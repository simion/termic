import { describe, it, expect } from "vitest";
import {
  BUILTIN_LIMIT_SIGNALS,
  looksLikeLimitNotice,
  parseResetAt,
  findWaitOption,
  planLimitPark,
  FALLBACK_WAIT_MS,
  MAX_WAIT_MS,
  KEY_DOWN,
  KEY_UP,
  KEY_ENTER,
} from "./autoRetry";
import { compileSignals } from "./agents";

const claude = compileSignals(BUILTIN_LIMIT_SIGNALS.claude);

/** 2026-08-23T10:00:00 LOCAL. Built from parts, not from an ISO string with a
 *  Z on it: every assertion below is about local-time resolution, so pinning
 *  "now" to a UTC instant would make the suite pass or fail on the runner's
 *  timezone. */
const NOW = new Date(2026, 7, 23, 10, 0, 0).getTime();
const at = (h: number, m = 0, dayOffset = 0) =>
  new Date(2026, 7, 23 + dayOffset, h, m, 0, 0).getTime();

describe("looksLikeLimitNotice", () => {
  it("matches the wordings claude has been observed printing", () => {
    for (const line of [
      "You've hit your limit · resets 3pm (Europe/Dublin)",
      "5-hour limit reached ∙ resets 3am",
      "Claude usage limit reached. Resets at 2pm",
      "Claude AI usage limit reached|1763049600",
      "You've reached your weekly limit · resets Monday 9am",
      // Recorded from a real session limit on 2026-08-23. The only sample
      // here that came off a live account rather than out of a doc.
      "You've hit your session limit · resets 7:30pm (Europe/Amsterdam)",
    ]) {
      expect(looksLikeLimitNotice(line, claude), line).toBe(true);
    }
  });

  it("ignores the transient-overload family, which wants a backoff not a clock", () => {
    // Parking a tab for five hours over a 529 blip is strictly worse than
    // doing nothing, so these must not match. See the doc on
    // BUILTIN_LIMIT_SIGNALS.
    for (const line of [
      "API Error: 529 overloaded_error",
      "Request failed with status 429",
      "rate limit exceeded, retrying",
      "Error: 503 Service Unavailable",
    ]) {
      expect(looksLikeLimitNotice(line, claude), line).toBe(false);
    }
  });

  it("does not match an empty line or an empty pattern set", () => {
    expect(looksLikeLimitNotice("", claude)).toBe(false);
    expect(looksLikeLimitNotice("usage limit reached", [])).toBe(false);
  });
});

