// Subscription usage: the OSC body claude's termic status line writes, and the
// parser for it (GH #277).
//
// This is the claude half of the usage feed. The codex half needs no wire
// format at all: `agent_usage.rs` asks `codex app-server` for the numbers over
// JSON-RPC and returns them typed, so there is nothing to parse out of a
// terminal. See docs/ideas/usage-footer.md for why the two providers get
// different transports.
//
// The status line is NOT a hook, but it rides the hook channel: same OSC 777
// `notify`, same trusted `termic` title, same three-target write. It is told
// apart from every other signal on that channel by this prefix alone, which is
// why the prefix must never be a prefix of, or prefixed by, HOOK_OSC_BODY or
// HOOK_OSC_READY_BODY.
//
// KEEP IN SYNC with `agent_hooks::USAGE_BODY_PREFIX` and
// `agent_hooks::statusline_body()`. Both sides pin the literal in their own
// test, because a string cannot be shared across the language boundary.
//
// The body also carries SESSION COST in USD, as a fifth field. Only claude
// sends it: codex answers plan limits over JSON-RPC and its own spend data is
// a token count, which would need a per-model price table to become dollars.
// Changing the script means bumping `agent_hooks::SCHEMA_VERSION`, or existing
// installs keep the old one forever.

import { i18n } from "@/lib/i18n";
/** Prefix of the body that reports subscription usage. */
export const USAGE_BODY_PREFIX = "usage ";

/** One rolling limit window. Percentages are 0-100 as the provider reports
 *  them; `resetsAt` is a Unix epoch in SECONDS, or null when unknown. */
export interface UsageWindow {
  usedPercent: number;
  resetsAt: number | null;
}

/** What an UNCAPPED plan has used this billing period. devin Enterprise is
 *  billed in ACUs with no quota, so it has no percentage to show and this is
 *  the whole readout. Never set alongside a window (agent_usage.rs). */
export interface PeriodConsumption {
  amount: number;
  /** What `amount` counts, e.g. `ACU`. */
  unit: string;
  /** Unix epoch SECONDS, or null when the provider did not say. */
  periodStart: number | null;
  periodEnd: number | null;
}

/** What one account has spent. Either window can be absent: codex on a free
 *  plan reports a single 30-day window and no second one at all, so a UI that
 *  assumes two columns renders an empty one. */
export interface AgentUsage {
  /** What this claude SESSION has cost so far, in USD, straight from the
   *  status line's `cost.total_cost_usd` (GH #277 follow-up).
   *
   *  `null` when the agent did not report one. Only claude does: codex answers
   *  plan limits over JSON-RPC and its own spend data is a token count, not
   *  dollars, and converting that would mean shipping a per-model price table
   *  that goes silently wrong the day prices move.
   *
   *  CUMULATIVE FOR ONE SESSION, not a delta. It resets to zero when the agent
   *  restarts, which is why the store banks it rather than summing readings
   *  (see `store/agentUsage.ts`). */
  sessionCostUsd: number | null;
  /** The short window. 5 hours for claude; whatever codex reports as the
   *  shorter of its two. */
  session: UsageWindow | null;
  /** The long window. 7 days for claude. */
  weekly: UsageWindow | null;
  /** Consumption on a plan with no cap. Only the pull transports set it. */
  consumed?: PeriodConsumption | null;
}

/** A money field: any non-negative number, unclamped.
 *
 *  Separate from `field` because that one is written for PERCENTAGES and its
 *  caller clamps to 100. Dollars have no ceiling, and clamping spend at 100
 *  would silently cap the number the moment it mattered most. */
