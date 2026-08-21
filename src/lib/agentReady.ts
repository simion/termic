// Wait for a freshly spawned agent to be ready for typed input.
//
// Every prompt-injection path used to sleep a flat few seconds after the
// PTY appeared and then type. That is a bet on the agent's boot time: win
// it and the text lands in the input box, lose it (a cold start, a
// contended machine, an agent pausing to connect its own MCP servers) and
// the text is written into a TUI that is not reading yet, which discards
// it. Nothing notices, because a write to a live PTY always succeeds.
//
// The store already carries the signals that timer was standing in for.
// TerminalPane stamps `firstOutputAt` when the PTY first produces output
// (the agent has started painting) and `lastOutputAt` on every chunk after
// it. A TUI that has painted and then gone quiet is sitting at its input
// box. So wait for the first paint, then for a quiet stretch, and only
// then hand back control.
//
// `firstOutputAt` is state, not a snapshot the caller has to take in time:
// polling can start whenever, and an agent that painted before anyone
// looked still reads as painted. `lastOutputAt` alone could not carry
// this, because it is stamped at spawn as well, which makes "quiet since
// spawn" and "nothing drawn yet" identical through it.
//
// Three bounds keep it honest:
//   - A floor, because an agent that prints one banner byte and then goes
//     quiet while it loads is not ready, however quiet it looks.
//   - A short deadline once it HAS painted, because a TUI that repaints an
//     idle status line more often than the quiet window would never look
//     quiet, and waiting the long deadline out for one would make every
//     prompt slower than the fixed sleep this replaced. Painted-and-noisy
//     is alive and drawing, which is all that sleep ever established, so
//     this lands near where it used to type.
//   - A long deadline while it has painted NOTHING, because that is the
//     case that loses prompts and is worth waiting out. Reaching it types
//     anyway: best-effort delivery beats refusing to deliver, and the
//     caller still verifies the PTY survived the write.

import type { TerminalTab } from "@/lib/types";

/** Quiet stretch that marks the TUI as done painting. Comfortably above
 *  TerminalPane's 500 ms `lastOutputAt` coalescing window, so a busy agent
 *  cannot look quiet in the gap between two store writes, and short enough
 *  that an agent repainting a status line still settles between repaints. */
export const READY_QUIET_MS = 1200;
/** Never type before this, however early the agent goes quiet. Boot output
 *  often arrives in bursts with real pauses between them. */
export const READY_FLOOR_MS = 3000;
/** Cap for an agent that painted but never goes quiet. Close to the 6 s
 *  fixed sleep this replaced, so a chatty TUI is no slower than it was. */
export const READY_PAINTING_DEADLINE_MS = 8000;
/** Cap for an agent that has painted nothing at all. Long, because this is
 *  the cold start whose prompt used to be typed into a splash screen. */
export const READY_DEADLINE_MS = 20_000;
const POLL_MS = 150;

/** Why the wait ended. `settled` is the good one: the agent painted and
 *  went quiet. `deadline` means it never stopped painting. `lost` means
 *  the tab dropped its PTY and there is nothing to type into. */
export type AgentReadyOutcome = "settled" | "deadline" | "lost";

/** Plain setTimeout, not window.setTimeout: this module is unit-tested
 *  outside a DOM environment, and the handle is never kept. */
export const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms); });

/** Wait until `tab()`'s agent looks ready for a typed prompt. Re-reads the
 *  tab on every poll so a restart onto a fresh PTY is seen. Never throws. */
export async function waitForAgentReady(
  tab: () => TerminalTab | undefined,
  opts: {
    quietMs?: number;
    floorMs?: number;
    paintingDeadlineMs?: number;
    deadlineMs?: number;
    pollMs?: number;
  } = {},
): Promise<AgentReadyOutcome> {
  const quietMs = opts.quietMs ?? READY_QUIET_MS;
  const floorMs = opts.floorMs ?? READY_FLOOR_MS;
  const paintingDeadlineMs = opts.paintingDeadlineMs ?? READY_PAINTING_DEADLINE_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? READY_DEADLINE_MS);

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const t = tab();
    if (!t?.ptyId) return "lost";
    const now = Date.now();
    const quietSince = t.lastOutputAt ?? now;
    if (t.firstOutputAt) {
      if (now - quietSince >= quietMs && now - started >= floorMs) return "settled";
      if (now - started >= paintingDeadlineMs) return "deadline";
    }
  }
  return "deadline";
}
