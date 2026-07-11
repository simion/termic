/**
 * Remove Claude Code's leading status glyphs from a live terminal title.
 *
 * Claude prefixes idle titles with ✳ and working titles with one or more
 * Braille spinner glyphs. We only hide those prefixes when Termic is already
 * showing its own working indicator, so users with the indicator disabled
 * still retain Claude's built-in state signal.
 */
export function formatTerminalTitle(
  title: string,
  cli: string,
  hideClaudeStatusGlyph: boolean,
): string {
  if (cli !== "claude" || !hideClaudeStatusGlyph) {
    return title;
  }

  return title
    .replace(/^\s*✳\s*/, "")
    .replace(/^\s*[\u2800-\u28ff](?:\s+[\u2800-\u28ff])*\s*/, "");
}
