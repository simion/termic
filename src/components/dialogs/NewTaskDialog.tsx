// New task dialog: name + CLI segmented pills + branch name +
// branch-from. Calls task_create on submit.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { usePr } from "@/store/pr";
import { AppDialog, dialogTitleAction } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { defaultCliFirst, visibleCliIds, isTerminalCli, agentDisplayName } from "@/lib/agents";
import { taskCreate, taskCreateMulti, settingsLoad, taskImportableWorktrees, taskImportWorktree, sandboxAvailable, taskOpenRepo, projectGitBranches, projectBranchContext, dockerImageStatus, type DockerImageStatus } from "@/lib/ipc";
import { launchSetupTab } from "@/lib/runTabs";
import { seedPromptWhenReady, SETUP_SPAWN_DEADLINE_MS } from "@/lib/seedPrompt";
import { deliverFirstMessage } from "@/lib/taskNotes";
import { MAX_PROMPT_CHARS } from "@/lib/deepLink";
import { Checkbox } from "@/components/ui/Checkbox";
import { withCreateLock } from "@/lib/createLock";
import { usePendingTasks } from "@/store/pendingTasks";
import { uniqueBranch, derivedBranch } from "@/lib/quickTask";
import { cn } from "@/lib/utils";
import { Check, Loader2, AlertTriangle, GitBranch, Link2, FolderGit2, Plus, CircleDot, History } from "lucide-react";
import { SandboxPicker, DockerEngineNote } from "@/components/SandboxPicker";
import { ListField } from "@/components/settings/Controls";
import { SANDBOX_PRESETS } from "@/lib/sandboxPresets";
import { selectionToFields, type MemberMode, type ImportableWorktree, type SandboxSelection, type ForgeIssue, type IssueLookup } from "@/lib/types";
import { projectForgeIssues } from "@/lib/ipc";
import { buildIssuePrompt, issueBranch, issueTaskName } from "@/lib/issuePrompt";
import { readMemberModes, persistMemberMode, seedMemberMode } from "@/components/dialogs/memberModes";
import { scoped } from "@/lib/profileScope";

const CLIS = ["claude", "codex", "agy", "grok", "opencode"] as const;

// Remember the user's last-used task type + sandbox mode across opens —
// most people always work one way (always worktree, always enforce), so
// re-deriving from project defaults every time fights their habit. Stored
// globally (not per-project): the choice is about how the user works, not the
// repo. Hard constraints still override at open time (non-git forces repo_root;
// an unsupported OS forces sandbox off).
const LS_LAST_MODE    = scoped("newTaskLastMode");
const LS_LAST_SANDBOX = scoped("newTaskLastSandboxMode");
function readLastMode(): "worktree" | "repo_root" | null {
  try { const v = localStorage.getItem(LS_LAST_MODE); return v === "worktree" || v === "repo_root" ? v : null; } catch { return null; }
}
function readLastSandbox(): SandboxSelection | null {
  try {
    const v = localStorage.getItem(LS_LAST_SANDBOX);
    return v === "off" || v === "monitor" || v === "enforce" || v === "enforce-fs" || v === "docker" ? v : null;
  } catch { return null; }
}
function persistLast(key: string, val: string) { try { localStorage.setItem(key, val); } catch {} }
// Branch names auto-fill as `<prefix>/<name>` where the prefix comes from
// the customizable `branchPrefix` pref (Settings → Tasks, default
// "feature"). The user edits the resulting field freely from there.

/** Fit a textarea to its content, capped by its CSS max-height (then it
 *  scrolls). Module scope: it touches no component state, so the callback
 *  ref that calls it needs no dependencies. */
