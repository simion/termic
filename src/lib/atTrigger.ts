// Word-boundary check for the opt-in `@` context-picker trigger. Pure so it's
// unit-testable without a real xterm buffer: the caller reads the cursor
// column and the character in the cell immediately before the cursor from
// `term.buffer.active` and passes them in.

/** True when the cursor sits at a word boundary: at column 0, or the cell
 *  immediately before it is empty (unwritten) or whitespace. Used to decide
 *  whether a typed `@` should open the context picker (boundary) or be passed
 *  through to the PTY as a literal `@` (mid-word, e.g. an email address). */
export function isAtWordBoundary(cursorX: number, charBeforeCursor: string): boolean {
  if (cursorX <= 0) return true;
  return charBeforeCursor === "" || /\s/.test(charBeforeCursor);
}
