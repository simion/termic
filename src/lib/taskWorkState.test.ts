import { describe, it, expect } from "vitest";
import {
  taskNeedsAttention, taskWorkDone, taskWorking, taskWorkBadge, taskDelegated, unreadClearsOnSight,
} from "@/lib/taskWorkState";
import type { Tab } from "@/lib/types";
import type { DelegatedWork } from "@/lib/delegatedWork";

// Only type / workState / unread matter to the helpers.
const term = (over: Partial<Tab> = {}): Tab =>
  ({ id: "t", type: "terminal", ...over } as Tab);
const edit = (over: Partial<Tab> = {}): Tab =>
  ({ id: "e", type: "edit", ...over } as Tab);

const ON = { settledHighlight: true, workingIndicator: true, attentionIndicator: true };

describe("the three predicates", () => {
  it("reads attention, done and working off terminal tabs", () => {
    expect(taskNeedsAttention([term({ unread: { reason: "attention" } })], ON)).toBe(true);
    expect(taskWorkDone([term({ workState: "done" })], ON)).toBe(true);
    expect(taskWorking([term({ workState: "working" })], ON)).toBe(true);
  });

  it("ignores non-terminal tabs", () => {
    expect(taskNeedsAttention([edit({ unread: { reason: "attention" } })], ON)).toBe(false);
    expect(taskWorkDone([edit({ workState: "done" } as Partial<Tab>)], ON)).toBe(false);
  });

  it("ignores unread reasons that are not attention", () => {
    // bell / idle / exit / done feed the OS-notification path only; the
    // sidebar bell is attention alone.
    for (const reason of ["bell", "idle", "exit", "done"] as const) {
      expect(taskNeedsAttention([term({ unread: { reason } })], ON)).toBe(false);
    }
  });

  it("is false on an empty tab list", () => {
    expect(taskWorkBadge([], ON)).toBe(null);
  });
});

describe("the pref gates", () => {
  it("settledHighlight off silences done, and no longer the bell", () => {
    // It used to silence both. The bell is the one mark that is about the
    // USER rather than the agent, so it got its own switch; this pref keeps
    // the name it has in Settings and the state it is named after.
    const tabs = [term({ unread: { reason: "attention" }, workState: "done" })];
    const p = { settledHighlight: false, workingIndicator: true };
    expect(taskWorkDone(tabs, p)).toBe(false);
    expect(taskNeedsAttention(tabs, p)).toBe(true);
  });

  it("attentionIndicator off silences the bell on its own", () => {
    const tabs = [term({ unread: { reason: "attention" }, workState: "done" })];
    expect(taskNeedsAttention(tabs,
      { settledHighlight: true, attentionIndicator: false })).toBe(false);
    // And a caller that does not pass it is asking "is anything blocked on
    // me". Defaulting that to no would hide the mark from the surfaces that
    // exist to show it.
    expect(taskNeedsAttention(tabs, { settledHighlight: true })).toBe(true);
  });

  it("workingIndicator off silences every MID-TURN mark, not just the spinner", () => {
    const p = { settledHighlight: true, workingIndicator: false };
    const held: DelegatedWork = { label: "shell", count: 1, ids: ["b1"] };
    expect(taskWorking([term({ workState: "working" })], p)).toBe(false);
    // The ring too: turning the spinner off used to leave one in its place,
    // which is the same claim drawn more quietly.
    expect(taskDelegated([term({ delegatedWork: held })], p)).toBe(false);
    expect(taskWorkDone([term({ workState: "done" })], p)).toBe(true);
  });

  it("treats an absent workingIndicator as off", () => {
    // The sidebar's rollup dots pass `{ settledHighlight }` alone rather than
    // subscribing to a pref they never use.
    expect(taskWorking([term({ workState: "working" })], { settledHighlight: true })).toBe(false);
    expect(taskWorkDone([term({ workState: "done" })], { settledHighlight: true })).toBe(true);
  });

  it("every switch off draws nothing at all", () => {
    const tabs = [term({ unread: { reason: "attention" }, workState: "working" })];
    expect(taskWorkBadge(tabs, {
      settledHighlight: false, workingIndicator: false, attentionIndicator: false,
    })).toBe(null);
  });
});

