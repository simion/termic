// The precedence table from src/lib/taskPhase.ts's header, rule by rule, plus
// the decisions argued there. Four inputs decide a phase now (the record, the
// PR snapshot, the git state, and whether each of the last two is KNOWN), so
// most of what is worth pinning is the interaction between them rather than
// any single rule on its own.

import { describe, it, expect } from "vitest";
import {
  taskPhase, phaseCounts, taskAgeLabel, PHASE_ORDER, PHASE_LABEL, PHASE_EMPTY_LABEL,
} from "@/lib/taskPhase";
import { relativeDayLabel } from "@/lib/relativeDay";
import type { PrStatus, Task, TaskGitState } from "@/lib/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    name: "Feature work",
    branch: "feature/example",
    base_branch: "main",
    path: "/Users/u/code/acme/tasks/acme/feature-example",
    cli: "claude",
    port: 1420,
    created: "2026-01-01T00:00:00.000Z",
    archived: false,
    ...overrides,
  };
}

function makePr(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    provider: "github",
    number: 1,
    url: "https://github.com/acme/widget/pull/1",
    title: "Example change",
    state: "open",
    checks: "none",
    review: "none",
    base: "main",
    head: "feature/example",
    ...overrides,
  };
}

/** Defaults to a branch that has done nothing: base known, no commits, clean,
 *  nothing to push. Each case overrides only the field it is about. */
function makeGit(overrides: Partial<TaskGitState> = {}): TaskGitState {
  return {
    own_commits: 0,
    dirty: false,
    ahead: 0,
    merged_into_base: false,
    base_known: true,
    ...overrides,
  };
}

/** The three conditions of the git-derived In review rule, all satisfied. */
const HANDED_OFF = makeGit({ own_commits: 2, dirty: false, ahead: 0 });

const STARTED = "2026-02-01T09:00:00.000Z";

describe("taskPhase: todo", () => {
  it("a brand new task is todo: created, agent spawned, nobody has prompted it", () => {
    expect(taskPhase(makeTask(), null, null)).toBe("todo");
  });

  it("stays todo with a polled git state that says the branch has done nothing", () => {
    expect(taskPhase(makeTask(), null, makeGit())).toBe("todo");
  });

  it("spawn_count and has_resumable_history no longer move it", () => {
    // Both left the table: an agent running is not somebody having asked it
    // for something, and creation spawns one.
    const task = makeTask({ spawn_count: 4, has_resumable_history: true });
    expect(taskPhase(task, null, null)).toBe("todo");
  });
});

