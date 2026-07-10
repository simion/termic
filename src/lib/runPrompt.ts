// Fire a library prompt at a destination the user picks at fire-time:
//   { kind: "agent", tabId } → an existing agent. If it's mid-turn
//                 (workState === "working") and supports work-done detection,
//                 the prompt is QUEUED (message queue) and a toast tells the
//                 user; otherwise it's sent immediately.
//   { kind: "new" } → spawn a fresh agent tab with the task's default CLI,
//                 wait for the PTY to come up AND the agent to initialize, then
//                 inject. A loader overlay (promptPendingTitle) covers the tab
//                 until the prompt is sent.
//
// Sending goes through sendMessageToPty (text, then a delayed CR) so agent TUIs
// register a real submit, and stamps lastInputAt so TerminalPane re-arms
// work-done detection for the next turn.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { sendMessageToPty } from "./agentSend";
import { workDoneCapable, agentDisplayName, tabLabel } from "./agents";
import type { Prompt } from "@/store/prompts";
import type { TerminalTab, Tab } from "@/lib/types";

/** Where a fired prompt goes: an existing agent tab, or a freshly spawned one
 *  with an explicit CLI (falls back to the task default when omitted). */
export type PromptDest = { kind: "agent"; tabId: string } | { kind: "new"; cli?: string };

// Once the PTY exists, give the agent TUI time to finish booting (auth check,
// MOTD, splash, the prompt box) before we type, so the prompt lands in the
// input and not a startup screen. Agents are slow to become input-ready, so
// this is deliberately generous; the loader overlay covers the wait.
const AGENT_INIT_SETTLE_MS = 5000;
const SPAWN_DEADLINE_MS = 12000;

function sendToAgent(taskId: string, prompt: Prompt, tabId: string) {
  const target = (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.id === tabId && t.type === "terminal",
  );
  if (!target?.ptyId) {
    useUI.getState().pushToast("That agent is no longer running.", "error");
    return;
  }
  const label = tabLabel(target);
  const busy = workDoneCapable(target.cli) && target.workState === "working";
  if (busy) {
    useApp.getState().enqueueAgentMessage(taskId, target.id, prompt.body);
    useUI.getState().pushToast(
      `${label} is busy. Queued "${prompt.title}", it sends when the current turn finishes.`,
      "info",
    );
    return;
  }
  sendMessageToPty(target.ptyId, prompt.body);
  useApp.getState().patchTab(taskId, target.id, { lastInputAt: Date.now() });
  useUI.getState().pushToast(`Sent "${prompt.title}" to ${label}.`, "success");
}

function spawnAgentWithPrompt(taskId: string, prompt: Prompt, explicitCli?: string) {
  const s = useApp.getState();
  const tabs = (s.tabs[taskId] ?? []) as Tab[];
  // Use the chosen CLI; otherwise the task default (default agent tab's
  // CLI, else any agent tab's, else claude).
  const cli =
    explicitCli ??
    tabs.find((t): t is TerminalTab => t.type === "terminal" && !!t.is_default)?.cli ??
    tabs.find((t): t is TerminalTab => t.type === "terminal")?.cli ??
    "claude";
  const newTabId = crypto.randomUUID();
  // promptPendingTitle drives the loader overlay (TerminalPane) until we inject.
  s.addTab(taskId, {
    id: newTabId, type: "terminal", title: `${agentDisplayName(cli)} · ${prompt.title}`, cli,
    promptPendingTitle: prompt.title,
  });

  // Wait for TerminalPane to spawn the PTY, then let the agent initialize
  // before injecting. Clear the overlay once sent (or on timeout).
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  const tick = () => {
    const t = (useApp.getState().tabs[taskId] ?? []).find(t => t.id === newTabId);
    if (t && t.type === "terminal" && t.ptyId) {
      window.setTimeout(() => {
        // Re-read the tab: it may have been closed, or restarted onto a fresh
        // PTY during the settle window. Read the CURRENT ptyId so we never
        // write the prompt into a stale/dead pty.
        const still = (useApp.getState().tabs[taskId] ?? []).find(t => t.id === newTabId);
        if (!still || still.type !== "terminal" || !still.ptyId) return;
        sendMessageToPty(still.ptyId, prompt.body);
        useApp.getState().patchTab(taskId, newTabId, { lastInputAt: Date.now(), promptPendingTitle: null });
      }, AGENT_INIT_SETTLE_MS);
      return;
    }
    if (Date.now() < deadline) { window.setTimeout(tick, 150); return; }
    // PTY never came up — drop the overlay and tell the user.
    if ((useApp.getState().tabs[taskId] ?? []).some(t => t.id === newTabId)) {
      useApp.getState().patchTab(taskId, newTabId, { promptPendingTitle: null });
      useUI.getState().pushToast(`Couldn't start the agent to run "${prompt.title}".`, "error");
    }
  };
  window.setTimeout(tick, 500);
}

/** Run a library prompt at the chosen destination. */
export function runPrompt(taskId: string, prompt: Prompt, dest: PromptDest): void {
  if (dest.kind === "new") spawnAgentWithPrompt(taskId, prompt, dest.cli);
  else sendToAgent(taskId, prompt, dest.tabId);
}
