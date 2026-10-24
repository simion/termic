// Source-line helpers shared by the preview's line-number gutter, its
// selection chip and go to line. Lines are 1-based and inclusive, the same
// numbering as the data-src-line / data-src-end stamps and the DocModel.

export interface LineRange { startLine: number; endLine: number }

/** `337` or `337-342`. */
export function rangeText(r: LineRange): string {
  return r.endLine > r.startLine ? `${r.startLine}-${r.endLine}` : `${r.startLine}`;
}

/** What a copied reference says: `docs/plan.md:337-342`, or just the range
 *  when the preview has no task-relative path to name. */
export function lineRef(path: string | undefined, r: LineRange): string {
  return path ? `${path}:${rangeText(r)}` : rangeText(r);
}

/** The stamped range of a rendered block, null for an unstamped element. The
 *  one reader of the data-src-line / data-src-end stamps. */
export function elRange(el: Element): LineRange | null {
  const s = Number(el.getAttribute("data-src-line"));
  if (!s) return null;
  return { startLine: s, endLine: Math.max(s, Number(el.getAttribute("data-src-end")) || s) };
}

/** Lines a..b (1-based, inclusive) of `text`, \n-joined, the same as
 *  `text.split("\n").slice(a - 1, b).join("\n")` without splitting the whole
 *  document (this runs per selectionchange). */
export function sliceLines(text: string, a: number, b: number): string {
  let from = 0;
  for (let n = 1; n < a; n++) {
    const i = text.indexOf("\n", from);
    if (i < 0) return "";
    from = i + 1;
  }
  let to = from;
  for (let n = a; n <= b; n++) {
    const i = text.indexOf("\n", to);
    if (i < 0) return text.slice(from);
    to = n < b ? i + 1 : i;
  }
  return text.slice(from, to);
}

/** Where `range` (lines of `before`) is in `after`, from the lines the two
 *  share at the start and at the end. `changed` when the edit between them
 *  touched the range's own lines, which is only answerable when the edit is
 *  confined to the range: one that also spans lines outside it is null, as
 *  is a range that was deleted. A whole-document replace (a reload from disk)
 *  diffs the same way, so this follows a block through an agent's write.
 *
 *  The diff runs twice, matching the shared start first and then the shared
 *  end first. They disagree only when identical lines make the edit's place
 *  ambiguous (`X A X` losing an `X A` or an `A X`), and then the range could
 *  be either copy: null. Two separate edits read as one span between them,
 *  which also only ever errs towards null (refuse), never a wrong range. */
export function remapRange(before: string, after: string, range: LineRange): (LineRange & { changed: boolean }) | null {
  if (before === after) return { ...range, changed: false };
  const a = before.split("\n"), b = after.split("\n");
  const x = mapThrough(a, b, range, true), y = mapThrough(a, b, range, false);
  return x && y && x.startLine === y.startLine && x.endLine === y.endLine && x.changed === y.changed ? x : null;
}

function mapThrough(a: readonly string[], b: readonly string[], range: LineRange, prefixFirst: boolean): (LineRange & { changed: boolean }) | null {
  const max = Math.min(a.length, b.length);
  let p = 0, s = 0;
  const prefix = (lim: number) => { while (p < lim && a[p] === b[p]) p++; };
  const suffix = (lim: number) => { while (s < lim && a[a.length - 1 - s] === b[b.length - 1 - s]) s++; };
  if (prefixFirst) { prefix(max); suffix(max - p); } else { suffix(max); prefix(max - s); }
  // the edit replaced old lines p+1..a.length-s (none for a pure insertion)
  const editFrom = p + 1, editTo = a.length - s, delta = b.length - a.length;
  if (range.endLine < editFrom) return { ...range, changed: false };
  if (range.startLine > editTo) return { startLine: range.startLine + delta, endLine: range.endLine + delta, changed: false };
  if (editFrom < range.startLine || editTo > range.endLine) return null;
  const endLine = range.endLine + delta;
  return endLine < range.startLine ? null : { startLine: range.startLine, endLine, changed: true };
}

/** The block go to line lands on, as an index into `ranges` (document order,
 *  ancestors before their descendants): the innermost one holding `line`,
 *  else the innermost at the next block's first line (`line` is a blank line
 *  between two blocks: the item, not its list). -1 past the last block. */
export function blockForLine(ranges: readonly LineRange[], line: number): number {
  let hit = -1;
  // siblings never overlap, so the LAST range holding the line is the deepest
  for (let i = 0; i < ranges.length; i++) if (ranges[i].startLine <= line && line <= ranges[i].endLine) hit = i;
  if (hit >= 0) return hit;
  // the nearest block after it, not the first in DOM order: footnote
  // definitions render at the end of the document wherever their source is
  let next = -1;
  for (const r of ranges) if (r.startLine > line && (next < 0 || r.startLine < next)) next = r.startLine;
  return next > 0 ? blockForLine(ranges, next) : -1;
}

/** The last line of `text` that go to line accepts: a final newline does not
 *  start another line. */
export function lastLine(text: string): number {
  if (!text) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Where a gutter label sits against its block, in the block's own box
 *  terms: its first line, or the whole content box when the block is a
 *  single line (a table row, a heading with a rule under it), so the number
 *  is centered on the text either way. */
export function labelBox(
  b: { top: number; height: number; padTop: number; padBottom: number; lineHeight: number },
): { top: number; height: number } {
  const content = b.height - b.padTop - b.padBottom;
  return { top: b.top + b.padTop, height: content < 2 * b.lineHeight ? Math.max(content, 0) : b.lineHeight };
}
