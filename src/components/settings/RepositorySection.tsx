// Per-repository settings, persisted to projects.json via project_update.
// Mirrors Termic's "Repository" page: paths, base branch, files-to-copy,
// setup/run/archive scripts. The "Remove repository" action removes the
// project from our list — does NOT delete anything from disk.

import { useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { projectUpdate, projectRemove, projectSetMembers, pathIsGitRepo, projectTasksPathDefault, repoConfigLoad, repoConfigSave } from "@/lib/ipc";
import { stopSpotlight } from "@/lib/spotlight";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Project, ProjectMember, RepoConfig } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Trash2, Check, Layers, X, AudioWaveform, Compass, SlidersHorizontal } from "lucide-react";
import { useTasksPathConflicts } from "./Controls";
import { ExcludeEditor } from "./ExcludeEditor";
import { ScriptField } from "./ScriptField";
import { BrowserCommandField } from "./BrowserCommandField";
import { LINK_CLICK_MODIFIER as CLICK_MOD } from "@/lib/previewBrowser";
import { cn, cleanLines } from "@/lib/utils";
import { i18n } from "@/lib/i18n";
import { isValidPortName } from "@/lib/namedPorts";
import { isTerminalEntry } from "@/lib/agents";
import { CodeIntelSettings } from "./CodeIntelSettings";
import { CodeIntelServers } from "./CodeIntelServers";
import { codeIntelName } from "@/lib/lsp/featureName";
import { SERVABLE_LANGUAGES } from "@/lib/lsp/serverNames";
import { usePrefs } from "@/store/prefs";
import { SandboxPicker } from "@/components/SandboxPicker";
import { selectionToFields, type SandboxSelection } from "@/lib/types";
import { dockerImageStatus, settingsLoad, type DockerImageStatus } from "@/lib/ipc";

/** The servers termic can drive, by the id the Rust host knows them by. Not
 *  every language CodeMirror highlights: these are the four something can
 *  actually answer for today. */
/** Every language termic can serve, from the one list that knows them all. */
const CODE_INTEL_LANGUAGES = SERVABLE_LANGUAGES;

