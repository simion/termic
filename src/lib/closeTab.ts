// Tab-close with an unsaved-changes guard.
//
// EVERY close path — the main strip's "×", a pane pill's "×", and ⌘W in
// either pane — routes through here so a dirty editor buffer or a live agent
// session can never be discarded without the user explicitly confirming.
// termic never auto-saves, so closing a dirty `edit` tab is genuinely
// destructive.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import type { Tab } from "@/lib/types";
import { agentDisplayName, isTerminalCli } from "@/lib/agents";

/** Shared confirm gate: resolves true when closing `tab` is safe (nothing to
 *  lose, or the user confirmed). `paneTab` tweaks the agent copy — pane tabs
 *  are never durable, so closing an agent there always forgets the session. */
async function confirmTabClose(tab: Tab | undefined, paneTab: boolean): Promise<boolean> {
  if (tab?.type === "edit" && tab.dirty) {
    const name = tab.path.split("/").pop() || tab.path;
    // No checkbox in the request → askConfirm resolves a plain boolean; the
    // === true keeps TS happy across its overloads.
    const ok = await useUI.getState().askConfirm({
      title: "Close without saving?",
      message: `"${name}" has unsaved changes. Closing the tab will discard them. ⌘S to save first.`,
      confirmLabel: "Discard & close",
      destructive: true,
    });
    return ok === true;
  }
  // Agent-tab close semantics (issue #23): the MAIN agent tab stays durable
  // — closing it just ends the process and the session auto-resumes when the
  // workspace wakes, so it's not destructive. A SECONDARY ("+") agent tab or
  // a split-pane agent tab is FORGOTTEN on close — X is the way to get rid
  // of it for good — so that close is destructive and the copy says so.
  // Plain shells (cli === "shell") close instantly; there's nothing to lose.
  if (tab?.type === "terminal" && tab.cli !== "shell") {
    // Custom-command and registry-terminal tabs have no agent session to
    // end or resume — the confirm is only about killing the live process.
    const termLike = isTerminalCli(tab.cli, useApp.getState().agents);
    // Process already exited (ptyId cleared on exit) → nothing to stop, and
    // terminal-like tabs have no session to lose either. Close silently
    // instead of a fake "Stops the running process" confirm.
    if (termLike && !tab.ptyId) return true;
    const label = tab.cli === "custom"
      ? (tab.title || "this command")
      : agentDisplayName(tab.cli, useApp.getState().agents);
    const isMain = !paneTab && !!tab.is_default;
    const ok = await useUI.getState().askConfirm({
      title: `Close ${label}?`,
      message: termLike
        ? "Stops the running process and closes the tab."
        : isMain
          ? "Stops the running process. The session resumes when you reopen the workspace."
          : "Ends this agent's session. It won't be restored when the workspace reopens.",
      confirmLabel: "Close tab",
      destructive: !isMain && !termLike,
    });
    return ok === true;
  }
  return true;
}

/** Close a main-pane tab, asking first when closing is destructive.
 *  Resolves once the tab is closed or the user backs out. */
export async function requestCloseTab(wsId: string, tabId: string) {
  const tab = useApp.getState().tabs[wsId]?.find(t => t.id === tabId);
  if (!(await confirmTabClose(tab, false))) return;
  useApp.getState().closeTab(wsId, tabId);
}

/** Close a split-pane tab with the same confirm gate as the main path.
 *  Returns true when the tab was actually closed (so callers can chain a
 *  closePane when it was the pane's last tab), false when the user backed
 *  out. */
export async function requestClosePaneTab(wsId: string, paneId: string, tabId: string): Promise<boolean> {
  const tab = useApp.getState().tabs[wsId]?.find(t => t.id === tabId);
  if (!(await confirmTabClose(tab, true))) return false;
  useApp.getState().closePaneTab(wsId, paneId, tabId);
  return true;
}
