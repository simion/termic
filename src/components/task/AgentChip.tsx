// The task footer's agent control: which account it runs as, what that
// account has spent, and one panel behind it (GH #277 + GH #278).
//
// ONE chip, not two. The account pill used to sit immediately left of this
// with its own trigger and its own panel, and its own header said it "forms
// one unit" with the usage chip, because the numbers here are THAT account's
// numbers. Two controls that form one unit are one control: merging them
// answers "which account, and how much is left" in a single click, and
// removed a duplicated auto-switch checkbox that had already caused one
// two-panels-disagree bug.
//
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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { CircleSlash, Copy, Check } from "lucide-react";
import * as ipc from "@/lib/ipc";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils";
import { useAgentUsage, usageKey, costTotal, costChipVisible, firstPollDelay, usageKnown, type UsageEntry } from "@/store/agentUsage";
import { AGENT_HOOKS_HIGHLIGHT } from "@/components/settings/AgentHooksBlock";
import {
  formatPercent, formatReset, formatUsd, formatConsumed, formatPeriod, usageLevel, drivingWindow, shortWindowWords,
  USAGE_WARN_PERCENT, USAGE_CRITICAL_PERCENT,
  blocksUsageFeed, blockedReason, statusLineAgentPrompt,
  type UsageLevel, type UsageWindow, type StatusLineOwner,
} from "@/lib/agentUsage";
import { builtinBaseId, agentDisplayName } from "@/lib/agents";
import { useAgentAccounts, type AgentAccounts } from "@/hooks/useAgentAccounts";
import { useAccountSwitching } from "@/hooks/useAccountSwitching";
import { AccountSwitcher } from "@/components/task/AccountSwitcher";
import { pillVisible } from "@/lib/accountPill";
import { KeyRound, ArrowRightLeft } from "lucide-react";
import { useUsageUnknownDismissed } from "@/store/usageUnknownDismissed";
import type { AgentAccountsView, TerminalTab } from "@/lib/types";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useAgentContext, contextKey, type ContextEntry } from "@/store/agentContext";
import { contextLevel, formatTokens, CONTEXT_WARN_PERCENT, footerSources, footerNeedsHooks, type FooterSources } from "@/lib/agentContext";

/** How long a pulled reading stands before the chip asks again.
 *
 *  Each codex refresh SPAWNS `app-server` and waits for a cold start, so this
 *  is not a poll interval to tune downwards. devin's is one HTTPS call and
 *  could be asked more often, but a quota moves at the speed of agent work,
 *  not of polling. It is a ceiling on staleness for the one visible task;
 *  claude pays nothing for the equivalent because its status line pushes on
 *  every turn. */
const POLL_REFRESH_MS = 120_000;

/** A reading older than this is called out as stale, with its age. The claude
 *  feed only speaks while a turn runs, so a task sitting idle overnight would
 *  otherwise present last night's number as current. */
const STALE_AFTER_MS = 15 * 60_000;

/** One footer chip, for ONE of the agents a task runs (GH #277).
 *
 *  Owns that agent's account state rather than taking it from the footer: with
 *  several agents in one task there is no single "the task's account" to lift
 *  any more, and each chip's numbers are keyed by the login ITS agent process
 *  was spawned with. The pill and the usage numbers still share one fetch,
 *  which was the reason `useAgentAccounts` was lifted in the first place -
 *  they are now the same chip, so the shared owner moved down here with them.
 */
export function FooterAgentChip({ taskId, agentId, cwd, docker, visible, hideClass }: {
  taskId: string;
  agentId: string;
  cwd?: string;
  docker: boolean;
  visible: boolean;
  /** The container-query class that hides this chip once the bar is too
   *  narrow to hold it, from `footerChipMode`. Undefined for the agent whose
   *  tab is on screen, which is never hidden at any width. */
  hideClass: string | undefined;
}) {
  // The account THIS agent's process is running as, which is the running one
  // and not the configured one: a switch applies on the next spawn, so between
  // the click and the restart the two differ.
  //
  // Selected as the string, so this chip re-renders when its own agent
  // restarts on another account and not when a sibling agent changes.
  const liveAccount = useApp(s => {
    const tab = (s.tabs[taskId] || []).find(
      t => t.type === "terminal" && (t as TerminalTab).cli === agentId,
    ) as TerminalTab | undefined;
    // `undefined` when nothing has spawned yet; `null` once a process is
    // running on the agent's ordinary login. The distinction is load-bearing:
    // merging them re-keys a running task's usage the moment the user names
    // their first credential set, and the numbers disappear mid-session.
    return tab && "liveAccount" in tab ? (tab.liveAccount ?? null) : undefined;
  });
  const accounts = useAgentAccounts(taskId, agentId, docker, liveAccount, visible);
  return (
    <AgentChip
      taskId={taskId}
      agentId={agentId}
      cwd={cwd}
      docker={docker}
      accounts={accounts}
      visible={visible}
      className={hideClass}
    />
  );
}

