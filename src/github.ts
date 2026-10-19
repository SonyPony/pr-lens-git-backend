import type { GitHubConfig } from "./config.ts";
import { VERSION } from "./version.ts";

/**
 * The few GitHub calls the diff panel needs, always made with the reader's own
 * token, so GitHub itself decides who may read which repository.
 *
 * The addresses are settings rather than constants so the tests can stand a
 * fake GitHub up on a local port, and an Enterprise Server host would need no
 * code change.
 */

export type GitHubSettings = Pick<GitHubConfig, "apiUrl" | "webUrl" | "timeoutMs">;

/** One changed file of a comparison, as much of it as the panel uses. */
export type ComparedFile = {
  filename: string;
  previousFilename: string | undefined;
  status: string;
  /** Absent for a binary file, or one too large for GitHub to inline a patch. */
  patch: string | undefined;
};

export type Comparison = { files: ComparedFile[] };

/** A call GitHub refused; `status` is GitHub's own. */
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/** Largest file the whole-file view will fetch. */
const MAX_FILE_BYTES = 1_000_000;
const USER_AGENT = `pr-lens-git-backend/${VERSION}`;

export class GitHubClient {
  readonly #settings: GitHubSettings;

  constructor(settings: GitHubSettings) {
    this.#settings = settings;
  }

  get webUrl(): string {
    return this.#settings.webUrl;
  }

  async #call(token: string, path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const response = await fetch(`${this.#settings.apiUrl}${path}`, {
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(this.#settings.timeoutMs),
    });
    if (!response.ok) {
      // Drained, so the connection can be reused.
      await response.text().catch(() => "");
      throw new GitHubError(response.status, `GitHub answered ${response.status} for ${path.split("?")[0]}`);
    }
    return response;
  }

  /** The signed-in user's login. */
  async login(token: string): Promise<string> {
    const user = (await (await this.#call(token, "/user")).json()) as { login?: unknown };
    if (typeof user.login !== "string") throw new GitHubError(502, "GitHub sent a user without a login");
    return user.login;
  }

  /** Whether the token can read the repository; false on GitHub's 403 and 404 alike. */
  async canRead(token: string, owner: string, repo: string): Promise<boolean> {
    try {
      await this.#call(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return false;
      throw error;
    }
  }

  /** The files that changed between two commits; GitHub lists at most 300. */
  async compare(token: string, owner: string, repo: string, base: string, head: string): Promise<Comparison> {
    const body = (await (
      await this.#call(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
    ).json()) as { files?: Array<Record<string, unknown>> };

    return {
      files: (body.files ?? []).map((file) => ({
        filename: String(file.filename),
        previousFilename: typeof file.previous_filename === "string" ? file.previous_filename : undefined,
        status: String(file.status),
        patch: typeof file.patch === "string" ? file.patch : undefined,
      })),
    };
  }

  /**
   * A file's text at one commit, or undefined when it is larger than
   * MAX_FILE_BYTES. Read as raw bytes, so no base64 round trip.
   */
  async file(token: string, owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
    const response = await this.#call(
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      "application/vnd.github.raw+json",
    );
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      await response.body?.cancel();
      return undefined;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) return undefined;
    return new TextDecoder().decode(bytes);
  }

  /** The OAuth code exchange of a GitHub App's user sign-in. */
  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<{ token: string; expiresIn: number | undefined }> {
    const response = await fetch(`${this.#settings.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }),
      signal: AbortSignal.timeout(this.#settings.timeoutMs),
    });
    // GitHub answers 200 with an `error` field for a bad code, so both are read.
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== "string")
      throw new GitHubError(response.ok ? 400 : response.status, `GitHub refused the sign-in: ${String(body.error ?? response.status)}`);
    return {
      token: body.access_token,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
    };
  }
}
