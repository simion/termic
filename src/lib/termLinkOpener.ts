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

import type { Terminal } from "@xterm/xterm";

// Slightly looser than the WebLinksAddon regex; trailing punctuation that
// prose tends to glue onto a URL is trimmed after matching.
const URL_RE = /https?:\/\/[^\s"'`<>{}|\\^\[\]]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>'"]+$/;

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

/** URL in the terminal buffer at the mouse position, or null. */
function linkAt(term: Terminal, host: HTMLElement, ev: MouseEvent): string | null {
  const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const col = Math.floor((ev.clientX - rect.left) / (rect.width / term.cols));
  const row = Math.floor((ev.clientY - rect.top) / (rect.height / term.rows));
  if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) return null;

  // OSC 8 first: if the clicked cell carries an explicit hyperlink, that
  // beats any text-scrape guess.
  const osc8 = osc8LinkAt(term, term.buffer.active.viewportY + row, col);
  if (osc8) return osc8;

  // Reconstruct the LOGICAL line under the click (soft-wrapped rows joined),
  // tracking the clicked cell's character index. translateToString(false)
  // keeps trailing spaces so column math stays aligned across rows. (Wide
  // CJK glyphs before the URL can shift the index; accepted — URLs and the
  // text around them are overwhelmingly single-width.)
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

  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) {
    if (clickIdx >= m.index && clickIdx < m.index + m[0].length) {
      return m[0].replace(TRAILING_PUNCT_RE, "");
    }
  }
  return null;
}

/** Install the capture-phase opener on a terminal host. Returns a disposer. */
export function attachCmdClickLinkOpener(
  term: Terminal,
  host: HTMLElement,
  open: (uri: string) => void,
): () => void {
  // Armed between mousedown and the trailing click event so the whole
  // gesture is swallowed as one unit (mouse reporting never sees any of it,
  // and the WebLinksAddon can't double-open).
  let armedUri: string | null = null;

  function onDown(ev: MouseEvent) {
    armedUri = null;
    if (ev.button !== 0 || !(ev.metaKey || ev.ctrlKey)) return;
    const uri = linkAt(term, host, ev);
    if (!uri) return;
    armedUri = uri;
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onUp(ev: MouseEvent) {
    if (!armedUri) return;
    ev.preventDefault();
    ev.stopPropagation();
    open(armedUri);
    // Clear AFTER the browser dispatches the trailing click (same turn),
    // so onClick below still sees the armed state and swallows it.
    setTimeout(() => { armedUri = null; }, 0);
  }
  function onClick(ev: MouseEvent) {
    if (!armedUri) return;
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
