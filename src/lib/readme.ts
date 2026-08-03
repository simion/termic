// Which file in a directory counts as "the README" (issue #151).
//
// A directory tab renders a folder's README under its file list, the way
// GitHub does, so it needs a rule for what a README is. Kept here (not in
// the pane) so the matching is unit-testable without mounting React.

import type { FileEntry } from "@/lib/types";

/** Markdown extensions a README may carry, best first. A bare `README`
 *  ranks last: it still goes through the markdown pipeline, which
 *  degrades to plain paragraphs for plain text. Deliberately NOT here:
 *  `.txt` / `.rst`, which are not markdown and would render wrong. */
const README_EXTS = ["md", "markdown", "mdown", "mkd", "mkdn"];

const README_RE = new RegExp(`^readme(?:\\.(${README_EXTS.join("|")}))?$`, "i");

/** Pick a directory's README from its entries, or null when it has none.
 *  Matching is case-insensitive (`README.md`, `readme.md`, `ReadMe.MD`)
 *  and deterministic: with several candidates the earliest extension in
 *  README_EXTS wins, then the alphabetically first name — so re-reading
 *  the same directory never swaps which one renders. */
export function findReadme(entries: readonly FileEntry[]): string | null {
  let best: { name: string; rank: number } | null = null;
  for (const e of entries) {
    if (e.is_dir) continue;
    const m = README_RE.exec(e.name);
    if (!m) continue;
    // No capture group → bare `README`, which sorts after every extension.
    const rank = m[1] ? README_EXTS.indexOf(m[1].toLowerCase()) : README_EXTS.length;
    // Code-unit comparison, not localeCompare: the tie-break only has to be
    // STABLE, and locale collation orders case differently per platform.
    if (!best || rank < best.rank || (rank === best.rank && e.name < best.name)) {
      best = { name: e.name, rank };
    }
  }
  return best?.name ?? null;
}
