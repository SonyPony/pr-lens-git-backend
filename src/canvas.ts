import { safeParseGraphDoc, type GraphDoc } from "@coldtea/pr-lens-schema";

import type { Config } from "./config.ts";
import {
  deletionIncomplete,
  invalidDocument,
  invalidRequest,
  notFound,
  rateLimited,
  revisionMoved,
  unauthenticated,
  type Issue,
} from "./errors.ts";
import { RateLimiter } from "./ratelimit.ts";
import type { DrawingCache } from "./render/cache.ts";
import type { Drawing, DrawnTile } from "./render/draw.ts";
import { EMPTY_DRAWING } from "./render/draw.ts";
import { hashToken, isSecret, mintSecret, tokenMatches } from "./secrets.ts";
import type { CachedStore } from "./store/cached.ts";
import type { CanvasRecord, Stored } from "./store/types.ts";
import { StoreUnavailable } from "./store/types.ts";
import { editUrl, embedUrl, imageUrl, viewUrl } from "./urls.ts";

/**
 * Version 1 of the canvas contract, over any store.
 *
 * Nothing here touches HTTP. A route reads the headers, decides what the
 * request is, and calls one of these; what comes back is the answer's body and
 * what is thrown is the refusal. That split is why the checks below can be read
 * against the contract's numbered list without any plumbing in the way.
 */

export type Tile = {
  id: string;
  title: string;
  lens: string;
  crumbs: string[];
  hero: boolean;
  width: number;
  height: number;
  renders: Record<string, string>;
  images: Record<string, string>;
};

export type Minted = {
  id: string;
  writeToken: string;
  rev: number;
  viewUrl: string;
  editUrl: string;
  embedUrl: string;
};

export type Fetched = {
  id: string;
  rev: number;
  viewUrl: string;
  embedUrl: string;
  document: unknown;
  tiles: Tile[];
};

export type Pushed = {
  id: string;
  rev: number;
  viewUrl: string;
  editUrl: string;
  embedUrl: string;
  tiles: Tile[];
};

export type Rotated = { id: string; editUrl: string };

export type Deleted = { id: string; deleted: true };

/** A canvas page's ingredients, for the HTML and SVG routes to lay out. */
export type Canvas = {
  id: string;
  rev: number;
  document: GraphDoc | undefined;
  drawing: Drawing;
};

/** How many times a mint collides with an existing id before we give up. */
const MINT_ATTEMPTS = 5;
/** Retries for a write that lost a race but whose intent still stands. */
const RACE_ATTEMPTS = 3;

export class CanvasService {
  readonly #config: Config;
  readonly #store: CachedStore;
  readonly #drawings: DrawingCache;
  readonly #mintLimit: RateLimiter;
  readonly #pushLimit: RateLimiter;

  constructor(config: Config, store: CachedStore, drawings: DrawingCache) {
    this.#config = config;
    this.#store = store;
    this.#drawings = drawings;
    this.#mintLimit = new RateLimiter(config.mintsPerHourPerIp, 3_600_000);
    this.#pushLimit = new RateLimiter(config.pushesPerMinutePerCanvas, 60_000);
  }