describe("parseResetAt", () => {
  it("reads a bare 12-hour clock later today", () => {
    expect(parseResetAt("You've hit your limit · resets 3pm", NOW)).toBe(at(15));
  });

  it("reads minutes and a spaced meridiem", () => {
    expect(parseResetAt("resets 3:30 pm", NOW)).toBe(at(15, 30));
  });

  it("rolls a clock that has already gone today forward to tomorrow", () => {
    // 3am seen at 10am is tomorrow's 3am. Reading it as this morning's would
    // schedule a resume in the past, which fires instantly and burns a try
    // against a limit that has not lifted.
    expect(parseResetAt("5-hour limit reached ∙ resets 3am", NOW)).toBe(at(3, 0, 1));
  });

  it("handles midnight and noon, where 12 is the trap", () => {
    expect(parseResetAt("resets 12am", NOW)).toBe(at(0, 0, 1));
    expect(parseResetAt("resets 12pm", NOW)).toBe(at(12));
  });

  it("accepts 'Resets at' and a 24-hour clock", () => {
    expect(parseResetAt("Claude usage limit reached. Resets at 2pm", NOW)).toBe(at(14));
    expect(parseResetAt("resets at 14:30", NOW)).toBe(at(14, 30));
  });

  it("ignores the parenthesised zone and resolves in local time", () => {
    // Documented behaviour, not an oversight: claude prints the zone it is
    // already rendering the clock in, so converting would double-apply it.
    expect(parseResetAt("resets 3pm (Europe/Dublin)", NOW)).toBe(at(15));
    expect(parseResetAt("resets 3pm (America/New_York)", NOW)).toBe(at(15));
  });

  it("steps to the next occurrence of a named weekday", () => {
    // NOW is a Sunday. Monday 9am is tomorrow.
    expect(new Date(NOW).getDay()).toBe(0);
    expect(parseResetAt("resets Monday 9am", NOW)).toBe(at(9, 0, 1));
    expect(parseResetAt("resets Friday 9am", NOW)).toBe(at(9, 0, 5));
  });

  it("reads the same weekday as a week out when its clock has passed", () => {
    expect(parseResetAt("resets Sunday 9am", NOW)).toBe(at(9, 0, 7));
    // ...but not when it is still ahead.
    expect(parseResetAt("resets Sunday 9pm", NOW)).toBe(at(21));
  });

  it("resolves the one notice recorded from a live account", () => {
    // 2026-08-23, Amsterdam machine, Amsterdam account. Parked at 18:44
    // local and re-prompted at 19:31:21, which is the 19:30 reset plus the
    // 60s default margin, found on the next 30s tick. This is the case the
    // whole feature exists for, so it gets its own assertion rather than
    // living only in the wording list above.
    const seenAt = new Date(2026, 7, 23, 18, 44, 0).getTime();
    expect(parseResetAt(
      "You've hit your session limit · resets 7:30pm (Europe/Amsterdam)",
      seenAt,
    )).toBe(new Date(2026, 7, 23, 19, 30, 0).getTime());
  });

  it("prefers an explicit unix timestamp over any clock on the line", () => {
    const secs = Math.floor(NOW / 1000) + 3600;
    expect(parseResetAt(`Claude AI usage limit reached|${secs}`, NOW)).toBe(secs * 1000);
  });

  it("only reads a clock anchored to the word reset", () => {
    // "3pm" belonging to some other sentence is not a reset time.
    expect(parseResetAt("the meeting is at 3pm, you have hit your limit", NOW)).toBeNull();
    expect(parseResetAt("usage limit reached", NOW)).toBeNull();
  });

  it("refuses a parse that lands in the past or absurdly far ahead", () => {
    const past = Math.floor(NOW / 1000) - 3600;
    expect(parseResetAt(`limit reached|${past}`, NOW)).toBeNull();
    const farOff = Math.floor((NOW + MAX_WAIT_MS + 60_000) / 1000);
    expect(parseResetAt(`limit reached|${farOff}`, NOW)).toBeNull();
  });

  it("refuses nonsense clocks rather than clamping them", () => {
    expect(parseResetAt("resets 25:00", NOW)).toBeNull();
    expect(parseResetAt("resets 13pm", NOW)).toBeNull();
    expect(parseResetAt("resets 3:99pm", NOW)).toBeNull();
    // A bare number is not a clock: "resets in 5" says nothing actionable.
    expect(parseResetAt("resets in 5", NOW)).toBeNull();
    expect(parseResetAt("", NOW)).toBeNull();
  });
});

describe("findWaitOption", () => {
  const MENU = [
    "You've hit your limit · resets 3pm",
    "",
    "❯ 1. Stop and wait for limit to reset",
    "  2. Upgrade your plan",
  ];

  it("selects the wait row and submits it", () => {
    const c = findWaitOption(MENU);
    expect(c).not.toBeNull();
    // Cursor is already on it: no arrows, just the Enter.
    expect(c!.nav).toEqual([]);
    expect(c!.submit).toEqual(KEY_ENTER);
    expect(c!.label).toBe("Stop and wait for limit to reset");
  });

  it("walks down to the wait row when the cursor starts above it", () => {
    const c = findWaitOption([
      "❯ 1. Continue with usage credits",
      "  2. Wait until your limit resets",
    ]);
    expect(c!.nav).toEqual(KEY_DOWN);
    expect(c!.label).toBe("Wait until your limit resets");
  });

  it("walks up, by as many rows as it takes", () => {
    const c = findWaitOption([
      "  1. Stop and wait for limit to reset",
      "  2. Upgrade your plan",
      "❯ 3. Buy usage credits",
    ]);
    expect(c!.nav).toEqual([...KEY_UP, ...KEY_UP]);
  });

  it("reads rows inside a drawn box", () => {
    const c = findWaitOption([
      "│ ❯ 1. Stop and wait for limit to reset   │",
      "│   2. Upgrade your plan                  │",
    ]);
    expect(c!.nav).toEqual([]);
    expect(c!.label).toBe("Stop and wait for limit to reset");
  });

  // ── The refusals. Each of these is a case where acting would be worse
  // than the status quo, which is "the user answers the prompt themselves".

  it("never selects a row that costs money, even when it also says wait", () => {
    expect(findWaitOption([
      "❯ 1. Upgrade your plan",
      "  2. Wait for the limit to reset, or add credits",
    ])).toBeNull();
  });

  it("refuses when no row is identifiably the wait option", () => {
    expect(findWaitOption([
      "❯ 1. Upgrade your plan",
      "  2. Switch to a Console account",
    ])).toBeNull();
  });

  it("refuses when nothing marks the current row", () => {
    // Without a marker the cursor position is a guess, and a guess here
    // sends arrow keys blind.
    expect(findWaitOption([
      "  1. Stop and wait for limit to reset",
      "  2. Upgrade your plan",
    ])).toBeNull();
  });

  it("refuses a single-row list and a screen with no menu at all", () => {
    expect(findWaitOption(["❯ 1. Stop and wait for limit to reset"])).toBeNull();
    expect(findWaitOption(["You've hit your limit · resets 3pm", ""])).toBeNull();
    expect(findWaitOption([])).toBeNull();
  });

  it("refuses a numbered list that is not numbered 1..n in order", () => {
    // Prose the agent wrote, not a menu it is blocking on.
    expect(findWaitOption([
      "❯ 2. Stop and wait for limit to reset",
      "  4. Upgrade your plan",
    ])).toBeNull();
  });

  it("reads the live prompt, not an earlier numbered list in the scrollback", () => {
    // The agent had printed its own list before the limit hit. Splicing the
    // two would count the arrow presses against the wrong block.
    const c = findWaitOption([
      "Here is what I will do:",
      "  1. Refactor the parser",
      "  2. Add the tests",
      "",
      "You've hit your limit · resets 3pm",
      "  1. Upgrade your plan",
      "❯ 2. Stop and wait for limit to reset",
    ]);
    expect(c).not.toBeNull();
    expect(c!.nav).toEqual([]);
    expect(c!.label).toBe("Stop and wait for limit to reset");
  });

  it("does not drive a prose list on its own", () => {
    expect(findWaitOption([
      "Here is what I will do:",
      "❯ 1. Wait for the build to reset the cache",
      "  2. Add the tests",
    ])).not.toBeNull();
    // ...which is why the caller only ever runs this after a limit notice
    // matched. Documented in TerminalPane; asserted here so the coupling is
    // visible rather than assumed: this function is NOT a limit detector.
  });
});