describe("taskPhase: in_progress", () => {
  it("started_at set is in_progress", () => {
    expect(taskPhase(makeTask({ started_at: STARTED }), null, null)).toBe("in_progress");
  });

  it("a draft PR is in_progress, not in_review", () => {
    expect(taskPhase(makeTask(), makePr({ state: "draft" }), null)).toBe("in_progress");
  });

  it("a closed PR is in_progress even on a task nobody ever prompted", () => {
    const task = makeTask({ started_at: null });
    expect(taskPhase(task, makePr({ state: "closed" }), null)).toBe("in_progress");
  });

  it("a dirty worktree drops a committed, pushed branch back to in_progress", () => {
    // The work cycle: this is the oscillation the design accepts on purpose.
    // NOTE the `null` PR. That cycle is the NO-PR path only, which the four
    // cases below pin from the other side.
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, null, { ...HANDED_OFF, dirty: true })).toBe("in_progress");
  });

  // An open PR is an explicit act by a person saying the work is ready to be
  // looked at. `dirty` and `ahead` are PROXIES for that same statement, used
  // only where no such statement exists, so they must not overrule it. The
  // practical half: a dirty worktree under an open PR is what addressing
  // review comments looks like, and a phase that flipped on every edit would
  // be the noise `changes_requested` is already kept out of the phase to
  // avoid. None of this was pinned until someone asked what it did.
  describe("taskPhase: an open PR outranks the local worktree", () => {
    it("stays in_review with a dirty worktree", () => {
      const task = makeTask({ started_at: STARTED });
      expect(taskPhase(task, makePr({ state: "open" }), { ...HANDED_OFF, dirty: true }))
        .toBe("in_review");
    });

    it("stays in_review with commits that were never pushed", () => {
      const task = makeTask({ started_at: STARTED });
      expect(taskPhase(task, makePr({ state: "open" }), { ...HANDED_OFF, ahead: 3 }))
        .toBe("in_review");
    });

    it("stays in_review with no remote branch at all", () => {
      // `ahead: null` is "there is no remote branch", the one the no-PR rule
      // treats as strictly not-handed-off.
      const task = makeTask({ started_at: STARTED });
      expect(taskPhase(task, makePr({ state: "open" }), { ...HANDED_OFF, ahead: null }))
        .toBe("in_review");
    });

    it("stays in_review mid-rework, dirty and ahead and nothing committed", () => {
      const task = makeTask({ started_at: STARTED });
      const git = makeGit({ own_commits: 0, dirty: true, ahead: 5 });
      expect(taskPhase(task, makePr({ state: "open" }), git)).toBe("in_review");
    });

    it("but a DRAFT PR with the same clean pushed branch is in_progress", () => {
      // The asymmetry is deliberate and this is the control for it: draft is
      // the person saying the opposite, so it wins over the git rule too.
      const task = makeTask({ started_at: STARTED });
      expect(taskPhase(task, makePr({ state: "draft" }), HANDED_OFF)).toBe("in_progress");
    });
  });

  it("unknown git with started_at is in_progress", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, null, undefined)).toBe("in_progress");
    expect(taskPhase(task, null, null)).toBe("in_progress");
  });

  it("unknown git WITHOUT started_at is todo, not in_progress", () => {
    const task = makeTask();
    expect(taskPhase(task, null, undefined)).toBe("todo");
    expect(taskPhase(task, null, null)).toBe("todo");
  });
});

describe("taskPhase: in_review", () => {
  it("an open PR is in_review", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, makePr({ state: "open" }), null)).toBe("in_review");
  });

  it("changes_requested on an open PR stays in_review", () => {
    const pr = makePr({ state: "open", review: "changes_requested" });
    expect(taskPhase(makeTask(), pr, null)).toBe("in_review");
  });

  it("failing checks on an open PR stay in_review", () => {
    const pr = makePr({ state: "open", checks: "failing" });
    expect(taskPhase(makeTask(), pr, null)).toBe("in_review");
  });

  it("an open PR wins even when the worktree is filthy", () => {
    // The PR is an explicit statement; local scratch work does not retract it.
    const task = makeTask({ started_at: STARTED });
    const git = makeGit({ own_commits: 3, dirty: true, ahead: 2 });
    expect(taskPhase(task, makePr({ state: "open" }), git)).toBe("in_review");
  });

  it("no PR plus own commits, clean tree and nothing ahead is in_review", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, null, HANDED_OFF)).toBe("in_review");
  });

  it("the git rule needs all three conditions: each one missing flips it", () => {
    const task = makeTask({ started_at: STARTED });
    // The control: all three present.
    expect(taskPhase(task, null, HANDED_OFF)).toBe("in_review");
    // No commits of its own, so there is nothing to hand off.
    expect(taskPhase(task, null, { ...HANDED_OFF, own_commits: 0 })).toBe("in_progress");
    // Uncommitted (or untracked) work still in the worktree.
    expect(taskPhase(task, null, { ...HANDED_OFF, dirty: true })).toBe("in_progress");
    // Committed locally but never pushed.
    expect(taskPhase(task, null, { ...HANDED_OFF, ahead: 3 })).toBe("in_progress");
  });

  it("ahead === null is not in_review: no remote branch is not nothing to push", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, null, { ...HANDED_OFF, ahead: null })).toBe("in_progress");
  });

  it("base_known false still reads in_review: own commits are counted against the base branch", () => {
    // An imported worktree or a reused branch has no `base_sha` and often no
    // reflog, so `base_known` is false for the whole life of the task. Its
    // commits beyond the base branch, a clean tree and a pushed remote are
    // exactly as real as anyone else's, and the creation commit is only ever
    // needed for `merged_into_base`, which Rust folds in on its own.
    const task = makeTask({ started_at: STARTED });
    const git = { ...HANDED_OFF, base_known: false };
    expect(taskPhase(task, null, git)).toBe("in_review");
  });

  it("a draft PR never becomes in_review, however clean the git state", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, makePr({ state: "draft" }), HANDED_OFF)).toBe("in_progress");
  });

  it("a closed PR never becomes in_review, however clean the git state", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, makePr({ state: "closed" }), HANDED_OFF)).toBe("in_progress");
  });

  it("the git rule does not fire for a task that was never started either", () => {
    // Not a special case in the code, just the consequence worth pinning:
    // rule 2 does not consult `started_at` at all, so a branch that arrived
    // committed and pushed reads In review without anybody prompting it.
    expect(taskPhase(makeTask(), null, HANDED_OFF)).toBe("in_review");
  });
});

