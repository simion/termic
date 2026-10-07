/** A leading run of spinner frames: any symbol that is not a letter, a
 *  number, whitespace or ASCII punctuation. The same catch-all the busy
 *  detector uses for claude (`BUILTIN_TITLE_SIGNALS` in lib/agents.ts),
 *  because the alphabet is not stable: Braille (U+2800..U+28FF), the circle
 *  family (◐◑◒◓) and the star family (✢✶✻✽, ·) have all shipped. Letters in
 *  any script survive, so a title in Chinese is never eaten, and so does
 *  ASCII punctuation (`#12 fix`, `[wip]`). */
const SPINNER_RUN = /^\s*(?:[^\p{L}\p{N}\s\x21-\x7e]\s*)+/u;

/**
 * Remove Claude Code's leading glyphs from a live terminal title, so each
 * thing the row says, it says once (docs/ui.md "One glyph per meaning").
 *
 * Claude prefixes an idle title with ✳ and a working one with a spinner
 * frame (see SPINNER_RUN). The ✳ only says "this is claude", which the brand icon
 * beside every title already says, so it always goes. The spinner says
 * "working", so it goes only while Termic draws its own working badge
 * (`termicShowsWork`, the workingIndicator pref): with that off it is the
 * user's only working signal. Its removal does not depend on the tab's
 * current state, so a tab needing attention whose title still spins does not
 * show both.
 *
 * `iconId` is the RESOLVED icon (`resolveIconId`), so a cloned agent such
 * as `claude-dpf` is treated as the claude it draws as.
 */
export function formatTerminalTitle(
  title: string,
  iconId: string,
  termicShowsWork: boolean,
): string {
  if (iconId !== "claude") return title;
  const noBrand = title.replace(/^\s*✳\s*/, "");
  if (!termicShowsWork) return noBrand;
  return noBrand.replace(SPINNER_RUN, "");
}

/**
 * True for the title Windows' console host announces on its own: ConPTY
 * sets the window title to the spawned program's path
 * (`\e]0;C:\Program Files\nodejs\node.exe\a`, measured on the Windows CI
 * runner by `src-tauri/examples/conpty_osc_probe.rs`) before the program has
 * run a line. It is not the program's title, so it must not become a tab's
 * live label or count as the agent having started. No title a unix program
 * sets looks like this.
 */
export function isConsoleHostTitle(title: string): boolean {
  // An elevated console prefixes it with "Administrator: " (measured on the
  // Windows CI runner, which runs elevated).
  return /^(Administrator: )?[A-Za-z]:\\[^\n]*\.(exe|com|cmd|bat)$/i.test(title.trim());
}
