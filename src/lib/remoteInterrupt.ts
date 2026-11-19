// A Stop sent from a phone or another computer (docs/remote.md) reaches the
// agent's PTY without passing through this window's keyboard, so TerminalPane
// never sees the Escape that licenses ending an interrupted turn, and the tab
// read "working" until the next prompt. The host announces each one here,
// keyed by PTY. It counts as a watched Escape: the watching gate guards
// against a stale, unrelated keypress, and a remote Stop is a deliberate
// interrupt of that agent, right now.
import { listen } from "@tauri-apps/api/event";

export const REMOTE_INTERRUPT_EVENT = "remote://interrupt";

const at = new Map<string, number>();

export function noteRemoteInterrupt(pty: string, now = Date.now()) {
  at.set(pty, now);
}

/** When this PTY was last interrupted remotely, or 0. */
export function remoteInterruptAt(pty: string | null | undefined): number {
  return pty ? at.get(pty) ?? 0 : 0;
}

/** Spend the licence, like clearing `escAtRef`. */
export function clearRemoteInterrupt(pty: string | null | undefined) {
  if (pty) at.delete(pty);
}

/** Started once by App. */
export function listenRemoteInterrupts() {
  return listen<{ pty: string }>(REMOTE_INTERRUPT_EVENT, (e) => noteRemoteInterrupt(e.payload.pty));
}
