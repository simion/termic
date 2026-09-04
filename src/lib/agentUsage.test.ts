import { describe, it, expect } from "vitest";
import {
  USAGE_BODY_PREFIX, parseUsageBody, sameUsage, formatPercent, formatReset,
  usageLevel, drivingWindow, USAGE_WARN_PERCENT, USAGE_CRITICAL_PERCENT,
} from "./agentUsage";
import { HOOK_OSC_BODY, HOOK_OSC_READY_BODY, parseNotifyBody, hookOscHandlerData } from "./agentHooks";
import { useAgentUsage } from "@/store/agentUsage";

describe("the usage body", () => {
  // The Rust half of this pair is
  // `the_usage_body_is_not_confusable_with_the_other_signals`. A string cannot
  // be shared across the language boundary, so both sides pin the literal.
  it("is pinned, because agent_hooks.rs writes it and cannot import this", () => {
    expect(USAGE_BODY_PREFIX).toBe("usage ");
  });

  // All three bodies ride OSC 777 with the trusted `termic` title and are told
  // apart by the body ALONE. If one were a prefix of another, a usage report
  // would route into the attention path and badge a tab on every single turn.
  it("cannot be confused with the attention or ready signals", () => {
    for (const other of [HOOK_OSC_BODY, HOOK_OSC_READY_BODY]) {
      expect(USAGE_BODY_PREFIX.startsWith(other)).toBe(false);
      expect(other.startsWith(USAGE_BODY_PREFIX)).toBe(false);
    }
  });
});

describe("parseUsageBody", () => {
  it("reads both windows and their resets", () => {
    expect(parseUsageBody("usage 16 14.000000000000002 1788530400 1788937200")).toEqual({
      session: { usedPercent: 16, resetsAt: 1788530400 },
      weekly: { usedPercent: 14.000000000000002, resetsAt: 1788937200 },
    });
  });

  it("takes one window without the other", () => {
    // codex on a free plan reports a single long window, so a parser that
    // demanded both would show that user nothing at all.
    expect(parseUsageBody("usage - 49 - 1790491695")).toEqual({
      session: null,
      weekly: { usedPercent: 49, resetsAt: 1790491695 },
    });
  });

  it("keeps a percentage whose reset is missing", () => {
    expect(parseUsageBody("usage 7 3 - 9")).toEqual({
      session: { usedPercent: 7, resetsAt: null },
      weekly: { usedPercent: 3, resetsAt: 9 },
    });
  });

  it("is not fooled by an empty field, which Number() would read as 0", () => {
    // The trap this guards: `Number("")` is 0, so a missing percentage would
    // paint a confident "0% used" over a field the agent never sent.
    expect(parseUsageBody("usage  - - -")).toBeNull();
    expect(parseUsageBody("usage - - - -")).toBeNull();
  });

  it("drops a field that is not a bare number", () => {
    // The body reaches a render path from an agent-controlled JSON document.
    // Exponent notation is not a percentage claude or codex ever sends, and
    // accepting it would let `1e9` through to a bar width.
    expect(parseUsageBody("usage 1e9 5 - -")?.session).toBeNull();
    expect(parseUsageBody("usage <script> 5 - -")).toEqual({
      session: null,
      weekly: { usedPercent: 5, resetsAt: null },
    });
    expect(parseUsageBody("usage -5 - - -")).toBeNull();
  });

  it("clamps, so a provider reporting over 100 cannot overflow the bar", () => {
    expect(parseUsageBody("usage 140 - - -")?.session?.usedPercent).toBe(100);
  });

  it("returns null for every body that is not a usage report", () => {
    expect(parseUsageBody(HOOK_OSC_BODY)).toBeNull();
    expect(parseUsageBody(HOOK_OSC_READY_BODY)).toBeNull();
    expect(parseUsageBody("usagey 1 2 3 4")).toBeNull();
    expect(parseUsageBody("")).toBeNull();
  });

  // End to end through the same parse the OSC handler does, rather than only
  // through the constant: the handler is handed everything after `777;`.
  it("survives the OSC round trip the handler performs", () => {
    const data = hookOscHandlerData("usage 16 14 1788530400 1788937200");
    const body = parseNotifyBody(data);
    expect(body).toBe("usage 16 14 1788530400 1788937200");
    expect(parseUsageBody(body!)?.session?.usedPercent).toBe(16);
  });
});