describe("planLimitPark", () => {
  const MARGIN = 60_000;
  const MENU = [
    "❯ 1. Stop and wait for limit to reset",
    "  2. Upgrade your plan",
  ];

  it("answers the menu and parks on the printed reset plus the margin", () => {
    const plan = planLimitPark("You've hit your limit · resets 3pm", MENU, NOW, MARGIN);
    expect(plan).not.toBeNull();
    expect(plan!.choice?.label).toBe("Stop and wait for limit to reset");
    expect(plan!.resumeAt).toBe(at(15) + MARGIN);
    expect(plan!.estimated).toBe(false);
  });

  it("falls back to the screen for the clock when the notice has none", () => {
    const plan = planLimitPark("Claude usage limit reached", [
      "Claude usage limit reached",
      "Resets at 2pm",
      ...MENU,
    ], NOW, MARGIN);
    expect(plan!.resumeAt).toBe(at(14) + MARGIN);
    expect(plan!.estimated).toBe(false);
  });

  it("parks on the fallback, flagged as estimated, when no clock is printed", () => {
    // Acting on a guess is right here (the menu is real and blocking), but
    // the UI has to be able to say it is a guess.
    const plan = planLimitPark("Claude usage limit reached", MENU, NOW, MARGIN);
    expect(plan!.estimated).toBe(true);
    expect(plan!.resumeAt).toBe(NOW + FALLBACK_WAIT_MS + MARGIN);
  });

  it("parks with no menu when the notice carries a clock but nothing is prompting", () => {
    // Already answered, or a wording that does not prompt. The re-prompt is
    // then the whole job.
    const plan = planLimitPark("You've hit your limit · resets 3pm", ["some other output"], NOW, MARGIN);
    expect(plan!.choice).toBeNull();
    expect(plan!.resumeAt).toBe(at(15) + MARGIN);
  });

  it("returns null when there is neither a menu nor a clock", () => {
    // The caller reads this as "look again", and after the last tick as "do
    // nothing" - which is the right answer for a line that merely talked
    // about a usage limit.
    expect(planLimitPark("Claude usage limit reached", ["still painting"], NOW, MARGIN)).toBeNull();
  });

  it("still parks on the clock when the menu is one it refuses to drive", () => {
    // The money guard kills the menu answer, NOT the wait: the reset time is
    // real either way, and leaving the prompt for the user is the point.
    const plan = planLimitPark("You've hit your limit · resets 3pm", [
      "❯ 1. Upgrade your plan",
      "  2. Switch to a Console account",
    ], NOW, MARGIN);
    expect(plan!.choice).toBeNull();
    expect(plan!.resumeAt).toBe(at(15) + MARGIN);
  });
});