export function AgentChip({ taskId, agentId, cwd, docker, accounts, visible, className }: {
  taskId: string;
  /** The agent ENTRY id (a clone keeps its own). Half of the account key: the
   *  other half is `liveAccount`, because one entry can now hold several
   *  logins (GH #278). */
  agentId: string;
  /** The footer's shared account state. `accounts.account` is the login these
   *  numbers were spent on, which is the RUNNING one and not the configured
   *  one: a switch applies on the next spawn, so between the click and the
   *  restart the two differ. */
  accounts: AgentAccounts;
  /** The task's worktree. A project can ship its own status line, which
   *  outranks the one termic installs, so the answer is per TASK. */
  cwd?: string;
  /** Is this task caged in Docker? Its codex logs in INSIDE the container, so
   *  its quota belongs to the config dir termic mounts there, not to the
   *  host's `~/.codex`. Reporting the host's would put another account's
   *  number under this task's name. */
  docker: boolean;
  /** Whether this task is the one on screen. Panes stay MOUNTED when hidden
   *  (they are display:none, never visibility:hidden), so without this every
   *  open task would spawn its own app-server on the same timer. */
  visible: boolean;
  /** Extra classes for the chip itself. The footer uses it to drop a
   *  SECONDARY agent's chip when the bar is too narrow for every agent the
   *  task runs; there is no wrapper element to hang that on, because an empty
   *  one would still spend a flex gap on a chip that rendered nothing. */
  className?: string;
}) {
  const { t } = useTranslation("task");
  const { account: liveAccount, view: accountsView, refresh: refreshAccounts } = accounts;
  // Per-agent opt-outs from Settings > Agents. Hiding usage also stops the
  // pull transports asking, so a hidden number costs no app-server spawns.
  const hideUsage = usePrefs(s => s.agentFooterHidden[agentId]?.usage === true);
  const hideContext = usePrefs(s => s.agentFooterHidden[agentId]?.context === true);
  const usageEntry = useAgentUsage(s => s.byAgent[usageKey(agentId, liveAccount)]);
  const entry = hideUsage ? undefined : usageEntry;
  // This task's conversation with this agent, from the tab that spoke last.
  const ctxEntry = useAgentContext(s => s.byTaskAgent[contextKey(taskId, agentId)]);
  const ctx = hideContext ? undefined : ctxEntry;
  // Everything this account has spent since termic launched. A NUMBER, not the
  // entry, so this chip re-renders when its own total moves and not when some
  // other account's does.
  const spend = useAgentUsage(s => costTotal(s.cost[usageKey(agentId, liveAccount)]));
  const agents = useApp(a => a.agents);
  // A clone of codex runs codex, so the base decides the transport, not the
  // entry id. `docker.rs` documents the same distinction on the Rust side.
  const base = builtinBaseId(agentId, agents);
  const words = shortWindowWords(base);
  // The pull transports: codex spawns `app-server`, devin POSTs its Connect
  // API. claude needs no ask at all: it pushes through the status line.
  const askUsage = hideUsage ? null
    : base === "codex" ? ipc.agentUsageCodex
    : base === "devin" ? ipc.agentUsageDevin
    : base === "copilot" ? ipc.agentUsageCopilot
    : null;

  // Why the feed cannot run, when it cannot. claude ONLY: it is the only
  // agent whose usage arrives through a status line, so it is the only one
  // that can be shadowed by somebody else's. Asked once, and only while there
  // is nothing to show anyway, so a working feed never pays for it.
  const [detailOpen, setDetailOpen] = useState(false);
  // Held HERE rather than in the panel: the automatic switch fires when an
  // account passes its limit, which is exactly a moment nobody has a panel
  // open. The panel is unmounted most of the time; this chip is not.
  const sw = useAccountSwitching(taskId, agentId, accounts, visible);
  const [owner, setOwner] = useState<StatusLineOwner | null>(null);
  const known = hideUsage || usageKnown(entry, spend);
  useEffect(() => {
    if (base !== "claude" || !visible || !cwd || known) { setOwner(null); return; }
    let cancelled = false;
    ipc.usageStatusLineOwner(agentId, cwd)
      .then(o => { if (!cancelled) setOwner(o); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agentId, base, cwd, visible, known]);

  // The pull transports only. claude arrives on its own through the terminal,
  // and asking it as well would spend a request to learn what it already told
  // us.
  useEffect(() => {
    if (!askUsage || !visible) return;
    let cancelled = false;
    const ask = () => {
      askUsage(agentId, docker, liveAccount)
        .then(u => {
          if (cancelled) return;
          // `report` bails on an unchanged reading, so a refresh that moved
          // nothing costs no store write and no re-render.
          useAgentUsage.getState().report(
            agentId, liveAccount,
            // No cost from the pull transports: they answer plan windows, and
            // the agents' own spend data is token counts and ACUs, not
            // dollars. Turning that into USD would mean a per-model price
            // table in termic, which goes silently wrong the day prices move.
            { session: u.session, weekly: u.weekly, sessionCostUsd: null, consumed: u.consumed ?? null },
            "rpc");
        })
        // No banner: the agent may not be installed, may not be logged in, or
        // may be an older build without the method, and none of those is
        // worth interrupting anyone over a footer number. But it is LOGGED,
        // because a silently swallowed failure here is exactly how a release
        // shipped with the chip never appearing for codex at all (the
        // packaged app's PATH could not find the binary, and nothing anywhere
        // said so).
        .catch(err => console.warn(`[usage] ${base} refused:`, agentId, err));
    };
    // The store entry is per CREDENTIAL and shared by every task on that
    // login, so a task switch usually lands on a number another task already
    // fetched. Read it NON-REACTIVELY: selecting it would re-run this effect
    // on every reading, which resets the interval and defeats the timer.
    const delay = firstPollDelay(
      useAgentUsage.getState().byAgent[usageKey(agentId, liveAccount)],
      Date.now(),
      POLL_REFRESH_MS,
    );
    let id: number | undefined;
    const first = window.setTimeout(() => {
      ask();
      id = window.setInterval(ask, POLL_REFRESH_MS);
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      if (id !== undefined) window.clearInterval(id);
    };
  }, [agentId, docker, askUsage, liveAccount, visible]);

  // Nothing known yet: render nothing at all rather than a placeholder. An
  // account that has not spoken has no honest number to show, and a row of
  // dashes in the footer reads as a broken feature rather than a quiet one.
  //
  // The ONE exception is a positively detected blocker, below: "we know why
  // this will never report" is a fact worth showing, where "nothing yet" is
  // not.
  // The two halves self-hide independently: an agent with no usage feed still
  // has accounts to switch, and an agent with no named account still has
  // numbers. The chip renders when EITHER has something.
  const hasNumbers = !hideUsage && known;
  const hasContext = !!ctx;
  // What this agent CAN put in the footer, for the readouts the user left on.
  // Usage also counts when Rust says the agent reports it, so a clone whose
  // base is missing from the table is not silently dropped.
  const sources = footerSources(base);
  const wantUsage = !hideUsage && (sources.usage !== null || !!accountsView?.reportsUsage);
  const wantContext = !hideContext && sources.context !== null;
  const hasAccounts = pillVisible(accountsView);
  // An agent that CAN report usage and has not yet says so, rather than
  // leaving a gap in the footer. Without it the first task restored after a
  // relaunch had no chip while the second one had a wrong one, and a clone
  // with no hooks looked exactly like a clone that would never report.
  // A positively detected blocker still wins: it names the actual cause.
  const blocked = blocksUsageFeed(owner);
  // ANY readout this agent could show and has not: usage, context, or both.
  // Gating this on usage alone (it used to be `reportsUsage`) left every
  // context-only agent (grok, opencode, pi) and the pull-usage agents Rust
  // does not list (copilot) with an empty footer and no way to find out that
  // installing hooks is what fills it.
  const unknown = (wantUsage || wantContext) && !hasNumbers && !hasContext && !blocked;
  // Dismissed: the same state and the same panel behind a faint icon, so the
  // footer stops spending a label on it but the way to hooks is still one click.
  // Only while this agent has NO hooks, which is what was dismissed: once they
  // are installed (Settings refreshes `agentHooksInstalled` on the spot) the
  // label comes back on its own until the first reading replaces it.
  const dismissed = useUsageUnknownDismissed(s => s.byAgent[agentId] === true);
  const hooksInstalled = useApp(s => s.agentHooksInstalled[agentId] === true);
  const quiet = unknown && dismissed && !hooksInstalled;
  if (!hasNumbers && !hasAccounts && !hasContext) {
    if (blocked) return <BlockedChip owner={owner!} className={className} />;
    if (!unknown) return null;
  }

  const stale = !!entry && Date.now() - entry.updatedAt > STALE_AFTER_MS;
  // The bar tracks the window closest to its limit, which is not always the
  // session one: 30% of five hours next to 95% of the week has to read as a
  // warning, not as comfort. `drivingWindow` is where that is decided.
  // Both null on an API-key account: it has no plan to be a percentage OF.
  const driver = entry ? drivingWindow(entry) : null;
  const level = driver ? usageLevel(driver.window.usedPercent) : "normal";
  const iconId = resolveIconId(agentId, agents);

  return (
    // Re-read the accounts when this opens: the opt-in below has a second
    // surface (the account pill carries the same checkbox) and nothing pushes
    // a change between them.
    <PopoverRoot
      open={detailOpen}
      onOpenChange={o => {
        setDetailOpen(o);
        // Re-read on OPEN so a set added in Settings is there; clear the
        // notice on CLOSE, never on open, or the one thing the user opened
        // the panel to read is unmounted as they look at it.
        if (o) refreshAccounts(); else sw.clearNotice();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="usage-chip"
          // The values the chip is CLAIMING, so a spec asserts the number the
          // user reads rather than the store field behind it. Percentages are
          // rounded here exactly as they are rendered.
          data-usage-agent={agentId}
          data-usage-session={entry?.session ? String(Math.round(entry.session.usedPercent)) : ""}
          data-usage-weekly={entry?.weekly ? String(Math.round(entry.weekly.usedPercent)) : ""}
          data-usage-source={entry?.source ?? ""}
          data-usage-level={level}
          data-context-percent={ctx ? String(Math.round(ctx.usedPercent)) : ""}
          // The ACCOUNT half's state, on the same element: one chip, so one
          // set of attributes for a spec to read.
          data-testid-account={hasAccounts ? "1" : ""}
          data-account={sw.label ?? ""}
          data-offering={sw.offering ? sw.candidate! : ""}
          data-usage-account={accounts.account ?? ""}
          data-auto={sw.auto ? "on" : "off"}
          title={
            sw.offering
              ? t("agentChip.offeringTitle", { now: sw.shown.now, candidate: sw.candidate })
              : sw.shown.next
                ? t("agentChip.nextTitle", { agent: agentId, now: sw.shown.now, next: sw.shown.next })
                : hasAccounts
                  ? t("agentChip.signedInTitle", { agent: agentDisplayName(agentId, agents), account: sw.shown.now })
                  : unknown
                    ? t("agentChip.unknownTitle", { agent: agentDisplayName(agentId, agents) })
                    : t("agentChip.planTitle", { agent: agentDisplayName(agentId, agents) })
          }
          data-usage-dismissed={quiet ? "1" : ""}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 tabular-nums",
            "hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]",
            // Deliberately NOT `transition-colors`: a themed colour set from
            // React state never repaints under that shorthand in WKWebView
            // (docs/gotchas.md), which is how this would light up amber
            // everywhere except the machine it ships on.
            sw.alert ? "text-[var(--color-warn)]"
              : stale || quiet ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg-dim)]",
            className,
          )}
        >
          {/* The agent's own brand icon, not a generic gauge. Two DIFFERENT
              agents are told apart right here without reading a word, which a
              gauge could never do; two accounts of the SAME agent are told
              apart in the popover. Sized to the sandbox status icon beside it
              rather than to the 3.5 the text sits at, because a brand mark at
              3.5 is a smudge. */}
          {quiet ? (
            // Same faint ink as the footer's idle Terminal button: present,
            // clickable, not asking for anything.
            <UsageRisingIcon data-testid="usage-dismissed-icon" className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-dim)]")}>
              <CliIcon cli={iconId} className="h-4 w-4" />
            </span>
          )}
          {/* The account, when there is one to name. A key glyph only while
              something needs attention: the brand icon already says which
              agent this is, so a second permanent icon would be width spent
              on nothing. */}
          {hasAccounts && (
            <>
              {sw.alert && <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />}
              <span className="max-w-[14ch] truncate">{sw.shown.now}</span>
              {(hasNumbers || hasContext || (unknown && !quiet)) && <span className="text-[var(--color-fg-faint)]">·</span>}
            </>
          )}
          {/* ONE GAUGE PER WINDOW, and each one IS its number's background.
              There used to be a single bar here, showing whichever window was
              closest to its limit (`drivingWindow`). The reasoning was sound,
              30% of five hours beside 95% of the week has to read as a
              warning, but the bar sat hard against the 5h number and silently
              displayed the OTHER one, so it read as that number's gauge and
              was wrong most of the time. The fix was two bars, which fixed the
              mis-pairing and left the footer reading as instrumentation: four
              marks for two facts, 56px of a bar that starts hiding chips at
              780px. Both reports came from someone looking straight at it,
              which is the only evidence that counts for a footer you are meant
              to take at a glance.

              A window's gauge is now the fill behind its own figure, so there
              is nothing beside a number that could belong to the other one and
              nothing to shed when the bar gets narrow. `drivingWindow` stays:
              it is still the right question for `autoSwitch`, which wants to
              know which limit will stop you, and for the popover's colouring.
              Two fixed labels rather than one adaptive string, unchanged: the
              footer must not reflow as the numbers tick, and "58% 5h" next to
              "41% wk" is read as two things where "58/41" is read as neither.

              No separator between them any more. Two filled boxes already
              delimit themselves, and a dot in the gap read as a third mark
              competing with the two it was separating. The dot after the
              ACCOUNT stays: bare text against a filled box does need one. */}
          {/* The context window LEADS: it is this conversation's number, the
              one that changes as you work, where the plan windows beside it
              belong to the account. Same gauge, so the chip reads as one row
              of figures rather than two different widgets. */}
          {ctx && <ContextReadout entry={ctx} />}
          {unknown && !quiet && (
            <span data-testid="usage-unknown" className="text-[var(--color-fg-faint)]">{t("agentChip.usageUnknown")}</span>
          )}
          {entry?.session && (
            <UsageWindowReadout
              window={entry.session} unit={words.chip} stale={stale} testid="5h"
            />
          )}
          {entry?.weekly && (
            <UsageWindowReadout
              window={entry.weekly} unit="wk" stale={stale} testid="wk"
            />
          )}
          {/* Spend since launch, and ONLY for an account with no plan, which
              is the case this feed exists for. On a subscription the
              percentages are the readout: a dollar figure beside them is a
              second number competing for the same glance, and showing it
              before the first `rate_limits` arrives made the chip flip from
              money to a bar mid-turn. The popover still carries the spend. */}
          {/* An uncapped plan (devin Enterprise, ACU-billed): what it used this
              billing period, as a plain count. No bar and no warn colour,
              because there is no limit for it to approach. */}
          {entry?.consumed && !entry.session && !entry.weekly && (
            <span data-testid="usage-consumed" className="tabular-nums">{formatConsumed(entry.consumed)}</span>
          )}
          {costChipVisible(entry, spend) && (
            <>
              {(entry?.session || entry?.weekly) && <span className="text-[var(--color-fg-faint)]">·</span>}
              <span data-usage-spend={spend.toFixed(4)}>{formatUsd(spend)}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-0"
        // Nothing in here is interactive, so taking focus would be pure theft:
        // the user is typing at an agent, and Radix's default is to move focus
        // into the panel on open. Escape still closes it (the dismissable
        // layer listens on the document), and the caret never leaves the
        // terminal. Same reasoning on the way out.
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <UsageDetail
          agentId={agentId} entry={entry} level={level} driver={driver} spend={hideUsage ? 0 : spend}
          unknown={unknown} ctx={ctx}
          sources={sources} show={{ usage: wantUsage, context: wantContext }}
          accountsView={accountsView} refreshAccounts={refreshAccounts}
          onNavigate={() => setDetailOpen(false)}
        />
        {/* The credentials half of the same panel. Rendered here rather than
            in its own popover: one control, one panel. */}
        {hasAccounts && accountsView && (
          <AccountSwitcher
            agentId={agentId}
            view={accountsView}
            sw={sw}
            onNavigate={() => setDetailOpen(false)}
          />
        )}
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
function UsageDetail({ agentId, entry, level, driver, spend, unknown, ctx, sources, show, accountsView, refreshAccounts, onNavigate }: {
  agentId: string;
  /** Undefined for an account that has never reported: the panel is then
   *  purely the credentials half, and the usage rows are skipped rather than
   *  rendered as blanks. */
  entry: UsageEntry | undefined;
  level: UsageLevel;
  /** `null` on an account with no plan windows, which has no driving one. */
  driver: { window: UsageWindow; label: "5h" | "wk" } | null;
  /** USD spent on this account since launch. */
  spend: number;
  /** The agent can report usage and has not yet: the panel explains why. */
  unknown: boolean;
  /** This task's context window with this agent, when shown. */
  ctx: ContextEntry | undefined;
  /** Where each readout comes from, and which ones the user left on: what
   *  the "unknown" panel has to explain. */
  sources: FooterSources;
  show: { usage: boolean; context: boolean };
  accountsView: AgentAccountsView | null;
  refreshAccounts: () => void;
  /** Close the popover: a row that navigates away must not leave it hanging
   *  over the page it just opened. */
  onNavigate: () => void;
}) {
  const { t } = useTranslation("task");
  const agents = useApp(a => a.agents);
  const iconId = resolveIconId(agentId, agents);
  const age = entry ? Date.now() - entry.updatedAt : 0;
  const stale = !!entry && age > STALE_AFTER_MS;
  const display = agentDisplayName(agentId, agents);
  const words = shortWindowWords(builtinBaseId(agentId, agents));

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

      {ctx ? <ContextRow entry={ctx} />
        : (!unknown && show.context && sources.context === "hooks")
          ? <ContextMissing agentId={agentId} onNavigate={onNavigate} />
          : null}
      <div className="flex flex-col gap-2.5 px-3 py-2.5 empty:hidden">
        {unknown ? (
          <UsageUnknown agentId={agentId} sources={sources} show={show} onNavigate={onNavigate} />
        ) : !entry ? null : (entry.session || entry.weekly) ? (
          <>
            <UsageRow label={words.label} sub={words.sub} window={entry.session}
              driving={driver?.label === "5h"} level={level} source={entry.source} />
            <UsageRow label={t("agentChip.weekly")} sub={t("agentChip.weeklySub")} window={entry.weekly}
              driving={driver?.label === "wk"} level={level} source={entry.source} />
          </>
        ) : entry.consumed ? (
          <div data-testid="usage-consumed-row" className="flex items-baseline justify-between">
            <span className="text-[var(--color-fg-dim)]">
              {t("agentChip.consumedLabel", { unit: entry.consumed.unit })}
              <span className="block text-[11px] text-[var(--color-fg-faint)]">
                {formatPeriod(entry.consumed)
                  ? t("agentChip.noQuotaPeriod", { period: formatPeriod(entry.consumed) })
                  : t("agentChip.noQuota")}
              </span>
            </span>
            <span className="shrink-0 whitespace-nowrap tabular-nums font-medium text-[var(--color-fg)]">{formatConsumed(entry.consumed)}</span>
          </div>
        ) : costChipVisible(entry, spend) ? (
          // No plan at all: say so, rather than showing two empty bars. This
          // is the API-key account, and its whole readout is the spend below.
          // Only once it is PROVED (`UsageEntry.noPlan`): a subscription looks
          // the same until its first turn reaches the API.
          <div className="text-[var(--color-fg-faint)]">
            {t("agentChip.billedPerToken")}
          </div>
        ) : null}
        {/* `costChipVisible` as well as a positive figure: on an account
            known to have no plan, zero is a reading (nothing spent yet) and
            hiding the row leaves the panel with a single sentence and no
            number, one turn before it fills in. A PLAN account keeps the
            `spend > 0` rule, because `costChipVisible` is false there. */}
        {(spend > 0 || costChipVisible(entry, spend)) && (
          <div
            data-testid="usage-spend-row"
            className="flex items-baseline justify-between border-t border-[var(--color-border-soft)] pt-2.5"
          >
            {/* The label turns on whether this account has a PLAN, because
                the same number means two different things.

                claude reports `total_cost_usd` on every account, subscription
                included, so a Max account shows plan windows AND a dollar
                figure. On that account the money was never spent: it is what
                the tokens would have cost at API rates, and the subscription
                covered them. Calling it "Spent" there states a charge that
                did not happen, which is exactly how it read to the first
                person who saw both on one panel. */}
            <span className="text-[var(--color-fg-dim)]">
              {entry?.sawPlan ? t("agentChip.wouldHaveCost") : entry?.noPlan ? t("agentChip.spentSinceLaunch") : t("agentChip.costSinceLaunch")}
              {/* The reset is said out loud either way, because the number
                  goes back to zero when termic does and someone comparing it
                  against a provider dashboard needs to know that first. */}
              <span className="block text-[11px] text-[var(--color-fg-faint)]">
                {entry?.sawPlan
                  ? t("agentChip.coveredByPlan")
                  : entry?.noPlan
                    ? t("agentChip.thisAgentAccount")
                    // Neither proved yet: the same figure is a charge on one
                    // kind of account and not on the other, so name neither.
                    : t("agentChip.atApiRates")}
              </span>
            </span>
            <span className="tabular-nums font-medium text-[var(--color-fg)]">{formatUsd(spend)}</span>
          </div>
        )}
      </div>

      {entry && !unknown && (
      <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[var(--color-fg-faint)]">
        {level !== "normal" && driver && (
          <div className={cn("mb-1", LEVEL_TEXT[level])}>
            {t("agentChip.overLimit", {
              percent: level === "critical" ? USAGE_CRITICAL_PERCENT : USAGE_WARN_PERCENT,
              window: driver.label === "5h" ? words.limit : "weekly",
            })}
          </div>
        )}
        {/* Where it came from, and how old. Both matter: the claude feed only
            speaks while a turn runs, so a number can be hours stale and look
            exactly like a fresh one. */}
        <div>
          {entry.source === "statusline"
            ? t("agentChip.reportedLive")
            : t("agentChip.readBackground", { agent: display })}
          {stale ? t("agentChip.lastUpdated", { age: describeAge(age) }) : ""}
        </div>
      </div>
      )}
      {/* Only the "add a second set" nudge survives here: once accounts exist
          the switcher below IS the credentials UI, and the auto-switch
          checkbox lives there. Two copies of that checkbox is what the merge
          removed. */}
      <AccountRow agentId={agentId} view={accountsView} refresh={refreshAccounts} onNavigate={onNavigate}
        uncapped={!!entry?.consumed && !entry.session && !entry.weekly} />
    </div>
  );
}

/** Usage only ever climbs within a window, so the dismissed chip's icon never
 *  dips: lucide's `TrendingUp` zig-zags down in the middle, which read as usage
 *  going down. Same grid and stroke as lucide, so it sits beside its icons. */
function UsageRisingIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" {...props}
    >
      <polyline points="2 19 9 12 14 12 22 4" />
      <polyline points="16 4 22 4 22 10" />
    </svg>
  );
}

