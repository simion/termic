// How every terminal in Termic is drawn and behaves, in one place: the agent tab
// (TerminalPane), the bottom shell (AuxTerminal) and a paired computer's
// terminal (RemoteTaskView). They used to set these each on their own, and
// the remote one drifted: no WebGL renderer and no Unicode 11 widths, so an
// agent's markdown tables drew with gaps between rows and a right border
// knocked out of line by ⌘ / ⌥. Anything about how text is drawn goes here,
// never into one call site; behaviour options (cursor, scrollback, links)
// stay with each terminal.
import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { ImageAddon } from "@xterm/addon-image";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { attachCmdClickLinkOpener, type ClickTarget } from "@/lib/termLinkOpener";
import { Osc52Base64 } from "@/lib/osc52";
import { openWebUrl } from "@/lib/previewBrowser";
import { IS_LINUX } from "@/lib/platform";
import * as ipc from "@/lib/ipc";
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

// ── Behaviour every terminal shares ─────────────────────────────────────
// Links, the OSC 52 clipboard and inline images used to be wired in each
// terminal on its own, and the remote one went without: Cmd+click on a link
// Claude printed did nothing there (Claude prints OSC 8 hyperlinks, which
// xterm parses but only activates through a linkHandler). Wire them here.

/** Open a link from a terminal in the system browser: the configured one
 *  (GH #245), or the plugin opener. Linux always takes the Rust path, which
 *  restores the host's environment for xdg-open (docs/gotchas.md). */
export function openTerminalLink(uri: string, browser: string | null | undefined, via: string): void {
  ipc.logLine(`[link] activate via=${via} uri=${uri}`).catch(() => {});
  if (browser || IS_LINUX) { void openWebUrl(uri, browser ?? ""); return; }
  openUrl(uri)
    .then(() => ipc.logLine("[link] open ok").catch(() => {}))
    .catch((e) => ipc.logLine(`[link] open FAILED: ${e}`).catch(() => {}));
}

/** `linkHandler` for `new Terminal`: OSC 8 hyperlinks (anchor text with the
 *  URL only in the escape sequence), opened on Cmd/Ctrl+click. */
export function terminalLinkHandler(open: (uri: string) => void): ITerminalOptions["linkHandler"] {
  return { activate: (ev, uri) => { if (ev.metaKey || ev.ctrlKey) open(uri); } };
}

/** Unicode 11 widths, the OSC 52 clipboard (with the codec that repairs
 *  Claude's double-encoded payloads) and inline images. Before `term.open`. */
export function loadTerminalAddons(term: Terminal): void {
  useTerminalWidths(term);
  term.loadAddon(new ClipboardAddon(new Osc52Base64(), osc52Clipboard));
  term.loadAddon(new ImageAddon());
}

/** Where an OSC 52 copy lands: the native clipboard, which takes a write
 *  with no user gesture behind it (an OSC 52 arrives on its own from the
 *  PTY; the addon's default is navigator.clipboard, whose gesture rules in
 *  WKWebView we would rather not depend on). Not shown to be a cause of the
 *  remote copy failure: the e2e window accepted the old path as well.
 *  Reads (an OSC 52 "?" query) get nothing: no program in a terminal reads
 *  the person's clipboard. */
const osc52Clipboard: IClipboardProvider = {
  readText: () => "",
  writeText: (_selection, text) => writeClipboardText(text).catch(() => navigator.clipboard.writeText(text)),
};

/** Plain URLs underlined on hover and opened on Cmd/Ctrl+click (the addon
 *  stays loaded so links already on screen work, #14), plus the
 *  capture-phase opener. `onPath` gets file paths; without it only URLs
 *  are links. Returns the opener's disposer. */
export function wireTerminalLinks(
  term: Terminal,
  host: HTMLElement,
  open: (uri: string) => void,
  onPath?: (target: Extract<ClickTarget, { kind: "path" }>, x: number, y: number) => void,
): () => void {
  term.loadAddon(new WebLinksAddon((event, uri) => { if (event.metaKey || event.ctrlKey) open(uri); }));
  return attachCmdClickLinkOpener(term, host, (target, x, y) => {
    if (target.kind === "url") open(target.uri);
    else onPath?.(target, x, y);
  }, onPath ? undefined : { urlsOnly: true });
}
