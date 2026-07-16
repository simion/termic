// The Agent Race compare surface. Once every racer has finished, this opens a
// wide N-up grid - one column per racer - showing each worktree's COMPLETE diff
// vs base (committed + staged + unstaged + new untracked files), so the user
// can eyeball what each agent produced and pick a winner by hand. Read-only:
// adopting / cherry-picking the winner is a later slice.
//
// Why static diffs, never live terminals: TerminalPane gates its WebGL attach
// on the single active task, so an N-up grid of live agent terminals would put
// one pane on the GPU and force the slow DOM renderer for every other pane -
// against "performance trumps polish". Diffs render cheaply side by side.
//
// Public surface: RaceCompare (mounted once in Dialogs). The cohort comes from
// the race store, never inferred from task names; per-racer work-state comes
// from each task's default tab. NOT responsible for launching a race
// (RaceDialog) or the live strip (RaceBoard).
//
// Test strategy: e2e dev bridge asserts at the DOM/store layer - open the
// compare for a finished 2-agent race and assert two diff columns render with
// their per-racer headers.

import { useEffect, useMemo, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { useRace } from "@/store/race";
import { AppDialog } from "@/components/ui/Dialog";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { taskDiff, taskSendDiffToMain, taskArchive } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Loader2, ArrowUpToLine } from "lucide-react";
import { StateDot, type WorkDot } from "@/components/task/RaceBoard";
import type { Task, TerminalTab, TaskDiffSummary } from "@/lib/types";

// A pathological agent could produce a huge diff; rendering every line as DOM
// across N columns would jank. Cap per column and note the truncation rather
// than silently dropping (a compare that hides changes is worse than useless).
const MAX_DIFF_LINES = 2000;

export function RaceCompare() {
  const raceCompareId = useUI(s => s.raceCompareId);
  const close = useUI(s => s.closeRaceCompare);
  const races = useRace(s => s.races);
  const tasks = useApp(s => s.tasks);

  const race = raceCompareId ? races[raceCompareId] ?? null : null;

  const cohort = useMemo(() => {
    if (!race) return [];
    return race.taskIds
      .map(id => tasks.find(t => t.id === id && !t.archived))
      .filter((t): t is Task => !!t);
  }, [race, tasks]);

  const open = !!race && cohort.length > 0;
  // Up to 3 racers share the width equally; beyond that each takes a fixed
  // width and the row scrolls horizontally so no column gets unreadably thin.
  const wide = cohort.length > 3;

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      title="Compare race"
      description={race?.prompt}
      className="max-w-[96vw] w-[96vw]"
    >
      <div className="mt-1 flex h-[80vh] min-h-0 gap-2 overflow-x-auto pb-1">
        {cohort.map(task => (
          <RaceColumn
            key={task.id}
            task={task}
            wide={wide}
            raceId={race?.id ?? ""}
            cohortIds={cohort.map(t => t.id)}
          />
        ))}
      </div>
    </AppDialog>
  );
}