/** Why an agent that can report usage has not, and the way forward.
 *
 *  claude's feed rides the status line the agent hooks install, so the answer
 *  turns on whether THIS agent's hooks are in: a clone relocates its config
 *  dir and needs its own install. codex and devin are asked by termic and need
 *  no hooks, so they never get the hooks advice. */
function UsageUnknown({ agentId, sources, show, onNavigate }: {
  agentId: string;
  sources: FooterSources;
  show: { usage: boolean; context: boolean };
  onNavigate: () => void;
}) {
  const agents = useApp(a => a.agents);
  const display = agentDisplayName(agentId, agents);
  const { t } = useTranslation("task");
  // From the store, not an IPC on open. Asking `agent_hooks_status` when the
  // panel opened rendered it empty first and then grew it, so it was placed
  // for the empty size and could land clipped at the bottom of the window.
  // Settings refreshes this right after it installs or removes hooks, and the
  // chip already reads the same flag to decide whether a dismissal holds.
  const hooksActive = useApp(s => s.agentHooksInstalled[agentId] === true);
  const dismissed = useUsageUnknownDismissed(s => s.byAgent[agentId] === true);
  const setDismissed = useUsageUnknownDismissed(s => s.setDismissed);

  // Decided by where the readouts come from, not by agent name: it used to be
  // `base !== "claude"`, which told a grok user to wait for a poll that does
  // not exist when what they needed was the hooks install.
  if (!footerNeedsHooks(sources, show)) {
    return (
      <div data-testid="usage-unknown-detail" data-usage-hooks="n/a" className="flex flex-col gap-1 text-[var(--color-fg-dim)]">
        <p>{t("agentChip.usagePollNote", { agent: display })}</p>
        <p className="text-[var(--color-fg-faint)]">{t("agentChip.usagePollRetry")}</p>
      </div>
    );
  }
  if (hooksActive) {
    return (
      <div data-testid="usage-unknown-detail" data-usage-hooks="active" className="flex flex-col gap-1 text-[var(--color-fg-dim)]">
        <p>{t("agentChip.usageAfterFirst")}</p>
        {/* claude reads its settings once, at start: hooks installed under a
            running session change nothing until that tab restarts. */}
        <p className="text-[var(--color-fg-faint)]">{t("agentChip.hooksRestartNote")}</p>
      </div>
    );
  }
  return (
    <div data-testid="usage-unknown-detail" data-usage-hooks="missing" className="flex flex-col gap-2 text-[var(--color-fg-dim)]">
      <p>
        {show.usage && sources.usage === "hooks"
          ? t(show.context && sources.context === "hooks" ? "agentChip.hooksNeededBoth" : "agentChip.hooksNeededUsage")
          : t("agentChip.hooksNeededContext")}
      </p>
      {/* To Settings, not an install from here: the hooks block shows exactly
          which files it will write before it writes them, and a button in a
          footer popover would skip that. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="usage-install-hooks"
          onClick={() => {
            onNavigate();
            useApp.getState().openSettings("agents", undefined, AGENT_HOOKS_HIGHLIGHT);
          }}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]"
        >
          {t("agentChip.installHooks")}
        </button>
        {/* For someone who does not want hooks now: the footer label goes, a
            faint icon stays, and this panel is still one click away. */}
        {!dismissed && (
          <button
            type="button"
            data-testid="usage-dismiss"
            onClick={() => { setDismissed(agentId, true); onNavigate(); }}
            title={t("agentChip.dismissFor", { agent: display })}
            // One line, truncated: the panel is a fixed 320px and an agent
            // name is typed by the user, so a long one without a break point
            // would otherwise run out of the panel. It wraps below "Install
            // hooks" first, and only then truncates.
            className="flex min-w-0 max-w-full rounded px-2 py-1 text-[12px] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
          >
            <span className="truncate">{t("agentChip.dismissFor", { agent: display })}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** The account row under the numbers: the one discovery vector that fires at
 *  the moment of need (GH #278).
 *
 *  Someone opens this popover when they are near a limit, which is exactly
 *  when a second account becomes interesting. It is the only surface where
 *  that thought and this affordance meet, and it shows whichever of the two
 *  steps the user has not taken yet:
 *
 *    no second account  ->  add one
 *    a second account   ->  let termic move to it on its own
 *
 *  Never both, and never a disabled control for the step that is not reachable
 *  yet. An always-visible toggle that cannot do anything until some other
 *  thing exists teaches people to ignore the row.
 *
 *  It cannot be the ONLY vector, and that is why the agent card carries one
 *  too: this chip renders nothing until an account has actually reported
 *  usage, which today means claude and codex alone. The other six built-ins
 *  never show it. The footer pill carries the same toggle, for the user who
 *  reaches for the account menu rather than the numbers.
 */
function AccountRow({ agentId, view, refresh, onNavigate, uncapped }: {
  agentId: string;
  view: AgentAccountsView | null;
  refresh: () => void;
  onNavigate: () => void;
  /** The account has no quota (devin Enterprise): "running low" cannot
   *  happen, so the nudge would be advice about nothing. */
  uncapped?: boolean;
}) {
  const { t } = useTranslation("task");
  // Only the nudge toward a SECOND set. Once one exists the switcher section
  // below is the credentials UI, and the auto-switch checkbox lives there:
  // this row used to carry its own copy, and toggling one left the other
  // stale until something remounted it.
  if (uncapped || !view || !view.supported || view.accounts.length >= 1) return null;

  return (
    <button
      type="button"
      data-testid="usage-add-credentials"
      onClick={() => {
        // Close first, then navigate: the panel is fixed-position and would
        // otherwise sit over the page it just opened. And carry the AGENT, so
        // Settings lands on the right card with the control focused.
        onNavigate();
        useApp.getState().openSettings("agents", undefined, `${agentId}:accounts`);
      }}
      className="w-full border-t border-[var(--color-border-soft)] px-3 py-2 text-left text-[12px] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
    >
      {t("agentChip.addCredentials")}
    </button>
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
  const { t } = useTranslation("task");
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
        <span>{source === "rpc" ? t("agentChip.notOnPlan") : t("agentChip.notInReport")}</span>
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
        <span>{formatReset(w) || t("agentChip.resetUnknown")}</span>
      </div>
    </div>
  );
}

/**
 * Shown when termic KNOWS the usage feed cannot run, never when it merely has
 * nothing yet.
 *
 * The whole point is that this failure is otherwise invisible: a project that
 * ships its own status line outranks termic's, so termic's script never runs,
 * no OSC is written, and the footer is empty with nothing logged anywhere. The
 * user is left to work out why one repo reports usage and another does not.
 *
 * Deliberately quiet: faint, no colour, no badge. It is an explanation for
 * someone who went looking, not a defect to be alarmed about, and the thing
 * blocking it is usually a status line the user wants more than this one.
 */
function BlockedChip({ owner, className }: { owner: StatusLineOwner; className?: string }) {
  const { t } = useTranslation("task");
  const [copied, setCopied] = useState(false);
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="usage-blocked-chip"
          data-usage-owner={owner.owner}
          title={t("agentChip.blockedTitle")}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5",
            "text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg-dim)]",
            className,
          )}
        >
          <CircleSlash className="h-3.5 w-3.5" />
          <span>{t("agentChip.usageNa")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-0"
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <div data-testid="usage-blocked-detail" className="text-[12.5px]">
          <div className="border-b border-[var(--color-border-soft)] px-3 py-2 font-medium text-[var(--color-fg)]">
            {t("agentChip.blockedTitle")}
          </div>
          <div className="flex flex-col gap-2 px-3 py-2.5 text-[var(--color-fg-dim)]">
            <p>{blockedReason(owner)}</p>
            {/* Name the FILE. Without it the user has to go and find which of
                three settings files is in force, and the answer is not
                obvious: a local one outranks a committed one. */}
            <p className="break-all text-[var(--color-fg-faint)]">
              <code className="font-mono">{owner.path}</code>
            </p>
            <p>
              {t("agentChip.blockedBody")}
            </p>
          </div>
          <div className="border-t border-[var(--color-border-soft)] px-3 py-2">
            {/* The way out, as work someone else does. The user does not have
                to learn the wire format: they paste this at the agent that
                owns the script and it makes the edit. */}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(statusLineAgentPrompt(owner))
                  .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
                  .catch(() => {});
              }}
              className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-dim)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg)]"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? t("common:copied") : t("agentChip.copyPrompt")}
            </button>
            <p className="mt-1 text-[12px] text-[var(--color-fg-faint)]">
              {t("agentChip.copyPromptHint")}
            </p>
          </div>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/** Fill colour per level, for the POPOVER's full-width bars. Tokens only: a
 *  hex outside `@theme` in index.css is a theme that cannot be themed
 *  (CLAUDE.md).
 *
 *  `normal` is NEUTRAL, not green. This number only goes up, so green is not
 *  good news, and a window of green bars trains you to ignore the one that
 *  turns amber. */
