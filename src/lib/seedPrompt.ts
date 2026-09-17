// Seed a first message into a task that was JUST created: wait for its
// default agent tab to acquire a PTY, wait for the agent TUI to be ready
// for input (lib/agentReady), then type the prompt and stamp lastInputAt
// (which arms work-done detection for the turn that follows).
//
// Three callers, same recipe:
//   - Agent Race (lib/agentRace) spawns N agents at once, which contend
//     for CPU.
//   - The New Task dialog's optional first message (GH #192) spawns one.
//   - The issue-seeded task path (lib/issuePrompt.ts) can sit behind a setup
//     script before its PTY ever spawns, so it passes a much longer deadline.
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
import { logWorkState } from "@/lib/workStateLog";
import { deliverMessage } from "@/lib/agentSend";
import { waitForAgentReady, sleep } from "@/lib/agentReady";
import type { TerminalTab } from "@/lib/types";

/** How long to wait for the agent's PTY before giving up. Race/New-Task
 *  agents spawn immediately; an issue task can sit behind a setup script
 *  first, so that caller passes SETUP_SPAWN_DEADLINE_MS instead. */
export const SPAWN_DEADLINE_MS = 15000;
export const SETUP_SPAWN_DEADLINE_MS = 90000;
const POLL_MS = 150;

/** Wait until `taskId`'s default agent tab has a live PTY and its agent is
 *  ready for input, then inject `prompt`. No-op for an empty prompt. */
export function seedPromptWhenReady(
  taskId: string,
  prompt: string,
  deadlineMs: number = SPAWN_DEADLINE_MS,
): void {
  if (!prompt.trim()) return;
  const defaultTab = () =>
    (useApp.getState().tabs[taskId] ?? []).find(
      (t): t is TerminalTab => t.type === "terminal" && !!t.is_default,
    );
  void (async () => {
    const deadline = Date.now() + deadlineMs;
    while (!defaultTab()?.ptyId) {
      if (Date.now() >= deadline) return;
      await sleep(POLL_MS);
    }
    // Does this agent report its own readiness? If so, waiting for it beats
    // every heuristic, and NOT waiting is what makes this path dangerous.
    const cli = defaultTab()?.cli;
    const hooksOwnReadiness = !!cli && useApp.getState().agentHooksInstalled[cli] === true;
    const outcome = await waitForAgentReady(defaultTab, { hooksOwnReadiness });
    if (outcome === "lost") return;
    // The agent reports readiness and never reported it. Something is holding
    // its startup, and the one case measured is claude's trust picker, where
    // typing is not merely useless: the submit confirms the highlighted
    // option, which is `No, exit`, and the agent exits. Losing the prompt is
    // the better failure, so this gives up without writing a byte.
    if (outcome === "blocked") {
      logWorkState("seed-blocked", `${cli} never reported ready; not typing (startup prompt?)`);
      return;
    }
    // Re-read: the tab may have restarted onto a fresh PTY while we
    // waited, so never write the prompt into a stale/dead pty.
    const still = defaultTab();
    if (!still?.ptyId) return;
    // Echo-verify unless the agent already told us it is ready. This is the
    // same protection for agents that report nothing: an input box echoes
    // what you type, a selection list does not, so a missing echo withholds
    // the submit rather than pressing Enter on someone else's dialog.
    try {
      await deliverMessage(still.ptyId, prompt, { verifyEcho: outcome !== "ready" });
    } catch (e) {
      logWorkState("seed-withheld", String(e));
      return;
    }
    useApp.getState().patchTab(taskId, still.id, { lastInputAt: Date.now() });
    // The New Task dialog's first message is the user's own text, so a task
    // created WITH a prompt is In progress from birth while one created empty
    // stays Todo until somebody types (src/lib/taskPhase.ts). Stamped here
    // rather than at create, because a prompt that was never delivered (the
    // withheld/blocked returns above) did not start anything.
    useApp.getState().markStarted(taskId);
  })();
}
