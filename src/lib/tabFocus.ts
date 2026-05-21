// Move keyboard focus to a tab's terminal. xterm captures input through
// a hidden `.xterm-helper-textarea`; every terminal-tab host carries a
// `data-tab-id` — the TerminalPane root up top, and the bottom-split
// AuxTerminal wrappers down below. Used after a tab close (focus
// follows to the tab that takes over) and after a new tab is spawned
// (focus lands in it so the user can type immediately) — instead of
// focus falling to <body>, or jumping to the wrong pane.
//
// Two reasons a single attempt isn't enough, both handled by retrying
// across animation frames:
//   1. The host may not be in the DOM yet — React has a re-render
//      pending right after the store update that triggered this.
//   2. The tab that takes over is mounted but still `visibility:hidden`
//      for one frame (panes stay mounted, visibility-toggled). focus()
//      on a hidden element is a no-op, so we verify it actually landed.
// tries ≈ frames: a fresh tab's xterm helper-textarea isn't in the DOM
// until TerminalPane / AuxTerminal mounts and runs `term.open()` — a
// few frames out — so retry generously before giving up.
export function focusTerminalTab(tabId: string | undefined | null, tries = 30): void {
  if (!tabId) return;
  const host = document.querySelector(`[data-tab-id="${tabId}"]`);
  const el = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
  if (el) {
    el.focus();
    if (document.activeElement === el) return; // focus actually took
  }
  if (tries > 0) requestAnimationFrame(() => focusTerminalTab(tabId, tries - 1));
}
