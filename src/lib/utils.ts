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

/** Truncate path to "…/last/two/segments" when it gets long. */
export function shortPath(p: string, segments = 2) {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= segments) return p;
  return "…/" + parts.slice(-segments).join("/");
}
