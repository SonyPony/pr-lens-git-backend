import { createHash } from "node:crypto";

import type { GitHubClient, Comparison } from "./github.ts";
import type { ClickableElement } from "./page.ts";

/**
 * What a click on a diagram element shows: the code it stands for, as it
 * changed between the document's base and head commits.
 *
 * Everything that picks a repository, a commit or a file comes from the stored
 * document, never from the request: the reader names an element, and the
 * document says which code that element is. The token is the reader's own, so
 * GitHub, not this server, decides whether they may see it.
 */

export type DiffLine = {
  /** "+" added, "-" removed, " " context. */
  t: "+" | "-" | " ";
  /** Line number on the old side, for "-" and " ". */
  o?: number;
  /** Line number on the new side, for "+" and " ". */
  n?: number;
  s: string;
};

export type Hunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

/** A unified diff's hunks, numbered on both sides. Anything before the first `@@` is ignored. */
export const parsePatch = (patch: string): Hunk[] => {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  // One trailing newline would otherwise read as a blank context line.
  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      current = {
        header: raw,
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }
    if (current === undefined) continue;
    const kind = raw[0];
    const text = raw.slice(1);
    if (kind === "+") current.lines.push({ t: "+", n: newLine++, s: text });
    else if (kind === "-") current.lines.push({ t: "-", o: oldLine++, s: text });
    else if (kind === " " || raw === "") current.lines.push({ t: " ", o: oldLine++, n: newLine++, s: text });
    // "\ No newline at end of file" and the like carry no line.
  }
  return hunks;
};

/**
 * The hunks that touch a line range on one side. No range is the whole file;
 * a hunk that only inserts on that side (count 0) is kept when it sits inside.
 */
export const hunksInRange = (
  hunks: readonly Hunk[],
  side: "old" | "new",
  start: number | undefined,
  end: number | undefined,
): Hunk[] => {
  if (start === undefined) return [...hunks];
  const last = end ?? start;
  return hunks.filter((hunk) => {
    const from = side === "old" ? hunk.oldStart : hunk.newStart;
    const count = side === "old" ? hunk.oldCount : hunk.newCount;
    const to = from + Math.max(count, 1) - 1;
    return from <= last && to >= start;
  });
};

export type FullLine = { t: "+" | "-" | " "; n?: number; s: string };

/**
 * A whole file with its changes woven in: every line of the new version, the
 * added ones marked, and each removed line placed just before the line that
 * followed it. For a file the change deleted, `text` is the old version and
 * every line is marked removed.
 */
export const wholeFile = (text: string, hunks: readonly Hunk[], deleted: boolean): FullLine[] => {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (deleted) return lines.map((s, index) => ({ t: "-", n: index + 1, s }));

  const added = new Set<number>();
  const removedBefore = new Map<number, string[]>();
  for (const hunk of hunks) {
    let nextNew = hunk.newStart;
    const pending: string[] = [];
    for (const line of hunk.lines) {
      if (line.t === "-") {
        pending.push(line.s);
        continue;
      }
      // A removed run belongs before the next line that survives on the new side.
      const at = line.n ?? nextNew;
      if (pending.length > 0) removedBefore.set(at, [...(removedBefore.get(at) ?? []), ...pending.splice(0)]);
      if (line.t === "+") added.add(at);
      nextNew = at + 1;
    }
    if (pending.length > 0) removedBefore.set(nextNew, [...(removedBefore.get(nextNew) ?? []), ...pending]);
  }

  const out: FullLine[] = [];
  for (let n = 1; n <= lines.length + 1; n += 1) {
    for (const s of removedBefore.get(n) ?? []) out.push({ t: "-", s });
    if (n <= lines.length) out.push({ t: added.has(n) ? "+" : " ", n, s: lines[n - 1] ?? "" });
  }
  return out;
};

export type FileDiff = {
  path: string;
  previousPath?: string;
  /** GitHub's word for it, or "unchanged" when the comparison does not list the file. */
  status: string;
  /** The range the document points at, e.g. "L3–9", when it names one. */
  range?: string;
  url: string;
  hunks: Hunk[];
  /** Hunks of this file outside the element's range, not shown. */
  otherHunks: number;
  /** GitHub sent no patch: a binary file, or one too large to inline. */
  noPatch: boolean;
};

export type DiffAnswer =
  | { state: "ok"; viewer: string | undefined; repo: string; files: FileDiff[] }
  | {
      state: "ok-full";
      viewer: string | undefined;
      path: string;
      url: string;
      lines: FullLine[] | undefined;
    }
  | { state: "signin"; loginUrl: string | undefined }
  | { state: "no-access"; repo: string; viewer: string | undefined }
  | { state: "unavailable"; reason: string };

