// OSC 52 clipboard codec for @xterm/addon-clipboard.
//
// The addon's default base64 codec is spec-correct: OSC 52 carries base64 of
// the UTF-8 bytes, and it decodes that straight back. The problem is agents
// that DOUBLE-ENCODE: they take already-UTF-8 bytes, reinterpret them as
// Latin-1, then UTF-8-encode THAT before base64. Claude Code does this. The
// result is that copying an em dash (—, UTF-8 E2 80 94) lands on the clipboard
// as the three codepoints U+00E2 U+0080 U+0094, which display as "‚Äî".
//
// (iTerm doesn't show it because it ignores OSC 52 clipboard writes by default,
// so its native selection copy wins. We honor OSC 52, so we inherit the bug.)
//
// We can't change what the agent emits, so we repair on the way in: after the
// normal decode, if every codepoint fits in a byte AND re-decoding those bytes
// as UTF-8 succeeds (strict/fatal), the string was a UTF-8 run masquerading as
// Latin-1 — i.e. double-encoded — so we use the repaired text. The fatal
// validation is the safety gate: genuinely-copied Latin-1 text like "café"
// (é = U+00E9, a lone 0xE9 byte) fails UTF-8 validation and is left as-is.

/** Implements @xterm/addon-clipboard's IBase64 (`encodeText`/`decodeText`). */
export class Osc52Base64 {
  encodeText(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  decodeText(b64: string): string {
    let bin: string;
    try {
      bin = atob(b64.replace(/\s+/g, ""));
    } catch {
      return "";
    }
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const text = decodeUtf8Strict(bytes);
    // Not valid UTF-8 at all → hand back the raw bytes-as-string (best effort,
    // matches a permissive decode). Shouldn't happen for real OSC 52.
    if (text === null) return bin;

    // Double-encoding repair: only when the decoded string is itself a byte
    // sequence (all codepoints <= 0xFF) that re-decodes cleanly as UTF-8.
    if ([...text].every(ch => ch.charCodeAt(0) <= 0xff)) {
      const inner = Uint8Array.from(text, ch => ch.charCodeAt(0));
      const repaired = decodeUtf8Strict(inner);
      if (repaired !== null && repaired !== text) return repaired;
    }
    return text;
  }
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
