// Resume an agent that stopped on a subscription usage limit.
//
// A limit does not kill the session, it PARKS it: claude prints the notice and
// then blocks on an interactive menu whose options are, roughly, "stop and wait
// for the limit to reset" and "spend money" (upgrade, or usage credits). Until
// somebody answers that menu the turn is over and nothing else happens, so an
// unattended run started at midnight is still sitting on the same question at
// nine the next morning. Answering it is only half the job: "stop and wait"
// stops, it does not come back, so the session also has to be re-prompted once
// the reset time passes (anthropics/claude-code#18980 asks for that third
// option; until it exists, this is it).
//
// So this module answers four questions, and nothing else:
//   1. is what just went past a usage-limit notice?          looksLikeLimitNotice
//   2. when does the limit reset?                            parseResetAt
//   3. which menu row is the one that does not cost money?   findWaitOption
//   4. so what should happen, given the screen?              planLimitPark
//
// Everything here is pure and takes `now` as a parameter, so the whole thing is
// unit-testable without a terminal, a clock, or a rate-limited account. The
// wiring (arming, verifying against the visible buffer, parking the tab, and
// the re-prompt) lives in TerminalPane; see docs/auto-retry.md.
//
// The one rule that outranks everything else in here: **never select an option
// that spends money.** A false negative parks a tab until the user looks at it,
// which is what happens today anyway. A false positive buys credits on their
// card. Every ambiguous case in this file therefore resolves to "do nothing".

import { compileSignals } from "@/lib/agents";
import { useApp } from "@/store/app";
import type { Agent } from "@/lib/types";

/** Lines that mean "you are out of quota", as the same regex sources a user
 *  would type into Settings. Sources rather than literals for the reason
 *  BUILTIN_TITLE_SIGNALS gives: Settings shows these as the placeholder, so
 *  what actually runs is visible and copyable instead of buried here.
 *
 *  Observed wordings (claude changes these without notice, which is why the
 *  list is patterns and why it is overridable per agent):
 *    "You've hit your limit · resets 3pm (Europe/Dublin)"
 *    "5-hour limit reached ∙ resets 3am"
 *    "Claude usage limit reached. Resets at 2pm"
 *    "Claude AI usage limit reached|1763049600"
 *
 *  Deliberately NOT matched: a bare "rate limit" or "429". Those are the
 *  transient-overload family, which retries on a backoff rather than a clock,
 *  and matching them here would park a tab for five hours over a blip. */
export const BUILTIN_LIMIT_SIGNALS: Record<string, string[]> = {
  claude: [
    "usage limit reached",
    "You'?ve (?:hit|reached) your (?:usage |weekly |session )?limit",
    "\\d+-hour limit reached",
    "(?:weekly|session) limit reached",
  ],
};

/** Limit patterns for an agent: the user's own if they set any, else the
 *  built-ins. Same override shape as every other signal class, so teaching a
 *  non-claude CLI is a Settings edit rather than a patch. */
export function limitPatternsForCli(
  cli: string,
  agents: Agent[] = useApp.getState().agents,
): RegExp[] {
  const user = agents.find(a => a.id === cli)?.capabilities?.signals?.limit;
  return compileSignals(user?.length ? user : BUILTIN_LIMIT_SIGNALS[cli]);
}

/** True when `line` reads like a usage-limit notice. `line` is expected to be
 *  ANSI-stripped and trimmed already (the caller strips, because it is holding
 *  the raw chunk anyway). Total: a user's bad pattern is dropped by
 *  compileSignals rather than thrown from the PTY data path. */
export function looksLikeLimitNotice(line: string, patterns: RegExp[]): boolean {
  if (!line) return false;
  return patterns.some(re => re.test(line));
}

// ── When does it reset? ──────────────────────────────────────────────────

/** Longest wait this will ever schedule. A weekly limit is the real ceiling;
 *  anything past it means the parse went wrong (a version string read as a
 *  clock, a year read as an epoch) and a wrong answer here is a tab that looks
 *  parked forever. Refuse instead. */
export const MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000;

/** Assumed wait when the notice carries no readable reset time. Claude's
 *  included allowance rolls on a 5-hour window, so this lands near the real
 *  reset without pretending to know it. */
