// Edit an existing multi-repo task. Deliberately mirrors the New Task
// dialog's layout — same fields in the same order — so "what did I
// create" and "what can I change" are the same picture. Fields that are
// frozen at create (task type, branch, per-member mode) render disabled
// rather than hidden; editable ones write through their existing
// commands: name → task_rename, CLI → task_set_cli, YOLO → task_set_yolo,
// members → task_update_members. Sandbox renders the same SandboxPicker
// + config column as create and saves through task_set_sandbox /
// task_set_docker; the resume-args override edits inline and saves
// through task_set_resume_override.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { defaultCliFirst, visibleCliIds, isTerminalCli } from "@/lib/agents";
import { taskRename, taskSetCli, taskSetYolo, taskSetResumeOverride, taskSetSandbox, taskSetDocker, taskUpdateMembers, sandboxAvailable, settingsLoad, dockerImageStatus, type DockerImageStatus } from "@/lib/ipc";
import { readMemberModes, seedMemberMode, persistMemberMode } from "./memberModes";
import { cn } from "@/lib/utils";
import { effectiveSandboxMode, isTaskCaged, selectionFor, selectionToFields, type CreateMultiMember, type MemberMode, type Project, type SandboxSelection, type Settings, type Task, type TaskMember } from "@/lib/types";
import { SandboxPicker, DockerEngineNote, KeychainBlockField } from "@/components/SandboxPicker";
import { memberSandboxUnion } from "@/lib/projectSandboxDefault";
import { ListField } from "@/components/settings/Controls";
import { SANDBOX_PRESETS } from "@/lib/sandboxPresets";
import { dockerToggleMessage, leaveDockerMessage } from "@/lib/sandboxSwitchCopy";
import { AlertTriangle, GitBranch, History, Link2, Loader2, Zap } from "lucide-react";

const CLIS = ["claude", "codex", "agy", "grok", "opencode"] as const;

type Row = {
  /** TaskMember.dir_name for existing rows, root_path for addable ones. */
  key: string;
  dir_name: string;
  name: string;
  root_path: string;
  /** Set when the row is already in the task's composition. */
  existing: TaskMember | null;
  /** Existing: keep. Addable: include in the task. */
  checked: boolean;
  /** Add-spec only — an existing member's mode is frozen. */
  mode: MemberMode;
  branch: string;
  base_branch: string;
  non_git: boolean;
};