describe("taskPhase: done", () => {
  it("a merged PR is done", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, makePr({ state: "merged" }), null)).toBe("done");
  });

  it("archived is done, regardless of PR state", () => {
    const task = makeTask({ archived: true, started_at: STARTED });
    expect(taskPhase(task, makePr({ state: "open" }), null)).toBe("done");
  });

  it("archived wins even when there is no PR and no git state at all", () => {
    expect(taskPhase(makeTask({ archived: true }), null, null)).toBe("done");
  });

  it("merged_into_base is done with no PR involved: ff, rebase and squash all land here", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, null, makeGit({ merged_into_base: true }))).toBe("done");
  });

  it("merged_into_base beats an open PR", () => {
    // The branch is in the base branch. Whatever the PR still says, the work
    // has landed, and this is the case the poller keeps polling draft and
    // closed PRs for.
    const task = makeTask({ started_at: STARTED });
    const git = makeGit({ merged_into_base: true });
    expect(taskPhase(task, makePr({ state: "open" }), git)).toBe("done");
  });

  it("merged_into_base beats a started task", () => {
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, null, makeGit({ merged_into_base: true, dirty: true }))).toBe("done");
  });
});

// The one hand-set value in the table. Its precedence is the whole question:
// it sits directly below Done and above every live signal, so most of what is
// worth pinning is which of the two wins where they disagree.
describe("taskPhase: parked", () => {
  const PARKED = "2026-03-01T10:00:00.000Z";

  it("a parked task reads parked", () => {
    const task = makeTask({ started_at: STARTED, parked_at: PARKED });
    expect(taskPhase(task, null, null)).toBe("parked");
  });

  it("parked with a reason is still just parked: the reason is not a phase", () => {
    // Blocked lives here rather than in the table, on purpose.
    const task = makeTask({
      started_at: STARTED,
      parked_at: PARKED,
      park_reason: "waiting on the API key",
    });
    expect(taskPhase(task, null, null)).toBe("parked");
  });

  it("parked beats an open PR", () => {
    // The most recent statement a person made about the work wins over a live
    // signal saying it is ready to look at. The PR chip on the row still says
    // the PR is open, so nothing is lost by this.
    const task = makeTask({ started_at: STARTED, parked_at: PARKED });
    expect(taskPhase(task, makePr({ state: "open" }), null)).toBe("parked");
  });

  it("parked beats a clean pushed branch, which would otherwise be in_review", () => {
    const task = makeTask({ started_at: STARTED, parked_at: PARKED });
    expect(taskPhase(task, null, HANDED_OFF)).toBe("parked");
  });

  it("parked beats a draft PR, a closed PR and started_at", () => {
    const task = makeTask({ started_at: STARTED, parked_at: PARKED });
    expect(taskPhase(task, makePr({ state: "draft" }), null)).toBe("parked");
    expect(taskPhase(task, makePr({ state: "closed" }), null)).toBe("parked");
    expect(taskPhase(makeTask({ parked_at: PARKED }), null, null)).toBe("parked");
  });

  it("a parked task whose PR merged is done, not parked", () => {
    // Finished beats put-down: the branch landed, whatever the user meant when
    // they set it down, and Parked would hide it.
    const task = makeTask({ started_at: STARTED, parked_at: PARKED });
    expect(taskPhase(task, makePr({ state: "merged" }), null)).toBe("done");
  });

  it("a parked task whose branch reached the base is done, not parked", () => {
    const task = makeTask({ started_at: STARTED, parked_at: PARKED });
    expect(taskPhase(task, null, makeGit({ merged_into_base: true }))).toBe("done");
  });

  it("an archived parked task is done, not parked", () => {
    const task = makeTask({ archived: true, started_at: STARTED, parked_at: PARKED });
    expect(taskPhase(task, null, null)).toBe("done");
  });

  it("a null parked_at is not parked, the way serde writes an empty one", () => {
    const task = makeTask({ started_at: STARTED, parked_at: null });
    expect(taskPhase(task, null, null)).toBe("in_progress");
  });

  it("a park_reason with no parked_at does not park anything", () => {
    // Nothing writes this pair (the store clears them together), so this only
    // pins that `parked_at` is the signal and the reason is decoration.
    const task = makeTask({ started_at: STARTED, park_reason: "stale leftover" });
    expect(taskPhase(task, null, null)).toBe("in_progress");
  });
});

