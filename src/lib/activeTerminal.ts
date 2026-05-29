// Resolve which terminal PTY a workspace-scoped action (the ⌘I context
// picker) should write into. Pure so it's unit-testable.
//
// Scope: the main-area agent terminals only. Bottom-split scratch shells are
// intentionally excluded — their PTY id lives inside the AuxTerminal component
// (not the store), and inserting agent @context into a plain shell isn't
// meaningful. The @-interception path (TerminalPane) targets its own PTY
// directly and doesn't go through here.

import type { Tab } from "@/lib/types";

const ptyOf = (t: Tab | undefined): string | null =>
  t && t.type === "terminal" && t.ptyId ? t.ptyId : null;

/** Returns the active main terminal tab's PTY id, falling back to the first
 *  main terminal tab that has a live PTY. Null when the workspace has no
 *  spawned terminal (e.g. only editor/diff tabs, or a terminal that hasn't
 *  spawned yet). */
export function resolveTargetPty(tabs: Tab[], activeTabId: string | undefined): string | null {
  const activePty = ptyOf(tabs.find(t => t.id === activeTabId));
  if (activePty) return activePty;
  for (const t of tabs) {
    const p = ptyOf(t);
    if (p) return p;
  }
  return null;
}
