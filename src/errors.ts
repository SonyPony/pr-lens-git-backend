/**
 * The refusal envelope, and the one class every route throws.
 *
 * The contract's error table is closed: a client that meets only these codes
 * understands every refusal in full, and anything else it reads as the server
 * being unavailable. So an internal fault must never leak out as a new code —
 * it leaves as a bare 500 with no envelope, which is exactly what the CLI
 * reports as unavailable.
 */

export type Issue = { code: string; path: string; message: string };

type Extra =
  | { kind: "none" }
  | { kind: "issues"; issues: readonly Issue[] }
  | { kind: "rev"; rev: number }
  | { kind: "retryAt"; retryAt: string };

const STATUS = {
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  INVALID_DOCUMENT: 422,
  CANNOT_DRAW: 422,
  REVISION_MOVED: 409,
  DELETION_INCOMPLETE: 409,
  RATE_LIMITED: 429,
  TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
} as const;

export type ErrorCode = keyof typeof STATUS;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: Extra;

  constructor(code: ErrorCode, message: string, extra: Extra = { kind: "none" }) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.extra = extra;
  }

  body(): { error: Record<string, unknown> } {
    const error: Record<string, unknown> = {
      code: this.code,
      message: this.message,
    };
    if (this.extra.kind === "issues") error.issues = this.extra.issues;
    if (this.extra.kind === "rev") error.rev = this.extra.rev;
    if (this.extra.kind === "retryAt") error.retryAt = this.extra.retryAt;
    return { error };
  }
}

/**
 * One answer for three cases — an id nobody minted, a right id with a wrong
 * token, and a canvas minted but never pushed to — so that a guesser cannot
 * learn which ids exist.
 */
export const notFound = (): ApiError =>
  new ApiError("NOT_FOUND", "No such canvas, or the write token is wrong");

export const invalidRequest = (message: string): ApiError =>
  new ApiError("INVALID_REQUEST", message);

export const invalidDocument = (issues: readonly Issue[]): ApiError =>
  new ApiError(
    "INVALID_DOCUMENT",
    "That is not a graph document this server can store",
    { kind: "issues", issues },
  );

export const cannotDraw = (message: string): ApiError =>
  new ApiError("CANNOT_DRAW", message);

export const revisionMoved = (rev: number): ApiError =>
  new ApiError(
    "REVISION_MOVED",
    "The canvas has moved on since you pulled it; pull again, then push",
    { kind: "rev", rev },
  );

export const deletionIncomplete = (message: string): ApiError =>
  new ApiError("DELETION_INCOMPLETE", message);

export const rateLimited = (retryAt: Date, message: string): ApiError =>
  new ApiError("RATE_LIMITED", message, {
    kind: "retryAt",
    retryAt: retryAt.toISOString(),
  });

/**
 * A mint without one of the push tokens this server was given. The contract's
 * own code for a bearer it does not accept, so the CLI says "did not accept
 * this sign-in" rather than calling the server unavailable.
 */
export const unauthenticated = (): ApiError =>
  new ApiError(
    "UNAUTHENTICATED",
    "This server only mints canvases for a push token it was given; set PR_LENS_TOKEN",
  );

export const tooLarge = (limit: number): ApiError =>
  new ApiError(
    "TOO_LARGE",
    `That document is larger than this server accepts (${limit} bytes)`,
  );
