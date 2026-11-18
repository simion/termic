// Match highlighting for find-in-terminal (TerminalFindBar).
//
// xterm's search addon paints every match as a cell-background decoration,
// but only when it is handed colours, and only as `#RRGGBB`: no alpha, no CSS
// variables. So the theme's accent is resolved and blended into the terminal's
// own background here, which gives the translucent look the editor's and the
// markdown preview's find have (accent-soft for every match, the accent for the
// current one) without a hex literal outside the theme.

import type { ISearchDecorationOptions } from "@xterm/addon-search";

type Rgb = [number, number, number];

/** The key that opens find in a terminal. EXACTLY ⌘F on macOS (no Shift, so
 *  ⇧⌘F stays the app's find-in-files); Ctrl+Alt+F elsewhere. Not plain
 *  Ctrl+F, which is readline's forward-char, and not Ctrl+Shift+F, which is
 *  find-in-files as in VS Code: it used to be this terminal's find, and since
 *  focus is nearly always in a terminal, find-in-files was unreachable from
 *  its own key. An AltGr layout that types a character on F reports that
 *  character as `key`, so it never matches and stays typeable. */
export function isTerminalFindCombo(e: KeyboardEvent, isMac: boolean): boolean {
  const f = e.key.toLowerCase() === "f";
  return isMac
    ? f && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey
    : f && e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey;
}

/** Close-tab from INSIDE a terminal, off macOS: Ctrl+Shift+W.
 *
 *  The app's Cmd is Ctrl there, so close-tab is Ctrl+W, and outside a
 *  terminal that already works. Inside one, plain Ctrl+W is the shell's
 *  delete-previous-word and is left to it (the rule above, and the one
 *  Windows Terminal and GNOME Terminal follow), which made close-tab
 *  unreachable from the place focus nearly always is. So the shifted chord
 *  is taken from the terminal and closes the tab. Never on macOS: ⌘W is not
 *  a key the shell uses, and it already reaches the app. */
export function isTerminalCloseCombo(e: KeyboardEvent, isMac: boolean): boolean {
  return !isMac && e.key.toLowerCase() === "w"
    && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha dropped) to channels. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map(c => c + c).join("");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

/** `rgb(...)` / `rgba(...)` (alpha dropped) to channels. */
function parseRgbFn(s: string): Rgb | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

/** `amount` of `fg` over `bg`, as an opaque colour. */
export function mix(fg: Rgb, bg: Rgb, amount: number): Rgb {
  return [0, 1, 2].map(i => fg[i] * amount + bg[i] * (1 - amount)) as Rgb;
}

/** Resolve any CSS colour the browser understands to channels. Canvas
 *  normalises `fillStyle` to `#rrggbb` or `rgba(...)`, whatever the theme
 *  wrote (oklch, a named colour, color-mix). */
function resolveCss(color: string): Rgb | null {
  if (!color) return null;
  const direct = parseHex(color) ?? parseRgbFn(color);
  if (direct) return direct;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  const out = String(ctx.fillStyle);
  return parseHex(out) ?? parseRgbFn(out);
}

/** Blend weights. Every match gets a soft wash; the current one a much
 *  stronger one plus an accent border, so it reads as "this one" at a glance
 *  among dozens. */
export const MATCH_MIX = 0.55;
export const ACTIVE_MIX = 0.8;

/** Decoration colours for a terminal whose background is `termBg`, from two
 *  already-resolved colours. Pure, so the blend is unit-testable. */
export function decorationsFor(accent: Rgb, termBg: Rgb): ISearchDecorationOptions {
  const match = toHex(mix(accent, termBg, MATCH_MIX));
  const active = toHex(mix(accent, termBg, ACTIVE_MIX));
  const border = toHex(accent);
  return {
    matchBackground: match,
    matchOverviewRuler: match,
    activeMatchBackground: active,
    activeMatchBorder: border,
    activeMatchColorOverviewRuler: border,
  };
}

/** Decoration colours for the live theme. Read per search, so a theme switch
 *  while the bar is open takes effect on the next keystroke. */
export function terminalFindDecorations(termBackground: string | undefined): ISearchDecorationOptions | undefined {
  const root = getComputedStyle(document.documentElement);
  const accent = resolveCss(root.getPropertyValue("--color-accent"));
  const bg = resolveCss(termBackground ?? "") ?? resolveCss(root.getPropertyValue("--color-bg"));
  return accent && bg ? decorationsFor(accent, bg) : undefined;
}

/** The count label: "3 of 12", "No results", or past the addon's highlight
 *  cap (it reports index -1) "1000+ matches". */
export function findCountLabel(resultIndex: number, resultCount: number, limit: number): string {
  if (resultCount === 0) return "No results";
  if (resultIndex < 0) return resultCount >= limit ? `${limit}+ matches` : `${resultCount} matches`;
  return `${resultIndex + 1} of ${resultCount}`;
}
