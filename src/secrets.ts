import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ids and write tokens: 128 random bits as base64url, 22 characters, no
 * padding. Both halves of the contract's capability pair look the same
 * because they are the same thing pointed in different directions — one reads,
 * one writes.
 */
const SECRET = /^[A-Za-z0-9_-]{22}$/;

export const mintSecret = (): string => randomBytes(16).toString("base64url");

export const isSecret = (value: unknown): value is string =>
  typeof value === "string" && SECRET.test(value);

/**
 * A plain digest, deliberately: a write token is 128 bits of uniform
 * randomness, so there is no dictionary to stretch out of reach and a slow KDF
 * would only tax every push. What matters is that the stored form is one-way,
 * so a copy of the store is not a copy of every token.
 */
export const hashToken = (token: string): string =>
  `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;

/** Constant time, so a wrong token cannot be narrowed down by timing it. */
export const tokenMatches = (token: string, hash: string): boolean => {
  const candidate = Buffer.from(hashToken(token), "utf8");
  const stored = Buffer.from(hash, "utf8");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
};

/** Two secrets compared in constant time, for values held as they are rather than hashed. */
export const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** The bearer token, or undefined when the header is absent or malformed. */
export const bearerToken = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1];
};