describe("formatting", () => {
  it("rounds, because the provider sends float noise", () => {
    expect(formatPercent({ usedPercent: 14.000000000000002, resetsAt: null })).toBe("14%");
    expect(formatPercent(null)).toBe("—");
  });

  it("says nothing when there is no reset to report", () => {
    expect(formatReset(null)).toBe("");
    expect(formatReset({ usedPercent: 1, resetsAt: null })).toBe("");
  });

  it("treats the reset as epoch SECONDS, not milliseconds", () => {
    // Getting this backwards is a silent 1970 in the tooltip.
    const inAnHour = Math.floor(Date.now() / 1000) + 3600;
    expect(formatReset({ usedPercent: 1, resetsAt: inAnHour })).toMatch(/^resets \d/);
  });
});

describe("the warning thresholds", () => {
  const w = (usedPercent: number) => ({ usedPercent, resetsAt: null });

  it("is neutral below the warn threshold, inclusive of the boundary", () => {
    expect(usageLevel(0)).toBe("normal");
    expect(usageLevel(USAGE_WARN_PERCENT - 0.1)).toBe("normal");
    // The boundary belongs to the WARNING. A footer that waits for 70.1 to
    // colour a number the user reads as "70" is a footer that looks broken.
    expect(usageLevel(USAGE_WARN_PERCENT)).toBe("warn");
    expect(usageLevel(USAGE_CRITICAL_PERCENT - 0.1)).toBe("warn");
    expect(usageLevel(USAGE_CRITICAL_PERCENT)).toBe("critical");
    expect(usageLevel(100)).toBe("critical");
  });

  it("colours by the window closest to its limit, not by the shorter one", () => {
    // The case this exists for: a comfortable session window in front of a
    // nearly-spent week. Reading the session window alone reports good news
    // right up until the turn that fails.
    const d = drivingWindow({ session: w(30), weekly: w(95) })!;
    expect(d.label).toBe("wk");
    expect(usageLevel(d.window.usedPercent)).toBe("critical");
  });

  it("prefers the session window when it is the one in trouble", () => {
    const d = drivingWindow({ session: w(95), weekly: w(30) })!;
    expect(d.label).toBe("5h");
  });

  it("takes whichever single window exists", () => {
    // codex on a free plan reports only the long one.
    expect(drivingWindow({ session: null, weekly: w(49) })!.label).toBe("wk");
    expect(drivingWindow({ session: w(49), weekly: null })!.label).toBe("5h");
    expect(drivingWindow({ session: null, weekly: null })).toBeNull();
  });

  it("breaks an exact tie towards the session window", () => {
    // Arbitrary but must be STABLE: a tie that flipped between renders would
    // move the colour from one number to the other while nothing changed.
    expect(drivingWindow({ session: w(80), weekly: w(80) })!.label).toBe("5h");
  });
});

