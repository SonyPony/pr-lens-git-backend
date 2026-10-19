import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { call, loadConfigWith, start, type Harness } from "./harness.ts";

/**
 * PUSH_TOKENS: with it set, only a bearer among the tokens mints a canvas,
 * which is how a server whose canvases are linked from pull requests keeps
 * strangers from minting documents of their own on it.
 */

const CI_TOKEN = "prl_u_ci0000000000000000000000";
const OTHER_TOKEN = "prl_u_other00000000000000000000";

describe("minting with push tokens", () => {
  let harness: Harness;
  before(async () => {
    harness = await start({ LOG_REQUESTS: "false", PUSH_TOKENS: ` ${CI_TOKEN} , ${OTHER_TOKEN}` });
  });
  after(async () => harness.close());

  const mint = (authorization?: string) =>
    call(`${harness.url}/api/canvas`, {
      method: "POST",
      headers: authorization === undefined ? {} : { authorization },
    });

  it("refuses a mint with no bearer", async () => {
    const refused = await mint();
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error.code, "UNAUTHENTICATED");
  });

  it("refuses a bearer it was not given", async () => {
    const refused = await mint("Bearer prl_u_stranger0000000000000000");
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error.code, "UNAUTHENTICATED");
  });

  it("mints for any of the tokens, and the write token still governs the push", async () => {
    for (const token of [CI_TOKEN, OTHER_TOKEN]) {
      const minted = await mint(`Bearer ${token}`);
      assert.equal(minted.status, 201);
      assert.equal(typeof minted.body.writeToken, "string");
    }

    const minted = await mint(`Bearer ${CI_TOKEN}`);
    const wrong = await call(`${harness.url}/api/canvas/${minted.body.id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CI_TOKEN}`,
        "if-match": "0",
      },
      body: "{}",
    });
    assert.equal(wrong.status, 404, "a push token is not a write token");
  });
});

describe("minting without push tokens", () => {
  let harness: Harness;
  before(async () => {
    harness = await start({ LOG_REQUESTS: "false" });
  });
  after(async () => harness.close());

  it("stays open to anyone, as before", async () => {
    const minted = await call(`${harness.url}/api/canvas`, { method: "POST" });
    assert.equal(minted.status, 201);
  });
});

describe("the PUSH_TOKENS setting", () => {
  const load = (value: string) => loadConfigWith({ PUSH_TOKENS: value });

  it("holds hashes only", () => {
    const config = load(CI_TOKEN);
    assert.equal(config.pushTokenHashes.length, 1);
    assert.equal(config.pushTokenHashes[0]?.includes(CI_TOKEN), false);
    assert.match(config.pushTokenHashes[0] ?? "", /^sha256:[0-9a-f]{64}$/);
  });

  it("refuses a token short enough to guess", () => {
    assert.throws(() => load("short"), /at least 20 characters/);
  });
});