function RaceColumn({ task, wide, raceId, cohortIds }: { task: Task; wide: boolean; raceId: string; cohortIds: string[] }) {
  const agents = useApp(s => s.agents);
  const tabs = useApp(s => s.tabs);
  const setActiveTask = useApp(s => s.setActiveTask);
  const proj = useApp(s => s.projects.find(p => p.id === task.project_id));
  const closeCompare = useUI(s => s.closeRaceCompare);

  const [summary, setSummary] = useState<TaskDiffSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adopting, setAdopting] = useState(false);

  const state: WorkDot = useMemo(() => {
    const main = (tabs[task.id] ?? []).find(
      (x): x is TerminalTab => x.type === "terminal" && !!x.is_default,
    );
    return (main?.workState ?? "idle") as WorkDot;
  }, [tabs, task.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    taskDiff(task.id)
      .then(s => { if (alive) setSummary(s); })
      .catch(e => { if (alive) setErr(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [task.id]);

  const iconId = resolveIconId(task.cli, agents);
  // Adopt = pick this racer the winner: apply its worktree diff into the
  // project's main checkout (committed + staged + unstaged) and copy its
  // untracked files. Same engine + guards as the toolbar's Send-to-main; the
  // main checkout must be clean, which the IPC hard-blocks. A main-checkout
  // task IS the destination, so it can never be a racer to adopt.
  const canAdopt = !task.is_main_checkout && !!summary && summary.files_changed > 0 && !adopting;
  const otherIds = cohortIds.filter(id => id !== task.id);

  async function adopt() {
    if (!canAdopt) return;
    // With more than one racer, offer to clear the losers in the same dialog so
    // a picked race doesn't strand N-1 dead worktrees in the sidebar. Opt-in
    // (default off): archiving removes real worktrees, so never silently.
    const req = {
      title: `Adopt "${task.name}"?`,
      message:
        `Applies this agent's changes (committed + staged + unstaged) and copies its untracked files into ${proj?.root_path ?? "the project's main checkout"}. ` +
        `The main checkout must be clean. Commit or stash there first.`,
      confirmLabel: "Adopt into main",
    };
    const res = otherIds.length
      ? await useUI.getState().askConfirm({
          ...req,
          checkbox: { label: `Also archive the ${otherIds.length} other racer${otherIds.length === 1 ? "" : "s"}`, defaultValue: false },
        })
      : await useUI.getState().askConfirm(req);
    const confirmed = typeof res === "boolean" ? res : res.confirmed;
    const archiveLosers = typeof res === "boolean" ? false : res.checked;
    if (!confirmed) return;
    setAdopting(true);
    try {
      const r = await taskSendDiffToMain(task.id);
      const parts: string[] = [];
      if (r.tracked_files)   parts.push(`${r.tracked_files} tracked diff${r.tracked_files === 1 ? "" : "s"} applied`);
      if (r.untracked_files) parts.push(`${r.untracked_files} untracked file${r.untracked_files === 1 ? "" : "s"} copied`);
      const summ = parts.length ? parts.join(", ") : "no changes to send";
      // Losers only get cleaned up AFTER the adopt succeeds - a failed apply
      // must leave every racer intact so the user can retry or pick another.
      let archived = 0;
      if (archiveLosers && otherIds.length) {
        for (const id of otherIds) {
          try { await taskArchive(id, true); archived++; } catch { /* best-effort */ }
        }
        if (raceId) useRace.getState().end(raceId);
        await useApp.getState().loadAll();
      }
      const tail = archived ? ` - archived ${archived} other racer${archived === 1 ? "" : "s"}` : "";
      useUI.getState().pushToast(`Adopted ${task.name} into main: ${summ}${tail}`, "success");
      closeCompare();
    } catch (e) {
      await useUI.getState().askConfirm({
        title: "Adopt failed",
        message: String(e),
        confirmLabel: "OK",
        cancelLabel: "",
        destructive: true,
      });
    } finally {
      setAdopting(false);
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]",
        wide ? "w-[440px] shrink-0" : "min-w-0 flex-1 basis-0",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-2">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId])}>
          <CliIcon cli={iconId} className="h-4 w-4" />
        </span>
        <button
          onClick={() => { setActiveTask(task.id); closeCompare(); }}
          title="Jump to this agent's terminal"
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--color-fg)] hover:text-[var(--color-accent)]"
        >
          {task.name}
        </button>
        <StateDot state={state} />
        {!task.is_main_checkout && (
          <button
            onClick={adopt}
            disabled={!canAdopt}
            title={
              adopting ? "Adopting..."
              : summary && summary.files_changed === 0 ? "Nothing to adopt: this agent made no changes"
              : "Adopt this agent's work into your main checkout"
            }
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-[11.5px] transition-colors",
              canAdopt
                ? "border-[var(--color-accent-soft)] text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
                : "cursor-not-allowed border-[var(--color-border)] text-[var(--color-fg-faint)]",
            )}
          >
            {adopting
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <ArrowUpToLine className="h-3.5 w-3.5" />}
            Adopt
          </button>
        )}
      </div>

      {summary && !loading && !err && (
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border-soft)] px-3 py-1.5 text-[11.5px] text-[var(--color-fg-dim)]">
          <span>{summary.files_changed} {summary.files_changed === 1 ? "file" : "files"}</span>
          <span className="text-[var(--color-ok)]">+{summary.insertions}</span>
          <span className="text-[var(--color-err)]">-{summary.deletions}</span>
          {summary.untracked > 0 && (
            <span className="text-[var(--color-fg-faint)]">{summary.untracked} new</span>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center gap-2 p-4 text-[12px] text-[var(--color-fg-dim)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" /> Loading diff...
          </div>
        )}
        {err && !loading && (
          <div className="p-4 font-mono text-[12px] text-[var(--color-err)]">Error: {err}</div>
        )}
        {!loading && !err && summary && <DiffBody text={summary.diff} />}
      </div>
    </div>
  );
}

// Lightweight unified-diff renderer: one <div> per line, colored by prefix. No
// CodeMirror - this is a read-only glance surface, so plain colored lines are
// far cheaper than N MergeView instances and read fine side by side.
function DiffBody({ text }: { text: string }) {
  const lines = useMemo(() => {
    if (!text.trim()) return null;
    const all = text.split("\n");
    const shown = all.slice(0, MAX_DIFF_LINES);
    return { rows: shown.map(classifyLine), truncated: all.length - shown.length };
  }, [text]);

  if (!lines) {
    return <div className="p-4 text-[12px] text-[var(--color-fg-dim)]">No changes yet.</div>;
  }

  return (
    <pre className="min-w-full whitespace-pre px-3 py-1.5 font-mono text-[11.5px] leading-[1.5]">
      {lines.rows.map((row, i) => (
        <div key={i} className={row.cls}>{row.text || " "}</div>
      ))}
      {lines.truncated > 0 && (
        <div className="mt-1 py-1 text-[var(--color-fg-faint)]">
          ... {lines.truncated} more lines (diff truncated for display)
        </div>
      )}
    </pre>
  );
}

function classifyLine(text: string): { text: string; cls: string } {
  if (text.startsWith("diff --git") || text.startsWith("index ") ||
      text.startsWith("+++") || text.startsWith("---") ||
      text.startsWith("new file") || text.startsWith("deleted file") ||
      text.startsWith("rename ") || text.startsWith("similarity ") ||
      text.startsWith("Binary files")) {
    return { text, cls: "text-[var(--color-fg-faint)]" };
  }
  if (text.startsWith("@@")) return { text, cls: "text-[var(--color-accent)]" };
  if (text.startsWith("+")) return { text, cls: "bg-[var(--color-ok)]/12 text-[var(--color-ok)]" };
  if (text.startsWith("-")) return { text, cls: "bg-[var(--color-err)]/12 text-[var(--color-err)]" };
  return { text, cls: "text-[var(--color-fg-dim)]" };
}
