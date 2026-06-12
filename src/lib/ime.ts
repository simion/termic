// Korean/CJK IME bridge for WKWebView terminals.
//
// In WKWebView (WebKit), xterm.js loses CJK input. WebKit does NOT drive
// composition through compositionstart/update/end (those never fire; the
// keydown's `isComposing` stays false and `keyCode` is always 229). Instead
// it composes directly in the helper textarea via `input` events:
//
//   • inputType "insertText"            → a fresh jamo is appended (the start
//                                          of a new syllable). xterm's
//                                          _inputEvent forwards these to the
//                                          PTY on its own.
//   • inputType "insertReplacementText" → the in-progress syllable is refined
//                                          (e.g. ㅇ → 아 → 안). xterm only
//                                          forwards inputType === "insertText",
//                                          so EVERY refinement is dropped and
//                                          only the leading jamo of each
//                                          syllable reaches the PTY: 안녕 → ㅇㄴ.
//
// We fill the gap. On a replacement event we diff the textarea's current value
// against its previous value (code-point aware) and send backspaces (DEL,
// 0x7f) for the removed suffix followed by the new tail, so the PTY line
// always mirrors the textarea. Diffing the whole composing value — not just
// the last char — also handles Korean's final-consonant migration (typing a
// vowel after a closed syllable moves the trailing consonant onto the next
// syllable, e.g. 안 + ㅏ → 아나).
//
// `prevVal` is resynced on EVERY input event, including the "insertText" ones
// xterm forwards itself, so the diff baseline stays correct across syllable
// boundaries. xterm clears the textarea on Enter / Ctrl+C without firing an
// input event, so we also reset the baseline on those keys.
//
// English and control keys route through keypress / keydown (keyCode is not
// 229), never hitting the replacement branch, so they are untouched.

const DEL = 0x7f;

// inputTypes that refine/delete the composing text and that xterm's
// _inputEvent drops (it forwards ONLY "insertText"). We must forward their
// delta ourselves. Deliberately EXCLUDES:
//   • insertText                  → xterm forwards it; we'd double-send.
//   • insertFromPaste             → xterm's own paste handler covers it.
//   • insertLineBreak/Paragraph   → Enter; xterm's keydown handles it.
// During IME a Backspace decomposes the syllable and arrives as a
// deleteContent*/deleteComposition* input event (xterm's keydown only
// preventDefaults Backspace OUTSIDE composition, so these only fire for IME).
const FORWARDED_INPUT_TYPES = new Set([
  "insertReplacementText",
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
  "deleteByComposition",
  "deleteContentBackward",
  "deleteContentForward",
]);

function isReplacement(inputType: string): boolean {
  return FORWARDED_INPUT_TYPES.has(inputType);
}

/**
 * Wire the IME replacement bridge onto a terminal's helper textarea.
 *
 * @param host    The `.xterm` container element (term.open target).
 * @param getPty  Lazy getter for the current PTY id (survives Restart, which
 *                spawns a fresh pty while reusing the same DOM).
 * @param write   Sends bytes to the PTY (e.g. ipc.ptyWrite).
 * @returns       A cleanup function that removes the listeners.
 */
export function setupImeReplacementBridge(
  host: HTMLElement,
  getPty: () => string | null,
  write: (ptyId: string, data: number[]) => void,
): () => void {
  const ta = host.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
  if (!ta) return () => {};

  let prevVal = "";
  const enc = new TextEncoder();

  const onInput = (ev: Event) => {
    const e = ev as InputEvent;
    const newVal = ta.value;
    if (isReplacement(e.inputType)) {
      // Code-point aware diff so multi-byte syllables count as one unit.
      const a = Array.from(prevVal);
      const b = Array.from(newVal);
      let common = 0;
      while (common < a.length && common < b.length && a[common] === b[common]) common++;
      const back = a.length - common;
      const tail = b.slice(common).join("");
      const pid = getPty();
      if (pid && (back > 0 || tail.length > 0)) {
        const bytes: number[] = [];
        for (let i = 0; i < back; i++) bytes.push(DEL);
        if (tail.length > 0) bytes.push(...enc.encode(tail));
        write(pid, bytes);
      }
    }
    // Always resync the baseline (insertText is forwarded by xterm itself; we
    // only need its value to keep the diff anchored).
    prevVal = newVal;
  };

  const onKeydown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    const isEnter = e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
    const isCtrlC = e.ctrlKey && (e.key === "c" || e.key === "C");
    // xterm wipes the textarea on these (Terminal.ts) without an input event.
    if (isEnter || isCtrlC) prevVal = "";
  };

  ta.addEventListener("input", onInput, true);
  ta.addEventListener("keydown", onKeydown, true);
  return () => {
    ta.removeEventListener("input", onInput, true);
    ta.removeEventListener("keydown", onKeydown, true);
  };
}
