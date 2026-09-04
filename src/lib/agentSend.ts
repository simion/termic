// Shared helper for injecting a message into a running agent's PTY, used by
// the Broadcast dialog and the per-agent message queue (ralph loop).

import { ptyWrite, onPtyData } from "./ipc";

// Gap between writing the message text and writing the submit CR. Agent TUIs
// treat a `\r` that arrives in the same input burst as the text as a literal
// newline (paste continuation), not a submit — the delay makes it register as
// a real Enter. Copilot's CLI is the slowest: it coalesces stdin that arrives
// close together into a single "[Paste #N - X lines]" chip, and a CR landing
// inside that window is swallowed (neither appended nor submitted), so the
// message just sits in the input and never sends. This is sized to clear that
// window for every agent. (90ms was not enough.)
const SUBMIT_DELAY_MS = 450;

/** Plain setTimeout, not `window.setTimeout`, for the same reason
 *  `lib/agentReady` gives: this module is unit-tested outside a DOM
 *  environment, and the handles are never kept. The delivery rules here are
 *  the ones that decide whether an agent gets a prompt or gets killed, so they
 *  have to be testable. */
const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms); });

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

/** Bracketed paste, around a body that contains newlines.
 *
 *  Without this a multi-line prompt is DESTROYED, not merely mangled. The
 *  bytes go to the PTY as typed, so every `\n` inside the text is an Enter to
 *  the agent's TUI: an eight-line prompt is eight submits, seven of them
 *  fragments, and only the last line survives as the message. Reported from a
 *  real run where an agent kept receiving nothing but the trailing line of a
 *  handoff prompt and tried to execute it as a command.
 *
 *  `ESC [ 200~` ... `ESC [ 201~` is how a terminal says "this is pasted text,
 *  the newlines are literal". Every agent TUI here enables the mode (DECSET
 *  2004) because they all support pasting a multi-line prompt.
 *
 *  Applied ONLY when the text actually spans lines. A single-line message is
 *  byte-for-byte what it was before, so the common path cannot regress, and
 *  an agent that somehow has the mode off keeps working for everything except
 *  the case that was already broken.
 *
 *  The CR that submits is deliberately still written separately, after the
 *  delay: it must land OUTSIDE the paste, or it is literal text inside it. */
function wrapIfMultiline(text: string): string {
  return /[\r\n]/.test(text) ? `\x1b[200~${text}\x1b[201~` : text;
}

/** How long to watch for the typed text to come back before deciding the
 *  agent is not reading. Measured: a real input box echoes well inside this,
 *  including an 8-line body, which comes back verbatim rather than as a paste
 *  chip. */
const ECHO_WINDOW_MS = 1500;
/** How much of the text has to come back. A prefix, not the whole thing: a
 *  narrow terminal wraps and a long body can be truncated in the box, and
 *  neither means the keystrokes were dropped. */
const ECHO_PREFIX_CHARS = 24;

/** Strip ANSI and all whitespace. The echo of a multi-line body comes back
 *  with cursor moves between words and its own idea of where spaces go, so a
 *  literal comparison fails on text that plainly did arrive. */
function normalizeEcho(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\s+/g, "");
}

/** Watch `ptyId` for `text` coming back, i.e. for the agent ECHOING what we
 *  just typed. Resolves true as soon as it does, false at the window.
 *
 *  This is the readiness check for agents that report nothing. An input box
 *  echoes what you type; a selection list does not, which is what makes it a
 *  discriminator rather than another timer. Measured against claude's trust
 *  picker ("Is this a project you created or one you trust?", highlighted
 *  default `No, exit`), which the quiet heuristic reads as a ready agent:
 *  no echo there, echo in a real input box, in every run. */
async function waitForEcho(ptyId: string, text: string): Promise<boolean> {
  const want = normalizeEcho(text).slice(0, ECHO_PREFIX_CHARS);
  // Nothing distinctive to look for (whitespace-only). Not a failure: fall
  // through to sending, which is what we did before this existed.
  if (!want) return true;
  let seen = "";
  let unlisten: (() => void) | undefined;
  try {
    const dec = new TextDecoder();
    unlisten = await onPtyData(ptyId, bytes => {
      // Keep only the tail: the answer is always in the recent output, and an
      // unbounded string here would grow with a streaming agent.
      seen = (seen + normalizeEcho(dec.decode(bytes, { stream: true }))).slice(-4096);
    });
    const deadline = Date.now() + ECHO_WINDOW_MS;
    while (Date.now() < deadline) {
      if (seen.includes(want)) return true;
      await sleep(40);
    }
    return seen.includes(want);
  } catch {
    // Could not observe the PTY at all. Absence of evidence is not evidence:
    // report "echoed" so the caller sends, matching the old behaviour rather
    // than silently swallowing every prompt on a listener failure.
    return true;
  } finally {
    unlisten?.();
  }
}

/** Same delivery as {@link sendMessageToPty}, but the returned promise
 *  rejects if the initial text write fails (e.g. the PTY has exited). The
 *  Enter (CR) is still scheduled only after the text write resolves, so a
 *  dead PTY never gets a stray submit. Callers that must not discard the
 *  user's input on a failed send (review comments) await this and react. */
export function deliverMessage(
  ptyId: string,
  text: string,
  opts: { verifyEcho?: boolean } = {},
): Promise<void> {
  const textBytes = Array.from(new TextEncoder().encode(wrapIfMultiline(text)));
  // Resolve only after BOTH the text AND the Enter (CR) have been written, so
  // an awaiting caller doesn't treat a half-delivered message (text in, never
  // submitted) as sent. Rejects if either write fails.
  return ptyWrite(ptyId, textBytes).then(async () => {
    // Stamped AFTER the write resolves, not before. `SUBMIT_DELAY_MS` is a
    // gap between the TEXT reaching the PTY and the CR, so it has to be
    // measured from the write completing; timing it from before the IPC round
    // trip silently spends part of the window on the round trip itself. On a
    // loaded machine that shortens the real gap by exactly as much as the
    // machine is slow, which is when the coalescing this guards against is
    // most likely.
    const wroteAt = Date.now();
    // Opt-in, and deliberately NOT on by default. The queue only ever sends
    // after a turn ended, which already proves the agent was at its input
    // box, so the check would cost every queued message a round trip to
    // re-establish something known. The FIRST message is the only one typed
    // into an agent that has never been ready, so it is the only one that can
    // meet a startup dialog, and it is the only caller that asks for this.
    if (opts.verifyEcho && !(await waitForEcho(ptyId, text))) {
      // The text went nowhere. Withhold the CR: on a selection list it would
      // confirm the highlighted option, and claude's is `No, exit`, so the
      // submit that was meant to deliver a prompt kills the agent instead.
      // Measured, on a single injection at termic's own ready floor.
      throw new Error("agent did not echo the message; not submitting");
    }
    // The echo wait REPLACES the guesswork in SUBMIT_DELAY_MS but not the
    // delay itself: that window exists so a CR is not coalesced into the text
    // burst as a paste continuation, which is about the agent's stdin
    // batching, not about whether it was reading. An echo seen at 40ms must
    // still not submit at 40ms. So sleep out whatever is left of it.
    const remaining = SUBMIT_DELAY_MS - (Date.now() - wroteAt);
    if (remaining > 0) await sleep(remaining);
    await ptyWrite(ptyId, [0x0d]);
  });
}
