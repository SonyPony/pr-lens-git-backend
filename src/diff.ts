import { createHash } from "node:crypto";

import type { GitHubClient, Comparison } from "./github.ts";
import { highlight, languageOf, type Token } from "./highlight.ts";
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
  /** Syntax tokens, when the file's language is known. */
  h?: Token[];
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

/** A line of the whole-file view: `n` on the new side, `o` for a removed line on the old. */
export type FullLine = { t: "+" | "-" | " "; n?: number; o?: number; s: string; h?: Token[] };

/**
 * A whole file with its changes woven in: every line of the new version, the
 * added ones marked, and each removed line placed just before the line that
 * followed it. For a file the change deleted, `text` is the old version and
 * every line is marked removed.
 */
export const wholeFile = (text: string, hunks: readonly Hunk[], deleted: boolean): FullLine[] => {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (deleted) return lines.map((s, index) => ({ t: "-", o: index + 1, s }));

  const added = new Set<number>();
  const removedBefore = new Map<number, DiffLine[]>();
  for (const hunk of hunks) {
    let nextNew = hunk.newStart;
    const pending: DiffLine[] = [];
    for (const line of hunk.lines) {
      if (line.t === "-") {
        pending.push(line);
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
    for (const removed of removedBefore.get(n) ?? [])
      out.push(removed.o === undefined ? { t: "-", s: removed.s } : { t: "-", o: removed.o, s: removed.s });
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
/** Highlighted files held at once; each is one file at one commit, so it never goes stale. */
const MAX_FILES = 300;

/**
 * One promise per key, so concurrent clicks share a fetch; the oldest key goes
 * first once the map is full, and a failure is forgotten so the next click
 * asks again.
 */
const remember = <T>(cache: Map<string, Promise<T>>, key: string, limit: number, make: () => Promise<T>): Promise<T> => {
  const held = cache.get(key);
  if (held !== undefined) return held;
  const pending = make();
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
};

const hasLines = (hunks: readonly Hunk[], kinds: readonly DiffLine["t"][]): boolean =>
  hunks.some((hunk) => hunk.lines.some((line) => kinds.includes(line.t)));

/**
 * Per-reader access answers, and shared comparisons and file contents.
 *
 * A comparison, or a file at a commit, is the same bytes for every reader and
 * never changes, so one fetch serves everybody — but only ever after that
 * reader's own access check has passed, which is why the access cache is kept
 * apart from the others.
 */
export class DiffService {
  readonly #github: GitHubClient;
  readonly #access = new Map<string, { ok: boolean; until: number }>();
  readonly #comparisons = new Map<string, Promise<Comparison>>();
  readonly #files = new Map<string, Promise<{ text: string | undefined; tokens: Token[][] | undefined }>>();

  constructor(github: GitHubClient) {
    this.#github = github;
  }

  /** A file at a commit, and its colours. Undefined text for a file too large to fetch. */
  #file(token: string, provenance: Provenance, sha: string, path: string) {
    const { owner, name } = provenance.repo;
    return remember(this.#files, `${owner}/${name}@${sha}:${path}`.toLowerCase(), MAX_FILES, async () => {
      const text = await this.#github.file(token, owner, name, path, sha);
      return { text, tokens: text === undefined ? undefined : await highlight(path, text) };
    });
  }

  /**
   * Colours for the shown hunks: new-side lines from the new file, removed lines
   * from the old one. Best effort — a file that will not fetch or colour is
   * shown plain, never as an error.
   */
  async #colour(token: string, provenance: Provenance, changed: Comparison["files"][number], hunks: Hunk[]): Promise<void> {
    if (hunks.length === 0 || languageOf(changed.filename) === undefined) return;
    const wantNew = changed.status !== "removed" && hasLines(hunks, ["+", " "]);
    const wantOld = changed.status !== "added" && hasLines(hunks, ["-"]);
    try {
      const [newer, older] = await Promise.all([
        wantNew ? this.#file(token, provenance, provenance.head.sha, changed.filename) : undefined,
        wantOld
          ? this.#file(token, provenance, provenance.base.sha, changed.previousFilename ?? changed.filename)
          : undefined,
      ]);
      for (const hunk of hunks)
        for (const line of hunk.lines) {
          const tokens =
            line.t === "-"
              ? line.o === undefined ? undefined : older?.tokens?.[line.o - 1]
              : line.n === undefined ? undefined : newer?.tokens?.[line.n - 1];
          if (tokens !== undefined) line.h = tokens;
        }
    } catch {
      // Plain text it is.
    }
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
    return remember(
      this.#comparisons,
      `${repo.owner}/${repo.name}@${base.sha}...${head.sha}`.toLowerCase(),
      MAX_COMPARISONS,
      () => this.#github.compare(token, repo.owner, repo.name, base.sha, head.sha),
    );
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
    const files = await Promise.all(element.files.map(async (file): Promise<FileDiff> => {
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
      await this.#colour(token, provenance, changed, shown);
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
    }));
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
    const shown = await this.#file(token, provenance, sha, path);
    const hunks = changed?.patch === undefined ? [] : parsePatch(changed.patch);
    const lines = shown.text === undefined ? undefined : wholeFile(shown.text, hunks, deleted);

    if (lines !== undefined) {
      // Removed lines of a file still there take their colours from its old version.
      const older =
        !deleted && changed !== undefined && changed.status !== "added" && lines.some((line) => line.t === "-")
          ? await this.#file(token, provenance, provenance.base.sha, changed.previousFilename ?? path).catch(() => undefined)
          : undefined;
      for (const line of lines) {
        const tokens =
          line.t === "-"
            ? line.o === undefined ? undefined : (deleted ? shown.tokens : older?.tokens)?.[line.o - 1]
            : line.n === undefined ? undefined : shown.tokens?.[line.n - 1];
        if (tokens !== undefined) line.h = tokens;
      }
    }

    return {
      state: "ok-full",
      viewer,
      path,
      url: `${this.#github.webUrl}/${repo.owner}/${repo.name}/blob/${sha}/${path}`,
      lines,
    };
  }
}