function money(raw: string | undefined): number | null {
  if (!raw || raw === "-") return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** One space-separated field: a number, or `-` for "the agent did not say".
 *
 *  Deliberately strict. The body is an agent-controlled string that reaches a
 *  render path, and `Number("")` is 0, which would paint a confident 0% over a
 *  field that was actually missing. */
function field(raw: string | undefined): number | null {
  if (!raw || raw === "-") return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a trusted `usage …` body, or null when it is not one.
 *
 * Wire format, five space-separated fields after the prefix:
 *
 *     usage <5h percent> <7d percent> <5h resets_at> <7d resets_at> <cost usd>
 *
 * with `-` standing in for any field the payload did not carry. A percentage
 * that fails to parse drops its whole window rather than defaulting, so an
 * unreadable payload shows nothing instead of showing a wrong number.
 *
 * Cost is the FIFTH field and was appended, never inserted: a running app with
 * an older status line installed sends four fields, and reading a missing
 * fifth as absent is exactly right. The reverse also holds, which is what lets
 * the script be upgraded independently of the app.
 */
export function parseUsageBody(body: string): AgentUsage | null {
  if (!body.startsWith(USAGE_BODY_PREFIX)) return null;
  const parts = body.slice(USAGE_BODY_PREFIX.length).trim().split(/\s+/);
  const [fh, sd, fhr, sdr, cost] = parts;
  const fhPct = field(fh);
  const sdPct = field(sd);
  const usd = money(cost);
  // Cost ALONE is a valid reading: an API-key account has no plan windows at
  // all, and it is the account this field exists for.
  if (fhPct === null && sdPct === null && usd === null) return null;
  return {
    session: fhPct === null ? null : { usedPercent: clamp(fhPct), resetsAt: field(fhr) },
    weekly: sdPct === null ? null : { usedPercent: clamp(sdPct), resetsAt: field(sdr) },
    sessionCostUsd: usd,
  };
}

/** Percentages are rendered into a fixed-width bar, so a provider reporting
 *  101 must not overflow it. */
function clamp(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Are two usage readings the same? Used to bail before writing an unchanged
 *  value through a store setter, which the status line would otherwise do on
 *  every single turn (docs/performance.md bear trap 8). */
export function sameUsage(a: AgentUsage | undefined, b: AgentUsage | undefined): boolean {
  if (!a || !b) return a === b;
  return sameWindow(a.session, b.session)
    && sameWindow(a.weekly, b.weekly)
    // Cost moves on turns where neither percentage does (it changes by cents
    // while a window stays on the same whole number), so leaving it out of the
    // comparison would bail on exactly the writes worth making.
    && a.sessionCostUsd === b.sessionCostUsd
    && sameConsumption(a.consumed ?? null, b.consumed ?? null);
}

function sameConsumption(a: PeriodConsumption | null, b: PeriodConsumption | null): boolean {
  if (!a || !b) return a === b;
  return a.amount === b.amount && a.unit === b.unit
    && a.periodStart === b.periodStart && a.periodEnd === b.periodEnd;
}

/** `70.6 ACU` under a hundred, `1234 ACU` from there: a tenth is worth
 *  watching early in a period and is only chip reflow later. */
export function formatConsumed(c: PeriodConsumption | null | undefined): string {
  if (!c || !Number.isFinite(c.amount)) return "";
  const n = c.amount < 100 ? c.amount.toFixed(1) : String(Math.round(c.amount));
  return `${n} ${c.unit}`;
}

/** "Aug 20 to Sep 20" for the popover, or "" when either bound is unknown. */
export function formatPeriod(c: PeriodConsumption | null | undefined): string {
  if (!c || c.periodStart == null || c.periodEnd == null) return "";
  const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day(c.periodStart)} to ${day(c.periodEnd)}`;
}

function sameWindow(a: UsageWindow | null, b: UsageWindow | null): boolean {
  if (!a || !b) return a === b;
  return a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt;
}

/**
 * Money, the way the user asked to read it: `$3.42` under ten dollars, `$42`
 * at or above it.
 *
 * Two decimals matter while the number is small, because that is where the
 * interesting movement is: watching a session tick from $0.40 to $0.85 is the
 * whole point, and `$0` for both would be useless. Past ten dollars the cents
 * are noise in a footer, and dropping them stops the chip reflowing every few
 * seconds as a digit appears and disappears.
 *
 * Never abbreviated. `$1.2k` in a spend readout is the one place a rounded
 * number is actively unwelcome.
 */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "";
  return usd < 10
    ? `$${usd.toFixed(2)}`
    // `Math.round`, not `toFixed(0)`: both round, but going through the
    // locale-free path keeps this free of a thousands separator we did not
    // ask for.
    : `$${Math.round(usd)}`;
}

/** `58%`, or `—` when the window is absent. Rounded, because the footer is a
 *  glance and `14.000000000000002%` is what the provider actually sends. */
export function formatPercent(w: UsageWindow | null): string {
  return w ? `${Math.round(w.usedPercent)}%` : "—";
}

/** "resets 14:00" / "resets Tue 07:00", or "" when the window said nothing.
 *  Tooltip text only: the footer chip itself never reflows on a clock. */
export function formatReset(w: UsageWindow | null): string {
  if (!w || w.resetsAt == null) return "";
  const d = new Date(w.resetsAt * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const today = d.toDateString() === new Date().toDateString();
  return today
    ? `resets ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : `resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ` +
      `${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** Where a percentage stops being background information.
 *
 *  Two thresholds, not a gradient. A bar that drifts through a hue tells you
 *  nothing you were not already reading off the number; what a footer owes you
 *  is the moment the number starts to matter. 70 is "plan the rest of the day
 *  around this", 90 is "you are about to be blocked mid-turn".
 *
 *  Below WARN the bar is deliberately NEUTRAL rather than green. This number
 *  only ever goes up, so a green bar is not good news, it is early news, and a
 *  window of tasks each showing a green bar is noise that trains you to stop
 *  looking at the one that turns amber. */
export const USAGE_WARN_PERCENT = 70;
export const USAGE_CRITICAL_PERCENT = 90;

export type UsageLevel = "normal" | "warn" | "critical";

export function usageLevel(usedPercent: number): UsageLevel {
  if (usedPercent >= USAGE_CRITICAL_PERCENT) return "critical";
  if (usedPercent >= USAGE_WARN_PERCENT) return "warn";
  return "normal";
}

/** Which window the bar and its colour should be about: whichever is CLOSEST
 *  TO ITS LIMIT, not whichever is shorter.
 *
 *  The session window is the one people watch, but it is not always the one
 *  that stops them. 30% of five hours next to 95% of the week is a footer that
 *  has to say "week", or it reports a comfortable number right up until the
 *  turn that fails. Returns null only when neither window was reported. */
export function drivingWindow(u: AgentUsage): { window: UsageWindow; label: "5h" | "wk" } | null {
  const s = u.session ? { window: u.session, label: "5h" as const } : null;
  const w = u.weekly ? { window: u.weekly, label: "wk" as const } : null;
  if (!s) return w;
  if (!w) return s;
  return w.window.usedPercent > s.window.usedPercent ? w : s;
}

/** The short window's name, per agent. claude and codex roll over in hours;
 *  devin's quota is a daily reset, so calling it "5h" would misname the one
 *  number the footer leads with. The "wk" half needs no per-agent word: both
 *  report a weekly window. */
export function shortWindowWords(baseId: string): {
  chip: string; label: string; sub: string; limit: string;
} {
  // copilot's quota is MONTHLY and its only window, so it rides the short
  // slot (agent_usage.rs files it there) and has to say so here.
  if (baseId === "copilot") return { chip: "mo", label: "Monthly", sub: "resets monthly", limit: "monthly" };
  return baseId === "devin"
    ? { chip: "day", label: "Daily", sub: "resets daily", limit: "daily" }
    : { chip: "5h", label: "Session", sub: "rolling 5 hours", limit: "session" };
}

/** Who owns claude's `statusLine` slot for a given task, from
 *  `agent_hooks::status_line_owner`. */
export interface StatusLineOwner {
  owner: "termic" | "project" | "project-local" | "user" | "none";
  path: string;
  command: string;
}

/** Is this owner one that STOPS termic's usage feed running? */
export function blocksUsageFeed(o: StatusLineOwner | null): boolean {
  return !!o && o.owner !== "termic" && o.owner !== "none";
}

/** One sentence naming what is in the way, in the user's own terms. */
export function blockedReason(o: StatusLineOwner): string {
  switch (o.owner) {
    case "project":
      return i18n.t("backend:agentUsage.statusProject");
    case "project-local":
      return i18n.t("backend:agentUsage.statusProjectLocal");
    case "user":
      return i18n.t("backend:agentUsage.statusUser");
    default:
      return "";
  }
}

/** A prompt to hand to the agent whose status line is in the way.
 *
 *  The point is that the user does not have to understand the wire format to
 *  fix this: they paste this at the agent that owns the script and it does
 *  the edit. It is written as instructions rather than as a patch because the
 *  script could be in any language (the reported case was Python behind a
 *  Node shim), and only the file itself knows how it is structured.
 *
 *  Every rule in here is one that makes the difference between working and
 *  silently not: the env guard is what keeps it a no-op for teammates and CI,
 *  the "print nothing extra" rule is because stdout IS the status line, and
 *  the dash convention is what stops a missing field being read as a zero. */
export function statusLineAgentPrompt(o: StatusLineOwner): string {
  return `Add Termic plan-usage reporting to the status line script this project uses.

The status line is configured in ${o.path} and runs:
  ${o.command}

Termic reads Claude's plan usage from the status line, but that slot is taken
by this script, so Termic currently receives nothing and its usage indicator
stays empty. Teach this script to report it as well. Do not change what it
prints.

The script already receives Claude's status line JSON on stdin. From that JSON
read:
  rate_limits.five_hour.used_percentage     (0-100)
  rate_limits.seven_day.used_percentage     (0-100)
  rate_limits.five_hour.resets_at           (Unix epoch SECONDS)
  rate_limits.seven_day.resets_at           (Unix epoch SECONDS)
  cost.total_cost_usd                       (dollars, may have decimals)

NOTE the path on that last one: it is NESTED under a top-level "cost" object,
NOT at the top level. Reading it as payload["total_cost_usd"] finds nothing and
reports no cost, for ever, which is the single easiest way to get this wrong.

Then, ONLY when both TERMIC_PTY and TERMIC_TASK_ID are set in the environment,
open the file named by $TERMIC_PTY and write exactly this, with no newline:

  \\033]777;notify;termic;usage <5h> <7d> <5hResetsAt> <7dResetsAt> <costUsd>\\007

for example:
  \\033]777;notify;termic;usage 58 41 1788530400 1788937200 0.2231\\007

Rules that matter:
- Write "-" for any of the five values that is missing or is not a number.
  Never substitute 0, which would report a limit as unused or a cost as free.
- Do not round or format the cost. Send the number as it appears; Termic
  decides how to display it.
- Send nothing at all only when ALL of the percentages and the cost are
  missing. In particular an account with no subscription (an API key, Bedrock,
  Vertex, an enterprise seat) carries NO rate_limits at all, and its cost is
  then the only thing there is to report: a script that stays silent unless it
  sees a percentage reports nothing, ever, on exactly the accounts where the
  cost is the whole point.
- Print NOTHING extra on stdout. Whatever this script prints is what renders in
  the status line, so the sequence must go to $TERMIC_PTY and nowhere else.
- Wrap the write so any failure is ignored. A status line that errors is one
  the user sees fail on every turn.
- The environment guard is required, not optional: with it, this is a complete
  no-op for anyone not running under Termic, including teammates and CI.

Keep the existing output and behaviour byte for byte otherwise.`;
}
