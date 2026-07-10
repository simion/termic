// Progress overlay for a QUICK worktree create (the sidebar `+` inline row).
// Reuses the New Task dialog's ProgressBody so the fast inline path shows the
// same "Creating worktree & copying files…" feedback (and the same error
// surface) as a normal modal submit, without reopening the whole dialog.
// Driven by `useUI().taskCreateProgress`; the sidebar commit handler sets it.

import { useRef } from "react";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { ProgressBody } from "./NewTaskDialog";

export function QuickCreateProgressDialog() {
  const progress = useUI(s => s.taskCreateProgress);
  const setProgress = useUI(s => s.setTaskCreateProgress);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const open = progress !== null;
  return (
    <AppDialog
      open={open}
      // Locked while creating (the git worktree add / file copy can't be
      // cancelled mid-flight); dismissable once it has errored.
      onOpenChange={(v) => { if (!v && progress?.phase === "error") setProgress(null); }}
      title="New worktree"
      className="max-w-md"
    >
      {progress && (
        <ProgressBody
          phase={progress.phase}
          err={progress.err}
          setupLog={[]}
          outputRef={outputRef}
          onClose={() => setProgress(null)}
        />
      )}
    </AppDialog>
  );
}
