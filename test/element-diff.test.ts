import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { parseGraphDoc } from "@coldtea/pr-lens-schema";

import { hunksInRange, parsePatch, wholeFile } from "../src/diff.ts";
import { highlight, languageOf } from "../src/highlight.ts";
import { call, loadConfigWith, pushDocument, start, type Harness } from "./harness.ts";

/**
 * The code behind a clicked element, end to end against a fake GitHub: who may
 * see it, which hunks they get, the whole-file view, and the sign-in that
 * hands the server a reader's own token.
 */

const API_PATCH = [
  "@@ -1,4 +1,5 @@",
  " import cache",
  "-old = 1",
  "+new = 1",
  "+extra = 2",
  " keep",
  " keep2",
  "@@ -40,2 +41,2 @@",
  " context",
  "-far = 0",
  "+far = 9",
].join("\n");

const API_HEAD = ["import cache", "new = 1", "extra = 2", "keep", "keep2"].join("\n") + "\n";
const API_BASE = ["import cache", "old = 1", "keep", "keep2"].join("\n") + "\n";

/** File contents the fake serves, by `path@ref`. */
const CONTENTS: Record<string, string> = {
  "src/api.py@bbb2222": API_HEAD,
  "src/api.py@aaa1111": API_BASE,
  "src/cache.py@bbb2222": "a\nb\nc\n",
};

type Fake = {
  url: string;
  host: string;
  calls: string[];
  verifiers: string[];
  close: () => Promise<void>;
};