function growPrompt(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function NewTaskDialog() {
  const projectId = useUI(s => s.newTaskProjectId);
  // Subscribed, not read imperatively: this is what makes a re-open (a second
  // deep link) re-run the reset effect below. Scalar, so an unrelated store
  // write can't re-render the dialog through it.
  const seedNonce = useUI(s => s.newTaskSeed?.nonce ?? 0);
  const close = useUI(s => s.closeNewTask);
  const pendingAdd = usePendingTasks(s => s.add);
  const pendingAppendLine = usePendingTasks(s => s.appendLine);
  const pendingFail = usePendingTasks(s => s.fail);
  const pendingRemove = usePendingTasks(s => s.remove);
  const project = useApp(s => projectId ? s.projects.find(p => p.id === projectId) : null);
  const setActive = useApp(s => s.setActiveTask);
  const setTaskGoal = useApp(s => s.setTaskGoal);
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
    // Project default first, same rule (and same reason) as the + menu's
    // launcher rows: the pill that is already selected on open should be the
    // one your eye lands on, wherever that agent sits in the registry.
    return defaultCliFirst(
      [...list.filter(a => visible.has(a.id)), SHELL_CHOICE],
      project?.default_cli,
    );
  })();

  const [name, setName] = useState("");
  const [cli, setCli] = useState<string>("claude");
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [base, setBase] = useState("");
  /** A deep-link `base=` this repo has no ref for; shown under the field. */
  const [baseUnknown, setBaseUnknown] = useState<string | null>(null);
  /** A deep-link `agent=` this install doesn't offer; shown under the picker. */
  const [agentUnknown, setAgentUnknown] = useState<string | null>(null);
  // Single-repo task shape: "worktree" (branch a fresh working dir) or
  // "repo_root" (no worktree — launch the agent in the repo's live checkout,
  // the same shape as the sidebar's "Run in repo with <agent>"). Main checkout
  // (repo_root) is the default (most people start there, reach for worktrees
  // later); repo_root hides the branch fields + sandbox panel and creates via
  // task_open_repo. Multi-repo honours it at the HOST level: repo_root opens
  // the host's live checkout with every member linked in (task_open_repo's
  // multi branch, the same shape the sidebar quick menu creates), while
  // worktree builds the wrapper + per-member toggles. Non-git projects force
  // repo_root (no branches).
  const [mode, setMode] = useState<"worktree" | "repo_root">("repo_root");
  // Flipping the toggle writes through to the shared `newTaskLastMode` key
  // right away (not just on submit), so the sidebar quick menu and this modal
  // always agree on the last choice. Opening the dialog (which also calls
  // setMode) must NOT persist, so that path uses setMode directly.
  const chooseMode = (m: "worktree" | "repo_root") => { setMode(m); persistLast(LS_LAST_MODE, m); };
  // Sandbox pin captured at creation. Defaults from project, can be
  // overridden for this one task, then is permanent post-create. One flat
  // SandboxSelection (off / Seatbelt's 3 modes / docker) rather than a
  // separate mode + engine - see SandboxPicker.tsx.
  const [selection, setSelection] = useState<SandboxSelection>("off");
  // Sandbox is macOS-only. On unsupported platforms, disable every
  // Seatbelt card except Off so we never save a mode that would only fail
  // later at spawn.
  const [osSandboxOk, setOsSandboxOk] = useState<boolean | null>(null);
  useEffect(() => { sandboxAvailable().then(setOsSandboxOk).catch(() => setOsSandboxOk(false)); }, []);
  useEffect(() => {
    if (osSandboxOk === false && selection !== "off" && selection !== "docker") setSelection("off");
  }, [osSandboxOk, selection]);
  const [dockerSettingsForNew, setDockerSettingsForNew] = useState<{ docker_sandbox_enabled?: boolean } | null>(null);
  const [dockerImageForNew, setDockerImageForNew] = useState<DockerImageStatus | null>(null);
  // Keyed on the OPEN signal, not mount-only. This dialog is rendered
  // unconditionally (Dialogs.tsx) and so never unmounts, so a mount-only
  // probe answered once per app launch: enable Docker and build the image in
  // Settings, come back here, and the Docker card stayed disabled for the
  // rest of the session with no way to refresh it. TaskSandboxDialog keys
  // the identical fetch on its own open signal for exactly this reason.
  useEffect(() => {
    if (!projectId) return;
    settingsLoad().then(setDockerSettingsForNew).catch(() => {});
    dockerImageStatus().then(setDockerImageForNew).catch(() => {});
  }, [projectId]);
  const dockerOffered = !!dockerSettingsForNew?.docker_sandbox_enabled && !!dockerImageForNew?.available;
  // Docker became unavailable (image rebuilt away, global switch flipped
  // off) while it was the picked selection - fall back rather than
  // silently creating a task pinned to a cage that can't actually launch.
  useEffect(() => {
    if (selection === "docker" && !dockerOffered) setSelection("off");
  }, [dockerOffered, selection]);
  const { mode: sandboxMode, docker: dockerWanted } = selectionToFields(selection);
  // The sandbox lists. Initialized from the
  // project's defaults whenever projectId changes; the user edits
  // freely until Create. Stored as multi-line text - we convert to
  // arrays at submit time. Using raw text in state lets the textareas
  // behave normally (blank lines while typing don't fight the split).
  const [sbRw,    setSbRw]    = useState("");
  const [sbHosts, setSbHosts] = useState("");
  // Docker's own per-task extra mounts (host_path:container_path). Seeded
  // from Settings.docker_default_extra_mounts, same lifecycle as sbRw/
  // sbHosts above; no per-project default exists for this one (Docker has
  // no project-level sandbox config the way Seatbelt does).
  const [dockerMounts, setDockerMounts] = useState("");
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
  // Bulk flip for compositions with many members. Non-git members are pinned
  // to repo_root (no branches, no worktree), so "all worktree" skips them.
  // Persists each git member's new mode, same write-through as the row toggle.
  const setAllMemberModes = (mode: MemberMode) => {
    setMembers(prev => prev.map(m => ({ ...m, mode: m.non_git ? "repo_root" : mode })));
    for (const m of members) {
      if (!m.non_git) persistMemberMode(m.root_path, mode);
    }
  };
  const isMulti = (project?.type ?? "single") === "multi";
  // A plain-folder project has no branches, so it can only run in place. That
  // is a SINGLE-repo rule: a multi-repo project whose HOST is a plain folder
  // still worktrees its members, because `task_create_multi` makes the
  // wrapper dir itself for a non-git host (symlinking the shared CLAUDE.md /
  // .claude into it) and each git member is worktreed under it exactly as
  // under a git host. Clamping those projects to the main checkout took the
  // whole per-member list away from them.
  const hostNonGit = !!project?.non_git;
  const canWorktree = isMulti || !hostNonGit;
  // Sandbox is offered in every shape: the seatbelt + proxy cage the main
  // checkout identically to a worktree (task_open_repo takes sandbox args,
  // for single AND multi hosts), and the multi wrapper carries its own.
  const canSandbox = true;
  // Derived: Seatbelt cage on (Docker is its own separate flag below).
  // Drives the 2-column layout + "send lists" gating.
  const sandbox = !dockerWanted && sandboxMode !== "off" && canSandbox;
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
  // Issue mode: seed the task from a GitHub issue / GitLab issue. Same shape
  // as import mode (a picker replacing the name+branch fields), but it is
  // orthogonal to worktree-vs-main-checkout - picking an issue only prefills
  // the name and branch and arms the prompt. Loading is deferred to the
  // moment the user asks for it: this is a network call through gh/glab, and
  // most New Task opens have nothing to do with issues.
  const canIssues = !isMulti && !project?.non_git;
  const [issueMode, setIssueMode] = useState(false);
  const [issueLookup, setIssueLookup] = useState<IssueLookup | null>(null);
  const [issueLoading, setIssueLoading] = useState(false);
  const [issueSelected, setIssueSelected] = useState<ForgeIssue | null>(null);
  const [issueQuery, setIssueQuery] = useState("");
  // Resume-args override, set at create so it applies from the FIRST spawn.
  // Exactly the field the task menu's "Resume override" edits
  // (Task.resume_override, task_set_resume_override): same storage, same
  // placeholder expansion, same "the agent owns a missing session" stance.
  //
  // It replaced a "Resume session ID" box that only accepted a bare uuid and
  // only appeared for agents declaring `resume_id_args` (claude, opencode,
  // copilot). Codex, gemini and agy resume with `--continue` / `resume
  // --last`, which take no id, so those agents got no field at all even
  // though raw resume args work fine for them (GH #169).
  const [resumeOverride, setResumeOverride] = useState("");
  // Optional first message, typed into the agent once it finishes booting
  // (GH #192). Blank by default and blank for every existing entry point —
  // this exists so a `termic://` link can arrive with a summarized ticket
  // already in the box, and so the user SEES that text and can edit or
  // clear it before anything is created. Never auto-submitted from the
  // link: the Create button is the confirmation.
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // "Start later": write the box down as the task's GOAL instead of typing it
  // at the agent. Everything else about create is unchanged, worktree and
  // agent spawn included; the only difference is that nothing is sent, so
  // nothing stamps `started_at` and the task stays Todo with a record of what
  // it is for. Before this there was no way to write down what a task was for
  // without starting it, because the prompt box was the only place to type.
  //
  // Unchecked by default and reset on every open (see the reset effect below,
  // which is the only thing that resets it: this dialog is permanently mounted
  // from Dialogs.tsx). A sticky one would quietly stop starting tasks.
  const [startLater, setStartLater] = useState(false);
  // Agents that can't take a typed first message (a plain shell has no
  // prompt box to type into) hide the field rather than silently dropping
  // the text at create time.
  const canPrompt = cli !== "shell" && !isTerminalCli(cli);
  const agentLabel = agentDisplayName(cli);
  // Auto-grow to fit the content, capped by max-height (then it scrolls).
  //
  // Growing has to happen on ATTACH, not only when `prompt` changes, which
  // is why the ref below is a callback. The field is conditionally rendered
  // (`canPrompt`), so a seeded open sets the prompt in the same commit that
  // first mounts the textarea: the effect runs with `promptRef.current`
  // still null, and by the time the node exists `prompt` has not changed
  // again, so nothing ever grows it. A deep link's prompt then sat in a
  // one-row box (GH #192) and only sprang open once the user typed into it.
  // The effect still covers typing, where the node is already attached.
  const attachPrompt = useCallback((el: HTMLTextAreaElement | null) => {
    promptRef.current = el;
    growPrompt(el);
  }, []);
  useEffect(() => { growPrompt(promptRef.current); }, [prompt]);
  // A plain shell or a registry terminal entry (docker, ssh) has no agent
  // session to resume, so there is nothing for an override to replace. Every
  // real agent takes resume args, whether or not it can address a session by
  // id, which is the whole point of this being an args override.
  const canResumeOverride = cli !== "shell" && !isTerminalCli(cli);
  /** The override as sent to Rust: capability-gated, trimmed, blank → unset. */
  const resumeOverrideArg = () =>
    canResumeOverride ? resumeOverride.trim() || undefined : undefined;
  // Collapsed by default: a label + hint + input is three lines of a form
  // that already scrolls, spent on something almost nobody sets at create
  // time (the task menu edits it afterwards for the rest). Expanded state is
  // per-open, not remembered: typing a value keeps it visible on its own.
  const [resumeOpen, setResumeOpen] = useState(false);
  // Same copy as ResumeOverrideDialog, trimmed to one line: this one is a
  // field in a long form, not a dialog whose whole subject is the override.
  const resumeOverrideField = resumeOpen ? (
    <Field
      label="Resume args override (optional)"
      hint={`Replaces ${agentLabel}'s default resume arguments. {WORKSPACE_NAME}, {WORKSPACE_SLUG} and {BRANCH} expand at launch. Editable later from the task menu.`}
    >
      <Input
        value={resumeOverride}
        onChange={e => setResumeOverride(e.target.value)}
        placeholder="--resume {WORKSPACE_NAME}"
        className="font-mono"
        autoFocus
      />
    </Field>
  ) : (
    <button
      type="button"
      data-testid="resume-override-toggle"
      onClick={() => setResumeOpen(true)}
      className="-mb-1 inline-flex items-center gap-1.5 self-start text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-accent)]"
    >
      <History className="h-3.5 w-3.5" />
      Override resume args
    </button>
  );
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

  // Reset the form ONLY when the dialog opens for a different project —
  // never on re-fetches of the same project's data. Window-focus events fire
  // `loadAll()` (App.tsx) which replaces the projects array → `project`
  // object identity changes → an effect depending on `project` would wipe
  // every field the user just typed. Depending on `projectId` (a stable
  // string) avoids that. We seed CLI/base from the project but read them
  // imperatively at effect-time via getState so we don't need them in deps.
  //
  // `seedNonce` is the second key: a deep link arriving while the dialog is
  // ALREADY open for the same project changes no other dependency, so without
  // it the window would raise onto the previous link's name and prompt (GH
  // #192). It is bumped by `openNewTask` itself, so it can only change on an
  // explicit open — never on the `loadAll()` refetches this effect must
  // ignore.
  useEffect(() => {
    if (!projectId) return;
    const p = useApp.getState().projects.find(x => x.id === projectId);
    // Seed (from openNewTask's optional 2nd arg): used by the
    // "Duplicate task" flow to pre-fill `base` with the source
    // task's branch tip + optionally seed a name prefix.
    const seed = useUI.getState().newTaskSeed;
    const seededName = seed?.namePrefix ?? "";
    setName(seededName);
    // Seed the branch HERE, in the same pass as the name, rather than
    // blanking it and leaving the job to the derive effect below. A deep
    // link arrives with the name already filled, so the user is looking at
    // a populated Name and an empty "Branch name" until they touch the
    // Name field, which is the one thing a link is supposed to save them
    // (GH #192 follow-up). `existingBranches` is empty at this point; the
    // derive effect still runs when the repo's branch list lands and bumps
    // the suffix if this one collides (#129).
    // Read imperatively, like the CLI/base seeds above: the effect must not
    // re-run (and re-blank the form) just because the prefix pref changed.
    setBranch(derivedBranch(seededName, usePrefs.getState().branchPrefix));
    setBranchEdited(false); setErr(null);
    setBase(seed?.baseBranch ?? p?.base_branch ?? "");
    // A LINK-supplied base is the one nobody can see before pressing Create:
    // a typo'd `base=` used to surface as a git error at create time, several
    // seconds later and with no hint that the URL caused it. So check it here
    // and say so next to the field.
    //
    // A warning, not a refusal, and not a blocked Create: create fetches the
    // base ref first (`git_fetch_base`), so a branch that exists only on the
    // remote and has never been fetched locally is legitimate — refusing it
    // would break links that work.
    setBaseUnknown(null);
    const seededBase = seed?.baseBranch;
    if (seededBase) {
      projectBranchContext(projectId)
        .then(ctx => {
          if (useUI.getState().newTaskProjectId !== projectId) return;
          const known = [...ctx.local, ...ctx.remote];
          if (!known.includes(seededBase)) setBaseUnknown(seededBase);
        })
        .catch(() => { /* no branch list ⇒ nothing to contradict */ });
    }
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
    //   0. an explicitly seeded agent (deep link) — but only if this
    //      install actually offers it, so a link naming an agent the user
    //      doesn't have falls through to the normal pick instead of
    //      selecting a pill that isn't there.
    const seededAgent =
      seed?.agent && list.some(a => !a.disabled && a.id === seed.agent) ? seed.agent
      : seed?.agent === "shell" ? "shell"
      : null;
    const projectDefault = p?.default_cli || "";
    setAgentUnknown(seed?.agent && !seededAgent ? seed.agent : null);
    if (seededAgent) {
      setCli(seededAgent);
    } else if (projectDefault && isUsable(projectDefault)) {
      setCli(projectDefault);
    } else {
      const firstInstalled = list.find(a => !a.disabled && isInstalled(a.id))?.id;
      setCli(firstInstalled ?? "shell");
    }
    // Sandbox toggle defaults to project's preference OR the global
    // default (Settings → Sandbox). Either being true checks the box.
    // The user can still flip for THIS task - but once Create
    // fires, the pin is permanent on the Task record. The
    // three lists are seeded from the project's defaults; user
    // edits in this dialog land on the task ONLY, never on
    // the project.
    // Last-used SELECTION wins (the user's habit, now including Docker);
    // fall back to the project's Seatbelt-only default, then the app-wide
    // default (Settings → Sandbox), only before they've ever picked one.
    const projectDefaultSandbox: SandboxSelection | null =
      p?.default_sandbox_mode ?? (p?.default_sandbox ? "enforce" : null);
    const globalDefault = usePrefs.getState().globalDefaultSandboxKind;
    setSelection(readLastSandbox() ?? projectDefaultSandbox ?? globalDefault);
    // Seed with project's lists immediately; once Settings loads,
    // merge global defaults on top (dedupe-preserving order).
    setSbRw((p?.sandbox_rw_paths ?? []).join("\n"));
    setSbHosts((p?.sandbox_allowed_hosts ?? []).join("\n"));
    setDockerMounts("");
    // Seed the per-member spec (multi-repo only). Each git member starts
    // on its last-used mode (remembered per root_path, like the single-repo
    // dialog remembers its toggle) and falls back to Worktree — the simplest
    // + safest default. Non-git members can't be worktreed (no branches), so
    // they force repo_root, same rule as a non-git single project / host.
    if ((p?.type ?? "single") === "multi") {
      const remembered = readMemberModes();
      const seeded: MemberSpec[] = (p?.members ?? []).map(pm => ({
        root_path: pm.root_path,
        name: pm.name,
        non_git: !!pm.non_git,
        mode: seedMemberMode(!!pm.non_git, remembered, pm.root_path) as MemberMode,
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
      setDockerMounts(merge(s.docker_default_extra_mounts));
    }).catch(() => {});
    // Import mode: off by default. We eager-load the project's existing
    // unopened worktrees so the "Import a worktree"
    // affordance only appears when there's actually something to import.
    const canImp = (p?.type ?? "single") !== "multi" && !p?.non_git;
    const wantImport = !!seed?.importMode && canImp;
    setImportSelected(null); setImportList([]); setImportLoading(false);
    setResumeOverride(""); setResumeOpen(false);
    setPrompt(seed?.prompt ?? "");
    setStartLater(false);
    setImportMode(wantImport);
    // Issue mode is per-OPEN, like import mode beside it. It was left out of
    // this reset, so picking issue #42 in project A and cancelling meant the
    // next open - for a DIFFERENT project - still showed project A's issue
    // list, and creating from it seeded the agent with project A's issue.
    setIssueMode(false);
    setIssueSelected(null);
    setIssueLookup(null);
    // A seed can ask to open straight into the issue picker (the palette's
    // "New task from an issue…" row routes through the project picker and
    // arrives here). Only where issues are a thing at all - `canImp` is the
    // same single-repo-git test `canIssues` uses. This runs after the resets
    // above, so it wins; a seed carrying both modes lands on issues, which is
    // the more specific of the two.
    if (seed?.issueMode && canImp) enterIssues();
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
    // A seeded mode (deep link) outranks the remembered choice — the link
    // asked for a specific shape. The non-git clamp still wins over both;
    // parseDeepLink rejects `worktree` on a non-git project up front, so
    // this only ever catches a project that lost its git dir since.
    // Same rule as `canWorktree` above, computed off the effect's own project.
    const clamped = !!p?.non_git && (p?.type ?? "single") !== "multi";
    setMode(clamped ? "repo_root" : (seed?.mode ?? readLastMode() ?? "repo_root"));
    if (canImp) loadImportable(projectId);
    setBusy(false);
    submittingRef.current = false;
  }, [projectId, seedNonce]);

  // Tauri event unlisten handles. Owned by submit() (which registers them
  // imperatively BEFORE invoking taskCreate — guaranteed ordering vs
  // the old useEffect-based subscription that races against fast/empty
  // setup scripts). Cleaned up on unmount + before each new submission.
  const unlistenRef = useRef<Array<() => void>>([]);
  useEffect(() => () => {
    for (const u of unlistenRef.current) u();
    unlistenRef.current = [];
  }, []);

  // Branch auto-fills from the name, but ONLY until the user touches the
  // branch field — after that it's theirs and we never clobber it (#15:
  // no more fighting a prefix you didn't want). Default shape is
  // `feature/<name>`, fully editable. A name that's already a qualified
  // branch (contains a "/", e.g. a Linear "username/my-feature" pasted
  // straight in) is taken verbatim with no prefix.
  const derived = useMemo(
    () => uniqueBranch(derivedBranch(name, branchPrefix), existingBranches),
    [name, branchPrefix, existingBranches],
  );
  // The name is real but derives no branch at all: every character of it is
  // outside a-z0-9-_ (an all-punctuation name, or a non-Latin script, which
  // `slugify` folds out because the slug is a path segment as well as a ref).
  // Only when the user has not typed their own branch — theirs is theirs.
  const nameSlugsAway = !!name.trim() && !derived && !branchEdited;
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

  // What happens to the prompt box, if the user left one AND the chosen agent
  // can take one: typed into the task's default tab once its agent finishes
  // booting (lib/seedPrompt), or, with "Start later" ticked, written down as
  // the task's goal and not sent at all. Best-effort either way, so a create
  // never fails over a prompt.
  function seedFirstMessage(taskId: string) {
    // There used to be a second seeder beside this one that composed and sent
    // the issue prompt itself, which meant an issue task's first message was
    // never shown to the user before it went out. Picking an issue now fills
    // THIS box instead (pickIssue), so there is one seeder, the user sees the
    // prompt, and they can edit or clear it before Create.
    //
    // SETUP_SPAWN_DEADLINE_MS, not the default: the issue seeder used the long
    // one because a task can sit behind a setup script before its PTY ever
    // spawns. That was never specific to issues - a typed first message on a
    // repo with a slow setup script hit the same wall and vanished - so the
    // patient deadline now covers both.
    //
    // Which of the two things happens to the text is `deliverFirstMessage`'s
    // call (lib/taskNotes, unit-tested), not this component's: all three
    // create paths funnel through here, so the branch lives in one place and
    // is assertable without rendering a dialog.
    deliverFirstMessage(
      taskId,
      { prompt, canPrompt, startLater },
      {
        seed: (id, text) => seedPromptWhenReady(id, text, SETUP_SPAWN_DEADLINE_MS),
        setGoal: (id, text) => setTaskGoal(id, text),
      },
    );
  }

  // Adopt an existing worktree. No worktree-add / file-copy / setup
  // script, so this skips the streaming phases entirely.
  /** Flip into issue mode and fetch. Re-fetches on every entry so a freshly
   *  filed issue shows up without reopening the dialog. */
  function enterIssues() {
    setIssueMode(true);
    setImportMode(false);
    setErr(null);
    if (!projectId) return;
    setIssueLoading(true);
    projectForgeIssues(projectId, 50)
      .then(setIssueLookup)
      .catch(e => setIssueLookup({
        provider: null, remote_url: "", status: "error", message: String(e), issues: [],
      }))
      .finally(() => setIssueLoading(false));
  }

  // Resolve the project's forge up front. Backed by a cached, network-free
  // command, so this costs one `git remote get-url` per repo per 5 minutes
  // and gates whether the issue affordance exists at all: a repo on
  // Bitbucket, a plain SSH host, or no remote shows nothing.
  useEffect(() => {
    if (projectId) void usePr.getState().resolveProvider(projectId);
  }, [projectId]);
  const forgeProvider = usePr(s => (projectId ? s.providerByProject[projectId] ?? null : null));
  const forges = usePr(s => s.forges);
  const forgeCli = forgeProvider === "gitlab" ? "glab" : "gh";
  const forgeCliReady = !!forges?.find(f => f.provider === forgeProvider)?.authed;

  // Client-side filter over the already-fetched list: no extra round-trip
  // for typing, and 50 issues is small enough to scan in the renderer.
  const visibleIssues = useMemo(() => {
    const all = issueLookup?.issues ?? [];
    const q = issueQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(i =>
      String(i.number).includes(q) ||
      i.title.toLowerCase().includes(q) ||
      i.labels.some(l => l.toLowerCase().includes(q)),
    );
  }, [issueLookup, issueQuery]);

  function exitIssues() {
    setIssueMode(false);
    // Drop the composed prompt with it. The name and branch survive because
    // they are just text the user may well want to keep; a first message that
    // opens "GitHub issue #266:" is actively wrong on a task that is no longer
    // about that issue, and "blank task instead" says what it clears.
    if (issueSelected) setPrompt("");
    setIssueSelected(null);
    setErr(null);
  }

  /** Picking an issue fills the name, the branch and the first message, all
   *  three still editable. The prompt is composed into the visible box rather
   *  than sent behind the user's back at create time: the box is the preview,
   *  and an issue nearly always needs a sentence of steering added to it.
   *
   *  It does NOT force worktree mode: an issue task in the main checkout is a
   *  legitimate thing to want, and silently switching the mode under the user
   *  would be worse than letting them choose. */
  function pickIssue(issue: ForgeIssue) {
    setIssueSelected(issue);
    setName(issueTaskName(issue));
    setBranch(uniqueBranch(issueBranch(issue, branchPrefix), existingBranches));
    setBranchEdited(false);
    // Budgeted so the composed prompt fits what the box will actually send.
    // Overwrites whatever is in there - same as the name and branch beside it,
    // and picking a second issue has to replace the first one's prompt or the
    // agent gets handed two.
    setPrompt(buildIssuePrompt(issue, MAX_PROMPT_CHARS));
    setErr(null);
  }

  async function submitImport() {
    if (!projectId || !importSelected || !name.trim()) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true); setErr(null);
    try {
      const splitLines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
      const w = await withCreateLock(() => taskImportWorktree(
        projectId, importSelected, name.trim(), cli,
        {
          enabled: sandbox, mode: sandboxMode, rwPaths: splitLines(sbRw), allowedHosts: splitLines(sbHosts),
          docker: dockerWanted, dockerExtraMounts: dockerWanted ? splitLines(dockerMounts) : undefined,
        },
        undefined, // no externally-started session id from this dialog
        // Gated on capability, not just field state: the input hides when
        // the agent switches to one with nothing to resume, but the typed
        // value would otherwise still ride along.
        resumeOverrideArg(),
      ));
      await loadAll();
      setActive(w.id);
      seedFirstMessage(w.id);
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
      // Serialized behind the app-wide create lock, same as every
      // other create path (createLock.ts).
      const w = await withCreateLock(() => taskOpenRepo(
        projectId, cli, name.trim(),
        {
          enabled: sandbox, mode: sandboxMode, rwPaths: splitLines(sbRw), allowedHosts: splitLines(sbHosts),
          docker: dockerWanted, dockerExtraMounts: dockerWanted ? splitLines(dockerMounts) : undefined,
        },
        undefined,
        undefined, // no externally-started session id from this dialog
        resumeOverrideArg(),
      ));
      await loadAll();
      setActive(w.id);
      seedFirstMessage(w.id);
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  }

  async function submit() {
    // Remember how the user works for next time. The task type is the
    // host-level shape for multi too (members keep their own per-row memory);
    // sandbox mode is remembered whenever a create can carry one.
    persistLast(LS_LAST_MODE, mode);
    // Sandbox can now ride on a single-repo main-checkout create too, so
    // remember the mode whenever a create can carry one (i.e. always here).
    persistLast(LS_LAST_SANDBOX, selection);
    // Import wins over the task-type mode: adopting a worktree is orthogonal
    // to worktree-vs-main-checkout, and the dialog can now open straight into
    // import mode from the launcher menu while `mode` is still repo_root
    // (the remembered default). Checking repo_root first would silently open
    // the main checkout instead of importing the picked worktree.
    if (importMode) { submitImport(); return; }
    // Main checkout, single or multi: task_open_repo opens the live checkout
    // (for multi, with every member linked into the host). This is the SAME
    // task the sidebar quick menu's Main checkout creates, so the two entry
    // points can't drift into different task shapes.
    if (mode === "repo_root") { submitRepoRoot(); return; }
    if (!projectId || !name.trim() || !branch.trim()) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    const taskId = crypto.randomUUID();
    // Worktree path: the id is pre-generated, so the seeder can start
    // polling for the agent immediately and simply waits out the setup
    // script (hence the longer deadline).
    // Clean up any prior unlisteners from a previous (errored) submission
    // before registering new ones.
    for (const u of unlistenRef.current) u();
    unlistenRef.current = [];
    // Register the progress listener BEFORE invoking taskCreate/
    // taskCreateMulti — `await listen()` returns once the Tauri backend has
    // confirmed the subscription, so no line emitted the instant the Rust
    // side starts running can race past an unmounted listener (the same
    // ordering guarantee the old setup-output subscription relied on).
    // Both create paths emit onto this ONE channel now (worktree add, file
    // copy, port allocation — see emit_create_progress in lib.rs — and,
    // for single-repo, the setup script that follows via launchSetupTab
    // below), so the pending pane's log is the whole creation timeline
    // with no second event name to wire up.
    const uOut = await listen<{ line: string }>(`setup-output://${taskId}`, ev => {
      pendingAppendLine(taskId, ev.payload.line);
    });
    unlistenRef.current = [uOut];
    // Represent the in-flight task in the sidebar + main pane right away —
    // this IS the fix for GH #242 (worktree creation no longer locks the
    // whole window behind a modal). The dialog closes on the next line;
    // CreatingTaskPane (MainArea) and PendingTaskRow (Sidebar) take over.
    pendingAdd({ id: taskId, projectId, name: name.trim(), cli });
    setActive(taskId);
    close();
    try {
      // Snap textareas → string[]. Done at submit so blank lines
      // during typing don't roundtrip through the array state.
      const splitLines = (s: string) =>
        s.split("\n").map(l => l.trim()).filter(Boolean);
      if (isMulti) {
        await withCreateLock(() => taskCreateMulti({
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
          docker_sandbox_enabled: dockerWanted,
          docker_extra_mounts:    dockerWanted ? splitLines(dockerMounts) : undefined,
          resume_override: resumeOverrideArg(),
        }));
      } else {
        await withCreateLock(() => taskCreate({
          id: taskId,
          project_id: projectId,
          name: name.trim(),
          cli,
          base_branch: base.trim() || null,
          branch: branch.trim(),
          // Capability-gated like import: the field hides when the agent has
          // nothing to resume, but typed state would otherwise ride along.
          resume_override: resumeOverrideArg(),
          sandbox_enabled: sandbox,
          sandbox_mode: sandboxMode,
          // Only send lists when sandbox is on - keeps the JSON tidy
          // for unsandboxed tasks (they don't need these saved).
          sandbox_rw_paths:       sandbox ? splitLines(sbRw)    : undefined,
          sandbox_allowed_hosts:  sandbox ? splitLines(sbHosts) : undefined,
          docker_sandbox_enabled: dockerWanted,
          docker_extra_mounts:    dockerWanted ? splitLines(dockerMounts) : undefined,
        }));
      }
      await loadAll();
      // The real task now exists — MainArea/Sidebar prefer it over the
      // pending entry the moment `tasks` carries it, so drop the pending
      // entry here rather than leaving a stale duplicate row behind.
      pendingRemove(taskId);
      seedFirstMessage(taskId);
      // Single-repo worktree: no blocking "running setup…" phase — if the
      // project has a setup script, it fires right after as an unfocused
      // background tab (ensureDefaultTab excludes setup-kind tabs from its
      // "already mounted" check, so the two can't race each other out).
      // Multi-repo's member setup scripts already run this way from the
      // Rust side (task_create_multi_sync spawns them in a background
      // thread and returns immediately — see setup-output/-done emits
      // there), so both paths land the user on a live task with the same
      // "agent gets focus now, setup streams in its own tab" shape.
      if (!isMulti) launchSetupTab(taskId, { focus: false }).catch(() => {});
    } catch (e) {
      // Worktree/branch creation itself failed. Leave the pending entry in
      // place (now in "error" phase) so the sidebar row and, if the user is
      // still looking at it, the main pane surface exactly what failed —
      // no separate toast, no reopening a dialog.
      pendingFail(taskId, String(e));
    } finally {
      submittingRef.current = false;
    }
  }

  return (
    <AppDialog
      // Locked only while busy — which, since GH #242, is just the brief
      // window an instant import/repo-root create is actually in flight
      // (worktree/multi creates close the dialog immediately; see submit()).
      open={!!projectId}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title={isMulti ? (mode === "repo_root" ? "New multi-repo task in the main checkout" : "New multi-repo task") : importMode ? "Import existing worktree" : mode === "repo_root" ? "New task in the main checkout" : "New task in a worktree"}
      description={undefined}
      // The four mode switches ride the title line rather than each taking a
      // `gap-4` form row. They are chrome - "make this a different KIND of
      // task" - not fields, and the one that shows most often was costing a
      // whole row on every open of a dialog that usually has nothing to do
      // with issues. Labels are short because worktree mode can show two of
      // them at once; the row wraps if a title ever leaves no space.
      titleAction={
        <>
          {/* Import (issue #5): adopt a worktree that already exists on disk
              instead of branching a fresh one. Only offered when there is
              actually something to adopt, hence the count. */}
          {canImport && !importMode && mode === "worktree" && importList.length > 0 && (
            <button type="button" onClick={enterImport} {...dialogTitleAction}>
              <FolderGit2 className="h-3.5 w-3.5" />
              Import a worktree
              <span className="text-[var(--color-fg-faint)]">({importList.length})</span>
            </button>
          )}
          {/* Start from an issue. Only for repos actually hosted on a forge
              (the #21/#22 tooling is CLI-backed, so it is real only where
              gh/glab can reach). Doubles as the discovery point for the CLIs:
              a GitHub repo whose owner has never installed gh still sees the
              entry and learns what it would buy them. */}
          {canIssues && forgeProvider && !issueMode && !importMode && (
            <button type="button" onClick={enterIssues} {...dialogTitleAction}>
              <CircleDot className="h-3.5 w-3.5" />
              From a {forgeProvider === "gitlab" ? "GitLab" : "GitHub"} issue
              {!forgeCliReady && (
                <span className="text-[var(--color-fg-faint)]">(needs {forgeCli})</span>
              )}
            </button>
          )}
          {canIssues && issueMode && (
            <button type="button" onClick={exitIssues} {...dialogTitleAction}>
              <Plus className="h-3.5 w-3.5" />
              Blank task instead
            </button>
          )}
          {canImport && importMode && (
            <button
              type="button"
              onClick={() => { setImportMode(false); setImportSelected(null); setResumeOverride(""); setResumeOpen(false); setErr(null); }}
              {...dialogTitleAction}
            >
              <Plus className="h-3.5 w-3.5" />
              New worktree instead
            </button>
          )}
        </>
      }
      // Widen the dialog to fit what's inside. Base width per mode (xl 36rem /
      // 2xl 42rem / 3xl 48rem) sizes the single-column form. Each extra column
      // (sandbox config, issue picker) is equal (flex-1) plus a 2rem (ml-8)
      // gutter, so N columns is N*base - (N-1)*0.5rem (content = N*(base-2.5)
      // + (N-1)*2rem gutter, + 2.5rem padding). Everything is in REM so,
      // whatever the root font-size (14px here), each flex-1 column resolves to
      // the SAME width as the single-column form — the left never changes, only
      // columns are added.
      //
      // Only the literals below exist; a computed `max-w-[${n}rem]` would not
      // survive Tailwind's source scan. The three-column case is only ever
      // 36rem-based: issue mode is single-repo-git only (no 3xl) and turns
      // import mode off (no 2xl), so 3*36 - 1 = 107rem is the one width it
      // needs. That is wider than most screens, which is fine — max-width, so
      // it shrinks, exactly as the 95.5rem multi+sandbox case already does.
      className={
        issueMode && sandbox
          ? "max-w-[107rem]"
          : issueMode || sandbox
            ? (isMulti ? "max-w-[95.5rem]" : importMode ? "max-w-[83.5rem]" : "max-w-[71.5rem]")
            : (isMulti ? "max-w-3xl" : importMode ? "max-w-2xl" : "max-w-xl")
      }
      // A long worktree form (sandbox panel, multi-repo members, …) can
      // exceed the viewport — pin Cancel/Create to the bottom instead of
      // letting them scroll away with the fields (the user has to be able
      // to see and press Create without scrolling to find it).
      stickyFooter={
        <>
          {err && <p className="mb-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form="new-task-form"
              disabled={busy || !name.trim() || (mode === "repo_root" ? false : importMode ? !importSelected : !branch.trim())}
            >
              {importMode ? "Import" : "Create"}
            </Button>
          </div>
        </>
      }
    >
      <form
        id="new-task-form"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="mt-1.5 flex flex-col gap-4"
      >
      {/* Columns row: the left form, then up to two more columns — the issue
          picker when starting from an issue, the sandbox config when a cage is
          enabled. Left is flex-1 (can't overflow); so is every added column,
          and the dialog max-width (above) is sized in REM so each column
          resolves to the SAME width whichever of them are showing.

          Issues sit BEFORE sandbox because picking one writes into the form
          beside it (name, branch, prompt), so the two want to be adjacent;
          the cage is set-and-forget. */}
      <div className="flex">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        {/* Every field uses the same structure: label on its own line, optional
            hint underneath, control on a new line. Previous version inlined
            the segmented controls next to the label and put hints on the same
            line as the label — both caused the spacing weirdness + wrapped
            hint text. */}
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

        {/* Worktree vs repo-root toggle. Repo root hides the branch fields
            (and, for multi, the per-member list: every member runs live) and
            creates in the repo's live checkout. Non-git projects can't
            worktree, so the Worktree button is disabled there. */}
        {!importMode && (
          <div className="flex flex-col gap-1.5">
            {/* Label + toggle share one row (not label-above-control like
                every other Field) — this is the field people re-adjust most
                often, so it's the one worth the extra vertical inch back. */}
            <div className="flex items-center justify-between gap-3">
              <label className="text-[13px] font-medium text-[var(--color-fg)]">Task type</label>
              <div className="inline-flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
                <button
                  type="button"
                  data-testid="task-type-main"
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
                  data-testid="task-type-worktree"
                  onClick={() => chooseMode("worktree")}
                  disabled={!canWorktree}
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
            </div>
            <p className="text-[12px] text-[var(--color-fg-faint)]">
              {mode === "worktree"
                ? (isMulti
                    ? "Branch every member into its own working directory, run agents in parallel."
                    : "Isolated branch in its own working directory. Run agents in parallel without touching your main checkout.")
                : (isMulti
                    ? "No worktrees, nothing copied. The agent runs in the host's live checkout with every member linked in. Edits land on your real files."
                    : "No worktree. The agent runs in the repo's main checkout, on its current branch. Edits land on your real files.")}
            </p>
          </div>
        )}

        {/* Name + branch fields grouped tightly (gap-2, vs. gap-4 between
            fields elsewhere): the branch is DERIVED from the name (see
            `derived` above), so they read as one cluster rather than three
            unrelated questions. Default CLI (a real question, unrelated to
            naming) follows as its own field, not folded into this group. */}
        <div className="flex flex-col gap-2">
          <Field label="Name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="fix login bug" autoFocus required />
          </Field>

          {!importMode && mode === "worktree" && (<>
          {/* Always editable. Auto-fills as “feature/<name>” while you type
              the name, then stops the moment you touch it, so pasting a
              branch from Linear (“username/my-feature”) is a true one-shot:
              select all, paste, done. No prefix control to fight (#15). */}
          <FieldInline label="Branch name" hint="Auto-fills from the name.">
            <div className="flex flex-col gap-1">
              <Input
                value={branch}
                onChange={e => { setBranch(e.target.value); setBranchEdited(true); }}
                placeholder="feature/fix-login-bug"
                required
              />
              {/* A name with nothing a branch can be made of. Create is already
                  disabled on an empty branch, but a dead button explains
                  nothing: the name looks perfectly good to the person who
                  typed it. Same sentence the CLI and quick-create give, at the
                  field that is actually empty. */}
              {nameSlugsAway && (
                <p data-testid="name-unslugabble" className="text-[11.5px] text-[var(--color-warn)]">
                  Task name must contain at least one letter or number. Branch names are a-z, 0-9, dash and underscore, so "{name.trim()}" leaves nothing to build one from. Type a branch name here to use it anyway.
                </p>
              )}
            </div>
          </FieldInline>

          {/* The multi-repo host variant's hint is a full sentence (members
              fall back separately) — too long for FieldInline's one line,
              so it keeps Field's stacked layout. */}
          {isMulti ? (
            // A plain-folder host has no branches to cut from; the members
            // still do, and they carry their own defaults in the list below.
            hostNonGit ? null : (
            <Field label="Host branch from" hint="Blank = host repo default. Members fall back to their own defaults below.">
              <Input
                value={base}
                onChange={e => { setBase(e.target.value); setBaseUnknown(null); }}
                placeholder="origin/master"
              />
            </Field>
            )
          ) : (
            <FieldInline label="Branch from" hint="Blank = repo default.">
              <div className="flex flex-col gap-1">
                <Input
                  value={base}
                  // Typing here is the user taking ownership of the field, so
                  // the link's warning stops applying.
                  onChange={e => { setBase(e.target.value); setBaseUnknown(null); }}
                  placeholder="origin/master"
                />
                {baseUnknown && base === baseUnknown && (
                  <p data-testid="base-unknown" className="text-[11.5px] text-[var(--color-warn)]">
                    This link asked to branch from "{baseUnknown}", which this repo has no ref for. Creating will only work if it exists on the remote.
                  </p>
                )}
              </div>
            </FieldInline>
          )}
          </>)}
        </div>

        <Field label="Default CLI">
          {/* Pulled from the editable agent registry (Settings → Agent
              CLIs), not hard-coded — custom agents show up here. Disabled
              and not-installed agents are filtered out (see cliChoices).
              "Terminal" (cli="shell") is appended as a no-agent fallback. */}
          <div className="inline-flex flex-wrap items-stretch gap-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
            {cliChoices.map(a => (
              <button
                // Picking one yourself answers the warning, so it goes.
                key={a.id} type="button" onClick={() => { setCli(a.id); setAgentUnknown(null); }}
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
          {/* Same deal as the base warning below: a link naming an agent this
              install doesn't offer falls back to the normal pick, which is
              right, but doing it silently means the user creates a task with
              a different agent than the link asked for and never learns why. */}
          {agentUnknown && (
            <p data-testid="agent-unknown" className="mt-1 text-[11.5px] text-[var(--color-warn)]">
              This link asked for "{agentUnknown}", which isn't available here. Using {cliChoices.find(a => a.id === cli)?.display_name ?? cli} instead.
            </p>
          )}
        </Field>

        {/* Optional first message (GH #192). Sent to the agent once it
            finishes booting, or, with "Start later" ticked below, saved as the
            task's goal and not sent at all. Hidden for a plain terminal, which
            has no prompt box to type into (the checkbox rides inside this same
            guard, so the two appear and disappear together). Starts at 1 row — growPrompt() (above)
            grows it on attach and as the user types, so the hint that used to explain
            "typed once ready, nothing sent until Create" isn't needed to
            justify the extra height; the placeholder carries that now. */}
        {canPrompt && (
          <Field label={issueSelected ? "Initial prompt (from the issue)" : "Initial prompt"}>
            <div className="flex flex-col gap-1">
              <textarea
                ref={attachPrompt}
                value={prompt}
                onChange={e => setPrompt(e.target.value.slice(0, MAX_PROMPT_CHARS))}
                rows={1}
                // Enter inserts a newline and nothing else. A textarea
                // never submits its form on Enter, but the dialog above it
                // does bind keys, and a multi-line first message must not
                // be able to trip anything mid-sentence.
                onKeyDown={e => { if (e.key === "Enter") e.stopPropagation(); }}
                // No native autocorrect / autocapitalize / spellcheck: this
                // is agent input, not prose, and macOS text substitution
                // mangling a path or a flag is never wanted. Same reasoning
                // as the broadcast composer.
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                placeholder={"Describe the task, paste a ticket, or leave empty to start the agent idle."}
                className="max-h-[30vh] w-full resize-none overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[13px] leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
              />
              {/* Counter appears only as the cap gets close, so the common
                  case (a couple of sentences) stays uncluttered. */}
              {prompt.length > MAX_PROMPT_CHARS * 0.8 && (
                <span className={cn(
                  "self-end text-[11.5px] tabular-nums",
                  prompt.length >= MAX_PROMPT_CHARS
                    ? "text-[var(--color-warn)]"
                    : "text-[var(--color-fg-faint)]",
                )}>
                  {prompt.length} / {MAX_PROMPT_CHARS}
                </span>
              )}
              {/* Start later: the whole point of the goal feature. Writing
                  down what a task is FOR used to mean starting it, because
                  this box was the only place to type and submitting it stamps
                  `started_at`. Ticked, the same text becomes the task's goal
                  and nothing is sent, so the task is created, its worktree is
                  cut and its agent still spawns: it just sits at Todo with a
                  record of what it is for.

                  Inside the `canPrompt` block on purpose, so it appears and
                  disappears with the field it describes rather than offering
                  to save a goal from a box that is not on screen. */}
              <label className="mt-1 flex items-start gap-2 text-[12.5px] text-[var(--color-fg)]">
                {/* The testid goes on the CHECKBOX, not the label: `Checkbox`
                    is a styled button rather than a native input, so a label
                    wrapping it is decoration and clicking it toggles nothing.
                    A spec has to press the control itself, and `aria-checked`
                    on it is what says which way it is set. */}
                <Checkbox
                  checked={startLater}
                  onChange={setStartLater}
                  aria-label="Start later"
                  data-testid="new-task-start-later"
                  className="mt-[1px]"
                />
                <span>
                  Start later
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
                    Saves the text as this task's goal. Nothing is sent to {agentLabel}.
                  </span>
                </span>
              </label>
            </div>
          </Field>
        )}

        {/* Resume-args override: the same field the task menu's "Resume
            override" edits, just available before the first spawn instead of
            after it. Sits BELOW the first message because it is the rarer of
            the two: almost every task types a first message, almost none
            override resume args at create. Shown for multi as well, where it
            lands on the host task. */}
        {canResumeOverride && resumeOverrideField}

        {/* Multi-repo: per-member mode + branch picker. Each member
            row renders a small toggle (Worktree | Repo root) and, when
            in Worktree mode, a branch + base override. RepoRoot mode
            collapses to a single warning line. */}
        {isMulti && mode === "repo_root" && (
          <div
            data-testid="members-live-note"
            className="rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2 text-[12px] text-[var(--color-warn)]"
          >
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            All {members.length} members run live, linked into the host checkout. The agent
            can directly modify every repo. No worktree isolation.
          </div>
        )}
        {isMulti && mode === "worktree" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-[13px] font-medium text-[var(--color-fg)]">
                Members ({members.length})
              </label>
              {members.length > 1 ? (
                // Bulk flip, for compositions with many members. Same wording
                // and order as the per-row toggle (main left, worktree right).
                // Non-git members stay on repo_root: the constraint outranks
                // the bulk ask, exactly like their disabled per-row button.
                <div className="flex items-center gap-1 text-[11.5px]">
                  <span className="text-[var(--color-fg-faint)]">Set all:</span>
                  <button
                    type="button"
                    data-testid="members-all-main"
                    onClick={() => setAllMemberModes("repo_root")}
                    className="rounded-[4px] border border-[var(--color-border)] px-2 py-[2px] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]"
                  >
                    Main checkout
                  </button>
                  <button
                    type="button"
                    data-testid="members-all-worktree"
                    onClick={() => setAllMemberModes("worktree")}
                    className="rounded-[4px] border border-[var(--color-border)] px-2 py-[2px] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]"
                  >
                    Worktree
                  </button>
                </div>
              ) : (
                <span className="text-[11.5px] text-[var(--color-fg-faint)]">
                  Per-repo mode + branch
                </span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              {members.map((m, idx) => {
                const update = (patch: Partial<MemberSpec>) =>
                  setMembers(prev => prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                // Write the flip through to storage right away (not on
                // submit), mirroring chooseMode above: a cancelled dialog
                // still teaches the next open. Non-git rows never persist —
                // their repo_root is a constraint, not a choice.
                const chooseMemberMode = (mode: MemberMode) => {
                  update({ mode });
                  if (!m.non_git) persistMemberMode(m.root_path, mode);
                };
                return (
                  <div
                    key={m.root_path}
                    data-testid="member-mode-row"
                    data-member-name={m.name}
                    data-member-mode={m.mode}
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
                          onClick={() => chooseMemberMode("repo_root")}
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
                          onClick={() => chooseMemberMode("worktree")}
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
        {/* Offered in every shape (see canSandbox). */}
        {canSandbox && (
        <Field label="Sandbox" hint="Cage the agent's filesystem + network access. Pinned at creation.">
          <SandboxPicker
          onEnableDocker={() => { close(); useApp.getState().openSettings("docker"); }}
            value={selection}
            onChange={setSelection}
            seatbeltUnavailable={osSandboxOk === false}
            dockerOffered={dockerOffered}
            compact
          />
          {selection === "docker" && (
            <div className="mt-2 flex flex-col gap-2">
              <DockerEngineNote compact />
              <ListField
                label="Extra mounts"
                placeholder={"$HOME/mcp-data:/data/mcp"}
                value={dockerMounts}
                onChange={setDockerMounts}
              />
            </div>
          )}
        </Field>
        )}
      </div>

      {/* Issue picker: its own column, not a box wedged into the form. It is a
          TABLE the user reads and scans (number, title, author, labels), and
          220px of it above the fields meant scrolling a list inside a dialog
          you were already scrolling. Same second-pane treatment the sandbox
          config gets, and mutually compatible with it - both can be open, and
          the dialog widens to three columns.

          Picking a row fills Name, Branch and Initial prompt on the left, all
          of which stay editable. That is the whole point of it being beside
          the form rather than above it: you see what the choice did. */}
      {issueMode && (
        <div
          data-testid="issue-column"
          data-issue-picked={issueSelected ? String(issueSelected.number) : undefined}
          className="ml-8 flex min-w-0 flex-1 flex-col gap-3 border-l border-[var(--color-border-soft)] pl-6"
        >
          <div className="text-[11.5px] uppercase tracking-[0.1em] text-[var(--color-fg-faint)]">
            Issue to start from
          </div>
          <p className="-mt-1 text-[12px] leading-snug text-[var(--color-fg-dim)]">
            Open issues, most recently updated first. The agent starts with the
            issue and reads the comments itself.
          </p>
          {issueLoading ? (
            <div className="flex items-center gap-2 px-1 py-4 text-[12.5px] text-[var(--color-fg-faint)]">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent)]" /> Loading issues…
            </div>
          ) : issueLookup && issueLookup.status !== "ok" ? (
            <div className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-3 text-[12.5px] text-[var(--color-fg-dim)]">
              {issueLookup.status === "cli-missing" ? (
                <>
                  <div className="text-[var(--color-fg)]">
                    Issues need the <span className="mono">{forgeCli}</span> CLI
                  </div>
                  <div className="mt-1">
                    Install it with <code className="mono">brew install {forgeCli}</code>, then sign in
                    with <code className="mono">{forgeCli} auth login</code>. It also powers the PR card and
                    merge detection.
                  </div>
                </>
              ) : issueLookup.status === "cli-unauthed" ? (
                <>
                  <div className="text-[var(--color-fg)]">Sign in to load issues</div>
                  <div className="mt-1">
                    Run <code className="mono">{forgeCli} auth login</code> in a terminal, then reopen this.
                  </div>
                </>
              ) : (
                <span className="break-words">{issueLookup.message}</span>
              )}
            </div>
          ) : (issueLookup?.issues.length ?? 0) === 0 ? (
            <div className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-4 text-center text-[12px] text-[var(--color-fg-faint)]">
              No open issues on this repo.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <input
                value={issueQuery}
                onChange={e => setIssueQuery(e.target.value)}
                placeholder="Filter by number, title or label"
                spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
                className="mb-1.5 h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12.5px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
              />
              <div className="min-h-[220px] flex-1 overflow-auto rounded-md border border-[var(--color-border-soft)]">
                {visibleIssues.map(issue => (
                  <button
                    key={issue.number}
                    type="button"
                    onClick={() => pickIssue(issue)}
                    title={issue.title}
                    className={cn(
                      "flex w-full items-start gap-2.5 border-b border-[var(--color-border-soft)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--color-hover)]",
                      issueSelected?.number === issue.number && "bg-[var(--color-accent-deep)]/10",
                    )}
                  >
                    <CircleDot className={cn(
                      "mt-px h-4 w-4 shrink-0",
                      issueSelected?.number === issue.number ? "text-[var(--color-accent)]" : "text-[var(--color-fg-faint)]",
                    )} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-[var(--color-fg)]">
                        <span className="text-[var(--color-fg-faint)]">#{issue.number}</span> {issue.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--color-fg-faint)]">
                        {issue.author && <span className="truncate">{issue.author}</span>}
                        {issue.comments > 0 && (
                          <span className="shrink-0">
                            {issue.comments} comment{issue.comments === 1 ? "" : "s"}
                          </span>
                        )}
                        {issue.labels.slice(0, 3).map(l => (
                          <span key={l} className="shrink-0 truncate rounded bg-[var(--color-bg-3)] px-1 text-[10.5px]">{l}</span>
                        ))}
                      </div>
                    </div>
                    {issueSelected?.number === issue.number && (
                      <Check className="mt-px h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                    )}
                  </button>
                ))}
                {visibleIssues.length === 0 && (
                  <div className="px-3 py-4 text-center text-[12px] text-[var(--color-fg-faint)]">
                    Nothing matches that filter.
                  </div>
                )}
              </div>
            </div>
          )}
          {/* A plain shell / registry terminal has no prompt box, so the
              composed prompt has nowhere to go. Say so here, where the issue
              was chosen, rather than letting Create silently drop it. */}
          {issueSelected && !canPrompt && (
            <p className="text-[12px] leading-snug text-[var(--color-warn)]">
              {agentLabel} has no prompt box, so the issue won't be handed over.
              Pick an agent to send it.
            </p>
          )}
        </div>
      )}
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
      </form>
    </AppDialog>
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

/** Field variant for when the hint is short enough to share the label's
 *  line instead of wrapping to its own — Branch name / Branch from's hints
 *  ("Auto-fills from the name.", "Blank = repo default.") are a few words,
 *  so a whole extra line for them was pure air. Falls back to Field's
 *  stacked layout the instant a longer hint (e.g. the multi-repo host
 *  variant) would crowd the label — pass it via `hint` on Field instead. */
function FieldInline({ label, hint, children }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <label className="text-[13px] font-medium text-[var(--color-fg)]">{label}</label>
        {hint && <span className="truncate text-[12px] text-[var(--color-fg-faint)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// Per-member script editor moved to NewProjectDialog / RepositorySection
// — scripts are project-scoped, not task-scoped.
