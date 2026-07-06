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
//
// `fallbackSelector` (the tab host wrapper, which carries tabIndex=-1): some
// tab content is present and visible but UNFOCUSABLE — a read-only CodeMirror
// (DiffPane) renders contenteditable=false with no tabindex, and MarkdownPane
// in preview mode keeps its .cm-content inside a display:none wrapper (its
// computed `visibility` is still "visible", so the guard below doesn't catch
// it). When focus() on such an element doesn't take, focus the host wrapper
// instead — keyboard focus stays inside the right pane, so DOM-focus-derived
// logic (⌘W pane detection, ⇧⌘[/] cycling) keeps working.
function focusBySelector(selector: string, tries: number, fallbackSelector?: string): void {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el) {
    // On WebKit, focus() on a visibility:hidden element (or a child of one)
    // can set document.activeElement without routing keyboard events — a
    // false-success. Only count focus as taken when the element is visible.
    if (getComputedStyle(el).visibility !== 'hidden') {
      el.focus();
      if (document.activeElement === el) return;
      // Present + visible, yet focus didn't take → unfocusable content.
      // Land on the host wrapper instead of retrying a hopeless target.
      if (fallbackSelector) {
        const host = document.querySelector(fallbackSelector) as HTMLElement | null;
        if (host) {
          host.focus();
          if (document.activeElement === host) return;
        }
      }
    }
  }
  if (tries > 0) requestAnimationFrame(() => focusBySelector(selector, tries - 1, fallbackSelector));
}

// Focus a terminal tab's xterm — a main-pane TerminalPane or a bottom-split
// AuxTerminal, both of which tag their host with `data-tab-id`.
export function focusTerminalTab(tabId: string | undefined | null, tries = 30): void {
  if (!tabId) return;
  focusBySelector(`[data-tab-id="${CSS.escape(tabId)}"] .xterm-helper-textarea`, tries);
}

// Focus a split-pane tab's content — terminal (xterm) OR editor (CodeMirror).
// Split panes host mixed tab types, so unlike focusTerminalTab this must match
// `.cm-content` too; the pane tab wrapper carries `data-tab-id` and
// tabIndex=-1 (the fallback target for diff / markdown-preview tabs).
export function focusPaneTab(tabId: string | undefined | null, tries = 30): void {
  if (!tabId) return;
  const host = `[data-tab-id="${CSS.escape(tabId)}"][data-split-leaf]`;
  focusBySelector(`${host} .xterm-helper-textarea, ${host} .cm-content`, tries, host);
}

// Move focus back into a MAIN-pane tab — a terminal (xterm) or an editor
// (CodeMirror). Used when hiding the bottom split (⌘J) so focus returns to the
// agent / file the user was in, rather than falling to <body>. Scoped to
// `data-main-tab-id` (the content-layer wrapper) so it can't match a
// bottom-split AuxTerminal or a TabBar pill.
export function focusMainTab(tabId: string | undefined | null, tries = 30): void {
  if (!tabId) return;
  const host = `[data-main-tab-id="${CSS.escape(tabId)}"]`;
  focusBySelector(`${host} .xterm-helper-textarea, ${host} .cm-content`, tries, host);
}
