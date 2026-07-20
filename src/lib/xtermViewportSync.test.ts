import { describe, it, expect, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { resyncViewportAfterReveal } from "./xtermViewportSync";

// The helper reaches into xterm internals, so these tests pin the contract
// against a fake core: what we poke, in what order, and that missing or
// reshaped internals degrade to a no-op instead of throwing.

function fakeTerm(viewport: unknown): Terminal {
  return { _core: { viewport } } as unknown as Terminal;
}

describe("resyncViewportAfterReveal", () => {
  // NOTE for both ordering tests: the helper wraps everything in try/catch,
  // so an expect() placed inside the mocked syncScrollArea is swallowed and
  // can never fail the test. Capture the observed state inside the mock,
  // assert OUTSIDE the helper call.
  it("invalidates the recorded viewport height, then forces an immediate sync", () => {
    let heightDuringSync: number | undefined;
    const vp = {
      _lastRecordedViewportHeight: 480,
      _ignoreNextScrollEvent: false,
      syncScrollArea: vi.fn(() => {
        heightDuringSync = vp._lastRecordedViewportHeight;
      }),
    };
    resyncViewportAfterReveal(fakeTerm(vp));
    expect(vp.syncScrollArea).toHaveBeenCalledExactlyOnceWith(true);
    // syncScrollArea must observe the poked value — that's what defeats its
    // dirty-checks and forces the full _innerRefresh.
    expect(heightDuringSync).toBe(-1);
  });

  it("clears a stale _ignoreNextScrollEvent before syncing", () => {
    let flagDuringSync: boolean | undefined;
    const vp = {
      _lastRecordedViewportHeight: 480,
      _ignoreNextScrollEvent: true,
      syncScrollArea: vi.fn(() => {
        flagDuringSync = vp._ignoreNextScrollEvent;
      }),
    };
    resyncViewportAfterReveal(fakeTerm(vp));
    expect(vp.syncScrollArea).toHaveBeenCalledOnce();
    expect(flagDuringSync).toBe(false);
  });

  it("no-ops when the viewport is missing", () => {
    expect(() => resyncViewportAfterReveal(fakeTerm(undefined))).not.toThrow();
    expect(() => resyncViewportAfterReveal({} as unknown as Terminal)).not.toThrow();
  });

  it("no-ops when syncScrollArea is gone (future xterm reshape)", () => {
    const vp = { _lastRecordedViewportHeight: 480 };
    resyncViewportAfterReveal(fakeTerm(vp));
    // Without a callable sync there is nothing to force — the poke must not
    // happen either, so we leave no fingerprints on an unknown object.
    expect(vp._lastRecordedViewportHeight).toBe(480);
  });

  it("skips the height poke when the field is not a number", () => {
    const vp = {
      _lastRecordedViewportHeight: undefined as number | undefined,
      syncScrollArea: vi.fn(),
    };
    resyncViewportAfterReveal(fakeTerm(vp));
    expect(vp._lastRecordedViewportHeight).toBeUndefined();
    expect(vp.syncScrollArea).toHaveBeenCalledWith(true);
  });

  it("swallows a throwing syncScrollArea", () => {
    const vp = {
      _lastRecordedViewportHeight: 480,
      syncScrollArea: vi.fn(() => { throw new Error("boom"); }),
    };
    expect(() => resyncViewportAfterReveal(fakeTerm(vp))).not.toThrow();
  });
});
