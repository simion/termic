// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { useUI } from "@/store/ui";

// One confirm slot serves the whole window, so a prompt nobody can answer is
// not a small mess: it blocks every other dialog until it is resolved. These
// cover the withdrawal path an asker uses when it goes away first (a terminal
// pane whose tab was closed, a task that got archived mid-prompt).
describe("confirm modal", () => {
  beforeEach(() => {
    useUI.setState({ confirm: null });
  });

  const settle = () => new Promise(r => setTimeout(r, 0));

  it("opens on the next macrotask and resolves with the answer", async () => {
    const p = useUI.getState().askConfirm({ title: "T", message: "M" });
    expect(useUI.getState().confirm).toBeNull(); // deferred, see askConfirm
    await settle();
    expect(useUI.getState().confirm?.req.title).toBe("T");

    useUI.getState().resolveConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(useUI.getState().confirm).toBeNull();
  });

  it("withdraws a prompt that is already on screen", async () => {
    const p = useUI.getState().askConfirm({ key: "k1", title: "T", message: "M" });
    await settle();
    expect(useUI.getState().confirm).not.toBeNull();

    useUI.getState().withdrawConfirm("k1");

    await expect(p).resolves.toBe(false);
    expect(useUI.getState().confirm).toBeNull();
  });

  it("withdraws a prompt that has not appeared yet", async () => {
    // The asker torn down inside askConfirm's deferral gap. The modal must
    // never reach the screen.
    const p = useUI.getState().askConfirm({ key: "k2", title: "T", message: "M" });
    useUI.getState().withdrawConfirm("k2");
    await settle();

    expect(useUI.getState().confirm).toBeNull();
    await expect(p).resolves.toBe(false);
  });

  it("leaves other prompts alone", async () => {
    const p = useUI.getState().askConfirm({ key: "mine", title: "T", message: "M" });
    await settle();

    useUI.getState().withdrawConfirm("someone-else");

    expect(useUI.getState().confirm?.req.title).toBe("T");
    useUI.getState().resolveConfirm(true);
    await expect(p).resolves.toBe(true);
  });

  it("reports a withdrawn checkbox prompt as unchecked, not undefined", async () => {
    const p = useUI.getState().askConfirm({
      key: "k3",
      title: "T",
      message: "M",
      checkbox: { label: "Also delete the branch" },
    });
    await settle();

    useUI.getState().withdrawConfirm("k3");

    await expect(p).resolves.toEqual({ confirmed: false, checked: false, dontAskAgain: false });
  });

  it("reports the object shape for a dontAskAgain prompt with no checkbox", async () => {
    const p = useUI.getState().askConfirm({ title: "T", message: "M", dontAskAgain: true });
    await settle();

    useUI.getState().resolveConfirm(true, false, true);

    await expect(p).resolves.toEqual({ confirmed: true, checked: false, dontAskAgain: true });
  });

  it("carries both checkbox answers back independently", async () => {
    const p = useUI.getState().askConfirm({
      title: "T",
      message: "M",
      checkbox: { label: "Delete the git branch:" },
      dontAskAgain: true,
    });
    await settle();

    useUI.getState().resolveConfirm(true, true, false);

    await expect(p).resolves.toEqual({ confirmed: true, checked: true, dontAskAgain: false });
  });

  it("still resolves a plain confirm as a bare boolean", async () => {
    const p = useUI.getState().askConfirm({ title: "T", message: "M" });
    await settle();

    useUI.getState().resolveConfirm(true, true, true);

    await expect(p).resolves.toBe(true);
  });
});

// The dashboard's phase filter. Session-only by design (no localStorage), so
// the only things worth pinning are the default, the round trip, and the bail
// that keeps a re-click of the selected pill from copying the store.
describe("dashboard phase filter", () => {
  beforeEach(() => {
    useUI.setState({ dashboardPhase: null });
  });

  it("defaults to All", () => {
    expect(useUI.getState().dashboardPhase).toBeNull();
  });

  it("round-trips a phase and back to All", () => {
    useUI.getState().setDashboardPhase("in_review");
    expect(useUI.getState().dashboardPhase).toBe("in_review");
    useUI.getState().setDashboardPhase(null);
    expect(useUI.getState().dashboardPhase).toBeNull();
  });

  it("notifies ONCE for a phase set twice (docs/performance.md bear trap 8)", () => {
    let notifications = 0;
    const unsub = useUI.subscribe(() => { notifications++; });
    useUI.getState().setDashboardPhase("done");
    useUI.getState().setDashboardPhase("done");
    useUI.getState().setDashboardPhase("done");
    unsub();
    expect(notifications).toBe(1);
  });

  it("does not notify when clearing a filter that is already All", () => {
    let notifications = 0;
    const unsub = useUI.subscribe(() => { notifications++; });
    useUI.getState().setDashboardPhase(null);
    unsub();
    expect(notifications).toBe(0);
  });
});
