import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "./config.ts";
import { GitHubError, type GitHubClient } from "./github.ts";
import { sendText } from "./http.ts";
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
 * The flow: `/auth/github/login` seals a fresh state and PKCE verifier into a
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

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * The three auth routes, or false when the path is none of them. Answers
 * NOT_FOUND-shaped silence (false) when sign-in is not configured, so a server
 * without an App looks exactly like one that never had these routes.
 */
export const handleAuth = async (
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
  origin: string,
  config: Config,
  github: GitHubClient,
): Promise<boolean> => {
  const app = config.github.app;
  if (app === undefined || (!path.startsWith(`${SIGN_IN_PATH}/`) && path !== "/auth/logout")) return false;
  const method = req.method ?? "GET";
  const secure = isSecure(origin);

  if (path === `${SIGN_IN_PATH}/login` && method === "GET") {
    const requested = query.get("return") ?? "";
    const signIn: SignIn = {
      state: randomBytes(16).toString("base64url"),
      verifier: randomBytes(32).toString("base64url"),
      returnTo: RETURN_TO.test(requested) ? requested : "/",
      expiresAt: Date.now() + SIGN_IN_TTL_MS,
    };
    const challenge = createHash("sha256").update(signIn.verifier).digest("base64url");
    const authorize = new URL(`${github.webUrl}/login/oauth/authorize`);
    authorize.searchParams.set("client_id", app.clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl(origin));
    authorize.searchParams.set("state", signIn.state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    redirect(res, authorize.toString(), [
      setCookie(SIGN_IN_COOKIE, seal(app.sessionKey, SIGN_IN_COOKIE, signIn), {
        path: SIGN_IN_PATH,
        maxAge: SIGN_IN_TTL_MS / 1000,
        secure,
      }),
    ]);
    return true;
  }

  if (path === `${SIGN_IN_PATH}/callback` && method === "GET") {
    const signIn = open<SignIn>(app.sessionKey, SIGN_IN_COOKIE, cookieOf(req, SIGN_IN_COOKIE));
    const code = query.get("code");
    const state = query.get("state");
    if (signIn === undefined || signIn.expiresAt < Date.now()) {
      failed(res, origin, "the sign-in took too long or started in another browser; try again");
      return true;
    }
    if (code === null || state === null || !same(state, signIn.state)) {
      failed(res, origin, "GitHub's answer did not match this sign-in");
      return true;
    }

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
      if (error instanceof GitHubError) {
        failed(res, origin, error.message);
        return true;
      }
      throw error;
    }

    redirect(res, signIn.returnTo, [
      setCookie(SESSION_COOKIE, seal(app.sessionKey, SESSION_COOKIE, session), {
        path: "/",
        maxAge: (session.expiresAt - Date.now()) / 1000,
        secure,
      }),
      clearCookie(SIGN_IN_COOKIE, SIGN_IN_PATH, secure),
    ]);
    return true;
  }

  if (path === "/auth/logout" && method === "POST") {
    res.writeHead(204, { "cache-control": "no-store", "set-cookie": forgetSession(origin) });
    res.end();
    return true;
  }

  return false;
};
