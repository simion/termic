// Subscription usage in the task footer (GH #277).
//
// Two numbers per account, a fill bar, and the agent's own brand icon. It sits
// immediately left of the sandbox status, which stays the rightmost item, and
// it shares that row with the "N blocked" chip, so it is deliberately terse.
// The detail lives in a popover, which is a CLICK: the numbers are what you
// read at a glance, the reset clocks are what you go looking for.
//
// Where the numbers come from differs per agent and is invisible here: claude
// pushes them through its status line on every turn, codex is asked over
// JSON-RPC. See docs/ideas/usage-footer.md.

import { useEffect } from "react";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import * as ipc from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useAgentUsage, type UsageEntry } from "@/store/agentUsage";
import {
  formatPercent, formatReset, usageLevel, drivingWindow,
  USAGE_WARN_PERCENT, USAGE_CRITICAL_PERCENT,
  type UsageLevel, type UsageWindow,
} from "@/lib/agentUsage";
import { builtinBaseId, agentDisplayName } from "@/lib/agents";
import { useApp } from "@/store/app";

/** How long a codex reading stands before the chip asks again.
 *
 *  Each refresh SPAWNS `codex app-server` and waits for a cold start, so this
 *  is not a poll interval to tune downwards. It is a ceiling on staleness for
 *  the one visible task; claude pays nothing for the equivalent because its
 *  status line pushes on every turn. */
const CODEX_REFRESH_MS = 120_000;

/** A reading older than this is called out as stale, with its age. The claude
 *  feed only speaks while a turn runs, so a task sitting idle overnight would
 *  otherwise present last night's number as current. */
const STALE_AFTER_MS = 15 * 60_000;

export function UsageChip({ agentId, docker, visible }: {
  /** The agent ENTRY id (a clone keeps its own), which is the account key. */
  agentId: string;
  /** Is this task caged in Docker? Its codex logs in INSIDE the container, so
   *  its quota belongs to the config dir termic mounts there, not to the
   *  host's `~/.codex`. Reporting the host's would put another account's
   *  number under this task's name. */
  docker: boolean;
  /** Whether this task is the one on screen. Panes stay MOUNTED when hidden
   *  (they are display:none, never visibility:hidden), so without this every
   *  open task would spawn its own app-server on the same timer. */
  visible: boolean;
}) {
  const entry = useAgentUsage(s => s.byAgent[agentId]);
  const agents = useApp(a => a.agents);
  // A clone of codex runs codex, so the base decides the transport, not the
  // entry id. `docker.rs` documents the same distinction on the Rust side.
  const isCodex = builtinBaseId(agentId, agents) === "codex";

  // codex only. claude arrives on its own through the terminal, and asking it
  // as well would spend a request to learn what it already told us.
  useEffect(() => {
    if (!isCodex || !visible) return;
    let cancelled = false;
    const ask = () => {
      ipc.agentUsageCodex(agentId, docker)
        .then(u => {
          if (cancelled) return;
          // `report` bails on an unchanged reading, so a refresh that moved
          // nothing costs no store write and no re-render.
          useAgentUsage.getState().report(agentId, { session: u.session, weekly: u.weekly }, "rpc");
        })
        // No banner: codex may not be installed, may not be logged in, or may
        // be an older build without the method, and none of those is worth
        // interrupting anyone over a footer number. But it is LOGGED, because
        // a silently swallowed failure here is exactly how a release shipped
        // with the chip never appearing for codex at all (the packaged app's
        // PATH could not find the binary, and nothing anywhere said so).
        .catch(err => console.warn("[usage] codex refused:", agentId, err));
    };
    ask();
    const id = window.setInterval(ask, CODEX_REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [agentId, docker, isCodex, visible]);

  // Nothing known yet: render nothing at all rather than a placeholder. An
  // account that has not spoken has no honest number to show, and a row of
  // dashes in the footer reads as a broken feature rather than a quiet one.
  if (!entry || (!entry.session && !entry.weekly)) return null;

  const stale = Date.now() - entry.updatedAt > STALE_AFTER_MS;
  // The bar tracks the window closest to its limit, which is not always the
  // session one: 30% of five hours next to 95% of the week has to read as a
  // warning, not as comfort. `drivingWindow` is where that is decided.
  const driver = drivingWindow(entry)!;
  const level = usageLevel(driver.window.usedPercent);
  const iconId = resolveIconId(agentId, agents);

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="usage-chip"
          // The values the chip is CLAIMING, so a spec asserts the number the
          // user reads rather than the store field behind it. Percentages are
          // rounded here exactly as they are rendered.
          data-usage-agent={agentId}
          data-usage-session={entry.session ? String(Math.round(entry.session.usedPercent)) : ""}
          data-usage-weekly={entry.weekly ? String(Math.round(entry.weekly.usedPercent)) : ""}
          data-usage-source={entry.source}
          data-usage-level={level}
          title={`${agentDisplayName(agentId, agents)} plan usage`}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 tabular-nums",
            "hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]",
            stale ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg-dim)]",
          )}
        >
          {/* The agent's own brand icon, not a generic gauge. Two DIFFERENT
              agents are told apart right here without reading a word, which a
              gauge could never do; two accounts of the SAME agent are told
              apart in the popover. Sized to the sandbox status icon beside it
              rather than to the 3.5 the text sits at, because a brand mark at
              3.5 is a smudge. */}
          <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
            <CliIcon cli={iconId} className="h-4 w-4" />
          </span>
          <UsageBar percent={driver.window.usedPercent} level={level} stale={stale} />
          {/* Two fixed labels rather than one adaptive string: the footer must
              not reflow as the numbers tick, and "58% 5h" next to "41% wk" is
              read as two things at a glance where "58/41" is read as neither.
              The DRIVING window's number takes the colour too, so a red bar is
              never ambiguous about which of the two it means. */}
          {entry.session && (
            <span className={driver.label === "5h" ? LEVEL_TEXT[level] : undefined}>
              {formatPercent(entry.session)} <Unit>5h</Unit>
            </span>
          )}
          {entry.session && entry.weekly && <span className="text-[var(--color-fg-faint)]">·</span>}
          {entry.weekly && (
            <span className={driver.label === "wk" ? LEVEL_TEXT[level] : undefined}>
              {formatPercent(entry.weekly)} <Unit>wk</Unit>
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-72 p-0"
        // Nothing in here is interactive, so taking focus would be pure theft:
        // the user is typing at an agent, and Radix's default is to move focus
        // into the panel on open. Escape still closes it (the dismissable
        // layer listens on the document), and the caret never leaves the
        // terminal. Same reasoning on the way out.
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <UsageDetail agentId={agentId} entry={entry} level={level} driver={driver} />
      </PopoverContent>
    </PopoverRoot>
  );
}

