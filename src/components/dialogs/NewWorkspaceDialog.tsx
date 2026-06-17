// New workspace dialog: name + CLI segmented pills + branch name +
// branch-from. Calls workspace_create on submit.

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
import { workspaceCreate, workspaceCreateMulti, settingsLoad, workspaceImportableWorktrees, workspaceImportWorktree, sandboxAvailable, workspaceOpenRepo } from "@/lib/ipc";
import { slugify, branchify, cn } from "@/lib/utils";
import { Check, Loader2, AlertTriangle, GitBranch, Link2, FolderGit2, Plus } from "lucide-react";
import { SandboxModeSelector } from "@/components/SandboxModeSelector";
import { SANDBOX_PRESETS } from "@/lib/sandboxPresets";
import type { MemberMode, ImportableWorktree, SandboxMode } from "@/lib/types";

const CLIS = ["claude", "codex", "agy", "gemini", "grok"] as const;
// Branch names auto-fill as `<prefix>/<name>` where the prefix comes from
// the customizable `branchPrefix` pref (Settings → General, default
// "feature"). The user edits the resulting field freely from there.

export function NewWorkspaceDialog() {
  const projectId = useUI(s => s.newWorkspaceProjectId);
  const close = useUI(s => s.closeNewWorkspace);
  const project = useApp(s => projectId ? s.projects.find(p => p.id === projectId) : null);
  const setActive = useApp(s => s.setActiveWorkspace);
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
  // as a login zsh, so this is a complete workspace shape, not a stub.
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
  // Single-repo workspace shape: "worktree" (branch a fresh working dir) or
  // "repo_root" (no worktree — launch the agent in the repo's live checkout,
  // the same shape as the sidebar's "Run in repo with <agent>"). Worktree is
  // the default; repo_root hides the branch fields + sandbox panel and
  // creates via workspace_open_repo. Multi-repo ignores this (it has its own
  // per-member toggle); non-git projects force repo_root (no branches).
  const [mode, setMode] = useState<"worktree" | "repo_root">("worktree");
  // Sandbox pin captured at creation. Defaults from project, can be
  // overridden for this one workspace, then is permanent post-create.
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("off");
  // Sandbox is macOS-only. On unsupported platforms, disable monitor/
  // enforce in the selector and force the pin to "off" so we never save
  // an unsupported mode that would only fail later at spawn.
  const [osSandboxOk, setOsSandboxOk] = useState<boolean | null>(null);
  useEffect(() => { sandboxAvailable().then(setOsSandboxOk).catch(() => setOsSandboxOk(false)); }, []);
  useEffect(() => {
    if (osSandboxOk === false && sandboxMode !== "off") setSandboxMode("off");
  }, [osSandboxOk, sandboxMode]);
  // Derived: any cage on. Drives the 2-column layout + "send lists" gating.
  // Repo-root mode has no sandbox (workspace_open_repo takes no sandbox args),
  // so force it off there — keeps the layout single-column + the panel hidden.
  const sandbox = sandboxMode !== "off" && mode === "worktree";
  // The sandbox lists. Initialized from the
  // project's defaults whenever projectId changes; the user edits
  // freely until Create. Stored as multi-line text - we convert to
  // arrays at submit time. Using raw text in state lets the textareas
  // behave normally (blank lines while typing don't fight the split).
  const [sbRw,    setSbRw]    = useState("");
  const [sbHosts, setSbHosts] = useState("");
  // Multi-repo: per-member spec, indexed by member project id. Seeded
  // when the dialog opens for a multi project from project.members.
  // Per-member spec. Scripts are not per-workspace — they live on
  // the multi-repo project itself and apply to every workspace under
  // it. The dialog only collects mode + branch overrides here.
  type MemberSpec = {
    project_id: string;
    mode: MemberMode;
    branch: string;
    base_branch: string;
  };
  const [members, setMembers] = useState<MemberSpec[]>([]);
  const isMulti = (project?.type ?? "single") === "multi";
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
  const [busy, setBusy] = useState(false);
  // Ref guard against double-submit. React batches setBusy(true) so the
  // button's `disabled` only updates on the next render — but during a
  // burst of Enter/click events, multiple submit() calls can already be
  // queued before that render lands. Without this guard, mashing Create
  // produces multiple worktrees on disk (the user's "hanged a lot of new
  // workspace" bug). The ref is checked + flipped synchronously inside
  // submit() so concurrent calls see the truth immediately.
  const submittingRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  // Progress phase: form (default) → creating (worktree+copy in flight) →
  // setup (running setup script with live output) → done (success, 2s flash) → error.
  const [phase, setPhase] = useState<"form" | "creating" | "setup" | "done" | "error">("form");
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [createdWsId, setCreatedWsId] = useState<string | null>(null);
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
    // Seed (from openNewWorkspace's optional 2nd arg): used by the
    // "Duplicate workspace" flow to pre-fill `base` with the source
    // workspace's branch tip + optionally seed a name prefix.
    const seed = useUI.getState().newWorkspaceSeed;
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
    // The user can still flip for THIS workspace - but once Create
    // fires, the pin is permanent on the Workspace record. The
    // three lists are seeded from the project's defaults; user
    // edits in this dialog land on the workspace ONLY, never on
    // the project.
    const globalDefault = usePrefs.getState().globalDefaultSandbox;
    setSandboxMode(p?.default_sandbox_mode ?? ((!!p?.default_sandbox || globalDefault) ? "enforce" : "off"));
    // Seed with project's lists immediately; once Settings loads,
    // merge global defaults on top (dedupe-preserving order).
    setSbRw((p?.sandbox_rw_paths ?? []).join("\n"));
    setSbHosts((p?.sandbox_allowed_hosts ?? []).join("\n"));
    // Seed the per-member spec (multi-repo only). Each member starts
    // in Worktree mode on its own default branch — the simplest +
    // safest default. User can flip per-member to Repo root or change
    // branches before submit.
    if ((p?.type ?? "single") === "multi") {
      const all = useApp.getState().projects;
      const seeded: MemberSpec[] = (p?.members ?? []).flatMap(pm => {
        const m = all.find(x => x.id === pm.project_id);
        if (!m) return [];
        return [{
          project_id: pm.project_id,
          mode: "worktree" as MemberMode,
          branch: "",
          base_branch: m.base_branch || "",
        }];
      });
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
      // For multi-repo: union globals + host + every member project's
      // sandbox lists. Same dedupe-preserving order as single-repo,
      // just N+1 inputs instead of 2.
      if ((p?.type ?? "single") === "multi") {
        const all = useApp.getState().projects;
        const memberLists = (p?.members ?? [])
          .map(pm => all.find(x => x.id === pm.project_id))
          .filter((x): x is NonNullable<typeof x> => !!x);
        setSbRw(merge(
          s.sandbox_default_rw_paths,
          p?.sandbox_rw_paths,
          ...memberLists.map(m => m.sandbox_rw_paths),
        ));
        setSbHosts(merge(
          s.sandbox_default_allowed_hosts,
          p?.sandbox_allowed_hosts,
          ...memberLists.map(m => m.sandbox_allowed_hosts),
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
    // Non-git folders can't be worktreed → force repo_root. Everything else
    // defaults to worktree (the safe, isolated default).
    setMode(p?.non_git ? "repo_root" : "worktree");
    if (canImp) loadImportable(projectId);
    setPhase("form"); setSetupLog([]); setCreatedWsId(null);
    // CRITICAL: also reset `busy`. On a successful prior creation we
    // intentionally leave busy=true (so the form can't be re-submitted
    // during the streaming-setup phase). Without this reset, the NEXT
    // time the dialog opens, busy is still true → Create button stays
    // disabled even with all fields filled.
    setBusy(false);
    submittingRef.current = false;
  }, [projectId]);

  // Tauri event unlisten handles. Owned by submit() (which registers them
  // imperatively BEFORE invoking workspaceCreate — guaranteed ordering vs
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
    if (trimmed.includes("/")) return branchify(trimmed);
    // Normalize the user's prefix at use time: drop surrounding slashes /
    // whitespace. An empty prefix yields a bare slug (no leading slash).
    const prefix = branchPrefix.trim().replace(/^\/+|\/+$/g, "");
    const slug = slugify(trimmed);
    return prefix ? `${prefix}/${slug}` : slug;
  }, [name, branchPrefix]);
  useEffect(() => { if (!branchEdited) setBranch(derived); }, [derived, branchEdited]);

  // Load the project's importable (existing, unopened) worktrees.
  // Declared as a hoisted function so the open-effect can call it.
  function loadImportable(pid: string) {
    setImportLoading(true);
    workspaceImportableWorktrees(pid)
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
      const w = await workspaceImportWorktree(
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
      const w = await workspaceOpenRepo(projectId, cli, name.trim());
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
    if (mode === "repo_root" && !isMulti) { submitRepoRoot(); return; }
    if (importMode) { submitImport(); return; }
    if (!projectId || !name.trim() || !branch.trim()) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true); setErr(null); setPhase("creating"); setSetupLog([]);
    // Pre-generate the workspace ID then `await listen(...)` for BOTH
    // setup-output and setup-done BEFORE invoking workspaceCreate. The
    // earlier useEffect-based subscription wasn't guaranteed to attach in
    // time — for empty setup scripts Rust emits setup-done synchronously
    // inside workspace_create_sync, so the done event could fire while
    // React was still scheduling the effect → dialog hung forever on
    // "Waiting for output…". `await listen()` returns once the
    // subscription is confirmed by the Tauri backend, eliminating the
    // race entirely.
    const wsId = crypto.randomUUID();
    setCreatedWsId(wsId);
    // Clean up any prior unlisteners from a previous (errored) submission
    // before registering new ones.
    for (const u of unlistenRef.current) u();
    unlistenRef.current = [];
    const uOut = await listen<{ line: string }>(`setup-output://${wsId}`, ev => {
      setSetupLog(log => [...log, ev.payload.line]);
    });
    const uDone = await listen<{ code: number | null; success: boolean }>(`setup-done://${wsId}`, ev => {
      if (ev.payload.success) {
        setPhase("done");
        window.setTimeout(() => { setActive(wsId); close(); }, 2000);
      } else {
        setPhase("error");
        setErr(`Setup script exited with code ${ev.payload.code ?? "?"}.`);
      }
    });
    unlistenRef.current = [uOut, uDone];
    try {
      // Snap textareas → string[]. Done at submit so blank lines
      // during typing don't roundtrip through the array state.
      const splitLines = (s: string) =>
        s.split("\n").map(l => l.trim()).filter(Boolean);
      if (isMulti) {
        await workspaceCreateMulti({
          id: wsId,
          project_id: projectId,
          name: name.trim(),
          cli,
          base_branch: base.trim() || undefined,
          branch: branch.trim(),
          members: members.map(m => ({
            project_id: m.project_id,
            mode: m.mode,
            // Worktree mode: blank branch falls back to the workspace's
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
      } else {
        await workspaceCreate({
          id: wsId,
          project_id: projectId,
          name: name.trim(),
          cli,
          base_branch: base.trim() || null,
          branch: branch.trim(),
          sandbox_enabled: sandbox,
          sandbox_mode: sandboxMode,
          // Only send lists when sandbox is on - keeps the JSON tidy
          // for unsandboxed workspaces (they don't need these saved).
          sandbox_rw_paths:       sandbox ? splitLines(sbRw)    : undefined,
          sandbox_allowed_hosts:  sandbox ? splitLines(sbHosts) : undefined,
        });
      }
      await loadAll();
      setPhase("setup");
    } catch (e) {
      setErr(String(e)); setBusy(false); setPhase("error");
      submittingRef.current = false;
    }
    // On success, submittingRef stays true until the dialog closes — guards
    // against any re-submit during the streaming-setup phase.
  }

  return (
    <AppDialog
      // Lock dialog while creating — clicking outside or Escape would leave
      // the user staring at no feedback while the worktree/file-copy chugs
      // for several seconds on big repos.
      open={!!projectId}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title={isMulti ? "New multi-repo workspace" : importMode ? "Import existing worktree" : mode === "repo_root" ? "New workspace in repo root" : "New workspace via worktree"}
      description={undefined}
      // Widen the dialog based on what's actually inside:
      //   - sandbox ON     → 4xl (the sandbox form needs a 2nd column)
      //   - multi-repo     → 3xl (per-member row = name + Worktree/Repo
      //                      toggle + branch input — max-w-md overflows)
      //   - plain worktree → md (anything wider looks empty)
      // Import mode lists full worktree paths, which overflow max-w-lg —
      // give it more room (still narrower than the sandbox 2-column form).
      className={sandbox ? "max-w-4xl" : isMulti ? "max-w-3xl" : importMode ? "max-w-2xl" : "max-w-xl"}
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
        className={cn(
          "mt-1.5 gap-6",
          sandbox ? "grid grid-cols-2 gap-x-8" : "flex flex-col",
        )}
      >
      <div className="flex flex-col gap-6">
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
          <Field label="Existing worktree" hint="Worktrees of this repo that aren't already open as workspaces.">
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
          <Field label="Workspace type">
            <div className="flex flex-col gap-1.5">
              <div className="inline-flex self-start items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
                <button
                  type="button"
                  onClick={() => setMode("worktree")}
                  disabled={!!project?.non_git}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors disabled:opacity-40",
                    mode === "worktree"
                      ? "bg-[var(--color-accent-deep)] text-white"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  <GitBranch className="h-3.5 w-3.5" /> New worktree
                </button>
                <button
                  type="button"
                  onClick={() => setMode("repo_root")}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors",
                    mode === "repo_root"
                      ? "bg-[var(--color-warn)] text-black"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >
                  <Link2 className="h-3.5 w-3.5" /> Repo root
                </button>
              </div>
              <p className="text-[12px] text-[var(--color-fg-faint)]">
                {mode === "worktree"
                  ? "Isolated branch in its own working directory. Run agents in parallel without touching your checkout."
                  : "No worktree. The agent runs in the repo's live checkout, on its current branch. Edits land on your real files."}
              </p>
            </div>
          </Field>
        )}

        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="fix login bug" autoFocus required />
        </Field>

        <Field label="Default CLI" hint="Auto-launches on first open. You can spawn other agents anytime via the workspace's + button.">
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
                const proj = useApp.getState().projects.find(p => p.id === m.project_id);
                if (!proj) return null;
                const update = (patch: Partial<MemberSpec>) =>
                  setMembers(prev => prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                return (
                  <div
                    key={m.project_id}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-[var(--color-fg)]">{proj.name}</div>
                        <div className="truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{proj.root_path}</div>
                      </div>
                      <div className="inline-flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-[2px] text-[11.5px]">
                        <button
                          type="button"
                          onClick={() => update({ mode: "worktree" })}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-[4px] px-2 transition-colors",
                            m.mode === "worktree"
                              ? "bg-[var(--color-accent-deep)] text-white"
                              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                          )}
                        >
                          <GitBranch className="h-3 w-3" /> Worktree
                        </button>
                        <button
                          type="button"
                          onClick={() => update({ mode: "repo_root" })}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-[4px] px-2 transition-colors",
                            m.mode === "repo_root"
                              ? "bg-[var(--color-warn)] text-black"
                              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                          )}
                        >
                          <Link2 className="h-3 w-3" /> Repo root
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
                          placeholder={proj.base_branch || "branch from…"}
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
            creation - lists below freeze onto the workspace and can't be
            edited after (archive + recreate to change). */}
        {/* Sandbox is worktree-only here: workspace_open_repo (repo-root)
            takes no sandbox args, and multi keeps mode="worktree". */}
        {mode === "worktree" && (
        <Field label="Sandbox" hint="Cage the agent's filesystem + network access. Pinned at creation.">
          <SandboxModeSelector value={sandboxMode} onChange={setSandboxMode} osUnavailable={osSandboxOk === false} compact />
        </Field>
        )}
      </div>

      {/* Right column: sandbox config form, only when enabled.
          Otherwise the form is single-column and this branch renders
          nothing. */}
      {sandbox && (
        <div className="flex flex-col gap-3 border-l border-[var(--color-border-soft)] pl-6">
          <div className="text-[11.5px] uppercase tracking-[0.1em] text-[var(--color-fg-faint)]">
            Sandbox config for this workspace
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
          <Field label="Allowed paths" hint="One per line. Workspace + agent state + caches + TMPDIR are always allowed. Add extras here.">
            <textarea
              value={sbRw}
              onChange={e => setSbRw(e.target.value)}
              rows={3}
              placeholder={"$HOME/Work/other-project\n$HOME/Notes"}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
          </Field>
          <Field label="Allowed hosts" hint="One per line. Use * as a wildcard. Per-CLI vendor + github + npm/pypi/crates are always allowed; these are extras.">
            <textarea
              value={sbHosts}
              onChange={e => setSbHosts(e.target.value)}
              rows={3}
              placeholder={"*.mycompany.com\nbitbucket.org"}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
          </Field>
        </div>
      )}

      {/* Error + actions row spans both columns when sandbox is on. */}
      <div className={cn(sandbox && "col-span-2")}>
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

/** Progress view shown while creating a workspace. Three sub-states:
 *  - creating: worktree + file-copy in flight (workspace_create has not yet returned)
 *  - setup: setup script running; stream stdout/stderr line by line
 *  - done: success flash, dialog auto-closes 2s later
 *  - error: surfaces the failure + lets the user dismiss and try again
 */
function ProgressBody({ phase, err, setupLog, outputRef, onClose }: {
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
// — scripts are project-scoped, not workspace-scoped.
