// Following the user's unsubmitted draft from their own keystrokes.
//
// While the user has text in an agent's prompt, nothing automatic may type
// there: it would land inside their text and the Enter that follows would send
// both as one message. So a queued message, and a prompt another agent sends
// over the CLI or MCP, waits while `composing` is true (TerminalPane,
// agentSendDisposition).
//
// That makes a WRONG "composing" a deadlock, and a silent one: every message
// for the tab queues, the turn-end drain refuses to send, the stall watchdog
// stands down, and nothing clears it until someone presses Enter in that
// terminal. An agent only other agents talk to never gets that Enter. The
// tracker was a character count, and three ordinary things left it above zero
// with an empty prompt:
//
//   - answering a blocking prompt. claude's permission dialog takes a bare
//     digit, no Enter: one counted character, never submitted, never cleared;
//   - deleting a word (Ctrl-W, Option-Backspace), which removed the text and
//     none of the count;
//   - recalling history with Up and stepping back out with Down.
//
// So this tracks the text itself, as far as keystrokes can say, and takes the
// one fact a keystroke cannot: whether the agent is blocked on a prompt of its
// own, in which case the key is an answer and not a draft.
//
// Still an estimate. The cursor is assumed to be at the end, and an edit this
// cannot see (a click, a kill-line, an agent that clears its own input) is not
// modelled. It errs towards "there is a draft", because typing into a real one
// is the worse mistake; the cases above are the ones where it erred that way
// with nothing there at all.

export interface DraftState {
  /** What the user has typed and not submitted, cursor assumed at the end. */
  text: string;
  /** How many Up presses deep into history the prompt is, when it holds a
   *  recalled entry and nothing typed. 0 otherwise. */
  recalled: number;
}

export const EMPTY_DRAFT: DraftState = { text: "", recalled: 0 };

/** Is there, as far as we can tell, something in the prompt? */
export function isComposing(d: DraftState): boolean {
  return d.text.length > 0 || d.recalled > 0;
}

const BRACKETED_PASTE = "\x1b[200~";

/** Drop the last word and the whitespace after it, readline's unix-word-rubout. */
function dropLastWord(s: string): string {
  return s.replace(/\s+$/, "").replace(/\S+$/, "");
}

/**
 * The draft after one `onData` payload.
 *
 * `answering`: the agent is blocked on a prompt of its own (a permission
 * dialog, a question), so this key goes to that prompt, not to the input box.
 * The draft is left exactly as it was: the box is not on screen to be edited,
 * and whatever was in it before the dialog is still there after.
 */
export function nextDraft(d: DraftState, data: string, answering: boolean): DraftState {
  if (answering) return d;

  // Submitted (Enter), or cleared (Ctrl-C, Ctrl-U).
  if (/[\r\n]/.test(data) || data === "\x03" || data === "\x15") return EMPTY_DRAFT;

  // A bracketed paste into the prompt. The content is not kept, only that
  // something is there now.
  if (data.startsWith(BRACKETED_PASTE)) {
    const pasted = Math.max(1, data.length - 12);
    return { text: d.text + "x".repeat(pasted), recalled: 0 };
  }

  // Word delete: Ctrl-W, or Option-Backspace (ESC then DEL / BS in one call).
  if (data === "\x17" || data === "\x1b\x7f" || data === "\x1b\b") {
    // On a recalled entry we never saw the text, so a word delete proves
    // nothing about what is left: it stays a draft.
    return d.recalled > 0 ? d : { text: dropLastWord(d.text), recalled: 0 };
  }

  // Up arrow. With nothing typed it recalls history, which puts an old prompt
  // in the input without a single typed character.
  if (data === "\x1b[A" || data === "\x1bOA") {
    return d.text.length > 0 ? d : { text: "", recalled: d.recalled + 1 };
  }
  // Down arrow steps back out of history; past the newest entry the prompt is
  // empty again.
  if (data === "\x1b[B" || data === "\x1bOB") {
    return d.recalled > 0 ? { text: "", recalled: d.recalled - 1 } : d;
  }

  // Arrows, a bare Escape, and xterm's own replies (cursor reports).
  if (data.startsWith("\x1b")) return d;

  let text = d.text;
  let typed = false;
  for (const ch of data) {
    if (ch === "\x7f" || ch === "\b") {
      text = text.slice(0, -1);
    } else if (ch >= " ") {
      text += ch;
      typed = true;
    }
  }
  // Typing onto a recalled entry makes it an edited draft: the recall depth no
  // longer says anything, and a placeholder stands in for the recalled text so
  // backspacing over what was typed does not read as an empty prompt.
  if (d.recalled > 0 && typed) return { text: "…" + text, recalled: 0 };
  // Backspace on a recalled entry: unseen text, so it stays a draft.
  if (d.recalled > 0) return d;
  return { text, recalled: 0 };
}

// ── Waiting for the keyboard to go quiet ──
//
// An empty draft is not enough on its own. Holding Backspace to clear a
// draft empties it while the key is still auto-repeating, so a held message
// was typed in at once and the remaining repeats deleted it. An automatic
// send therefore also waits until the user's keys have been quiet for a
// moment, measured from their last keystroke in that terminal.

/** How long after the user's last keystroke an automatic send waits. */
export const TYPING_QUIET_MS = 1500;

// ── A draft nobody touches expires ──
//
// The tracker is a guess from keystrokes, and a wrong guess held every message
// for that agent until someone pressed Enter in its terminal: a delegated
// worker sat done for minutes with a report waiting (`queue-held ... why=draft
// in the prompt`) and nothing on screen said why. So a draft with no keystroke
// for this long is assumed gone and automatic sends resume. The cost, accepted
// on purpose: a real draft left alone this long gets the message typed after it.
let draftStaleMs = 2 * 60_000;
export const draftStaleAfterMs = (): number => draftStaleMs;
/** e2e only: a spec cannot wait two minutes. */
export function setDraftStaleMs(ms: number): void { draftStaleMs = ms; }

/** A payload that is the user pressing a key, as opposed to one of xterm's
 *  automatic replies (a cursor-position report starts with ESC too). A bare
 *  ESC and the arrow keys are keys; any other ESC sequence is not. */
export function isUserKey(data: string): boolean {
  return !data.startsWith("\x1b") || data === "\x1b" || /^\x1b(\[|O)[ABCD]$/.test(data);
}

/** Ms an automatic send must still wait for the keyboard to go quiet; 0 when
 *  it may go now (or the user has not typed here at all). */
export function typingHoldMs(lastKeyAt: number, now: number, quietMs = TYPING_QUIET_MS): number {
  if (!lastKeyAt) return 0;
  return Math.max(0, quietMs - (now - lastKeyAt));
}
