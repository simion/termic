// iTerm-style "copy on select" for every xterm instance (agent terminals,
// right split, scratch shells). When the user finishes a MOUSE selection
// (drag, double-click word, triple-click line) the selected text is written
// to the clipboard. Mouse-only on purpose: it mirrors iTerm and avoids
// auto-copying programmatic selections (e.g. SearchAddon highlighting the
// active match). Gated on the live `terminalCopyOnSelect` pref so toggling
// the setting applies to already-open terminals without a respawn.

import type { Terminal } from "@xterm/xterm";
import { usePrefs } from "@/store/prefs";

/** Attach copy-on-select to a terminal. Returns a disposer for cleanup. */
export function attachCopyOnSelect(term: Terminal, host: HTMLElement): () => void {
  const onMouseUp = () => {
    if (!usePrefs.getState().terminalCopyOnSelect) return;
    // Defer a tick so xterm has finalized the selection range for this drag.
    window.setTimeout(() => {
      let sel = "";
      try {
        if (!term.hasSelection()) return; // plain click clears selection: leave clipboard alone
        sel = term.getSelection();
      } catch { return; }
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    }, 0);
  };
  host.addEventListener("mouseup", onMouseUp);
  return () => host.removeEventListener("mouseup", onMouseUp);
}
