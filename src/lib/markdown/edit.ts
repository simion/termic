// A write the preview asks for, against a line range of the source. Lines
// are 1-based and inclusive, the same numbering as the DocModel and the
// data-src-line stamps. Pure: who applies it (the editor buffer) is the
// caller's business, see PreviewEditTarget.
//
import { remapRange } from "./lines";

// `text` is the document exactly as the editor holds it, with whatever line
// separator it uses. Lines are compared without their \r, so `expect` and
// `insert` are always \n-joined; `insert` is written back with the
// document's own separator (CRLF if its first line break is one).

export interface DocEdit {
  fromLine: number;
  toLine: number;
  /** the current text of lines fromLine..toLine, \n-joined. A mismatch means
   *  the document moved under the preview: refuse rather than guess. */
  expect: string;
  /** replaces those lines. "" leaves one empty line, it does not delete. */
  insert: string;
}

export type ApplyResult = { ok: true; text: string } | { ok: false; reason: "conflict" | "range" };

export function applyDocEdit(text: string, edit: DocEdit): ApplyResult {
  const { fromLine, toLine } = edit;
  // offsets of each line start, found by scanning: no split of the whole doc
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  if (!Number.isInteger(fromLine) || !Number.isInteger(toLine) || fromLine < 1 || toLine < fromLine || toLine > starts.length) {
    return { ok: false, reason: "range" };
  }
  const from = starts[fromLine - 1];
  // end of toLine's content, before its separator
  let to = toLine < starts.length ? starts[toLine] - 1 : text.length;
  if (to > from && text[to - 1] === "\r") to--;
  const current = text.slice(from, to).replace(/\r\n/g, "\n");
  if (current !== edit.expect) return { ok: false, reason: "conflict" };
  const eol = /\r\n/.test(text.slice(0, starts[1] ?? 0)) ? "\r\n" : "\n";
  const insert = eol === "\n" ? edit.insert : edit.insert.replace(/\n/g, eol);
  return { ok: true, text: text.slice(0, from) + insert + text.slice(to) };
}

const isWs = (c: string | undefined) => c === " " || c === "\t";

/** Where a task item's `[` sits on `line`: after any mix of blockquote `>`s
 *  and list markers (`- > - [ ]`, `1. - [ ]`), the last of them a list
 *  marker. -1 when the line is not a task item. A loop, not one regex: the
 *  repeated prefix with whitespace on both sides backtracks on a long line
 *  of markers that never reaches a `[`. */
function taskBracket(line: string): number {
  let i = 0, list = false;
  for (;;) {
    while (isWs(line[i])) i++;
    if (line[i] === ">") { i++; list = false; continue; }
    let j = i;
    if ("-*+".includes(line[j] ?? "x")) j++;
    else {
      while (j - i < 9 && line[j] >= "0" && line[j] <= "9") j++;
      j = j > i && (line[j] === "." || line[j] === ")") ? j + 1 : i;
    }
    if (j === i || !isWs(line[j])) break;
    i = j;
    list = true;
    while (isWs(line[i])) i++;
    if (line[i] === "[") break;
  }
  return list && /^\[[ xX]\](?=[ \t]|$)/.test(line.slice(i, i + 4)) ? i : -1;
}

/** The edit that ticks (or unticks) the task item on 1-based `line` of
 *  `text`, the source the preview rendered. Null when that line is not a task
 *  item, so a stale click never rewrites some other line. */
export function toggleTask(text: string, line: number): DocEdit | null {
  let from = 0;
  for (let n = 1; n < line && from !== -1; n++) {
    const nl = text.indexOf("\n", from);
    from = nl === -1 ? -1 : nl + 1;
  }
  if (from === -1 || line < 1) return null;
  const nl = text.indexOf("\n", from);
  const expect = text.slice(from, nl === -1 ? undefined : nl).replace(/\r$/, "");
  const b = taskBracket(expect);
  if (b < 0) return null;
  const insert = expect.slice(0, b + 1) + (expect[b + 1] === " " ? "x" : " ") + expect.slice(b + 2);
  return { fromLine: line, toLine: line, expect, insert };
}

/** toggleTask for a box on `rendered` (the debounced copy the preview drew),
 *  moved onto `live` (the buffer, maybe ahead of it). The edit keeps the
 *  rendered line as its `expect`, so it lands only where that exact line now
 *  is. Null when it cannot be followed or its own line changed. */
export function taskChange(rendered: string, live: string, line: number): DocEdit | null {
  const e = toggleTask(rendered, line);
  if (!e || rendered === live) return e;
  const m = remapRange(rendered, live, { startLine: line, endLine: line });
  return m && !m.changed ? { ...e, fromLine: m.startLine, toLine: m.startLine } : null;
}

export type EditOutcome = "applied" | "conflict" | "range";

/** Where the preview sends its edits: the markdown tab's editor buffer
 *  (components/task/markdown/editTarget). Read-only previews (diff view,
 *  external files, Changelog) get none, or one with `canEdit` false. */
export interface PreviewEditTarget {
  canEdit: boolean;
  /** verify `expect` against the LIVE buffer and replace the lines in one
   *  undoable transaction. `label` says what the edit was ("Checked off line
   *  12"), for the toast the save policy shows. */
  apply(edit: DocEdit, label?: string): EditOutcome;
  /** the live buffer's lines fromLine..toLine, \n-joined; null out of range */
  read(fromLine: number, toLine: number): string | null;
  /** the whole live buffer, \n-joined: what a held line range is remapped
   *  onto before it is written (the preview renders a debounced copy) */
  text(): string;
  /** ⌘Z / ⇧⌘Z / ⌘S pressed while the preview has focus */
  undo(): void;
  redo(): void;
  save(): void;
}
