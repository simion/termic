// How every terminal in Termic is drawn, in one place: the agent tab
// (TerminalPane), the bottom shell (AuxTerminal) and a paired computer's
// terminal (RemoteTaskView). They used to set these each on their own, and
// the remote one drifted: no WebGL renderer and no Unicode 11 widths, so an
// agent's markdown tables drew with gaps between rows and a right border
// knocked out of line by ⌘ / ⌥. Anything about how text is drawn goes here,
// never into one call site; behaviour options (cursor, scrollback, links)
// stay with each terminal.
import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { usePrefs, currentTerminalStack, currentTerminalTheme, currentMinimumContrastRatio } from "@/store/prefs";

/** Options for `new Terminal({ ...terminalLook(), ... })`. */
export function terminalLook(): ITerminalOptions {
  const p = usePrefs.getState();
  return {
    fontFamily: currentTerminalStack(),
    fontSize: p.terminalFontSize,
    // Regular 400 / bold 700, the two static JetBrains Mono masters bundled
    // with the app. Any other weight makes xterm's WebGL atlas interpolate,
    // which WKWebView rasterizes soft.
    fontWeight: 400,
    fontWeightBold: 700,
    letterSpacing: p.terminalLetterSpacing,
    // 1.0 is what TUIs assume; more inflates every cell and turns a row the
    // TUI paints with a background into a ribbon.
    lineHeight: 1.0,
    theme: currentTerminalTheme() as ITerminalOptions["theme"],
    // Truecolor text stays readable on a light background (#83).
    minimumContrastRatio: currentMinimumContrastRatio(),
    allowProposedApi: true,
  };
}

/** Unicode 11 widths, as the agents measure text. Before `term.open`; the
 *  renderer (`loadTerminalRenderer`) goes on after it. */
export function useTerminalWidths(term: Terminal): void {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
}
