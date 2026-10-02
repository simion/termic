// The PR/MR glyph on a task row: one icon whose colour is the pull request's
// state, linking out to the forge.
//
// Was local to Sidebar.tsx. Shared now because the dashboard shows it too.
// Strictly READ-ONLY: it renders what `usePr` already resolved and never kicks
// a fetch, so putting it on a page that lists every task costs nothing. A task
// whose PR has never been looked up renders its cached `pr_url` identity, or
// nothing at all.

import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tip } from "@/components/ui/Tooltip";
import { usePr } from "@/store/pr";
import { prBadgeAppearance } from "@/lib/prBadgeAppearance";
import { openPath } from "@/lib/ipc";
import { forgeName, prNounShort, prRef } from "@/lib/forge";
import type { Task } from "@/lib/types";

/** `testId`: the sidebar's status section passes its own, so the tree's
 *  `task-pr-badge` stays the first one in document order. */
export function TaskPrBadge({ task, testId = "task-pr-badge" }: { task: Task; testId?: string }) {
  const { t } = useTranslation("chrome");
  const pr = usePr(s => s.byTask[task.id]?.lookup?.pr ?? null);
  const url = pr?.url ?? task.pr_url ?? null;
  if (!url) return null;
  const provider = pr?.provider ?? task.pr_provider;
  const noun = prNounShort(provider);
  const num = pr?.number ?? task.pr_number;
  const state = pr?.state ?? null;
  // Colour comes from prBadgeAppearance, where the rules live and are
  // unit-tested over the whole state x checks matrix: no red anywhere, a
  // draft takes no colour at all, and an open pr with failing checks goes
  // WARN rather than ERR.
  //
  // The tooltip still says the checks fail, on a draft too. That is the split
  // the colour cannot express: the fact belongs to anyone who hovers, the
  // alarm colour belongs only to something you are meant to act on.
  const failing = pr?.checks === "failing" && (state === "open" || state === "draft");
  const { color } = prBadgeAppearance(state, pr?.checks ?? null);
  const failingSuffix = failing ? ` · ${t("taskPrBadge.checksFailing")}` : "";
  const { Icon, label } =
    state === "merged" ? { Icon: GitMerge, label: t("taskPrBadge.stateMerged") } :
    state === "closed" ? { Icon: GitPullRequestClosed, label: t("taskPrBadge.stateClosed") } :
    state === "draft"  ? { Icon: GitPullRequestDraft, label: t("taskPrBadge.stateDraft") + failingSuffix } :
    state === "open"   ? { Icon: GitPullRequest, label: t("taskPrBadge.stateOpen") + failingSuffix } :
    { Icon: GitPullRequest, label: "" };
  const id = `${noun}${num ? ` ${prRef(provider, num)}` : ""}`;
  const forge = forgeName(provider);
  return (
    <Tip content={`${id}${label ? ` · ${label}` : ""}. ${t("taskPrBadge.openOn", { forge })}`} delay={0}>
      <button
        data-no-drag
        data-testid={testId}
        data-pr-state={state ?? "unknown"}
        onClick={(e) => { e.stopPropagation(); openPath(url).catch(() => {}); }}
        className="shrink-0 rounded p-px hover:bg-[var(--color-bg-3)]"
      >
        <Icon className="h-3 w-3" style={{ color }} />
      </button>
    </Tip>
  );
}
