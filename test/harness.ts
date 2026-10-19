import type { AddressInfo } from "node:net";

import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";

/**
 * A real server on a real socket, over the in-memory store.
 *
 * The tests drive it with fetch rather than calling the service, so the things
 * the contract is actually picky about — header parsing, status codes, the order
 * the checks happen in — are what gets tested.
 */
export type Harness = {
  url: string;
  close: () => Promise<void>;
};

export const start = async (
  env: Record<string, string> = {},
): Promise<Harness> => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    STORE: "memory",
    PORT: "0",
    HOST: "127.0.0.1",
    // Off, so a read never answers from a previous assertion's cache.
    READ_CACHE_TTL_MS: "0",
    // Off, so a test that pushes many times is not metered mid-assertion.
    MINTS_PER_HOUR_PER_IP: "0",
    PUSHES_PER_MINUTE_PER_CANVAS: "0",
    PUBLIC_URL: "",
    ...env,
  });

  const config = loadConfig();
  process.env = saved;

  const { server } = createApp(config);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export type Answer<T = any> = { status: number; body: T; headers: Headers };

export const call = async <T = any>(
  url: string,
  init: RequestInit = {},
): Promise<Answer<T>> => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T, headers: response.headers };
};

/** The config a server would load with these settings, over the in-memory store. */
export const loadConfigWith = (env: Record<string, string>) => {
  const saved = { ...process.env };
  Object.assign(process.env, { STORE: "memory", ...env });
  try {
    return loadConfig();
  } finally {
    process.env = saved;
  }
};

/** Mints a canvas and pushes `document` as its first revision; the canvas id. */
export const pushDocument = async (harness: Harness, document: unknown): Promise<string> => {
  const minted = await call(`${harness.url}/api/canvas`, { method: "POST" });
  const { id, writeToken } = minted.body;
  const pushed = await call(`${harness.url}/api/canvas/${id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${writeToken}`,
      "if-match": "0",
    },
    body: JSON.stringify(document),
  });
  if (pushed.status !== 200) throw new Error(`push failed: ${JSON.stringify(pushed.body)}`);
  return id;
};
