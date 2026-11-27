import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combine conditional Tailwind classes; later wins on conflicts. */
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

/** "user input" → "user-input"; strips diacritics-ish + lowercases.
 *
 *  Runs of dashes collapse to ONE. The `+` above only collapses a run of
 *  characters it REPLACES, and `-` is a character it keeps, so anything that
 *  put dashes next to each other by two different routes got through: the
 *  ordinary task name "a - b" slugified to "a---b" (space, kept dash, space)
 *  and became a branch called that. `mă-duc` did the same through a stripped
 *  letter. Mirrors `slugify` in src-tauri/src/lib.rs, which derives the
 *  worktree DIRECTORY from the same name (`utils.test.ts` and lib.rs's
 *  `slugify_collapses_dash_runs` pin the pair against one case list). */
export function slugify(s: string) {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, c => FOLD.get(c) ?? "-")
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  // Windows cannot create a directory with a reserved device name, and the
  // slug is a worktree directory. On every OS, so a task named on a Mac
  // still checks out on a teammate's Windows machine.
  return WINDOWS_RESERVED.test(slug) ? `${slug}-1` : slug;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** Accented Latin letters a slug spells out instead of dropping (GH #472):
 *  ä→ae, ß→ss, the rest without the accent. The same string as `SLUG_FOLD`
 *  in termic-proto/src/lib.rs, byte for byte (`utils.test.ts` reads both). */
export const SLUG_FOLD = "ae:äæ;oe:öœ;ue:ü;ss:ß;th:þ;a:àáâãåāăą;c:çćčĉċ;d:ďđð;e:èéêëēĕėęě;g:ğĝġģ;h:ĥħ;i:ìíîïĩīĭįı;j:ĵ;k:ķ;l:ĺļľŀł;n:ñńņň;o:òóôõōŏőø;r:ŕŗř;s:śŝşšș;t:ţťŧț;u:ùúûũūŭůűų;w:ŵ;y:ýÿŷ;z:źżž";
const FOLD = new Map(SLUG_FOLD.split(";").flatMap(pair => {
  const [to, from] = pair.split(":");
  return [...from].map(c => [c, to] as const);
}));

/** Like {@link slugify} but PRESERVES slashes, so an already-qualified
 *  branch pasted from elsewhere (e.g. Linear's "username/my-feature")
 *  survives as a multi-segment git ref instead of being flattened to a
 *  single segment. Each path segment is slugified independently and
 *  empty segments (leading / trailing / double slashes) are dropped, so
 *  the result is always a git-legal branch name. */
export function branchify(s: string) {
  return s.split("/").map(slugify).filter(Boolean).join("/");
}

/** Split a textarea value (or array) into trimmed, non-empty lines. The
 *  canonical "one entry per line" cleanup used by the settings editors
 *  (excludes, sandbox paths/hosts, files-to-copy) before persisting. */
export function cleanLines(input: string | string[]): string[] {
  const arr = Array.isArray(input) ? input : input.split("\n");
  return arr.map(l => l.trim()).filter(Boolean);
}

/** Byte count as "812 B" / "245 KB" / "1.4 MB" (decimal units, one decimal
 *  place below 10 of a unit). */
export function formatBytes(n: number) {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  // 9.95, not 10: toFixed(1) would round it up to a "10.0" that contradicts
  // the one-decimal-below-10 rule.
  return v < 9.95 ? `${v.toFixed(1)} ${units[i]}` : `${Math.round(v)} ${units[i]}`;
}

/** Truncate path to "…/last/two/segments" when it gets long. */
export function shortPath(p: string, segments = 2) {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= segments) return p;
  return "…/" + parts.slice(-segments).join("/");
}
