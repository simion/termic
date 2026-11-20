// @vitest-environment happy-dom
//
// A failed accounts read must not hide the usage chip for good: it keeps the
// last view and re-reads on a back-off. It used to null the view and wait for
// an unrelated accounts event that might never come.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/ipc", () => ({ agentAccounts: vi.fn(), taskAccount: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import * as ipc from "@/lib/ipc";
import { useAgentAccounts, RETRY_MS, type AgentAccounts } from "./useAgentAccounts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = { accounts: [{ name: "Work" }, { name: "Home" }], supported: true } as never;
let root: Root;
let last: AgentAccounts | null = null;
function Probe() { last = useAgentAccounts("t1", "claude", false, undefined, true); return null; }
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("useAgentAccounts", () => {
  beforeEach(() => { vi.useFakeTimers(); root = createRoot(document.createElement("div")); last = null; });
  afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.mocked(ipc.agentAccounts).mockReset(); });

  it("re-reads after a failed read instead of staying empty", async () => {
    vi.mocked(ipc.agentAccounts).mockRejectedValueOnce(new Error("in use")).mockResolvedValue(VIEW);
    act(() => root.render(createElement(Probe)));
    await flush();
    expect(last!.view).toBeNull();
    await act(async () => { vi.advanceTimersByTime(RETRY_MS[0]); });
    await flush();
    expect(ipc.agentAccounts).toHaveBeenCalledTimes(2);
    expect(last!.view).toBe(VIEW);
  });

  it("keeps the last good view when a later read fails", async () => {
    vi.mocked(ipc.agentAccounts).mockResolvedValueOnce(VIEW).mockRejectedValue(new Error("in use"));
    act(() => root.render(createElement(Probe)));
    await flush();
    expect(last!.view).toBe(VIEW);
    act(() => last!.refresh());
    await flush();
    expect(last!.view).toBe(VIEW);
  });

  it("gives up after the last back-off step", async () => {
    vi.mocked(ipc.agentAccounts).mockRejectedValue(new Error("gone"));
    act(() => root.render(createElement(Probe)));
    for (const ms of RETRY_MS) { await flush(); await act(async () => { vi.advanceTimersByTime(ms); }); }
    await flush();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(ipc.agentAccounts).toHaveBeenCalledTimes(RETRY_MS.length + 1);
  });
});
