// Add Project dialog with discovered-repos shortcut.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { projectAdd, projectAddMulti, discoverRepos, settingsLoad } from "@/lib/ipc";
import type { DiscoveredRepo, Project } from "@/lib/types";
import { Folder, FolderPlus, Layers, X } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils";

export function NewProjectDialog() {
  const open = useUI(s => s.newProjectOpen);
  const close = useUI(s => s.closeNewProject);
  const pushToast = useUI(s => s.pushToast);
  const loadAll = useApp(s => s.loadAll);
  const projects = useApp(s => s.projects);
  const setProjectCollapsed = useApp(s => s.setProjectCollapsed);
  // Project type picker — defaults to "repo" (today's single-repo
  // flow). Switching to "multi" swaps the body to the host-picker +
  // member-multi-select form. Both flows reuse the same Add button.
  const [mode, setMode] = useState<"repo" | "multi">("repo");
  const [path, setPath] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredRepo[]>([]);
  const [reposDir, setReposDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Filter for the discovered-repos list. Shows when >5 repos so the
  // dialog stays uncluttered for small repos folders. Case-insensitive
  // substring match against name + path.
  const [filter, setFilter] = useState("");
  // Multi-repo: rich member rows (project_id + per-member scripts).
  // Stored as an array (order = display order) keyed by project_id.
  type MultiMember = { project_id: string; setup_script: string; run_script: string; archive_script: string };
  const [memberRows, setMemberRows] = useState<MultiMember[]>([]);
  // Multi-repo: user-visible project name. Required (drives the
  // auto-created host dir name when no host path is given, and the
  // sidebar label always).
  const [multiName, setMultiName] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("repo");
    setPath(""); setErr(null); setFilter("");
    setMemberRows([]);
    setMultiName("");
    (async () => {
      try {
        const s = await settingsLoad();
        setReposDir(s.repos_dir || "");
        if (s.repos_dir) {
          const repos = await discoverRepos(s.repos_dir);
          setDiscovered(repos.filter(r => !r.already_added));
        } else { setDiscovered([]); }
      } catch { setDiscovered([]); }
    })();
  }, [open]);

  async function add(p: string) {
    setBusy(true); setErr(null);
    try {
      const proj = await projectAdd(p);
      // Newly-added projects start expanded so the "+ Get started"
      // CTA is visible without an extra click — the empty-defaults-
      // to-collapsed fallback in Sidebar would otherwise hide it.
      setProjectCollapsed(proj.id, false);
      await loadAll();
      pushToast(`Added project “${proj.name}”`, "success");
      // Refresh discovery in case the same repos_dir has more candidates.
      if (reposDir) {
        const repos = await discoverRepos(reposDir).catch(() => []);
        const nextDiscovered = repos.filter(r => !r.already_added);
        setDiscovered(nextDiscovered);
        // If the current filter would leave the list empty after the
        // add (e.g. user typed the repo name to find it, ticked it,
        // and now nothing else matches), drop the filter so they see
        // the full list again. If something still matches, keep it -
        // probably mid-multi-add for similar names.
        const q = filter.trim().toLowerCase();
        if (q) {
          const stillVisible = nextDiscovered.some(r =>
            r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
          );
          if (!stillVisible) setFilter("");
        }
      }
      if (p === path) close();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  async function addMulti() {
    setBusy(true); setErr(null);
    try {
      // Empty path tells Rust to auto-create + git-init the host
      // under ~/termic/projects/<slug>/. Name is required either way.
      const proj = await projectAddMulti(path.trim(), multiName.trim(), memberRows);
      setProjectCollapsed(proj.id, false);
      await loadAll();
      pushToast(`Added multi-repo project “${proj.name}” (${memberRows.length} members)`, "success");
      close();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  function toggleMember(id: string) {
    setMemberRows(prev => {
      const exists = prev.some(m => m.project_id === id);
      if (exists) return prev.filter(m => m.project_id !== id);
      // Seed scripts from the member project's own defaults — the
      // user can edit inline below. They are project-scoped on the
      // new multi-repo project (independent of the member project's
      // own scripts going forward).
      const m = projects.find(p => p.id === id);
      return [...prev, {
        project_id: id,
        setup_script:   m?.setup_script   ?? "",
        run_script:     m?.run_script     ?? "",
        archive_script: m?.archive_script ?? "",
      }];
    });
  }
  function updateMember(id: string, patch: Partial<MultiMember>) {
    setMemberRows(prev => prev.map(m => m.project_id === id ? { ...m, ...patch } : m));
  }

  async function browse() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setPath(sel);
  }

  // List of projects eligible to be members (any already-added single
  // project; multi projects are excluded — nesting multi inside multi
  // is out of scope for v1).
  const memberCandidates: Project[] = projects.filter(
    p => (p.type ?? "single") === "single",
  );

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title="Add project"
      // Fixed width across both modes so toggling between Repository
      // and Multi-repo doesn't resize the dialog mid-decision. Sized
      // for multi-repo: per-member rows each have three script
      // textareas + a checkbox row, so the dialog needs real width
      // and benefits from the dialog-level vertical scrolling that
      // AppDialog provides by default.
      className="max-w-3xl"
    >
      {/* Segmented switch: Repository (default) vs Multi-repo.
          Sits at the very top so the user's first decision is the type
          of project they're adding — the body below swaps to match.
          Full-width 50/50 so both options carry the same visual weight
          and the user reads "choose one of two", not "primary CTA +
          afterthought". Two-line tiles (icon + name + descriptor) make
          the difference obvious before committing. */}
      <div className="mb-5 grid grid-cols-2 gap-2 text-[13px]">
        {([
          { id: "repo",  icon: Folder, label: "Repository",  hint: "One git repo. Worktrees branch off it." },
          { id: "multi", icon: Layers, label: "Multi-repo project", hint: "Several repos in one workspace. Shared memory across them." },
        ] as const).map(opt => {
          const active = mode === opt.id;
          const Ic = opt.icon;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setMode(opt.id)}
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-deep)]/15"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
              )}
            >
              <span className="flex items-center gap-1.5 font-medium text-[var(--color-fg)]">
                <Ic className={cn("h-3.5 w-3.5", active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]")} />
                {opt.label}
              </span>
              <span className="text-[11.5px] leading-snug text-[var(--color-fg-dim)]">{opt.hint}</span>
            </button>
          );
        })}
      </div>

      {mode === "multi" ? (
        <>
          <p className="mb-3 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
            A multi-repo project groups several repos under one workspace
            so an agent can work across them in a single session. Each
            workspace creates a folder with one worktree per member repo,
            plus a shared
            {" "}<code className="mono">CLAUDE.md</code> /{" "}
            <code className="mono">AGENTS.md</code> /{" "}
            <code className="mono">.claude/</code> the agent loads at startup,
            persistent business knowledge that lives across every workspace.
          </p>

          <label className="block text-[13.5px]">
            Name
            <Input
              value={multiName}
              onChange={e => setMultiName(e.target.value)}
              placeholder="team-knowledge"
              className="mt-1.5"
              autoFocus
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
            <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
              Shown in the sidebar. If no host repository is set below, this also
              names the auto-created host directory.
            </span>
          </label>

          <label className="mt-4 block text-[13.5px]">
            Host repository <span className="text-[var(--color-fg-faint)]">(optional)</span>
            <div className="mt-1.5 flex gap-2">
              <Input value={path} onChange={e => setPath(e.target.value)} placeholder="~/Notes/team-knowledge" />
              <Button variant="secondary" size="lg" onClick={browse}>Browse…</Button>
            </div>
            <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
              Where the shared <code className="mono">CLAUDE.md</code>,{" "}
              <code className="mono">AGENTS.md</code>, and{" "}
              <code className="mono">.claude/</code> live. Leave blank and Termic
              creates one at{" "}
              <code className="mono">~/termic/projects/&lt;name&gt;/</code>.
            </span>
          </label>

          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
              <span>Members</span>
              <span className="font-mono normal-case text-[11.5px] text-[var(--color-fg-faint)]">
                {memberRows.length} of {memberCandidates.length}
              </span>
            </div>
            {memberCandidates.length === 0 ? (
              <div className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-4 text-center text-[12.5px] text-[var(--color-fg-faint)]">
                No projects added yet. Add at least one repository first, then
                come back to create a multi-repo project that references it.
              </div>
            ) : (
              <>
                {memberRows.length === 0 ? (
                  <div className="rounded-md border border-dashed border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-6 text-center text-[12.5px] text-[var(--color-fg-faint)]">
                    No members yet. Click <b>Add member</b> below to pick repos to mount under this multi-repo project.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {memberRows.map(row => {
                      const p = memberCandidates.find(x => x.id === row.project_id);
                      if (!p) return null;
                      return (
                        <div key={row.project_id} className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)]">
                          <div className="flex items-center gap-3 px-3 py-2">
                            <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{p.name}</div>
                              <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{p.root_path}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => toggleMember(p.id)}
                              title="Remove from this multi-repo project"
                              className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-err)]/10 hover:text-[var(--color-err)]"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="flex flex-col gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/40 px-3 py-2">
                            <ScriptInput
                              label="Setup"
                              value={row.setup_script}
                              onChange={v => updateMember(p.id, { setup_script: v })}
                              placeholder={p.setup_script || "docker compose up -d"}
                            />
                            <ScriptInput
                              label="Run"
                              value={row.run_script}
                              onChange={v => updateMember(p.id, { run_script: v })}
                              placeholder={p.run_script || "PORT=$TERMIC_PORT npm run dev"}
                            />
                            <ScriptInput
                              label="Archive"
                              value={row.archive_script}
                              onChange={v => updateMember(p.id, { archive_script: v })}
                              placeholder={p.archive_script || "docker compose down"}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <AvailableMembersPicker
                  candidates={memberCandidates.filter(c => !memberRows.some(r => r.project_id === c.id))}
                  onAdd={(id) => toggleMember(id)}
                />
              </>
            )}
          </div>

          {err && <p className="mt-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!multiName.trim() || memberRows.length === 0 || busy}
              onClick={addMulti}
            >
              <Layers className="h-4 w-4" /> Add multi-repo
            </Button>
          </div>
        </>
      ) : (
      <>
      {discovered.length > 0 && (() => {
        const q = filter.trim().toLowerCase();
        const filtered = q
          ? discovered.filter(r =>
              r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
            )
          : discovered;
        return (
        <div className="mb-3">
          <div className="mb-1.5 flex items-baseline justify-between text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
            <span>Discovered repos</span>
            <span className="font-mono normal-case text-[11.5px] text-[var(--color-fg-faint)]">
              {q ? `${filtered.length} of ${discovered.length}` : discovered.length} in {reposDir}
            </span>
          </div>
          {discovered.length > 5 && (
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter…"
              className="mb-1.5"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
          <div className="max-h-[220px] overflow-auto rounded-md border border-[var(--color-border-soft)]">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-[12.5px] text-[var(--color-fg-faint)]">
                No repos match "{filter}".
              </div>
            ) : filtered.map(r => (
              <button key={r.path} onClick={() => add(r.path)} disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] hover:bg-[var(--color-hover)] disabled:opacity-50"
                title={r.path}
              >
                <Folder className="h-4 w-4 text-[var(--color-fg-faint)]" />
                <span className="flex-1 truncate">{r.name}</span>
                <span className="text-[11.5px] uppercase tracking-wider text-[var(--color-accent)] opacity-70">Add</span>
              </button>
            ))}
          </div>
          <div className="relative my-3 text-center">
            <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border-soft)]" />
            <span className="relative bg-[var(--color-bg-1)] px-2 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">or add manually</span>
          </div>
        </div>
        );
      })()}

      <label className="block text-[13.5px]">
        Repository root
        <div className="mt-1.5 flex gap-2">
          <Input value={path} onChange={e => setPath(e.target.value)} placeholder="/path/to/repo" />
          <Button variant="secondary" size="lg" onClick={browse}>Browse…</Button>
        </div>
      </label>

      {err && <p className="text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!path || busy} onClick={() => add(path)}>
          <FolderPlus className="h-4 w-4" /> Add
        </Button>
      </div>
      </>
      )}
    </AppDialog>
  );
}

