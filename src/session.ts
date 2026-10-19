import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Sealed cookies: the reader's GitHub token travels to and from the browser
 * encrypted and authenticated, so the server keeps no session table and any
 * replica holding SESSION_KEY can read any reader's cookie.
 *
 * AES-256-GCM, with the cookie's name as associated data: a value sealed for
 * one cookie does not open as another, so the short-lived sign-in cookie can
 * never be replayed as a session.
 */

export const SESSION_COOKIE = "prl_session";
export const SIGN_IN_COOKIE = "prl_oauth";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const seal = (key: Buffer, name: string, value: unknown): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
};

/** The value, or undefined for anything tampered with, truncated or sealed under another name or key. */
export const open = <T>(key: Buffer, name: string, sealed: string | undefined): T | undefined => {
  if (sealed === undefined) return undefined;
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    return undefined;
  }
};

/** One cookie from the request, by name. */
export const cookieOf = (req: IncomingMessage, name: string): string | undefined => {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
};

/**
 * A Set-Cookie value. HttpOnly always: no script on any page may read a token.
 * Secure whenever the page is served over https, which every real deployment
 * is; a laptop on plain http still gets a working cookie.
 */
export const setCookie = (
  name: string,
  value: string,
  options: { path: string; maxAge: number; secure: boolean },
): string =>
  [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");

export const clearCookie = (name: string, path: string, secure: boolean): string =>
  setCookie(name, "", { path, maxAge: 0, secure });

/** What the session cookie holds. */
export type Session = {
  token: string;
  login: string;
  /** Epoch milliseconds; a GitHub App user token lives eight hours. */
  expiresAt: number;
};

/** What the sign-in cookie holds between the redirect to GitHub and the callback. */
export type SignIn = {
  state: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
};
