// Per-repository settings, persisted to projects.json via project_update.
// Mirrors Termic's "Repository" page: paths, base branch, files-to-copy,
// setup/run/archive scripts. The "Remove repository" action removes the
// project from our list — does NOT delete anything from disk.

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { projectUpdate, projectRemove } from "@/lib/ipc";
import type { Project } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Trash2, Check } from "lucide-react";

export function RepositorySection({ projectId }: { projectId: string }) {
  const project = useApp(s => s.projects.find(p => p.id === projectId));
  const loadAll = useApp(s => s.loadAll);
  const setView = useApp(s => s.setView);

  // Local working copy. Every patch debounces a `project_update` call (500ms
  // after last keystroke) — no explicit Save button. The status indicator
  // tells the user when the save lands so they know it's not lost.
  const [draft, setDraft] = useState<Project | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const savedFlashTimer = useRef<number | null>(null);
  // Skip the save-on-mount that would otherwise fire when we hydrate `draft`
  // from `project`. We only want saves driven by actual user edits.
  const firstSync = useRef(true);

  useEffect(() => {
    if (project) { setDraft({ ...project }); setErr(null); firstSync.current = true; }
  }, [project]);

  // CRITICAL: every hook in this component must run on every render — React
  // tracks hook calls by ordinal position. Moving these selectors AFTER the
  // early-return below skips them on renders where `project` is null, which
  // triggers "Rendered more hooks than during the previous render" the moment
  // the project shows up. Keep all hook calls above any conditional return.
  // The filter creates a new array each render — Zustand 5 warns about this.
  // We compute the count directly via a primitive-returning selector so the
  // snapshot stays stable across renders unless workspaces actually change.
  const wsCount = useApp(s => s.workspaces.reduce(
    (n, w) => n + (project && w.project_id === project.id ? 1 : 0), 0,
  ));
  const wtCount = useApp(s => s.workspaces.reduce(
    (n, w) => n + (project && w.project_id === project.id && !w.is_repo_root ? 1 : 0), 0,
  ));

  if (!project || !draft) return <div className="text-[13.5px] text-[var(--color-fg-faint)]">Repository not found.</div>;

  async function performSave(next: Project) {
    setStatus("saving"); setErr(null);
    try {
      const cleaned: Project = {
        ...next,
        files_to_copy: (next.files_to_copy as unknown as string[] | string)
          ? (Array.isArray(next.files_to_copy)
              ? next.files_to_copy
              : String(next.files_to_copy).split("\n").map(s => s.trim()).filter(Boolean))
          : [],
      };
      await projectUpdate(cleaned);
      await loadAll();
      setStatus("saved");
      // Auto-fade the "Saved" indicator after a couple seconds so it
      // doesn't permanently occupy real estate.
      if (savedFlashTimer.current) window.clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = window.setTimeout(() => setStatus("idle"), 1500) as unknown as number;
    } catch (e) { setErr(String(e)); setStatus("error"); }
  }

  function patch<K extends keyof Project>(k: K, v: Project[K]) {
    setDraft(d => {
      if (!d) return d;
      const next = { ...d, [k]: v };
      // Debounce the actual save — coalesces rapid keystrokes.
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => { void performSave(next); }, 500) as unknown as number;
      return next;
    });
  }
  void firstSync;  // reserved for future skip logic

  // Hoist into a const so TS keeps the non-null narrowing across closures.
  const proj = project;
  async function remove() {
    if (!proj) return;
    // Build a confirmation that's specific about the side effects.
    // Worktrees: get `git worktree remove` + `rm -rf` on disk.
    // Repo-root workspaces: just unregistered (the real repo stays put).
    // The user's actual git repo at root_path is NEVER touched.
    const lines = [
      `Remove project "${proj.name}"?`,
      "",
      wsCount === 0
        ? "No workspaces to remove."
        : `This will archive ${wsCount} workspace${wsCount === 1 ? "" : "s"}:`,
    ];
    if (wtCount > 0) {
      lines.push(`  • ${wtCount} git worktree${wtCount === 1 ? "" : "s"} will be removed from disk (rm -rf).`);
    }
    if (wsCount - wtCount > 0) {
      lines.push(`  • ${wsCount - wtCount} repo-root workspace${wsCount - wtCount === 1 ? "" : "s"} will be unregistered.`);
    }
    lines.push("", `Your repo at ${proj.root_path} is NOT touched.`, "", "Cannot be undone.");
    if (!confirm(lines.join("\n"))) return;
    const { setBusy } = useUI.getState();
    setBusy(`Removing "${proj.name}" and ${wsCount} workspace${wsCount === 1 ? "" : "s"}…`);
    try {
      await projectRemove(proj.id);
      await loadAll();
      setView("dashboard");
    } catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  }

  // files_to_copy → textarea text + back.
  const filesText = Array.isArray(draft.files_to_copy)
    ? draft.files_to_copy.join("\n")
    : String(draft.files_to_copy ?? "");

  return (
    <div className="flex flex-col gap-7">
      <div className="flex items-center gap-3">
        <input
          value={draft.name}
          onChange={(e) => patch("name", e.target.value)}
          className="bg-transparent text-[20px] font-medium outline-none border-b border-transparent focus:border-[var(--color-accent)] min-w-0 flex-1"
        />
      </div>

      <Field
        label="Root path"
        hint="The git repo on disk. Do not move or delete this directory — remove the repository in Termic instead."
        control={<Input value={draft.root_path} readOnly className="font-mono opacity-70 cursor-not-allowed" />}
      />

      <Field
        label="Workspaces path"
        hint="Where each new worktree lives. Don't move or delete subdirectories — archive workspaces in Termic instead."
        control={<Input value={draft.workspaces_path} onChange={(e) => patch("workspaces_path", e.target.value)} className="font-mono" />}
      />

      <Field
        label="Branch new workspaces from"
        hint="Each workspace is an isolated copy of your codebase, branched off here."
        control={<Input value={draft.base_branch} onChange={(e) => patch("base_branch", e.target.value)} className="font-mono" placeholder="origin/master" />}
      />

      <Field
        label="Remote"
        hint="Git remote name (used when resolving the base branch)."
        control={<Input value={draft.remote} onChange={(e) => patch("remote", e.target.value)} className="font-mono" placeholder="origin" />}
      />

      <Field
        label="Default CLI"
        hint="Which agent to spawn for new workspaces in this repo."
        control={
          <select
            value={draft.default_cli}
            onChange={(e) => patch("default_cli", e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[140px]"
          >
            <option value="claude">claude</option>
            <option value="gemini">gemini</option>
            <option value="codex">codex</option>
          </select>
        }
      />

      <div>
        <div className="text-[14px] font-medium">Preview URL</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Overrides the terminal panel's Open button URL. Supports Termic environment variables
          (<code className="font-mono">$TERMIC_WORKSPACE_NAME</code>,
          <code className="font-mono"> $TERMIC_PORT</code>, etc.). Leave blank to auto-detect from output logs.
        </div>
        <Input
          value={draft.preview_url}
          onChange={(e) => patch("preview_url", e.target.value)}
          className="mt-2 font-mono"
          placeholder="http://localhost:$TERMIC_PORT"
        />
      </div>

      <div>
        <div className="text-[14px] font-medium">Files to copy</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Termic will automatically copy these file paths from the repo root into each new workspace. One per line, glob patterns OK (e.g. <code className="font-mono">.env*</code>).
        </div>
        <textarea
          value={filesText}
          onChange={(e) => patch("files_to_copy", e.target.value.split("\n") as unknown as Project["files_to_copy"])}
          rows={5}
          placeholder=".env*&#10;src/config/local.py"
          className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <h2 className="text-[16px] font-medium">Scripts</h2>
        <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">
          Commands that run when workspaces are set up, run, or archived.
        </p>

        <div className="mt-4 flex flex-col gap-5">
          <ScriptField
            label="Setup script"
            hint="Runs when a new workspace is created."
            value={draft.setup_script}
            onChange={(v) => patch("setup_script", v)}
            placeholder="just up"
          />
          <ScriptField
            label="Run script"
            hint="Runs when you click the Run button."
            value={draft.run_script}
            onChange={(v) => patch("run_script", v)}
            placeholder="npm run dev"
          />
          <ScriptField
            label="Archive script"
            hint="Runs before a workspace is archived."
            value={draft.archive_script}
            onChange={(v) => patch("archive_script", v)}
            placeholder="rm -rf node_modules"
          />
        </div>
      </div>

      {err && <div className="text-[13px] text-[var(--color-err)]">{err}</div>}

      <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] pt-5">
        <Button variant="danger" size="sm" onClick={remove}>
          <Trash2 className="h-3.5 w-3.5" /> Remove repository
        </Button>

        {/* Auto-save status — debounced, no explicit Save button. */}
        <div className="text-[12px] text-[var(--color-fg-faint)] min-h-[1em]">
          {status === "saving" && <span>Saving…</span>}
          {status === "saved"  && (
            <span className="flex items-center gap-1 text-[var(--color-ok)]">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          {status === "error"  && <span className="text-[var(--color-err)]">Save failed</span>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div>
      <div className="text-[14px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      <div className="mt-2">{control}</div>
    </div>
  );
}

function ScriptField({ label, hint, value, onChange, placeholder }: {
  label: string; hint: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <div className="text-[13.5px] font-medium">{label}</div>
      <div className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">{hint}</div>
      <textarea
        value={value} onChange={(e) => onChange(e.target.value)} rows={2} placeholder={placeholder}
        className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
      />
    </div>
  );
}
