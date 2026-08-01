import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combine conditional Tailwind classes; later wins on conflicts. */
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }

/** "user input" → "user-input"; strips diacritics-ish + lowercases. */
export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
}

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
