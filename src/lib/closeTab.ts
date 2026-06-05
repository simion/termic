// Tab-close with an unsaved-changes guard.
//
// Both close paths — the tab's "×" button and the ⌘W shortcut —
// route through here so a dirty editor buffer can never be discarded
// without the user explicitly confirming. termic never auto-saves, so
// closing a dirty `edit` tab is genuinely destructive.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { agentDisplayName } from "@/lib/agents";

/** Close a tab, asking first when closing it is destructive:
 *   - an `edit` tab with unsaved changes (discards the buffer), or
 *   - a terminal tab running an agent / custom command (kills the live
 *     session). Plain shell tabs close instantly — nothing to lose.
 *  Both close paths — the "×" button and ⌘W — route through here.
 *  Resolves once the tab is closed or the user backs out. */
export async function requestCloseTab(wsId: string, tabId: string) {
  const tab = useApp.getState().tabs[wsId]?.find(t => t.id === tabId);
  if (tab?.type === "edit" && tab.dirty) {
    const name = tab.path.split("/").pop() || tab.path;
    const ok = await useUI.getState().askConfirm({
      title: "Close without saving?",
      message: `"${name}" has unsaved changes. Closing the tab will discard them. ⌘S to save first.`,
      confirmLabel: "Discard & close",
      destructive: true,
    });
    if (!ok) return;
  }
  // Closing an agent (or custom-command) terminal kills its running
  // session — confirm so an accidental ⌘W doesn't drop the conversation.
  // Plain shells (cli === "shell") close instantly; there's nothing to lose.
  if (tab?.type === "terminal" && tab.cli !== "shell") {
    const label = tab.cli === "custom"
      ? (tab.title || "this command")
      : agentDisplayName(tab.cli, useApp.getState().agents);
    const ok = await useUI.getState().askConfirm({
      title: `Close ${label}?`,
      message: "Closing this tab ends the running session.",
      confirmLabel: "Close tab",
      destructive: true,
    });
    if (!ok) return;
  }
  useApp.getState().closeTab(wsId, tabId);
}
