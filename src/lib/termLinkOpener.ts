// Cmd/Ctrl+click link opening that works even when the running TUI has xterm
// mouse reporting enabled (GH #58).
//
// The WebLinksAddon detects + underlines URLs fine, but its ACTIVATION rides
// xterm's normal mouse pipeline — and when an agent TUI (Claude Code, Codex)
// turns on mouse tracking, the modified click is consumed by the
// mouse-reporting path before the addon's handler runs. Links then "randomly"
// stop opening: fine in a plain shell, dead inside an agent, back again when
// the TUI resets. This helper bypasses all of it: capture-phase listeners on
// the terminal host see the Cmd/Ctrl+click FIRST, resolve the URL straight
// from the buffer, open it, and swallow the gesture so neither xterm's mouse
// reporting nor the addon double-handles it. The addon stays loaded for
// hover-underline and as the opener when no TUI is intercepting.
//
// GH #117: the opener also resolves file-path references. Their hover-underline
// can't reuse WebLinksAddon: its link computer runs every match through
// `new URL()`, which throws for scheme-less paths and drops them.
// registerPathLinkProvider below uses xterm's link API directly.

import type { Terminal, ILink, IDisposable } from "@xterm/xterm";

// Slightly looser than the WebLinksAddon regex; trailing punctuation that
// prose tends to glue onto a URL is trimmed after matching.
const URL_RE = /https?:\/\/[^\s"'`<>{}|\\^\[\]]+/g;
// File-path-like token: dir-qualified, or a bare filename with a letter-led
// extension (so version strings like "1.2.3" don't match), plus optional
// trailing :line[:col]. `@` is a valid path char so retina assets
// (`logo@2x.png`) and scoped packages (`@types/node`) resolve; the cost is a
// bare `user@host` email underlining and resolving to nothing (harmless).
// Each segment run is bounded ({1,255}, the max filename length) so a long
// slash-less/dot-less blob (base64, a hash) can't drive the regex into O(n^2)
// backtracking and stall the hover-underline pass.
export const PATH_TOKEN_RE = /(?:(?:[\w.@-]{1,255}\/)+[\w.@-]{1,255}|[\w.@-]{1,255}\.[A-Za-z]\w{0,9})(?::\d+(?::\d+)?)?/;

// Single scan that recognises three things so a fragment of one can't leak as
// another (e.g. the `host/path.ts` inside a URL, or the two halves of an scp
// remote, being mistaken for paths). Only the `path` group is ours:
//   url  - a schemed URL. WebLinksAddon draws its own hover-underline, so we
//          consume-and-skip it here to avoid a double underline. Scheme bounded
//          ({0,15}) so it can't backtrack on a long slash-less run.
//   junk - an scp-style `host:path` git remote: a colon glued straight onto a
//          path char (not `:line:col`, not a `(path): prose` colon). Consumed
//          so neither the host nor the path half underlines.
//   path - PATH_TOKEN_RE.
const PATH_SCAN_RE_G = new RegExp(
  "(?<url>[a-zA-Z][\\w+.-]{0,15}:\\/\\/\\S+)" +
  "|(?<junk>[\\w.@-]{1,255}:(?=[A-Za-z_~./])[\\w.@:/-]*)" +
  "|(?<path>" + PATH_TOKEN_RE.source + ")",
  "g",
);

/** File-path tokens in `text`, skipping URLs and scp `host:path` compounds.
 *  Each result carries the token's start index so callers can hit-test a click
 *  or build a hover range; `raw` has trailing prose punctuation trimmed. */
export function scanPathTokens(text: string): { raw: string; index: number }[] {
  PATH_SCAN_RE_G.lastIndex = 0;
  const out: { raw: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = PATH_SCAN_RE_G.exec(text))) {
    if (m.groups?.path === undefined) continue; // url / junk: not ours
    const raw = m[0].replace(TRAILING_PUNCT_RE, "");
    if (raw) out.push({ raw, index: m.index });
  }
  return out;
}
const TRAILING_LINE_COL_RE = /:(\d+)(?::(\d+))?$/;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>'"]+$/;

export type ClickTarget =
  | { kind: "url"; uri: string }
  | { kind: "path"; path: string; line?: number; col?: number };

/** Split "src/file.ts:123:5" into { path, line, col }. */
export function parsePathToken(full: string): { path: string; line?: number; col?: number } {
  const lc = TRAILING_LINE_COL_RE.exec(full);
  if (!lc) return { path: full };
  return {
    path: full.slice(0, lc.index),
    line: parseInt(lc[1], 10),
    col: lc[2] !== undefined ? parseInt(lc[2], 10) : undefined,
  };
}

/** OSC 8 hyperlink at a buffer cell, or null. Anchor-text links ("Learn
 *  more") carry their URL only in the escape sequence, never in the visible
 *  buffer text, so the regex scrape below can't see them. xterm's public API
 *  doesn't expose the cell's link either, so this reads the internal
 *  extended-attributes + OscLinkService pair; every access is optional so an
 *  xterm upgrade degrades to "no OSC 8 support" instead of throwing. */
function osc8LinkAt(term: Terminal, absRow: number, col: number): string | null {
  try {
    const cell = term.buffer.active.getLine(absRow)?.getCell(col) as
      { extended?: { urlId?: number } } | undefined;
    const urlId = cell?.extended?.urlId;
    if (!urlId) return null;
    const core = (term as unknown as { _core?: { _oscLinkService?: { getLinkData?: (id: number) => { uri?: string } | undefined } } })._core;
    return core?._oscLinkService?.getLinkData?.(urlId)?.uri ?? null;
  } catch {
    return null;
  }
}

interface ClickContext { absRow: number; col: number; text: string; clickIdx: number; }