export function RepositorySection({ projectId }: { projectId: string }) {
  const project = useApp(s => s.projects.find(p => p.id === projectId));
  const loadAll = useApp(s => s.loadAll);
  // The feature's name follows the type-checking switch (lib/lsp/featureName).
  // Up here with the other hooks: this component early-returns further down.
  const typeChecking = usePrefs(s => s.codeIntelDiagnostics);
  const appDefaultYolo = usePrefs(s => s.defaultYolo);
  // App-wide browser, only to describe what "follow the app-wide setting"
  // currently resolves to in the dropdown label. MUST stay up here with the
  // other hooks: this component early-returns when no project is selected,
  // and a hook below that return is a conditional hook, which crashes the
  // whole Settings overlay on the render where it changes.
  const globalBrowser = useApp(s => s.previewBrowser);
  const setView = useApp(s => s.setView);
  const agents = useApp(s => s.agents);
  const { t } = useTranslation("settings");

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
  // Docker is only offerable once it is on globally AND an image exists;
  // otherwise the card would set a default that cannot launch. Re-probed per
  // project open, not once per app launch, so enabling Docker in Settings
  // mid-session is picked up (the same trap NewTaskDialog had).
  const [dockerImage, setDockerImage] = useState<DockerImageStatus | null>(null);
  const [dockerGloballyOn, setDockerGloballyOn] = useState(false);
  useEffect(() => {
    let dead = false;
    settingsLoad()
      .then(s => { if (!dead) setDockerGloballyOn(!!s.docker_sandbox_enabled); })
      .catch(() => {});
    dockerImageStatus()
      .then(v => { if (!dead) setDockerImage(v); })
      .catch(() => {});
    return () => { dead = true; };
  }, [projectId]);
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
  // snapshot stays stable across renders unless tasks actually change.
  const taskCount = useApp(s => s.tasks.reduce(
    (n, w) => n + (project && w.project_id === project.id ? 1 : 0), 0,
  ));
  const wtCount = useApp(s => s.tasks.reduce(
    (n, w) => n + (project && w.project_id === project.id && !w.is_main_checkout ? 1 : 0), 0,
  ));

  // Auto start, and the language list that belongs to it. `auto` is read in
  // the render to decide whether that list is on screen at all. Up here with
  // the other hooks, ABOVE this component's "Project not found" early return:
  // a useState below it changes the hook count between renders and takes the
  // whole settings page down with it.
  const auto = (draft?.code_intel_auto ?? "off") as "off" | "main" | "all";
  const [detecting, setDetecting] = useState(false);

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
      scripts: { setup: "", run: "", archive: "", preview_url: "", files_to_copy: [], run_scripts: [] },
      sandbox: { enabled_by_default: false, allowed_hosts: [], allowed_paths: [] },
      exclude: [],
      extra_named_ports: [],
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
        // i18n.t, not t: this effect re-fetches on [projectId], and adding t
        // (whose identity changes on language switch) would re-run the fetch.
        setErr(i18n.t("settings:repo.yamlError", { error: String(e) }));
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
  const spotlightTaskId = useApp(s => s.spotlightTaskId[projectId] ?? null);
  const spotlightTaskName = useApp(s => {
    const id = s.spotlightTaskId[projectId];
    if (!id) return null;
    return s.tasks.find(w => w.id === id)?.name ?? null;
  });

  // Where this project's worktrees land with NO override below, i.e. straight
  // from Settings → Tasks → Default tasks path. Shown as the "Tasks path"
  // placeholder so the field can stay empty and still say where tasks go.
  // Re-read per project mount, which is also how an edit to the global setting
  // reaches here (switching rails remounts this page).
  // Gated on the sub-tab: this field only renders under More, and the two IPC
  // round trips below would otherwise fire on every project switch for a
  // control nobody is looking at.
  const onMoreTab = subTab === "advanced";
  const [tasksPathDefault, setTasksPathDefault] = useState("");
  useEffect(() => {
    if (!onMoreTab) return;
    let cancelled = false;
    projectTasksPathDefault(projectId)
      .then(p => { if (!cancelled) setTasksPathDefault(p); })
      .catch(() => { if (!cancelled) setTasksPathDefault(""); });
    return () => { cancelled = true; };
  }, [projectId, onMoreTab]);

  // Whether the typed override would resolve onto this repo itself, which
  // task_create refuses. Surfaced here so the objection arrives while the
  // value is being typed, not at the next task create. An empty value inherits
  // the global, whose own validity is reported on the Tasks page.
  // `draftTasksPath` is a primitive derived from `draft`, so this does not
  // re-fire on every unrelated keystroke in the section.
  const draftTasksPath = draft?.tasks_path.trim() ?? "";
  const tasksPathInvalid = useTasksPathConflicts(
    onMoreTab ? draftTasksPath : "", projectId,
  ).names.length > 0;
  // The debounced save closes over the render that scheduled it, so it needs a
  // ref to read the CURRENT verdict rather than the one from 500ms ago.
  const tasksPathInvalidRef = useRef(false);
  tasksPathInvalidRef.current = tasksPathInvalid;

  if (!project || !draft) return <div className="text-[13.5px] text-[var(--color-fg-faint)]">{t("repo.notFound")}</div>;

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
        // Raw split lines from the textarea → trimmed, blanks dropped.
        extra_named_ports: cleanLines(next.extra_named_ports ?? []),
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

  /** Switch the standing instruction, and keep the language list honest with
   *  it. Turning it ON with nothing decided yet reads the repo and ticks what
   *  it is actually written in, rather than every language termic can serve:
   *  four ticked boxes on a Python repo is an instruction to start four
   *  servers, and nobody meant it. Turning it OFF drops the list, because the
   *  list is not shown while off and a stored one would go on hiding editor
   *  buttons with no visible control to explain why. */
  async function armAuto(value: "off" | "main" | "all") {
    patch("code_intel_auto", value as any);
    if (value === "off") {
      if (draft?.code_intel_languages?.length) patch("code_intel_languages", undefined as any);
      return;
    }
    if (draft?.code_intel_languages?.length) return;   // already a decision
    // Detection needs a checkout to read, which means a task: the file list
    // is task-scoped IPC. A project with none yet keeps "all", and the first
    // real arm re-detects (autoStart does its own detection per checkout).
    const st = useApp.getState();
    const task = st.tasks.find(w => !w.archived && w.project_id === projectId && w.is_main_checkout)
      ?? st.tasks.find(w => !w.archived && w.project_id === projectId);
    if (!task) return;
    setDetecting(true);
    try {
      const [{ taskListFilesForFinder }, { projectLanguages }] = await Promise.all([
        import("@/lib/ipc"),
        import("@/lib/lsp/projectLanguages"),
      ]);
      const found = projectLanguages(await taskListFilesForFinder(task.id));
      // Nothing recognised is not "serve nothing": an empty list would read as
      // undefined ("all") on the next render anyway, so leave it alone.
      if (found.length && found.length < CODE_INTEL_LANGUAGES.length) {
        patch("code_intel_languages", found as any);
      }
    } catch {
      /* unreadable checkout: leave the list alone, every box stays ticked */
    } finally {
      setDetecting(false);
    }
  }

  function patch<K extends keyof Project>(k: K, v: Project[K]) {
    touchedKeys.current.add(k as string);
    // The auto-start planner caches what a checkout is written in. Changing
    // which languages this project serves is the one edit that makes that
    // guess wrong, so drop it rather than waiting for a relaunch.
    if (k === "code_intel_languages" || k === "code_intel_auto") {
      void import("@/lib/lsp/autoStart").then(m => m.forgetDetectedLanguages()).catch(() => {});
    }
    setDraft(d => {
      if (!d) return d;
      const next = { ...d, [k]: v };
      // Debounce the actual save — coalesces rapid keystrokes.
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        // Don't persist a tasks path that resolves onto the repo. The field is
        // already flagged; writing it would leave a broken value in
        // projects.json whose only other signal is a failed task create.
        // Skips the whole batch rather than substituting the last good value:
        // performSave ends in loadAll(), which re-seeds `draft` from the store,
        // so saving something other than what is on screen would silently
        // revert the user's typing mid-edit. Fixing the path is itself a
        // keystroke, which reschedules this.
        if (tasksPathInvalidRef.current) { setStatus("idle"); return; }
        void performSave(next);
      }, 500) as unknown as number;
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
        files_to_copy: cleanLines(next.scripts.files_to_copy),
      },
      exclude: cleanLines(next.exclude ?? []),
      extra_named_ports: cleanLines(next.extra_named_ports ?? []),
    };
    setStatus("saving"); setErr(null);
    repoConfigSave(projectId, cleaned)
      .then(() => {
        setStatus("saved");
        // .termic.yaml is now on disk with the latest excludes — nudge the
        // file tree to re-read so any exclude edits take effect immediately.
        useUI.getState().reloadFileTree();
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
  // Extra named ports live at the top level of .termic.yaml (GH #196),
  // like `exclude`. Raw split lines kept in state so typing isn't
  // mangled; cleanLines normalizes on save.
  function patchRcExtraPorts(text: string) {
    setRc(prev => {
      if (!prev) return prev;
      const next = { ...prev, extra_named_ports: text.split("\n") };
      scheduleRcSave(next);
      return next;
    });
  }
  // File-tree excludes live at the top level of .termic.yaml (not under
  // scripts). The ExcludeEditor hands back the full pattern array; we save
  // it and nudge the file tree to re-read so the change is visible behind
  // the Settings overlay.
  function patchExclude(next: string[]) {
    setRc(prev => {
      if (!prev) return prev;
      const updated = { ...prev, exclude: next };
      scheduleRcSave(updated);
      return updated;
    });
    // Tree refresh happens in flushRcSave's success handler — re-reading
    // here (pre-save) would use the stale on-disk .termic.yaml.
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
    // Repo-root tasks: just unregistered (the real repo stays put).
    // The user's actual git repo at root_path is NEVER touched.
    const parts: string[] = [];
    parts.push(
      taskCount === 0
        ? t("repo.removeNoTasks")
        : t("repo.removeArchives", { count: taskCount }),
    );
    if (wtCount > 0) parts.push(t("repo.removeWorktrees", { count: wtCount }));
    if (taskCount - wtCount > 0) parts.push(t("repo.removeMainEntries", { count: taskCount - wtCount }));
    parts.push(t("repo.removeUntouched", { path: proj.root_path }));
    const ok = await useUI.getState().askConfirm({
      title: t("repo.removeTitle", { name: proj.name }),
      message: parts.join(" "),
      confirmLabel: t("repo.removeConfirm"),
      destructive: true,
    });
    if (!ok) return;
    const { setBusy } = useUI.getState();
    setBusy(t("repo.removeBusy", { name: proj.name, count: taskCount }));
    try {
      await projectRemove(proj.id);
      await loadAll();
      setView("dashboard");
    } catch (e) { setErr(String(e)); }
    finally { setBusy(null); }
  }

  const isMulti = (draft.type ?? "single") === "multi";
  // Default-CLI choices, and whether the SAVED value is among them. It can
  // fall out of the list: the agent was removed or disabled, its id changed
  // with its display name, or the registry simply hasn't loaded yet. See the
  // select below for why that has to be rendered rather than papered over.
  const cliChoices = agents.filter(a => !a.disabled && !isTerminalEntry(a));
  const cliMissing = draft.default_cli !== "shell"
    && !cliChoices.some(a => a.id === draft.default_cli);
  // The project's default engine, expressed in the picker's own vocabulary.
  // Reads the same three fields the create paths read, in the same order
  // NewTaskDialog seeds from, so the two can never disagree about what this
  // project's default IS.
  const projectDefaultSelection: SandboxSelection = draft.default_docker
    ? "docker"
    : (draft.default_sandbox_mode ?? (draft.default_sandbox ? "enforce" : "off"));

  /** Write a picker choice back onto the three stored fields. Docker and
   *  Seatbelt are separate booleans on the record (see SandboxSelection), so
   *  picking one has to clear the other or a task would carry both. */
  function setProjectDefaultSelection(sel: SandboxSelection) {
    const { mode, docker } = selectionToFields(sel);
    patch("default_docker", docker as never);
    patch("default_sandbox_mode", (docker ? null : mode) as never);
    patch("default_sandbox", (!docker && mode !== "off") as never);
  }

  const dockerOffered = dockerGloballyOn && !!dockerImage?.available;

  // For single-repo, files-to-copy source depends on which tab is active.
  const filesArr = isMulti || scriptTarget === "personal"
    ? (Array.isArray(draft.files_to_copy) ? draft.files_to_copy : [])
    : (rc?.scripts.files_to_copy ?? []);
  const filesText = filesArr.join("\n");
  // Extra named ports (GH #196), same source rule as files-to-copy.
  // Single-repo only: multi hosts declare them in .termic.yaml directly.
  const portsArr = scriptTarget === "personal"
    ? (Array.isArray(draft.extra_named_ports) ? draft.extra_named_ports : [])
    : (rc?.extra_named_ports ?? []);
  const portsText = portsArr.join("\n");
  const badPortNames = portsArr.map(s => s.trim()).filter(Boolean)
    .filter(n => !isValidPortName(n));
  // Tab order signals importance + frequency of edit:
  //   Scripts first  → the thing you actually came here to tune
  //   Files / Sandbox → focused single-concept tabs
  //   Code nav       → set-once, and costly enough to deserve its own page
  //   More last      → set-once metadata (paths, branch, remote)
  //                    + irreversible Remove action at the bottom
  // The code-nav label follows the feature's own name, which turns into
  // "Code intelligence" once diagnostics are on (lib/lsp/featureName.ts), so
  // the tab and the panel it opens can never disagree.
  const tabs: { id: SubTab; label: string }[] = [
    { id: "scripts",  label: t(isMulti ? "repo.tabScriptsMulti" : "repo.tabScripts") },
    { id: "sandbox",  label: t("repo.sandboxHeading") },
    { id: "codenav",  label: codeIntelName(typeChecking) },
    { id: "git",      label: t("repo.tabGit") },
    { id: "advanced", label: t("repo.tabMore") },
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
          {status === "saving" && <span>{t("common:saving")}</span>}
          {status === "saved"  && (
            <span className="flex items-center gap-1 text-[var(--color-ok)]">
              <Check className="h-3.5 w-3.5" /> {t("shared.saved")}
            </span>
          )}
          {status === "error"  && <span className="text-[var(--color-err)]">{t("shared.saveFailed")}</span>}
        </div>
      </div>

      {/* Sub-tab strip. Mirrors the top-level Settings rail's pill
          shape but rendered horizontally inline with the page —
          keeps the project page self-contained without nesting a
          second sidebar. Active tab = filled bg-2, inactive = dim
          fg + soft hover. Visible always so users can flip between
          tabs without scrolling first. */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)]">
        {tabs.map(th => (
          <button
            key={th.id}
            type="button"
            data-repo-tab={th.id}
            onClick={() => setSubTab(th.id)}
            className={cn(
              "relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
              subTab === th.id
                ? "text-[var(--color-fg)]"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
            )}
          >
            {th.label}
            {/* Underline that lines up with the bottom border of the
                tab strip. -mb-px on the parent puts us right on top of
                the border. */}
            {subTab === th.id && (
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
                { id: "personal", label: t("repo.targetPersonal"), hint: t("repo.targetPersonalHint")   },
                { id: "yaml",     label: t("repo.targetYaml"),     hint: t("repo.targetYamlHint") },
              ] as const).map(th => (
                <button
                  key={th.id} type="button"
                  onClick={() => setScriptTarget(th.id)}
                  className={cn(
                    "relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
                    scriptTarget === th.id
                      ? "text-[var(--color-fg)]"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  {th.label}
                  <span className="text-[11px] font-normal text-[var(--color-fg-faint)]">{th.hint}</span>
                  {scriptTarget === th.id && (
                    <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Preview URL */}
          <div>
            <div className="text-[14px] font-medium">{t("repo.previewLabel")}</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              <Trans
                t={t}
                i18nKey="repo.previewHint"
                components={{ 1: <Token />, 3: <Token />, 5: <Token /> }}
              />
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

          {/* Per-project browser override (GH #245). Personal, never
              .termic.yaml: a launch command is machine-specific, so a
              committed one would be a dead link for a teammate on Linux. */}
          <div>
            <div className="text-[14px] font-medium">{t("repo.browserLabel")}</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              {t("repo.browserHint", { mod: CLICK_MOD })}
            </div>
            <div className="mt-2">
              <BrowserCommandField
                value={draft.preview_browser}
                onChange={(v) => patch("preview_browser", v)}
                allowInherit
                globalCommand={globalBrowser}
                testId="project-browser"
              />
            </div>
          </div>

          {isMulti ? (
            <MultiMembersEditor project={draft} onSaved={() => { void loadAll(); }} />
          ) : (
            <div className="flex flex-col gap-5">
              <ScriptField
                label={t("repo.setupLabel")}
                hint={t("repo.setupHint")}
                value={scriptTarget === "yaml" ? (rc?.scripts.setup ?? "") : (draft.setup_script ?? "")}
                onChange={(v) => scriptTarget === "yaml" ? patchScript("setup", v) : patch("setup_script", v)}
                placeholder="docker compose up -d"
                flash={scriptTarget === "personal" && flashKeys.has("setup_script")}
              />
              <ScriptField
                label={t("repo.runLabel")}
                hint={<Trans t={t} i18nKey="repo.runHint" components={{ 1: <Token /> }} />}
                value={scriptTarget === "yaml" ? (rc?.scripts.run ?? "") : (draft.run_script ?? "")}
                onChange={(v) => scriptTarget === "yaml" ? patchScript("run", v) : patch("run_script", v)}
                placeholder="PORT=$TERMIC_PORT npm run dev"
                flash={scriptTarget === "personal" && flashKeys.has("run_script")}
              />
              <ScriptField
                label={t("repo.archiveLabel")}
                hint={t("repo.archiveHint")}
                value={scriptTarget === "yaml" ? (rc?.scripts.archive ?? "") : (draft.archive_script ?? "")}
                onChange={(v) => scriptTarget === "yaml" ? patchScript("archive", v) : patch("archive_script", v)}
                placeholder="docker compose down"
                flash={scriptTarget === "personal" && flashKeys.has("archive_script")}
              />
            </div>
          )}

          {/* Extra named ports (GH #196). Team list lives at the top level
              of .termic.yaml, personal list on Project.extra_named_ports;
              the union (yaml first, deduped) is frozen into each NEW task
              as name→port pairs. Single-repo only for now: multi hosts can
              declare them by editing .termic.yaml directly. */}
          {!isMulti && (
            <div>
              <div className="text-[14px] font-medium">{t("repo.portsLabel")}</div>
              <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                <Trans
                  t={t}
                  i18nKey="repo.portsHint"
                  components={{ 1: <Token />, 3: <Token /> }}
                />
              </div>
              <textarea
                value={portsText}
                onChange={(e) => {
                  if (scriptTarget === "personal") {
                    patch("extra_named_ports", e.target.value.split("\n") as unknown as Project["extra_named_ports"]);
                  } else {
                    patchRcExtraPorts(e.target.value);
                  }
                }}
                rows={3}
                placeholder="API_PORT&#10;DB_PORT"
                data-testid="extra-named-ports-input"
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                className={cn(
                  "mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]",
                  scriptTarget === "personal" && flashRing("extra_named_ports"),
                )}
              />
              {badPortNames.length > 0 && (
                <div data-testid="extra-named-ports-warning" className="mt-1 text-[12px] text-[var(--color-warn)]">
                  {t("repo.portsWarning", { names: badPortNames.join(", ") })}
                </div>
              )}
            </div>
          )}

          {/* Extra run commands (GH #124). Only for single-repo — multi-repo
              runs are driven per-member in the Members editor above. Managed
              (personal + committed, with a test button) in a dedicated modal. */}
          {!isMulti && (
            <div className="border-t border-[var(--color-border-soft)] pt-6">
              <div className="text-[14px] font-medium">{t("repo.runCmdLabel")}</div>
              <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                {t("repo.runCmdHint")}
              </div>
              <div className="mt-3">
                <Button variant="secondary" size="sm" onClick={() => useUI.getState().openRunCommands(projectId)}>
                  <SlidersHorizontal className="h-3.5 w-3.5" /> {t("repo.runCmdButton")}
                </Button>
              </div>
            </div>
          )}

          {/* Files to copy. For a multi-repo project this list covers the
              HOST repo only (the task's root dir); each member carries its
              own list in the Members & scripts editor above (GH #264). */}
          <div>
            <div className="text-[14px] font-medium">{t("repo.filesLabel")}</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              <Trans
                t={t}
                i18nKey={isMulti ? "repo.filesHintMulti" : "repo.filesHintSingle"}
                components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
              />
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

          {/* Hidden files — committed to .termic.yaml, shared with the team
              and the standalone CLI. Saved live (debounced) like the other
              .termic.yaml fields. */}
          <div className="border-t border-[var(--color-border-soft)] pt-6">
            <div className="text-[14px] font-medium">{t("repo.hiddenLabel")}</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              <Trans
                t={t}
                i18nKey="repo.hiddenHint"
                components={{ 1: <code className="font-mono" /> }}
              />
            </div>
            <div className="mt-3">
              <ExcludeEditor value={rc?.exclude ?? []} onChange={patchExclude} />
            </div>
          </div>
        </div>
      )}

      {/* Code navigation lives on its own sub-tab rather than at the tail of
          Scripts & run: it has nothing to do with the setup/run/archive
          scripts that tab exists for, it is the size of a tab on its own
          (arming, languages, the per-project server picker, per-language
          settings), and it is machine-local projects.json while that tab's
          storage strip is switching between personal and the committed
          .termic.yaml. */}
      {subTab === "codenav" && (
        <div>
        {/* Code intelligence (GH #174). Three choices rather than a checkbox,
            because the two "on"s differ by an order of magnitude and a
            single "on" would hide that: the main checkout is one server per
            language however many tasks share it, while worktrees are one
            server EACH. Machine-local (projects.json), deliberately not in
            the committed .termic.yaml: whether to spend this machine's
            memory is not a decision a colleague should be able to push. */}
        <div>
          {/* h2 at the tab's own size, like Sandbox: this used to be a 14px
              subheading under a top rule, which is what a section reads like
              when it follows another one on a shared page. */}
          <h2 className="mb-3 flex items-center gap-2 text-[16px] font-medium text-[var(--color-fg)]">
            <Compass className="h-4 w-4 text-[var(--color-accent)]" />
            {codeIntelName(typeChecking)}
          </h2>
          <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
            {t("repo.intelIntro")}
          </p>
          {/* The radios had no heading of their own: they simply followed the
              language checkboxes, so what they were choosing BETWEEN had to be
              inferred from three hints. The panel intro used to carry that
              sentence, which by this point in the page was two blocks away. */}
          <div className="mb-2 text-[12.5px] font-medium text-[var(--color-fg)]">{t("repo.autoHeading")}</div>
          <p className="mb-2 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
            {t("repo.autoHint")}
          </p>
          <div className="flex flex-col gap-2">
            {([
              ["off", t("repo.autoOff"), t("repo.autoOffHint")],
              ["main", t("repo.autoMain"), t("repo.autoMainHint")],
              ["all", t("repo.autoAll"), t("repo.autoAllHint")],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-3 select-none">
                <input
                  type="radio"
                  name="code-nav-auto"
                  data-testid={`code-nav-auto-${value}`}
                  checked={(draft.code_intel_auto ?? "off") === value}
                  onChange={() => void armAuto(value)}
                  className="mt-1 accent-[var(--color-accent)]"
                />
                <div>
                  <span className="text-[13.5px] font-medium text-[var(--color-fg)]">{label}</span>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">{hint}</p>
                </div>
              </label>
            ))}

            {/* The languages belong to auto start and nowhere else, which is
                what the flat layout could not say: they used to sit ABOVE the
                radios, so the first thing the page asked was which languages
                to narrow, before anything had said what was being narrowed.
                Hidden while Off, because then there is nothing to narrow: each
                task asks, one chip click at a time. */}
            {auto !== "off" && (
              <div className="mt-4 border-l-2 border-[var(--color-border-soft)] pl-4">
                <div className="mb-2 text-[12.5px] font-medium text-[var(--color-fg)]">{t("repo.languagesHeading")}</div>
                <p className="mb-2 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
                  {t("repo.languagesHint")}
                </p>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {CODE_INTEL_LANGUAGES.map(({ id, label }) => {
                    const list = draft.code_intel_languages;
                    const on = !list || list.includes(id);
                    return (
                      <label key={id} className="flex cursor-pointer items-center gap-2 select-none">
                        <Checkbox
                          checked={on}
                          onChange={(v) => {
                            // Undefined means "all", so the first untick has to
                            // materialise the full list minus this one, or every
                            // other language would be dropped with it.
                            const cur = list ?? CODE_INTEL_LANGUAGES.map(l => l.id);
                            const next = v ? [...cur, id] : cur.filter(x => x !== id);
                            patch("code_intel_languages", (
                              next.length === CODE_INTEL_LANGUAGES.length ? undefined : next
                            ) as any);
                          }}
                        />
                        <span className="text-[13px] text-[var(--color-fg)]">{label}</span>
                      </label>
                    );
                  })}
                </div>
                {detecting && (
                  <p className="mt-2 text-[12px] text-[var(--color-fg-faint)]">{t("repo.detecting")}</p>
                )}
              </div>
            )}
          </div>

          {/* WHICH server, per project. The same panel Settings -> Editor
              shows, pointed at this project: a repo that needs pyright can
              say so without changing what the reader's other repos use, and
              each row prints the machine setting it is overriding. */}
          <div className="mt-4 border-t border-[var(--color-border-soft)] pt-4">
            <div className="mb-2 text-[12.5px] font-medium text-[var(--color-fg)]">
              {t("repo.serversHeading")}
            </div>
            <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
              {t("repo.serversHint")}
            </p>
            <CodeIntelServers
              project={draft}
              onProjectChange={(p) => {
                if (p.code_intel_servers) patch("code_intel_servers", p.code_intel_servers);
                if (p.code_intel_commands) patch("code_intel_commands", p.code_intel_commands);
              }}
            />
          </div>

          <CodeIntelSettings 
            project={draft} 
            onChange={(p) => patch("code_intel_settings", p.code_intel_settings as any)}
          />
        </div>

        </div>
      )}

      {subTab === "sandbox" && (
        <div>
          <h2 className="text-[16px] font-medium">{t("repo.sandboxHeading")}</h2>
          <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">
            <Trans
              t={t}
              i18nKey="repo.sandboxIntro"
              components={{
                1: <code className="font-mono" />, 3: <code className="font-mono" />,
                5: <code className="font-mono" />, 7: <code className="font-mono" />,
                9: <code className="font-mono" />, 11: <code className="font-mono" />,
                13: <code className="font-mono" />, 15: <code className="font-mono" />,
              }}
            />
          </p>
          <div className="mt-4 flex flex-col gap-5">
            {/* The SAME picker the New Task dialog uses, so "what a new task
                gets" is chosen in one vocabulary rather than a checkbox here
                and five cards there. This is what the quick-create menu in
                the sidebar applies, which previously had no way to say
                anything but on/off. */}
            <div>
              <div className="text-[13.5px] font-medium">{t("repo.defaultLabel")}</div>
              <div className="mt-0.5 mb-2 text-[12.5px] text-[var(--color-fg-dim)]">
                {t("repo.defaultHint")}
              </div>
              <SandboxPicker
          onEnableDocker={() => { useApp.getState().openSettings("docker"); }}
                compact
                value={projectDefaultSelection}
                onChange={setProjectDefaultSelection}
                dockerOffered={dockerOffered}
                dockerUnavailableReason={
                  dockerOffered ? undefined : t("repo.dockerUnavailable")
                }
              />
            </div>

            {/* This project's YOLO default. Three answers because the field
                is optional: no opinion inherits Settings → Sandbox, and "Off"
                keeps a project asking on a machine that is otherwise YOLO.
                Personal (projects.json) only, never .termic.yaml: a committed
                file must not be able to switch approvals off for a clone. */}
            <div>
              <div className="text-[13.5px] font-medium">{t("repo.yoloDefault.label")}</div>
              <div className="mt-0.5 mb-2 text-[12.5px] text-[var(--color-fg-dim)]">
                <Trans
                  t={t}
                  i18nKey="repo.yoloDefault.hint"
                  components={{ 1: <code className="font-mono" /> }}
                />
              </div>
              <select
                data-testid="project-default-yolo"
                value={draft.default_yolo == null ? "inherit" : draft.default_yolo ? "on" : "off"}
                onChange={(e) => patch(
                  "default_yolo",
                  e.target.value === "inherit" ? null : e.target.value === "on",
                )}
                className={cn(
                  "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[140px]",
                  flashRing("default_yolo"),
                )}
              >
                <option value="inherit">{t("repo.yoloDefault.inherit", { value: t(appDefaultYolo ? "repo.yoloDefault.on" : "repo.yoloDefault.off") })}</option>
                <option value="on">{t("repo.yoloDefault.on")}</option>
                <option value="off">{t("repo.yoloDefault.off")}</option>
              </select>
            </div>

            {/* Only meaningful for a Docker default; hidden otherwise rather
                than shown inert. */}
            {projectDefaultSelection === "docker" && (
              <div>
                <div className="text-[13.5px] font-medium">{t("repo.mountsLabel")}</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  <Trans
                    t={t}
                    i18nKey="repo.mountsHint"
                    components={{ 1: <code className="font-mono" /> }}
                  />
                </div>
                <textarea
                  value={(draft.docker_extra_mounts ?? []).join("\n")}
                  onChange={(e) => patch("docker_extra_mounts", e.target.value.split("\n") as never)}
                  rows={3}
                  placeholder={"$HOME/mcp-data:/data/mcp"}
                  data-testid="project-docker-extra-mounts"
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                />
              </div>
            )}

            {/* Storage target tabs — same underline-tab style as the
                top-level Scripts / Sandbox / More strip. Controls
                whether the allow-lists below read/write the committed
                .termic.yaml (shared with the team) or the local
                projects.json personal override. Both layers are merged
                at spawn time. */}
            <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)]">
              {([
                { id: "personal", label: t("repo.targetPersonal"), hint: t("repo.targetPersonalSandboxHint") },
                { id: "yaml",     label: t("repo.targetYaml"),     hint: t("repo.targetYamlHint") },
              ] as const).map(th => (
                <button
                  key={th.id} type="button"
                  onClick={() => setSandboxTarget(th.id)}
                  className={cn(
                    "relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
                    sandboxTarget === th.id
                      ? "text-[var(--color-fg)]"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  {th.label}
                  <span className="text-[11px] font-normal text-[var(--color-fg-faint)]">{th.hint}</span>
                  {sandboxTarget === th.id && (
                    <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]" />
                  )}
                </button>
              ))}
            </div>

            <Field
              label={t("repo.allowedPathsLabel")}
              hint={t("repo.allowedPathsHint")}
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
              label={t("repo.allowedHostsLabel")}
              hint={t("repo.allowedHostsHint")}
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

      {subTab === "git" && (
        <div className="flex flex-col gap-7">
          {/* The same field the project `+` menu's "Branch from" row writes,
              so the two can't disagree. */}
          <GitField
            label={t("repo.branchLabel")}
            hint={t("repo.branchHint")}
            control={<Input value={draft.base_branch} onChange={(e) => patch("base_branch", e.target.value)} className={cn("font-mono", flashRing("base_branch"))} placeholder="origin/master" />}
          />
          <GitField
            label={t("repo.remoteLabel")}
            hint={t("repo.remoteHint")}
            control={<Input value={draft.remote} onChange={(e) => patch("remote", e.target.value)} className={cn("font-mono", flashRing("remote"))} placeholder="origin" />}
          />
          <GitField
            label={t("repo.mergeLabel")}
            hint={t("repo.mergeHint")}
            control={
              <select
                value={draft.on_pr_merge ?? "ask"}
                onChange={(e) => patch("on_pr_merge", e.target.value as Project["on_pr_merge"])}
                className={cn(
                  "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[140px]",
                  flashRing("on_pr_merge"),
                )}
              >
                <option value="ask">{t("repo.mergeAsk")}</option>
                <option value="auto">{t("repo.mergeAuto")}</option>
                <option value="off">{t("repo.mergeOff")}</option>
              </select>
            }
          />
          <GitField
            label={t("repo.watchLabel")}
            hint={t("repo.watchHint")}
            control={
              <select
                value={draft.watch_pr_comments ? "on" : "off"}
                onChange={(e) => patch("watch_pr_comments", e.target.value === "on")}
                className={cn(
                  "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[140px]",
                  flashRing("watch_pr_comments"),
                )}
              >
                <option value="off">{t("repo.watchPerTask")}</option>
                <option value="on">{t("repo.watchAlways")}</option>
              </select>
            }
          />
          <GitField
            label={t("repo.actLabel")}
            hint={t("repo.actHint")}
            control={
              <select
                value={draft.watch_untrusted_comments ? "on" : "off"}
                onChange={(e) => patch("watch_untrusted_comments", e.target.value === "on")}
                className={cn(
                  "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[140px]",
                  flashRing("watch_untrusted_comments"),
                )}
              >
                <option value="off">{t("repo.actCollaborators")}</option>
                <option value="on">{t("repo.actEveryone")}</option>
              </select>
            }
          />

          {/* Spotlight mirrors a task's git changes onto the main checkout,
              so it lives here rather than on Scripts & run. */}
          <div className="border-t border-[var(--color-border-soft)] pt-6">
            <div className="mb-3 flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
              <AudioWaveform className="h-4 w-4 text-[var(--color-accent)]" />
              {t("repo.spotlightHeading")}
            </div>

            {isMulti ? (
              <p className="text-[13px] text-[var(--color-fg-faint)]">
                {t("repo.spotlightUnsupported")}
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
                      {t("repo.spotlightEnable")}
                    </span>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
                      {t("repo.spotlightHint")}
                    </p>
                  </div>
                </label>

                {draft.spotlight_enabled && (
                  <div className="ml-7">
                    {spotlightTaskName ? (
                      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3 py-2">
                        <AudioWaveform className="termic-spotlight-wave h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                        <span className="flex-1 text-[13px] text-[var(--color-fg)]">
                          <Trans
                            t={t}
                            i18nKey="repo.spotlightActive"
                            values={{ name: spotlightTaskName }}
                            components={{ 1: <strong /> }}
                          />
                        </span>
                        <button
                          type="button"
                          onClick={() => stopSpotlight(spotlightTaskId!).catch(e =>
                            useUI.getState().pushToast(String(e), "error")
                          )}
                          className="rounded px-2.5 py-1 text-[12px] font-medium bg-[var(--color-bg-3)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
                        >
                          {t("shared.stop")}
                        </button>
                      </div>
                    ) : (
                      <p className="text-[12.5px] text-[var(--color-fg-faint)]">
                        {t("repo.spotlightNone")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === "advanced" && (
        <div className="flex flex-col gap-7">
          <Field
            label={t("repo.defaultCliLabel")}
            hint={t("repo.defaultCliHint")}
            control={
              <select
                value={draft.default_cli}
                // A change that matches what's already stored is not an edit:
                // don't spend a save (and a green flash) on it.
                onChange={(e) => {
                  if (e.target.value === draft.default_cli) return;
                  patch("default_cli", e.target.value);
                }}
                className={cn(
                  "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[140px]",
                  flashRing("default_cli"),
                )}
              >
                {/* The saved value ALWAYS gets an option, even when the agent
                    it names is gone (removed, renamed, disabled) or the
                    registry hasn't loaded yet. A <select> whose value matches
                    no <option> is silently re-pointed at the first one by
                    React, so the page would claim the project defaults to
                    some other agent, and the next stray pick would save that
                    lie. Rendered first so a broken default is impossible to
                    miss. */}
                {cliMissing && (
                  <option value={draft.default_cli}>
                    {draft.default_cli
                      ? t("repo.cliMissing", { cli: draft.default_cli })
                      : t("repo.cliNotSet")}
                  </option>
                )}
                {/* Built from the editable agent registry so custom
                    agents show up here too. Terminal (cli="shell") is
                    always available as the no-agent fallback. Custom
                    terminals (kind: "terminal") are excluded — a project
                    default CLI must be an agent (resume, review, and
                    task semantics all assume one). */}
                {cliChoices.map(a => (
                  <option key={a.id} value={a.id}>{a.display_name}</option>
                ))}
                <option value="shell">{t("repo.cliTerminal")}</option>
              </select>
            }
          />
          <Field
            label={t("repo.rootLabel")}
            hint={t("repo.rootHint")}
            control={<Input value={draft.root_path} readOnly className="font-mono opacity-70 cursor-not-allowed" />}
          />
          <Field
            label={t("repo.tasksPathLabel")}
            hint={t("repo.tasksPathHint")}
            control={
              <>
                <Input
                  value={draft.tasks_path}
                  onChange={(e) => patch("tasks_path", e.target.value)}
                  placeholder={tasksPathDefault}
                  className={cn(
                    "font-mono",
                    tasksPathInvalid
                      ? "!border-[var(--color-err)] focus:!border-[var(--color-err)]"
                      : flashRing("tasks_path"),
                  )}
                  data-testid="project-tasks-path-input"
                />
                {tasksPathInvalid && (
                  <div
                    className="mt-1.5 text-[12.5px] text-[var(--color-err)]"
                    data-testid="project-tasks-path-conflict"
                  >
                    {t("repo.tasksPathConflict")}
                  </div>
                )}
              </>
            }
          />

          {/* Danger zone pinned to the bottom of More — same
              page as the rarely-touched metadata, since it's also
              rarely-touched + irreversible. Distinct red card so it
              can't be confused with the editable fields above. */}
          <div className="mt-2 rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/5 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium text-[var(--color-fg)]">{t("repo.removeLabel")}</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  <Trans
                    t={t}
                    i18nKey="repo.removeHint"
                    values={{ path: draft.root_path }}
                    components={{ 1: <code className="font-mono" /> }}
                  />
                </div>
              </div>
              <Button variant="danger" size="sm" onClick={remove} className="shrink-0">
                <Trash2 className="h-3.5 w-3.5" /> {t("common:remove")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {err && <div className="text-[13px] text-[var(--color-err)]">{err}</div>}
    </div>
  );
}

type SubTab = "scripts" | "sandbox" | "codenav" | "git" | "advanced";

function Field({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div>
      <div className="text-[14px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      <div className="mt-2">{control}</div>
    </div>
  );
}

/** Same field shape as `Field`, but the control sits to the RIGHT of the
 *  label/hint column instead of stacked below it - matches Appearance's
 *  own Field layout. Used on the Git tab, whose controls are all a single
 *  select/input, small enough that stacking them under a hint just adds
 *  vertical scroll for no reason. */
function GitField({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/** Inline mono chip for env-var / token mentions inside hint text.
 *  Click selects the contents instantly so the user can ⌘C without
 *  fiddling with text-selection on the surrounding hint. The
 *  app-wide `user-select: none` chrome rule is opted-out via
 *  select-text + cursor: text so the chip behaves like a real
 *  copyable token. */
// children is optional so <Trans components={{ 1: <Token /> }} /> type-checks:
// i18next re-renders the element with the tag's text injected as children.
function Token({ children }: { children?: string }) {
  const { t } = useTranslation("settings");
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
      title={t("repo.tokenTip")}
    >{children}</code>
  );
}

/** Edit the member list of a multi-repo project. Lists single-repo
 *  projects with a checkbox each; saving fires `project_set_members`
 *  which validates + persists on the Rust side. Existing tasks
 *  under this project aren't migrated — their composition is frozen
 *  at create time. Removing a member here only affects FUTURE
 *  tasks. */
function MultiMembersEditor({ project, onSaved }: {
  project: Project;
  onSaved: () => void;
}) {
  const { t } = useTranslation("settings");
  const allProjects = useApp(s => s.projects);
  const pushToast = useUI(s => s.pushToast);
  type Row = ProjectMember;
  // Local working copy of the (self-contained, inline) member list.
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

  // Add a self-contained member by copying an existing project's path +
  // config. The project is NOT referenced; nothing is registered.
  function addFromProject(p: Project) {
    setRows(prev => prev.some(r => r.root_path === p.root_path) ? prev : [...prev, {
      root_path: p.root_path,
      name: p.name,
      non_git: p.non_git,
      base_branch: p.base_branch,
      setup_script:   p.setup_script   ?? "",
      run_script:     p.run_script     ?? "",
      archive_script: p.archive_script ?? "",
      files_to_copy:  p.files_to_copy  ?? [],
      sandbox_rw_paths:      p.sandbox_rw_paths,
      sandbox_allowed_hosts: p.sandbox_allowed_hosts,
    }]);
  }
  // Add a member straight from a disk path (no project record). Rust
  // canonicalizes + detects git on save; non_git here is provisional.
  function addFromDisk(path: string, nonGit: boolean) {
    const name = path.split("/").filter(Boolean).pop() || "repo";
    setRows(prev => prev.some(r => r.root_path === path) ? prev : [...prev, {
      root_path: path, name, non_git: nonGit,
      base_branch: "", setup_script: "", run_script: "", archive_script: "",
      files_to_copy: [],
    }]);
  }
  function remove(rootPath: string) {
    setRows(prev => prev.filter(r => r.root_path !== rootPath));
  }
  function update(rootPath: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => r.root_path === rootPath ? { ...r, ...patch } : r));
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      await projectSetMembers(project.id, rows);
      pushToast(t("repo.membersSaved", { count: rows.length, name: project.name }), "success");
      onSaved();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-[14px] font-medium">
        <Layers className="h-4 w-4 text-[var(--color-accent)]" /> {t("repo.membersTitle")}
      </div>
      <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
        <Trans
          t={t}
          i18nKey="repo.membersDesc"
          components={{
            1: <b />, 3: <b />,
            5: <code className="font-mono" />, 7: <code className="font-mono" />,
            9: <b />,
          }}
        />
      </div>
      {/* Cross-member port discovery: every member's scripts +
          agent PTYs see a TERMIC_PORT_<DIR> var for each sibling,
          so service A can `curl localhost:$TERMIC_PORT_API` without
          hardcoding ports. Surface the actual names here as
          click-to-copy chips so users don't have to guess the
          sanitization rules. */}
      {rows.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-fg-faint)]">
          <span className="text-[var(--color-fg-dim)]">{t("repo.envVars")}</span>
          <Token>$TERMIC_PORT</Token>
          {rows.map(r => {
            const sanitized = r.name
              .split("")
              .map(ch => (/[A-Za-z0-9]/.test(ch) ? ch.toUpperCase() : "_"))
              .join("");
            return <Token key={r.root_path}>{`$TERMIC_PORT_${sanitized}`}</Token>;
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
          {t("repo.membersEmpty")}
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {rows.map(row => (
            <div key={row.root_path} className="overflow-hidden rounded-md border border-l-2 border-[var(--color-accent-soft)] border-l-[var(--color-accent)] bg-[var(--color-accent-deep)]/[0.07]">
              <div className="flex items-center gap-3 px-3 py-2">
                <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{row.name}</span>
                    {row.non_git && (
                      <span className="shrink-0 rounded bg-[var(--color-bg-1)] px-1 text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">{t("repo.folderBadge")}</span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{row.root_path}</div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(row.root_path)}
                  title={t("repo.removeMemberTip")}
                  className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-err)]/10 hover:text-[var(--color-err)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex flex-col gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/40 px-3 py-2">
                <MemberScriptRow label={t("repo.setupShort")}   value={row.setup_script}   placeholder="docker compose up -d"        onChange={v => update(row.root_path, { setup_script: v })} />
                <MemberScriptRow label={t("repo.runShort")}     value={row.run_script}     placeholder="PORT=$TERMIC_PORT npm run dev" onChange={v => update(row.root_path, { run_script: v })} />
                <MemberScriptRow label={t("repo.archiveShort")} value={row.archive_script} placeholder="docker compose down"            onChange={v => update(row.root_path, { archive_script: v })} />
                <MemberFilesRow
                  value={row.files_to_copy ?? []}
                  onChange={v => update(row.root_path, { files_to_copy: v })}
                  repoName={row.name}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add-member picker: pick an existing project to copy in, or add
          any folder from disk. Members are self-contained — nothing is
          registered as a standalone project. */}
      <AddMemberPicker
        candidates={candidates.filter(c => !rows.some(r => r.root_path === c.root_path))}
        onAdd={addFromProject}
        onQuickAdd={async (path) => {
          const isGit = await pathIsGitRepo(path).catch(() => false);
          addFromDisk(path, !isGit);
        }}
      />
      {error && <div className="mt-2 text-[12.5px] text-[var(--color-err)]">{error}</div>}
      <div className="mt-3">
        <Button variant="primary" size="sm" disabled={!dirty || busy} onClick={save}>
          {busy ? t("common:saving") : t("repo.saveMembers", { count: rows.length })}
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

/** Per-member "Files to copy" globs (GH #264). One glob per line,
 *  resolved against the MEMBER's repo root and copied into that member's
 *  worktree at task create. Left empty, the member repo's own committed
 *  `.termic.yaml` list applies instead, so a repo that already declares
 *  its `.env` needs nothing restated here. */
function MemberFilesRow({ value, onChange, repoName }: {
  value: string[];
  onChange: (v: string[]) => void;
  repoName?: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex items-start gap-2">
      <label className="w-16 shrink-0 pt-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
        {t("repo.filesShort")}
      </label>
      <textarea
        value={value.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n"))}
        rows={2}
        placeholder=".env*&#10;app/google-services.json"
        title={t("repo.filesTip")}
        data-testid={`member-files-to-copy-${repoName ?? ""}`}
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
  onAdd: (p: Project) => void;
  /** Add any folder from disk as a self-contained member (no project
   *  registration). */
  onQuickAdd?: (path: string) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diskPath, setDiskPath] = useState("");
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
      >
        {t("repo.addMember")}
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
        <span>{t("repo.available")}</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-0.5 hover:text-[var(--color-fg)]"
          aria-label={t("common:close")}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[11.5px] leading-snug text-[var(--color-fg-dim)]">
        {t("repo.pickerHint")}
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
          <span className="shrink-0 text-[11.5px] uppercase tracking-wider text-[var(--color-accent)] opacity-70">{t("repo.addBadge")}</span>
        </button>
      ))}
      {onQuickAdd && (
        <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/40 px-3 py-2.5">
          <div className="mb-1.5 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
            {t("repo.addFromDisk")}
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
            <Button variant="secondary" size="lg" onClick={browseDisk} disabled={busy}>{t("common:browse")}</Button>
            <Button variant="primary" size="lg" onClick={addDisk} disabled={busy || !diskPath.trim()}>
              {busy ? t("repo.adding") : t("repo.addBadge")}
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">
            {t("repo.addDiskNote")}
          </p>
        </div>
      )}
    </div>
  );
}
