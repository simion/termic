// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));

import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { DEFAULT_BINDINGS, SHORTCUT_DEFS } from "@/lib/shortcuts";
import { shortcutLabel } from "@/lib/shortcutCopy";
import { i18n } from "@/lib/i18n";
import { fuzzyMatch } from "@/lib/fuzzy";
import { resolveStatusQualifier, STATUS_QUALIFIER_RE } from "./TaskFinderDialog";
import type { Task, Project } from "@/lib/types";

describe("TaskFinder shortcut and state", () => {
  beforeEach(() => {
    useUI.setState({ taskFinderOpen: false });
  });

  it("has a task-finder shortcut registered with Cmd+O / Ctrl+O", () => {
    const def = SHORTCUT_DEFS.find(d => d.id === "task-finder");
    expect(def).toBeDefined();
    // The row's name is a locale entry (lib/shortcutCopy.ts): this reads the
    // one the Settings page and the ⌘/ sheet draw, not a copy kept beside the
    // binding.
    expect(shortcutLabel("task-finder", i18n.getFixedT("en"))).toBe("Open task finder");
    expect(def?.group).toBe("General");
    expect(def?.defaultBinding.key).toBe("o");
    expect(def?.defaultBinding.cmd).toBe(true);
    expect(DEFAULT_BINDINGS["task-finder"]).toEqual({
      key: "o",
      cmd: true,
      shift: false,
      alt: false,
    });
  });

  it("toggles taskFinderOpen in UI store", () => {
    expect(useUI.getState().taskFinderOpen).toBe(false);
    useUI.getState().openTaskFinder();
    expect(useUI.getState().taskFinderOpen).toBe(true);
    useUI.getState().closeTaskFinder();
    expect(useUI.getState().taskFinderOpen).toBe(false);
  });
});

describe("task matching logic for TaskFinder", () => {
  const p1: Project = { id: "p1", name: "termic", root_path: "/code/termic" } as Project;
  const p2: Project = { id: "p2", name: "api-server", root_path: "/code/api-server" } as Project;

  const t1: Task = { id: "t1", project_id: "p1", name: "auth-refactor", branch: "feat/auth", cli: "claude", archived: false } as Task;
  const t2: Task = { id: "t2", project_id: "p1", name: "fix-layout", branch: "fix/layout", cli: "codex", archived: false } as Task;
  const t3: Task = { id: "t3", project_id: "p2", name: "database-migration", branch: "db-mig", cli: "gemini", archived: false } as Task;

  it("fuzzy-matches by task name", () => {
    expect(fuzzyMatch(t1.name, "auth")).toBeTruthy();
    expect(fuzzyMatch(t2.name, "layout")).toBeTruthy();
    expect(fuzzyMatch(t3.name, "layout")).toBeNull();
  });

  it("fuzzy-matches by branch name", () => {
    expect(fuzzyMatch(t1.branch, "feat/auth")).toBeTruthy();
    expect(fuzzyMatch(t3.branch, "db")).toBeTruthy();
  });

  it("fuzzy-matches by project name", () => {
    expect(fuzzyMatch(p1.name, "term")).toBeTruthy();
    expect(fuzzyMatch(p2.name, "api")).toBeTruthy();
  });

  it("fuzzy-matches by status label directly", () => {
    expect(fuzzyMatch("Working", "work")).toBeTruthy();
    expect(fuzzyMatch("In review", "review")).toBeTruthy();
    expect(fuzzyMatch("Needs attention", "attention")).toBeTruthy();
    expect(fuzzyMatch("Needs attention", "needs")).toBeTruthy();
    expect(fuzzyMatch("Not started", "not started")).toBeTruthy();
    expect(fuzzyMatch("Settled", "settled")).toBeTruthy();
  });

  it("matches combined project, task name, and status string", () => {
    const combined1 = `${p1.name} ${t1.name} Working`;
    const combined2 = `${p1.name} ${t2.name} In review`;
    const combined3 = `${p2.name} ${t3.name} Needs attention`;

    expect(fuzzyMatch(combined1, "termic working")).toBeTruthy();
    expect(fuzzyMatch(combined1, "auth working")).toBeTruthy();
    expect(fuzzyMatch(combined2, "termic review")).toBeTruthy();
    expect(fuzzyMatch(combined3, "api attention")).toBeTruthy();
    expect(fuzzyMatch(combined3, "api working")).toBeNull();
  });
});

