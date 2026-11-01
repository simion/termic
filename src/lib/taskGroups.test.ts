import { describe, expect, it } from "vitest";
import { crossProjectStrays, flattenSegments, groupBadgeKinds, groupColorCss, groupLabel, groupMemberByName, layoutTaskList, liveGroups, nextGroupColor, sidebarTaskOrder, GROUP_FALLBACK_COLOR } from "./taskGroups";
import type { Tab } from "./types";
import type { Project, Task, TaskGroup } from "./types";

const t = (id: string, group?: TaskGroup, extra: Partial<Task> = {}): Task =>
  ({ id, name: id, project_id: "p", archived: false, group, ...extra }) as Task;
const G = (id: string, extra: Partial<TaskGroup> = {}): TaskGroup => ({ id, ...extra });
const ids = (segs: ReturnType<typeof layoutTaskList>) =>
  segs.map(s => (s.kind === "task" ? s.task.id : `[${s.tasks.map(m => m.id).join(",")}]`));

describe("liveGroups", () => {
  it("lists each live group once, lead's copy first, archived-only groups gone", () => {
    const gs = liveGroups([
      t("c1", G("o", { color: "red" })),
      t("o", G("o", { color: "teal" })),
      t("solo", G("solo")),
      t("b", G("gone"), { archived: true }),
      t("x"),
    ]);
    expect(gs).toEqual([G("o", { color: "teal" }), G("solo")]);
  });
});

describe("groupMemberByName", () => {
  // The reported case: an MCP client created two tasks and named each one's
  // group "Release prep". The second call has to find the first's group.
  it("finds the group a second task should join, through its lead", () => {
    const tasks = [
      t("a", G("a", { name: "Release prep", color: "blue" })),
      t("a2", G("a", { name: "Release prep", color: "blue" })),
      t("b"),
    ];
    expect(groupMemberByName(tasks, "p", "Release prep", "b")?.id).toBe("a");
    // Trimmed and case-insensitive: it is a label typed by an agent.
    expect(groupMemberByName(tasks, "p", "  release PREP ", "b")?.id).toBe("a");
  });

  it("matches a group that only follows its lead's name", () => {
    const tasks = [t("orchestrator", G("orchestrator")), t("child", G("orchestrator")), t("new")];
    expect(groupMemberByName(tasks, "p", "orchestrator", "new")?.id).toBe("orchestrator");
  });

  it("joins through any live member when the lead is archived", () => {
    const tasks = [
      t("lead", G("lead", { name: "Batch" }), { archived: true }),
      t("m", G("lead", { name: "Batch" })),
      t("new"),
    ];
    expect(groupMemberByName(tasks, "p", "Batch", "new")?.id).toBe("m");
  });

  it("stays inside the project, and ignores archived groups and the task itself", () => {
    const tasks = [
      t("other", G("other", { name: "Batch" }), { project_id: "q" }),
      t("old", G("old", { name: "Batch" }), { archived: true }),
      t("me", G("me", { name: "Batch" })),
    ];
    expect(groupMemberByName(tasks, "p", "Batch", "me")).toBeUndefined();
    expect(groupMemberByName(tasks, "p", "Batch")?.id).toBe("me");
    expect(groupMemberByName(tasks, "p", "   ")).toBeUndefined();
  });
});

describe("crossProjectStrays", () => {
  it("drops a group's lone member in a project when the group spans projects", () => {
    const q = { project_id: "q" };
    const strays = crossProjectStrays([
      // The reported case: lead in one project, its one child in another.
      t("lead", G("lead")), t("child", G("lead"), q),
      // Two here and one there: the pair is still a group, the one is not.
      t("a1", G("a")), t("a2", G("a")), t("a3", G("a"), q),
      // A group of one in ONE project is a real group (Move to group > New).
      t("solo", G("solo")),
      // An archived member does not make a group span.
      t("b1", G("b")), t("b2", G("b"), { ...q, archived: true }),
    ]);
    expect([...strays].sort()).toEqual(["a3", "child", "lead"]);
  });
});

describe("layoutTaskList", () => {
  it("gathers a group at its first member and leaves the rest in store order", () => {
    const list = [t("x"), t("o", G("o")), t("y"), t("c1", G("o")), t("z"), t("c2", G("o"))];
    expect(ids(layoutTaskList(list))).toEqual(["x", "[o,c1,c2]", "y", "z"]);
  });

  it("draws a group of one as a group, like a project folder of one", () => {
    const list = [t("o", G("o")), t("y")];
    expect(ids(layoutTaskList(list))).toEqual(["[o]", "y"]);
  });

  it("lets the dragged row wear the hovered group before anything is saved", () => {
    const list = [t("o", G("o", { color: "teal" })), t("c1", G("o", { color: "teal" })), t("d")];
    const hovered = G("o", { color: "teal" });
    const groupFor = (x: Task) => (x.id === "d" ? hovered : x.group ?? null);
    expect(ids(layoutTaskList(list, groupFor))).toEqual(["[o,c1,d]"]);
    // And dragging a member OUT drops it from the block.
    const out = (x: Task) => (x.id === "c1" ? null : x.group ?? null);
    expect(ids(layoutTaskList(list, out))).toEqual(["[o]", "c1", "d"]);
  });

  it("takes the block's name and colour from the lead", () => {
    const list = [t("c1", G("o", { color: "red" })), t("o", G("o", { color: "teal", name: "Auth" }))];
    const seg = layoutTaskList(list)[0];
    expect(seg.kind === "group" && seg.group).toEqual(G("o", { color: "teal", name: "Auth" }));
  });

  it("flattens to display order for the reorder write", () => {
    const list = [t("o", G("o")), t("y"), t("c1", G("o"))];
    expect(flattenSegments(layoutTaskList(list)).map(x => x.id)).toEqual(["o", "c1", "y"]);
  });
});