/** The popover: everything the chip has to leave out, laid out as ROWS.
 *
 *  This was a tooltip first, and a tooltip renders a multi-line string as one
 *  run of prose ("Session window: 19% used, resets 17:00 Weekly window: 14%
 *  used, resets Wed 10:00 Reported by the agent as it works."), which is
 *  unreadable at exactly the moment you went looking for it. Rows, a bar per
 *  window, and the reset clock in its own column. */
function UsageDetail({ agentId, entry, level, driver }: {
  agentId: string;
  entry: UsageEntry;
  level: UsageLevel;
  driver: { window: UsageWindow; label: "5h" | "wk" };
}) {
  const agents = useApp(a => a.agents);
  const iconId = resolveIconId(agentId, agents);
  const age = Date.now() - entry.updatedAt;
  const stale = age > STALE_AFTER_MS;
  const display = agentDisplayName(agentId, agents);

  return (
    <div data-testid="usage-detail" className="text-[12.5px]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-2">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
          <CliIcon cli={iconId} className="h-4 w-4" />
        </span>
        <span className="truncate font-medium text-[var(--color-fg)]">{display}</span>
        {/* The ACCOUNT, spelled out, when it is not just the agent's own name.
            Two clones of one agent put two chips in the window with two
            different numbers, and this is the only place that says which
            login each belongs to. */}
        {display !== agentId && (
          <span className="ml-auto shrink-0 truncate text-[var(--color-fg-faint)]">{agentId}</span>
        )}
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        <UsageRow label="Session" sub="rolling 5 hours" window={entry.session}
          driving={driver.label === "5h"} level={level} source={entry.source} />
        <UsageRow label="Weekly" sub="rolling 7 days" window={entry.weekly}
          driving={driver.label === "wk"} level={level} source={entry.source} />
      </div>

      <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[var(--color-fg-faint)]">
        {level !== "normal" && (
          <div className={cn("mb-1", LEVEL_TEXT[level])}>
            Over {level === "critical" ? USAGE_CRITICAL_PERCENT : USAGE_WARN_PERCENT}% of the{" "}
            {driver.label === "5h" ? "session" : "weekly"} limit.
          </div>
        )}
        {/* Where it came from, and how old. Both matter: the claude feed only
            speaks while a turn runs, so a number can be hours stale and look
            exactly like a fresh one. */}
        <div>
          {entry.source === "statusline"
            ? "Reported by the agent as it works."
            : "Read from codex in the background."}
          {stale ? ` Last updated ${describeAge(age)} ago.` : ""}
        </div>
      </div>
    </div>
  );
}

