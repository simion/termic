// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { INDEFINITE, lastCaffeinateFlags, lastCaffeinateHours, localDateTime, matchesCaffeinateSettings, rememberCaffeinateFlags, rememberCaffeinateHours, requestFromDraft, type CaffeinateStatus } from "./caffeinate";

describe("caffeinate draft validation", () => {
  it("rejects invalid durations without constructing an IPC request", () => {
    for (const hours of ["", " ", "0", "-1", "NaN", "Infinity", "24.01"]) {
      expect(requestFromDraft("duration", hours, "", false, false)).toBe("invalidDuration");
    }
    expect(requestFromDraft("duration", "1.5", "", true, false)).toEqual({ mode: "duration", duration_minutes: 90, closed_lid: true, display: false });
  });
  it("uses the same 24-hour horizon for until and duration", () => {
    const now = new Date(2026, 9, 25, 12).getTime();
    const future = localDateTime(new Date(now + 7_200_000));
    expect(requestFromDraft("until", "", future, false, true, now)).toEqual({ mode: "until", until_ms: now + 7_200_000, closed_lid: false, display: true });
    for (const value of ["", "bad", localDateTime(new Date(now - 60_000)), localDateTime(new Date(now + 86_460_000))]) {
      expect(requestFromDraft("until", "", value, false, false, now)).toBe("invalidTime");
    }
  });
  it("automatic mode has no deadline and does not use a hidden duration field", () => {
    expect(requestFromDraft("agents", "", "bad", false, false)).toEqual({ mode: "agents", closed_lid: false, display: false });
  });
  it("offers the duration last started, and falls back to 2 hours on junk", () => {
    localStorage.clear();
    expect(lastCaffeinateHours()).toBe("2");
    rememberCaffeinateHours("8");
    expect(lastCaffeinateHours()).toBe("8");
    rememberCaffeinateHours(INDEFINITE);
    expect(lastCaffeinateHours()).toBe(INDEFINITE);
    for (const junk of ["0", "25", "abc", ""]) {
      localStorage.setItem("caffeinateHours", junk);
      expect(lastCaffeinateHours()).toBe("2");
    }
  });
  it("offers the checkboxes last applied, and both off on junk", () => {
    localStorage.clear();
    expect(lastCaffeinateFlags()).toEqual({ closedLid: false, display: false });
    rememberCaffeinateFlags(true, true);
    expect(lastCaffeinateFlags()).toEqual({ closedLid: true, display: true });
    rememberCaffeinateFlags(false, true);
    expect(lastCaffeinateFlags()).toEqual({ closedLid: false, display: true });
    localStorage.setItem("caffeinateFlags", "{bad");
    expect(lastCaffeinateFlags()).toEqual({ closedLid: false, display: false });
  });
  it("the ∞ preset asks for an indefinite session and matches it back", () => {
    const request = requestFromDraft("duration", INDEFINITE, "", false, true);
    expect(request).toEqual({ mode: "indefinite", closed_lid: false, display: true });
    const status = { mode: "indefinite", closed_lid: false, display: true, duration_minutes: null, deadline_ms: null } as CaffeinateStatus;
    expect(matchesCaffeinateSettings(status, "duration", INDEFINITE, "", false, true)).toBe(true);
    // Toggling the display alone is a pending change, not "These settings are active".
    expect(matchesCaffeinateSettings(status, "duration", INDEFINITE, "", false, false)).toBe(false);
    expect(matchesCaffeinateSettings(status, "duration", "24", "", false, true)).toBe(false);
  });
});
