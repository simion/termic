// The key handling every Termic terminal shares, local (TerminalPane) and
// remote (RemoteTerminal: a paired computer's task). One copy, so a key that
// works in one works in the other: the remote view had none of this and
// sent Shift+Enter as a submit, swallowed app shortcuts and lost ⌘⌫.
//
// Two halves, because the local terminal puts its own keys between them
// (find, Docker's image paste). Each returns `false` (handled: xterm must
// not see it) or `undefined` (not ours: carry on).
import type { Terminal } from "@xterm/xterm";
import { IS_MAC, bindingMatches, isAppChordInTerminal, superIsHeld, terminalPassesToApp, type ShortcutId } from "@/lib/shortcuts";
import { isTerminalCloseCombo } from "@/lib/terminalFind";
import { terminalNewlineBytes } from "@/lib/terminalNewline";
import { readClipboardText, writeClipboardText } from "@/lib/clipboard";
import { usePrefs } from "@/store/prefs";

/** What a terminal gives the shared handler: its xterm, and a way to send
 *  bytes to whatever runs in it (a local PTY, or another computer's). */
export interface TerminalKeyTarget {
  term: Terminal;
  write: (bytes: number[]) => void;
  /** The built-in agent id behind the tab (its newline convention). */
  agentBaseId: () => string;
}

// Global app shortcuts that must still work while the terminal has focus.
// xterm would otherwise swallow the keys (send them to the PTY and
// preventDefault), so the window-level handler never fires. We return false
// for these → xterm ignores the event → it bubbles up to useShortcuts, which
// dispatches the command. Read from resolved prefs so user rebinds are
// honored.
const PASS_TO_APP: ShortcutId[] = [
  "file-finder", "find-in-files", "broadcast", "open-settings",
  // Unbound by default; once recorded it reaches the app from a terminal
  // too, the way double-Shift does (that one is tracked on the window, so
  // it never needed passing). On macOS with Cmd; elsewhere only when the
  // chord carries Shift or Alt, since plain Ctrl+letter is the shell's.
  "search-everywhere",
];

const stop = (e: KeyboardEvent): false => {
  e.preventDefault();
  e.stopPropagation();
  return false;
};

/** Before a terminal's own keys: the IME guard, the close chord and the
 *  app's shortcuts. */
export function terminalKeysBefore(e: KeyboardEvent): boolean | undefined {
  // IME composition guard (Korean/Japanese/Chinese). xterm's
  // CompositionHelper.keydown() decides "still composing?" purely by
  // `keyCode === 229`. Chromium sets that for every composition keystroke,
  // but WKWebView (WebKit) reports the real jamo key instead, so xterm
  // finalizes the composition on EVERY keystroke, committing the partial
  // syllable and resetting (안녕하세요 → ㅇㄴㅎ세). Returning false here
  // short-circuits xterm's keydown BEFORE its composition handler runs and,
  // crucially, without preventDefault, so the native textarea and xterm's
  // own compositionstart/update/end listeners assemble the full syllable
  // and emit it once on compositionend. `isComposing` covers continuation
  // keystrokes; `keyCode === 229` covers the one that starts composition.
  if (e.type === "keydown" && (e.isComposing || e.keyCode === 229)) return false;
  // Ctrl+Shift+W off macOS: not for the PTY, let it bubble to useShortcuts,
  // which closes the tab (see isTerminalCloseCombo).
  if (e.type === "keydown" && isTerminalCloseCombo(e, IS_MAC)) return false;
  if (e.type === "keydown") {
    const binds = usePrefs.getState().shortcuts;
    // On macOS with Cmd; elsewhere only when the chord carries Shift or Alt,
    // since plain Ctrl+letter is the shell's. See terminalPassesToApp.
    if (terminalPassesToApp(e, binds, PASS_TO_APP)) return false;
    // The same rule for EVERY shortcut, not only the four above: a chord
    // with Shift or Alt on it is the app's (isAppChordInTerminal).
    if (isAppChordInTerminal(e, binds)) return false;
  }
  return undefined;
}

/** After a terminal's own keys: copy/paste off macOS, Super chords,
 *  Shift+Enter, ⌘⌫ and ⌘←/⌘→. */
export function terminalKeysAfter(e: KeyboardEvent, t: TerminalKeyTarget): boolean | undefined {
  // Linux/Windows terminal copy/paste. macOS keeps native ⌘C / ⌘V (this
  // branch never runs there). The defaults are Ctrl+Shift+C / Ctrl+Shift+V
  // — the Shift keeps plain Ctrl+C as SIGINT for the shell. Rebindable via
  // Settings > Shortcuts.
  if (!IS_MAC && e.type === "keydown") {
    const binds = usePrefs.getState().shortcuts;
    // Copy only when there's a selection; otherwise fall through so the
    // combo isn't swallowed.
    if (bindingMatches(e, binds["terminal-copy"]) && t.term.hasSelection()) {
      writeClipboardText(t.term.getSelection()).catch(() => {});
      return stop(e);
    }
    if (bindingMatches(e, binds["terminal-paste"])) {
      readClipboardText().then(x => t.term.paste(x)).catch(() => {});
      return stop(e);
    }
  }
  // Linux: Super is held, so this key is an app shortcut (Super+J) and not
  // text. WebKitGTK reports the chord as a bare letter, which xterm would
  // send to the PTY; returning false leaves it for useShortcuts. Keypress
  // too, or the letter is typed after the shortcut fired. AFTER copy /
  // paste above: those are the terminal's own, and Super+Shift+V has to
  // paste here like Ctrl+Shift+V does.
  if (superIsHeld() && (e.type === "keydown" || e.type === "keypress")) return false;
  // Shift+Enter → newline-without-submit. xterm sends plain \r for BOTH
  // Enter and Shift+Enter, so the agent cannot tell them apart without an
  // override: `\` + `\r` (claude's `hasUsedBackslashReturn` path; gemini and
  // codex accept it too), or Ctrl+J for OpenCode (terminalNewlineBytes).
  //
  // BOTH stops are required: false skips xterm's own keydown (which would
  // also emit \r), and preventDefault stops WKWebView inserting `\n` into
  // the helper textarea, which fires xterm's input listener and submits
  // anyway. That stray LF suffixed every "right" byte sequence until found.
  const isEnter = e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
  if (e.type === "keydown" && e.shiftKey && isEnter && !e.altKey && !e.ctrlKey && !e.metaKey) {
    t.write(terminalNewlineBytes(t.agentBaseId()));
    return stop(e);
  }
  // ⌘⌫ on macOS: delete to the start of the line (Ctrl+U), as in Terminal.
  if (IS_MAC && e.type === "keydown" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key === "Backspace") {
    t.write([0x15]);
    return stop(e);
  }
  // ⌘← / ⌘→ on macOS: start / end of the line (Ctrl+A / Ctrl+E).
  if (IS_MAC && e.type === "keydown" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey
    && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    t.write([e.key === "ArrowLeft" ? 0x01 : 0x05]);
    return stop(e);
  }
  return undefined;
}
