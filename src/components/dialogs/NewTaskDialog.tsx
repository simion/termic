// New task dialog: name + CLI segmented pills + branch name +
// branch-from. Calls task_create on submit.

import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { visibleCliIds } from "@/lib/agents";
import { taskCreate, taskCreateMulti, settingsLoad, taskImportableWorktrees, taskImportWorktree, sandboxAvailable, taskOpenRepo, projectGitBranches } from "@/lib/ipc";
import { launchSetupTab } from "@/lib/runTabs";
import { slugify, branchify, cn } from "@/lib/utils";
import { Check, Loader2, AlertTriangle, GitBranch, Link2, FolderGit2, Plus } from "lucide-react";
import { SandboxModeSelector } from "@/components/SandboxModeSelector";
import { SANDBOX_PRESETS } from "@/lib/sandboxPresets";
import type { MemberMode, ImportableWorktree, SandboxMode } from "@/lib/types";

const CLIS = ["claude", "codex", "agy", "grok", "opencode"] as const;

// Nudge a proposed branch off any name that already exists in the repo — a
// task archived without deleting its branch leaves the name behind, and reusing
// it fails or silently checks out stale commits (issue #129). If the base ends
// in `-<n>` we bump that number; otherwise we append `-2`, then `-3`, ... until
// the name is free. Only the auto-filled default is adjusted; a branch the user
// typed is never touched (empty `existing` short-circuits here).
function uniqueBranch(base: string, existing: string[]): string {
  if (!base || existing.length === 0) return base;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  const m = base.match(/^(.*)-(\d+)$/);
  const stem = m ? m[1] : base;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

// Remember the user's last-used task type + sandbox mode across opens —
// most people always work one way (always worktree, always enforce), so
// re-deriving from project defaults every time fights their habit. Stored
// globally (not per-project): the choice is about how the user works, not the
// repo. Hard constraints still override at open time (non-git forces repo_root;
// an unsupported OS forces sandbox off).
const LS_LAST_MODE    = "newTaskLastMode";
const LS_LAST_SANDBOX = "newTaskLastSandboxMode";
function readLastMode(): "worktree" | "repo_root" | null {
  try { const v = localStorage.getItem(LS_LAST_MODE); return v === "worktree" || v === "repo_root" ? v : null; } catch { return null; }
}
function readLastSandbox(): SandboxMode | null {
  try { const v = localStorage.getItem(LS_LAST_SANDBOX); return v === "off" || v === "monitor" || v === "enforce" || v === "enforce-fs" ? v : null; } catch { return null; }
}
function persistLast(key: string, val: string) { try { localStorage.setItem(key, val); } catch {} }
// Branch names auto-fill as `<prefix>/<name>` where the prefix comes from
// the customizable `branchPrefix` pref (Settings → General, default
// "feature"). The user edits the resulting field freely from there.

export function NewTaskDialog() {
  const projectId = useUI(s => s.newTaskProjectId);
  const close = useUI(s => s.closeNewTask);
  const project = useApp(s => projectId ? s.projects.find(p => p.id === projectId) : null);
  const setActive = useApp(s => s.setActiveTask);
  const loadAll = useApp(s => s.loadAll);
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const branchPrefix = usePrefs(s => s.branchPrefix);
  // CLI choices: the registry (custom agents included), or the built-in
  // list before it loads — minus any disabled / not-installed agents.
  // Build the picker options. Always APPEND a synthetic "Terminal"
  // (cli = "shell") entry so the user has a fallback when zero agents
  // are installed — without it the picker would be either empty or
  // populated with uninstalled agents that spawn-fail at create time.
  // The TerminalPane / ensureDefaultTab paths already treat cli="shell"
  // as a login zsh, so this is a complete task shape, not a stub.
  const SHELL_CHOICE = { id: "shell", display_name: "Terminal", color: "" } as any;
  const cliChoices = (() => {
    const list = agents.length
      ? agents
      : CLIS.map(id => ({ id, display_name: id, color: "" } as any));
    const visible = visibleCliIds(list.map(a => a.id), agents, detectedClis);
    return [...list.filter(a => visible.has(a.id)), SHELL_CHOICE];
  })();

  const [name, setName] = useState("");
  const [cli, setCli] = useState<string>("claude");
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [base, setBase] = useState("");
  // Single-repo task shape: "worktree" (branch a fresh working dir) or
  // "repo_root" (no worktree — launch the agent in the repo's live checkout,
  // the same shape as the sidebar's "Run in repo with <agent>"). Main checkout
  // (repo_root) is the default (most people start there, reach for worktrees
  // later); repo_root hides the branch fields + sandbox panel and creates via
  // task_open_repo. Multi-repo ignores this (it has its own per-member
  // toggle); non-git projects force repo_root (no branches).
  const [mode, setMode] = useState<"worktree" | "repo_root">("repo_root");
  // Flipping the toggle writes through to the shared `newTaskLastMode` key
  // right away (not just on submit), so the sidebar quick menu and this modal
  // always agree on the last choice. Opening the dialog (which also calls
  // setMode) must NOT persist, so that path uses setMode directly.
  const chooseMode = (m: "worktree" | "repo_root") => { setMode(m); persistLast(LS_LAST_MODE, m); };
  // Sandbox pin captured at creation. Defaults from project, can be
  // overridden for this one task, then is permanent post-create.
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("off");
  // Sandbox is macOS-only. On unsupported platforms, disable monitor/
  // enforce in the selector and force the pin to "off" so we never save
  // an unsupported mode that would only fail later at spawn.
  const [osSandboxOk, setOsSandboxOk] = useState<boolean | null>(null);
  useEffect(() => { sandboxAvailable().then(setOsSandboxOk).catch(() => setOsSandboxOk(false)); }, []);
  useEffect(() => {
    if (osSandboxOk === false && sandboxMode !== "off") setSandboxMode("off");
  }, [osSandboxOk, sandboxMode]);
  // The sandbox lists. Initialized from the
  // project's defaults whenever projectId changes; the user edits
  // freely until Create. Stored as multi-line text - we convert to
  // arrays at submit time. Using raw text in state lets the textareas
  // behave normally (blank lines while typing don't fight the split).
  const [sbRw,    setSbRw]    = useState("");
  const [sbHosts, setSbHosts] = useState("");
  // Multi-repo: per-member spec, keyed by member root_path. Seeded when
  // the dialog opens for a multi project from project.members (which are
  // self-contained — no project lookup). Scripts are not per-task —
  // they live on the multi-repo project itself. The dialog only collects
  // mode + branch overrides here. name / non_git are carried for display.
  type MemberSpec = {
    root_path: string;
    name: string;
    non_git: boolean;
    mode: MemberMode;
    branch: string;
    base_branch: string;
  };
  const [members, setMembers] = useState<MemberSpec[]>([]);
  const isMulti = (project?.type ?? "single") === "multi";
  // Sandbox is offered for single-repo tasks in BOTH locations: the seatbelt +
  // proxy cage the main checkout identically to a worktree (see task_open_repo,
  // which now takes sandbox args). Multi keeps its own handling (its mode stays
  // "worktree"), so the repo-root case is gated on !isMulti.
  const canSandbox = mode === "worktree" || (mode === "repo_root" && !isMulti);
  // Derived: any cage on. Drives the 2-column layout + "send lists" gating.
  const sandbox = sandboxMode !== "off" && canSandbox;
  // Import mode (issue #5): instead of branching a fresh worktree, adopt
  // one that already exists on disk. Only offered for single-repo git
  // projects (multi composition / non-git folders don't apply). When on,
  // the git fields (branch / branch-from) are hidden and the
  // user picks from `importList` instead.
  const canImport = !isMulti && !project?.non_git;
  const [importMode, setImportMode] = useState(false);
  const [importList, setImportList] = useState<ImportableWorktree[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importSelected, setImportSelected] = useState<string | null>(null);
  // Existing local branch names in the project's repo, loaded on open so the
  // auto-filled branch can dodge one still hanging around from an archived
  // task (issue #129). Empty until loaded / for non-git / multi projects.
  const [existingBranches, setExistingBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Ref guard against double-submit. React batches setBusy(true) so the
  // button's `disabled` only updates on the next render — but during a
  // burst of Enter/click events, multiple submit() calls can already be
  // queued before that render lands. Without this guard, mashing Create
  // produces multiple worktrees on disk (the user's "hanged a lot of new
  // task" bug). The ref is checked + flipped synchronously inside
  // submit() so concurrent calls see the truth immediately.
  const submittingRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  // Progress phase: form (default) → creating (worktree+copy in flight) →
  // setup (running setup script with live output) → done (success, 2s flash) → error.
  const [phase, setPhase] = useState<"form" | "creating" | "setup" | "done" | "error">("form");
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Reset the form ONLY when the dialog opens for a different project —
  // never on re-fetches of the same project's data. Window-focus events fire
  // `loadAll()` (App.tsx) which replaces the projects array → `project`
  // object identity changes → an effect depending on `project` would wipe
  // every field the user just typed. Depending on `projectId` (a stable
  // string) avoids that. We seed CLI/base from the project but read them
  // imperatively at effect-time via getState so we don't need them in deps.
  useEffect(() => {
    if (!projectId) return;
    const p = useApp.getState().projects.find(x => x.id === projectId);
    // Seed (from openNewTask's optional 2nd arg): used by the
    // "Duplicate task" flow to pre-fill `base` with the source
    // task's branch tip + optionally seed a name prefix.
    const seed = useUI.getState().newTaskSeed;
    setName(seed?.namePrefix ?? "");
    setBranch(""); setBranchEdited(false); setErr(null);
    setBase(seed?.baseBranch ?? p?.base_branch ?? "");
    // Pick a CLI that's actually present and respects the project's
    // saved default whenever usable. Order:
    //   1. project default — IF it's "shell" (always usable), or
    //      installed, or detection hasn't run yet (trust the saved
    //      pick before we know better).
    //   2. first installed agent (when project default is known-broken).
    //   3. "shell" as the no-agent fallback.
    const detected = useApp.getState().detectedClis;
    const list = useApp.getState().agents;
    const detectionRan = Object.keys(detected).length > 0;
    const isInstalled = (id: string) => detected[id]?.found === true;
    const isUsable = (id: string) =>
      id === "shell" || !detectionRan || isInstalled(id);
    const projectDefault = p?.default_cli || "";
    if (projectDefault && isUsable(projectDefault)) {
      setCli(projectDefault);
    } else {
      const firstInstalled = list.find(a => !a.disabled && isInstalled(a.id))?.id;
      setCli(firstInstalled ?? "shell");
    }
    // Sandbox toggle defaults to project's preference OR the global
    // default (Settings → General). Either being true checks the box.
    // The user can still flip for THIS task - but once Create
    // fires, the pin is permanent on the Task record. The
    // three lists are seeded from the project's defaults; user
    // edits in this dialog land on the task ONLY, never on
    // the project.
    // Last-used sandbox mode wins (the user's habit); fall back to the
    // project / global default only before they've ever picked one.
    const globalDefault = usePrefs.getState().globalDefaultSandbox;
    setSandboxMode(readLastSandbox()
      ?? p?.default_sandbox_mode
      ?? ((!!p?.default_sandbox || globalDefault) ? "enforce" : "off"));
    // Seed with project's lists immediately; once Settings loads,
    // merge global defaults on top (dedupe-preserving order).
    setSbRw((p?.sandbox_rw_paths ?? []).join("\n"));
    setSbHosts((p?.sandbox_allowed_hosts ?? []).join("\n"));
    // Seed the per-member spec (multi-repo only). Each member starts
    // in Worktree mode on its own default branch — the simplest +
    // safest default. User can flip per-member to Repo root or change
    // branches before submit.
    if ((p?.type ?? "single") === "multi") {
      const seeded: MemberSpec[] = (p?.members ?? []).map(pm => ({
        root_path: pm.root_path,
        name: pm.name,
        non_git: !!pm.non_git,
        // Non-git members can't be worktreed (no branches) → force
        // repo_root, same rule as a non-git single project / host.
        mode: (pm.non_git ? "repo_root" : "worktree") as MemberMode,
        branch: "",
        base_branch: pm.base_branch || "",
      }));
      setMembers(seeded);
    } else {
      setMembers([]);
    }
    settingsLoad().then(s => {
      const merge = (...lists: (string[] | undefined)[]) => {
        const seen = new Set<string>(); const out: string[] = [];
        for (const list of lists) {
          for (const v of list ?? []) {
            if (v && !seen.has(v)) { seen.add(v); out.push(v); }
          }
        }
        return out.join("\n");
      };
      // For multi-repo: union globals + host + every member's own
      // sandbox lists (carried inline on the member). Same dedupe-
      // preserving order as single-repo, just N+1 inputs instead of 2.
      if ((p?.type ?? "single") === "multi") {
        const mem = p?.members ?? [];
        setSbRw(merge(
          s.sandbox_default_rw_paths,
          p?.sandbox_rw_paths,
          ...mem.map(m => m.sandbox_rw_paths),
        ));
        setSbHosts(merge(
          s.sandbox_default_allowed_hosts,
          p?.sandbox_allowed_hosts,
          ...mem.map(m => m.sandbox_allowed_hosts),
        ));
      } else {
        setSbRw(merge(s.sandbox_default_rw_paths,      p?.sandbox_rw_paths));
        setSbHosts(merge(s.sandbox_default_allowed_hosts, p?.sandbox_allowed_hosts));
      }
    }).catch(() => {});
    // Import mode: off by default. We eager-load the project's existing
    // unopened worktrees so the "Import an existing worktree instead"
    // affordance only appears when there's actually something to import.
    const canImp = (p?.type ?? "single") !== "multi" && !p?.non_git;
    const wantImport = !!seed?.importMode && canImp;
    setImportSelected(null); setImportList([]); setImportLoading(false);
    setImportMode(wantImport);
    // Load existing branches so `derived` can auto-number past a collision
    // (#129). Only meaningful for single-repo git projects (worktree mode).
    setExistingBranches([]);
    if (canImp) {
      projectGitBranches(projectId).then(setExistingBranches).catch(() => {});
    }
    // Non-git folders can't be worktreed → force repo_root. Everything else
    // restores the user's last-used type (main checkout by default). Shares
    // the `newTaskLastMode` key with the sidebar quick menu, so the toggle
    // choice carries across both surfaces.
    setMode(p?.non_git ? "repo_root" : (readLastMode() ?? "repo_root"));
    if (canImp) loadImportable(projectId);
    setPhase("form"); setSetupLog([]); setCreatedTaskId(null);
    // CRITICAL: also reset `busy`. On a successful prior creation we
    // intentionally leave busy=true (so the form can't be re-submitted
    // during the streaming-setup phase). Without this reset, the NEXT
    // time the dialog opens, busy is still true → Create button stays
    // disabled even with all fields filled.
    setBusy(false);
    submittingRef.current = false;
  }, [projectId]);

  // Tauri event unlisten handles. Owned by submit() (which registers them
  // imperatively BEFORE invoking taskCreate — guaranteed ordering vs
  // the old useEffect-based subscription that races against fast/empty
  // setup scripts). Cleaned up on unmount + before each new submission.
  const unlistenRef = useRef<Array<() => void>>([]);
  useEffect(() => () => {
    for (const u of unlistenRef.current) u();
    unlistenRef.current = [];
  }, []);

  // Auto-scroll setup output as new lines arrive.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [setupLog]);

  // Branch auto-fills from the name, but ONLY until the user touches the
  // branch field — after that it's theirs and we never clobber it (#15:
  // no more fighting a prefix you didn't want). Default shape is
  // `feature/<name>`, fully editable. A name that's already a qualified
  // branch (contains a "/", e.g. a Linear "username/my-feature" pasted
  // straight in) is taken verbatim with no prefix.
  const derived = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    const base = trimmed.includes("/")
      ? branchify(trimmed)
      // Normalize the user's prefix at use time: drop surrounding slashes /
      // whitespace. An empty prefix yields a bare slug (no leading slash).
      : (() => {
          const prefix = branchPrefix.trim().replace(/^\/+|\/+$/g, "");
          const slug = slugify(trimmed);
          return prefix ? `${prefix}/${slug}` : slug;
        })();
    return uniqueBranch(base, existingBranches);
  }, [name, branchPrefix, existingBranches]);
  useEffect(() => { if (!branchEdited) setBranch(derived); }, [derived, branchEdited]);

  // Load the project's importable (existing, unopened) worktrees.
  // Declared as a hoisted function so the open-effect can call it.
  function loadImportable(pid: string) {
    setImportLoading(true);
    taskImportableWorktrees(pid)
      .then(list => setImportList(list))
      .catch(e => setErr(String(e)))
      .finally(() => setImportLoading(false));
  }

  // Flip into import mode from the in-form affordance, lazy-loading the
  // worktree list the first time.
  function enterImport() {
    if (!projectId) return;
    setImportMode(true);
    setErr(null);
    if (importList.length === 0 && !importLoading) loadImportable(projectId);
  }

  // Pick an existing worktree to import. Seed the name from its branch
  // (or the dir basename for a detached HEAD) so it's a one-step adopt.
  function pickImport(wt: ImportableWorktree) {
    setImportSelected(wt.path);
    const baseName = wt.path.split("/").pop() || "worktree";
    setName(wt.branch || baseName);
  }

  // Adopt an existing worktree. No worktree-add / file-copy / setup
  // script, so this skips the streaming phases entirely.
  async function submitImport() {
    if (!projectId || !importSelected || !name.trim()) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true); setErr(null);
    try {
      const splitLines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
      const w = await taskImportWorktree(
        projectId, importSelected, name.trim(), cli,
        { enabled: sandbox, mode: sandboxMode, rwPaths: splitLines(sbRw), allowedHosts: splitLines(sbHosts) },
      );
      await loadAll();
      setActive(w.id);
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  }

  // Repo-root create: no worktree, no file-copy, no setup script — just open
  // the agent in the repo's live checkout (same IPC the sidebar "Run in repo"
  // rows use). Skips the streaming phases entirely, like submitImport.
  async function submitRepoRoot() {
    if (!projectId || !name.trim()) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true); setErr(null);
    try {
      const splitLines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
      const w = await taskOpenRepo(
        projectId, cli, name.trim(),
        { enabled: sandbox, mode: sandboxMode, rwPaths: splitLines(sbRw), allowedHosts: splitLines(sbHosts) },
      );
      await loadAll();
      setActive(w.id);
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  }

  async function submit() {
    // Remember how the user works for next time. Task type is a
    // single-repo concept (multi has its own per-member toggle); sandbox mode
    // is remembered whenever a worktree/multi create can carry one.
    if (!isMulti) persistLast(LS_LAST_MODE, mode);
    // Sandbox can now ride on a single-repo main-checkout create too, so
    // remember the mode whenever a create can carry one (i.e. always here).
    persistLast(LS_LAST_SANDBOX, sandboxMode);
    // Import wins over the task-type mode: adopting a worktree is orthogonal
    // to worktree-vs-main-checkout, and the dialog can now open straight into
    // import mode from the launcher menu while `mode` is still repo_root
    // (the remembered default). Checking repo_root first would silently open
    // the main checkout instead of importing the picked worktree.
    if (importMode) { submitImport(); return; }
    if (mode === "repo_root" && !isMulti) { submitRepoRoot(); return; }
    if (!projectId || !name.trim() || !branch.trim()) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true); setErr(null); setPhase("creating"); setSetupLog([]);
    const taskId = crypto.randomUUID();
    setCreatedTaskId(taskId);
    // Clean up any prior unlisteners from a previous (errored) submission
    // before registering new ones.
    for (const u of unlistenRef.current) u();
    unlistenRef.current = [];
    // Multi-repo still runs its (possibly several, sequential) member setup
    // scripts synchronously on the Rust side and streams progress here —
    // that path is unchanged, so keep waiting on it. Single-repo setup runs
    // as an unfocused background tab instead (see below), so it needs
    // neither of these listeners. Pre-generate + `await listen(...)` BEFORE
    // invoking taskCreateMulti: the earlier useEffect-based subscription
    // wasn't guaranteed to attach in time — for empty setup scripts Rust
    // emits setup-done synchronously, so the done event could fire while
    // React was still scheduling the effect → dialog hung forever on
    // "Waiting for output…". `await listen()` returns once the
    // subscription is confirmed by the Tauri backend, eliminating the race.
    if (isMulti) {
      const uOut = await listen<{ line: string }>(`setup-output://${taskId}`, ev => {
        setSetupLog(log => [...log, ev.payload.line]);
      });
      const uDone = await listen<{ code: number | null; success: boolean }>(`setup-done://${taskId}`, ev => {
        if (ev.payload.success) {
          setPhase("done");
          window.setTimeout(() => { setActive(taskId); close(); }, 2000);
        } else {
          setPhase("error");
          setErr(`Setup script exited with code ${ev.payload.code ?? "?"}.`);
        }
      });
      unlistenRef.current = [uOut, uDone];
    }
    try {
      // Snap textareas → string[]. Done at submit so blank lines
      // during typing don't roundtrip through the array state.
      const splitLines = (s: string) =>
        s.split("\n").map(l => l.trim()).filter(Boolean);
      if (isMulti) {
        await taskCreateMulti({
          id: taskId,
          project_id: projectId,
          name: name.trim(),
          cli,
          base_branch: base.trim() || undefined,
          branch: branch.trim(),
          members: members.map(m => ({
            root_path: m.root_path,
            mode: m.mode,
            // Worktree mode: blank branch falls back to the task's
            // top-level branch on the Rust side. base falls back to
            // the member project's own base. RepoRoot mode ignores both.
            branch: m.mode === "worktree" ? (m.branch.trim() || undefined) : undefined,
            base_branch: m.mode === "worktree" ? (m.base_branch.trim() || undefined) : undefined,
          })),
          sandbox_enabled: sandbox,
          sandbox_mode: sandboxMode,
          sandbox_rw_paths:       sandbox ? splitLines(sbRw)    : undefined,
          sandbox_allowed_hosts:  sandbox ? splitLines(sbHosts) : undefined,
        });
        await loadAll();
        setPhase("setup");
        // On success, submittingRef stays true until the dialog closes —
        // guards against any re-submit during the streaming-setup phase.
        return;
      }
      await taskCreate({
        id: taskId,
        project_id: projectId,
        name: name.trim(),
        cli,
        base_branch: base.trim() || null,
        branch: branch.trim(),
        sandbox_enabled: sandbox,
        sandbox_mode: sandboxMode,
        // Only send lists when sandbox is on - keeps the JSON tidy
        // for unsandboxed tasks (they don't need these saved).
        sandbox_rw_paths:       sandbox ? splitLines(sbRw)    : undefined,
        sandbox_allowed_hosts:  sandbox ? splitLines(sbHosts) : undefined,
      });
      await loadAll();
      // Single-repo worktree: open immediately and focus the main agent —
      // no blocking "running setup…" phase. If the project has a setup
      // script, it fires right after as an unfocused background tab
      // (ensureDefaultTab excludes setup-kind tabs from its "already
      // mounted" check, so the two can't race each other out).
      setActive(taskId);
      close();
      launchSetupTab(taskId, { focus: false }).catch(() => {});
    } catch (e) {
      setErr(String(e)); setBusy(false); setPhase("error");
      submittingRef.current = false;
      return;
    }
    // Success: for multi, submittingRef stays true until the dialog closes
    // (guards against a re-submit during the streaming-setup phase). For
    // single-repo, the dialog is already closed above — tidy up so a later
    // mount of this component starts clean.
    if (!isMulti) { setBusy(false); submittingRef.current = false; }
  }

  return (
    <AppDialog
      // Lock dialog while creating — clicking outside or Escape would leave
      // the user staring at no feedback while the worktree/file-copy chugs
      // for several seconds on big repos.
      open={!!projectId}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title={isMulti ? "New multi-repo task" : importMode ? "Import existing worktree" : mode === "repo_root" ? "New task in the main checkout" : "New task in a worktree"}
      description={undefined}
      // Widen the dialog to fit what's inside. Base width per mode (xl 36rem /
      // 2xl 42rem / 3xl 48rem) sizes the single-column form. Enabling the
      // sandbox adds a SECOND, equal (flex-1) column plus a 2rem (ml-8) gutter,
      // so the dialog is 2*base - 0.5rem (content = 2*(base-2.5) + 2rem gutter,
      // + 2.5rem padding). Everything is in REM so, whatever the root font-size
      // (14px here), each flex-1 column resolves to the SAME width as the
      // single-column form — the left never changes, only the column is added.
      className={
        sandbox
          ? (isMulti ? "max-w-[95.5rem]" : importMode ? "max-w-[83.5rem]" : "max-w-[71.5rem]")
          : (isMulti ? "max-w-3xl" : importMode ? "max-w-2xl" : "max-w-xl")
      }
    >
      {/* Phase-aware body: form on start, then progress view while creating
          + running setup. Form stays unmounted in non-form phases so its
          state doesn't fight the progress UI. */}
      {phase !== "form" && (
        <ProgressBody
          phase={phase}
          err={err}
          setupLog={setupLog}
          outputRef={outputRef}
          onClose={() => { if (!busy || phase === "error") { setPhase("form"); setBusy(false); close(); } }}
        />
      )}
      {phase === "form" && (
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="mt-1.5 flex flex-col gap-6"
      >
      {/* Columns row: the left form + the sandbox config as a second column
          when a cage is enabled. Left is flex-1 (can't overflow); the sandbox
          column is flex-1 too, and the dialog max-width (below) is sized in REM
          so each column resolves to the SAME width in both states. */}
      <div className="flex">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {/* Every field uses the same structure: label on its own line, optional
            hint underneath, control on a new line. Previous version inlined
            the segmented controls next to the label and put hints on the same
            line as the label — both caused the spacing weirdness + wrapped
            hint text. */}
        {/* Import affordance (issue #5). Single-repo git projects only.
            A subtle link that flips the dialog into "adopt an existing
            worktree" mode, hiding the branch fields. */}
        {canImport && !importMode && mode === "worktree" && importList.length > 0 && (
          <button
            type="button"
            onClick={enterImport}
            className="-mb-1 inline-flex items-center gap-1.5 self-start text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-accent)]"
          >
            <FolderGit2 className="h-3.5 w-3.5" />
            Import an existing worktree instead
            <span className="text-[var(--color-fg-faint)]">({importList.length})</span>
          </button>
        )}
        {canImport && importMode && (
          <button
            type="button"
            onClick={() => { setImportMode(false); setImportSelected(null); setErr(null); }}
            className="-mb-1 inline-flex items-center gap-1.5 self-start text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-accent)]"
          >
            <Plus className="h-3.5 w-3.5" />
            Create a new worktree instead
          </button>
        )}

        {/* Worktree picker — replaces the branch fields in import mode. */}
        {importMode && (
          <Field label="Existing worktree" hint="Worktrees of this repo that aren't already open as tasks.">
            {importLoading ? (
              <div className="flex items-center gap-2 px-1 py-4 text-[12.5px] text-[var(--color-fg-faint)]">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent)]" /> Scanning worktrees…
              </div>
            ) : importList.length === 0 ? (
              <div className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-4 text-center text-[12px] text-[var(--color-fg-faint)]">
                No unopened worktrees found. Create one with{" "}
                <code className="mono">git worktree add</code>, or switch back to make a new one.
              </div>
            ) : (
              <div className="max-h-[200px] overflow-auto rounded-md border border-[var(--color-border-soft)]">
                {importList.map(wt => (
                  <button
                    key={wt.path}
                    type="button"
                    onClick={() => pickImport(wt)}
                    title={wt.path}
                    className={cn(
                      "flex w-full items-center gap-2.5 border-b border-[var(--color-border-soft)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--color-hover)]",
                      importSelected === wt.path && "bg-[var(--color-accent-deep)]/10",
                    )}
                  >
                    <FolderGit2 className={cn("h-4 w-4 shrink-0", importSelected === wt.path ? "text-[var(--color-accent)]" : "text-[var(--color-fg-faint)]")} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-[var(--color-fg)]">
                        {wt.branch || <span className="italic text-[var(--color-fg-dim)]">detached {wt.head}</span>}
                      </div>
                      <div className="truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{wt.path}</div>
                    </div>
                    {importSelected === wt.path && <Check className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />}
                  </button>
                ))}
              </div>
            )}
          </Field>
        )}

        {/* Worktree vs repo-root toggle (single-repo only — multi has its
            own per-member toggle below). Repo root hides the branch + sandbox
            fields and creates in the repo's live checkout. Non-git projects
            can't worktree, so the Worktree button is disabled there. */}
        {!isMulti && !importMode && (
          <Field label="Task type">
            <div className="flex flex-col gap-1.5">
              <div className="inline-flex self-start items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
                <button
                  type="button"
                  onClick={() => chooseMode("repo_root")}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors",
                    mode === "repo_root"
                      ? "bg-[var(--color-accent-deep)] text-white"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  <Link2 className="h-3.5 w-3.5" /> Main checkout
                </button>
                <button
                  type="button"
                  onClick={() => chooseMode("worktree")}
                  disabled={!!project?.non_git}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors disabled:opacity-40",
                    mode === "worktree"
                      ? "bg-[var(--color-accent-deep)] text-white"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  <GitBranch className="h-3.5 w-3.5" /> Worktree
                </button>
              </div>
              <p className="text-[12px] text-[var(--color-fg-faint)]">
                {mode === "worktree"
                  ? "Isolated branch in its own working directory. Run agents in parallel without touching your main checkout."
                  : "No worktree. The agent runs in the repo's main checkout, on its current branch. Edits land on your real files."}
              </p>
            </div>
          </Field>
        )}

        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="fix login bug" autoFocus required />
        </Field>

        <Field label="Default CLI" hint="Auto-launches on first open. You can spawn other agents anytime via the task's + button.">
          {/* Pulled from the editable agent registry (Settings → Agent
              CLIs), not hard-coded — custom agents show up here. Disabled
              and not-installed agents are filtered out (see cliChoices).
              "Terminal" (cli="shell") is appended as a no-agent fallback. */}
          <div className="inline-flex flex-wrap items-stretch gap-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
            {cliChoices.map(a => (
              <button
                key={a.id} type="button" onClick={() => setCli(a.id)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors",
                  cli === a.id
                    ? "bg-[var(--color-accent-deep)] text-white"
                    : cn("text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]", CLI_BRAND_COLOR[a.icon_id]),
                )}
                style={cli === a.id ? undefined : (a.color ? { color: a.color } : undefined)}
              >
                {/* Local label override: shorten Antigravity → Agy
                    so the segmented control fits more comfortably on
                    one row. The global display_name stays untouched
                    (used elsewhere in the app). */}
                <CliIcon cli={a.icon_id} className="h-3.5 w-3.5" />
                {a.id === "agy" ? "Agy" : a.display_name}
              </button>
            ))}
          </div>
        </Field>

        {!importMode && mode === "worktree" && (<>
        {/* Always editable. Auto-fills as “feature/<name>” while you type
            the name, then stops the moment you touch it, so pasting a
            branch from Linear (“username/my-feature”) is a true one-shot:
            select all, paste, done. No prefix control to fight (#15). */}
        <Field
          label="Branch name"
          hint="Auto-fills from the name. Edit or paste a full branch directly; once you change it, it stays."
        >
          <Input
            value={branch}
            onChange={e => { setBranch(e.target.value); setBranchEdited(true); }}
            placeholder="feature/fix-login-bug"
            required
          />
        </Field>

        <Field label={isMulti ? "Host branch from" : "Branch from"} hint={isMulti ? "Blank = host repo default. Members fall back to their own defaults below." : "Blank = repo default."}>
          <Input value={base} onChange={e => setBase(e.target.value)} placeholder="origin/master" />
        </Field>
        </>)}

        {/* Multi-repo: per-member mode + branch picker. Each member
            row renders a small toggle (Worktree | Repo root) and, when
            in Worktree mode, a branch + base override. RepoRoot mode
            collapses to a single warning line. */}
        {isMulti && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-[13px] font-medium text-[var(--color-fg)]">
                Members ({members.length})
              </label>
              <span className="text-[11.5px] text-[var(--color-fg-faint)]">
                Per-repo mode + branch
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {members.map((m, idx) => {
                const update = (patch: Partial<MemberSpec>) =>
                  setMembers(prev => prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                return (
                  <div
                    key={m.root_path}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-[var(--color-fg)]">{m.name}</div>
                        <div className="truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{m.root_path}</div>
                      </div>
                      <div className="inline-flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-[2px] text-[11.5px]">
                        {/* Main checkout first, matching the single-repo toggle
                            and the sidebar quick menu (left = main, right =
                            worktree everywhere). */}
                        <button
                          type="button"
                          onClick={() => update({ mode: "repo_root" })}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-[4px] px-2 transition-colors",
                            m.mode === "repo_root"
                              ? "bg-[var(--color-accent-deep)] text-white"
                              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                          )}
                        >
                          <Link2 className="h-3 w-3" /> Main checkout
                        </button>
                        <button
                          type="button"
                          // Non-git members have no branches → worktree is
                          // impossible; lock them to repo-root like a non-git
                          // single project.
                          disabled={m.non_git}
                          title={m.non_git ? "Not a git repository, runs in the main checkout only" : undefined}
                          onClick={() => update({ mode: "worktree" })}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-[4px] px-2 transition-colors",
                            m.mode === "worktree"
                              ? "bg-[var(--color-accent-deep)] text-white"
                              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                            m.non_git && "cursor-not-allowed opacity-40 hover:text-[var(--color-fg-dim)]",
                          )}
                        >
                          <GitBranch className="h-3 w-3" /> Worktree
                        </button>
                      </div>
                    </div>
                    {m.mode === "worktree" ? (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Input
                          value={m.branch}
                          onChange={e => update({ branch: e.target.value })}
                          placeholder={branch || "(same as host branch)"}
                        />
                        <Input
                          value={m.base_branch}
                          onChange={e => update({ base_branch: e.target.value })}
                          placeholder={m.base_branch || "branch from…"}
                        />
                      </div>
                    ) : (
                      <div className="mt-2 text-[11.5px] text-[var(--color-warn)]">
                        Live symlink. Agent edits land directly on your real checkout.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {members.some(m => m.mode === "repo_root") && (
              <div className="rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2 text-[12px] text-[var(--color-warn)]">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                One or more members are linked to live checkouts. The agent
                can directly modify those repos. No worktree isolation.
              </div>
            )}
          </div>
        )}

        {/* Sandbox panel - same shape as the Edit Sandbox dialog so
            users see one consistent control. Wrapped in a Field so the
            OFF / MONITORING / ENFORCING band reads as a labelled "Sandbox"
            control like every other row (otherwise it's an unlabelled
            strip of buttons whose purpose isn't obvious). Pinned at
            creation - lists below freeze onto the task and can't be
            edited after (archive + recreate to change). */}
        {/* Offered for single-repo worktree AND main checkout (see canSandbox);
            multi has its own per-member handling. */}
        {canSandbox && (
        <Field label="Sandbox" hint="Cage the agent's filesystem + network access. Pinned at creation.">
          <SandboxModeSelector value={sandboxMode} onChange={setSandboxMode} osUnavailable={osSandboxOk === false} compact />
        </Field>
        )}
      </div>

      {/* Right column: sandbox config, an equal-width second pane (flex-1, so
          it matches the left; the dialog is sized to 2x base). Rendered ONLY
          when a cage is enabled, so there's no ghost width/height when off. */}
      {sandbox && (
        <div className="ml-8 flex min-w-0 flex-1 flex-col gap-3 border-l border-[var(--color-border-soft)] pl-6">
          <div className="text-[11.5px] uppercase tracking-[0.1em] text-[var(--color-fg-faint)]">
            Sandbox config for this task
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-[var(--color-fg-faint)]">Preset:</span>
            {SANDBOX_PRESETS.map(p => (
              <button
                key={p.id} type="button"
                title={p.hint}
                onClick={() => {
                  setSbRw(p.rwPaths.join("\n"));
                  setSbHosts(p.allowedHosts.join("\n"));
                }}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[12px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
              >
                {p.label}
              </button>
            ))}
          </div>
          <Field label="Allowed paths" hint="One per line. Task + agent state + caches + TMPDIR are always allowed. Add extras here.">
            <textarea
              value={sbRw}
              onChange={e => setSbRw(e.target.value)}
              rows={3}
              placeholder={"$HOME/Work/other-project\n$HOME/Notes"}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
          </Field>
          {/* ENFORCING (FS) disables the network sandbox, so the host
              allow-list is irrelevant — hide it in that mode. */}
          {sandboxMode !== "enforce-fs" && (
            <Field label="Allowed hosts" hint="One per line. Use * as a wildcard. Per-CLI vendor + github + npm/pypi/crates are always allowed; these are extras.">
              <textarea
                value={sbHosts}
                onChange={e => setSbHosts(e.target.value)}
                rows={3}
                placeholder={"*.mycompany.com\nbitbucket.org"}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              />
            </Field>
          )}
          {sandboxMode === "enforce-fs" && (
            <p className="text-[12px] leading-snug text-[var(--color-fg-faint)]">
              Network is unrestricted in this mode (filesystem cage only). The
              agent reaches any host directly, with no proxy or host allow-list.
            </p>
          )}
        </div>
      )}
      </div>{/* end columns row */}

      {/* Error + actions row, below the columns. */}
      <div>
        {err && <p className="mb-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !name.trim() || (mode === "repo_root" ? false : importMode ? !importSelected : !branch.trim())}
          >
            {importMode ? "Import" : "Create"}
          </Button>
        </div>
      </div>
      </form>
      )}
    </AppDialog>
  );
}

