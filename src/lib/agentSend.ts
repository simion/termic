// Shared helper for injecting a message into a running agent's PTY, used by
// the Broadcast dialog and the per-agent message queue (ralph loop).

import { ptyWrite } from "./ipc";

// Gap between writing the message text and writing the submit CR. Agent TUIs
// treat a `\r` that arrives in the same input burst as the text as a literal
// newline (paste continuation), not a submit — the delay makes it register as
// a real Enter. Copilot's CLI is the slowest: it coalesces stdin that arrives
// close together into a single "[Paste #N - X lines]" chip, and a CR landing
// inside that window is swallowed (neither appended nor submitted), so the
// message just sits in the input and never sends. This is sized to clear that
// window for every agent. (90ms was not enough.)
const SUBMIT_DELAY_MS = 450;

/** Type a message into an agent PTY and submit it, mirroring a real
 *  keystroke burst: write the text first, then the Enter (CR) on its own a
 *  beat later. Callers that rely on work-done detection should also stamp the
 *  tab's `lastInputAt` (via patchTab) so TerminalPane re-arms the detector,
 *  exactly as a keyboard Enter would. */
export function sendMessageToPty(ptyId: string, text: string): void {
  // Fire-and-forget wrapper for callers that don't care whether the write
  // landed (broadcast, queue drain). Swallows errors.
  void deliverMessage(ptyId, text).catch(() => {});
}

/** Same delivery as {@link sendMessageToPty}, but the returned promise
 *  rejects if the initial text write fails (e.g. the PTY has exited). The
 *  Enter (CR) is still scheduled only after the text write resolves, so a
 *  dead PTY never gets a stray submit. Callers that must not discard the
 *  user's input on a failed send (review comments) await this and react. */
export function deliverMessage(ptyId: string, text: string): Promise<void> {
  const textBytes = Array.from(new TextEncoder().encode(text));
  // Resolve only after BOTH the text AND the Enter (CR) have been written, so
  // an awaiting caller doesn't treat a half-delivered message (text in, never
  // submitted) as sent. Rejects if either write fails.
  return ptyWrite(ptyId, textBytes).then(
    () => new Promise<void>((resolve, reject) => {
      window.setTimeout(() => { ptyWrite(ptyId, [0x0d]).then(() => resolve(), reject); }, SUBMIT_DELAY_MS);
    }),
  );
}
