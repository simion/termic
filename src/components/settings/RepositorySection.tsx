// Per-repository settings, persisted to projects.json via project_update.
// Mirrors Termic's "Repository" page: paths, base branch, files-to-copy,
// setup/run/archive scripts. The "Remove repository" action removes the
// project from our list — does NOT delete anything from disk.

import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { projectUpdate, projectRemove, projectSetMembers, projectAdd, repoConfigLoad, repoConfigSave, workspaceSpotlightStop } from "@/lib/ipc";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Project, RepoConfig } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Trash2, Check, Layers, X, AudioWaveform } from "lucide-react";
import { cn } from "@/lib/utils";

export function RepositorySection({ projectId }: { projectId: string }) {
  const project = useApp(s => s.projects.find(p => p.id === projectId));
  const loadAll = useApp(s => s.loadAll);
  const setView = useApp(s => s.setView);
  const agents = useApp(s => s.agents);

  // Local working copy. Every patch debounces a `project_update` call (500ms
  // after last keystroke) — no explicit Save button. The status indicator
  // tells the user when the save lands so they know it's not lost.
  const [draft, setDraft] = useState<Project | null>(null);
  // Working copy of the repo's committed `.termic.yaml`. Single-repo
  // scripts + files-to-copy are edited here and saved via a separate
  // debounced `repo_config_save`. Initialized to the EFFECTIVE values:
  // a legacy `projects.json` script wins until the first edit migrates
  // it into `.termic.yaml`.
  const [rc, setRc] = useState<RepoConfig | null>(null);
  // Storage target for sandbox allow-lists and scripts/files — whether edits
  // write to the committed .termic.yaml (team-shared) or to projects.json
  // (personal overrides, local only). Reset on project switch.
  const [sandboxTarget, setSandboxTarget] = useState<"yaml" | "personal">("yaml");
  const [scriptTarget,  setScriptTarget]  = useState<"yaml" | "personal">("yaml");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  // Per-field save-success flash. patch() records every field key
  // touched between debounce intervals; on successful save those
  // get put in `flashKeys` for ~2s, which the inputs use to render
  // a green ring. Cleared automatically by the timer; the
  // touchedKeys ref accumulates across rapid edits until the
  // batched save fires.
  const touchedKeys = useRef<Set<string>>(new Set());
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set());
  const flashTimer = useRef<number | null>(null);
  // Sub-tab inside the per-project page. "scripts" is the default
  // landing tab — it's the most-edited surface. Reset on project
  // switch so jumping between projects lands on the same starting
  // point every time.
  const [subTab, setSubTab] = useState<SubTab>("scripts");
  useEffect(() => { setSubTab("scripts"); setSandboxTarget("yaml"); setScriptTarget("yaml"); }, [projectId]);
  const saveTimer = useRef<number | null>(null);
  const rcSaveTimer = useRef<number | null>(null);
  // Pending `.termic.yaml` payload, kept in a ref so a debounced save
  // can be flushed if Settings closes mid-edit.
  const pendingRc = useRef<RepoConfig | null>(null);
  const flushRcRef = useRef<() => void>(() => {});
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

  // Load raw `.termic.yaml` into rc. rc is the yaml content exactly —
  // draft (projects.json) is shown separately on the Personal tab.
  // Neither view merges the other; the user picks where to edit.
  // When no `.termic.yaml` exists yet, default the storage target to
  // Personal — there's nothing committed to edit, so the user almost
  // always wants their local override first.
  useEffect(() => {
    let cancelled = false;
    const empty: RepoConfig = {
      version: 1,
      scripts: { setup: "", run: "", archive: "", preview_url: "", files_to_copy: [] },
      sandbox: { enabled_by_default: false, allowed_hosts: [], allowed_paths: [] },
    };
    repoConfigLoad(projectId)
      .then(loaded => {
        if (cancelled) return;
        setRc(loaded ?? empty);
        // No committed config → auto-focus Personal. When it exists, the
        // project-switch reset already left the target on "yaml".
        if (!loaded) { setScriptTarget("personal"); setSandboxTarget("personal"); }
      })
      .catch(e => {
        if (cancelled) return;
        setErr(`Couldn't read .termic.yaml: ${e}`);
        setRc(empty);
        setScriptTarget("personal"); setSandboxTarget("personal");
      });
    return () => { cancelled = true; };
  }, [projectId]);

  // Flush a pending `.termic.yaml` save if Settings closes mid-edit so
  // a sub-debounce-window edit isn't silently dropped.
  useEffect(() => () => flushRcRef.current(), []);

  // Spotlight selectors — MUST live above the early-return so the hook
  // call count stays stable across renders (see CLAUDE.md hooks rule).
  const spotlightWsId = useApp(s => s.spotlightWsId[projectId] ?? null);
  const spotlightWsName = useApp(s => {
    const id = s.spotlightWsId[projectId];
    if (!id) return null;
    return s.workspaces.find(w => w.id === id)?.name ?? null;
  });

  if (!project || !draft) return <div className="text-[13.5px] text-[var(--color-fg-faint)]">Project not found.</div>;

  async function performSave(next: Project) {
    // Snapshot the keys we're about to commit + clear the accumulator
    // so the next round of edits gets its own batch.
    const batchKeys = new Set(touchedKeys.current);
    touchedKeys.current = new Set();
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
      // Light up every field that was part of this save batch with a
      // 2s green ring. Replaces (rather than unions) the previous
      // flash so a fresh save resets the timer cleanly.
      setFlashKeys(batchKeys);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashKeys(new Set()), 2000) as unknown as number;
      // Auto-fade the "Saved" indicator after a couple seconds so it
      // doesn't permanently occupy real estate.
      if (savedFlashTimer.current) window.clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = window.setTimeout(() => setStatus("idle"), 1500) as unknown as number;
    } catch (e) { setErr(String(e)); setStatus("error"); }
  }

  function patch<K extends keyof Project>(k: K, v: Project[K]) {
    touchedKeys.current.add(k as string);
    setDraft(d => {
      if (!d) return d;
      const next = { ...d, [k]: v };
      // Debounce the actual save — coalesces rapid keystrokes.
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => { void performSave(next); }, 500) as unknown as number;
      return next;
    });
  }
  // Tailwind class fragment applied to an input/textarea for ~2s
  // after a successful save of its field. Swaps the border color
  // to ok-green (overriding both the resting and focused borders
  // via `!important` so it wins even while the user is still in
  // the field). transition-colors makes the swap fade in/out
  // smoothly when the 2s window opens and closes.
  const flashRing = (k: keyof Project) =>
    flashKeys.has(k as string)
      ? "!border-[var(--color-ok)] focus:!border-[var(--color-ok)] transition-colors"
      : "transition-colors";
  void firstSync;  // reserved for future skip logic

  // ── `.termic.yaml` (rc) editing ──
  function flushRcSave() {
    if (rcSaveTimer.current) { window.clearTimeout(rcSaveTimer.current); rcSaveTimer.current = null; }
    const next = pendingRc.current;
    if (!next) return;
    pendingRc.current = null;
    const cleaned: RepoConfig = {
      ...next,
      scripts: {
        ...next.scripts,
        files_to_copy: next.scripts.files_to_copy.map(s => s.trim()).filter(Boolean),
      },
    };
    setStatus("saving"); setErr(null);
    repoConfigSave(projectId, cleaned)
      .then(() => {
        setStatus("saved");
        if (savedFlashTimer.current) window.clearTimeout(savedFlashTimer.current);
        savedFlashTimer.current = window.setTimeout(() => setStatus("idle"), 1500) as unknown as number;
      })
      .catch(e => { setErr(String(e)); setStatus("error"); });
  }
  flushRcRef.current = flushRcSave;

  function scheduleRcSave(next: RepoConfig) {
    pendingRc.current = next;
    if (rcSaveTimer.current) window.clearTimeout(rcSaveTimer.current);
    rcSaveTimer.current = window.setTimeout(flushRcSave, 500) as unknown as number;
  }
  function patchScript(which: "setup" | "run" | "archive", v: string) {
    setRc(prev => {
      if (!prev) return prev;
      const next = { ...prev, scripts: { ...prev.scripts, [which]: v } };
      scheduleRcSave(next);
      return next;
    });
  }
  function patchRcPreview(url: string) {
    setRc(prev => {
      if (!prev) return prev;
      const next = { ...prev, scripts: { ...prev.scripts, preview_url: url } };
      scheduleRcSave(next);
      return next;
    });
  }
  function patchFilesToCopy(text: string) {
    setRc(prev => {
      if (!prev) return prev;
      const next = { ...prev, scripts: { ...prev.scripts, files_to_copy: text.split("\n") } };
      scheduleRcSave(next);
      return next;
    });
  }
  function patchRcSandbox(paths: string[], hosts: string[]) {
    setRc(prev => {
      if (!prev) return prev;
      const next = { ...prev, sandbox: { ...prev.sandbox, allowed_paths: paths, allowed_hosts: hosts } };
      scheduleRcSave(next);
      return next;
    });
  }

  // Hoist into a const so TS keeps the non-null narrowing across closures.
  const proj = project;
  async function remove() {
    if (!proj) return;
    // Build a confirmation that's specific about the side effects.
    // Worktrees: get `git worktree remove` + `rm -rf` on disk.
    // Repo-root workspaces: just unregistered (the real repo stays put).
    // The user's actual git repo at root_path is NEVER touched.
    const parts: string[] = [];
    parts.push(
      wsCount === 0
        ? "No workspaces to remove."
        : `Archives ${wsCount} workspace${wsCount === 1 ? "" : "s"}.`,
    );
    if (wtCount > 0) parts.push(`${wtCount} git worktree${wtCount === 1 ? "" : "s"} removed from disk (rm -rf).`);
    if (wsCount - wtCount > 0) parts.push(`${wsCount - wtCount} repo-root entr${wsCount - wtCount === 1 ? "y" : "ies"} unregistered.`);
    parts.push(`Your repo at ${proj.root_path} is NOT touched. Cannot be undone.`);
    const ok = await useUI.getState().askConfirm({
      title: `Remove project "${proj.name}"?`,
      message: parts.join(" "),
      confirmLabel: "Remove project",
      destructive: true,
    });
    if (!ok) return;
    const { setBusy } = useUI.getState();
    setBusy(`Removing "${proj.name}" and ${wsCount} workspace${wsCount === 1 ? "" : "s"}…`);
    try {
      await projectRemove(proj.id);
      await loadAll();
      setView("dashboard");
    } catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  }

  const isMulti = (draft.type ?? "single") === "multi";
  // For single-repo, files-to-copy source depends on which tab is active.
  const filesArr = isMulti || scriptTarget === "personal"
    ? (Array.isArray(draft.files_to_copy) ? draft.files_to_copy : [])
    : (rc?.scripts.files_to_copy ?? []);
  const filesText = filesArr.join("\n");
  // Tab order signals importance + frequency of edit:
  //   Scripts first  → the thing you actually came here to tune
  //   Files / Sandbox → focused single-concept tabs
  //   More last      → set-once metadata (paths, branch, remote)
  //                    + irreversible Remove action at the bottom
  const tabs: { id: SubTab; label: string }[] = [
    { id: "scripts",  label: isMulti ? "Members & scripts" : "Scripts & run" },
    { id: "sandbox",  label: "Sandbox" },
    { id: "advanced", label: "More" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Project-name input doubles as the page title — same pattern
          as the previous flat layout, kept on top above the sub-tabs
          so renaming is always one click away regardless of which
          sub-tab is active. */}
      <div className="flex items-center gap-3">
        <input
          value={draft.name}
          onChange={(e) => patch("name", e.target.value)}
          className={cn(
            "bg-transparent text-[20px] font-medium outline-none border-b border-transparent focus:border-[var(--color-accent)] min-w-0 flex-1",
            flashKeys.has("name") && "border-b-[var(--color-ok)]",
          )}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <div className="text-[12px] text-[var(--color-fg-faint)] min-h-[1em] shrink-0">
          {status === "saving" && <span>Saving…</span>}
          {status === "saved"  && (
            <span className="flex items-center gap-1 text-[var(--color-ok)]">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          {status === "error"  && <span className="text-[var(--color-err)]">Save failed</span>}
        </div>
      </div>

      {/* Sub-tab strip. Mirrors the top-level Settings rail's pill
          shape but rendered horizontally inline with the page —
          keeps the project page self-contained without nesting a
          second sidebar. Active tab = filled bg-2, inactive = dim
          fg + soft hover. Visible always so users can flip between
          tabs without scrolling first. */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)]">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            className={cn(
              "relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
              subTab === t.id
                ? "text-[var(--color-fg)]"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
            )}
          >
            {t.label}
            {/* Underline that lines up with the bottom border of the
                tab strip. -mb-px on the parent puts us right on top of
                the border. */}
            {subTab === t.id && (
              <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]" />
            )}
          </button>
        ))}
      </div>

      {subTab === "scripts" && (
        <div className="flex flex-col gap-7">
          {/* Storage target strip — same underline-tab pattern as
              Scripts / Sandbox / More. Hidden for multi-repo projects
              since they always write to projects.json (no single
              canonical .termic.yaml to target). */}
          {!isMulti && (
            <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)]">
              {([
                { id: "personal", label: "Personal",     hint: "overrides when set"   },
                { id: "yaml",     label: ".termic.yaml", hint: "committed to git repo" },
              ] as const).map(t => (
                <button
                  key={t.id} type="button"
                  onClick={() => setScriptTarget(t.id)}
                  className={cn(
                    "relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
                    scriptTarget === t.id
                      ? "text-[var(--color-fg)]"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  {t.label}
                  <span className="text-[11px] font-normal text-[var(--color-fg-faint)]">{t.hint}</span>
                  {scriptTarget === t.id && (
                    <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Preview URL */}
          <div>
            <div className="text-[14px] font-medium">Preview URL</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              URL the terminal panel's Open button opens. Supports{" "}
              <Token>$TERMIC_WORKSPACE_NAME</Token>,{" "}
              <Token>$TERMIC_PORT</Token>, etc.
              Blank = auto-detect from output logs.
            </div>
            <Input
              value={!isMulti && scriptTarget === "yaml" ? (rc?.scripts.preview_url ?? "") : draft.preview_url}
              onChange={(e) => !isMulti && scriptTarget === "yaml"
                ? patchRcPreview(e.target.value)
                : patch("preview_url", e.target.value)}
              className={cn("mt-2 font-mono", !isMulti && scriptTarget === "personal" && flashRing("preview_url"))}
              placeholder="http://localhost:$TERMIC_PORT"
            />
          </div>

          {isMulti ? (
            <MultiMembersEditor project={draft} onSaved={() => { void loadAll(); }} />
          ) : (
            <div className="flex flex-col gap-5">
              <ScriptField
                label="Setup script"
                hint="Runs when a new workspace is created."
                value={scriptTarget === "yaml" ? (rc?.scripts.setup ?? "") : (draft.setup_script ?? "")}
                onChange={(v) => scriptTarget === "yaml" ? patchScript("setup", v) : patch("setup_script", v)}
                placeholder="docker compose up -d"
                flash={scriptTarget === "personal" && flashKeys.has("setup_script")}
              />
              <ScriptField
                label="Run script"
                hint={<>Runs when you click the Run button. Use <Token>$TERMIC_PORT</Token> so each workspace gets its own port.</>}
                value={scriptTarget === "yaml" ? (rc?.scripts.run ?? "") : (draft.run_script ?? "")}
                onChange={(v) => scriptTarget === "yaml" ? patchScript("run", v) : patch("run_script", v)}
                placeholder="PORT=$TERMIC_PORT npm run dev"
                flash={scriptTarget === "personal" && flashKeys.has("run_script")}
              />
              <ScriptField
                label="Archive script"
                hint="Runs before a workspace is archived. Termic already removes the worktree dir + its contents, so this is for stopping external services your run script started."
                value={scriptTarget === "yaml" ? (rc?.scripts.archive ?? "") : (draft.archive_script ?? "")}
                onChange={(v) => scriptTarget === "yaml" ? patchScript("archive", v) : patch("archive_script", v)}
                placeholder="docker compose down"
                flash={scriptTarget === "personal" && flashKeys.has("archive_script")}
              />
            </div>
          )}

          {/* Files to copy */}
          <div>
            <div className="text-[14px] font-medium">Files to copy</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              Copied from the repo root into each new workspace. One per line, glob patterns OK (e.g. <code className="font-mono">.env*</code>).
            </div>
            <textarea
              value={filesText}
              onChange={(e) => {
                if (isMulti || scriptTarget === "personal") {
                  patch("files_to_copy", e.target.value.split("\n") as unknown as Project["files_to_copy"]);
                } else {
                  patchFilesToCopy(e.target.value);
                }
              }}
              rows={6}
              placeholder=".env*&#10;src/config/local.py"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              className={cn(
                "mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]",
                scriptTarget === "personal" && flashRing("files_to_copy"),
              )}
            />
          </div>

          {/* Spotlight — lives in Scripts & run because it controls
              how the run command is executed (root path vs worktree). */}
          <div className="border-t border-[var(--color-border-soft)] pt-6">
            <div className="mb-3 flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
              <AudioWaveform className="h-4 w-4 text-[var(--color-accent)]" />
              Spotlight
            </div>

            {isMulti ? (
              <p className="text-[13px] text-[var(--color-fg-faint)]">
                Spotlight is not supported for multi-repo projects.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <label className="flex cursor-pointer items-start gap-3 select-none">
                  <Checkbox
                    checked={!!draft.spotlight_enabled}
                    onChange={(v) => patch("spotlight_enabled", v as any)}
                  />
                  <div>
                    <span className="text-[13.5px] font-medium text-[var(--color-fg)]">
                      Enable spotlight for this project
                    </span>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
                      When enabled, you can spotlight a workspace from its settings menu.
                      Spotlight syncs that workspace's changes to your main checkout automatically
                      so you can run and test from there. Committed changes appear as a checkpoint
                      commit on main; uncommitted edits sync as working-tree changes; untracked
                      files are copied (.gitignore respected). Main must be clean to start.
                      Stopping spotlight removes the checkpoint commit and restores main.
                      While spotlight is active, the run script executes at the repo root.
                    </p>
                  </div>
                </label>

                {draft.spotlight_enabled && (
                  <div className="ml-7">
                    {spotlightWsName ? (
                      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3 py-2">
                        <AudioWaveform className="termic-spotlight-wave h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                        <span className="flex-1 text-[13px] text-[var(--color-fg)]">
                          <strong>{spotlightWsName}</strong> is spotlighted right now
                        </span>
                        <button
                          type="button"
                          onClick={() => workspaceSpotlightStop(spotlightWsId!).catch(e =>
                            useUI.getState().pushToast(String(e), "error")
                          )}
                          className="rounded px-2.5 py-1 text-[12px] font-medium bg-[var(--color-bg-3)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
                        >
                          Stop
                        </button>
                      </div>
                    ) : (
                      <p className="text-[12.5px] text-[var(--color-fg-faint)]">
                        No workspace is spotlighted right now.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === "sandbox" && (
        <div>
          <h2 className="text-[16px] font-medium">Sandbox</h2>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">
            When a workspace is sandboxed, the agent runs under macOS seatbelt: the filesystem is allow-listed (workspace + agent state + caches + dirs you list); HTTPS goes through an in-process per-workspace proxy filtered against the host allowlist. Secrets (<code className="font-mono">~/.ssh</code>, <code className="font-mono">~/.aws</code>, <code className="font-mono">~/.gnupg</code>, <code className="font-mono">~/.netrc</code>, <code className="font-mono">~/.kube</code>, …) and personal data (<code className="font-mono">~/Documents</code>, <code className="font-mono">~/Desktop</code>, <code className="font-mono">~/Downloads</code>, browser data, mail) are denied by default.
          </p>
          <div className="mt-4 flex flex-col gap-5">
            <label className="inline-flex cursor-pointer items-center gap-2 select-none">
              <Checkbox
                checked={!!draft.default_sandbox}
                onChange={(v) => patch("default_sandbox", v as any)}
              />
              <span className="text-[13.5px] font-medium">Sandbox new workspaces by default</span>
            </label>

            {/* Storage target tabs — same underline-tab style as the
                top-level Scripts / Sandbox / More strip. Controls
                whether the allow-lists below read/write the committed
                .termic.yaml (shared with the team) or the local
                projects.json personal override. Both layers are merged
                at spawn time. */}
            <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)]">
              {([
                { id: "personal", label: "Personal",     hint: "local only · merged on top" },
                { id: "yaml",     label: ".termic.yaml", hint: "committed to git repo" },
              ] as const).map(t => (
                <button
                  key={t.id} type="button"
                  onClick={() => setSandboxTarget(t.id)}
                  className={cn(
                    "relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
                    sandboxTarget === t.id
                      ? "text-[var(--color-fg)]"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  {t.label}
                  <span className="text-[11px] font-normal text-[var(--color-fg-faint)]">{t.hint}</span>
                  {sandboxTarget === t.id && (
                    <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]" />
                  )}
                </button>
              ))}
            </div>

            <Field
              label="Allowed paths"
              hint="Dirs the agent can read AND write. One per line. ~, $HOME, and $WORKSPACE expand at spawn time."
              control={
                <textarea
                  value={sandboxTarget === "yaml"
                    ? (rc?.sandbox.allowed_paths ?? []).join("\n")
                    : (draft.sandbox_rw_paths ?? []).join("\n")}
                  onChange={(e) => {
                    const lines = e.target.value.split("\n");
                    if (sandboxTarget === "yaml") {
                      patchRcSandbox(lines, rc?.sandbox.allowed_hosts ?? []);
                    } else {
                      patch("sandbox_rw_paths", lines.map(s => s.trim()).filter(Boolean) as any);
                    }
                  }}
                  rows={3}
                  placeholder={"$HOME/Work/other-project\n$HOME/Notes"}
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  className={cn(
                    "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]",
                    sandboxTarget === "personal" && flashRing("sandbox_rw_paths"),
                  )}
                />
              }
            />
            <Field
              label="Allowed hosts"
              hint="One per line. Use * as a wildcard. Per-CLI vendor + GitHub + npm/pypi/crates.io are always allowed; these are extras."
              control={
                <textarea
                  value={sandboxTarget === "yaml"
                    ? (rc?.sandbox.allowed_hosts ?? []).join("\n")
                    : (draft.sandbox_allowed_hosts ?? []).join("\n")}
                  onChange={(e) => {
                    const lines = e.target.value.split("\n");
                    if (sandboxTarget === "yaml") {
                      patchRcSandbox(rc?.sandbox.allowed_paths ?? [], lines);
                    } else {
                      patch("sandbox_allowed_hosts", lines.map(s => s.trim()).filter(Boolean) as any);
                    }
                  }}
                  rows={4}
                  placeholder={"*.mycompany.com\nbitbucket.org"}
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  className={cn(
                    "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]",
                    sandboxTarget === "personal" && flashRing("sandbox_allowed_hosts"),
                  )}
                />
              }
            />
          </div>
        </div>
      )}

      {subTab === "advanced" && (
        <div className="flex flex-col gap-7">
          <Field
            label="Default CLI"
            hint="Which agent to spawn for new workspaces in this repo. Pick Terminal for a plain login shell (no agent)."
            control={
              <select
                value={draft.default_cli}
                onChange={(e) => patch("default_cli", e.target.value)}
                className={cn(
                  "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[140px]",
                  flashRing("default_cli"),
                )}
              >
                {/* Built from the editable agent registry so custom
                    agents show up here too. Terminal (cli="shell") is
                    always available as the no-agent fallback. */}
                {agents
                  .filter(a => !a.disabled)
                  .map(a => (
                    <option key={a.id} value={a.id}>{a.display_name}</option>
                  ))}
                <option value="shell">Terminal</option>
              </select>
            }
          />
          <Field
            label="Root path"
            hint="The git repo on disk. Do not move or delete this directory; remove the project in Termic instead."
            control={<Input value={draft.root_path} readOnly className="font-mono opacity-70 cursor-not-allowed" />}
          />
          <Field
            label="Workspaces path"
            hint="Where each new worktree lives. Don't move or delete subdirectories; archive workspaces in Termic instead."
            control={<Input value={draft.workspaces_path} onChange={(e) => patch("workspaces_path", e.target.value)} className={cn("font-mono", flashRing("workspaces_path"))} />}
          />
          <Field
            label="Branch new workspaces from"
            hint="Each workspace is an isolated copy of your codebase, branched off here."
            control={<Input value={draft.base_branch} onChange={(e) => patch("base_branch", e.target.value)} className={cn("font-mono", flashRing("base_branch"))} placeholder="origin/master" />}
          />
          <Field
            label="Remote"
            hint="Git remote name (used when resolving the base branch)."
            control={<Input value={draft.remote} onChange={(e) => patch("remote", e.target.value)} className={cn("font-mono", flashRing("remote"))} placeholder="origin" />}
          />

          {/* Danger zone pinned to the bottom of More — same
              page as the rarely-touched metadata, since it's also
              rarely-touched + irreversible. Distinct red card so it
              can't be confused with the editable fields above. */}
          <div className="mt-2 rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/5 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium text-[var(--color-fg)]">Remove project</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  Drops the project from the sidebar + archives every workspace under it. The actual repo at <code className="font-mono">{draft.root_path}</code> stays on disk.
                </div>
              </div>
              <Button variant="danger" size="sm" onClick={remove} className="shrink-0">
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </div>
          </div>
        </div>
      )}

      {err && <div className="text-[13px] text-[var(--color-err)]">{err}</div>}
    </div>
  );
}

type SubTab = "scripts" | "sandbox" | "advanced";

function Field({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div>
      <div className="text-[14px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      <div className="mt-2">{control}</div>
    </div>
  );
}

function ScriptField({ label, hint, value, onChange, placeholder, flash }: {
  label: string;
  hint: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** When true (set by the parent for ~2s after a successful save
   *  of this field), the textarea gets a soft green ring. */
  flash?: boolean;
}) {
  return (
    <div>
      <div className="text-[13.5px] font-medium">{label}</div>
      <div className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">{hint}</div>
      <textarea
        value={value} onChange={(e) => onChange(e.target.value)} rows={2} placeholder={placeholder}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className={cn(
          "mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]",
          "transition-colors",
          flash && "!border-[var(--color-ok)] focus:!border-[var(--color-ok)]",
        )}
      />
    </div>
  );
}

/** Inline mono chip for env-var / token mentions inside hint text.
 *  Click selects the contents instantly so the user can ⌘C without
 *  fiddling with text-selection on the surrounding hint. The
 *  app-wide `user-select: none` chrome rule is opted-out via
 *  select-text + cursor: text so the chip behaves like a real
 *  copyable token. */
function Token({ children }: { children: string }) {
  return (
    <code
      onClick={(e) => {
        const range = document.createRange();
        range.selectNodeContents(e.currentTarget);
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      }}
      // user-select: all makes the WHOLE token select as one unit
      // on any selection gesture — including double-click, which
      // would otherwise break at the `$` (browsers treat $ as a
      // word boundary and skip it). Pairs with the click handler
      // for the single-click-selects-all UX.
      style={{ userSelect: "all", WebkitUserSelect: "all" }}
      className="cursor-text rounded bg-[var(--color-accent-soft)] px-1 py-px font-mono text-[11.5px] text-[var(--color-accent)]"
      title="Click to select"
    >{children}</code>
  );
}

/** Edit the member list of a multi-repo project. Lists single-repo
 *  projects with a checkbox each; saving fires `project_set_members`
 *  which validates + persists on the Rust side. Existing workspaces
 *  under this project aren't migrated — their composition is frozen
 *  at create time. Removing a member here only affects FUTURE
 *  workspaces. */
function MultiMembersEditor({ project, onSaved }: {
  project: Project;
  onSaved: () => void;
}) {
  const allProjects = useApp(s => s.projects);
  const pushToast = useUI(s => s.pushToast);
  type Row = { project_id: string; setup_script: string; run_script: string; archive_script: string };
  // Local working copy of the member list with their script overrides.
  // Hydrated from project.members; saving fires project_set_members.
  const [rows, setRows] = useState<Row[]>(() => (project.members ?? []).map(m => ({ ...m })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows((project.members ?? []).map(m => ({ ...m })));
  }, [project.id, JSON.stringify(project.members ?? [])]);

  // Only single-repo projects are candidates (nested multi out of scope).
  const candidates = allProjects.filter(
    p => p.id !== project.id && (p.type ?? "single") === "single",
  );

  const initialJson = JSON.stringify(project.members ?? []);
  const currentJson = JSON.stringify(rows);
  const dirty = initialJson !== currentJson;

  function toggle(id: string) {
    setRows(prev => {
      const exists = prev.some(r => r.project_id === id);
      if (exists) return prev.filter(r => r.project_id !== id);
      const proj = allProjects.find(p => p.id === id);
      return [...prev, {
        project_id: id,
        setup_script:   proj?.setup_script   ?? "",
        run_script:     proj?.run_script     ?? "",
        archive_script: proj?.archive_script ?? "",
      }];
    });
  }
  function update(id: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => r.project_id === id ? { ...r, ...patch } : r));
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      await projectSetMembers(project.id, rows);
      pushToast(`Updated ${rows.length} member${rows.length === 1 ? "" : "s"} on “${project.name}”`, "success");
      onSaved();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-[14px] font-medium">
        <Layers className="h-4 w-4 text-[var(--color-accent)]" /> Members & scripts
      </div>
      <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
        Repos to mount inside every workspace under this multi-repo project,
        and the <b>Setup / Run / Archive</b> commands to use for each. These
        scripts live on the multi-repo project (independent of the member
        project's own scripts). Edits apply to <b>future</b> workspaces;
        existing ones freeze at creation.
      </div>
      {/* Cross-member port discovery: every member's scripts +
          agent PTYs see a TERMIC_PORT_<DIR> var for each sibling,
          so service A can `curl localhost:$TERMIC_PORT_API` without
          hardcoding ports. Surface the actual names here as
          click-to-copy chips so users don't have to guess the
          sanitization rules. */}
      {rows.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-fg-faint)]">
          <span className="text-[var(--color-fg-dim)]">Env vars:</span>
          <Token>$TERMIC_PORT</Token>
          {rows.map(r => {
            const c = allProjects.find(p => p.id === r.project_id);
            if (!c) return null;
            const sanitized = c.name
              .split("")
              .map(ch => (/[A-Za-z0-9]/.test(ch) ? ch.toUpperCase() : "_"))
              .join("");
            return <Token key={r.project_id}>{`$TERMIC_PORT_${sanitized}`}</Token>;
          })}
          <Token>$TERMIC_WORKSPACE_NAME</Token>
        </div>
      )}
      {/* Selected-members list — shows only what's IN the project.
          Unselected candidates live behind the "Add member" picker
          below so the panel doesn't double-scroll inside the page.
          Each row collapses the script editors directly under its
          header (no separate hover/toggle dance) since checking is
          done via the explicit Remove button. */}
      {rows.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-6 text-center text-[12.5px] text-[var(--color-fg-faint)]">
          No members yet. Click <b>Add member</b> below to pick repos to mount under this multi-repo project.
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {rows.map(row => {
            const c = allProjects.find(p => p.id === row.project_id);
            if (!c) return null;
            return (
              <div key={row.project_id} className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)]">
                <div className="flex items-center gap-3 px-3 py-2">
                  <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{c.name}</div>
                    <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{c.root_path}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    title="Remove from this multi-repo project"
                    className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-err)]/10 hover:text-[var(--color-err)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-col gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/40 px-3 py-2">
                  <MemberScriptRow label="Setup"   value={row.setup_script}   placeholder={c.setup_script   || "docker compose up -d"}        onChange={v => update(c.id, { setup_script: v })} />
                  <MemberScriptRow label="Run"     value={row.run_script}     placeholder={c.run_script     || "PORT=$TERMIC_PORT npm run dev"} onChange={v => update(c.id, { run_script: v })} />
                  <MemberScriptRow label="Archive" value={row.archive_script} placeholder={c.archive_script || "docker compose down"}            onChange={v => update(c.id, { archive_script: v })} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add-member picker: shows the list of available (not yet
          added) repos when expanded. Collapses back to the button
          after a row is clicked. Keeps the steady-state panel
          short — only added members live there. */}
      <AddMemberPicker
        candidates={candidates.filter(c => !rows.some(r => r.project_id === c.id))}
        onAdd={(id) => toggle(id)}
        onQuickAdd={async (path) => {
          try {
            const p = await projectAdd(path);
            await useApp.getState().loadAll();
            toggle(p.id);
          } catch (e) {
            // "project already added" → look it up in the refreshed
            // list and add it as a member anyway (the user wanted it
            // here, the duplicate guard at the IPC level is just for
            // the standalone-projects list).
            const msg = String(e);
            if (!/already added/i.test(msg)) {
              setError(msg);
              return;
            }
            await useApp.getState().loadAll();
            const all = useApp.getState().projects;
            const found = all.find(p => p.root_path === path || p.root_path.endsWith(path));
            if (found) toggle(found.id);
          }
        }}
      />
      {error && <div className="mt-2 text-[12.5px] text-[var(--color-err)]">{error}</div>}
      <div className="mt-3">
        <Button variant="primary" size="sm" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : `Save members & scripts (${rows.length})`}
        </Button>
      </div>
    </div>
  );
}

function MemberScriptRow({ label, value, onChange, placeholder }: {
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

/** Collapsible "+ Add member" affordance for the multi-repo project's
 *  members list. Default state = a single dashed button; click → list
 *  of available candidates; click a candidate → adds + collapses back
 *  (or stays open if more are still available). Keeps the steady-
 *  state panel short. */
function AddMemberPicker({ candidates, onAdd, onQuickAdd }: {
  candidates: Project[];
  onAdd: (id: string) => void;
  /** Folder-picker shortcut: skips the "register as project first"
   *  detour by adding the repo as a standalone project on the fly and
   *  immediately wiring it in as a member. */
  onQuickAdd?: (path: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Auto-collapse only when neither path forward is available.
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
  const pickFolder = async () => {
    if (!onQuickAdd || busy) return;
    const sel = await openDialog({ directory: true, multiple: false });
    if (!sel || typeof sel !== "string") return;
    setBusy(true);
    try {
      await onQuickAdd(sel);
    } finally {
      setBusy(false);
    }
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
        Members come from your existing projects. Pick one below, or use “Add
        repo from disk” to register a new project and wire it in here in one
        step. Each member carries its own scripts and sandbox allow-lists.
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
      {onQuickAdd && (
        <button
          type="button"
          onClick={pickFolder}
          disabled={busy}
          className="flex w-full items-center gap-3 border-t border-[var(--color-border-soft)] px-3 py-2 text-left text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-60"
        >
          <span className="text-[13.5px]">{busy ? "Adding…" : "+ Add repo from disk…"}</span>
          <span className="ml-auto truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">
            registers a new project + adds it as a member
          </span>
        </button>
      )}
    </div>
  );
}
