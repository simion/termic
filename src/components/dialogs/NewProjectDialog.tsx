// Add Project dialog with discovered-repos shortcut.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { projectAdd, projectAddMulti, discoverRepos, settingsLoad, pathIsGitRepo } from "@/lib/ipc";
import type { DiscoveredRepo, Project, ProjectMember } from "@/lib/types";
import { Folder, FolderPlus, Layers, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Where a non-git folder is being added — drives the confirm copy. We no
// longer ask the user to pre-declare "not a git repo" with a checkbox;
// instead we detect it after they pick a directory and confirm intent.
type ConfirmKind = "project" | "host" | "member";
const CONFIRM_COPY: Record<ConfirmKind, { title: string; body: string }> = {
  project: {
    title: "Add as a plain folder?",
    body: "This folder isn't a git repository. You can still add it as a plain folder project: agents run at the folder root, but there are no worktrees or branches.",
  },
  host: {
    title: "Add a non-git host?",
    body: "This folder isn't a git repository. It will host the shared knowledge files as a plain folder. Member repos still get their own worktrees per workspace.",
  },
  member: {
    title: "Add as a plain folder?",
    body: "This folder isn't a git repository. It mounts repo-root only (a live symlink), with no worktree or branch.",
  },
};

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
  // Issue #4: add a plain folder (not a git repo). In repo mode the
  // folder becomes a repo-root-only project (agent runs at the folder).
  // In multi mode it becomes a non-git HOST for the member repos.
  // No longer toggled by the user — set automatically once we detect the
  // picked directory isn't a git repo (and they confirm via the dialog).
  const [nonGit, setNonGit] = useState(false);
  // Pending non-git confirmation. We surface it as a Promise so the
  // browse / add flows can `await` the user's decision inline.
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; resolve: (ok: boolean) => void } | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredRepo[]>([]);
  const [reposDir, setReposDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Filter for the discovered-repos list. Shows when >5 repos so the
  // dialog stays uncluttered for small repos folders. Case-insensitive
  // substring match against name + path.
  const [filter, setFilter] = useState("");
  // Multi-repo: self-contained inline member rows (order = display order),
  // keyed by root_path. No project registration — a member is just a path
  // plus its per-project scripts.
  const [memberRows, setMemberRows] = useState<ProjectMember[]>([]);
  // Multi-repo: user-visible project name. Required (drives the
  // auto-created host dir name when no host path is given, and the
  // sidebar label always).
  const [multiName, setMultiName] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("repo");
    setPath(""); setErr(null); setFilter("");
    setNonGit(false);
    setConfirm(null);
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

  // Resolve the pending confirm dialog with the user's decision.
  function resolveConfirm(ok: boolean) {
    confirm?.resolve(ok);
    setConfirm(null);
  }
  // Open the non-git confirm dialog and resolve once the user decides.
  function confirmNonGit(kind: ConfirmKind): Promise<boolean> {
    return new Promise(resolve => setConfirm({ kind, resolve }));
  }
  // Decide how to treat a picked directory: a real git repo proceeds
  // straight through; a plain folder pops the confirm. Returns the
  // resolved non-git flag, or null if the user backed out.
  async function classify(p: string, kind: ConfirmKind): Promise<boolean | null> {
    const isGit = await pathIsGitRepo(p).catch(() => false);
    if (isGit) return false;
    return (await confirmNonGit(kind)) ? true : null;
  }

  async function add(p: string, asNonGit: boolean) {
    setBusy(true); setErr(null);
    try {
      const proj = await projectAdd(p, asNonGit);
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

  // Single-repo Add: detect git, confirm if it's a plain folder, then add.
  async function handleAdd() {
    const p = path.trim();
    if (!p) return;
    const ng = await classify(p, "project");
    if (ng === null) return;
    await add(path, ng);
  }

  async function addMulti(asNonGit: boolean) {
    setBusy(true); setErr(null);
    try {
      // Empty path tells Rust to auto-create + git-init the host
      // under ~/termic/projects/<slug>/. Name is required either way.
      const proj = await projectAddMulti(path.trim(), multiName.trim(), memberRows, asNonGit);
      setProjectCollapsed(proj.id, false);
      await loadAll();
      pushToast(`Added multi-repo project “${proj.name}” (${memberRows.length} members)`, "success");
      close();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  // Multi-repo Add: a host path is optional. When given, detect git and
  // confirm if it's a plain folder; an auto-created host is always git.
  async function handleAddMulti() {
    const host = path.trim();
    let ng = false;
    if (host) {
      const res = await classify(host, "host");
      if (res === null) return;
      ng = res;
    }
    await addMulti(ng);
  }

  // Add an inline member from an existing project — copies its path /
  // git status / base / scripts / sandbox lists into a self-contained
  // member. The source project is NOT referenced; nothing is registered.
  function addMemberFromProject(p: Project) {
    setMemberRows(prev => prev.some(m => m.root_path === p.root_path) ? prev : [...prev, {
      root_path: p.root_path,
      name: p.name,
      non_git: p.non_git,
      base_branch: p.base_branch,
      setup_script:   p.setup_script   ?? "",
      run_script:     p.run_script     ?? "",
      archive_script: p.archive_script ?? "",
      sandbox_rw_paths:      p.sandbox_rw_paths,
      sandbox_allowed_hosts: p.sandbox_allowed_hosts,
    }]);
  }
  // Add an inline member straight from a disk path (no project record).
  // Rust canonicalizes + detects git on submit; these are provisional.
  function addMemberFromDisk(path: string, asNonGit: boolean) {
    const name = path.split("/").filter(Boolean).pop() || "repo";
    setMemberRows(prev => prev.some(m => m.root_path === path) ? prev : [...prev, {
      root_path: path, name, non_git: asNonGit,
      base_branch: "", setup_script: "", run_script: "", archive_script: "",
    }]);
  }
  function removeMember(rootPath: string) {
    setMemberRows(prev => prev.filter(m => m.root_path !== rootPath));
  }
  function updateMember(rootPath: string, patch: Partial<ProjectMember>) {
    setMemberRows(prev => prev.map(m => m.root_path === rootPath ? { ...m, ...patch } : m));
  }

  async function browse() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel !== "string") return;
    // Detect git right after the pick so the form reflects reality (and
    // the "Folder" vs "Repository" label updates). A plain folder pops the
    // confirm; backing out leaves the field untouched.
    const ng = await classify(sel, mode === "multi" ? "host" : "project");
    if (ng === null) return;
    setPath(sel);
    setNonGit(ng);
  }

  // List of projects eligible to be members (any already-added single
  // project; multi projects are excluded — nesting multi inside multi
  // is out of scope for v1).
  const memberCandidates: Project[] = projects.filter(
    p => (p.type ?? "single") === "single",
  );

  return (
    <>
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
              <Input value={path} onChange={e => { setPath(e.target.value); setNonGit(false); }} placeholder="~/Notes/team-knowledge" />
              <Button variant="secondary" size="lg" onClick={browse}>Browse…</Button>
            </div>
            <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
              Where the shared <code className="mono">CLAUDE.md</code>,{" "}
              <code className="mono">AGENTS.md</code>, and{" "}
              <code className="mono">.claude/</code> live. Leave blank and Termic
              creates one at{" "}
              <code className="mono">~/termic/projects/&lt;name&gt;/</code>. A plain
              folder works too: we'll confirm after you pick it.
            </span>
          </label>

          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
              <span>Members</span>
              <span className="font-mono normal-case text-[11.5px] text-[var(--color-fg-faint)]">
                {memberRows.length} of {memberCandidates.length}
              </span>
            </div>
            <>
                {memberRows.length === 0 ? (
                  <div className="rounded-md border border-dashed border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-6 text-center text-[12.5px] text-[var(--color-fg-faint)]">
                    No members yet. Add repos below: pick from your existing projects or add any folder from disk.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {memberRows.map(row => (
                      <div key={row.root_path} className="overflow-hidden rounded-md border border-l-2 border-[var(--color-accent-soft)] border-l-[var(--color-accent)] bg-[var(--color-accent-deep)]/[0.07]">
                        <div className="flex items-center gap-3 px-3 py-2">
                          <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{row.name}</span>
                              {row.non_git && (
                                <span className="shrink-0 rounded bg-[var(--color-bg-1)] px-1 text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">folder</span>
                              )}
                            </div>
                            <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{row.root_path}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeMember(row.root_path)}
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
                            onChange={v => updateMember(row.root_path, { setup_script: v })}
                            placeholder="docker compose up -d"
                          />
                          <ScriptInput
                            label="Run"
                            value={row.run_script}
                            onChange={v => updateMember(row.root_path, { run_script: v })}
                            placeholder="PORT=$TERMIC_PORT npm run dev"
                          />
                          <ScriptInput
                            label="Archive"
                            value={row.archive_script}
                            onChange={v => updateMember(row.root_path, { archive_script: v })}
                            placeholder="docker compose down"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <AvailableMembersPicker
                  candidates={memberCandidates.filter(c => !memberRows.some(r => r.root_path === c.root_path))}
                  onAdd={addMemberFromProject}
                  onQuickAdd={async (path) => {
                    const asNonGit = await classify(path, "member");
                    if (asNonGit === null) return;
                    addMemberFromDisk(path, asNonGit);
                  }}
                />
              </>
          </div>

          {err && <p className="mt-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!multiName.trim() || memberRows.length === 0 || busy}
              onClick={handleAddMulti}
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
              <button key={r.path} onClick={() => { setPath(r.path); setNonGit(false); }} disabled={busy}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] hover:bg-[var(--color-hover)] disabled:opacity-50",
                  path === r.path && "bg-[var(--color-accent-deep)]/10",
                )}
                title={r.path}
              >
                <Folder className={cn("h-4 w-4", path === r.path ? "text-[var(--color-accent)]" : "text-[var(--color-fg-faint)]")} />
                <span className="flex-1 truncate">{r.name}</span>
                {path === r.path && (
                  <span className="text-[11.5px] uppercase tracking-wider text-[var(--color-accent)] opacity-70">Selected</span>
                )}
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
        {nonGit ? "Folder" : "Repository root"}
        <div className="mt-1.5 flex gap-2">
          <Input value={path} onChange={e => { setPath(e.target.value); setNonGit(false); }} placeholder="/path/to/repo" />
          <Button variant="secondary" size="lg" onClick={browse}>Browse…</Button>
        </div>
        {/* Issue #4: a plain folder (e.g. a parent dir of several repos)
            works too — it becomes a repo-root-only project (agents run at
            the folder, no worktrees). We detect git after you pick the dir
            and confirm before adding, so there's no checkbox to set. */}
        <span className="mt-1 block text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
          A git repo gets worktrees and branches. A plain folder works too: agents run at the folder root. We confirm after you pick it.
        </span>
      </label>

      {err && <p className="mt-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!path || busy} onClick={handleAdd}>
          <FolderPlus className="h-4 w-4" /> Add
        </Button>
      </div>
      </>
      )}
    </AppDialog>

    {/* Non-git confirm. Replaces the old "Not a git repository" checkboxes:
        we detect a plain folder after the user picks it, then ask here. */}
    <AppDialog
      open={!!confirm}
      onOpenChange={(v) => { if (!v) resolveConfirm(false); }}
      title={confirm ? CONFIRM_COPY[confirm.kind].title : ""}
      className="max-w-md"
    >
      {confirm && (
        <>
          <p className="text-[13.5px] leading-snug text-[var(--color-fg-dim)]">
            {CONFIRM_COPY[confirm.kind].body}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => resolveConfirm(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => resolveConfirm(true)}>
              <FolderPlus className="h-4 w-4" /> Add as folder
            </Button>
          </div>
        </>
      )}
    </AppDialog>
    </>
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
 *  click → list of available candidates; clicking a row copies that
 *  project's path/config into a self-contained member. `onQuickAdd`
 *  adds any folder from disk as a member (no project registration). */
function AvailableMembersPicker({ candidates, onAdd, onQuickAdd }: {
  candidates: Project[];
  onAdd: (p: Project) => void;
  onQuickAdd?: (path: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Path for the inline "Add repo from disk" row — same path + Browse
  // shape as the host field above, just rendered as a member row. Git
  // detection (and the non-git confirm) happens in onQuickAdd.
  const [diskPath, setDiskPath] = useState("");
  useEffect(() => {
    if (candidates.length === 0 && !onQuickAdd) setOpen(false);
  }, [candidates.length, onQuickAdd]);
  if (candidates.length === 0 && !onQuickAdd && !open) {
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
  const browseDisk = async () => {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setDiskPath(sel);
  };
  const addDisk = async () => {
    if (!onQuickAdd || busy) return;
    const p = diskPath.trim();
    if (!p) return;
    setBusy(true);
    try { await onQuickAdd(p); setDiskPath(""); } finally { setBusy(false); }
  };
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
      <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[11.5px] leading-snug text-[var(--color-fg-dim)]">
        Pick one of your existing projects to copy in, or use “Add repo from
        disk” for any folder. Members are self-contained: each carries its own
        scripts, and nothing is registered as a standalone project.
      </div>
      {candidates.map(c => (
        <button
          key={c.id}
          type="button"
          onClick={() => onAdd(c)}
          className="flex w-full items-center gap-3 border-t border-[var(--color-border-soft)] px-3 py-2 text-left hover:bg-[var(--color-hover)]"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{c.name}</div>
            <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{c.root_path}</div>
          </div>
          <span className="shrink-0 text-[11.5px] uppercase tracking-wider text-[var(--color-accent)] opacity-70">Add</span>
        </button>
      ))}
      {onQuickAdd && (
        <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/40 px-3 py-2.5">
          <div className="mb-1.5 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
            Add repo from disk
          </div>
          <div className="flex gap-2">
            <Input
              value={diskPath}
              onChange={e => setDiskPath(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addDisk(); } }}
              placeholder="/path/to/repo"
              className="flex-1"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
            <Button variant="secondary" size="lg" onClick={browseDisk} disabled={busy}>Browse…</Button>
            <Button variant="primary" size="lg" onClick={addDisk} disabled={busy || !diskPath.trim()}>
              {busy ? "Adding…" : "Add"}
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">
            Adds the folder as a member of this project only (no standalone project). A plain folder works too: we confirm after you pick it, then it mounts repo-root only (no worktree).
          </p>
        </div>
      )}
    </div>
  );
}