/** Compact mono input for per-member script entries. Label on the
 *  left, single-row textarea on the right. Empty value = skip that
 *  script for the member. Placeholder shows the member project's
 *  standalone default so the user knows what gets inherited if they
 *  leave it blank (but they have to explicitly type it to opt in —
 *  empty means skip). */
function ScriptInput({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 shrink-0 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-1)] px-2 py-1 font-mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
      />
    </div>
  );
}

/** Collapsible "+ Add member" picker — same pattern as the
 *  RepositorySection editor. Default = single dashed button;
 *  click → list of available candidates; clicking a row adds + stays
 *  open if more remain, otherwise collapses. */
function AvailableMembersPicker({ candidates, onAdd }: {
  candidates: Project[];
  onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (candidates.length === 0) setOpen(false); }, [candidates.length]);
  if (candidates.length === 0 && !open) {
    return (
      <div className="mt-3 text-[11.5px] text-[var(--color-fg-faint)]">
        Every other repository is already a member.
      </div>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
      >
        + Add member
      </button>
    );
  }
  return (
    <div className="mt-3 rounded-md border border-[var(--color-border-soft)]">
      <div className="flex items-center justify-between px-3 py-1.5 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
        <span>Available repositories</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-0.5 hover:text-[var(--color-fg)]"
          aria-label="Close"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {candidates.map(c => (
        <button
          key={c.id}
          type="button"
          onClick={() => onAdd(c.id)}
          className="flex w-full items-center gap-3 border-t border-[var(--color-border-soft)] px-3 py-2 text-left hover:bg-[var(--color-hover)]"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{c.name}</div>
            <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{c.root_path}</div>
          </div>
          <span className="shrink-0 text-[11.5px] uppercase tracking-wider text-[var(--color-accent)] opacity-70">Add</span>
        </button>
      ))}
    </div>
  );
}