describe("resolveStatusQualifier and STATUS_QUALIFIER_RE", () => {
  it("resolves English status names and aliases", () => {
    expect(resolveStatusQualifier("working")).toBe("working");
    expect(resolveStatusQualifier("work")).toBe("working");
    expect(resolveStatusQualifier("running")).toBe("working");

    expect(resolveStatusQualifier("review")).toBe("review");
    expect(resolveStatusQualifier("in review")).toBe("review");
    expect(resolveStatusQualifier("in-review")).toBe("review");
    expect(resolveStatusQualifier("in_review")).toBe("review");
    expect(resolveStatusQualifier("pr")).toBe("review");

    expect(resolveStatusQualifier("attention")).toBe("attention");
    expect(resolveStatusQualifier("needs attention")).toBe("attention");
    expect(resolveStatusQualifier("needs-attention")).toBe("attention");
    expect(resolveStatusQualifier("blocked")).toBe("attention");
    expect(resolveStatusQualifier("warn")).toBe("attention");

    expect(resolveStatusQualifier("backlog")).toBe("backlog");
    expect(resolveStatusQualifier("not started")).toBe("backlog");
    expect(resolveStatusQualifier("not-started")).toBe("backlog");
    expect(resolveStatusQualifier("todo")).toBe("backlog");

    expect(resolveStatusQualifier("settled")).toBe("settled");
    expect(resolveStatusQualifier("done")).toBe("settled");
    expect(resolveStatusQualifier("idle")).toBe("settled");

    expect(resolveStatusQualifier("unknown-status")).toBeNull();
    expect(resolveStatusQualifier("")).toBeNull();
  });

  it("resolves localized status names using translator function", () => {
    const mockTc = (key: string) => {
      switch (key) {
        case "board.colWorking": return "进行中";
        case "board.colReview": return "审查中";
        case "board.colAttention": return "需要注意";
        case "board.colBacklog": return "未开始";
        case "board.colSettled": return "已完成";
        default: return "";
      }
    };

    expect(resolveStatusQualifier("进行中", mockTc)).toBe("working");
    expect(resolveStatusQualifier("审查中", mockTc)).toBe("review");
    expect(resolveStatusQualifier("需要注意", mockTc)).toBe("attention");
    expect(resolveStatusQualifier("未开始", mockTc)).toBe("backlog");
    expect(resolveStatusQualifier("已完成", mockTc)).toBe("settled");
  });

  it("extracts qualifier prefix from queries", () => {
    const m1 = "status:working".match(STATUS_QUALIFIER_RE);
    expect(m1).toBeTruthy();
    expect(m1?.[1] || m1?.[2] || m1?.[3]).toBe("working");

    const m2 = "is:review".match(STATUS_QUALIFIER_RE);
    expect(m2).toBeTruthy();
    expect(m2?.[1] || m2?.[2] || m2?.[3]).toBe("review");

    const m3 = 'status:"in review" auth'.match(STATUS_QUALIFIER_RE);
    expect(m3).toBeTruthy();
    expect(m3?.[1] || m3?.[2] || m3?.[3]).toBe("in review");

    const m4 = "termic is:attention".match(STATUS_QUALIFIER_RE);
    expect(m4).toBeTruthy();
    expect(m4?.[1] || m4?.[2] || m4?.[3]).toBe("attention");

    const m5 = "status:not-started".match(STATUS_QUALIFIER_RE);
    expect(m5).toBeTruthy();
    expect(m5?.[1] || m5?.[2] || m5?.[3]).toBe("not-started");
  });
});