const LEVEL_FILL: Record<UsageLevel, string> = {
  // `--color-fg-dim`, not `--color-fg-faint`: faint against the track was two
  // greys a shade apart, which is not a reading you can take at a glance.
  normal:   "bg-[var(--color-fg-dim)]",
  warn:     "bg-[var(--color-warn)]",
  critical: "bg-[var(--color-err)]",
};

/** The CHIP's gauge is the number's own background, so these are the same
 *  three hues mixed into whatever the footer's ground is rather than painted
 *  solid. Raw tokens (not Tailwind classes) because they go through
 *  `color-mix` in a computed gradient. */
const LEVEL_TINT: Record<UsageLevel, string> = {
  normal:   "var(--color-fg-dim)",
  warn:     "var(--color-warn)",
  critical: "var(--color-err)",
};

/** How much of that hue the fill carries, as a percentage mixed over the
 *  track. Not taste: these are the strongest values at which the number on
 *  top still clears 4.5:1 in BOTH themes, computed against every
 *  level/theme/track pairing rather than eyeballed on this machine's screen.
 *
 *    dark   normal 4.91  warn 5.87  critical 7.22
 *    light  normal 4.78  warn 9.20  critical 7.73
 *
 *  Push `critical` past ~40 and the red number starts to disappear into its
 *  own fill, which is the one reading that must never be hard to take. */