describe("sidebarTaskOrder", () => {
  const P = (id: string, group?: string): Project => ({ id, name: id, group }) as Project;

  // The reported case. `a` was open, its agent ran `termic new` and created
  // `d`. Rust sorts `d` last (newest, never dragged), and the spawn put it in
  // `a`'s group, so the sidebar draws it straight under `a`. ⌥⌘↓ from `a`
  // went to `b`, and `d` came last, after `c`.
  it("walks a task an agent created right after its creator, as the sidebar draws it", () => {
    const tasks = [t("a", G("a")), t("b"), t("c"), t("d", G("a"))];
    expect(sidebarTaskOrder([P("p")], tasks).map(x => x.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("is store order while a project has no group", () => {
    const tasks = [t("a"), t("b"), t("c")];
    expect(sidebarTaskOrder([P("p")], tasks).map(x => x.id)).toEqual(["a", "b", "c"]);
  });

  it("goes project by project in folder order, and leaves archived tasks out", () => {
    // Store order x, y, z, with x and z in one folder: drawn x, z, y.
    const projects = [P("x", "WORK"), P("y"), P("z", "WORK")];
    const tasks = [
      t("y1", undefined, { project_id: "y" }),
      t("z1", undefined, { project_id: "z" }),
      t("x1", G("x1"), { project_id: "x" }),
      t("x2", undefined, { project_id: "x" }),
      t("gone", G("x1"), { project_id: "x", archived: true }),
      t("x3", G("x1"), { project_id: "x" }),
    ];
    expect(sidebarTaskOrder(projects, tasks).map(x => x.id)).toEqual(["x1", "x3", "x2", "z1", "y1"]);
  });
});

describe("groupLabel", () => {
  it("prefers the group's own name, then follows the lead's live name", () => {
    const tasks = [t("o", G("o"), { name: "refactor-auth" })];
    expect(groupLabel(G("o"), tasks)).toBe("refactor-auth");
    expect(groupLabel(G("o", { name: "  Auth " }), tasks)).toBe("Auth");
    expect(groupLabel(G("o", { name: "  " }), tasks)).toBe("refactor-auth");
    expect(groupLabel(G("gone"), tasks)).toBe("Task group");
  });
});

describe("nextGroupColor", () => {
  it("picks the first accent no live group wears", () => {
    // Calm hues first: red on a fresh group would read as an error.
    expect(nextGroupColor([])).toBe("blue");
    expect(nextGroupColor([t("a", G("a", { color: "blue" })), t("b", G("b", { color: "purple" }))])).toBe("teal");
    // An archived member's colour is free again.
    expect(nextGroupColor([t("a", G("a", { color: "blue" }), { archived: true })])).toBe("blue");
    // Every founding colour is a real palette key.
    const seen = new Set<string>();
    const tasks: Task[] = [];
    for (let i = 0; i < 8; i++) {
      const c = nextGroupColor(tasks);
      seen.add(c);
      tasks.push(t(`g${i}`, G(`g${i}`, { color: c })));
    }
    expect(seen.size).toBe(8);
  });
});

describe("groupColorCss", () => {
  it("resolves an accent key and falls back for none or an unknown one", () => {
    expect(groupColorCss(G("o", { color: "teal" }))).toBe("var(--color-palette-teal)");
    expect(groupColorCss(G("o"))).toBe(GROUP_FALLBACK_COLOR);
    expect(groupColorCss(G("o", { color: "nope" }))).toBe(GROUP_FALLBACK_COLOR);
  });
});

describe("groupBadgeKinds", () => {
  const term = (patch: Record<string, unknown>) => ({ id: "x", type: "terminal", title: "", cli: "claude", ...patch }) as unknown as Tab;
  const ALL = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };
  const needs = [term({ unread: { reason: "attention" } })];
  const done = [term({ workState: "done" })];
  const working = [term({ workState: "working" })];
  const partial = [term({ workState: "done", delegatedWork: { label: "subagent", count: 2, ids: ["a", "b"], partial: true } })];
  const idle = [term({})];

  it("shows one of each mark present, in a fixed order", () => {
    expect(groupBadgeKinds([done, idle, needs, working, done], ALL, true)).toEqual(["attention", "done", "working"]);
  });

  it("uses each member's own row rule, so a member contributes only its top mark", () => {
    // Attention outranks done on ONE task: the group does not claim a done.
    const both = [term({ unread: { reason: "attention" }, workState: "done" })];
    expect(groupBadgeKinds([both], ALL, true)).toEqual(["attention"]);
  });

  it("draws partial where the row would, and falls back when that pref is off", () => {
    expect(groupBadgeKinds([partial], ALL, true)).toEqual(["partial"]);
    expect(groupBadgeKinds([partial], ALL, false)).toEqual(["done"]);
  });

  it("honours the prefs the rows honour", () => {
    expect(groupBadgeKinds([working, done], { settledHighlight: false, workingIndicator: false }, true)).toEqual([]);
  });

  it("is empty for a quiet group", () => {
    expect(groupBadgeKinds([idle, idle], ALL, true)).toEqual([]);
  });
});

describe("groupBadgeKinds with a hand-marked tab", () => {
  it("rolls the marked dot up between done and working", () => {
    const ON = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };
    const marked = [{ id: "m", type: "terminal", markedUnread: true }] as never;
    const done = [{ id: "d", type: "terminal", workState: "done" }] as never;
    const working = [{ id: "w", type: "terminal", workState: "working" }] as never;
    expect(groupBadgeKinds([working, marked, done], ON, true)).toEqual(["done", "marked", "working"]);
  });
});
