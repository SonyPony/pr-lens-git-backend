import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { CanvasService } from "./canvas.ts";
import type { Config } from "./config.ts";
import { getDemoFixture, getDemoImage } from "./demo.ts";
import { ApiError, invalidRequest, notFound, rateLimited } from "./errors.ts";
import {
  clientOf,
  headerOf,
  originOf,
  readBody,
  sendJson,
  sendText,
} from "./http.ts";
import { customIndex, type CustomIndex } from "./markdown.ts";
import { canvasPage, heroSvg, indexPage, markdownPage, pageCsp } from "./page.ts";
import { DrawingCache } from "./render/cache.ts";
import { bearerToken } from "./secrets.ts";
import { CachedStore } from "./store/cached.ts";
import { GitStore } from "./store/git.ts";
import { MemoryStore } from "./store/memory.ts";
import { StoreThrottled } from "./store/types.ts";

/**
 * Seven routes and a health check, matched by hand.
 *
 * Every id in this file is a read capability, so nothing here puts one in a log
 * line. The paths are logged with the id replaced, which is the difference
 * between an access log and a list of everybody's canvases.
 */

const CANVAS = /^\/api\/canvas\/([^/]+)$/;
const ROTATE = /^\/api\/canvas\/([^/]+)\/rotate$/;
const PAGE = /^\/c\/([^/]+?)(\.svg)?$/;
const IMAGE = /^\/images\/([^/]+)\/([^/]+\.svg)$/;

export type App = {
  server: Server;
  service: CanvasService;
  /** The operator's own page at `/`, when they mounted one. */
  index: CustomIndex | undefined;
};

export const createApp = (config: Config): App => {
  const backing =
    config.store === "git"
      ? new GitStore(
          config.git ?? (() => { throw new Error("git settings missing"); })(),
        )
      : new MemoryStore();

  const store = new CachedStore(backing, config.readCacheTtlMs);
  const drawings = new DrawingCache(config.renderCacheBytes, config.draw);
  const service = new CanvasService(config, store, drawings);

  const index =
    config.indexMarkdownFile === undefined
      ? undefined
      : customIndex(config.indexMarkdownFile);

  const server = createServer((req, res) => {
    const started = Date.now();
    void route(req, res, config, service, index)
      .catch((error: unknown) => refuse(res, error))
      .finally(() => {
        if (config.logRequests) log(req, res, started);
      });
  });

  return { server, service, index };
};

