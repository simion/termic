import { describe, expect, it } from "vitest";
import { prBadgeAppearance, type PrBadgeState, type PrChecks } from "./prBadgeAppearance";

const ERR = "var(--color-err)";
const WARN = "var(--color-warn)";
const FAINT = "var(--color-fg-faint)";
const OPEN = "var(--color-pr-open)";
const MERGED = "var(--color-pr-merged)";
const CLOSED = "var(--color-pr-closed)";

const STATES: PrBadgeState[] = ["open", "draft", "merged", "closed", null];
const CHECKS: (PrChecks | null)[] = ["failing", "pending", "passing", "none", null];

describe("prBadgeAppearance", () => {
  it("never returns the alarm red, for ANY combination", () => {
    // The whole rule, asserted over the whole matrix rather than case by case.
    // --color-err means "broken right now". A failing build on an open PR is
    // something to go and look at rather than a broken task, and a closed PR
    // wants nothing at all (it has a muted red of its own). A list dotted
    // with alarm red you are not meant to act on teaches you to stop seeing it.
    for (const state of STATES) {
      for (const checks of CHECKS) {
        expect(prBadgeAppearance(state, checks).color, `${state} / ${checks}`).not.toBe(ERR);
      }
    }
  });

  it("gives a draft no colour at all, whatever its checks say", () => {
    // Not just "not red": not green either. A draft is work its author has not
    // asked anyone to look at, so neither its failures nor its passes are a
    // signal to anybody else yet.
    for (const checks of CHECKS) {
      const a = prBadgeAppearance("draft", checks);
      expect(a.color, `draft with checks=${checks}`).toBe(FAINT);
      expect(a.alarming).toBe(false);
    }
  });

  it("warns, not errors, on an open PR whose checks fail", () => {
    expect(prBadgeAppearance("open", "failing")).toEqual({ color: WARN, alarming: true, struck: false });
  });

  it("dims an open PR whose checks are still running: no verdict, no green", () => {
    expect(prBadgeAppearance("open", "pending")).toEqual({ color: "var(--color-fg-dim)", alarming: false, struck: false });
  });

  it("leaves an open PR its own green once checks pass, or with none", () => {
    for (const checks of ["passing", "none", null] as const) {
      expect(prBadgeAppearance("open", checks), `open with checks=${checks}`)
        .toEqual({ color: OPEN, alarming: false, struck: false });
    }
  });

  it("keeps merged purple even if HEAD's CI went red afterwards", () => {
    expect(prBadgeAppearance("merged", "failing")).toEqual({ color: MERGED, alarming: false, struck: false });
  });

  it("draws closed in its own muted red, struck through, and never as an alarm", () => {
    // It used to be --color-err, which said "something needs you here" about a
    // PR that by definition wants nothing. Then faint, which made it
    // indistinguishable from a draft on a number-only mark.
    for (const checks of CHECKS) {
      expect(prBadgeAppearance("closed", checks), `closed with checks=${checks}`)
        .toEqual({ color: CLOSED, alarming: false, struck: true });
    }
  });

  it("strikes through closed and nothing else", () => {
    for (const state of STATES) {
      for (const checks of CHECKS) {
        expect(prBadgeAppearance(state, checks).struck, `${state} / ${checks}`).toBe(state === "closed");
      }
    }
  });

  it("is faint when there is no state yet", () => {
    // A task carrying a cached pr_url that has never been looked up.
    expect(prBadgeAppearance(null, null)).toEqual({ color: FAINT, alarming: false, struck: false });
  });

  it("marks only the open+failing case as alarming", () => {
    for (const state of STATES) {
      for (const checks of CHECKS) {
        const want = state === "open" && checks === "failing";
        expect(prBadgeAppearance(state, checks).alarming, `${state} / ${checks}`).toBe(want);
      }
    }
  });
});
