// Edit a task's GOAL: free text recording what the task is for.
//
// It is text, not a state. It feeds no rule in `taskPhase`, so setting one
// never moves a task off Todo; a task carrying a goal with no `started_at` is
// what the dashboard draws as Planned, and that reading is rendered from those
// two fields rather than derived into a phase of its own (see the header of
// src/lib/taskPhase.ts).
//
// The New Task dialog's "Start later" checkbox is where most goals come from.
// This dialog is the way to add one afterwards, or to change one, or to clear
// it: an emptied box means no goal, which is the same answer `null`, an absent
// field and a box holding only spaces all give.
//
// A TEXTAREA, not an input. A goal typically arrives from the New Task
// dialog's multi-line prompt box, and `<input type="text">` silently strips
// the newlines out of its own value, so editing a pasted ticket here would
// flatten it on the way back out.

import { useEffect, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { taskGoalText } from "@/lib/taskNotes";
import { Target } from "lucide-react";

export function TaskGoalDialog() {
  const taskId = useUI(s => s.taskGoalTaskId);
  const close = useUI(s => s.closeTaskGoal);
  const task = useApp(s => s.tasks.find(w => w.id === taskId) ?? null);
  const setTaskGoal = useApp(s => s.setTaskGoal);

  const open = taskId !== null;
  const [goal, setGoal] = useState("");

  // Snapshot the record whenever the dialog opens for a new id, the same
  // shape ResumeOverrideDialog uses: this component is permanently mounted
  // from Dialogs.tsx, so nothing else resets its state between opens.
  useEffect(() => {
    if (!open) return;
    setGoal(task?.goal ?? "");
  }, [open, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function save() {
    if (!taskId) return;
    // The store trims and collapses an empty box to `null` itself, and bails
    // when nothing moved, so an unedited submit costs one array lookup and no
    // disk write (docs/performance.md bear trap 8).
    setTaskGoal(taskId, goal);
    close();
  }

  const had = taskGoalText(task ?? { goal: null });
  const clearing = had !== "" && goal.trim() === "";

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title={had ? "Edit goal" : "Set a goal"}
      className="max-w-lg"
    >
      <p className="mb-4 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        What <span className="font-mono">{task?.name ?? "this task"}</span> is
        for. It is a note, not a status: nothing is sent to the agent and the
        task's phase does not move. A task with a goal that nobody has prompted
        yet reads as planned on the dashboard.
      </p>

      <label className="block text-[13.5px]">
        Goal
        <textarea
          data-testid="task-goal-input"
          value={goal}
          onChange={e => setGoal(e.target.value)}
          rows={3}
          onKeyDown={e => {
            // Enter inserts a newline (a goal can be a pasted ticket), so the
            // keyboard save is the modifier. Stop the key here either way, so
            // a multi-line goal cannot trip anything the dialog binds.
            if (e.key === "Enter") {
              e.stopPropagation();
              if (e.metaKey || e.ctrlKey) { e.preventDefault(); save(); }
            }
          }}
          placeholder="Ship the parser rewrite behind a flag."
          className="mt-1.5 box-border max-h-[40vh] w-full resize-none overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px] leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          autoFocus
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
          {clearing
            ? "Empty: saving clears this task's goal."
            : <>Press <kbd className="font-mono">⌘↵</kbd> to save. Emptying the box clears the goal.</>}
        </span>
      </label>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={save} data-testid="task-goal-save">
          <Target className="h-4 w-4" /> Save goal
        </Button>
      </div>
    </AppDialog>
  );
}