/** One window: name, percentage, its own full-width bar, and when it resets. */
function UsageRow({ label, sub, window: w, driving, level, source }: {
  label: string;
  sub: string;
  window: UsageWindow | null;
  /** Is this the window the chip's colour is about? Only that one is coloured
   *  here too, so the popover and the footer never disagree. */
  driving: boolean;
  level: UsageLevel;
  /** Which transport reported it. Decides what a MISSING window means, and
   *  the two meanings are not interchangeable. */
  source: UsageEntry["source"];
}) {
  // A window that is not here. Said in WORDS, because an omitted row reads as
  // a rendering bug, and the wording has to match the REASON.
  //
  // For codex it is a plan fact: a free plan genuinely has no session window
  // and never will, so "on this plan" is the useful thing to say.
  //
  // For claude it is never a plan fact. Claude always has both windows, so a
  // missing one means this particular payload did not carry it: measured, a
  // `used_percentage` of null (or a null `five_hour`) drops the window, and
  // the likely moment for that is just after the window resets. Telling a
  // Claude Max user their plan has no session limit is simply wrong, and it
  // is what this said until someone read it on their own screen.
  if (!w) {
    return (
      <div className="flex items-baseline justify-between text-[var(--color-fg-faint)]">
        <span>{label}</span>
        <span>{source === "rpc" ? "not reported on this plan" : "not in the last report"}</span>
      </div>
    );
  }
  const rowLevel = driving ? level : "normal";
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[var(--color-fg)]">{label}</span>
        <span className={cn("tabular-nums", LEVEL_TEXT[rowLevel] ?? "text-[var(--color-fg-dim)]")}>
          {formatPercent(w)}
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-3)]">
        <div
          className={cn("h-full rounded-full", LEVEL_FILL[rowLevel])}
          style={{ width: `${Math.max(2, Math.round(w.usedPercent))}%` }}
        />
      </div>
      <div className="mt-1 flex items-baseline justify-between text-[var(--color-fg-faint)]">
        <span>{sub}</span>
        <span>{formatReset(w) || "reset time not reported"}</span>
      </div>
    </div>
  );
}

/** Fill colour per level. Tokens only: a hex outside `@theme` in index.css is
 *  a theme that cannot be themed (CLAUDE.md).
 *
 *  `normal` is NEUTRAL, not green. This number only goes up, so green is not
 *  good news, and a window of green bars trains you to ignore the one that
 *  turns amber. */
const LEVEL_FILL: Record<UsageLevel, string> = {
  normal:   "bg-[var(--color-fg-faint)]",
  warn:     "bg-[var(--color-warn)]",
  critical: "bg-[var(--color-err)]",
};

/** Text colour for the driving window's percentage. `normal` is undefined so
 *  it inherits, which is what keeps the quiet case quiet. */
const LEVEL_TEXT: Record<UsageLevel, string | undefined> = {
  normal:   undefined,
  warn:     "text-[var(--color-warn)]",
  critical: "text-[var(--color-err)]",
};

/**
 * The chip's fill bar.
 *
 * FIXED width, always, whatever the number: the track is the same width at 3%
 * and at 97%, and only the fill inside it moves. A bar sized to its value
 * would reflow the two percentages and the sandbox status beside it on every
 * turn, which in this footer is a visible twitch rather than a layout detail.
 *
 * No transition either. The value changes about once per turn, seconds apart,
 * so an animation has nothing to smooth: it would only ever be caught
 * mid-flight by a screenshot or by someone glancing over.
 */
function UsageBar({ percent, level, stale }: {
  percent: number; level: UsageLevel; stale: boolean;
}) {
  return (
    <span
      aria-hidden
      // 8px tall in a 36px (`h-9`) footer, and 56px wide. Sized to be READ at a
      // glance from across the desk rather than to be tidy: a 4px hairline is
      // the kind of thing you only notice once you already know it is there,
      // which defeats the point of putting a bar next to a number that is
      // already written out in words.
      className="h-2 w-14 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-3)]"
    >
      <span
        data-testid="usage-bar-fill"
        className={cn("block h-full rounded-full", LEVEL_FILL[level], stale && "opacity-50")}
        // Width is genuinely dynamic, so it cannot be a Tailwind class. The
        // value was clamped to 0-100 on the way in, and is never a string from
        // the payload.
        //
        // Floored at 2% so a barely-used account still shows a sliver: an
        // empty track is indistinguishable from a bar that failed to render,
        // and the exact figure is spelled out in words right beside it.
        style={{ width: `${Math.max(2, Math.round(percent))}%` }}
      />
    </span>
  );
}

/** The unit beside a percentage, one step dimmer than the number.
 *
 *  The number is the DATA and the unit is the label, and at 12.5px in a footer
 *  they otherwise read as one four-character word. Its own explicit colour, so
 *  it stays quiet even inside a percentage that has gone amber or red: a unit
 *  is never the thing that turned urgent. */
function Unit({ children }: { children: string }) {
  return <span className="text-[var(--color-fg-faint)]">{children}</span>;
}

function describeAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
