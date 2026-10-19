import type { Provenance } from "@coldtea/pr-lens-schema";

import type { ClickableElement } from "./elements.ts";
import { GitHubError, type Comparison, type GitHubClient } from "./github.ts";
import { highlight, languageOf, type Token } from "./highlight.ts";
import { hashToken } from "./secrets.ts";

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

/**
 * A whole file with its changes woven in: every line of the new version, the
 * added ones marked, and each removed line placed just before the line that
 * followed it. For a file the change deleted, `text` is the old version and
 * every line is marked removed.
 */
export const wholeFile = (text: string, hunks: readonly Hunk[], deleted: boolean): DiffLine[] => {
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

  const out: DiffLine[] = [];
  for (let n = 1; n <= lines.length + 1; n += 1) {
    for (const removed of removedBefore.get(n) ?? []) out.push({ t: "-", o: removed.o, s: removed.s });
    if (n <= lines.length) out.push({ t: added.has(n) ? "+" : " ", n, s: lines[n - 1] ?? "" });
  }
  return out;
};

/**
 * Colours lines from the files they belong to: a removed line from the old
 * version by its old number, any other line from the new version by its new one.
 */
const attach = (lines: readonly DiffLine[], newer: Token[][] | undefined, older: Token[][] | undefined): void => {
  for (const line of lines) {
    const tokens =
      line.t === "-"
        ? line.o === undefined ? undefined : older?.[line.o - 1]
        : line.n === undefined ? undefined : newer?.[line.n - 1];
    if (tokens !== undefined) line.h = tokens;
  }
};

export type FileDiff = {
  path: string;
  /** GitHub's word for it, or "unchanged" when the comparison does not list the file. */
  status: string;
  url: string;
  hunks: Hunk[];
  /** Hunks of this file outside the element's range, not shown. */
  otherHunks: number;
  /** GitHub sent no patch: a binary file, or one too large to inline. */
  noPatch: boolean;
};

export type DiffAnswer =
  | { state: "ok"; viewer: string | undefined; files: FileDiff[] }
  | { state: "ok-full"; lines: DiffLine[] | undefined }
  | { state: "signin"; loginUrl: string | undefined }
  | { state: "no-access"; repo: string; viewer: string | undefined }
  | { state: "unavailable"; reason: string };

/** What the service answers: a DiffAnswer, or GitHub turning the reader's token away. */
export type DiffResult = DiffAnswer | { state: "rejected" };

const ACCESS_OK_MS = 5 * 60_000;
const ACCESS_DENIED_MS = 60_000;
/** Readers' access answers held at once; past it, expired ones go first, then the oldest. */
const MAX_ACCESS = 10_000;
const COMPARISON_BUDGET = 32_000_000;
const FILE_BUDGET = 64_000_000;
/** Rough heap cost of one token: two short strings, a number and an array. */
const TOKEN_BYTES = 64;

/**
 * Promises by key under a byte budget, least recently used out first. A
 * failure is forgotten, so the next click asks again, and concurrent clicks
 * share one fetch.
 */
class BudgetCache<T> {
  readonly #entries = new Map<string, { value: Promise<T>; bytes: number }>();
  readonly #budget: number;
  readonly #sizeOf: (value: T) => number;
  #total = 0;

  constructor(budget: number, sizeOf: (value: T) => number) {
    this.#budget = budget;
    this.#sizeOf = sizeOf;
  }

  get(key: string, make: () => Promise<T>): Promise<T> {
    const held = this.#entries.get(key);
    if (held !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, held);
      return held.value;
    }
    const entry = { value: make(), bytes: 0 };
    this.#entries.set(key, entry);
    entry.value.then(
      (value) => {
        if (this.#entries.get(key) !== entry) return;
        entry.bytes = this.#sizeOf(value);
        this.#total += entry.bytes;
        for (const [oldest, held] of this.#entries) {
          if (this.#total <= this.#budget) break;
          this.#entries.delete(oldest);
          this.#total -= held.bytes;
        }
      },
      () => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      },
    );
    return entry.value;
  }
}

type HeldFile = { text: string | undefined; tokens: Token[][] | undefined };

const hasLines = (hunks: readonly Hunk[], kinds: readonly DiffLine["t"][]): boolean =>
  hunks.some((hunk) => hunk.lines.some((line) => kinds.includes(line.t)));

/**
 * The code behind an element, for one reader.
 *
 * A comparison, or a file at a commit, is the same bytes for every reader and
 * never changes, so one fetch serves everybody — but only ever after that
 * reader's own access check has passed, which is why access answers are kept
 * per reader and apart from the shared caches, and why `answer` is the only
 * way in.
 */
