// CRLF files in the editor.
//
// CodeMirror normalizes every line break to `\n`, so a file checked out with
// CRLF (the Git for Windows default, and any `.gitattributes eol=crlf` file on
// every OS) came back from a save as LF: a whole-file diff for a one-character
// edit. And the buffer never equalled the file on disk, so every disk poll saw
// a "change" that was not there.
//
// Only a file whose EVERY line break is `\r\n` keeps them: with the separator
// set, CodeMirror splits lines on it alone, so a mixed file would render its
// bare `\n` breaks as one long line. Mixed files keep today's behaviour.

/** `text` with every line break as `\n`: the form CodeMirror holds, so a
 *  file on disk and a buffer can be compared whatever the file uses. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** True when `text` has line breaks and all of them are CRLF. A lone `\r`
 *  counts against it: CodeMirror (splitting on `\r\n` only) would keep it
 *  inside a line while markdown-it breaks on it, and every preview line
 *  stamp after it would be off by one against the buffer. */
export function isPureCrlf(text: string): boolean {
  const lf = text.split("\n").length - 1;
  if (lf === 0) return false;
  const crlf = text.split("\r\n").length - 1;
  return crlf === lf && text.split("\r").length - 1 === crlf;
}