export type Provenance = {
  repo: { owner: string; name: string; host: string };
  base: { sha: string };
  head: { sha: string };
};

const ACCESS_OK_MS = 5 * 60_000;
const ACCESS_DENIED_MS = 60_000;
const MAX_COMPARISONS = 200;

/**
 * Per-reader access answers and shared comparisons.
 *
 * A comparison is the same bytes for every reader, and a commit pair never
 * changes, so one fetch serves everybody — but only ever after that reader's
 * own access check has passed, which is why the two caches are kept apart.
 */
export class DiffService {
  readonly #github: GitHubClient;
  readonly #access = new Map<string, { ok: boolean; until: number }>();
  readonly #comparisons = new Map<string, Promise<Comparison>>();

  constructor(github: GitHubClient) {
    this.#github = github;
  }

  async canRead(token: string, owner: string, name: string): Promise<boolean> {
    const key = `${createHash("sha256").update(token).digest("hex")}|${owner}/${name}`.toLowerCase();
    const cached = this.#access.get(key);
    if (cached !== undefined && cached.until > Date.now()) return cached.ok;
    const ok = await this.#github.canRead(token, owner, name);
    this.#access.set(key, { ok, until: Date.now() + (ok ? ACCESS_OK_MS : ACCESS_DENIED_MS) });
    return ok;
  }

  #compare(token: string, provenance: Provenance): Promise<Comparison> {
    const { repo, base, head } = provenance;
    const key = `${repo.owner}/${repo.name}@${base.sha}...${head.sha}`.toLowerCase();
    let pending = this.#comparisons.get(key);
    if (pending === undefined) {
      pending = this.#github.compare(token, repo.owner, repo.name, base.sha, head.sha);
      // A failure is not remembered: the next click asks again.
      pending.catch(() => this.#comparisons.delete(key));
      this.#comparisons.set(key, pending);
      if (this.#comparisons.size > MAX_COMPARISONS) {
        const oldest = this.#comparisons.keys().next().value;
        if (oldest !== undefined) this.#comparisons.delete(oldest);
      }
    }
    return pending;
  }

  /** The element's files as hunks; the caller has already checked access. */
  async element(
    token: string,
    viewer: string | undefined,
    provenance: Provenance,
    element: ClickableElement,
  ): Promise<DiffAnswer> {
    const comparison = await this.#compare(token, provenance);
    const { repo } = provenance;
    const files = element.files.map((file): FileDiff => {
      const oldSide = file.revision === "base" || element.delta === "removed";
      const changed = comparison.files.find(
        (candidate) =>
          candidate.filename === file.path || (oldSide && candidate.previousFilename === file.path),
      );
      const sha = oldSide ? provenance.base.sha : provenance.head.sha;
      const range =
        file.startLine === undefined
          ? undefined
          : `L${file.startLine}${file.endLine !== undefined && file.endLine !== file.startLine ? `–${file.endLine}` : ""}`;
      const url = `${this.#github.webUrl}/${repo.owner}/${repo.name}/blob/${sha}/${file.path}`;

      if (changed === undefined)
        return { path: file.path, status: "unchanged", range, url, hunks: [], otherHunks: 0, noPatch: false };

      const all = changed.patch === undefined ? [] : parsePatch(changed.patch);
      const shown = hunksInRange(all, oldSide ? "old" : "new", file.startLine, file.endLine);
      return {
        path: file.path,
        ...(changed.previousFilename === undefined ? {} : { previousPath: changed.previousFilename }),
        status: changed.status,
        range,
        url,
        hunks: shown,
        otherHunks: all.length - shown.length,
        noPatch: changed.patch === undefined,
      };
    });
    return { state: "ok", viewer, repo: `${repo.owner}/${repo.name}`, files };
  }

  /** One of the element's files in full, with its changes woven in. */
  async whole(
    token: string,
    viewer: string | undefined,
    provenance: Provenance,
    element: ClickableElement,
    path: string,
  ): Promise<DiffAnswer | undefined> {
    const file = element.files.find((candidate) => candidate.path === path);
    if (file === undefined) return undefined;

    const comparison = await this.#compare(token, provenance);
    const changed = comparison.files.find((candidate) => candidate.filename === path);
    const deleted = changed?.status === "removed";
    const sha = deleted ? provenance.base.sha : provenance.head.sha;
    const { repo } = provenance;
    const text = await this.#github.file(token, repo.owner, repo.name, path, sha);
    const hunks = changed?.patch === undefined ? [] : parsePatch(changed.patch);

    return {
      state: "ok-full",
      viewer,
      path,
      url: `${this.#github.webUrl}/${repo.owner}/${repo.name}/blob/${sha}/${path}`,
      lines: text === undefined ? undefined : wholeFile(text, hunks, deleted),
    };
  }
}
