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
import { openPath } from "@/lib/ipc";
import type { Task } from "@/lib/types";

export function TaskPrBadge({ task }: { task: Task }) {
  const { t } = useTranslation("chrome");
  const pr = usePr(s => s.byTask[task.id]?.lookup?.pr ?? null);
  const url = pr?.url ?? task.pr_url ?? null;
  if (!url) return null;
  const noun = (pr?.provider ?? task.pr_provider) === "gitlab" ? "MR" : "PR";
  const num = pr?.number ?? task.pr_number;
  const state = pr?.state ?? null;
  // Failing checks override the state color for open/draft: this glyph is
  // the only PR signal visible without opening the Git tab, and an all-green
  // "open" icon next to a red CI failure (visible only in the full card) is
  // exactly the confusing case - a broken build shouldn't look identical to
  // a healthy one at a glance. Merged/closed keep their own color; the PR
  // is already done, so CI at HEAD stops being the thing worth flagging.
  const failing = pr?.checks === "failing" && (state === "open" || state === "draft");
  const failingSuffix = failing ? ` · ${t("taskPrBadge.checksFailing")}` : "";
  const { Icon, color, label } =
    state === "merged" ? { Icon: GitMerge, color: "var(--color-pr-merged)", label: t("taskPrBadge.stateMerged") } :
    state === "closed" ? { Icon: GitPullRequestClosed, color: "var(--color-err)", label: t("taskPrBadge.stateClosed") } :
    state === "draft"  ? { Icon: GitPullRequestDraft, color: failing ? "var(--color-err)" : "var(--color-fg-faint)", label: t("taskPrBadge.stateDraft") + failingSuffix } :
    state === "open"   ? { Icon: GitPullRequest, color: failing ? "var(--color-err)" : "var(--color-pr-open)", label: t("taskPrBadge.stateOpen") + failingSuffix } :
    { Icon: GitPullRequest, color: "var(--color-fg-faint)", label: "" };
  const id = `${noun}${num ? ` ${noun === "MR" ? "!" : "#"}${num}` : ""}`;
  const forge = noun === "MR" ? "GitLab" : "GitHub";
  return (
    <Tip content={`${id}${label ? ` · ${label}` : ""}. ${t("taskPrBadge.openOn", { forge })}`} delay={0}>
      <button
        data-no-drag
        data-testid="task-pr-badge"
        data-pr-state={state ?? "unknown"}
        onClick={(e) => { e.stopPropagation(); openPath(url).catch(() => {}); }}
        className="shrink-0 rounded p-px hover:bg-[var(--color-bg-3)]"
      >
        <Icon className="h-3 w-3" style={{ color }} />
      </button>
    </Tip>
  );
}
