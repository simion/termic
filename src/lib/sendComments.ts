// Deliver review comments to an agent. One path, two callers: the
// pending-comments bar (the whole queued batch) and the composer's "Send now"
// (this one comment, straight out, without joining the queue).
//
// Kept out of the components because the composer is framework-free CodeMirror
// DOM and cannot reach React state — and because "which agent, how it is
// written, what the user is told" should not have two implementations that
// drift apart.

import { deliverMessage } from "./agentSend";
import { isTerminalCli, tabLabel } from "./agents";
import { focusTerminalTab } from "./tabFocus";
import { composeCommentsMessage, type ReviewComment } from "@/store/reviewComments";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import type { TerminalTab } from "./types";

/** Live agent terminals for a task: real agents only, never a plain shell, a
 *  run tab, a custom-command tab, or a registry "terminal"-kind entry. A
 *  review comment is an instruction to act on; a dev server is not an agent. */
export function agentTargets(taskId: string): TerminalTab[] {
  const s = useApp.getState();
  return (s.tabs[taskId] ?? []).filter(
    (t): t is TerminalTab =>
      t.type === "terminal" && !!t.ptyId && !t.runTab && !isTerminalCli(t.cli, s.agents),
  );
}

/** Which agent a send lands in: an explicit pick, else the active tab when it
 *  is an agent, else the task default, else the first live one. */
export function pickAgentTarget(taskId: string, tabId?: string | null): TerminalTab | null {
  const targets = agentTargets(taskId);
  const activeTabId = useApp.getState().activeTab[taskId];
  return (
    (tabId ? targets.find(t => t.id === tabId) : undefined) ??
    targets.find(t => t.id === activeTabId) ??
    targets.find(t => t.is_default) ??
    targets[0] ??
    null
  );
}

/**
 * Write `comments` into an agent as ONE message and surface it.
 *
 * Resolves true once the bytes are in the PTY. The caller decides what that
 * means for its own state (the bar clears the queue; the composer never
 * queued in the first place), which is why nothing here touches the store.
 */
export async function sendCommentsToAgent(
  taskId: string,
  comments: ReviewComment[],
  opts: { tabId?: string | null; label?: string } = {},
): Promise<boolean> {
  if (!comments.length) return false;
  const target = pickAgentTarget(taskId, opts.tabId);
  if (!target?.ptyId) {
    useUI.getState().pushToast("No running agent in this task to send to.", "error");
    return false;
  }
  const name = tabLabel(target);
  try {
    await deliverMessage(target.ptyId, composeCommentsMessage(comments));
  } catch {
    useUI.getState().pushToast(`Could not reach ${name}. Nothing was sent.`, "error");
    return false;
  }
  // Arm work-done detection exactly as a keyboard Enter would: delivery writes
  // straight to the PTY, bypassing term.onData.
  useApp.getState().patchTab(taskId, target.id, { lastInputAt: Date.now() });
  // Same gate, same reason: the user wrote these comments and just sent them
  // to an agent, which starts the task (src/lib/taskPhase.ts).
  useApp.getState().markStarted(taskId);
  // Surface the agent we just fed and drop focus into it, so the user can keep
  // steering immediately.
  useApp.getState().setActiveTabId(taskId, target.id);
  focusTerminalTab(target.id);
  const what = opts.label ?? `${comments.length} comment${comments.length === 1 ? "" : "s"}`;
  useUI.getState().pushToast(`Sent ${what} to ${name}`, "success");
  return true;
}
