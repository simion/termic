// Shared helper for injecting a message into a running agent's PTY, used by
// the Broadcast dialog and the per-agent message queue (ralph loop).

import { ptyWrite } from "./ipc";

/** Type a message into an agent PTY and submit it, mirroring a real
 *  keystroke burst: write the text first, then the Enter (CR) on its own
 *  ~90ms later. Agent TUIs (claude especially) treat a `\r` that arrives in
 *  the same input burst as the text as a literal newline (paste
 *  continuation), not a submit — the delay makes it register as a real
 *  Enter. Callers that rely on work-done detection should also stamp the
 *  tab's `lastInputAt` (via patchTab) so TerminalPane re-arms the detector,
 *  exactly as a keyboard Enter would. */
export function sendMessageToPty(ptyId: string, text: string): void {
  const textBytes = Array.from(new TextEncoder().encode(text));
  ptyWrite(ptyId, textBytes).catch(() => {});
  window.setTimeout(() => {
    ptyWrite(ptyId, [0x0d]).catch(() => {});
  }, 90);
}