const FILL_MIX: Record<UsageLevel, number> = { normal: 18, warn: 34, critical: 40 };

/** The unused part of the gauge. A gauge has to show its EMPTY part too, or
 *  the fill has nothing to be a fraction of. Kept neutral at every level: the
 *  track is the same at 3% and 97%, only the fill says anything. */
const TRACK_MIX = 10;

/** Ink for the number sitting ON the fill.
 *
 *  Warn and critical go NEUTRAL-BRIGHT rather than taking their own hue, and
 *  that is the trade this design makes on purpose. Amber text on an amber
 *  fill measures 3.3:1 in dark mode, i.e. the number gets hardest to read
 *  exactly when it matters most, and no amount of tuning the mix fixes it
 *  (22% still only reaches 4.08). So the BOX carries the severity and the
 *  text carries the reading: a red-filled box is louder than red text ever
 *  was, and the figure inside it stays legible at 7:1.
 *
 *  `normal` stays dim, because a quiet reading brightening to full `fg` would
 *  make every calm chip in the footer shout. */
const LEVEL_INK: Record<UsageLevel, string> = {
  normal:   "text-[var(--color-fg-dim)]",
  warn:     "text-[var(--color-fg)]",
  critical: "text-[var(--color-fg)]",
};

/** Text colour by level, for the POPOVER: its header and its per-window rows,
 *  which have room for a coloured figure beside a full-width bar. `normal` is
 *  undefined so it inherits, which is what keeps the quiet case quiet.
 *
 *  The CHIP no longer uses this. Its figure sits ON the gauge, where taking
 *  the level's own hue costs it half its contrast; see `LEVEL_INK`. */