/** The clicked cell plus the LOGICAL line under it (soft-wrapped rows joined),
 *  with the clicked cell's index into that line. translateToString(false)
 *  keeps trailing spaces so column math stays aligned across rows. (Wide CJK
 *  glyphs before the token can shift the index; accepted.) Null if the click
 *  isn't over a cell. Shared by urlAt/pathAt so the join runs once. */
function clickContext(term: Terminal, host: HTMLElement, ev: MouseEvent): ClickContext | null {
  const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const col = Math.floor((ev.clientX - rect.left) / (rect.width / term.cols));
  const row = Math.floor((ev.clientY - rect.top) / (rect.height / term.rows));
  if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) return null;

  const buf = term.buffer.active;
  const clickedLine = buf.viewportY + row;
  let start = clickedLine;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  let text = "";
  let clickIdx = -1;
  for (let ln = start; ln - start < 100; ln++) {
    const line = buf.getLine(ln);
    if (!line || (ln !== start && !line.isWrapped)) break;
    if (ln === clickedLine) clickIdx = text.length + col;
    text += line.translateToString(false);
  }
  if (clickIdx < 0) return null;
  return { absRow: clickedLine, col, text, clickIdx };
}

/** URL at the click: an OSC 8 hyperlink on the cell (explicit, so it beats any
 *  text scrape), else a scraped http(s) URL. Null if neither. */
function urlAt(term: Terminal, ctx: ClickContext): ClickTarget | null {
  const osc8 = osc8LinkAt(term, ctx.absRow, ctx.col);
  if (osc8) return { kind: "url", uri: osc8 };
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(ctx.text))) {
    if (ctx.clickIdx >= m.index && ctx.clickIdx < m.index + m[0].length) {
      return { kind: "url", uri: m[0].replace(TRAILING_PUNCT_RE, "") };
    }
  }
  return null;
}

/** File-path reference at the click, or null. */
function pathAt(ctx: ClickContext): ClickTarget | null {
  for (const { raw, index } of scanPathTokens(ctx.text)) {
    if (ctx.clickIdx >= index && ctx.clickIdx < index + raw.length) {
      const { path, line, col } = parsePathToken(raw);
      return { kind: "path", path, line, col };
    }
  }
  return null;
}

/** Install the capture-phase opener on a terminal host. Returns a disposer. */
export function attachCmdClickLinkOpener(
  term: Terminal,
  host: HTMLElement,
  onActivate: (target: ClickTarget, clientX: number, clientY: number) => void,
  opts?: { urlsOnly?: boolean },
): () => void {
  // Armed between mousedown and the trailing click event so the whole
  // gesture is swallowed as one unit (mouse reporting never sees any of it,
  // and the WebLinksAddon can't double-open).
  let armed: { target: ClickTarget; x: number; y: number } | null = null;

  function onDown(ev: MouseEvent) {
    armed = null;
    if (ev.button !== 0 || !(ev.metaKey || ev.ctrlKey)) return;
    const ctx = clickContext(term, host, ev);
    if (!ctx) return;
    // URLs win over paths; the scratch shell (urlsOnly) never resolves paths.
    const target = urlAt(term, ctx) ?? (opts?.urlsOnly ? null : pathAt(ctx));
    if (!target) return;
    armed = { target, x: ev.clientX, y: ev.clientY };
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onUp(ev: MouseEvent) {
    if (!armed) return;
    ev.preventDefault();
    ev.stopPropagation();
    onActivate(armed.target, armed.x, armed.y);
    // Clear AFTER the browser dispatches the trailing click (same turn),
    // so onClick below still sees the armed state and swallows it.
    setTimeout(() => { armed = null; }, 0);
  }
  function onClick(ev: MouseEvent) {
    if (!armed) return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  host.addEventListener("mousedown", onDown, true);
  host.addEventListener("mouseup", onUp, true);
  host.addEventListener("click", onClick, true);
  return () => {
    host.removeEventListener("mousedown", onDown, true);
    host.removeEventListener("mouseup", onUp, true);
    host.removeEventListener("click", onClick, true);
  };
}

/** Hover-underline for file-path references. Activation is a fallback; real
 *  clicks go through the capture-phase opener above. */
export function registerPathLinkProvider(
  term: Terminal,
  onActivate: (path: string, line: number | undefined, col: number | undefined, event: MouseEvent) => void,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const buf = term.buffer.active;
      const y0 = bufferLineNumber - 1;
      let start = y0;
      while (start > 0 && buf.getLine(start)?.isWrapped) start--;
      // Reconstruct the wrapped logical line (as in clickContext), tracking
      // each row's start offset. Single-width assumption: wide CJK can shift it.
      let text = "";
      const rowStart: number[] = [];
      for (let ln = start; ln - start < 100; ln++) {
        const line = buf.getLine(ln);
        if (!line || (ln !== start && !line.isWrapped)) break;
        rowStart.push(text.length);
        text += line.translateToString(false);
      }
      if (rowStart.length === 0) { callback(undefined); return; }

      const toPos = (offset: number) => {
        let i = 0;
        while (i + 1 < rowStart.length && rowStart[i + 1] <= offset) i++;
        return { row: start + i, col: offset - rowStart[i] };
      };

      const links: ILink[] = [];
      for (const { raw, index } of scanPathTokens(text)) {
        const s = toPos(index);
        // End on the last char (+1 -> 1-based inclusive), not one-past: a token
        // ending on a soft wrap would otherwise land at col 0 of the next row.
        const e = toPos(index + raw.length - 1);
        const { path, line, col } = parsePathToken(raw);
        links.push({
          range: { start: { x: s.col + 1, y: s.row + 1 }, end: { x: e.col + 1, y: e.row + 1 } },
          text: raw,
          activate: (event) => onActivate(path, line, col, event),
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}
