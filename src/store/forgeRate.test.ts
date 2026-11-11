// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/ipc", () => ({ forgeRateStatus: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import * as ipc from "@/lib/ipc";
import * as ev from "@tauri-apps/api/event";
import { activePause, initForgeRate, lookupMessage, rateLimitedText, useForgeRate } from "@/store/forgeRate";
import type { ForgeRateStatus } from "@/lib/types";

const host = (paused: ForgeRateStatus["paused"], name = "github.com"): ForgeRateStatus => ({
  host: name,
  buckets: [{ bucket: "graphql", window: null, spent: 3, estimated: 1, cap: 1000, by_feature: [] }],
  paused,
});

describe("activePause", () => {
  it("names the first host with a pause still ahead", () => {
    const now = 1000;
    const hosts = [host(null), host({ until: 2000, kind: "floor" }, "ghe.acme.com")];
    expect(activePause(hosts, now)).toMatchObject({ host: "ghe.acme.com", kind: "floor", until: 2000 });
  });

  it("ignores a pause whose time has passed", () => {
    expect(activePause([host({ until: 900, kind: "limited" })], 1000)).toBeNull();
  });
});

describe("useForgeRate.refresh", () => {
  beforeEach(() => useForgeRate.setState({ hosts: [] }));

  it("writes nothing when the ledger has not changed", async () => {
    vi.mocked(ipc.forgeRateStatus).mockResolvedValue([host(null)]);
    await useForgeRate.getState().refresh();
    const first = useForgeRate.getState().hosts;
    const listener = vi.fn();
    const unsub = useForgeRate.subscribe(listener);
    vi.mocked(ipc.forgeRateStatus).mockResolvedValue([host(null)]);
    await useForgeRate.getState().refresh();
    expect(listener).not.toHaveBeenCalled();
    expect(useForgeRate.getState().hosts).toBe(first);
    unsub();
  });

  it("keeps the last answer when the IPC fails", async () => {
    useForgeRate.setState({ hosts: [host(null)] });
    vi.mocked(ipc.forgeRateStatus).mockRejectedValue(new Error("boom"));
    await useForgeRate.getState().refresh();
    expect(useForgeRate.getState().hosts).toHaveLength(1);
  });
});

describe("a pause lifting", () => {
  beforeEach(() => {
    useForgeRate.setState({ hosts: [] });
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000); // 1000s
  });
  afterEach(() => vi.useRealTimers());

  it("asks the ledger again when the pause's time comes, and the pause is gone", async () => {
    vi.mocked(ipc.forgeRateStatus).mockReset()
      .mockResolvedValueOnce([host({ until: 1060, kind: "budget" })])
      .mockResolvedValue([host(null)]);
    await useForgeRate.getState().refresh();
    expect(activePause(useForgeRate.getState().hosts)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ipc.forgeRateStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ipc.forgeRateStatus).toHaveBeenCalledTimes(2);
    expect(activePause(useForgeRate.getState().hosts)).toBeNull();
  });

  it("never arms a timer past setTimeout's ceiling", async () => {
    const spy = vi.spyOn(window, "setTimeout");
    vi.mocked(ipc.forgeRateStatus).mockReset().mockResolvedValue([host({ until: 1000 + 100 * 86_400, kind: "limited" })]);
    await useForgeRate.getState().refresh();
    const ms = spy.mock.calls.at(-1)?.[1] ?? 0;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2 ** 31 - 1);
    spy.mockRestore();
  });

  it("words a GitHub refusal with the time it lifts, or without one", () => {
    expect(rateLimitedText(1060)).toMatch(/rate limit.*\d{2}:\d{2}/);
    expect(rateLimitedText(undefined)).toMatch(/shortly/);
  });
});

describe("a pull racing a pushed event", () => {
  it("drops a pull that lands after an event arrived while it was in flight", async () => {
    let push: ((e: { payload: ForgeRateStatus[] }) => void) | null = null;
    vi.mocked(ev.listen).mockImplementation(((_: string, h: typeof push) => {
      push = h;
      return Promise.resolve(() => {});
    }) as never);
    vi.mocked(ipc.forgeRateStatus).mockResolvedValue([]);
    initForgeRate();
    await Promise.resolve();
    useForgeRate.setState({ hosts: [] });

    let answer!: (h: ForgeRateStatus[]) => void;
    vi.mocked(ipc.forgeRateStatus).mockReturnValue(new Promise(r => { answer = r; }));
    const pulled = useForgeRate.getState().refresh();
    const paused = host({ until: Date.now() / 1000 + 600, kind: "budget" });
    push!({ payload: [paused] });
    answer([host(null)]); // computed before the pause began
    await pulled;
    expect(useForgeRate.getState().hosts).toEqual([paused]);

    // With no event in flight, a pull lands as before.
    vi.mocked(ipc.forgeRateStatus).mockResolvedValue([host(null)]);
    await useForgeRate.getState().refresh();
    expect(useForgeRate.getState().hosts[0].paused).toBeNull();
  });
});

describe("lookupMessage", () => {
  it("words a rate refusal from the lookup's own retry time", () => {
    expect(lookupMessage({ status: "rate-limited", message: "GitHub rate limit reached", retry_at: 2_000_000_000 }))
      .toBe(rateLimitedText(2_000_000_000));
    expect(lookupMessage({ status: "error", message: "boom" })).toBe("boom");
  });
});
