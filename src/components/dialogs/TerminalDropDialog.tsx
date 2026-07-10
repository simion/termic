// Prompt shown when a file is dropped onto a SANDBOXED agent terminal.
//
// The agent runs under the macOS seatbelt, which hard-denies ~/Desktop,
// ~/Downloads, ~/Documents, ~/Pictures (see sandbox.rs). So inserting the
// dropped file's raw path would let the agent see the path but fail to read
// the file — looking broken. We ask the user how to share it instead.

import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { FolderOpen, FileCheck2, Clock } from "lucide-react";

function baseName(p: string): string {
  return p.split("/").pop() || p;
}
function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
}

export function TerminalDropDialog() {
  const drop = useUI(s => s.terminalDrop);
  const resolve = useUI(s => s.resolveTerminalDrop);
  if (!drop) return null;

  const { paths } = drop.req;
  const single = paths.length === 1;
  const fileLabel = single ? baseName(paths[0]) : `${paths.length} files`;
  // For the "allow folder" hint, show the common parent when it's the same
  // for every file; otherwise just say "their folders".
  const parents = Array.from(new Set(paths.map(parentDir)));
  const folderHint = parents.length === 1 ? parents[0] : "their folders";

  return (
    <AppDialog
      open
      onOpenChange={(v) => { if (!v) resolve({ kind: "cancel" }); }}
      title="Share a file with a sandboxed agent"
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4 pt-1 text-[13.5px] text-[var(--color-fg-dim)] leading-relaxed">
        <p>
          This task is sandboxed, so the agent can't read files from
          locations like Desktop or Downloads. Choose how to share{" "}
          <span className="font-medium text-[var(--color-fg)]">{fileLabel}</span>:
        </p>

        <div className="flex flex-col gap-2">
          {/* Recommended: copy into TMPDIR (already sandbox-readable). */}
          <button
            type="button"
            onClick={() => resolve({ kind: "temp" })}
            className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2.5 text-left hover:border-[var(--color-accent)] hover:bg-[var(--color-hover)] transition-colors"
          >
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
            <div>
              <div className="font-medium text-[var(--color-fg)]">
                Copy to a temp folder <span className="text-[11px] font-normal text-[var(--color-accent)]">recommended</span>
              </div>
              <div className="text-[12px] text-[var(--color-fg-faint)]">
                Copies the file somewhere the sandbox already allows and inserts that path. Works immediately, no restart, no permanent access.
              </div>
            </div>
          </button>

          {/* Allow the containing folder for this + future drops from there. */}
          <button
            type="button"
            onClick={() => resolve({ kind: "allow-folder" })}
            className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2.5 text-left hover:border-[var(--color-accent)] hover:bg-[var(--color-hover)] transition-colors"
          >
            <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
            <div>
              <div className="font-medium text-[var(--color-fg)]">Allow the folder</div>
              <div className="text-[12px] text-[var(--color-fg-faint)] break-all">
                Adds <code className="font-mono">{folderHint}</code> to this task's sandbox allow-list. Inserts the real path. Takes effect after the agent restarts.
              </div>
            </div>
          </button>

          {/* Allow just the exact file. */}
          <button
            type="button"
            onClick={() => resolve({ kind: "allow-file" })}
            className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2.5 text-left hover:border-[var(--color-accent)] hover:bg-[var(--color-hover)] transition-colors"
          >
            <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
            <div>
              <div className="font-medium text-[var(--color-fg)]">
                Allow {single ? "this exact file" : "these exact files"}
              </div>
              <div className="text-[12px] text-[var(--color-fg-faint)]">
                Adds only the dropped {single ? "file" : "files"} to the allow-list. Inserts the real path. Takes effect after the agent restarts.
              </div>
            </div>
          </button>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" type="button" onClick={() => resolve({ kind: "cancel" })}>
          Cancel
        </Button>
      </div>
    </AppDialog>
  );
}
