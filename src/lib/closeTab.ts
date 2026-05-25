// Tab-close with an unsaved-changes guard.
//
// Both close paths — the tab's "×" button and the ⌘W shortcut —
// route through here so a dirty editor buffer can never be discarded
// without the user explicitly confirming. termic never auto-saves, so
// closing a dirty `edit` tab is genuinely destructive.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";

/** Close a tab, but if it's an `edit` tab with unsaved changes, ask
 *  for confirmation first. Resolves once the tab is closed or the
 *  user backs out. */
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
  useApp.getState().closeTab(wsId, tabId);
}
