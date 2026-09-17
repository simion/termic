import { describe, it, expect, vi } from "vitest";

// `taskNotes` reaches `isTerminalCli`, which reads the live agent registry off
// the app store, which pulls in the Tauri IPC layer. Same two mocks
// `agents.test.ts` uses, and the registry below is what a registry-terminal
// entry looks like: `kind: "terminal"` is what makes docker/ssh rows a
// terminal rather than an agent.
const mockAgents: import("@/lib/types").Agent[] = [
  { id: "claude", display_name: "Claude", command: "claude" } as import("@/lib/types").Agent,
  { id: "docker", display_name: "Docker", command: "docker", kind: "terminal" } as import("@/lib/types").Agent,
];
vi.mock("@/store/app", () => ({
  useApp: { getState: () => ({ agents: mockAgents }) },
}));
vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  projectsList: vi.fn(),
  taskList: vi.fn(),
}));

import {
  noteText, taskGoalText, parkReasonText, isParked, parkMenuLabel,
  cliCanPrompt, canStartWithGoal, deliverFirstMessage,
} from "@/lib/taskNotes";
import type { Task } from "@/lib/types";

/** A task record with only the fields these predicates read. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "w1", project_id: "p1", name: "task", branch: "feat/x", path: "/tmp/w1",
    cli: "claude", created: "2026-01-01T00:00:00Z",
    ...over,
  } as Task;
}

// ── noteText / the three readers over it ──────────────────────────────

describe("noteText", () => {
  it("collapses every shape of absent to an empty string", () => {
    expect(noteText(null)).toBe("");
    expect(noteText(undefined)).toBe("");
    expect(noteText("")).toBe("");
    // The one that matters: a box submitted with only whitespace. Rust and
    // the store both write `null` for this, so a reader that answered "   "
    // would draw a planned row for a goal that is not on disk.
    expect(noteText("   ")).toBe("");
    expect(noteText("\n\t ")).toBe("");
  });

  it("trims the edges and keeps the inside", () => {
    expect(noteText("  ship the parser  ")).toBe("ship the parser");
    // Multi-line survives: the goal box is a textarea, and Start later can
    // hand it a pasted ticket.
    expect(noteText("  line one\nline two ")).toBe("line one\nline two");
  });
});

describe("taskGoalText / parkReasonText", () => {
  it("read their own field and nothing else", () => {
    const w = task({ goal: " write the spec ", park_reason: " waiting on the API key " });
    expect(taskGoalText(w)).toBe("write the spec");
    expect(parkReasonText(w)).toBe("waiting on the API key");
  });

  it("answer empty for a record written before the fields existed", () => {
    const w = task();
    expect(taskGoalText(w)).toBe("");
    expect(parkReasonText(w)).toBe("");
  });
});

// ── Parked ────────────────────────────────────────────────────────────

describe("isParked / parkMenuLabel", () => {
  it("follows parked_at, not park_reason", () => {
    expect(isParked(task())).toBe(false);
    expect(isParked(task({ parked_at: null }))).toBe(false);
    expect(isParked(task({ parked_at: "2026-01-02T00:00:00Z" }))).toBe(true);
    // A reason with no stamp is not a park. Rust clears the two together
    // (`clear_task_park`), so this state should not exist, and if it ever
    // does the row must not read as put down.
    expect(isParked(task({ park_reason: "blocked" } as Partial<Task>))).toBe(false);
  });

  it("names the action the click will perform", () => {
    expect(parkMenuLabel(task())).toBe("Park task");
    expect(parkMenuLabel(task({ parked_at: "2026-01-02T00:00:00Z" }))).toBe("Unpark task");
  });
});

// ── Which cli can be handed a goal ────────────────────────────────────

describe("cliCanPrompt", () => {
  it("is true for an agent and false for every kind of terminal", () => {
    expect(cliCanPrompt("claude")).toBe(true);
    expect(cliCanPrompt("shell")).toBe(false);
    // A custom-command task is a terminal as far as `isTerminalCli` is
    // concerned: there is no agent prompt behind it.
    expect(cliCanPrompt("custom")).toBe(false);
    // A registry entry marked `kind: "terminal"` (docker, ssh).
    expect(cliCanPrompt("docker")).toBe(false);
  });

  it("takes an explicit registry when the caller already has one", () => {
    expect(cliCanPrompt("docker", [])).toBe(true);
    expect(cliCanPrompt("docker", mockAgents)).toBe(false);
  });
});

// ── "Start with goal" ─────────────────────────────────────────────────

describe("canStartWithGoal", () => {
  it("shows for a goal nobody has started", () => {
    expect(canStartWithGoal(task({ goal: "write the spec" }))).toBe(true);
  });

  it("hides with no goal at all", () => {
    expect(canStartWithGoal(task())).toBe(false);
    expect(canStartWithGoal(task({ goal: null }))).toBe(false);
    // Whitespace is not a goal, the same answer the store and Rust give.
    expect(canStartWithGoal(task({ goal: "   " }))).toBe(false);
  });

  it("hides once the task has started, goal or not", () => {
    // The goal SURVIVES starting (it is the record of what the task is for),
    // so `started_at` is what has to take the row away, not clearing the goal.
    expect(canStartWithGoal(task({ goal: "write the spec", started_at: "2026-01-02T00:00:00Z" })))
      .toBe(false);
  });

  it("hides for an agent with no prompt box", () => {
    // Delivering a goal here would type prose into a shell and press Return.
    expect(canStartWithGoal(task({ goal: "write the spec", cli: "shell" }))).toBe(false);
    expect(canStartWithGoal(task({ goal: "write the spec", cli: "custom" }))).toBe(false);
    expect(canStartWithGoal(task({ goal: "write the spec", cli: "docker" }))).toBe(false);
  });
});

// ── The Start later branch ────────────────────────────────────────────

describe("deliverFirstMessage", () => {
  function sinks() {
    return { seed: vi.fn(), setGoal: vi.fn() };
  }

  it("unchecked sends the prompt and writes no goal", () => {
    const s = sinks();
    const out = deliverFirstMessage("w1", { prompt: "fix the parser", canPrompt: true, startLater: false }, s);
    expect(out).toBe("seeded");
    expect(s.seed).toHaveBeenCalledWith("w1", "fix the parser");
    expect(s.setGoal).not.toHaveBeenCalled();
  });

  it("checked writes the goal and sends nothing", () => {
    const s = sinks();
    const out = deliverFirstMessage("w1", { prompt: "fix the parser", canPrompt: true, startLater: true }, s);
    expect(out).toBe("goal");
    expect(s.setGoal).toHaveBeenCalledWith("w1", "fix the parser");
    // The whole point: nothing reaches the agent, so nothing stamps
    // `started_at` and the task stays Todo.
    expect(s.seed).not.toHaveBeenCalled();
  });

  it("trims the text on both branches", () => {
    const a = sinks();
    deliverFirstMessage("w1", { prompt: "  fix the parser \n", canPrompt: true, startLater: false }, a);
    expect(a.seed).toHaveBeenCalledWith("w1", "fix the parser");
    const b = sinks();
    deliverFirstMessage("w1", { prompt: "  fix the parser \n", canPrompt: true, startLater: true }, b);
    expect(b.setGoal).toHaveBeenCalledWith("w1", "fix the parser");
  });

  it("does nothing for a blank or whitespace box, checked or not", () => {
    for (const startLater of [false, true]) {
      for (const prompt of ["", "   ", "\n\t"]) {
        const s = sinks();
        const out = deliverFirstMessage("w1", { prompt, canPrompt: true, startLater }, s);
        expect(out).toBe("none");
        expect(s.seed).not.toHaveBeenCalled();
        expect(s.setGoal).not.toHaveBeenCalled();
      }
    }
  });

  it("does nothing when the agent has no prompt box", () => {
    // The field and the checkbox are both hidden under this condition, so any
    // text here is stale state from before the cli was switched. It must not
    // ride along as a goal either.
    for (const startLater of [false, true]) {
      const s = sinks();
      const out = deliverFirstMessage("w1", { prompt: "fix the parser", canPrompt: false, startLater }, s);
      expect(out).toBe("none");
      expect(s.seed).not.toHaveBeenCalled();
      expect(s.setGoal).not.toHaveBeenCalled();
    }
  });
});
