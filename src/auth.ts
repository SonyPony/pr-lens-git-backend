import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "./config.ts";
import { GitHubError, type GitHubClient } from "./github.ts";
import { sendText } from "./http.ts";
import { sameSecret } from "./secrets.ts";
import {
  clearCookie,
  cookieOf,
  open,
  seal,
  SESSION_COOKIE,
  setCookie,
  SIGN_IN_COOKIE,
  type Session,
  type SignIn,
} from "./session.ts";

/**
 * Sign in with GitHub, through a GitHub App's user authorization.
 *
 * A GitHub App rather than an OAuth App because its user tokens carry only the
 * permissions the App was given (contents read, here) and expire after eight
 * hours, where an OAuth App would need the `repo` scope and with it write
 * access to everything the reader can reach.
 *
 * The flow: `login` seals a fresh state and PKCE verifier into a
 * short-lived cookie and sends the reader to GitHub; `/auth/github/callback`
 * checks the state against that cookie, trades the code for a token, and seals
 * the token into the session cookie.
 */

const SIGN_IN_PATH = "/auth/github";
const SIGN_IN_TTL_MS = 10 * 60_000;
/** A GitHub App user token's own lifetime; the cookie never outlives it. */
const SESSION_MAX_MS = 8 * 60 * 60_000;
/** Where a reader may be sent back to: a canvas page and nothing else, so this is no open redirect. */
const RETURN_TO = /^\/c\/[A-Za-z0-9_-]{1,64}$/;

const callbackUrl = (origin: string): string => `${origin}${SIGN_IN_PATH}/callback`;
const isSecure = (origin: string): boolean => origin.startsWith("https://");

/** The sign-in link for a canvas, or undefined when sign-in is off. */
export const loginUrl = (config: Config, canvasId: string): string | undefined =>
  config.github.app === undefined
    ? undefined
    : `${SIGN_IN_PATH}/login?return=${encodeURIComponent(`/c/${canvasId}`)}`;

/** The reader's GitHub token: their session, or on loopback the dev token. */
export const readerOf = (
  req: IncomingMessage,
  config: Config,
): { token: string; viewer: string | undefined; fromSession: boolean } | undefined => {
  const app = config.github.app;
  if (app !== undefined) {
    const session = open<Session>(app.sessionKey, SESSION_COOKIE, cookieOf(req, SESSION_COOKIE));
    if (session !== undefined && session.expiresAt > Date.now())
      return { token: session.token, viewer: session.login, fromSession: true };
  }
  if (config.github.devToken !== undefined)
    return { token: config.github.devToken, viewer: undefined, fromSession: false };
  return undefined;
};

/** Ends a session GitHub no longer honours, so the next click offers sign-in. */
export const forgetSession = (origin: string): string =>
  clearCookie(SESSION_COOKIE, "/", isSecure(origin));

const redirect = (res: ServerResponse, location: string, cookies: string[]): void => {
  res.writeHead(302, { location, "cache-control": "no-store", "set-cookie": cookies });
  res.end();
};

const failed = (res: ServerResponse, origin: string, message: string): void =>
  sendText(res, 400, "text/plain; charset=utf-8", `Sign-in failed: ${message}\n`, {
    "set-cookie": clearCookie(SIGN_IN_COOKIE, SIGN_IN_PATH, isSecure(origin)),
  });

type App = NonNullable<Config["github"]["app"]>;

/** `GET /auth/github/login?return=/c/{id}`: off to GitHub, with a fresh state and PKCE verifier sealed in a cookie. */
export const login = (res: ServerResponse, query: URLSearchParams, origin: string, app: App, github: GitHubClient): void => {
  const requested = query.get("return") ?? "";
  const signIn: SignIn = {
    state: randomBytes(16).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    returnTo: RETURN_TO.test(requested) ? requested : "/",
    expiresAt: Date.now() + SIGN_IN_TTL_MS,
  };
  const authorize = new URL(`${github.webUrl}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", app.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl(origin));
  authorize.searchParams.set("state", signIn.state);
  authorize.searchParams.set("code_challenge", createHash("sha256").update(signIn.verifier).digest("base64url"));
  authorize.searchParams.set("code_challenge_method", "S256");
  redirect(res, authorize.toString(), [
    setCookie(SIGN_IN_COOKIE, seal(app.sessionKey, SIGN_IN_COOKIE, signIn), {
      path: SIGN_IN_PATH,
      maxAge: SIGN_IN_TTL_MS / 1000,
      secure: isSecure(origin),
    }),
  ]);
};

/** `GET /auth/github/callback`: checks the state, trades the code for a token, and seals the token into the session cookie. */
export const callback = async (
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  origin: string,
  app: App,
  github: GitHubClient,
): Promise<void> => {
  const signIn = open<SignIn>(app.sessionKey, SIGN_IN_COOKIE, cookieOf(req, SIGN_IN_COOKIE));
  const code = query.get("code");
  const state = query.get("state");
  if (signIn === undefined || signIn.expiresAt < Date.now())
    return failed(res, origin, "the sign-in took too long or started in another browser; try again");
  if (code === null || state === null || !sameSecret(state, signIn.state))
    return failed(res, origin, "GitHub's answer did not match this sign-in");

  let session: Session;
  try {
    const { token, expiresIn } = await github.exchangeCode({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code,
      redirectUri: callbackUrl(origin),
      codeVerifier: signIn.verifier,
    });
    const lifetime = Math.min((expiresIn ?? Infinity) * 1000, SESSION_MAX_MS);
    session = { token, login: await github.login(token), expiresAt: Date.now() + lifetime };
  } catch (error) {
    if (error instanceof GitHubError) return failed(res, origin, error.message);
    throw error;
  }

  const secure = isSecure(origin);
  redirect(res, signIn.returnTo, [
    setCookie(SESSION_COOKIE, seal(app.sessionKey, SESSION_COOKIE, session), {
      path: "/",
      maxAge: (session.expiresAt - Date.now()) / 1000,
      secure,
    }),
    clearCookie(SIGN_IN_COOKIE, SIGN_IN_PATH, secure),
  ]);
};

/** `POST /auth/logout` */
export const logout = (res: ServerResponse, origin: string): void => {
  res.writeHead(204, { "cache-control": "no-store", "set-cookie": forgetSession(origin) });
  res.end();
};
