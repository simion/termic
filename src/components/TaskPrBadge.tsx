// The PR/MR glyph on a task row: one icon whose colour is the pull request's
// state, linking out to the forge.
//
// Was local to Sidebar.tsx. Shared now because the dashboard shows it too.
// Strictly READ-ONLY: it renders what `usePr` already resolved and never kicks
// a fetch, so putting it on a page that lists every task costs nothing. A task
// whose PR has never been looked up renders its cached `pr_url` identity, or
// nothing at all.

import { Check, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tip } from "@/components/ui/Tooltip";
import { cachedPrFor, usePr } from "@/store/pr";
import { prBadgeAppearance } from "@/lib/prBadgeAppearance";
import { openPath } from "@/lib/ipc";
import { forgeName, prNounShort, prRef } from "@/lib/forge";
import type { Task } from "@/lib/types";

/** `showNumber`: the sidebar draws the number beside the glyph (`#367`),
 *  so the badge reads as a link to a specific PR rather than one more icon.
 *  `showIcon: false` leaves the number alone, in the state's colour. A PR
 *  whose number is not known yet keeps its glyph anyway: dropping both would
 *  drop the link. */
export function TaskPrBadge({ task, testId = "task-pr-badge", showNumber = false, showIcon = true }: { task: Task; testId?: string; showNumber?: boolean; showIcon?: boolean }) {
  const { t } = useTranslation("chrome");
  const pr = usePr(s => s.byTask[task.id]?.lookup?.pr ?? null);
  // Above the early return: a hook after it runs on some renders and not
  // others, and React tears the row down when a task gains its PR.
  // Until this session's first poll lands, the mark wears what the PR last
  // read (store/pr.ts "last-known status"), so a launch does not start grey
  // and colour in one row at a time. The live lookup always wins.
  const cached = usePr(s => (s.byTask[task.id]?.lookup?.pr ? null : cachedPrFor(s.snapshots, task)));
  const unseenNumber = usePr(s => s.unseen[task.id]);
  const url = pr?.url ?? task.pr_url ?? null;
  if (!url) return null;
  const provider = pr?.provider ?? task.pr_provider;
  const noun = prNounShort(provider);
  const num = pr?.number ?? task.pr_number;
  const state = pr?.state ?? cached?.state ?? null;
  const checks = pr?.checks ?? cached?.checks ?? null;
  // Approved, and still waiting to merge: the one review verdict that means
  // "this is ready", so the one worth a mark of its own.
  const approved = (pr?.review ?? cached?.review) === "approved" && state === "open";
  // Colour comes from prBadgeAppearance, where the rules live and are
  // unit-tested over the whole state x checks matrix: never the alarm red,
  // a draft takes no colour at all, an open pr with failing checks goes WARN
  // rather than ERR, and a closed one is a muted red with its number struck.
  //
  // The tooltip still says the checks fail, on a draft too. That is the split
  // the colour cannot express: the fact belongs to anyone who hovers, the
  // alarm colour belongs only to something you are meant to act on.
  const failing = checks === "failing" && (state === "open" || state === "draft");
  const { color, struck } = prBadgeAppearance(state, checks);
  // Running checks say so too: the dim number alone reads as "no PR state yet".
  const running = checks === "pending" && state === "open";
  const failingSuffix = (failing ? ` · ${t("taskPrBadge.checksFailing")}` : "")
    + (running ? ` · ${t("taskPrBadge.checksRunning")}` : "")
    + (approved ? ` · ${t("taskPrBadge.approved")}` : "");
  const { Icon, label } =
    state === "merged" ? { Icon: GitMerge, label: t("taskPrBadge.stateMerged") } :
    state === "closed" ? { Icon: GitPullRequestClosed, label: t("taskPrBadge.stateClosed") } :
    state === "draft"  ? { Icon: GitPullRequestDraft, label: t("taskPrBadge.stateDraft") + failingSuffix } :
    state === "open"   ? { Icon: GitPullRequest, label: t("taskPrBadge.stateOpen") + failingSuffix } :
    { Icon: GitPullRequest, label: "" };
  const id = `${noun}${num ? ` ${prRef(provider, num)}` : ""}`;
  // Opened while the task was not in front, and not visited since.
  const fresh = unseenNumber != null && unseenNumber === num;
  const forge = forgeName(provider);
  return (
    <Tip content={`${fresh ? `${t("taskPrBadge.new")} · ` : ""}${id}${label ? ` · ${label}` : ""}. ${t("taskPrBadge.openOn", { forge })}`} delay={0}>
      <button
        data-no-drag
        data-testid={testId}
        data-pr-state={state ?? "unknown"}
        data-pr-approved={approved ? "" : undefined}
        data-pr-cached={!pr && cached ? "" : undefined}
        data-pr-new={fresh ? "" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (fresh) usePr.getState().markPrSeen(task.id);
          openPath(url).catch(() => {});
        }}
        className={`flex shrink-0 items-center gap-0.5 rounded p-px hover:bg-[var(--color-bg-3)]${fresh ? " bg-[var(--color-accent)]/15 ring-1 ring-[var(--color-accent)]/50" : ""}`}
        style={showNumber ? { color } : undefined}
      >
        {(showIcon || !(showNumber && num)) && <Icon className="h-3 w-3" style={{ color }} />}
        {/* LEFT of the number, so the numbers keep one right edge down the
            tree whether or not a row is ticked. Its own green, whatever the mark's colour: an approved PR with a
            failing build is amber AND ticked, which is exactly what it is. */}
        {approved && <Check data-testid="task-pr-approved" aria-hidden className="h-3 w-3 text-[var(--color-ok)]" strokeWidth={3} />}
        {showNumber && num ? <span data-testid="task-pr-number" className={`text-[11px] tabular-nums leading-none${struck ? " tc-pr-struck" : ""}`}>{prRef(provider, num)}</span> : null}
      </button>
    </Tip>
  );
}
