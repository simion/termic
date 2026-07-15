// Agent Race orchestration (Slice 1): fire ONE prompt at N agents, each in its
// own fresh worktree, and seed the same prompt into every agent once it boots.
// Reuses the proven spawn -> wait-for-PTY -> settle -> inject recipe from
// lib/runPrompt (generalized from "a new tab in one task" to "the default tab
// of each new task"). The cohort is recorded in the race store so the
// RaceBoard, and later the compare slice, can enumerate exactly which
// worktrees raced instead of parsing names.
//
// Public surface: startRace. NOT responsible for the launcher UI (RaceDialog)
// or the board (RaceBoard); this is the spawn+seed engine only.
//
// Test strategy: e2e dev bridge asserts at the store/IPC layer (N tasks under
// the project, each default tab acquires a ptyId, lastInputAt stamped after
// the settle, race store cohort = N taskIds). The prompt visibly landing in
// each agent's input box needs eyes (hidden-pane timing probes fabricate).

import { taskCreate } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useRace } from "@/store/race";
import { useUI } from "@/store/ui";
import { launchSetupTab } from "@/lib/runTabs";
import { sendMessageToPty } from "@/lib/agentSend";
import { agentDisplayName } from "@/lib/agents";
import { slugify } from "@/lib/utils";
import type { TerminalTab } from "@/lib/types";

/** One racer to spawn: an agent CLI id and its 1-based index within that CLI
 *  (so two claudes become "Claude #1" / "Claude #2" with distinct branches). */
export interface Racer { cli: string; n: number; }

// N agents boot at once here and contend for CPU, so give the TUIs a beat
// longer than the single-spawn path (runPrompt's 5s) to reach the input box
// before we type, so the prompt lands in the box, not on a splash screen.
const RACE_SETTLE_MS = 6000;
const SPAWN_DEADLINE_MS = 15000;
const POLL_MS = 150;

/** Poll until `taskId`'s default agent tab has a live PTY, let the agent
 *  settle, then inject `prompt` and stamp lastInputAt (arms work-done
 *  detection, exactly as runPrompt does). Best-effort: gives up silently
 *  after the deadline. */
function seedPromptWhenReady(taskId: string, prompt: string) {
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
      }, RACE_SETTLE_MS);
      return;
    }
    if (Date.now() < deadline) window.setTimeout(tick, POLL_MS);
  };
  window.setTimeout(tick, POLL_MS);
}

/** Launch a race: create one worktree task per racer, mount them all so their
 *  agents spawn, seed the shared prompt into each, and record the cohort.
 *  Returns the created task ids in launch order. Throws if a task create
 *  fails (the dialog surfaces it). */
export async function startRace(opts: {
  projectId: string;
  racers: Racer[];
  prompt: string;
}): Promise<string[]> {
  const { projectId, racers, prompt } = opts;
  const raceId = crypto.randomUUID();
  const shortId = raceId.slice(0, 8);

  const taskIds: string[] = [];
  // Sequential: `git worktree add` contends on the repo index, so N concurrent
  // creates would race the lock. One at a time is safe and fast enough.
  for (const r of racers) {
    const id = crypto.randomUUID();
    await taskCreate({
      id,
      project_id: projectId,
      name: `${agentDisplayName(r.cli)} #${r.n}`,
      cli: r.cli,
      base_branch: null,
      branch: `race/${shortId}/${slugify(r.cli)}-${r.n}`,
    });
    taskIds.push(id);
  }

  await useApp.getState().loadAll();
  // Mount every racer (without stealing focus N times) so each TaskView seeds
  // its default agent tab and TerminalPane spawns its PTY. Focus the first.
  useApp.getState().mountTasks(taskIds);
  if (taskIds[0]) useApp.getState().setActiveTask(taskIds[0]);
  // Worktrees run their setup script unfocused, same as a normal create.
  for (const id of taskIds) launchSetupTab(id, { focus: false }).catch(() => {});
  // Seed the shared prompt into each agent once it's input-ready.
  for (const id of taskIds) seedPromptWhenReady(id, prompt);

  useRace.getState().start({ id: raceId, prompt: firstLine(prompt), taskIds, createdAt: Date.now() });
  useUI.getState().pushToast(`Race started: ${racers.length} agents on one prompt.`, "success");
  return taskIds;
}

/** The prompt's first non-empty line, capped, for the board label. */
function firstLine(s: string): string {
  const line = s.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "Untitled prompt";
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}
