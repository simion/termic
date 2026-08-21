// Seed a first message into a task that was JUST created: wait for its
// default agent tab to acquire a PTY, wait for the agent TUI to be ready
// for input (lib/agentReady), then type the prompt and stamp lastInputAt
// (which arms work-done detection for the turn that follows).
//
// Two callers, same recipe:
//   - Agent Race (lib/agentRace) spawns N agents at once, which contend
//     for CPU.
//   - The New Task dialog's optional first message (GH #192) spawns one.
// They used to differ only in how long they slept before typing; readiness
// is now observed rather than guessed, so contention needs no extra
// patience - a busy machine simply paints later, and the wait sees it.
//
// Best-effort by design: if the PTY never comes up, or the tab restarts
// onto a fresh PTY mid-wait, this gives up silently rather than typing
// into a dead terminal. The prompt is a convenience, not a delivery
// contract - the CLI's `--wait` path (lib/cliRpc's injectPromptTracked) is
// the one that has to REPORT delivery, and it deliberately keeps its own
// copy for that.

import { useApp } from "@/store/app";
import { sendMessageToPty } from "@/lib/agentSend";
import { waitForAgentReady, sleep } from "@/lib/agentReady";
import type { TerminalTab } from "@/lib/types";

const SPAWN_DEADLINE_MS = 15000;
const POLL_MS = 150;

/** Wait until `taskId`'s default agent tab has a live PTY and its agent is
 *  ready for input, then inject `prompt`. No-op for an empty prompt. */
export function seedPromptWhenReady(taskId: string, prompt: string): void {
  if (!prompt.trim()) return;
  const defaultTab = () =>
    (useApp.getState().tabs[taskId] ?? []).find(
      (t): t is TerminalTab => t.type === "terminal" && !!t.is_default,
    );
  void (async () => {
    const deadline = Date.now() + SPAWN_DEADLINE_MS;
    while (!defaultTab()?.ptyId) {
      if (Date.now() >= deadline) return;
      await sleep(POLL_MS);
    }
    if (await waitForAgentReady(defaultTab) === "lost") return;
    // Re-read: the tab may have restarted onto a fresh PTY while we
    // waited, so never write the prompt into a stale/dead pty.
    const still = defaultTab();
    if (!still?.ptyId) return;
    sendMessageToPty(still.ptyId, prompt);
    useApp.getState().patchTab(taskId, still.id, { lastInputAt: Date.now() });
  })();
}
