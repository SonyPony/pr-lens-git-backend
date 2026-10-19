import { basename, extname } from "node:path";

import { bundledLanguages, bundledLanguagesAlias, codeToTokensWithThemes } from "shiki";

/**
 * Syntax colours for the diff panel, in GitHub's own light and dark themes.
 *
 * A whole file is highlighted, never a hunk: a hunk that starts inside a
 * docstring or a template literal would otherwise be coloured as code. Each
 * diff line then takes its tokens from the file it belongs to by line number,
 * which is how GitHub colours a diff too.
 *
 * Tokens leave as data — text, two colours, a style — and the page builds them
 * with textContent, so highlighting never puts markup from a file on the page.
 */

/** `[text]` in the default colour, or `[text, light, dark, style]`; style is Shiki's bit set: 1 italic, 2 bold, 4 underline. */
export type Token = [string] | [string, string, string, number];

/** Beyond this a file is shown plain: highlighting is linear, but not free. */
const MAX_HIGHLIGHT_BYTES = 300_000;

const DEFAULT_LIGHT = "#24292E";
const DEFAULT_DARK = "#E1E4E8";

/** Files whose name, not extension, says what they are. */
const BY_NAME: Record<string, string> = {
  Dockerfile: "docker",
  Makefile: "make",
  Jenkinsfile: "groovy",
  "CMakeLists.txt": "cmake",
};

export const languageOf = (path: string): string | undefined => {
  const name = basename(path);
  const named = BY_NAME[name];
  if (named !== undefined) return named;
  const extension = extname(name).slice(1).toLowerCase();
  if (extension === "") return undefined;
  if (extension in bundledLanguages || extension in bundledLanguagesAlias) return extension;
  return undefined;
};

/** One token list per line of `text`, or undefined for a language Shiki lacks or a file too large to colour. */
export const highlight = async (path: string, text: string): Promise<Token[][] | undefined> => {
  const lang = languageOf(path);
  if (lang === undefined || Buffer.byteLength(text) > MAX_HIGHLIGHT_BYTES) return undefined;
  const code = text.endsWith("\n") ? text.slice(0, -1) : text;
  try {
    const lines = await codeToTokensWithThemes(code, {
      lang: lang as never,
      themes: { light: "github-light", dark: "github-dark" },
    });
    return lines.map((line) =>
      line.map((token): Token => {
        const light = token.variants.light?.color ?? DEFAULT_LIGHT;
        const dark = token.variants.dark?.color ?? DEFAULT_DARK;
        const style = token.variants.light?.fontStyle ?? 0;
        return light.toUpperCase() === DEFAULT_LIGHT && dark.toUpperCase() === DEFAULT_DARK && style <= 0
          ? [token.content]
          : [token.content, light, dark, Math.max(0, style)];
      }),
    );
  } catch {
    // A grammar that fails on odd input costs the colours, never the diff.
    return undefined;
  }
};