/** Just enough GitHub: sign-in, the user, repo access, a comparison and file contents. */
const fakeGitHub = async (): Promise<Fake> => {
  const calls: string[] = [];
  const verifiers: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    calls.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/login/oauth/access_token") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        verifiers.push(body.code_verifier);
        if (body.code === "good-code" && body.client_secret === "app-secret")
          json(200, { access_token: "user-token", expires_in: 28800 });
        else json(200, { error: "bad_verification_code" });
      });
      return;
    }

    const readers = new Set(["user-token", "dev-token"]);
    if (url.pathname === "/user") {
      if (token === "user-token") return json(200, { login: "ada" });
      if (token === "dev-token") return json(200, { login: "dev" });
      return json(401, {});
    }
    if (token === "expired-token") return json(401, {});
    if (url.pathname === "/repos/acme/shop") return readers.has(token) ? json(200, {}) : json(404, {});
    if (url.pathname === "/repos/acme/shop/compare/aaa1111...bbb2222")
      return json(200, {
        files: [
          { filename: "src/cache.py", status: "added", patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c" },
          { filename: "src/api.py", status: "modified", patch: API_PATCH },
          { filename: "assets/logo.png", status: "modified" },
        ],
      });
    const content = /^\/repos\/acme\/shop\/contents\/(.+)$/.exec(url.pathname);
    const text = content ? CONTENTS[`${content[1]}@${url.searchParams.get("ref")}`] : undefined;
    if (text !== undefined) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(text);
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    calls,
    verifiers,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/** A small document whose provenance points at the fake. */
const shopDoc = (host: string) =>
  parseGraphDoc({
    schemaVersion: "0.2.0",
    kind: "graph",
    title: "Cache in front of the store",
    summary: "Adds a cache.",
    lenses: ["architecture"],
    provenance: {
      repo: { owner: "acme", name: "shop", host },
      base: { sha: "aaa1111" },
      head: { sha: "bbb2222" },
    },
    lanes: [{ id: "app", label: "App" }],
    nodes: [
      { id: "api", label: "api.py", kind: "module", delta: "modified", lane: "app", files: [{ path: "src/api.py", startLine: 1, endLine: 5 }] },
      { id: "cache", label: "cache.py", kind: "cache", delta: "added", lane: "app", files: [{ path: "src/cache.py" }] },
      { id: "logo", label: "logo", kind: "other", delta: "modified", lane: "app", files: [{ path: "assets/logo.png" }] },
      { id: "readme", label: "README", kind: "other", delta: "unchanged", lane: "app", files: [{ path: "README.md" }] },
    ],
    edges: [{ id: "api-cache", from: "api", to: "cache", kind: "call", delta: "added" }],
    flows: [],
    stats: {},
    views: [],
  });

const SESSION_KEY = randomBytes(32).toString("base64");

const pushDoc = pushDocument;

const diffOf = (harness: Harness, id: string, el: string, extra = "", cookie?: string) =>
  call(`${harness.url}/c/${id}/diff?el=${encodeURIComponent(el)}${extra}`, {
    headers: cookie === undefined ? {} : { cookie },
  });

describe("the diff behind an element, with a dev token", () => {
  let github: Fake;
  let harness: Harness;
  let id: string;
  before(async () => {
    github = await fakeGitHub();
    harness = await start({
      LOG_REQUESTS: "false",
      GITHUB_API_URL: github.url,
      GITHUB_WEB_URL: github.url,
      GITHUB_DEV_TOKEN: "dev-token",
    });
    id = await pushDoc(harness, shopDoc(github.host));
  });
  after(async () => {
    await harness.close();
    await github.close();
  });

  it("shows the hunks inside the element's range, and counts the rest", async () => {
    const answer = await diffOf(harness, id, "node:api");
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("cache-control"), "private, no-store");
    assert.equal(answer.headers.get("vary"), "Cookie");
    assert.equal(answer.body.state, "ok");

    const [file] = answer.body.files;
    assert.equal(file.path, "src/api.py");
    assert.equal(file.hunks.length, 1);
    assert.equal(file.otherHunks, 1);
    assert.deepEqual(
      file.hunks[0].lines.map((line: { t: string; s: string }) => `${line.t}${line.s}`),
      [" import cache", "-old = 1", "+new = 1", "+extra = 2", " keep", " keep2"],
    );
    assert.equal(file.url, `${github.url}/acme/shop/blob/bbb2222/src/api.py`);
  });

  it("colours each line from its own side's file, in GitHub's themes", async () => {
    const [file] = (await diffOf(harness, id, "node:api")).body.files;
    const lines = file.hunks[0].lines as Array<{ t: string; s: string; h?: unknown[][] }>;
    for (const line of lines) {
      assert.ok(Array.isArray(line.h), `"${line.s}" has no colours`);
      assert.equal(line.h.map((token) => token[0]).join(""), line.s, "the tokens spell the line");
    }
    // `import` is a keyword in github-light: a coloured token, not the default.
    const keyword = lines[0]?.h?.find((token) => token[0] === "import");
    assert.equal(keyword?.length, 4);

    const whole = await diffOf(harness, id, "node:api", "&full=src/api.py");
    const removed = whole.body.lines.find((line: { t: string }) => line.t === "-");
    assert.equal(removed.o, 2);
    assert.ok(Array.isArray(removed.h), "a removed line takes its colours from the old file");
  });

  it("shows every hunk when the document names no range", async () => {
    const answer = await diffOf(harness, id, "node:cache");
    const [file] = answer.body.files;
    assert.equal(file.status, "added");
    assert.equal(file.hunks.length, 1);
    assert.equal(file.otherHunks, 0);
  });

  it("says so for a file with no patch, and for a file the change left alone", async () => {
    assert.equal((await diffOf(harness, id, "node:logo")).body.files[0].noPatch, true);
    assert.equal((await diffOf(harness, id, "node:readme")).body.files[0].status, "unchanged");
  });

  it("weaves the changes into the whole file, for the element's own files only", async () => {
    const whole = await diffOf(harness, id, "node:api", "&full=src/api.py");
    assert.equal(whole.status, 200);
    assert.equal(whole.body.state, "ok-full");
    assert.deepEqual(
      whole.body.lines.map((line: { t: string; s: string }) => `${line.t}${line.s}`),
      [" import cache", "-old = 1", "+new = 1", "+extra = 2", " keep", " keep2"],
    );

    const other = await diffOf(harness, id, "node:api", "&full=src/cache.py");
    assert.equal(other.status, 404);
  });

  it("answers NOT_FOUND for an element the document does not have", async () => {
    assert.equal((await diffOf(harness, id, "node:nope")).status, 404);
    assert.equal((await diffOf(harness, id, "edge:api-cache")).status, 404, "an edge without files is not clickable");
  });

  it("compares a commit pair once, however many clicks ask", async () => {
    const before = github.calls.filter((entry) => entry.includes("/compare/")).length;
    await diffOf(harness, id, "node:api");
    await diffOf(harness, id, "node:cache");
    const after = github.calls.filter((entry) => entry.includes("/compare/")).length;
    assert.equal(after, before, "the comparison came from the cache");
  });

  it("has no sign-in routes without a GitHub App", async () => {
    assert.equal((await fetch(`${harness.url}/auth/github/login`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${harness.url}/auth/logout`, { method: "POST" })).status, 404);
  });

  it("refuses a document that points at another host", async () => {
    const elsewhere = await pushDoc(harness, shopDoc("gitlab.example.com"));
    const answer = await diffOf(harness, elsewhere, "node:api");
    assert.equal(answer.status, 422);
    assert.equal(answer.body.state, "unavailable");
  });
});

describe("the diff behind an element, for a reader who cannot read the repo", () => {
  let github: Fake;
  let harness: Harness;
  before(async () => {
    github = await fakeGitHub();
    harness = await start({
      LOG_REQUESTS: "false",
      GITHUB_API_URL: github.url,
      GITHUB_WEB_URL: github.url,
      GITHUB_DEV_TOKEN: "outsider-token",
    });
  });
  after(async () => {
    await harness.close();
    await github.close();
  });

  it("shows no code, and never asks GitHub for the comparison", async () => {
    const id = await pushDoc(harness, shopDoc(github.host));
    const answer = await diffOf(harness, id, "node:api");
    assert.equal(answer.status, 403);
    assert.equal(answer.body.state, "no-access");
    assert.equal(github.calls.some((entry) => entry.includes("/compare/")), false);
  });
});

describe("signing in with GitHub", () => {
  let github: Fake;
  let harness: Harness;
  let id: string;
  before(async () => {
    github = await fakeGitHub();
    harness = await start({
      LOG_REQUESTS: "false",
      GITHUB_API_URL: github.url,
      GITHUB_WEB_URL: github.url,
      GITHUB_APP_CLIENT_ID: "app-id",
      GITHUB_APP_CLIENT_SECRET: "app-secret",
      SESSION_KEY,
    });
    id = await pushDoc(harness, shopDoc(github.host));
  });
  after(async () => {
    await harness.close();
    await github.close();
  });

  const cookieFrom = (response: Response, name: string): string | undefined =>
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split(";")[0];

  const signIn = async (returnTo: string) => {
    const login = await fetch(`${harness.url}/auth/github/login?return=${encodeURIComponent(returnTo)}`, {
      redirect: "manual",
    });
    assert.equal(login.status, 302);
    const authorize = new URL(login.headers.get("location") ?? "");
    const pending = cookieFrom(login, "prl_oauth");
    assert.ok(pending);
    return { authorize, pending };
  };

  it("offers sign-in to a reader who has not signed in", async () => {
    const answer = await diffOf(harness, id, "node:api");
    assert.equal(answer.status, 401);
    assert.equal(answer.body.state, "signin");
    assert.equal(answer.body.loginUrl, `/auth/github/login?return=${encodeURIComponent(`/c/${id}`)}`);
  });

  it("signs in, then shows the code with the reader's own token", async () => {
    const { authorize, pending } = await signIn(`/c/${id}`);
    assert.equal(authorize.pathname, "/login/oauth/authorize");
    assert.equal(authorize.searchParams.get("client_id"), "app-id");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");

    const callback = await fetch(
      `${harness.url}/auth/github/callback?code=good-code&state=${authorize.searchParams.get("state")}`,
      { redirect: "manual", headers: { cookie: pending } },
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), `/c/${id}`);

    const verifier = github.verifiers.at(-1) ?? "";
    assert.equal(
      createHash("sha256").update(verifier).digest("base64url"),
      authorize.searchParams.get("code_challenge"),
      "the verifier GitHub got matches the challenge it was shown",
    );

    const raw = callback.headers.getSetCookie().find((cookie) => cookie.startsWith("prl_session="));
    assert.ok(raw);
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Lax/);
    assert.equal(raw.includes("user-token"), false, "the token travels sealed");

    const answer = await diffOf(harness, id, "node:api", "", cookieFrom(callback, "prl_session"));
    assert.equal(answer.status, 200);
    assert.equal(answer.body.viewer, "ada");
  });

  it("refuses a callback whose state does not match", async () => {
    const { pending } = await signIn(`/c/${id}`);
    const callback = await fetch(`${harness.url}/auth/github/callback?code=good-code&state=forged`, {
      redirect: "manual",
      headers: { cookie: pending },
    });
    assert.equal(callback.status, 400);
  });

  it("sends a reader back to a canvas and nowhere else", async () => {
    const { authorize, pending } = await signIn("https://evil.example/steal");
    const callback = await fetch(
      `${harness.url}/auth/github/callback?code=good-code&state=${authorize.searchParams.get("state")}`,
      { redirect: "manual", headers: { cookie: pending } },
    );
    assert.equal(callback.headers.get("location"), "/");
  });

  it("treats a tampered session as no session", async () => {
    const answer = await diffOf(harness, id, "node:api", "", "prl_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(answer.status, 401);
  });

  it("answers a wrong method on an auth route like any other route", async () => {
    assert.equal((await fetch(`${harness.url}/auth/logout`)).status, 405);
    assert.equal((await fetch(`${harness.url}/auth/github/login`, { method: "POST" })).status, 405);
  });

  it("signs out", async () => {
    const out = await fetch(`${harness.url}/auth/logout`, { method: "POST" });
    assert.equal(out.status, 204);
    assert.match(out.headers.getSetCookie()[0] ?? "", /^prl_session=; Path=\/; Max-Age=0/);
  });
});

describe("the sign-in settings", () => {
  const load = loadConfigWith;

  it("keeps the dev token to loopback", () => {
    assert.throws(() => load({ HOST: "0.0.0.0", GITHUB_DEV_TOKEN: "dev-token" }), /loopback/);
    assert.equal(load({ HOST: "127.0.0.1", GITHUB_DEV_TOKEN: "dev-token" }).github.devToken, "dev-token");
  });

  it("wants a 32-byte session key with an App", () => {
    assert.throws(
      () => load({ GITHUB_APP_CLIENT_ID: "a", GITHUB_APP_CLIENT_SECRET: "b", SESSION_KEY: "c2hvcnQ=" }),
      /32 random bytes/,
    );
  });
});

describe("highlighting", () => {
  it("knows a language by extension or by name, and leaves the rest plain", () => {
    assert.equal(languageOf("src/app.py"), "py");
    assert.equal(languageOf("web/App.TSX"), "tsx");
    assert.equal(languageOf("Dockerfile"), "docker");
    assert.equal(languageOf("notes.unknownext"), undefined);
    assert.equal(languageOf("LICENSE"), undefined);
  });

  it("gives one token list per line, with both themes' colours", async () => {
    const lines = await highlight("a.py", "def f():\n    return 1\n");
    assert.equal(lines?.length, 2);
    const def = lines?.[0]?.find((token) => token[0] === "def");
    assert.deepEqual(def?.slice(1, 3), ["#D73A49", "#F97583"]);
  });

  it("returns nothing for a language it does not know", async () => {
    assert.equal(await highlight("data.unknownext", "x"), undefined);
  });
});

describe("reading a patch", () => {
  const hunks = parsePatch(API_PATCH);

  it("numbers both sides", () => {
    assert.equal(hunks.length, 2);
    const removed = hunks[0]?.lines.find((line) => line.t === "-");
    const added = hunks[0]?.lines.filter((line) => line.t === "+");
    assert.equal(removed?.o, 2);
    assert.deepEqual(added?.map((line) => line.n), [2, 3]);
    assert.equal(hunks[1]?.newStart, 41);
  });

  it("keeps the hunks that touch a range on the side asked for", () => {
    assert.equal(hunksInRange(hunks, "new", 1, 5).length, 1);
    assert.equal(hunksInRange(hunks, "new", 41, 41).length, 1);
    assert.equal(hunksInRange(hunks, "new", 10, 20).length, 0);
    assert.equal(hunksInRange(hunks, "old", 40, 40).length, 1);
    assert.equal(hunksInRange(hunks, "new", undefined, undefined).length, 2);
  });

  it("marks every line of a deleted file as removed", () => {
    assert.deepEqual(
      wholeFile("a\nb\n", [], true).map((line) => line.t),
      ["-", "-"],
    );
  });
});