const route = async (
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  service: CanvasService,
  index: CustomIndex | undefined,
): Promise<void> => {
  const method = req.method ?? "GET";
  // Only the path matters; a query string is never part of a route here.
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const query = new URL(req.url ?? "/", "http://localhost").searchParams;
  const origin = originOf(req, config);

  // Somebody pasted the host into a browser. Tell them what this is, and mostly
  // how to point a working setup at it rather than at prlens.dev -- unless the
  // operator mounted a page of their own, which then replaces all of it. Not
  // cached: the canvas count on it would go stale, and it is one small page.
  if (path === "/" && (method === "GET" || method === "HEAD")) {
    if (!config.indexPage) throw notFound();
    const facts = {
      store: config.store,
      draws: config.draw,
      count: await service.count(),
    };
    const nonce = randomBytes(16).toString("base64");
    const html =
      index === undefined
        ? indexPage(origin, facts, nonce)
        : await index
            .page(origin, facts)
            .then(({ title, body }) => markdownPage(title, body, nonce));
    sendText(res, 200, "text/html; charset=utf-8", html, {
      // A page somebody else wrote may name pictures anywhere; a page this
      // server wrote has no business doing so.
      "content-security-policy": pageCsp(
        nonce,
        index === undefined ? "self" : "anywhere",
      ),
    });
    return;
  }

  if ((path === "/demo" || path === "/demo.svg") && (method === "GET" || method === "HEAD")) {
    const rawSample = query.get("sample");
    const sample =
      rawSample === "single" || rawSample === "1" || rawSample === "billing"
        ? "single"
        : "multi";
    const demo = getDemoFixture(sample);

    if (path === "/demo.svg") {
      const theme = query.get("theme") === "dark" ? "dark" : "light";
      const hero = heroSvg(demo.canvas, theme);
      if (hero === undefined) throw notFound();

      const etag = `"${hero.contentHash}"`;
      if (headerOf(req, "if-none-match") === etag) {
        res.writeHead(304, {
          etag,
          "cache-control": config.embedCacheControl,
        });
        res.end();
        return;
      }

      sendText(res, 200, "image/svg+xml; charset=utf-8", hero.svg, {
        "cache-control": config.embedCacheControl,
        etag,
      });
      return;
    }

    const nonce = randomBytes(16).toString("base64");
    sendText(
      res,
      200,
      "text/html; charset=utf-8",
      canvasPage(demo.canvas, nonce, { demoSample: sample }),
      { "content-security-policy": pageCsp(nonce, "self") },
    );
    return;
  }

  // Liveness is about this process; readiness is about the store behind it.
  // Keeping them apart means a container health check does not spend a round
  // trip to the remote every few seconds.
  if (path === "/healthz" && (method === "GET" || method === "HEAD")) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === "/readyz" && (method === "GET" || method === "HEAD")) {
    await service.ping();
    sendJson(res, 200, { ok: true, store: config.store });
    return;
  }

  if (path === "/api/canvas") {
    if (method !== "POST") return notAllowed(res, "POST");
    const minted = await service.mint(clientOf(req, config), origin);
    sendJson(res, 201, minted);
    return;
  }

  const rotate = ROTATE.exec(path);
  if (rotate?.[1] !== undefined) {
    if (method !== "POST") return notAllowed(res, "POST");
    const body = await jsonBody(req, config.maxBodyBytes);
    const rotated = await service.rotate(
      rotate[1],
      bearerToken(headerOf(req, "authorization")),
      body,
      origin,
    );
    sendJson(res, 200, rotated);
    return;
  }

  const canvas = CANVAS.exec(path);
  if (canvas?.[1] !== undefined) {
    const id = canvas[1];

    if (method === "GET" || method === "HEAD") {
      sendJson(res, 200, await service.fetch(id, origin));
      return;
    }

    if (method === "PUT") {
      // The contract's first three checks, in its order: a usable If-Match
      // before the body is read at all, then the size, then the syntax.
      const ifMatch = parseIfMatch(headerOf(req, "if-match"));
      const body = await jsonBody(req, config.maxBodyBytes);
      const pushed = await service.push(
        id,
        bearerToken(headerOf(req, "authorization")),
        ifMatch,
        body,
        origin,
      );
      sendJson(res, 200, pushed);
      return;
    }

    if (method === "DELETE") {
      const deleted = await service.remove(
        id,
        bearerToken(headerOf(req, "authorization")),
      );
      sendJson(res, 200, deleted);
      return;
    }

    return notAllowed(res, "GET, PUT, DELETE");
  }

  const page = PAGE.exec(path);
  if (page?.[1] !== undefined) {
    if (method !== "GET" && method !== "HEAD") return notAllowed(res, "GET");
    const held = await service.canvas(page[1]);

    if (page[2] === ".svg") {
      const theme = query.get("theme") === "dark" ? "dark" : "light";
      const hero = heroSvg(held, theme);
      if (hero === undefined) throw notFound();

      // The embed's address does not change when the picture does, so it is
      // revalidated rather than frozen, and the render's own hash is the tag.
      const etag = `"${hero.contentHash}"`;
      if (headerOf(req, "if-none-match") === etag) {
        res.writeHead(304, {
          etag,
          "cache-control": config.embedCacheControl,
        });
        res.end();
        return;
      }

      sendText(res, 200, "image/svg+xml; charset=utf-8", hero.svg, {
        "cache-control": config.embedCacheControl,
        etag,
      });
      return;
    }

    const nonce = randomBytes(16).toString("base64");
    sendText(
      res,
      200,
      "text/html; charset=utf-8",
      canvasPage(held, nonce),
      { "content-security-policy": pageCsp(nonce, "self") },
    );
    return;
  }

  const image = IMAGE.exec(path);
  if (image?.[1] !== undefined && image[2] !== undefined) {
    if (method !== "GET" && method !== "HEAD") return notAllowed(res, "GET");
    const id = image[1];
    const fileName = image[2];
    const svg = id.startsWith("demo")
      ? getDemoImage(fileName)
      : await service.image(id, fileName);
    // A file name that is not the current revision's is simply not here; it is
    // never a stale picture served under a fresh name.
    if (svg === undefined) throw notFound();

    sendText(res, 200, "image/svg+xml; charset=utf-8", svg, {
      // The hash is in the file name, so these bytes can never change.
      "cache-control": config.imageCacheControl,
      etag: `"${image[2]}"`,
    });
    return;
  }

  throw notFound();
};

/**
 * `If-Match` carries the revision the writer last saw, as a plain integer,
 * quotes tolerated. Absent or unparseable is the contract's first refusal.
 */
const parseIfMatch = (header: string | undefined): number => {
  const match = /^(?:W\/)?"?(\d+)"?$/.exec((header ?? "").trim());
  const rev = match?.[1];
  if (rev === undefined)
    throw invalidRequest(
      "If-Match must carry the revision you last saw, as an integer",
    );
  return Number(rev);
};

const jsonBody = async (
  req: IncomingMessage,
  limit: number,
): Promise<unknown> => {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw invalidRequest("The body is not JSON");
  }
};

const notAllowed = (res: ServerResponse, allow: string): void => {
  sendJson(res, 405, notFound().body(), { allow });
};

/**
 * A refusal the contract names, or nothing at all.
 *
 * An internal fault deliberately leaves without an envelope: the client reads a
 * bare 500 as the server being unavailable, which is the truth, whereas a made
 * up code would be a lie it would try to act on.
 */
const refuse = (res: ServerResponse, error: unknown): void => {
  if (res.headersSent) {
    res.end();
    return;
  }

  if (error instanceof ApiError) {
    sendJson(res, error.status, error.body());
    return;
  }

  if (error instanceof StoreThrottled) {
    const throttled = rateLimited(error.retryAt, error.message);
    sendJson(res, throttled.status, throttled.body());
    return;
  }

  console.error("[pr-lens-git-backend] unhandled", error);
  sendJson(res, 500, {});
};

/** Paths with their ids removed, because an id is a capability. */
const redact = (path: string): string =>
  path
    .replace(CANVAS, "/api/canvas/:id")
    .replace(ROTATE, "/api/canvas/:id/rotate")
    .replace(PAGE, "/c/:id$2")
    .replace(IMAGE, "/images/:id/:file");

const log = (req: IncomingMessage, res: ServerResponse, started: number): void => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  console.log(
    `${req.method ?? "GET"} ${redact(path)} ${res.statusCode} ${Date.now() - started}ms`,
  );
};
