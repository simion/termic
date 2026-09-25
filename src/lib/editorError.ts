// What EditorPane does with a failed `taskFileRead`. Three outcomes, and the
// split matters visually: a binary file, or one too big to load, is not a
// failure but the WRONG VIEWER, so it gets a calm centered notice with a way
// out (open in the OS default app / reveal in the file manager). Anything
// else — missing file, permission denied, IO error — is a real failure and
// keeps the red raw message, because offering "Open in default app" on a
// file that would not read is offering a button that fails again.
//
// Split from the component so the rule is testable without mounting React
// (and so the sibling panes can adopt it later without copying the regexes).
//
// Both detections are LOOSE matches against messages Rust returns from
// `read_text_file_capped` ("file is not valid UTF-8" / "file too large to
// preview (N bytes)", src-tauri/src/lib.rs). That cross-language coupling is
// pinned by Rust tests, so a reword there fails `cargo test` instead of
// silently dropping this pane back to the raw error. Deliberately loose: the
// UTF-8 one should survive "invalid UTF-8" too.
//
// Rust checks binary BEFORE size, so a 40 MB archive lands on the binary
// notice (which offers the app that CAN open it) rather than on the
// less useful "too large".

import { i18n } from "@/lib/i18n";

/** Copy for the binary case. Says "here", not "at all": the file is fine,
 *  this viewer is not, and the two buttons under it are the way out. */
export function binaryNotice(): string {
  return i18n.t("backend:editorError.binary");
}

/** Copy for the too-large case, with the file's size when Rust reported one.
 *  The size is the whole reason to say anything beyond "too large": it tells
 *  the user whether they hit a 3 MB log or a 900 MB dump. */
export function tooLargeNotice(bytes: number | null): string {
  return i18n.t("backend:editorError.tooLarge", {
    size: bytes === null ? "" : i18n.t("backend:editorError.tooLargeSized", { mb: formatBytes(bytes) }),
  });
}

/** Byte count as the size a file manager would show. One decimal past 1 MB,
 *  whole KB below it: nobody needs three digits of precision to learn that a
 *  file is far too big to open. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

export type EditorLoadError =
  /** Not decodable as text. Calm notice + OS actions. */
  | { kind: "binary"; message: string }
  /** Decodable, but past the read cap. Calm notice + OS actions. */
  | { kind: "too-large"; message: string }
  /** A genuine read failure. Raw message, red. */
  | { kind: "raw"; message: string };

/** True for the two kinds that render the calm notice rather than red text.
 *  A type guard so the pane branches once instead of listing kinds twice. */
export function isUnviewable(e: EditorLoadError): e is Extract<EditorLoadError, { kind: "binary" | "too-large" }> {
  return e.kind === "binary" || e.kind === "too-large";
}

/** Classify a rejected `taskFileRead`. Never throws; anything unrecognised
 *  falls through to `raw`, so a new Rust failure mode is still surfaced. */
export function classifyEditorLoadError(e: unknown): EditorLoadError {
  const message = String(e);
  if (/valid UTF-8/i.test(message)) return { kind: "binary", message: binaryNotice() };
  if (/too large to preview/i.test(message)) {
    // "(1234 bytes)" when fstat gave a size, "(>2000000 bytes)" when the file
    // grew mid-read. Only the exact one is worth quoting back.
    const exact = /\((\d+) bytes\)/.exec(message);
    return { kind: "too-large", message: tooLargeNotice(exact ? Number(exact[1]) : null) };
  }
  return { kind: "raw", message };
}
