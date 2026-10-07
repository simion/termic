// @vitest-environment node
//
// A fixed wait in the e2e suite has to be a DECISION, not a habit.
//
// `browser.pause(n)` is right in exactly one shape: the thing being waited
// for IS time. Proving something did not happen needs a window for it to fail
// to happen in, and a timer the app itself owns (a debounce, a grace period,
// a survive window) has to be outlasted. Everything else is a condition
// nobody has named yet, and naming it is the difference between a suite that
// is slow and flaky and one that is neither: a duration long enough on a dev
// Mac is a coin flip on a loaded CI runner, and it is slower every run in
// exchange (docs/e2e-tests.md rule 1).
//
// This is a COUNT, deliberately, not a stopwatch. docs/perf-ci.md settles why:
// counts and static facts survive a shared runner and gate a PR honestly,
// while wall-clock numbers flake and get muted. So the gate is "no new fixed
// wait appears without someone writing down why", and the timing report
// (scripts/e2e-slowest.mjs, printed into the CI job summary) is the human
// half that says where the minutes actually go.
//
// Adding one: run it down to a condition first. If it genuinely has to be
// time, bump the count here and say which clock it outlasts.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SPECS = path.join(__dirname, "specs");

/** Fixed waits we have accepted, and the clock each file is outlasting. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "agent.e2e.ts": {
    count: 15,
    why: "work-state timers the cases exist to prove: SURVIVE_MS, the detached "
      + "grace, RESUME_FAILURE_MS, and several 'no badge / no bell / no respawn' "
      + "negatives that need a window to fail in",
  },
  "credentials.e2e.ts": {
    count: 2,
    why: "two negatives: seeding usage must NOT raise the switch offer, and three "
      + "unknown-cost reports must NOT flip the label. Nothing fires for what "
      + "does not render",
  },
  "editor.e2e.ts": {
    count: 3,
    why: "a settle window against IPC still in flight from the case before, plus "
      + "two 'the task did not change' negatives after a shortcut",
  },
  "settings.e2e.ts": {
    count: 1,
    why: "AgentsSection writes its copy 500ms after an edit and the timer outlives "
      + "the page, so the next case has to start past it",
  },
  "sidebar-filter.e2e.ts": {
    count: 2,
    why: "two negatives: the paused project filter's slashed icon must NOT open "
      + "the bar, and a bar a query closed must NOT reopen when the query clears",
  },
  "tabs-layout.e2e.ts": {
    count: 2,
    why: "Ctrl-Tab is asynchronous, so 'the task did not switch' has to be asserted "
      + "after a settle or it passes against the bug too",
  },
  "task.e2e.ts": {
    count: 1,
    why: "a negative: hovering an unlinked task draws no spawn link",
  },
};

function pauseCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of readdirSync(SPECS).filter(f => f.endsWith(".e2e.ts"))) {
    const n = (readFileSync(path.join(SPECS, name), "utf8").match(/browser\.pause\(/g) ?? []).length;
    if (n > 0) out[name] = n;
  }
  return out;
}

// The same rule for WebdriverIO's ELEMENT layer, which is the other way a
// spec gets slow without anyone noticing. Measured on this stack: a
// `browser.execute` round trip is 4ms, while `$(sel).click()` on the
// offscreen window is ~29s (two of them were 58s of one 60s case). Every
// interaction the suite needs has an in-page helper: clickWhenVisible,
// clickPresent, setInputValue, textOf, waitForAttr, waitVisible.
//
// One exception is real and recorded below: moving the REAL pointer. CSS
// `:hover` does not respond to a synthetic event, so a case about a control
// that appears on hover has to drive the actual cursor.
const ELEMENT_CMD_ALLOWED: Record<string, { count: number; why: string }> = {
  "projects.e2e.ts": {
    count: 1,
    why: "`$(sel).moveTo()` parks the REAL pointer off the sidebar; the filter "
      + "bar is revealed by CSS :hover, which a dispatched event cannot drive",
  },
};

describe("element commands in the e2e suite", () => {
  it("has none beyond the ones recorded here", () => {
    const found: Record<string, number> = {};
    const where: string[] = [];
    for (const name of readdirSync(SPECS).filter(f => f.endsWith(".e2e.ts"))) {
      readFileSync(path.join(SPECS, name), "utf8").split("\n").forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//")) return;
        // The CALL: `$("sel")` / `$(`sel`)` / `browser.$$(...)`, or an element
        // method. A `$(FOO)` inside a string (a Makefile fixture) is not one,
        // hence the required quote.
        if (!/(?:^|[^\w.$])\$\$?\(\s*[`'"]|browser\.\$\$?\(|\.waitForExist\(|\.waitForDisplayed\(|\.waitForClickable\(/.test(line)) return;
        found[name] = (found[name] ?? 0) + 1;
        where.push(`${name}:${i + 1}: ${code.slice(0, 80)}`);
      });
    }
    const expected = Object.fromEntries(
      Object.entries(ELEMENT_CMD_ALLOWED).map(([f, { count }]) => [f, count]),
    );
    expect(found, [
      "A WebdriverIO element command was added, removed or moved.",
      `Found: ${where.join(" | ") || "none"}`,
      "They cost ~29s each on this offscreen window; an execute costs 4ms.",
      "Use clickWhenVisible / clickPresent / setInputValue / textOf / waitForAttr,",
      "or record it here with the reason it must drive the real browser.",
      "See docs/e2e-tests.md 'Where the time goes'.",
    ].join("\n")).toEqual(expected);
  });
});

describe("fixed waits in the e2e suite", () => {
  it("has none that nobody wrote down a reason for", () => {
    const found = pauseCounts();
    const expected = Object.fromEntries(
      Object.entries(ALLOWED).map(([f, { count }]) => [f, count]),
    );
    // One assertion over the whole map rather than per file: a wait MOVING
    // between files is the same decision as adding one, and a per-file loop
    // would let it through as a pair of offsetting changes.
    expect(found, [
      "A fixed wait was added, removed or moved.",
      "Waiting for a condition instead? Delete it and update the count here.",
      "Genuinely waiting on time? Update the count and say which clock it outlasts.",
      "See e2e/fixedWaits.test.ts and docs/e2e-tests.md rule 1.",
    ].join("\n")).toEqual(expected);
  });

  it("keeps every fixed wait next to a comment saying why", () => {
    const naked: string[] = [];
    for (const name of readdirSync(SPECS).filter(f => f.endsWith(".e2e.ts"))) {
      const lines = readFileSync(path.join(SPECS, name), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("browser.pause(")) return;
        // A comment in the three lines above it. Cheap, and it is the whole
        // point: the number alone never says which clock it is racing.
        const above = lines.slice(Math.max(0, i - 3), i).join("\n");
        if (!/\/\/|\*/.test(above)) naked.push(`${name}:${i + 1}`);
      });
    }
    expect(naked, "each browser.pause needs a comment above it naming the clock it outlasts")
      .toEqual([]);
  });
});