// Planned is RENDERED from a goal plus no `started_at`, never derived into a
// phase of its own: a fifth value would store what `started_at` already
// answers. So the goal has to be inert here, in every combination.
describe("taskPhase: a goal is text, not a state", () => {
  it("a goal with no started_at is todo", () => {
    const task = makeTask({ goal: "Ship the importer" });
    expect(taskPhase(task, null, null)).toBe("todo");
  });

  it("a goal does not move a started task off in_progress", () => {
    const task = makeTask({ goal: "Ship the importer", started_at: STARTED });
    expect(taskPhase(task, null, null)).toBe("in_progress");
  });

  it("a goal does not move a parked task, an in_review one or a done one", () => {
    const goal = "Ship the importer";
    expect(taskPhase(makeTask({ goal, parked_at: "2026-03-01T10:00:00.000Z" }), null, null))
      .toBe("parked");
    expect(taskPhase(makeTask({ goal }), makePr({ state: "open" }), null)).toBe("in_review");
    expect(taskPhase(makeTask({ goal, archived: true }), null, null)).toBe("done");
  });

  it("an empty goal is the same as none", () => {
    expect(taskPhase(makeTask({ goal: "" }), null, null)).toBe("todo");
    expect(taskPhase(makeTask({ goal: null }), null, null)).toBe("todo");
  });
});

describe("taskPhase: unknown inputs fall through rather than forcing a phase", () => {
  it("pr undefined behaves exactly like pr null", () => {
    // A failed PrLookup (cli-missing, no-remote, error, ...) resolves to a
    // null/undefined pr, and both must fall through.
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, undefined, null)).toBe(taskPhase(task, null, null));
    expect(taskPhase(task, undefined, null)).toBe("in_progress");
  });

  it("git undefined behaves exactly like git null", () => {
    // undefined = nothing polled it yet; null = the lookup rejected and the
    // store recorded the failure. Neither is information about the branch.
    const task = makeTask({ started_at: STARTED });
    expect(taskPhase(task, null, undefined)).toBe(taskPhase(task, null, null));
  });
});

describe("phaseCounts", () => {
  it("tallies a mixed list across all five phases", () => {
    const tasks: Task[] = [
      makeTask({ id: "a", archived: true }),
      makeTask({ id: "b", started_at: STARTED }),
      makeTask({ id: "c" }),
      makeTask({ id: "d", started_at: STARTED }),
      makeTask({ id: "e", started_at: STARTED }),
      makeTask({ id: "f", started_at: STARTED, parked_at: "2026-03-01T10:00:00.000Z" }),
    ];
    const prById: Record<string, PrStatus | null> = {
      a: null,
      b: makePr({ state: "open" }),
      c: null,
      d: makePr({ state: "merged" }),
      e: null,
      // Parked with an open PR, so this also pins that the tally follows the
      // same precedence the single-task function does.
      f: makePr({ state: "open" }),
    };
    const gitById: Record<string, TaskGitState | null> = {
      a: null,
      b: null,
      c: null,
      d: null,
      // No PR, but committed, clean and pushed: the git-derived In review.
      e: HANDED_OFF,
      f: null,
    };
    const counts = phaseCounts(tasks, id => prById[id] ?? null, id => gitById[id] ?? null);
    expect(counts).toEqual({
      todo: 1,
      in_progress: 0,
      in_review: 2,
      parked: 1,
      done: 2,
    });
  });

  it("counts a task whose git lookup never ran the same as one whose failed", () => {
    const tasks: Task[] = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    const counts = phaseCounts(
      tasks,
      () => null,
      id => (id === "a" ? undefined : null),
    );
    expect(counts.todo).toBe(2);
  });

  it("returns every phase key at zero on an empty list, parked included", () => {
    // The caller indexes this map by phase without guarding, so a missing key
    // is a rendered `undefined` rather than a 0.
    expect(phaseCounts([], () => null, () => null)).toEqual({
      todo: 0, in_progress: 0, in_review: 0, parked: 0, done: 0,
    });
  });
});