const LEVEL_TEXT: Record<UsageLevel, string | undefined> = {
  normal:   undefined,
  warn:     "text-[var(--color-warn)]",
  critical: "text-[var(--color-err)]",
};

/** One window's gauge, which IS its number's background.
 *
 *  There used to be a 24x10 pill in FRONT of each percentage. Two of them in a
 *  row read as instrumentation rather than as a reading, and they cost 56px of
 *  a bar that starts hiding chips at 780px: the same chip measures 264px with
 *  the pills and 219px without them. Reported by someone looking straight at
 *  it, which is the only evidence that counts for a footer meant to be taken
 *  at a glance.
 *
 *  So the gauge moved BEHIND the number: a hard-stop gradient across the
 *  readout's own box, filled to the percentage, with the unused part left as a
 *  visible track. Nothing sits beside the number that could belong to the
 *  other window, which is the failure the two pills were themselves a fix for.
 *
 *  A hard stop, not a fade. A gradient that eases out has no readable edge, so
 *  the one thing the shape is for (where does the fill end) becomes a guess.
 *
 *  No transition, for the same reason the old bar had none: the value changes
 *  about once per turn, seconds apart, so an animation has nothing to smooth
 *  and would only ever be caught mid-flight. `transition-colors` would be
 *  worse than useless here, since it never repaints a themed colour in
 *  WKWebView at all (docs/gotchas.md).
 *
 *  The BOX is fixed-content, not fixed-width: it is exactly as wide as
 *  "85% wk", so the footer does not reflow as the fill moves. Only the stop
 *  position changes. */