/** Progress view shown while creating a task. Three sub-states:
 *  - creating: worktree + file-copy in flight (task_create has not yet returned)
 *  - setup: setup script running; stream stdout/stderr line by line
 *  - done: success flash, dialog auto-closes 2s later
 *  - error: surfaces the failure + lets the user dismiss and try again
 */
export function ProgressBody({ phase, err, setupLog, outputRef, onClose }: {
  phase: "creating" | "setup" | "done" | "error";
  err: string | null;
  setupLog: string[];
  outputRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const status =
    phase === "creating" ? { icon: <Loader2 className="h-5 w-5 animate-spin" />, label: "Creating worktree & copying files…" } :
    phase === "setup"    ? { icon: <Loader2 className="h-5 w-5 animate-spin" />, label: "Running setup script…" } :
    phase === "done"     ? { icon: <Check className="h-5 w-5" />, label: "Done." } :
                           { icon: <AlertTriangle className="h-5 w-5" />, label: "Setup failed." };
  const tone =
    phase === "done"  ? "text-[var(--color-ok)]" :
    phase === "error" ? "text-[var(--color-err)]" :
                        "text-[var(--color-fg-dim)]";
  return (
    // min-w-0 is required because the parent is a CSS grid (`Dialog.Content`
    // uses `grid`) — grid items default to `min-width: auto` which means
    // their column refuses to shrink below the intrinsic width of their
    // content. Long monospace lines (pip dep dumps, etc.) then push the
    // whole dialog wider than `max-w-md`. min-w-0 lets the column hit zero
    // and our inner `overflow-auto` actually clip + scroll.
    <div className="flex min-w-0 flex-col gap-3">
      <div className={cn("flex items-center gap-2 text-[13px] font-medium", tone)}>
        {status.icon}
        <span>{status.label}</span>
      </div>
      {(phase === "setup" || phase === "done" || (phase === "error" && setupLog.length > 0)) && (
        <div
          ref={outputRef}
          data-selectable
          // max-w-full + overflow-x-hidden belt-and-braces against any single
          // unbreakable token (urls, base64, long hashes) that `break-words`
          // can't split — those would otherwise stretch the box past the
          // dialog edge again.
          className="h-[220px] max-w-full overflow-auto overflow-x-hidden rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-2.5 font-mono text-[11.5px] leading-snug text-[var(--color-fg-dim)]"
        >
          {setupLog.length === 0
            ? <span className="text-[var(--color-fg-faint)]">Waiting for output…</span>
            : setupLog.map((line, i) => <div key={i} className="whitespace-pre-wrap break-words">{line}</div>)
          }
        </div>
      )}
      {phase === "error" && err && (
        <p className="text-[12.5px] text-[var(--color-err)]">{err}</p>
      )}
      {(phase === "error" || phase === "done") && (
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            {phase === "done" ? "Open now" : "Close"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Form field layout: label / optional hint / control, each on its own line.
 *  Keeps spacing consistent and prevents hint text from wrapping next to the
 *  label (which produced the previous "Branch name (auto-generated from
 *  name; edit to..." 2-line mess). */
function Field({ label, hint, children }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] font-medium text-[var(--color-fg)]">{label}</label>
      {hint && <div className="text-[12px] leading-snug text-[var(--color-fg-faint)] -mt-1">{hint}</div>}
      {children}
    </div>
  );
}

// Per-member script editor moved to NewProjectDialog / RepositorySection
// — scripts are project-scoped, not task-scoped.