describe("PHASE_ORDER / PHASE_LABEL", () => {
  it("carries exactly the five phases, each with a label", () => {
    expect(PHASE_ORDER).toHaveLength(5);
    for (const phase of PHASE_ORDER) {
      expect(PHASE_LABEL[phase]).toBeTruthy();
    }
  });

  it("reads in lifecycle order with parked LAST, after done", () => {
    // Not the precedence order (where Parked sits directly below Done). The
    // first four are a task's life in sequence and Parked is a task stepping
    // out of that line, so it goes at the end rather than in the middle of a
    // row people read left to right.
    expect([...PHASE_ORDER]).toEqual(["todo", "in_progress", "in_review", "done", "parked"]);
  });
});

describe("PHASE_EMPTY_LABEL", () => {
  it("covers every phase", () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_EMPTY_LABEL[phase]).toBeTruthy();
    }
  });

  it("reads as a sentence for todo, which is why the map is explicit", () => {
    // The one entry that is NOT `"Nothing " + label.toLowerCase()`. If this
    // ever gets refactored into a template, this is the case that breaks
    // (it would produce "Nothing todo").
    expect(PHASE_EMPTY_LABEL.todo).toBe("Nothing to do");
    expect(PHASE_EMPTY_LABEL.in_progress).toBe("Nothing in progress");
    expect(PHASE_EMPTY_LABEL.in_review).toBe("Nothing in review");
    expect(PHASE_EMPTY_LABEL.parked).toBe("Nothing parked");
    expect(PHASE_EMPTY_LABEL.done).toBe("Nothing done");
  });

  it("uses no em dash, like every other user-visible string", () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_EMPTY_LABEL[phase]).not.toContain("—");
      expect(PHASE_LABEL[phase]).not.toContain("—");
    }
  });
});

describe("taskAgeLabel", () => {
  const NOW = new Date("2026-09-16T12:00:00.000Z").getTime();

  function isoMinutesAgo(minutes: number): string {
    return new Date(NOW - minutes * 60_000).toISOString();
  }

  function isoDaysAgo(days: number): string {
    return new Date(NOW - days * 86_400_000).toISOString();
  }

  it("undefined has no age", () => {
    expect(taskAgeLabel(undefined, NOW)).toBeNull();
  });

  it("null has no age", () => {
    expect(taskAgeLabel(null, NOW)).toBeNull();
  });

  it("an unparseable string has no age", () => {
    expect(taskAgeLabel("not-a-timestamp", NOW)).toBeNull();
  });

  it("5 minutes ago is suppressed as noise", () => {
    expect(taskAgeLabel(isoMinutesAgo(5), NOW)).toBeNull();
  });

  it("23 hours ago is still suppressed", () => {
    expect(taskAgeLabel(isoMinutesAgo(23 * 60), NOW)).toBeNull();
  });

  it("25 hours ago reads Yesterday", () => {
    expect(taskAgeLabel(isoMinutesAgo(25 * 60), NOW)).toBe("Yesterday");
  });

  it("3 days ago reads N days ago", () => {
    expect(taskAgeLabel(isoDaysAgo(3), NOW)).toBe("3 days ago");
  });

  it("22 days ago reads 3 weeks ago", () => {
    expect(taskAgeLabel(isoDaysAgo(22), NOW)).toBe("3 weeks ago");
  });

  it("40 days ago falls back to relativeDayLabel's month + year, not a hardcoded string", () => {
    const iso = isoDaysAgo(40);
    expect(taskAgeLabel(iso, NOW)).toBe(relativeDayLabel(iso, NOW));
  });
});