function UsageWindowReadout({ window: w, unit, stale, testid }: {
  window: UsageWindow; unit: string; stale: boolean; testid: string;
}) {
  const level = usageLevel(w.usedPercent);
  // Floored at 2% so a barely-used account still shows a sliver of fill: a
  // box with no fill at all is indistinguishable from one that failed to
  // render, and the exact figure is spelled out in words on top of it.
  // Clamped to 0-100 on the way in, and never a string from the payload.
  const fill = Math.max(2, Math.round(w.usedPercent));
  // A stale reading gets a fainter gauge rather than a dimmer number: the
  // figure is still the figure, it is the confidence that has dropped. Half
  // the mix, not a flat value, so a stale critical still reads as critical.
  const mix = stale ? Math.round(FILL_MIX[level] / 2) : FILL_MIX[level];
  return (
    <span
      data-usage-window={testid}
      data-testid="usage-gauge"
      // The gauge's own value, so a spec can assert what was DRAWN rather than
      // counting elements. The old `usage-bar-fill` testid went with the pill.
      data-usage-fill={fill}
      // NOT `inline-flex`: the number and its unit are two inline children
      // with a space between them, and flex layout discards whitespace between
      // items, so the chip rendered "95%wk". There is nothing to lay out in a
      // row here anyway; the chip's own flex centres this box vertically.
      className={cn("shrink-0 rounded px-1.5 py-px", LEVEL_INK[level])}
      // Genuinely dynamic (the stop moves with the number), so it cannot be a
      // Tailwind class. Two layers: the fill gradient over a flat track, both
      // mixed with `transparent` so they composite over whatever the footer's
      // ground is and a custom theme's tokens carry through untouched.
      style={{
        background:
          `linear-gradient(to right,`
          + ` color-mix(in srgb, ${LEVEL_TINT[level]} ${mix}%, transparent) 0 ${fill}%,`
          + ` transparent ${fill}% 100%),`
          + ` color-mix(in srgb, var(--color-fg-dim) ${TRACK_MIX}%, transparent)`,
      }}
    >
      {formatPercent(w)} <Unit>{unit}</Unit>
    </span>
  );
}

