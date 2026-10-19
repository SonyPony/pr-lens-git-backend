import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { hashToken } from "./secrets.ts";
import { VERSION } from "./version.ts";

/**
 * Everything the server needs to know, read once at startup.
 *
 * A missing setting that has no safe default is a startup failure rather than
 * a 500 on the first request: a canvas server that cannot reach its store is
 * not half-working, it is not working.
 */

export type GitSettings = {
  /** Anything `git fetch` takes: an https URL, an ssh URL, a path. */
  remote: string;
  branch: string;
  prefix: string;
  /**
   * Where the local mirror lives. Disposable by design: it holds no truth the
   * remote does not, so deleting it costs one clone and nothing else.
   */
  mirror: string;
  authorName: string;
  authorEmail: string;
  /** Basic-auth user for an https remote; the token is the password. */
  username: string;
  /** Undefined for a remote that authenticates some other way, ssh included. */
  token: string | undefined;
  /** Sent as http.userAgent, so the host's logs can name which replica called. */
  userAgent: string;
  /** Ceiling on a single git invocation. */
  timeoutMs: number;
  /** How long a fetched view may be reused before the remote is asked again. */
  fetchTtlMs: number;
};

export type Config = {
  host: string;
  port: number;
  /** Origin the answers' URLs are built from; undefined means "ask the request". */
  publicUrl: string | undefined;
  store: "git" | "memory";
  git: GitSettings | undefined;
  /** Largest push body accepted, in bytes. */
  maxBodyBytes: number;
  /** How long a read may be served from memory before the store is asked again. */
  readCacheTtlMs: number;
  /** Ceiling on rendered SVG bytes held in memory. */
  renderCacheBytes: number;
  /** False turns the server into a pure store: every answer carries `tiles: []`. */
  draw: boolean;
  mintsPerHourPerIp: number;
  pushesPerMinutePerCanvas: number;
  /** Cache-Control for the content-addressed image routes. */
  imageCacheControl: string;
  /** Cache-Control for /c/{id}.svg, which changes with every revision. */
  embedCacheControl: string;
  /** Whether to believe x-forwarded-for when identifying a client. */
  trustProxy: boolean;
  /** One line per request, with canvas ids redacted. */
  logRequests: boolean;
  /**
   * Serve a page at `/`. Off answers NOT_FOUND there instead — including when a
   * page has been mounted, since off is a decision about the route.
   */
  indexPage: boolean;
  /**
   * A Markdown file to serve at `/` in place of the explanatory page. Undefined
   * is the page this server ships with.
   */
  indexMarkdownFile: string | undefined;
  /**
   * Hashes of the bearer tokens allowed to mint a canvas, from PUSH_TOKENS.
   * Empty leaves minting open to anyone, as the contract's hosted app does.
   * Only hashes are held, so a dump of the config is not a list of tokens.
   */
  pushTokenHashes: string[];
  github: GitHubConfig;
};

export type GitHubConfig = {
  apiUrl: string;
  webUrl: string;
  timeoutMs: number;
  /**
   * The GitHub App readers sign in with. Undefined turns sign-in off: the panel
   * still shows what a click selected, but no code.
   */
  app: { clientId: string; clientSecret: string; sessionKey: Buffer } | undefined;
  /**
   * A token to read diffs with when nobody is signed in, from GITHUB_DEV_TOKEN.
   * Only on a server bound to loopback: anywhere else it would show anybody
   * with a canvas link whatever the token can read.
   */
  devToken: string | undefined;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const githubConfig = (host: string): GitHubConfig => {
  const clientId = optional("GITHUB_APP_CLIENT_ID");
  let app: GitHubConfig["app"];
  if (clientId !== undefined) {
    const sessionKey = Buffer.from(str("SESSION_KEY"), "base64");
    if (sessionKey.length !== 32)
      throw new Error("SESSION_KEY must be 32 random bytes, base64: openssl rand -base64 32");
    app = { clientId, clientSecret: str("GITHUB_APP_CLIENT_SECRET"), sessionKey };
  }

  const devToken = optional("GITHUB_DEV_TOKEN");
  if (devToken !== undefined && !LOOPBACK.has(host))
    throw new Error(
      `GITHUB_DEV_TOKEN only works on a server bound to loopback, and HOST is ${host}. Readers sign in with GITHUB_APP_CLIENT_ID instead.`,
    );

  return {
    apiUrl: origin(str("GITHUB_API_URL", "https://api.github.com")),
    webUrl: origin(str("GITHUB_WEB_URL", "https://github.com")),
    timeoutMs: int("GITHUB_TIMEOUT_MS", 10_000),
    app,
    devToken,
  };
};

/** Long enough that a push token cannot be guessed; `prl_u_` plus 22 is 28. */
const MIN_PUSH_TOKEN_LENGTH = 20;

const pushTokenHashes = (): string[] => {
  const raw = optional("PUSH_TOKENS");
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .map((token) => {
      if (token.length < MIN_PUSH_TOKEN_LENGTH)
        throw new Error(
          `PUSH_TOKENS entries must be at least ${MIN_PUSH_TOKEN_LENGTH} characters`,
        );
      return hashToken(token);
    });
};

const str = (name: string, fallback?: string): string => {
  const value = process.env[name]?.trim();
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
};

/** A setting with no default and no obligation: unset and empty are the same. */
const optional = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const int = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return value;
};