  /**
   * POST /api/canvas
   *
   * With PUSH_TOKENS set, only a bearer among them mints. Checked before the
   * meter, so a stranger's refused attempts never spend a CI runner's quota.
   */
  async mint(client: string, origin: string, bearer: string | undefined): Promise<Minted> {
    const hashes = this.#config.pushTokenHashes;
    if (
      hashes.length > 0 &&
      (bearer === undefined || !hashes.some((hash) => tokenMatches(bearer, hash)))
    )
      throw unauthenticated();

    const allowed = this.#mintLimit.take(client);
    if (!allowed.ok)
      throw rateLimited(
        allowed.retryAt,
        "This server is minting canvases as fast as it will for now",
      );

    const writeToken = mintSecret();
    const now = new Date().toISOString();

    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
      const id = mintSecret();
      const record: CanvasRecord = {
        id,
        // A fresh canvas has no revision yet, so a fetch answers NOT_FOUND
        // until the first push lands rev 1.
        rev: 0,
        tokenHash: hashToken(writeToken),
        createdAt: now,
        updatedAt: now,
        document: null,
      };

      if ((await this.#store.create(record)) === "written")
        return {
          id,
          writeToken,
          rev: 0,
          viewUrl: viewUrl(origin, id),
          editUrl: editUrl(origin, id, writeToken),
          embedUrl: embedUrl(origin, id),
        };
    }

    // 128 random bits colliding five times running is not bad luck.
    throw new StoreUnavailable("Could not find a free canvas id");
  }

  /** GET /api/canvas/{id} */
  async fetch(id: string, origin: string): Promise<Fetched> {
    const held = await this.#readPushed(id);
    const { drawing } = this.#drawIfReadable(held.record.document);

    return {
      id,
      rev: held.record.rev,
      viewUrl: viewUrl(origin, id),
      embedUrl: embedUrl(origin, id),
      // Exactly as it was pushed, whatever this server can make of it.
      document: held.record.document,
      tiles: tilesFor(origin, id, drawing),
    };
  }

  /**
   * PUT /api/canvas/{id}
   *
   * The caller has already done the contract's first three checks, which are
   * about the request rather than the canvas: a usable `If-Match`, a body inside
   * the limit, and a body that is JSON. What is left starts at the fourth.
   */
  async push(
    id: string,
    token: string | undefined,
    ifMatch: number,
    body: unknown,
    origin: string,
  ): Promise<Pushed> {
    // Checked here as well as inside, so the answer below can hand the token
    // straight back into the edit link without pretending it might be absent.
    if (token === undefined) throw notFound();

    const held = await this.#readAuthorised(id, token);

    const allowed = this.#pushLimit.take(id);
    if (!allowed.ok)
      throw rateLimited(
        allowed.retryAt,
        "This canvas has been pushed to as often as this server allows for now",
      );

    if (ifMatch !== held.record.rev) throw revisionMoved(held.record.rev);

    const parsed = safeParseGraphDoc(body);
    if (!parsed.ok) throw invalidDocument(issuesOf(parsed.error));

    // Before the write, so an undrawable document changes nothing.
    const drawing = this.#drawings.for(parsed.value);

    const rev = await this.#write(held, parsed.value);

    return {
      id,
      rev,
      viewUrl: viewUrl(origin, id),
      // The token arrived on this request, so the edit link can carry it back
      // without the store ever holding it in the clear.
      editUrl: editUrl(origin, id, token),
      embedUrl: embedUrl(origin, id),
      tiles: tilesFor(origin, id, drawing),
    };
  }

  /**
   * POST /api/canvas/{id}/rotate
   *
   * The CLI mints the next token and saves it before asking, so an answer lost
   * on the way back costs nothing: it asks again with the same pair. Which is
   * why knowing the new token is itself proof, and why the first rule below has
   * to come before the bearer token is looked at.
   */
  async rotate(
    id: string,
    token: string | undefined,
    body: unknown,
    origin: string,
  ): Promise<Rotated> {
    const next = (body as { writeToken?: unknown } | null)?.writeToken;
    if (!isSecret(next))
      throw invalidRequest(
        "writeToken must be 22 characters of base64url, as minted",
      );

    if (!isSecret(id)) throw notFound();

    for (let attempt = 0; ; attempt += 1) {
      const held =
        attempt === 0
          ? await this.#store.read(id)
          : await this.#store.readFresh(id);
      if (held === null) throw notFound();

      // Already rotated: this is a retry finishing, and it finishes as success.
      if (tokenMatches(next, held.record.tokenHash))
        return { id, editUrl: editUrl(origin, id, next) };

      if (token === undefined || !tokenMatches(token, held.record.tokenHash))
        throw notFound();

      const written = await this.#store.replace(
        {
          ...held.record,
          tokenHash: hashToken(next),
          updatedAt: new Date().toISOString(),
        },
        held.etag,
      );

      if (written === "written") return { id, editUrl: editUrl(origin, id, next) };
      if (attempt >= RACE_ATTEMPTS)
        throw new StoreUnavailable(`Could not rotate the token for ${id}`);
    }
  }

