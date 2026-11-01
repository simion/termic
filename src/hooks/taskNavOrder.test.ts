// @vitest-environment happy-dom
//
// The task-switching keys walk the rows the sidebar DRAWS, not the store's
// order. They differ once a project has a task group: a task an agent creates
// with `termic new` (or MCP `task_new`) joins its creator's group and draws
// right under it, while Rust sorts it to the bottom of the project as the
// newest task. ⌥⌘↓ from the creator used to skip the new task and reach it
// last. Driven through the real keydown handler against the real store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  windowCloseIfNotLast: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { makeTask, makeTerminalTab, resetAppStore, seedTab } from "@/test-utils/store";
import { jumpToNextWaiting } from "@/lib/waitingAgents";
import type { Project, TaskGroup } from "@/lib/types";
import { useShortcuts } from "./useShortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  useShortcuts();
  return null;
}

// ⌥⌘↑/↓ (task-prev/next-arrow) and ⌥↑/↓ (sidebar-prev/next), the defaults.
const press = (key: "ArrowUp" | "ArrowDown", mods: { cmd?: boolean } = {}) =>
  act(() => {
    const e = new KeyboardEvent("keydown", {
      key, code: key, metaKey: !!mods.cmd, ctrlKey: !!mods.cmd, altKey: true,
      bubbles: true, cancelable: true,
    });
    // happy-dom answers getModifierState("AltGraph") with altKey, which would
    // read every Alt press as AltGr. A real Alt is not AltGr.
    Object.defineProperty(e, "getModifierState", { value: () => false });
    window.dispatchEvent(e);
  });
const active = () => useApp.getState().activeTaskId;

const G: TaskGroup = { id: "a" };
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  resetAppStore();
  usePrefs.setState({ shortcuts: usePrefs.getInitialState().shortcuts, settledHighlight: true });
  // Store order as Rust hands it over: `d` is the newest, so it sorts last,
  // but `a`'s agent created it, so it sits in `a`'s group.
  useApp.setState({
    projects: [{ id: "p", name: "p" } as Project],
    tasks: [
      makeTask({ id: "a", project_id: "p", group: G }),
      makeTask({ id: "b", project_id: "p" }),
      makeTask({ id: "c", project_id: "p" }),
      makeTask({ id: "d", project_id: "p", group: G }),
    ],
    splitTree: {}, activePaneId: {}, paneHistory: {},
  });
  for (const id of ["a", "b", "c", "d"]) seedTab(id, makeTerminalTab({ id: `${id}-t` }));
  useApp.getState().setActiveTask("a");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("task switching follows the sidebar's rows", () => {
  it("⌥⌘↓ goes from a task to the one its agent created, then on down the sidebar", () => {
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) { press("ArrowDown", { cmd: true }); seen.push(active()); }
    expect(seen).toEqual(["d", "b", "c", "a"]);
  });

  it("⌥⌘↑ walks the same rows the other way", () => {
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) { press("ArrowUp", { cmd: true }); seen.push(active()); }
    expect(seen).toEqual(["c", "b", "d", "a"]);
  });

  it("⌥↓ walks the sidebar rows in the same order", () => {
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) { press("ArrowDown"); seen.push(active()); }
    expect(seen).toEqual(["d", "b", "c", "a"]);
  });

  it("⇧⌘A lands on the next waiting task on screen, not in the store", () => {
    for (const id of ["b", "d"]) seedTab(id, makeTerminalTab({ id: `${id}-done`, workState: "done" }));
    expect(jumpToNextWaiting()).toBe(true);
    expect(active()).toBe("d");
    expect(jumpToNextWaiting()).toBe(true);
    expect(active()).toBe("b");
  });

  it("is plain store order once the group is gone", () => {
    useApp.setState(s => ({ tasks: s.tasks.map(t => ({ ...t, group: undefined })) }));
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) { press("ArrowDown", { cmd: true }); seen.push(active()); }
    expect(seen).toEqual(["b", "c", "d", "a"]);
  });
});