const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean, got ${raw}`);
};

/** Trailing slashes off, so joining paths never doubles one. */
const origin = (url: string): string => url.replace(/\/+$/, "");

/**
 * What this server calls itself when it talks to the remote.
 *
 * `pr-lens-git-backend/0.2.0 (pod-7b9f4)`, matching the CLI's own
 * `pr-lens-cli/<version>` and putting the host in the parenthesised comment
 * that RFC 9110 reserves for exactly this — `@` is not a legal character in a
 * product version, however common the habit.
 *
 * The host is there so a rate limit or an audit entry can be traced to one
 * replica rather than to "the canvas server". In a pod that is the pod name; on
 * a laptop it is the machine's name, which is why `USER_AGENT_HOST` can replace
 * it, or empty it out for a plain `pr-lens-git-backend/0.2.0`.
 */
const userAgent = (): string => {
  const host = process.env.USER_AGENT_HOST ?? hostname();
  // A comment may hold anything but an unescaped parenthesis or backslash; this
  // is stricter than that, because a host name has no business being exotic.
  const safe = host.trim().replace(/[^A-Za-z0-9._:-]/g, "");
  return safe === ""
    ? `pr-lens-git-backend/${VERSION}`
    : `pr-lens-git-backend/${VERSION} (${safe})`;
};

export const loadConfig = (): Config => {
  const store = str("STORE", "git");
  // Named on its own, because a deployment carrying the old value is one env
  // rename away from working and deserves to be told which one.
  if (store === "gitlab")
    throw new Error(
      'STORE=gitlab is gone: the store now speaks git to any remote. Set STORE=git, GIT_REMOTE to the repository GITLAB_PROJECT named, and GIT_TOKEN to what GITLAB_TOKEN held. The files in the repository are unchanged.',
    );
  if (store !== "git" && store !== "memory")
    throw new Error(`STORE must be "git" or "memory", got ${store}`);

  const publicUrl = process.env.PUBLIC_URL?.trim();
  const host = str("HOST", "0.0.0.0");

  return {
    host,
    port: int("PORT", 8787),
    publicUrl:
      publicUrl === undefined || publicUrl === ""
        ? undefined
        : origin(publicUrl),
    store,
    git:
      store === "git"
        ? {
            remote: str("GIT_REMOTE"),
            branch: str("GIT_BRANCH", "main"),
            prefix: str("GIT_PREFIX", "canvases").replace(/^\/+|\/+$/g, ""),
            mirror: str("GIT_MIRROR_DIR", join(tmpdir(), "pr-lens-canvases.git")),
            authorName: str("GIT_AUTHOR_NAME", "pr-lens-git-backend"),
            authorEmail: str("GIT_AUTHOR_EMAIL", "pr-lens-git-backend@localhost"),
            // Most hosts ignore the user when the password is a token; the ones
            // that do not (Bitbucket wants x-token-auth) can say so.
            username: str("GIT_USERNAME", "oauth2"),
            token: optional("GIT_TOKEN"),
            userAgent: userAgent(),
            timeoutMs: int("GIT_TIMEOUT_MS", 30_000),
            // Zero means every read asks the remote, which is what the GitLab
            // API call used to cost and the freshness the docs promise.
            fetchTtlMs: int("GIT_FETCH_TTL_MS", 0),
          }
        : undefined,
    maxBodyBytes: int("MAX_BODY_BYTES", 4_000_000),
    readCacheTtlMs: int("READ_CACHE_TTL_MS", 5_000),
    renderCacheBytes: int("RENDER_CACHE_BYTES", 64_000_000),
    draw: bool("DRAW", true),
    mintsPerHourPerIp: int("MINTS_PER_HOUR_PER_IP", 60),
    pushesPerMinutePerCanvas: int("PUSHES_PER_MINUTE_PER_CANVAS", 30),
    imageCacheControl: str(
      "IMAGE_CACHE_CONTROL",
      "public, max-age=31536000, immutable",
    ),
    embedCacheControl: str(
      "EMBED_CACHE_CONTROL",
      "public, max-age=60, stale-while-revalidate=300",
    ),
    trustProxy: bool("TRUST_PROXY", false),
    logRequests: bool("LOG_REQUESTS", true),
    indexPage: bool("INDEX_PAGE", true),
    indexMarkdownFile: optional("INDEX_MARKDOWN_FILE"),
    pushTokenHashes: pushTokenHashes(),
    github: githubConfig(host),
  };
};
