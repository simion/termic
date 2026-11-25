// What colour the PR glyph on a task row takes, and whether it is an alarm.
//
// A pure function rather than a ternary chain inside TaskPrBadge, because the
// rules here are easy to break by accident ("a draft never takes a colour",
// "nothing on this glyph is ever the alarm red") and this repo has no
// component-render setup: the choices are a real unit test on a function or a
// regex over the component's source.
//
// NEVER --color-err, deliberately. That is the colour the app uses for "this
// is broken right now". A failing build on an open PR is something to go and
// look at, not a failure of the task the row represents, and a closed PR is
// inert rather than broken. A list dotted with alarm red that you are not
// meant to act on is how you teach someone to stop seeing red at all.
//
// Closed still has to read as closed, though. For a while it was plain faint,
// and with the sidebar's default number-only mark that made a closed PR, a
// draft and a PR nobody has looked up yet the same grey number, told apart
// only by the tooltip. So closed takes its own muted red (--color-pr-closed)
// and a struck-through number: dead, not on fire.

/** The four states `PrStatus.state` can carry, plus "no lookup yet". */
export type PrBadgeState = "open" | "draft" | "merged" | "closed" | null;
export type PrChecks = "none" | "pending" | "passing" | "failing";

export interface PrBadgeAppearance {
  /** A CSS var reference, ready for `style={{ color }}`. */
  color: string;
  /** True only for an OPEN pr whose checks are failing: the one case worth
   *  wording differently in the tooltip. Never set for draft (its checks are
   *  nobody's business yet) or closed (not a build problem). */
  alarming: boolean;
  /** True only for closed-without-merging: its number is drawn struck
   *  through, so it does not rest on the colour alone. */
  struck: boolean;
}

export function prBadgeAppearance(state: PrBadgeState, checks: PrChecks | null): PrBadgeAppearance {
  const failing = checks === "failing";
  switch (state) {
    case "merged":
      // Done. CI at HEAD stops being the thing worth flagging.
      return { color: "var(--color-pr-merged)", alarming: false, struck: false };
    case "closed":
      // Inert, not broken. It used to be --color-err, which said "something
      // needs you here" about a PR that by definition wants nothing; then
      // faint, which made it a draft. Muted red and struck through.
      return { color: "var(--color-pr-closed)", alarming: false, struck: true };
    case "draft":
      // NEVER coloured, whatever the checks say. A draft is work its author
      // has not asked anyone to look at, so its build state is not a signal to
      // anyone else yet. Grey is the whole answer: no red, and no green
      // either, because "passing" on a draft is not an invitation.
      return { color: "var(--color-fg-faint)", alarming: false, struck: false };
    case "open":
      // The glyph is the only PR signal visible without opening the Git tab,
      // so a broken build must not look identical to a healthy one here. Warn,
      // not err: go and look at this, as against this is on fire.
      // Green is a verdict. Checks still running (or required ones not yet
      // reported) have none, and a green number there read as "passed" on a
      // PR whose CI was still going: dim, until they pass or fail.
      if (failing) return { color: "var(--color-warn)", alarming: true, struck: false };
      if (checks === "pending") return { color: "var(--color-fg-dim)", alarming: false, struck: false };
      return { color: "var(--color-pr-open)", alarming: false, struck: false };
    default:
      // A cached `pr_url` with no lookup yet: an identity, not a state.
      return { color: "var(--color-fg-faint)", alarming: false, struck: false };
  }
}
