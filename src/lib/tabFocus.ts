// Keyboard-focus helpers for tabs. xterm captures input through a hidden
// `.xterm-helper-textarea`, CodeMirror through `.cm-content`. Used after a tab
// close (focus follows the tab that takes over), after a new tab spawns (focus
// lands in it so the user can type immediately), and when toggling the bottom
// split (⌘J) — instead of focus falling to <body>, or jumping to the wrong pane.

// Focus the first element matching `selector`, retrying across animation frames
// until focus actually lands. Two reasons a single attempt isn't enough:
//   1. The host may not be in the DOM yet — React has a re-render pending right
//      after the store update that triggered this.
//   2. The tab that takes over is mounted but still `visibility:hidden` for one
//      frame (panes stay mounted, visibility-toggled). focus() on a hidden
//      element is a no-op, so we verify it actually landed.
// tries ≈ frames: a fresh tab's textarea isn't in the DOM until TerminalPane /
// AuxTerminal mounts and runs `term.open()`, a few frames out — so retry
// generously. Always match the target as a DESCENDANT of its tab host, never
// via a two-step host-then-child lookup: TabBar pills also carry `data-tab-id`
// and sit earlier in the DOM, so resolving the host first can land on a pill
// (no terminal inside) and focus would never take.
function focusBySelector(selector: string, tries: number): void {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el) {
    el.focus();
    if (document.activeElement === el) return; // focus actually took
  }
  if (tries > 0) requestAnimationFrame(() => focusBySelector(selector, tries - 1));
}

// Focus a terminal tab's xterm — a main-pane TerminalPane or a bottom-split
// AuxTerminal, both of which tag their host with `data-tab-id`.
export function focusTerminalTab(tabId: string | undefined | null, tries = 30): void {
  if (!tabId) return;
  focusBySelector(`[data-tab-id="${CSS.escape(tabId)}"] .xterm-helper-textarea`, tries);
}

// Move focus back into a MAIN-pane tab — a terminal (xterm) or an editor
// (CodeMirror). Used when hiding the bottom split (⌘J) so focus returns to the
// agent / file the user was in, rather than falling to <body>. Scoped to
// `data-main-tab-id` (the WorkspaceView content wrapper) so it can't match a
// bottom-split AuxTerminal or a TabBar pill.
export function focusMainTab(tabId: string | undefined | null, tries = 30): void {
  if (!tabId) return;
  const host = `[data-main-tab-id="${CSS.escape(tabId)}"]`;
  focusBySelector(`${host} .xterm-helper-textarea, ${host} .cm-content`, tries);
}
