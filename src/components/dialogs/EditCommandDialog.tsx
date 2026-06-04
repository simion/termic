// Edit the launch command of an existing custom-command workspace. The
// command is a multiline bash script — it's handed verbatim to a login
// shell (`zsh -lc "<script>; exec zsh -l"`) on every PTY spawn, so newlines,
// loops, multiple statements etc. all work. Saving persists the new script
// and re-seeds any open custom tab so the NEXT respawn runs it; the running
// PTY is untouched until the user restarts the agent tab.

import { useEffect, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { workspaceSetCustomCommand } from "@/lib/ipc";
import { SquareChevronRight } from "lucide-react";

export function EditCommandDialog() {
  const wsId = useUI(s => s.editCommandWsId);
  const close = useUI(s => s.closeEditCommand);
  const ws = useApp(s => s.workspaces.find(w => w.id === wsId) ?? null);
  const setWorkspaceCustomCommand = useApp(s => s.setWorkspaceCustomCommand);

  const open = wsId !== null;
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Snapshot the workspace's command whenever the dialog opens for a new id.
  useEffect(() => {
    if (!open) return;
    setCommand(ws?.custom_command ?? "");
    setErr(null);
    setBusy(false);
  }, [open, ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    const c = command.trim();
    if (!wsId || !c || busy) return;
    setBusy(true); setErr(null);
    try {
      await workspaceSetCustomCommand(wsId, c);
      setWorkspaceCustomCommand(wsId, c);
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title="Edit launch command"
      className="max-w-lg"
    >
      <p className="mb-4 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        Runs in <span className="font-mono">{ws?.name ?? "the workspace"}</span>'s
        repo root in a login shell. A multiline bash script is fine: newlines,
        loops, and multiple commands all run. Changes apply the next time the
        terminal launches, so restart the agent tab to pick them up live.
      </p>

      <label className="block text-[13.5px]">
        Command
        <textarea
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            // ⌘/Ctrl+Enter saves; a bare Enter inserts a newline so the
            // script stays freely editable.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={"npm run dev\n# or any multiline bash script"}
          rows={8}
          className="mt-1.5 box-border min-h-[160px] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] leading-snug text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          autoFocus
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
          Press <kbd className="font-mono">⌘↵</kbd> to save.
        </span>
      </label>

      {err && <p className="mt-3 text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!command.trim() || busy} onClick={submit}>
          <SquareChevronRight className="h-4 w-4" /> Save
        </Button>
      </div>
    </AppDialog>
  );
}
