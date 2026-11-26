import { describe, expect, it } from "vitest";
import { sameList, waitingTasks } from "./attentionPanel";

describe("the needs-you panel's list", () => {
  const term = (extra: Record<string, unknown> = {}) => ({ type: "terminal", id: "x", ...extra });
  const tasks = [
    { id: "a", name: "fix-login", project_id: "p1" },
    { id: "b", name: "busy", project_id: "p1" },
    { id: "c", name: "gone", project_id: "p2", archived: true },
    { id: "d", name: "asking-mid-turn", project_id: "p2" },
  ];
  const tabs = {
    a: [term({ unread: { reason: "attention" } })],
    b: [term({ workState: "working" })],
    c: [term({ unread: { reason: "attention" } })],
    // Asking mid-turn is still waiting on the user (attention outranks working).
    d: [term({ workState: "working", unread: { reason: "attention" } })],
  };
  const name = (id: string) => ({ p1: "web", p2: "api" })[id] ?? "";

  it("lists the tasks waiting on the user, never an archived one", () => {
    expect(waitingTasks(tasks, tabs, name)).toEqual([
      { taskId: "a", name: "fix-login", project: "web" },
      { taskId: "d", name: "asking-mid-turn", project: "api" },
    ]);
  });

  it("only tells the panel when the list really changed", () => {
    const l = waitingTasks(tasks, tabs, name);
    expect(sameList(l, waitingTasks(tasks, tabs, name))).toBe(true);
    expect(sameList(l, l.slice(0, 1))).toBe(false);
  });
});