/** The context window's figure, drawn with the plan windows' gauge so the chip
 *  stays one row of like things. Its own thresholds: a context filling up is a
 *  session's normal life, so it only colours near compaction. */
function ContextReadout({ entry }: { entry: ContextEntry }) {
  const { t } = useTranslation("task");
  const level = contextLevel(entry.usedPercent);
  const fill = Math.max(2, Math.round(entry.usedPercent));
  return (
    <span
      data-usage-window="ctx"
      data-testid="context-gauge"
      data-usage-fill={fill}
      title={t("agentChip.contextChipTip", { used: formatTokens(entry.usedTokens), total: formatTokens(entry.windowTokens) })}
      className={cn("shrink-0 rounded px-1.5 py-px", LEVEL_INK[level])}
      style={{
        background:
          `linear-gradient(to right,`
          + ` color-mix(in srgb, ${LEVEL_TINT[level]} ${FILL_MIX[level]}%, transparent) 0 ${fill}%,`
          + ` transparent ${fill}% 100%),`
          + ` color-mix(in srgb, var(--color-fg-dim) ${TRACK_MIX}%, transparent)`,
      }}
    >
      {Math.round(entry.usedPercent)}% <Unit>ctx</Unit>
    </span>
  );
}

/** The popover's context row: the token counts the chip leaves out. */
function ContextRow({ entry }: { entry: ContextEntry }) {
  const { t } = useTranslation("task");
  const level = contextLevel(entry.usedPercent);
  return (
    <div data-testid="context-row" className="border-b border-[var(--color-border-soft)] px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[var(--color-fg)]">{t("agentChip.context")}</span>
        <span className={cn("tabular-nums", LEVEL_TEXT[level] ?? "text-[var(--color-fg-dim)]")}>
          {Math.round(entry.usedPercent)}%
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg-3)]">
        <div
          className={cn("h-full rounded-full", LEVEL_FILL[level])}
          style={{ width: `${Math.max(2, Math.round(entry.usedPercent))}%` }}
        />
      </div>
      <div className="mt-1 flex items-baseline justify-between text-[var(--color-fg-faint)]">
        <span>{level === "normal" ? t("agentChip.contextThisConversation") : t("agentChip.contextNearCompaction", { percent: CONTEXT_WARN_PERCENT })}</span>
        <span className="tabular-nums">
          {t("agentChip.contextTokens", { used: formatTokens(entry.usedTokens), total: formatTokens(entry.windowTokens) })}
        </span>
      </div>
    </div>
  );
}

/** No context reading yet, on an agent whose plan usage IS showing.
 *
 *  The "Usage unknown" panel covers an agent with nothing at all; this is the
 *  other half. copilot's usage is pulled from its own cache, so its chip has
 *  numbers with or without hooks, and without them the context window simply
 *  never appeared, with nothing saying that hooks are what bring it. */
function ContextMissing({ agentId, onNavigate }: { agentId: string; onNavigate: () => void }) {
  const hooksActive = useApp(s => s.agentHooksInstalled[agentId] === true);
  const { t } = useTranslation("task");
  return (
    <div data-testid="context-missing" data-context-hooks={hooksActive ? "active" : "missing"}
      className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] px-3 py-2.5">
      <span className="text-[var(--color-fg-dim)]">
        {t("agentChip.context")}
        <span className="block text-[11px] text-[var(--color-fg-faint)]">
          {hooksActive ? t("agentChip.contextMissingActive") : t("agentChip.contextMissingHooks")}
        </span>
      </span>
      {!hooksActive && (
        <button
          type="button"
          data-testid="context-install-hooks"
          onClick={() => {
            onNavigate();
            useApp.getState().openSettings("agents", undefined, AGENT_HOOKS_HIGHLIGHT);
          }}
          className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]"
        >
          {t("agentChip.installHooks")}
        </button>
      )}
    </div>
  );
}

/** The unit beside a percentage, one step dimmer than the number.
 *
 *  The number is the DATA and the unit is the label, and at 12.5px in a footer
 *  they otherwise read as one four-character word.
 *
 *  OPACITY, not its own colour. A fixed `--color-fg-faint` kept the unit quiet
 *  in the wrong way: it did not brighten with the chip on hover, so pointing
 *  at the control made the numbers step forward and left "5h" and "wk"
 *  behind, and it was too dim to read at rest besides. Opacity subdues it
 *  RELATIVE to whatever the number is doing, which also keeps a unit from
 *  ever being the thing that turned amber or red. */
function Unit({ children }: { children: string }) {
  return <span className="opacity-70">{children}</span>;
}

function describeAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}