export const FALLBACK_WAIT_MS = 5 * 60 * 60 * 1000;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Parse the reset moment out of a limit notice. Returns epoch ms, or null
 *  when the text carries no time this is confident about.
 *
 *  Times are resolved in LOCAL time on purpose, including when the notice
 *  carries a parenthesised zone: claude prints that zone because it is already
 *  rendering the clock in it, so "3pm (Europe/Dublin)" on a Dublin machine is
 *  3pm local. Reading the zone and converting would double-apply the offset for
 *  every user whose machine agrees with their account, which is nearly all of
 *  them. The margin the caller adds on top absorbs the rest.
 *
 *  A bare clock with no date is always read FORWARD: "resets 3am" seen at 11pm
 *  means 3am tomorrow, never 3am twenty hours ago. */
export function parseResetAt(text: string, now = Date.now()): number | null {
  if (!text) return null;

  // Exact form first: the CLI's machine-readable notice carries a unix
  // timestamp after a pipe ("...usage limit reached|1763049600"). No
  // ambiguity to resolve, so it wins over any clock elsewhere in the line.
  const epoch = /\|\s*(\d{10})\b/.exec(text);
  if (epoch) return within(Number(epoch[1]) * 1000, now);

  // Everything else has to be anchored to the word "reset", so a "3pm" that
  // belongs to some other sentence on the line cannot be mistaken for one.
  const anchor = /reset(?:s|ting)?(?:\s+(?:at|on|in))?\b/i.exec(text);
  if (!anchor) return null;
  const window = text.slice(anchor.index + anchor[0].length, anchor.index + anchor[0].length + 48);

  const clock = matchClock(window);
  if (!clock) return null;

  const d = new Date(now);
  d.setHours(clock.hour, clock.minute, 0, 0);

  const weekday = matchWeekday(window);
  if (weekday !== null) {
    // "resets Monday 9am": step to the next occurrence of that weekday. Same
    // weekday but the clock has already gone means next week, not today.
    let delta = (weekday - d.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= now) delta = 7;
    d.setDate(d.getDate() + delta);
  } else if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1);
  }

  return within(d.getTime(), now);
}

/** Reject a parse that lands in the past or absurdly far ahead. */
function within(at: number, now: number): number | null {
  if (!Number.isFinite(at)) return null;
  if (at <= now) return null;
  if (at - now > MAX_WAIT_MS) return null;
  return at;
}

/** First clock in `s`, 12-hour ("3pm", "3:30 pm") or 24-hour ("14:30").
 *  A bare number with no meridiem and no colon is NOT a clock: "resets in 5"
 *  says nothing this should act on. */
