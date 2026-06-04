// "Run a command in repo" dialog. Creates a repo-root workspace whose
// default tab launches a user-supplied command in a login shell instead
// of an agent CLI (ssh, a dev server, a REPL, anything). Both a name and
// a command are required — the name labels the sidebar row, the command
// is what runs. Mirrors the inline name-prompt of the agent "Run in repo"
// rows, but needs a form because there are two fields.

import { useEffect, useRef, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { workspaceOpenRepo } from "@/lib/ipc";
import { SquareChevronRight } from "lucide-react";

export function CustomCommandDialog() {
  const projectId = useUI(s => s.customCommandProjectId);
  const close = useUI(s => s.closeCustomCommand);
  const loadAll = useApp(s => s.loadAll);
  const setActive = useApp(s => s.setActiveWorkspace);

  const open = projectId !== null;
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cmdRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(""); setCommand(""); setErr(null); setBusy(false);
  }, [open]);

  async function submit() {
    const n = name.trim();
    const c = command.trim();
    if (!projectId || !n || !c || busy) return;
    setBusy(true); setErr(null);
    try {
      const w = await workspaceOpenRepo(projectId, "custom", n, c);
      await loadAll();
      setActive(w.id);
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
      title="New workspace with custom launch command"
      className="max-w-md"
    >
      <p className="mb-4 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        Opens the repo's current branch (no worktree) and launches your
        command in a login shell. When the command exits you drop back into
        a normal shell in the repo, so an ssh disconnect or stopped dev
        server leaves a usable terminal.
      </p>

      <label className="block text-[13.5px]">
        Name
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); cmdRef.current?.focus(); } }}
          placeholder="dev-server"
          className="mt-1.5"
          autoFocus
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
          Shown in the sidebar.
        </span>
      </label>

      <label className="mt-4 block text-[13.5px]">
        Command
        <textarea
          ref={cmdRef}
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            // ⌘/Ctrl+Enter launches; a bare Enter inserts a newline so a
            // multiline bash script stays freely editable.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}
          placeholder={"npm run dev\n# or any multiline bash script"}
          rows={5}
          className="mt-1.5 box-border min-h-[120px] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] leading-snug text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
          Runs in the repo root, e.g. <code className="mono">ssh box</code>,{" "}
          <code className="mono">npm run dev</code>, <code className="mono">python</code>.
          A multiline bash script is fine. Press <kbd className="font-mono">⌘↵</kbd> to launch.
        </span>
      </label>

      {err && <p className="mt-3 text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!name.trim() || !command.trim() || busy} onClick={submit}>
          <SquareChevronRight className="h-4 w-4" /> Launch
        </Button>
      </div>
    </AppDialog>
  );
}