describe("the store", () => {
  const reset = () => useAgentUsage.setState({ byAgent: {} });

  it("keys on the agent entry, so two clones never share a number", () => {
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", { session: { usedPercent: 10, resetsAt: null }, weekly: null }, "statusline");
    s.report("next-claude", { session: { usedPercent: 90, resetsAt: null }, weekly: null }, "statusline");
    const { byAgent } = useAgentUsage.getState();
    expect(byAgent["claude"].session?.usedPercent).toBe(10);
    expect(byAgent["next-claude"].session?.usedPercent).toBe(90);
  });

  // docs/performance.md bear trap 8. The status line fires on EVERY turn and
  // most turns move a percentage by nothing, so an unchanged write would copy
  // the whole store and re-run every selector on the hottest path there is.
  it("bails on an unchanged reading, object identity included", () => {
    reset();
    const usage = { session: { usedPercent: 10, resetsAt: 5 }, weekly: null };
    useAgentUsage.getState().report("claude", usage, "statusline");
    const first = useAgentUsage.getState().byAgent;
    // A fresh object with the same VALUES must still be recognised as equal.
    useAgentUsage.getState().report("claude", { session: { usedPercent: 10, resetsAt: 5 }, weekly: null }, "statusline");
    expect(useAgentUsage.getState().byAgent).toBe(first);
  });

  it("writes when the number actually moves", () => {
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", { session: { usedPercent: 10, resetsAt: null }, weekly: null }, "statusline");
    const first = useAgentUsage.getState().byAgent;
    s.report("claude", { session: { usedPercent: 11, resetsAt: null }, weekly: null }, "statusline");
    expect(useAgentUsage.getState().byAgent).not.toBe(first);
    expect(useAgentUsage.getState().byAgent["claude"].session?.usedPercent).toBe(11);
  });

  it("writes when the same number arrives from the other transport", () => {
    // Which side reported it is shown in the tooltip, so a switch from the
    // codex RPC to a status line push has to land even at an equal percentage.
    reset();
    const u = { session: { usedPercent: 10, resetsAt: null }, weekly: null };
    useAgentUsage.getState().report("codex", u, "rpc");
    const first = useAgentUsage.getState().byAgent;
    useAgentUsage.getState().report("codex", u, "statusline");
    expect(useAgentUsage.getState().byAgent).not.toBe(first);
  });

  // The bug this exists for: a Claude Max user watched their Session row turn
  // into "not reported", because one payload carried `used_percentage: null`
  // and the whole entry was replaced with it.
  it("keeps a window the newest reading happens to omit", () => {
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", {
      session: { usedPercent: 3, resetsAt: 10 },
      weekly: { usedPercent: 18, resetsAt: 20 },
    }, "statusline");
    // The next turn reports only the weekly one.
    s.report("claude", { session: null, weekly: { usedPercent: 19, resetsAt: 20 } }, "statusline");
    const e = useAgentUsage.getState().byAgent["claude"];
    expect(e.session?.usedPercent).toBe(3);
    expect(e.weekly?.usedPercent).toBe(19);
  });

  it("does not invent a window the source never reported", () => {
    // codex on a free plan has no session window at all, and carrying one
    // forward from nothing would be inventing a limit that does not exist.
    reset();
    useAgentUsage.getState().report("codex", { session: null, weekly: { usedPercent: 49, resetsAt: 1 } }, "rpc");
    expect(useAgentUsage.getState().byAgent["codex"].session).toBeNull();
  });

  it("never carries a window ACROSS sources", () => {
    // The two transports describe different accounts' shapes. A claude push
    // must not backfill a codex reading, or the chip shows a window that
    // account does not have.
    reset();
    const s = useAgentUsage.getState();
    s.report("x", { session: { usedPercent: 5, resetsAt: 1 }, weekly: null }, "statusline");
    s.report("x", { session: null, weekly: { usedPercent: 7, resetsAt: 2 } }, "rpc");
    expect(useAgentUsage.getState().byAgent["x"].session).toBeNull();
  });

  it("clears without churning the store when there is nothing to clear", () => {
    reset();
    const before = useAgentUsage.getState().byAgent;
    useAgentUsage.getState().clear("nobody");
    expect(useAgentUsage.getState().byAgent).toBe(before);
  });
});

describe("sameUsage", () => {
  it("compares by value, and treats a missing window as different from a present one", () => {
    const a = { session: { usedPercent: 1, resetsAt: 2 }, weekly: null };
    expect(sameUsage(a, { session: { usedPercent: 1, resetsAt: 2 }, weekly: null })).toBe(true);
    expect(sameUsage(a, { session: { usedPercent: 1, resetsAt: 3 }, weekly: null })).toBe(false);
    expect(sameUsage(a, { session: null, weekly: null })).toBe(false);
    expect(sameUsage(undefined, undefined)).toBe(true);
    expect(sameUsage(a, undefined)).toBe(false);
  });
});