describe("taskWorkBadge precedence", () => {
  it("attention outranks done and working", () => {
    expect(taskWorkBadge([
      term({ id: "a", unread: { reason: "attention" } }),
      term({ id: "b", workState: "done" }),
      term({ id: "c", workState: "working" }),
    ], ON)).toBe("attention");
  });

  it("done outranks working", () => {
    expect(taskWorkBadge([
      term({ id: "b", workState: "done" }),
      term({ id: "c", workState: "working" }),
    ], ON)).toBe("done");
  });

  it("falls through to working when it is the only signal", () => {
    expect(taskWorkBadge([term({ workState: "working" })], ON)).toBe("working");
  });

  it("aggregates ACROSS tabs, not per tab", () => {
    // The badge is the task's, so a bell on one tab and a spinner on another
    // resolves to the bell rather than to whichever tab is first.
    expect(taskWorkBadge([
      term({ id: "a", workState: "working" }),
      term({ id: "b", unread: { reason: "attention" } }),
    ], ON)).toBe("attention");
  });

  it("draws delegated work last, and only when nothing else wants the slot", () => {
    const held: DelegatedWork = { label: "shell", count: 1, ids: ["b1"] };
    // On its own: a tab with nothing spinning and nothing to announce, that
    // still has something running. This is the case the collapsed sidebar row
    // showed as completely inert.
    expect(taskWorkBadge([term({ delegatedWork: held })], ON)).toBe("delegated");
    // And it never outranks a real state, on the same tab or another.
    expect(taskWorkBadge([term({ workState: "working", delegatedWork: held })], ON))
      .toBe("working");
    expect(taskWorkBadge([term({ workState: "done", delegatedWork: held })], ON))
      .toBe("done");
    expect(taskWorkBadge([
      term({ id: "a", delegatedWork: held }),
      term({ id: "b", unread: { reason: "attention" } }),
    ], ON)).toBe("attention");
  });

  it("gates delegated work on the spinner pref, with done unaffected", () => {
    const held: DelegatedWork = { label: "shell", count: 1, ids: ["b1"] };
    // Mid-turn marks are one family and one switch. The ring says an agent is
    // busy, so "do not show me busy agents" has to cover it.
    expect(taskDelegated([term({ delegatedWork: held })],
      { settledHighlight: false, workingIndicator: true })).toBe(true);
    expect(taskDelegated([term({ delegatedWork: held })],
      { settledHighlight: true, workingIndicator: false })).toBe(false);
    // A non-terminal tab can never carry one.
    expect(taskDelegated([edit({ delegatedWork: held } as never)], ON)).toBe(false);
  });

  it("skips a silenced higher rank instead of drawing nothing", () => {
    // settledHighlight off removes done from contention, so a
    // working agent still gets its spinner.
    expect(taskWorkBadge([
      term({ id: "a", unread: { reason: "attention" } }),
      term({ id: "b", workState: "working" }),
    ], { settledHighlight: false, workingIndicator: true, attentionIndicator: false }))
      .toBe("working");
  });
});

describe("unreadClearsOnSight", () => {
  it("every mark clears on sight except an agent blocked on the user", () => {
    for (const reason of ["bell", "idle", "exit", "done"]) {
      expect(unreadClearsOnSight({ reason })).toBe(true);
    }
    expect(unreadClearsOnSight({ reason: "attention" })).toBe(false);
  });

  it("nothing to clear is not a mark", () => {
    expect(unreadClearsOnSight(null)).toBe(false);
    expect(unreadClearsOnSight(undefined)).toBe(false);
  });
});