  /** DELETE /api/canvas/{id} */
  async remove(id: string, token: string | undefined): Promise<Deleted> {
    let held: Stored | null = await this.#readAuthorised(id, token);

    for (let attempt = 0; ; attempt += 1) {
      if (held === null) return { id, deleted: true };

      if ((await this.#store.remove(id, held.etag)) === "written")
        return { id, deleted: true };

      if (attempt >= RACE_ATTEMPTS)
        throw deletionIncomplete(
          "The canvas could not be removed just now; ask again",
        );

      // Something else wrote or removed it; a gone canvas is a done deletion.
      held = await this.#store.readFresh(id);
    }
  }

  /**
   * GET /c/{id} and GET /c/{id}.svg
   *
   * Pictures are redrawn from the stored document rather than looked up, which
   * is what keeps this server free of a second place to put bytes.
   */
  async canvas(id: string): Promise<Canvas> {
    const held = await this.#readPushed(id);
    const { document, drawing } = this.#drawIfReadable(held.record.document);
    return { id, rev: held.record.rev, document, drawing };
  }

  /** GET /images/{id}/{fileName} */
  async image(id: string, fileName: string): Promise<string | undefined> {
    const canvas = await this.canvas(id);
    return canvas.drawing.images.get(fileName);
  }

  async ping(): Promise<void> {
    return this.#store.ping();
  }

  /** For the index page. Decoration, so a store that cannot say answers nothing. */
  async count(): Promise<{ canvases: number; atLeast: boolean } | undefined> {
    return this.#store.count().catch(() => undefined);
  }

  /** A canvas that exists and has been pushed to at least once. */
  async #readPushed(id: string): Promise<Stored> {
    if (!isSecret(id)) throw notFound();
    const held = await this.#store.read(id);
    // Minted but never pushed to is the third case NOT_FOUND covers.
    if (held === null || held.record.document === null) throw notFound();
    return held;
  }

  /** A canvas that exists, whether pushed to or not, plus the right token. */
  async #readAuthorised(id: string, token: string | undefined): Promise<Stored> {
    if (!isSecret(id)) throw notFound();
    const held = await this.#store.read(id);
    if (held === null) throw notFound();
    if (token === undefined || !tokenMatches(token, held.record.tokenHash))
      throw notFound();
    return held;
  }

  /**
   * The next revision, or the revision the canvas actually reached.
   *
   * A lost race is reported with a revision read past the cache, because a
   * client told the wrong number would pull, push and lose again.
   */
  async #write(held: Stored, document: GraphDoc): Promise<number> {
    const rev = held.record.rev + 1;
    const written = await this.#store.replace(
      {
        ...held.record,
        rev,
        document,
        updatedAt: new Date().toISOString(),
      },
      held.etag,
    );

    if (written === "written") return rev;

    const fresh = await this.#store.readFresh(held.record.id);
    if (fresh === null) throw notFound();
    throw revisionMoved(fresh.record.rev);
  }

  /**
   * A stored document this server cannot parse is still served: the contract
   * says `document` is what was pushed, and a CLI newer or older than this
   * server is entitled to make its own mind up. It just gets no pictures.
   */
  #drawIfReadable(stored: unknown): {
    document: GraphDoc | undefined;
    drawing: Drawing;
  } {
    const parsed = safeParseGraphDoc(stored);
    if (!parsed.ok) return { document: undefined, drawing: EMPTY_DRAWING };
    return { document: parsed.value, drawing: this.#drawings.for(parsed.value) };
  }
}

/** File names become addresses only here, where the origin is known. */
const tilesFor = (origin: string, id: string, drawing: Drawing): Tile[] =>
  drawing.tiles.map((tile: DrawnTile) => ({
    id: tile.id,
    title: tile.title,
    lens: tile.lens,
    crumbs: tile.crumbs,
    hero: tile.hero,
    width: tile.width,
    height: tile.height,
    renders: tile.renders,
    images: Object.fromEntries(
      Object.entries(tile.files).map(([theme, fileName]) => [
        theme,
        imageUrl(origin, id, fileName),
      ]),
    ),
  }));

/**
 * Every issue the parser found, and never an empty list: a refusal the CLI
 * prints as nothing at all is worse than one line of explanation.
 */
const issuesOf = (error: {
  code: string;
  message: string;
  issues: readonly Issue[];
}): Issue[] =>
  error.issues.length > 0
    ? error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      }))
    : [{ code: error.code, path: "", message: error.message }];
