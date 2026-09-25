// The agent work badge: bell, bullet, or spinner.
//
// Was `TabBadge`, local to Sidebar.tsx. Shared now because the dashboard draws
// the same badge for the same task, and a second copy would be free to drift.
//
// `data-testid="work-badge"` is NOT unique on the page any more: the sidebar is
// always mounted and the dashboard is an overlay over it, so a task with a live
// agent renders two. Specs must scope through `[data-dashboard-task-id]` or the
// sidebar's `[data-sidebar-task-id]` rather than querying the testid globally.

import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { BackgroundRing } from "@/components/ui/BackgroundRing";
import { cn } from "@/lib/utils";
import { delegatedTitle, type DelegatedWork } from "@/lib/delegatedWork";
import { usePrefs } from "@/store/prefs";
import type { WorkBadgeReason } from "@/lib/taskWorkState";

/** `delegated`: work the agent handed off and has not finished, which
 *  qualifies two of the three reasons rather than being a fourth. See
 *  `lib/delegatedWork.ts`. */
export function TaskWorkBadge(
  { reason, delegated, preview }: {
    /** `"delegated"` is not a work state: it is an IDLE tab that still has
     *  something running, and it draws only because nothing outranks it. See
     *  the chain in `TabBar` and docs/ui.md. */
    reason: WorkBadgeReason | "delegated";
    delegated?: DelegatedWork | null;
    /** Documentation, not a live tab: draw the mark whatever the prefs say.
     *  The legend explaining a mark has to keep explaining it, and the one
     *  in the welcome wizard runs before the user has any prefs at all. */
    preview?: boolean;
  },
) {
  const { t } = useTranslation("chrome");
  // Off means the intermediate mark is noise to this user. It falls back to
  // the ring below, never to done: the turn is not over.
  const showPartial = usePrefs(s => s.partialDoneIndicator) || preview;
  const held = delegated ? delegatedTitle(delegated, t) : "";
  // PARTIALLY DONE: some of what the agent delegated has reported back and
  // the rest runs on. Outlined, not the solid done bullet, and it rings no
  // bell: a turn that is partly over is not over. Measured on three
  // background subagents, where the alternative was a full "done" with two
  // still working.
  if (delegated?.partial && showPartial && reason !== "attention") {
    return (
      <span
        data-testid="work-badge"
        data-work-state="partial"
        data-delegated={delegated.label}
        className="shrink-0 flex items-center justify-center"
        title={held}
        aria-label={held}
      >
        <span
          className="block h-2 w-2 rounded-full border-[1.5px]"
          style={{ borderColor: "var(--color-info)" }}
        />
      </span>
    );
  }
  // Waiting on delegated work, whether or not a turn is nominally running:
  // the agent's own loop has STOPPED either way, so the working spinner would
  // claim a model is computing. See `BackgroundRing`.
  if (reason === "delegated" || (reason === "working" && delegated)) {
    return (
      <span
        data-testid="work-badge"
        data-work-state={reason === "working" ? "working" : "delegated"}
        data-delegated={delegated ? delegated.label : undefined}
        className="shrink-0 flex items-center justify-center text-[var(--color-fg-faint)]"
        title={held || t("taskWorkBadge.delegated")}
        aria-label={held || t("taskWorkBadge.delegatedAria")}
      >
        <BackgroundRing size={12} />
      </span>
    );
  }
  if (reason === "working") {
    return (
      <span
        data-testid="work-badge"
        data-work-state="working"
        className="shrink-0 flex items-center justify-center text-[var(--color-fg-faint)]"
        title={t("taskWorkBadge.working")}
        aria-label={t("taskWorkBadge.workingAria")}
      >
        <Spinner size={12} />
      </span>
    );
  }
  if (reason === "attention") {
    return (
      <span
        data-testid="work-badge"
        data-work-state="attention"
        // Flex like every other mark: an inline span leaves the icon on the
        // text baseline, off the centre line the dot and rings sit on, which
        // shows the moment two marks share a row (a collapsed task group).
        className="shrink-0 flex items-center justify-center text-[var(--color-warn)]"
        title={t("taskWorkBadge.attention")}
      >
        <Bell className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  // done — solid blue bullet, iTerm2-style, in --color-info (defined in
  // @theme; themes can override). h-3.5 visually matches the bell + spinner.
  return (
    <span
      data-testid="work-badge"
      data-work-state="done"
      data-delegated={delegated ? delegated.label : undefined}
      className="shrink-0 flex items-center justify-center"
      title={held ? t("taskWorkBadge.doneDelegated", { held }) : t("taskWorkBadge.done")}
      aria-label={t("taskWorkBadge.doneAria")}
    >
      <span
        className="block h-2 w-2 rounded-full"
        style={{ backgroundColor: "var(--color-info)" }}
      />
    </span>
  );
}