export class DiffService {
  readonly #github: GitHubClient;
  /** The only host whose changes can be shown: the one readers sign in to. */
  readonly #host: string;
  readonly #access = new Map<string, { ok: boolean; until: number }>();
  readonly #comparisons = new BudgetCache<Comparison>(COMPARISON_BUDGET, (comparison) =>
    comparison.files.reduce((sum, file) => sum + 2 * (file.patch?.length ?? 0) + 200, 0),
  );
  readonly #files = new BudgetCache<HeldFile>(FILE_BUDGET, (file) =>
    2 * (file.text?.length ?? 0) + TOKEN_BYTES * (file.tokens?.reduce((sum, line) => sum + line.length, 0) ?? 0),
  );

  constructor(github: GitHubClient) {
    this.#github = github;
    this.#host = new URL(github.webUrl).host;
  }

  /**
   * The element's changed lines, or with `full` one of its files whole. Undefined
   * when `full` is not one of the element's own files.
   */
  async answer(
    reader: { token: string; viewer: string | undefined },
    provenance: Provenance,
    element: ClickableElement,
    full: string | null,
  ): Promise<DiffResult | undefined> {
    if (provenance.repo.host !== this.#host)
      return { state: "unavailable", reason: `Only changes on ${this.#host} can be shown.` };
    const { owner, name } = provenance.repo;
    try {
      if (!(await this.#canRead(reader.token, owner, name)))
        return { state: "no-access", repo: `${owner}/${name}`, viewer: reader.viewer };
      return full === null
        ? await this.#changes(reader.token, reader.viewer, provenance, element)
        : await this.#whole(reader.token, provenance, element, full);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (error.status === 401) return { state: "rejected" };
      return { state: "unavailable", reason: `GitHub could not show these changes (${error.status}).` };
    }
  }

  async #canRead(token: string, owner: string, name: string): Promise<boolean> {
    const key = `${hashToken(token)}|${owner}/${name}`.toLowerCase();
    const now = Date.now();
    const cached = this.#access.get(key);
    if (cached !== undefined && cached.until > now) return cached.ok;
    this.#access.delete(key);

    const ok = await this.#github.canRead(token, owner, name);
    if (this.#access.size >= MAX_ACCESS) {
      for (const [stale, entry] of this.#access) if (entry.until <= now) this.#access.delete(stale);
      const oldest = this.#access.keys().next().value;
      if (this.#access.size >= MAX_ACCESS && oldest !== undefined) this.#access.delete(oldest);
    }
    this.#access.set(key, { ok, until: now + (ok ? ACCESS_OK_MS : ACCESS_DENIED_MS) });
    return ok;
  }

  #compare(token: string, provenance: Provenance): Promise<Comparison> {
    const { repo, base, head } = provenance;
    return this.#comparisons.get(`${repo.owner}/${repo.name}@${base.sha}...${head.sha}`.toLowerCase(), () =>
      this.#github.compare(token, repo.owner, repo.name, base.sha, head.sha),
    );
  }

  /** A file at a commit, and its colours. Undefined text for a file too large to fetch. */
  #file(token: string, provenance: Provenance, sha: string, path: string): Promise<HeldFile> {
    const { owner, name } = provenance.repo;
    return this.#files.get(`${owner}/${name}@${sha}:${path}`.toLowerCase(), async () => {
      const text = await this.#github.file(token, owner, name, path, sha);
      return { text, tokens: text === undefined ? undefined : await highlight(path, text) };
    });
  }

  #blobUrl(provenance: Provenance, sha: string, path: string): string {
    return `${this.#github.webUrl}/${provenance.repo.owner}/${provenance.repo.name}/blob/${sha}/${path}`;
  }

  /**
   * Colours for the shown hunks. Best effort: a file that will not fetch or
   * colour is shown plain, never as an error.
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
      for (const hunk of hunks) attach(hunk.lines, newer?.tokens, older?.tokens);
    } catch {
      // Plain text it is.
    }
  }

  async #changes(
    token: string,
    viewer: string | undefined,
    provenance: Provenance,
    element: ClickableElement,
  ): Promise<DiffAnswer> {
    const comparison = await this.#compare(token, provenance);
    const files = await Promise.all(
      element.files.map(async (file): Promise<FileDiff> => {
        const oldSide = file.revision === "base" || element.delta === "removed";
        const changed = comparison.files.find(
          (candidate) => candidate.filename === file.path || (oldSide && candidate.previousFilename === file.path),
        );
        const url = this.#blobUrl(provenance, oldSide ? provenance.base.sha : provenance.head.sha, file.path);
        if (changed === undefined)
          return { path: file.path, status: "unchanged", url, hunks: [], otherHunks: 0, noPatch: false };

        const all = changed.patch === undefined ? [] : parsePatch(changed.patch);
        const shown = hunksInRange(all, oldSide ? "old" : "new", file.startLine, file.endLine);
        await this.#colour(token, provenance, changed, shown);
        return {
          path: file.path,
          status: changed.status,
          url,
          hunks: shown,
          otherHunks: all.length - shown.length,
          noPatch: changed.patch === undefined,
        };
      }),
    );
    return { state: "ok", viewer, files };
  }

  async #whole(
    token: string,
    provenance: Provenance,
    element: ClickableElement,
    path: string,
  ): Promise<DiffAnswer | undefined> {
    if (!element.files.some((candidate) => candidate.path === path)) return undefined;

    // The new version is what is shown unless the change deleted the file, so it
    // is fetched alongside the comparison rather than after it.
    const [comparison, head] = await Promise.all([
      this.#compare(token, provenance),
      this.#file(token, provenance, provenance.head.sha, path).catch(() => undefined),
    ]);
    const changed = comparison.files.find((candidate) => candidate.filename === path);
    const deleted = changed?.status === "removed";
    const shown = deleted || head === undefined
      ? await this.#file(token, provenance, deleted ? provenance.base.sha : provenance.head.sha, path)
      : head;
    if (shown.text === undefined) return { state: "ok-full", lines: undefined };

    const hunks = changed?.patch === undefined ? [] : parsePatch(changed.patch);
    const lines = wholeFile(shown.text, hunks, deleted);
    if (deleted) attach(lines, undefined, shown.tokens);
    else {
      // Removed lines of a file still there take their colours from its old version.
      const older =
        changed !== undefined && changed.status !== "added" && lines.some((line) => line.t === "-")
          ? await this.#file(token, provenance, provenance.base.sha, changed.previousFilename ?? path).catch(
              () => undefined,
            )
          : undefined;
      attach(lines, shown.tokens, older?.tokens);
    }
    return { state: "ok-full", lines };
  }
}
