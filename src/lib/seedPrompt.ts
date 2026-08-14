// Seed a first message into a task that was JUST created: wait for its
// default agent tab to acquire a PTY, let the agent TUI finish booting, then
// type the prompt and stamp lastInputAt (which arms work-done detection for
// the turn that follows).
//
// Two callers, same recipe, different patience:
//   - Agent Race (lib/agentRace) spawns N agents at once, which contend for
//     CPU, so it waits longer before typing.
//   - The New Task dialog's optional first message (GH #192) spawns one.
//
// Best-effort by design: if the PTY never comes up, or the tab restarts onto
// a fresh PTY mid-settle, this gives up silently rather than typing into a
// dead terminal. The prompt is a convenience, not a delivery contract — the
// CLI's `--wait` path (lib/cliRpc's injectPromptTracked) is the one that has
// to REPORT delivery, and it deliberately keeps its own copy for that.

import { useApp } from "@/store/app";
import { sendMessageToPty } from "@/lib/agentSend";
import type { TerminalTab } from "@/lib/types";

/** One agent booting alone. Matches runPrompt's AGENT_INIT_SETTLE_MS. */
export const SINGLE_SETTLE_MS = 5000;
/** N agents booting together contend for CPU, so give the TUIs a beat
 *  longer to reach their input box before we type. */
export const RACE_SETTLE_MS = 6000;

const SPAWN_DEADLINE_MS = 15000;
const POLL_MS = 150;

/** Poll until `taskId`'s default agent tab has a live PTY, let the agent
 *  settle for `settleMs`, then inject `prompt`. No-op for an empty prompt. */
export function seedPromptWhenReady(
  taskId: string,
  prompt: string,
  settleMs: number = SINGLE_SETTLE_MS,
): void {
  if (!prompt.trim()) return;
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  const defaultTab = () =>
    (useApp.getState().tabs[taskId] ?? []).find(
      (t): t is TerminalTab => t.type === "terminal" && !!t.is_default,
    );
  const tick = () => {
    const t = defaultTab();
    if (t?.ptyId) {
      window.setTimeout(() => {
        // Re-read: the tab may have restarted onto a fresh PTY during the
        // settle window, so never write the prompt into a stale/dead pty.
        const still = defaultTab();
        if (!still?.ptyId) return;
        sendMessageToPty(still.ptyId, prompt);
        useApp.getState().patchTab(taskId, still.id, { lastInputAt: Date.now() });
      }, settleMs);
      return;
    }
    if (Date.now() < deadline) window.setTimeout(tick, POLL_MS);
  };
  window.setTimeout(tick, POLL_MS);
}