function matchClock(s: string): { hour: number; minute: number } | null {
  const twelve = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i.exec(s);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = Number(twelve[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = twelve[3].toLowerCase() === "p";
    if (hour === 12) hour = 0;
    return { hour: pm ? hour + 12 : hour, minute };
  }
  const twentyFour = /\b(\d{1,2}):(\d{2})\b/.exec(s);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

/** Index into WEEKDAYS for the first weekday named in `s`, else null. */
function matchWeekday(s: string): number | null {
  const m = /\b(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|satur?)(?:day)?\b/i.exec(s);
  if (!m) return null;
  const head = m[1].toLowerCase().slice(0, 3);
  const i = WEEKDAYS.findIndex(d => d.startsWith(head));
  return i === -1 ? null : i;
}

// ── Which menu row is safe to pick? ──────────────────────────────────────

/** Rows that cost money. Vetoes a row outright: a row matching any of these is
 *  never selected, even if it also reads like a wait option ("wait, or add
 *  credits" as a single row would be ambiguous, and ambiguous means no). */
const PAID_OPTION = /\b(upgrade|credits?|purchase|buy|billing|bill|pay|paid|subscribe|checkout|\$)\b/i;

/** Rows that stop and wait for the clock. Both halves are required, so a bare
 *  "Stop" or an unrelated "wait" cannot win. */
const WAIT_OPTION = [/\bwait(s|ing)?\b/i, /\b(reset|limit)/i];

/** One parsed row of a select menu. */
export interface MenuOption {
  /** 1-based number as printed. */
  number: number;
  /** The option text, box drawing and marker removed. */
  text: string;
  /** True when the selection marker sits on this row. */
  current: boolean;
}

/** ESC [ B — cursor down. */
export const KEY_DOWN = [0x1b, 0x5b, 0x42];
/** ESC [ A — cursor up. */
export const KEY_UP = [0x1b, 0x5b, 0x41];
/** Carriage return, the submit. */
export const KEY_ENTER = [0x0d];

/** The keystrokes that select the wait option, or null when this must not act.
 *
 *  Null is the common and correct outcome: no menu on screen, a menu whose
 *  rows do not parse, a menu with no identifiable wait row, or a menu whose
 *  wait row also mentions money. The caller does nothing and the user answers
 *  the prompt themselves, exactly as they do today.
 *
 *  `rows` is the visible buffer, top to bottom, ANSI already stripped. */
export function findWaitOption(rows: string[]): {
  /** Arrow keys that move the marker onto the wait row. Empty when it is
   *  already there. Send these, then `submit` a beat later. */
  nav: number[];
  submit: number[];
  /** The row that will be selected, for the log line and the toast. */
  label: string;
} | null {
  // The LAST block wins. A numbered list in the agent's own prose earlier in
  // the viewport must not shadow the live prompt, which is always the newest
  // thing on screen, and splicing two separate lists into one menu would count
  // the arrow presses wrong.
  const options = lastOptionBlock(rows);

  // A real select menu is at least two rows numbered 1..n in order. This is
  // the guard that keeps an enumerated list in the agent's own prose ("1. do
  // this  2. do that") from being driven like a menu.
  if (options.length < 2) return null;
  if (options.some((o, i) => o.number !== i + 1)) return null;

  const cursor = options.findIndex(o => o.current);
  // No marker means the render is not one this understands. Guessing the
  // cursor is at row 0 would send arrow keys blind.
  if (cursor === -1) return null;

  const target = options.findIndex(o =>
    !PAID_OPTION.test(o.text) && WAIT_OPTION.every(re => re.test(o.text)));
  if (target === -1) return null;

  const delta = target - cursor;
  const key = delta > 0 ? KEY_DOWN : KEY_UP;
  const nav: number[] = [];
  for (let i = 0; i < Math.abs(delta); i++) nav.push(...key);
  return { nav, submit: [...KEY_ENTER], label: options[target].text };
}

/** The last run of numbered rows in `rows`. Blank rows do not break a run
 *  (claude pads its menus); any other non-option row does. */
function lastOptionBlock(rows: string[]): MenuOption[] {
  let block: MenuOption[] = [];
  let open: MenuOption[] = [];
  for (const raw of rows) {
    const opt = parseOptionRow(raw);
    if (opt) { open.push(opt); continue; }
    if (!raw.trim()) continue;
    if (open.length) { block = open; open = []; }
  }
  return open.length ? open : block;
}

/** Strip box drawing and the selection marker off one row and read it as a
 *  numbered option. Null when the row is not one. */
function parseOptionRow(raw: string): MenuOption | null {
  const line = raw.replace(/^[\s│┃|╎┆*]+/, "").replace(/[\s│┃|╎┆]+$/, "");
  const m = /^([❯>▶►→]\s*)?(\d{1,2})[.):]\s+(\S.*)$/.exec(line);
  if (!m) return null;
  return { number: Number(m[2]), text: m[3].trim(), current: !!m[1] };
}

// ── Putting it together ──────────────────────────────────────────────────

/** What to do about a limit notice, given what is on screen. */
export interface LimitPark {
  /** Keys that answer the wait-or-pay menu, or null when there is no menu to
   *  answer (already answered, or a wording that does not prompt). */
  choice: { nav: number[]; submit: number[]; label: string } | null;
  /** Wall-clock to re-prompt at, margin included. */
  resumeAt: number;
  /** True when `resumeAt` is FALLBACK_WAIT_MS rather than a printed time.
   *  The UI has to say so: presenting a guess as a printed fact is how a user
   *  learns not to trust the banner. */
  estimated: boolean;
}

/** Decide what a limit notice plus the current screen adds up to.
 *
 *  Returns null for "not yet": neither a menu to answer nor a clock to wait
 *  on. That is the normal result on an early tick, when the menu is still
 *  being painted, and the final result for a line that merely TALKED about a
 *  usage limit. Both want the same thing from the caller, which is to look
 *  again and then drop it.
 *
 *  `rows` is the visible buffer tail, top to bottom, ANSI already stripped.
 *  `notice` is the line that armed the check, kept separate because it may
 *  have scrolled off the rows by the time this runs and it is where the reset
 *  time is printed in every wording recorded so far. */
export function planLimitPark(
  notice: string,
  rows: string[],
  now: number,
  marginMs: number,
): LimitPark | null {
  const parsed = parseResetAt(notice, now)
    ?? rows.map(r => parseResetAt(r, now)).find((t): t is number => t !== null)
    ?? null;
  const choice = findWaitOption(rows);
  if (!choice && parsed === null) return null;
  return {
    choice,
    resumeAt: (parsed ?? now + FALLBACK_WAIT_MS) + marginMs,
    estimated: parsed === null,
  };
}
