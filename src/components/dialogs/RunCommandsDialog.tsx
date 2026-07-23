// Run configuration manager (GH #124). One place to edit a repo's run setup:
// the primary Run script, the Setup script, the Preview URL, and the list of
// extra Run commands. Split into Personal (projects.json) and Shared
// (.termic.yaml) via tabs, mirroring Settings. Opened from the file-tree "Add
// to Run scripts", the Run dropdown's "Manage run commands", and Settings.
//
// Reuses ScriptField + RunCommandsEditor for the fields and the runCommands.ts
// load/save helpers for persistence — no field↔store mapping lives here.

import { useEffect, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ScriptField } from "@/components/settings/ScriptField";
import { RunCommandsEditor } from "@/components/settings/RunCommandsEditor";
import {
  loadRunConfigs,
  savePersonalRunConfig, saveSharedRunConfig,
  type RunConfig,
} from "@/lib/runCommands";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

const EMPTY: RunConfig = { run: "", setup: "", preview: "", commands: [] };
type Store = "personal" | "yaml";

export function RunCommandsDialog() {
  const req = useUI(s => s.runCommandsDialog);
  const close = useUI(s => s.closeRunCommands);
  const projectId = req?.projectId ?? null;
  const open = projectId !== null;

  const project = useApp(s => s.projects.find(p => p.id === projectId));

  const [tab, setTab] = useState<Store>("personal");
  const [personal, setPersonal] = useState<RunConfig>(EMPTY);
  const [shared, setShared] = useState<RunConfig>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load both configs when the dialog opens. The default tab mirrors Settings:
  // .termic.yaml when the repo has a committed file, else Personal. Any
  // `initialAdd` (from a file-tree "Add to Run scripts") is seeded as a new
  // command on that same default store, so the row is visible on the tab that
  // opens.
  useEffect(() => {
    if (!open || !projectId) return;
    setErr(null); setBusy(false);
    const add = req?.initialAdd;
    loadRunConfigs(projectId)
      .then(({ personal, shared, hasSharedFile }) => {
        const target: Store = hasSharedFile ? "yaml" : "personal";
        const seed = (cfg: RunConfig): RunConfig =>
          add ? { ...cfg, commands: [...cfg.commands, { label: add.label, command: add.command }] } : cfg;
        setPersonal(target === "personal" ? seed(personal) : personal);
        setShared(target === "yaml" ? seed(shared) : shared);
        setTab(target);
      })
      .catch(() => { setPersonal(EMPTY); setShared(EMPTY); setTab("personal"); });
  }, [open, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = tab === "personal" ? personal : shared;
  const setCfg = tab === "personal" ? setPersonal : setShared;
  const patch = (p: Partial<RunConfig>) => setCfg(c => ({ ...c, ...p }));

  async function save() {
    if (!projectId || busy) return;
    setBusy(true); setErr(null);
    try {
      await savePersonalRunConfig(projectId, { ...personal, commands: personal.commands.filter(c => c.command.trim()) });
      await saveSharedRunConfig(projectId, { ...shared, commands: shared.commands.filter(c => c.command.trim()) });
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const tabs: { id: Store; label: string; hint: string }[] = [
    { id: "personal", label: "Personal",     hint: "this machine only" },
    { id: "yaml",     label: ".termic.yaml",  hint: "committed, team-shared" },
  ];

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title="Run configuration"
      className="max-w-2xl"
      // Don't auto-focus the first control (the Personal tab) on open — the
      // focus ring on the tab reads as a mis-styled button. Focus lands
      // naturally once the user interacts, same as the Settings tabs.
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <p className="mb-3 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        Run setup for <span className="font-mono">{project?.name ?? "this repo"}</span>. <b>Personal</b> stays on this machine; <b>.termic.yaml</b> is committed and shared with your team. Right-clicking a file seeds a command as <span className="font-mono">./file</span> — edit it to anything and press play to test.
      </p>

      {/* Personal / .termic.yaml tabs — same underline style as Settings. */}
      <div className="mb-4 flex items-center gap-1 border-b border-[var(--color-border-soft)]">
        {tabs.map(t => (
          <button
            key={t.id} type="button" onClick={() => setTab(t.id)}
            className={cn(
              "relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
              tab === t.id ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
            )}
          >
            {t.label}
            <span className="text-[11px] font-normal text-[var(--color-fg-faint)]">{t.hint}</span>
            {tab === t.id && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]" />}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-5">
        <div>
          <div className="text-[13.5px] font-medium">Preview URL</div>
          <div className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">
            Opened by the terminal panel's Open button. Supports <span className="font-mono">$TERMIC_PORT</span>, <span className="font-mono">$TERMIC_WORKSPACE_NAME</span>.
          </div>
          <Input
            value={cfg.preview}
            onChange={(e) => patch({ preview: e.target.value })}
            placeholder="http://localhost:$TERMIC_PORT"
            className="mt-2 font-mono"
          />
        </div>
        <ScriptField
          label="Setup script"
          hint="Runs once when a new task is created."
          value={cfg.setup}
          onChange={(v) => patch({ setup: v })}
          placeholder="npm install"
        />
        <ScriptField
          label="Run script"
          hint={<>Runs when you click the Run button. Use <span className="font-mono">$TERMIC_PORT</span> so each task gets its own port.</>}
          value={cfg.run}
          onChange={(v) => patch({ run: v })}
          placeholder="PORT=$TERMIC_PORT npm run dev"
        />
        <div>
          <div className="text-[13.5px] font-medium">Run commands</div>
          <div className="mt-0.5 mb-2 text-[12px] text-[var(--color-fg-dim)]">
            Extra commands shown in the Run dropdown, each opening its own run tab.
          </div>
          <RunCommandsEditor
            value={cfg.commands}
            onChange={(commands) => patch({ commands })}
          />
        </div>
      </div>

      {err && <p className="mt-3 text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={save}>
          <Check className="h-4 w-4" /> Save
        </Button>
      </div>
    </AppDialog>
  );
}