export function EditTaskDialog() {
  // Two namespaces: this dialog's own copy plus the create dialog's, which it
  // deliberately reuses rather than restating (Task type, Main checkout, the
  // sandbox field labels), and `tc` for the shared Cancel/Save/Close/Remove.
  const { t } = useTranslation("dialogs");
  const { t: tc } = useTranslation("common");
  const taskId = useUI(s => s.editTaskId);
  const close = useUI(s => s.closeEditTask);
  const task = useApp(s => s.tasks.find(w => w.id === taskId) ?? null);
  const project = useApp(s => s.projects.find(p => p.id === task?.project_id) ?? null);
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);

  const open = taskId !== null;
  const mounted = useApp(s => (taskId ? s.mountedTasks.has(taskId) : false));
  const [name, setName] = useState("");
  const [cli, setCli] = useState("");
  const [yolo, setYolo] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Sandbox mirrors New Task's: one SandboxSelection drives the picker,
  // the seatbelt lists and Docker mounts sit beside it in the config
  // column that only renders while a cage is on.
  const [sel, setSel] = useState<SandboxSelection>("off");
  const [sbRw, setSbRw] = useState("");
  const [sbHosts, setSbHosts] = useState("");
  const [blockKc, setBlockKc] = useState(false);
  const [dockerMounts, setDockerMounts] = useState("");
  const [resume, setResume] = useState("");
  const [resumeOpen, setResumeOpen] = useState(false);
  // Same probes as create — run on each open so a Docker flip in
  // Settings while the dialog was closed doesn't leave the card stale.
  const [osSandboxOk, setOsSandboxOk] = useState<boolean | null>(null);
  const [dockerSettings, setDockerSettings] = useState<{ docker_sandbox_enabled?: boolean } | null>(null);
  const [dockerImage, setDockerImage] = useState<DockerImageStatus | null>(null);
  const sbGlobals = useRef<Settings | null>(null);
  useEffect(() => {
    if (!open) return;
    // Reset BEFORE re-probing — stale non-null values from the previous
    // open would satisfy the flip guards below and clobber a freshly
    // seeded "docker"/seatbelt sel before the real answers land.
    setOsSandboxOk(null);
    setDockerSettings(null);
    setDockerImage(null);
    sandboxAvailable().then(setOsSandboxOk).catch(() => setOsSandboxOk(false));
    settingsLoad().then(s => {
      // The globals layer of the seatbelt auto-union — a member toggle
      // re-derives the lists and needs it to not drop lines it can't
      // rebuild.
      sbGlobals.current = s;
      setDockerSettings(s);
    }).catch(() => {});
    dockerImageStatus().then(setDockerImage).catch(() => {});
  }, [open]);
  const dockerOffered = !!dockerSettings?.docker_sandbox_enabled && !!dockerImage?.available;
  // Flip off only once both probes have answered — the seeded value can
  // legitimately be "docker" before they resolve, and clobbering it
  // would silently change the task's cage on save.
  useEffect(() => {
    if (dockerSettings !== null && dockerImage !== null && sel === "docker" && !dockerOffered) setSel("off");
  }, [dockerSettings, dockerImage, dockerOffered, sel]);
  useEffect(() => {
    if (osSandboxOk === false && sel !== "off" && sel !== "docker") setSel("off");
  }, [osSandboxOk, sel]);

  // Same options as New Task's Default CLI picker: registry agents filtered
  // to installed+enabled, project default first. Plus the task's CURRENT
  // cli when no picker entry covers it — task_set_cli only accepts agent
  // CLIs, so "shell"/"custom"/an uninstalled agent can't be offered as a
  // choice, but hiding it would leave the row showing no selection.
  const SHELL_CHOICE = { id: "shell", display_name: "Terminal", color: "" } as any;
  const cliChoices = (() => {
    const list = agents.length
      ? agents
      : CLIS.map(id => ({ id, display_name: id, color: "" } as any));
    const visible = visibleCliIds(list.map(a => a.id), agents, detectedClis);
    const covered = task && list.some(a => a.id === task.cli && visible.has(a.id));
    const current = task && !covered
      ? [task.cli === "shell" ? SHELL_CHOICE : { id: task.cli, display_name: task.cli, color: "" } as any]
      : [];
    return defaultCliFirst(
      [...list.filter(a => visible.has(a.id)), ...current],
      project?.default_cli,
    );
  })();

  // Seed rows from a task + project. Called on open (layout effect, same
  // reasoning as NewTaskDialog's member seeding — the dialog stays mounted)
  // and again after a failed save: task_update_members is per-member
  // best-effort, so partial changes have already landed and the rows must
  // reflect the fresh record or a retry resubmits applied removals.
  function seed(t: Task, p: Project) {
    // A listener from a previous open is either dead (fired) or stale —
    // its task id is last session's; replace it.
    setupDoneUnlisten.current?.();
    setupDoneUnlisten.current = null;
    setName(t.name);
    setCli(t.cli);
    setYolo(!!t.yolo);
    setSel(selectionFor(effectiveSandboxMode(t), !!t.docker_sandbox_enabled));
    setSbRw((t.sandbox_rw_paths ?? []).join("\n"));
    setSbHosts((t.sandbox_allowed_hosts ?? []).join("\n"));
    setBlockKc(!!t.sandbox_block_keychain);
    setDockerMounts((t.docker_extra_mounts ?? []).join("\n"));
    setResume(t.resume_override ?? "");
    // A set override shows expanded; empty keeps create's collapsed
    // "Override resume args" toggle.
    setResumeOpen(!!t.resume_override);
    setErr(null);
    setBusy(false);
    const comp = t.composition ?? [];
    const remembered = readMemberModes();
    // Same resolution as the backend's member_repo: legacy records have
    // no repo_path — a repo_root member's path IS the repo root, a
    // worktree member resolves through its member project. Without this
    // a legacy member shows up as BOTH an existing row and an addable row.
    const all = useApp.getState().projects;
    const memberRoot = (cm: TaskMember): string =>
      cm.repo_path ||
      (cm.mode === "repo_root" ? cm.path
        : all.find(mp => mp.id === cm.project_id)?.root_path ?? "");
    const existing: Row[] = comp.map(cm => {
      const root = memberRoot(cm);
      const pm = (p.members ?? []).find(m => m.root_path === root);
      return {
        key: `ex-${cm.dir_name}`,
        dir_name: cm.dir_name,
        name: pm?.name ?? cm.dir_name,
        root_path: root,
        existing: cm,
        checked: true,
        mode: cm.mode,
        branch: cm.branch,
        base_branch: "",
        non_git: pm?.non_git ?? false,
      };
    });
    const addable: Row[] = (p.members ?? [])
      .filter(pm => !comp.some(cm => {
        const root = memberRoot(cm);
        // Unresolvable legacy member (member project deleted): fall back
        // to the dir_name the spec would get, or it renders twice.
        return root === pm.root_path || (root === "" && cm.dir_name === pm.name);
      }))
      .map(pm => ({
        key: `add-${pm.root_path}`,
        dir_name: pm.name,
        name: pm.name,
        root_path: pm.root_path,
        existing: null,
        checked: false,
        mode: seedMemberMode(pm.non_git ?? false, remembered, pm.root_path),
        branch: "",
        base_branch: "",
        non_git: pm.non_git ?? false,
      }));
    setRows([...existing, ...addable]);
  }

  useLayoutEffect(() => {
    if (!open || !task || !project) return;
    seed(task, project);
  }, [open, task?.id, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLive = task?.is_main_checkout ?? false;
  const update = (key: string, patch: Partial<Row>) =>
    setRows(prev => {
      const next = prev.map(r => (r.key === key ? { ...r, ...patch } : r));
      // A membership toggle re-syncs the seatbelt lists only while they
      // still hold an AUTO value — the union for the previous checked
      // set, or the stored list when IT was itself auto-derived (the
      // backend's "untouched" rule: stored == composition base or the
      // all-members union the dialog pins at create). A stored list the
      // user hand-pinned — or a textarea they edited here — is theirs,
      // and is never rewritten by a checkbox.
      if ("checked" in patch && task && project) {
        const pms = (rs: Row[]) => (project.members ?? []).filter(pm =>
          rs.some(r => r.checked && r.root_path === pm.root_path));
        const allAuto = memberSandboxUnion(sbGlobals.current, project, project.members ?? []);
        const prevAuto = memberSandboxUnion(sbGlobals.current, project, pms(prev));
        const nextAuto = memberSandboxUnion(sbGlobals.current, project, pms(next));
        const untouched = (now: string[], stored: string[], prevB: string[], allB: string[]) =>
          arrEq(now, prevB) || ((arrEq(stored, prevB) || arrEq(stored, allB)) && arrEq(now, stored));
        if (untouched(lines(sbRw), task.sandbox_rw_paths ?? [], prevAuto.rw, allAuto.rw)) {
          setSbRw(nextAuto.rw.join("\n"));
        }
        if (untouched(lines(sbHosts), task.sandbox_allowed_hosts ?? [], prevAuto.hosts, allAuto.hosts)) {
          setSbHosts(nextAuto.hosts.join("\n"));
        }
      }
      return next;
    });

  const removing = useMemo(() => rows.filter(r => r.existing && !r.checked), [rows]);
  const adding = useMemo(() => rows.filter(r => !r.existing && r.checked), [rows]);
  const kept = rows.filter(r => r.checked).length;

  // Sandbox diff vs the live record. Hidden fields keep their seeded
  // values so they compare equal — no mode-gating needed here.
  const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
  const arrEq = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const selNow: SandboxSelection = task ? selectionFor(effectiveSandboxMode(task), !!task.docker_sandbox_enabled) : "off";
  const { mode: selMode, docker: selDocker } = selectionToFields(sel);
  // Gate on the DRAFT, not the record — same as create (yoloForCreate):
  // a stored yolo=true on a task the draft cages must not be written
  // back, or it lights the red ⚡ the moment the sandbox is turned off.
  const yoloCaged = isTaskCaged({ sandbox_mode: selMode, docker_sandbox_enabled: selDocker });
  const yoloApplies = !!task && !isTerminalCli(cli);
  const canResumeOverride = !!task && cli !== "shell" && !isTerminalCli(cli);
  // Create's coercion: caged or non-agent ⇒ store yolo=false. Saves a
  // stale record flag AND rejects the tick the disabled checkbox can't.
  const yoloEff = yoloApplies && yolo && !yoloCaged;
  // same rule as TaskSandboxDialog: the Keychain row shows (and counts)
  // only for the enforcing modes, so changing the mode here always shows
  // whether the block will apply.
  const kcRow = !selDocker && (selMode === "enforce" || selMode === "enforce-fs");
  const sandboxDirty = !!task && (
    sel !== selNow ||
    (kcRow && blockKc !== !!task.sandbox_block_keychain) ||
    !arrEq(lines(sbRw), task.sandbox_rw_paths ?? []) ||
    !arrEq(lines(sbHosts), task.sandbox_allowed_hosts ?? []) ||
    !arrEq(lines(dockerMounts), task.docker_extra_mounts ?? [])
  );
  // task_set_docker SIGKILLs live PTYs unconditionally — any docker
  // change is a restart, so it needs its own dirty flag + confirm gate.
  const dockerDirty = !!task && (
    selDocker !== !!task.docker_sandbox_enabled ||
    (selDocker && !arrEq(lines(dockerMounts), task.docker_extra_mounts ?? []))
  );
  const resumeDirty = !!task && canResumeOverride && resume.trim() !== (task.resume_override ?? "");
  const dirty =
    name.trim() !== (task?.name ?? "") ||
    (!!task && cli !== task.cli) ||
    (!!task && yoloEff !== !!task.yolo) ||
    sandboxDirty || resumeDirty ||
    removing.length > 0 || adding.length > 0;

  // Guard like NewTaskDialog's submittingRef: busy isn't set until after
  // the confirms, so a second submit inside the askConfirm gap would
  // re-enter — and the second askConfirm would orphan the first promise.
  const submittingRef = useRef(false);
  // One setup-done listener per dialog session — see save().
  const setupDoneUnlisten = useRef<(() => void) | null>(null);

  async function save() {
    if (!task || busy || submittingRef.current) return;
    submittingRef.current = true;
    try {
      await saveInner(task);
    } finally {
      submittingRef.current = false;
    }
  }

  async function saveInner(task: Task) {
    const wtRemoved = removing.filter(r => r.existing!.mode === "worktree");
    if (wtRemoved.length > 0) {
      const names = wtRemoved.map(r => r.dir_name).join(", ");
      const ok = await useUI.getState().askConfirm({
        title: wtRemoved.length === 1
          ? t("editTask.removeWorktreeTitleOne")
          : t("editTask.removeWorktreeTitleMany", { count: wtRemoved.length }),
        message: wtRemoved.length === 1
          ? t("editTask.removeWorktreeBodyOne", { names })
          : t("editTask.removeWorktreeBodyMany", { names }),
        confirmLabel: tc("remove"),
        destructive: true,
      });
      if (ok !== true) return;
    }
    // Docker changes kill live PTYs server-side with no opt-out, so they
    // get the same informed pre-save confirm the worktree removal gets —
    // with the same per-direction copy TaskSandboxDialog uses.
    // Seatbelt changes can wait — saved without restart, with a toast
    // action offered after instead of a forced inline choice.
    if (dockerDirty && mounted) {
      const ok = await useUI.getState().askConfirm({
        title: t("editTask.restartTitle"),
        message: selDocker
          ? dockerToggleMessage(true)
          : leaveDockerMessage(selMode === "off" ? "off" : "seatbelt"),
        confirmLabel: t("editTask.restartConfirm"),
      });
      if (ok !== true) return;
    }
    setBusy(true); setErr(null);
    try {
      const trimmed = name.trim();
      if (trimmed && trimmed !== task.name) await taskRename(task.id, trimmed);
      if (cli !== task.cli) await taskSetCli(task.id, cli);
      if (yoloEff !== !!task.yolo) await taskSetYolo(task.id, yoloEff);
      if (resumeDirty) await taskSetResumeOverride(task.id, resume.trim());
      if (sandboxDirty) {
        // Mark right before the kill IPC (TaskSandboxDialog's ordering):
        // marking earlier leaves a stale auto-respawn if a call above
        // throws and the docker change never lands.
        if (dockerDirty && mounted) useUI.getState().markPendingPtyRestart(task.id);
        if (selDocker) {
          if (dockerDirty) {
            // extra_args have no field here (same as create) — keep the
            // task's existing ones so a mounts edit doesn't clear them.
            await taskSetDocker(task.id, true, task.docker_extra_args ?? [], lines(dockerMounts));
          } else {
            // Picked away to seatbelt and back — docker stays on but the
            // lists were touched in between. Persist them dormant (docker
            // stores sandbox_mode "off"; they apply if docker's dropped).
            await taskSetSandbox(task.id, effectiveSandboxMode(task), lines(sbRw), lines(sbHosts), false);
          }
        } else {
          // Record the cage FIRST, then drop Docker — same order as
          // TaskSandboxDialog: a respawn between the calls lands on the
          // new seatbelt profile rather than uncaged.
          await taskSetSandbox(task.id, selMode, lines(sbRw), lines(sbHosts), false, kcRow ? blockKc : undefined);
          if (task.docker_sandbox_enabled) {
            await taskSetDocker(task.id, false, task.docker_extra_args ?? [], lines(dockerMounts));
          } else if (mounted) {
            // Seatbelt→seatbelt only — a docker transition already killed
            // and auto-respawned the agents, so no restart is owed.
            useUI.getState().pushToast(t("editTask.sandboxSavedToast"), "success", {
              action: { label: t("editTask.restartAgents"), onClick: () => useApp.getState().stopTask(task.id) },
            });
          }
        }
      }
      if (removing.length > 0 || adding.length > 0) {
        const add: CreateMultiMember[] = adding.map(r => ({
          root_path: r.root_path,
          dir_name: r.dir_name,
          mode: isLive ? "repo_root" : r.mode,
          branch: r.branch.trim() || undefined,
          base_branch: r.base_branch.trim() || undefined,
        }));
        // Setup for added members streams on the task's own channel —
        // but unlike create, no pending pane is listening on this id.
        // Subscribe BEFORE invoking (the done event can fire inside the
        // invoke when no member has a script) so a silent failure isn't
        // invisible: toast it. The listener outlives save() on purpose —
        // setups stream after the dialog closes (and after a failed save,
        // for partial adds) — self-unsubscribes on the first event;
        // re-armed per open in seed().
        if (adding.length > 0 && !setupDoneUnlisten.current) {
          setupDoneUnlisten.current = await listen<{ success?: boolean }>(`setup-done://${task.id}`, ev => {
            setupDoneUnlisten.current?.();
            setupDoneUnlisten.current = null;
            if (ev.payload.success === false) {
              useUI.getState().pushToast(t("editTask.setupFailedToast"), "error");
            }
          });
        }
        await taskUpdateMembers(task.id, add, removing.map(r => r.dir_name));
      }
      await useApp.getState().loadAll();
      close();
    } catch (e) {
      // task_update_members is per-member best-effort: some changes may
      // have landed before the error, so refresh either way AND re-seed
      // the rows from the fresh record — otherwise a second Save would
      // resubmit already-applied removals ("'x' is not a member").
      // seed() clears err+busy itself, so setErr AFTER it or the error
      // we're reporting disappears.
      await useApp.getState().loadAll().catch(() => {});
      const s = useApp.getState();
      const t2 = s.tasks.find(t => t.id === task.id);
      const p2 = s.projects.find(p => p.id === task.project_id);
      if (t2 && p2) seed(t2, p2);
      setErr(String(e));
      setBusy(false);
    }
  }

  // The sandbox config column renders only while a seatbelt cage is
  // picked — same gate as create's right column (Docker has its own
  // inline block under the picker; "off" leaves no ghost width).
  const sandboxPane = sel !== "docker" && selMode !== "off";

  /** Segmented control identical to New Task's task-type/member-mode
   *  toggles. `disabled` freezes it — the whole point of showing it is
   *  reading the task's shape at a glance, like a field you can't edit. */
  const segmented = (opts: {
    value: MemberMode;
    onPick?: (m: MemberMode) => void;
    disabled?: boolean;
    worktreeDisabled?: boolean;
    worktreeTitle?: string;
  }) => (
    <div className="inline-flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-[2px] text-[11.5px]">
      <button
        type="button"
        disabled={opts.disabled}
        onClick={() => opts.onPick?.("repo_root")}
        className={cn(
          "flex h-6 items-center gap-1 rounded-[4px] px-2 transition-colors",
          opts.value === "repo_root"
            ? "bg-[var(--color-accent-deep)] text-white"
            : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
          opts.disabled && "cursor-default",
        )}
      >
        <Link2 className="h-3 w-3" /> Main checkout
      </button>
      <button
        type="button"
        disabled={opts.disabled || opts.worktreeDisabled}
        title={opts.worktreeDisabled ? (opts.worktreeTitle ?? "Not a git repository, runs in the main checkout only") : undefined}
        onClick={() => opts.onPick?.("worktree")}
        className={cn(
          "flex h-6 items-center gap-1 rounded-[4px] px-2 transition-colors",
          opts.value === "worktree"
            ? "bg-[var(--color-accent-deep)] text-white"
            : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
          (opts.disabled || opts.worktreeDisabled) && "cursor-not-allowed opacity-40 hover:text-[var(--color-fg-dim)]",
        )}
      >
        <GitBranch className="h-3 w-3" /> {t("newTask.worktree")}
      </button>
    </div>
  );

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title={task ? t("editTask.titleNamed", { name: task.name }) : t("editTask.title")}
      // Same width math as the multi New Task dialog: 3xl base for the
      // form column, widening to the two-column size while the sandbox
      // config pane is showing (see NewTaskDialog for the rem formula).
      className={sandboxPane ? "max-w-[95.5rem]" : "max-w-3xl"}
      // Pin Cancel/Save like Create — a many-member list can scroll.
      stickyFooter={
        <>
          {err && <p className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[13.5px] text-[var(--color-err)]">{err}</p>}
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[11.5px] text-[var(--color-fg-faint)]">
              {(adding.length > 0 || removing.length > 0) && (
                <>
                  <AlertTriangle className="h-3 w-3" />
                  {[
                    adding.length > 0 ? t("editTask.pendingAdding", { count: adding.length }) : "",
                    removing.length > 0 ? t("editTask.pendingRemoving", { count: removing.length }) : "",
                  ].filter(Boolean).join(", ")}
                </>
              )}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" type="button" onClick={close} disabled={busy}>{tc("cancel")}</Button>
              <Button variant="primary" type="submit" form="edit-task-form" disabled={busy || !dirty || !name.trim()}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc("save")}
              </Button>
            </div>
          </div>
        </>
      }
    >
      {task && project ? (
        <form
          id="edit-task-form"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="mt-1.5 flex flex-col gap-4"
        >
        {/* Columns row, same as create: the left form is flex-1, the
            sandbox config column joins it while a cage is on. */}
        <div className="flex">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Same Task type row as create — disabled here: a worktree task
              can't become a live-checkout task (the wrapper IS the worktree),
              so the toggle is informational. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className="text-[13px] font-medium text-[var(--color-fg)]">{t("newTask.taskType")}</label>
              <div className="inline-flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
                {(["repo_root", "worktree"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    disabled
                    title={t("editTask.taskTypeFrozen")}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px]",
                      (isLive ? "repo_root" : "worktree") === m
                        ? "bg-[var(--color-accent-deep)] text-white"
                        : "text-[var(--color-fg-dim)] opacity-40",
                    )}
                  >
                    {m === "repo_root" ? <Link2 className="h-3.5 w-3.5" /> : <GitBranch className="h-3.5 w-3.5" />}
                    {m === "repo_root" ? t("newTask.mainCheckout") : t("newTask.worktree")}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[12px] text-[var(--color-fg-faint)]">
              {isLive
                ? t("editTask.liveHint")
                : t("editTask.worktreeHint")}
            </p>
          </div>

          {/* Name + frozen git fields share one tight cluster, like create.
              Branch/base can't be recut post-create — shown disabled rather
              than dropped so the task's shape is fully visible. Name stays
              the dialog's FIRST input (e2e types into it positionally). */}
          <div className="flex flex-col gap-2">
            <Field label={t("newTask.nameLabel")}>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
                required
              />
            </Field>
            {!isLive && task.branch && (
              <FieldInline label={t("newTask.branchName")} hint={t("editTask.branchCutHint")}>
                <Input value={task.branch} disabled className="opacity-60" />
              </FieldInline>
            )}
            {!isLive && task.base_branch && (
              <FieldInline label={t("newTask.hostBranchFrom")}>
                <Input value={task.base_branch} disabled className="opacity-60" />
              </FieldInline>
            )}
          </div>

          <Field label={t("newTask.defaultCli")}>
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
                  <CliIcon cli={a.icon_id} className="h-3.5 w-3.5" />
                  {a.id === "agy" ? "Agy" : a.display_name}
                </button>
              ))}
            </div>
          </Field>

          {/* Resume-args override, same affordance and same place as
              create (right after the prompt slot, which edit lacks):
              collapsed toggle until set (or asked for), then the input. */}
          {canResumeOverride && (resumeOpen ? (
            <Field
              label={t("newTask.resumeOverrideLabel")}
              hint={t("editTask.resumeOverrideHint")}
            >
              <Input
                value={resume}
                onChange={e => setResume(e.target.value)}
                placeholder={t("newTask.resumeOverridePlaceholder")}
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
              {t("newTask.overrideResumeToggle")}
            </button>
          ))}

          {/* Members — same section as create, minus the saved-set chips and
              bulk Set-all buttons: a one-click preset on EXISTING members is
              a one-click mass worktree deletion, so membership changes here
              stay per-row and intentional. Existing members' mode/branch are
              frozen — the segmented renders disabled at the real value;
              remove + re-add is how you change it. */}
          {isLive ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="text-[13px] font-medium text-[var(--color-fg)]">
                  {t("editTask.membersLabel", { kept, total: rows.length })}
                </label>
                <span className="text-[11.5px] text-[var(--color-fg-faint)]">
                  {t("editTask.membersLinkedHint")}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {rows.map(r => (
                  <label
                    key={r.key}
                    data-testid="edit-member-row"
                    data-member-name={r.name}
                    data-member-existing={r.existing ? "true" : "false"}
                    data-member-checked={r.checked ? "true" : "false"}
                    data-member-mode="repo_root"
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2",
                      !r.checked && "opacity-50",
                    )}
                  >
                    <Checkbox
                      data-testid="edit-member-include"
                      aria-label={r.existing ? t("editTask.memberKeep", { name: r.name }) : t("editTask.memberAdd", { name: r.name })}
                      checked={r.checked}
                      onChange={v => update(r.key, { checked: v })}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-[var(--color-fg)]">{r.name}</div>
                      <div className="truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{r.root_path || r.dir_name}</div>
                    </div>
                    {r.existing && !r.checked && (
                      <span className="text-[11.5px] text-[var(--color-err)]">{t("editTask.memberUnlinkedOnSave")}</span>
                    )}
                  </label>
                ))}
              </div>
              {kept > 0 ? (
                <div
                  data-testid="members-live-note"
                  className="rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2 text-[12px] text-[var(--color-warn)]"
                >
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                  {kept === rows.length
                    ? t("editTask.membersLiveNoteEvery", { kept, total: rows.length })
                    : t("editTask.membersLiveNoteThose", { kept, total: rows.length })}
                </div>
              ) : (
                <div
                  data-testid="members-live-note"
                  className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-2 text-[12px] text-[var(--color-fg-faint)]"
                >
                  {t("editTask.membersLiveNoteNone")}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="text-[13px] font-medium text-[var(--color-fg)]">
                  {t("editTask.membersLabel", { kept, total: rows.length })}
                </label>
                <span className="text-[11.5px] text-[var(--color-fg-faint)]">
                  {t("newTask.perRepo")}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {rows.map(r => {
                  const chooseMode = (mode: MemberMode) => {
                    update(r.key, { mode });
                    if (!r.non_git) persistMemberMode(r.root_path, mode);
                  };
                  return (
                    <div
                      key={r.key}
                      data-testid="edit-member-row"
                      data-member-name={r.name}
                      data-member-existing={r.existing ? "true" : "false"}
                      data-member-checked={r.checked ? "true" : "false"}
                      data-member-mode={r.existing ? r.existing.mode : r.mode}
                      className={cn(
                        "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2",
                        !r.checked && "opacity-50",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                          <Checkbox
                            data-testid="edit-member-include"
                            aria-label={r.existing ? `Keep ${r.name} in this task` : `Add ${r.name} to this task`}
                            checked={r.checked}
                            onChange={v => update(r.key, { checked: v })}
                          />
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-[var(--color-fg)]">{r.name}</div>
                            <div className="truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{r.root_path || r.dir_name}</div>
                          </div>
                        </label>
                        {r.checked && (
                          r.existing
                            ? segmented({ value: r.existing.mode, disabled: true })
                            : segmented({
                                value: r.mode,
                                onPick: chooseMode,
                                worktreeDisabled: r.non_git,
                              })
                        )}
                      </div>
                      {r.existing && r.checked && r.existing.mode === "worktree" && (
                        <div className="mt-2">
                          <Input value={r.existing.branch} disabled className="opacity-60" title={t("editTask.branchFrozen")} />
                        </div>
                      )}
                      {r.existing && r.checked && r.existing.mode === "repo_root" && (
                        <div className="mt-2 text-[11.5px] text-[var(--color-warn)]">
                          {t("newTask.liveSymlinkWarn")}
                        </div>
                      )}
                      {r.existing && !r.checked && (
                        <div className="mt-2 text-[11.5px] text-[var(--color-err)]">
                          {r.existing.mode === "worktree"
                            ? t("editTask.willRemoveWorktree")
                            : t("editTask.willRemoveLink")}
                        </div>
                      )}
                      {!r.existing && r.checked && (r.mode === "worktree" ? (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <Input
                            value={r.branch}
                            onChange={e => update(r.key, { branch: e.target.value })}
                            placeholder={task.branch ? t("editTask.memberBranchDefault", { branch: task.branch }) : t("editTask.memberBranchPlaceholder")}
                          />
                          <Input
                            value={r.base_branch}
                            onChange={e => update(r.key, { base_branch: e.target.value })}
                            placeholder={t("newTask.memberBasePlaceholder")}
                          />
                        </div>
                      ) : (
                        <div className="mt-2 text-[11.5px] text-[var(--color-warn)]">
                          {t("newTask.liveSymlinkWarn")}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
              {rows.length === 0 && (
                <div className="text-[12px] text-[var(--color-fg-faint)]">
                  {t("editTask.noMembers")}
                </div>
              )}
              {rows.some(r => r.checked && (r.existing ? r.existing.mode : r.mode) === "repo_root") && (
                <div className="rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2 text-[12px] text-[var(--color-warn)]">
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                  {t("newTask.someLiveWarn")}
                </div>
              )}
            </div>
          )}

          {/* Same Sandbox field as create — the picker is the single
              control; Docker's extra mounts ride under it, the seatbelt
              lists live in the right-hand config column. */}
          <Field label={t("newTask.sandboxLabel")} hint={t("editTask.sandboxHint")}>
            <SandboxPicker
              onEnableDocker={() => { close(); useApp.getState().openSettings("docker"); }}
              value={sel}
              onChange={setSel}
              seatbeltUnavailable={osSandboxOk === false}
              dockerOffered={dockerOffered}
              compact
            />
            {sel === "docker" && (
              <div className="mt-2 flex flex-col gap-2">
                <DockerEngineNote compact />
                <ListField
                  label={t("newTask.extraMounts")}
                  placeholder={"$HOME/mcp-data:/data/mcp"}
                  value={dockerMounts}
                  onChange={setDockerMounts}
                />
              </div>
            )}
          </Field>

          {yoloApplies && (
            <Field
              label={t("newTask.yoloLabel")}
              hint={yoloCaged
                ? t("editTask.yoloHintCaged")
                : yolo
                  ? t("editTask.yoloHintOn")
                  : t("editTask.yoloHintOff")}
            >
              <label
                data-testid="edit-task-yolo"
                data-yolo-state={yoloCaged ? "auto" : yolo ? "on" : "off"}
                className={cn(
                  "flex w-fit items-center gap-2 text-[13px] select-none",
                  yoloCaged
                    ? "cursor-default text-[var(--color-fg-faint)]"
                    : "cursor-pointer text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  !yoloCaged && yolo && "text-[var(--color-err)] hover:text-[var(--color-err)]",
                )}
              >
                <input
                  type="checkbox"
                  checked={yoloCaged || yolo}
                  disabled={yoloCaged}
                  onChange={e => setYolo(e.target.checked)}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-[var(--color-border)] bg-[var(--color-bg-2)] text-[var(--color-accent)] focus:ring-0 focus:ring-offset-0 disabled:cursor-default"
                />
                <Zap className="h-3.5 w-3.5 shrink-0" fill="none" />
                {yoloCaged ? t("newTask.yoloAutoCaged") : t("newTask.yoloSkipPrompts")}
              </label>
            </Field>
          )}
        </div>{/* end left column */}

        {/* Right column: sandbox config, identical to create's — presets
            + the two lists, present only while a seatbelt cage is on. */}
        {sandboxPane && (
          <div className="ml-8 flex min-w-0 flex-1 flex-col gap-3 border-l border-[var(--color-border-soft)] pl-6">
            <div className="text-[11.5px] uppercase tracking-[0.1em] text-[var(--color-fg-faint)]">
              {t("editTask.sandboxPaneTitle")}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="text-[var(--color-fg-faint)]">{t("newTask.presetLabel")}</span>
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
            <Field label={t("newTask.allowedPathsLabel")} hint={t("editTask.allowedPathsHint")}>
              <textarea
                data-testid="sandbox-rw-paths"
                value={sbRw}
                onChange={e => setSbRw(e.target.value)}
                rows={3}
                placeholder={"$HOME/Work/other-project\n$HOME/Notes"}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              />
            </Field>
            {/* ENFORCING (FS) disables the network sandbox, so the host
                allow-list is irrelevant — hide it in that mode. */}
            {selMode !== "enforce-fs" && (
              <Field label={t("newTask.allowedHostsLabel")} hint={t("editTask.allowedHostsHint")}>
                <textarea
                  data-testid="sandbox-allowed-hosts"
                  value={sbHosts}
                  onChange={e => setSbHosts(e.target.value)}
                  rows={3}
                  placeholder={"*.mycompany.com\nbitbucket.org"}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                />
              </Field>
            )}
            {selMode === "enforce-fs" && (
              <p className="text-[12px] leading-snug text-[var(--color-fg-faint)]">
                {t("editTask.networkUnrestricted")}
              </p>
            )}
            {kcRow && <KeychainBlockField checked={blockKc} onChange={setBlockKc} />}
          </div>
        )}
        </div>{/* end columns row */}
        </form>
      ) : (
        // Task or project vanished while the dialog was up (archived
        // elsewhere, project removed) — or the project hasn't loaded yet
        // (open beats the fetch; a task without a loaded project is
        // indistinguishable until it arrives, so don't call it gone).
        <div className="flex flex-col gap-4">
          <p className="text-[13.5px] text-[var(--color-fg-dim)]">
            {task ? t("editTask.loadingProject") : t("editTask.gone")}
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={close}>{tc("close")}</Button>
          </div>
        </div>
      )}
    </AppDialog>
  );
}

/** Same label/hint/control stack as NewTaskDialog's local Field — kept
 *  dialog-local like the codebase's other Field helpers. */
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
