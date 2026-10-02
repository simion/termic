import { describe, it, expect, beforeEach } from "vitest";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { watchedBadgedTab } from "@/hooks/useSeenWhenWatched";
import type { Task, Tab } from "@/lib/types";

const task = (id: string): Task => ({
  id, project_id: "p", name: id, path: `/tmp/${id}`, branch: "main",
  cli: "claude", created_at: "", archived: false,
} as unknown as Task);

const tab = (id: string, unread: Tab["unread"]): Tab => ({
  id, type: "terminal", cli: "claude", title: id, unread,
} as unknown as Tab);

describe("watchedBadgedTab", () => {
  beforeEach(() => {
    useUI.setState({ windowless: false } as never);
    useApp.setState({
      tasks: [task("t1"), task("t2")],
      activeTaskId: "t1",
      tabs: { t1: [tab("a", { reason: "bell" })], t2: [tab("b", { reason: "done" })] },
      activeTab: { t1: "a", t2: "b" },
      splitTree: {}, activePaneId: {},
    } as never);
  });

  it("names the badged tab the user is actually looking at", () => {
    expect(watchedBadgedTab(useApp.getState())).toBe("t1:a");
  });

  it("ignores a badge on a task the user is not on", () => {
    // t2's badge is the whole point of badges. Clearing it would destroy the
    // signal instead of acknowledging it.
    useApp.setState({ activeTaskId: "t2" } as never);
    expect(watchedBadgedTab(useApp.getState())).toBe("t2:b");
    useApp.setState({ activeTaskId: "t1" } as never);
    expect(watchedBadgedTab(useApp.getState())).toBe("t1:a");
  });

  it("names a tab whose only badge is the blue DONE dot", () => {
    // The reported bug. The two badges read different fields: the bell is
    // `unread.reason`, the dot is `workState === "done"`. A target keyed on
    // `unread` alone missed a tab holding just the dot, and the dwell cleared
    // the bell while the dot stayed until the user clicked the sidebar item.
    useApp.setState({
      tabs: { ...useApp.getState().tabs,
        t1: [{ id: "a", type: "terminal", cli: "claude", title: "a", unread: null, workState: "done" }] },
    } as never);
    expect(watchedBadgedTab(useApp.getState())).toBe("t1:a");
  });

  it("names nothing when the visible tab has neither badge", () => {
    useApp.setState({
      tabs: { ...useApp.getState().tabs,
        t1: [{ id: "a", type: "terminal", cli: "claude", title: "a", unread: null, workState: "idle" }] },
    } as never);
    expect(watchedBadgedTab(useApp.getState())).toBe("");
  });

  it("is PURE in the app store, so presence is the hook's to apply", () => {
    // Deliberately still names the tab while windowless. Folding presence in
    // here would be worse than redundant: a `useApp` selector does not re-run
    // when `useUI` changes, so a target that baked in focus would stay stale
    // at "" after the user came back and the badge would never clear.
    useUI.setState({ windowless: true, windowFocused: false } as never);
    expect(watchedBadgedTab(useApp.getState())).toBe("t1:a");
  });

  it("does not name a tab whose only mark is an attention bell", () => {
    // Seeing a question is not answering it, so sight never clears the bell,
    // and a target parked on that tab would only hide the next clearable
    // mark behind it.
    useApp.setState({
      tabs: { ...useApp.getState().tabs, t1: [tab("a", { reason: "attention" } as Tab["unread"])] },
    } as never);
    expect(watchedBadgedTab(useApp.getState())).toBe("");
  });

  it("still names a bell's tab once it ALSO holds the done dot, to clear the dot", () => {
    useApp.setState({
      tabs: { ...useApp.getState().tabs,
        t1: [{ id: "a", type: "terminal", cli: "claude", title: "a", unread: { reason: "attention" }, workState: "done" }] },
    } as never);
    expect(watchedBadgedTab(useApp.getState())).toBe("t1:a");
  });

  it("names nothing when no task is active", () => {
    useApp.setState({ activeTaskId: null } as never);
    expect(watchedBadgedTab(useApp.getState())).toBe("");
  });

  it("returns a primitive, so the selector cannot churn subscribers", () => {
    // A fresh object here would re-run every store subscriber on every write.
    // See src/store/selectorFanout.test.ts for why that is a gating concern.
    expect(typeof watchedBadgedTab(useApp.getState())).toBe("string");
  });
});
