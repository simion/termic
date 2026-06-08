// Edit a workspace's resume-args override. When set, this string REPLACES
// termic's default resume logic (id-based `--resume <uuid>` for repo-root,
// `--continue` for worktrees) on the next agent spawn. It's split into argv
// tokens (quotes honored) and `{WORKSPACE_NAME}` / `{WORKSPACE_SLUG}` / etc.
// placeholders are expanded per-spawn, so a repo-root workspace can resume a
// named session, e.g. `--resume {WORKSPACE_NAME}`. The agent owns the
// "session not found" case (claude shows its resume picker), so there's no
// fast-exit fallback. Empty clears the override. Live PTYs keep running until
// the user restarts the agent tab.

import { useEffect, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { workspaceSetResumeOverride, ptyKill } from "@/lib/ipc";
import type { TerminalTab } from "@/lib/types";
import { History, RotateCcw } from "lucide-react";

export function ResumeOverrideDialog() {
  const wsId = useUI(s => s.resumeOverrideWsId);
  const close = useUI(s => s.closeResumeOverride);
  const ws = useApp(s => s.workspaces.find(w => w.id === wsId) ?? null);
  const setWorkspaceResumeOverride = useApp(s => s.setWorkspaceResumeOverride);

  const open = wsId !== null;
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Snapshot the workspace's override whenever the dialog opens for a new id.
  useEffect(() => {
    if (!open) return;
    setCommand(ws?.resume_override ?? "");
    setErr(null);
    setBusy(false);
  }, [open, ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The primary agent tab is the only one that resumes (secondary "+" tabs
  // always start fresh), so it's the only one worth restarting. Mirror
  // TerminalPane's primary-tab rule: the default tab, else the first agent
  // terminal tab. Shell / custom tabs never resume an agent session.
  const primaryAgentTab = (): TerminalTab | undefined => {
    const tabs = (useApp.getState().tabs[wsId ?? ""] ?? []).filter(
      t => t.type === "terminal" && (t as TerminalTab).cli !== "shell" && (t as TerminalTab).cli !== "custom",
    ) as TerminalTab[];
    return tabs.find(t => t.is_default) ?? tabs[0];
  };
  const liveAgent = open ? primaryAgentTab() : undefined;
  const canRestart = !!liveAgent?.ptyId;

  async function submit(restart: boolean) {
    if (!wsId || busy) return;
    const c = command.trim();
    setBusy(true); setErr(null);
    try {
      await workspaceSetResumeOverride(wsId, c);
      setWorkspaceResumeOverride(wsId, c);
      // Save & restart: SIGKILL the live primary agent and flag the
      // workspace so TerminalPane auto-respawns (reading the just-saved
      // override from the store) instead of showing the exited overlay.
      if (restart) {
        const t = primaryAgentTab();
        if (t?.ptyId) {
          useUI.getState().markPendingPtyRestart(wsId);
          await ptyKill(t.ptyId).catch(() => {});
        }
      }
      close();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title="Resume override"
      className="max-w-lg"
    >
      <p className="mb-4 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        Replaces the default resume arguments for{" "}
        <span className="font-mono">{ws?.name ?? "this workspace"}</span>'s agent.
        Use it to resume a named session instead of the auto-managed one, e.g.{" "}
        <span className="font-mono">--resume {"{WORKSPACE_NAME}"}</span>. Placeholders{" "}
        <span className="font-mono">{"{WORKSPACE_NAME}"}</span>,{" "}
        <span className="font-mono">{"{WORKSPACE_SLUG}"}</span>,{" "}
        <span className="font-mono">{"{BRANCH}"}</span> expand per launch. Leave
        empty for the default behavior. Restart the agent tab to apply.
      </p>

      <label className="block text-[13.5px]">
        Resume arguments
        <input
          type="text"
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              // ⌘/Ctrl+Enter saves AND restarts the live agent; a bare
              // Enter just saves (applies on the next launch).
              submit((e.metaKey || e.ctrlKey) && canRestart);
            }
          }}
          placeholder={"--resume {WORKSPACE_NAME}"}
          className="mt-1.5 box-border w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] leading-snug text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          autoFocus
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
          The agent handles a missing session (e.g. claude opens its resume
          picker). {canRestart
            ? <>Press <kbd className="font-mono">⌘↵</kbd> to save &amp; restart the running agent.</>
            : <>Press <kbd className="font-mono">↵</kbd> to save.</>}
        </span>
      </label>

      {err && <p className="mt-3 text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="secondary" disabled={busy} onClick={() => submit(false)}>
          <History className="h-4 w-4" /> Save
        </Button>
        {/* Always shown so the action is discoverable; disabled (with an
            explanation) when there's no live agent to restart, in which
            case plain Save already covers the next launch. */}
        <Button
          variant="primary"
          disabled={busy || !canRestart}
          title={canRestart ? undefined : "No agent is running in this workspace yet"}
          onClick={() => submit(true)}
        >
          <RotateCcw className="h-4 w-4" /> Save &amp; restart
        </Button>
      </div>
    </AppDialog>
  );
}
