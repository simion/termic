// Main-pane view for a task that's still being created (worktree add +
// file copy + setup script, streamed on the same `setup-output://{id}`
// channel the setup script itself uses post-creation — see
// emit_create_progress in src-tauri/src/lib.rs). Replaces the old
// NewTaskDialog-blocking modal (GH #242): the dialog now closes the moment
// Create is pressed, the sidebar shows this task with a spinner badge, and
// clicking it here shows exactly what used to be trapped inside the modal.
// Laid out like a terminal pane (full-bleed log, thin header bar) rather
// than a small centered box — this IS the task's pane until the real one
// takes over, not a modal-shaped insert floating in it.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertTriangle } from "lucide-react";
import { useApp } from "@/store/app";
import { usePendingTask, usePendingTasks } from "@/store/pendingTasks";
import { CliIcon, resolveIconId } from "@/icons/cli";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

export function CreatingTaskPane({ id }: { id: string }) {
  const { t } = useTranslation("task");
  // Resolved: a cloned agent inherits its parent's icon.
  const agents = useApp(s => s.agents);
  const pending = usePendingTask(id);
  const setActive = useApp(s => s.setActiveTask);
  const remove = usePendingTasks(s => s.remove);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pending?.log.length]);

  // Pending entry can vanish out from under us the instant the real task
  // lands (loadAll picks it up and MainArea switches to the real TaskView
  // on the next render) — render nothing for that one frame rather than
  // crash on a stale reference.
  if (!pending) return null;

  const isError = pending.phase === "error";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] px-4 py-2.5 text-[13px] font-medium">
        {isError
          ? <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-err)]" />
          : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--color-fg-dim)]" />
        }
        <CliIcon cli={resolveIconId(pending.cli, agents)} className="h-4 w-4 shrink-0" />
        <span className="truncate">{pending.name}</span>
        <span className={cn("shrink-0", isError ? "text-[var(--color-err)]" : "text-[var(--color-fg-faint)]")}>
          {isError ? t("creating.failed") : t("creating.creating")}
        </span>
        {isError && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => { remove(id); setActive(null); }}
          >
            {t("common:dismiss")}
          </Button>
        )}
      </div>
      {isError && pending.err && (
        <p className="shrink-0 border-b border-[var(--color-border-soft)] px-4 py-2 text-[13px] text-[var(--color-err)]">
          {pending.err}
        </p>
      )}
      <div
        ref={outputRef}
        data-testid="creating-task-log"
        data-selectable
        className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]"
      >
        {pending.log.length === 0
          ? <span className="text-[var(--color-fg-faint)]">{t("creating.waiting")}</span>
          : pending.log.map((line, i) => <div key={i} className="whitespace-pre-wrap break-words">{line}</div>)
        }
      </div>
    </div>
  );
}
