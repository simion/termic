import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({ forgeRateStatus: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import * as ipc from "@/lib/ipc";
import { activePause, useForgeRate } from "@/store/forgeRate";
import type { ForgeRateStatus } from "@/lib/types";

const host = (paused: ForgeRateStatus["paused"], name = "github.com"): ForgeRateStatus => ({
  host: name,
  buckets: [{ bucket: "graphql", window: null, spent: 3, estimated: 1, cap: 1000, by_feature: [] }],
  paused,
});

describe("activePause", () => {
  it("names the first host with a pause still ahead", () => {
    const now = 1000;
    const hosts = [host(null), host({ until: 2000, kind: "floor", reason: "" }, "ghe.acme.com")];
    expect(activePause(hosts, now)).toMatchObject({ host: "ghe.acme.com", kind: "floor", until: 2000 });
  });

  it("ignores a pause whose time has passed", () => {
    expect(activePause([host({ until: 900, kind: "limited", reason: "" })], 1000)).toBeNull();
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
