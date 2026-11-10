// The status bar's one cage control (docs/ui.md "The cage chip"): one pill,
// two targets. The left part, `<mode> · <role>`, opens the settings popover
// (sandbox mode, the credential-store block, the Secrets role, YOLO); the
// tail, when something needs you, opens the wide Activity dialog. FooterBar
// owns the 2s poll and hands its counts down, so the chip adds none.

import { useEffect, useRef, useState } from "react";
import { enforcing } from "@/components/secretsUi/RolePicker";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, ChevronDown, KeyRound, Lock, Zap } from "lucide-react";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
import { SandboxIcon, DockerSandboxIcon, sandboxModeText } from "@/components/SandboxIcon";
import { cn } from "@/lib/utils";
import * as ipc from "@/lib/ipc";
import { cageChipState, type CageChipState, type CageMode } from "@/lib/cageChip";
import { effectiveSandboxMode, keychainBlocked, type BrokerCounts, type Role, type SandboxMode, type Task } from "@/lib/types";
import { roleColour } from "@/lib/secretsUi";
import { roleSecrets, useShellRoles } from "@/lib/shellSecrets";
import { dockerToggleMessage, leaveDockerMessage } from "@/lib/sandboxSwitchCopy";
import { restartTaskAgents } from "@/lib/accountRestart";
import { taskLabel } from "@/lib/taskLabel";
import { agentDisplayName } from "@/lib/agents";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { useSecrets } from "@/store/secrets";

export type CageTask = Pick<Task, "id" | "project_id" | "name" | "branch"> & Partial<Omit<Task, "id" | "project_id" | "name" | "branch">>;


export function CageChip({ task, sandboxWarning, total, kcOpen, counts, shellCounts, role, configured }: {
  task: CageTask;
  sandboxWarning: string | null;
  /** the cage's own count: denies, or accesses in Monitor. */
  total: number;
  kcOpen: number | null;
  counts: BrokerCounts | null;
  /** the task's role shells' counts (active task only). */
  shellCounts: (BrokerCounts | null)[];
  role: Role | null;
  configured: Role | null;
}) {
  const { t } = useTranslation("task");
  const { t: tS } = useTranslation("secrets");
  const { t: tChrome } = useTranslation("chrome");
  const [open, setOpen] = useState(false);
  // roles only on macOS (the broker's platform); empty hides "No secrets".
  const roles = useShellRoles();
  const st = cageChipState(task, counts, total, role, configured, { roles: useSecrets.getState().roles, kcOpen, shells: shellCounts });
  const r = st.role;
  const tail = st.tail;
  const suspicious = tail?.kind === "suspicious";
  const noSecrets = !r && roles.length > 0 && st.mode !== "docker";
  // the store block's state, for specs: a pending block reads "restart to
  // apply" on the chip too.
  const kcState = keychainBlocked(task) && kcOpen !== null ? (kcOpen > 0 ? "pending" : "blocked") : undefined;
  const modeLabel = st.mode === "docker" ? t("cage.modeDocker")
    : st.mode === "off" ? t("footer.sandboxOff")
    : sandboxModeText(st.mode, tChrome).shortLabel;

  return (
    <span data-testid="cage-chip-group" className={cn(
      "flex min-w-0 shrink items-stretch rounded",
      suspicious && "bg-[var(--color-err)]/10",
    )}>
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="cage-chip"
            data-mode={st.mode}
            data-role={r?.applied ? r.role.id : undefined}
            data-saved-role={r?.applied ? (st.savedRole ?? r.role).id : undefined}
            data-unapplied-role={r && !r.applied ? r.role.id : undefined}
            data-tail={tail?.kind}
            data-keychain={kcState}
            onClick={e => e.stopPropagation()}
            title={sandboxWarning ?? t("cage.chipTip")}
            className="flex min-w-0 shrink items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
          >
            {sandboxWarning ? (<>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
              <span className="shrink-0 font-medium">{t("footer.sandboxDegraded")}</span>
              <span className="text-[var(--color-fg-faint)]">·</span>
              <span className="truncate">{sandboxWarning}</span>
            </>) : (<>
              {st.mode === "docker"
                ? <DockerSandboxIcon className="h-3.5 w-3.5 shrink-0" />
                : <SandboxIcon mode={st.mode} className="h-3.5 w-3.5 shrink-0" />}
              <span className="whitespace-nowrap @max-[560px]:hidden">{modeLabel}</span>
            </>)}
            {r && (<>
              <span className="text-[var(--color-fg-faint)]">·</span>
              <KeyRound className="h-3.5 w-3.5 shrink-0" style={{ color: suspicious ? "var(--color-err)" : r.applied ? roleColour(r.role.colour) : "var(--color-warn)" }} />
              <span className={cn("whitespace-nowrap @max-[560px]:hidden", !r.applied && "text-[var(--color-warn)] line-through")}>{r.role.name}</span>
            </>)}
            {noSecrets && (<>
              <span className="text-[var(--color-fg-faint)]">·</span>
              <span data-testid="cage-chip-no-secrets" className="whitespace-nowrap text-[var(--color-fg-faint)] @max-[560px]:hidden">{tS("task.noSecrets")}</span>
            </>)}
            {st.pending && (
              <span data-testid="cage-chip-pending" className="whitespace-nowrap text-[var(--color-fg-faint)] @max-[560px]:hidden">· {t("cage.restartToApply")}</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[440px] max-w-[calc(100vw-2rem)] p-0 text-[12.5px]">
          {open && <CageSettings task={task} st={st} close={() => setOpen(false)} />}
        </PopoverContent>
      </PopoverRoot>
      {tail && (
        <button
          type="button"
          data-testid="cage-chip-tail"
          data-tail={tail.kind}
          // a toggle: the panel blocks nothing, so the tail is also its off switch.
          onClick={e => {
            e.stopPropagation();
            const ui = useUI.getState();
            if (ui.cageActivity?.taskId === task.id) ui.closeCageActivity(); else ui.openCageActivity(task.id);
          }}
          title={t("cage.tailTip")}
          className={cn(
            "flex shrink-0 items-center whitespace-nowrap rounded px-1.5 py-0.5 hover:bg-[var(--color-bg-2)]",
            tail.kind === "suspicious" ? "text-[var(--color-err)]" : tail.kind === "accesses" ? "text-[var(--color-fg-faint)]" : "text-[var(--color-warn)]",
          )}
        >
          {tail.kind === "suspicious" ? t("cage.chipSuspicious", { count: tail.count })
            : tail.kind === "paused" ? t("cage.chipPaused")
            : tail.kind === "blocked" ? t("cage.chipBlocked", { count: tail.count })
            : t(tail.count === 1 ? "denied.accessesBadgeOne" : "denied.accessesBadgeOther", { count: tail.count })}
        </button>
      )}
    </span>
  );
}

/** Allow-lists for a cage turned on from scratch: the global + project
 *  defaults (same seeding as TaskSandboxDialog.chooseMode), or the task's
 *  own when it has any. */
async function cageLists(task: CageTask): Promise<{ rw: string[]; hosts: string[] }> {
  const rw = task.sandbox_rw_paths ?? [];
  const hosts = task.sandbox_allowed_hosts ?? [];
  if (rw.length || hosts.length) return { rw, hosts };
  const s = await ipc.settingsLoad().catch(() => null);
  const p = useApp.getState().projects.find(x => x.id === task.project_id);
  const merge = (...ls: (string[] | undefined)[]) => [...new Set(ls.flatMap(l => l ?? []).filter(Boolean))];
  return {
    rw: merge(s?.sandbox_default_rw_paths, p?.sandbox_rw_paths),
    hosts: merge(s?.sandbox_default_allowed_hosts, p?.sandbox_allowed_hosts),
  };
}

type Draft = { mode: SandboxMode; block: boolean; role: string; yolo: boolean };

const MODES: SandboxMode[] = ["off", "monitor", "enforce-fs", "enforce"];

/** Settings, no lists (those stay in the Sandbox dialog): one row per
 *  thing, each led by the glyph the chip and the sidebar already use. Edits
 *  are a draft until Save or Save & restart, like the Sandbox dialog;
 *  Docker switches at once with its own confirm, as it does there. */
function CageSettings({ task, st, close }: { task: CageTask; st: CageChipState; close: () => void }) {
  const { t } = useTranslation("task");
  const { t: tS } = useTranslation("secrets");
  const { t: tD } = useTranslation("dialogs");
  const { t: tChrome } = useTranslation("chrome");
  const roles = useShellRoles();
  const secrets = useSecrets(s => s.secrets);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const agent = agentDisplayName(task.cli ?? "claude");
  const name = taskLabel(task as Task, useBranchAsTaskName);
  const docker = !!task.docker_sandbox_enabled;

  const saved: Draft = {
    mode: effectiveSandboxMode(task),
    block: !!task.sandbox_block_keychain,
    role: task.role ?? "",
    yolo: !!task.yolo,
  };
  const [draft, setDraft] = useState<Draft>(saved);
  const [busy, setBusy] = useState(false);

  // Docker is offered once Settings has it on AND an image is built.
  const [dockerOffered, setDockerOffered] = useState(false);
  useEffect(() => {
    void Promise.all([ipc.settingsLoad().catch(() => null), ipc.dockerImageStatus().catch(() => null)])
      .then(([s, img]) => setDockerOffered(!!s?.docker_sandbox_enabled && !!img?.available));
  }, []);

  const caged = docker || enforcing(draft.mode);
  const blockApplies = !docker && enforcing(draft.mode);
  const sandboxDirty = !docker && (draft.mode !== saved.mode || (blockApplies && draft.block !== saved.block));
  const dirty = sandboxDirty || draft.role !== saved.role || (!caged && draft.yolo !== saved.yolo);

  // the mode and block a role pick switched the cage on from, so taking the
  // role back off ("No secrets") puts the cage back as it was.
  const cageBeforeRole = useRef<{ mode: SandboxMode; block: boolean } | null>(null);

  function pickMode(m: SandboxMode) {
    if (docker) { void leaveDocker(m); return; }
    cageBeforeRole.current = null;
    // leaving the enforcing modes takes the role with it (Rust drops it too);
    // entering one with a role turns the store block on, which a role needs.
    setDraft(d => enforcing(m) ? { ...d, mode: m, block: d.role ? true : d.block } : { ...d, mode: m, role: "" });
  }
  function setBlock(v: boolean) {
    cageBeforeRole.current = null;
    setDraft(d => ({ ...d, block: v, role: v ? d.role : "" }));
  }
  function pickRole(id: string) {
    // a role needs the cage: picking one on an uncaged draft turns it on,
    // the same as New Task does.
    const before = cageBeforeRole.current;
    if (!id && before) {
      cageBeforeRole.current = null;
      setDraft(d => ({ ...d, role: "", ...before }));
      return;
    }
    if (id && !(enforcing(draft.mode) && draft.block) && !before) {
      cageBeforeRole.current = { mode: draft.mode, block: draft.block };
    }
    setDraft(d => id && !(enforcing(d.mode) && d.block)
      ? { ...d, role: id, mode: d.mode === "enforce" ? "enforce" : "enforce-fs", block: true }
      : { ...d, role: id });
  }

  async function save(restart: boolean) {
    if (busy || !dirty) return;
    setBusy(true);
    try {
      const block = blockApplies ? draft.block : undefined;
      let lists: { rw: string[]; hosts: string[] } | null = null;
      if (sandboxDirty) {
        lists = await cageLists(task);
        await ipc.taskSetSandbox(task.id, draft.mode, lists.rw, lists.hosts, false, block);
      }
      // after the cage: Rust refuses a role until the store block is on.
      if (draft.role !== saved.role) await ipc.taskSetRole(task.id, draft.role);
      if (!caged && draft.yolo !== saved.yolo) {
        useApp.getState().setTaskYolo(task.id, draft.yolo);
        await ipc.taskSetYolo(task.id, draft.yolo);
      }
      if (restart) {
        if (lists) {
          // the kill comes last, so the respawn reads the new role too.
          useUI.getState().markPendingPtyRestart(task.id);
          await ipc.taskSetSandbox(task.id, draft.mode, lists.rw, lists.hosts, true, block);
        } else {
          restartTaskAgents(task.id);
        }
      }
      await useApp.getState().loadAll();
      close();
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      setBusy(false);
    }
  }

  async function turnOnDocker() {
    const ok = await useUI.getState().askConfirm({
      title: tD("taskSandbox.dockerToggleTitleRun", { name }),
      // Docker cannot carry a role, so the switch drops it (task_set_docker).
      message: dockerToggleMessage(true) + (savedRoleName ? " " + tD("taskSandbox.dropsRole", { role: savedRoleName }) : ""),
      confirmLabel: tD("taskSandbox.confirmRunDocker"),
    });
    if (!ok) return;
    try {
      useUI.getState().markPendingPtyRestart(task.id);
      // the mounts go back explicitly: task_set_docker assigns them.
      await ipc.taskSetDocker(task.id, true, task.docker_extra_args ?? [], task.docker_extra_mounts ?? []);
      await useApp.getState().loadAll();
      close();
    } catch (e) { useUI.getState().pushToast(String(e), "error"); }
  }
  async function leaveDocker(next: SandboxMode) {
    const ok = await useUI.getState().askConfirm({
      title: tD("taskSandbox.leaveDockerTitle", { name }),
      message: leaveDockerMessage(next === "off" ? "off" : "seatbelt")
        + (task.sandbox_block_keychain && enforcing(next) ? " " + tD("taskSandbox.leaveDockerKeychainNote") : ""),
      confirmLabel: next === "off" ? tD("taskSandbox.confirmStopDocker") : tD("taskSandbox.confirmSwitchSeatbelt"),
    });
    if (!ok) return;
    try {
      useUI.getState().markPendingPtyRestart(task.id);
      // the cage is recorded first, so there is no window with neither.
      const lists = await cageLists(task);
      await ipc.taskSetSandbox(task.id, next, lists.rw, lists.hosts, false);
      await ipc.taskSetDocker(task.id, false, task.docker_extra_args ?? [], task.docker_extra_mounts ?? []);
      await useApp.getState().loadAll();
      close();
    } catch (e) { useUI.getState().pushToast(String(e), "error"); }
  }

  const shownMode: CageMode = docker ? "docker" : draft.mode;
  const modeText = shownMode === "docker" ? t("cage.modeDocker") : sandboxModeText(shownMode, tChrome).shortLabel;
  const modeDetail = shownMode === "docker" ? t("cage.dockerDetail")
    : shownMode === "off" ? t("cage.offDetail")
    : shownMode === "monitor" ? t("cage.monitorDetail")
    : shownMode === "enforce-fs" ? t("cage.enforceFsDetail") : t("cage.enforceDetail");
  const pickedRole = roles.find(r => r.id === draft.role) ?? null;
  const savedRoleName = saved.role ? roles.find(r => r.id === saved.role)?.name ?? saved.role : null;
  const roleTurnedCageOn = !!draft.role && draft.role !== saved.role && (saved.mode !== draft.mode || saved.block !== draft.block);
  const roleDropped = !!savedRoleName && !draft.role && draft.role !== saved.role;
  // a role saved on a task that cannot carry it (no cage, no block): one
  // click puts both back, the same fix the old notice chip had.
  const unapplied = !docker && !!draft.role && !(enforcing(draft.mode) && draft.block);
  const blocked = st.tail && st.tail.kind !== "paused" && st.tail.kind !== "accesses" ? st.tail.count : 0;

  const glyphBtn = (m: CageMode, label: string, on: boolean, onClick: () => void) => (
    <button key={m} type="button" role="radio" aria-checked={on} aria-label={label} title={label}
      data-testid={`cage-mode-${m}`} onClick={onClick}
      className={cn("flex h-7 w-8 items-center justify-center border-l border-[var(--color-border)] first:border-l-0",
        on ? "bg-[var(--color-bg-2)] shadow-[inset_0_-2px_0_var(--color-ok)]" : "hover:bg-[var(--color-hover)]")}>
      {m === "docker" ? <DockerSandboxIcon className="h-3.5 w-3.5" /> : <SandboxIcon mode={m} className="h-3.5 w-3.5" />}
    </button>
  );
  const sw = (on: boolean, onChange: (v: boolean) => void, disabled: boolean, testId: string, label: string) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} data-testid={testId}
      onClick={() => onChange(!on)}
      className={cn("relative h-4 w-7 shrink-0 rounded-full transition-none disabled:opacity-45",
        on ? "bg-[var(--color-ok)]" : "bg-[var(--color-border)]")}>
      <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white", on ? "right-0.5" : "left-0.5")} />
    </button>
  );
  const row = (icon: React.ReactNode, title: React.ReactNode, detail: React.ReactNode, control: React.ReactNode, testId: string) => (
    <div data-testid={testId} className="flex items-center gap-2.5 border-t border-[var(--color-border-soft)] py-2.5">
      <span className="flex w-5 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-[var(--color-fg)]">{title}</span>
        <span className="block text-[11.5px] leading-snug text-[var(--color-fg-faint)]">{detail}</span>
      </span>
      {control}
    </div>
  );

  return (
    <div data-testid="cage-settings" className="flex flex-col px-4 pb-3 pt-3">
      <div className="flex items-center gap-2 pb-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--color-fg)]">{t("cage.settingsTitle", { agent, task: name })}</span>
        <button type="button" data-testid="cage-open-activity" onClick={() => { close(); useUI.getState().openCageActivity(task.id); }}
          className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
          {t("cage.activity")}{blocked > 0 && <span className="text-[var(--color-warn)]"> · {blocked}</span>}
        </button>
      </div>

      {row(
        shownMode === "docker" ? <DockerSandboxIcon className="h-4 w-4" /> : <SandboxIcon mode={shownMode} className="h-4 w-4" />,
        modeText, modeDetail,
        <span role="radiogroup" aria-label={t("cage.rowSandbox")} className="flex shrink-0 overflow-hidden rounded-md border border-[var(--color-border)]">
          {MODES.map(m => glyphBtn(m, sandboxModeText(m, tChrome).label, !docker && draft.mode === m, () => pickMode(m)))}
          {(dockerOffered || docker) && glyphBtn("docker", t("cage.modeDocker"), docker, () => { if (!docker) void turnOnDocker(); })}
        </span>,
        "cage-row-sandbox",
      )}

      {row(
        <Lock className="h-4 w-4" style={{ color: blockApplies && draft.block ? "var(--color-ok)" : "var(--color-fg-faint)" }} />,
        blockApplies && draft.block ? t("cage.storesBlocked") : t("cage.storesOpen"),
        blockApplies ? t("cage.storesHint") : t("cage.storesNeedsCage"),
        sw(blockApplies && draft.block, setBlock, !blockApplies, "cage-block-stores", t("cage.storesBlocked")),
        "cage-row-stores",
      )}

      {(roles.length > 0 || savedRoleName) && row(
        <KeyRound className="h-4 w-4" style={{ color: pickedRole ? roleColour(pickedRole.colour) : "var(--color-fg-faint)" }} />,
        t("cage.rowRole"),
        docker ? t("cage.notAppliedDocker")
          : pickedRole ? roleSecrets(pickedRole, secrets).map(s => s.name).join(", ") || tS("task.noSecrets")
          : t("cage.roleNoneDetail"),
        <DropdownRoot>
          <DropdownTrigger asChild>
            <button type="button" data-testid="cage-role" disabled={docker}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[12.5px] text-[var(--color-fg)] hover:bg-[var(--color-hover)] disabled:opacity-45">
              <span aria-hidden className="h-2 w-2 rounded-full" style={pickedRole ? { background: roleColour(pickedRole.colour) } : { border: "1px dashed var(--color-fg-faint)" }} />
              {pickedRole?.name ?? tS("task.noSecrets")}
              <ChevronDown className="h-3 w-3 text-[var(--color-fg-faint)]" />
            </button>
          </DropdownTrigger>
          <DropdownMenu align="end">
            {[null, ...roles].map(r => (
              <DropdownItem key={r?.id ?? "none"} data-role-option={r?.id ?? "none"} onSelect={() => pickRole(r?.id ?? "")}>
                <span className="flex items-center gap-2 text-[13px]">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={r ? { background: roleColour(r.colour) } : { border: "1px dashed var(--color-fg-faint)" }} />
                  {r?.name ?? tS("task.noSecrets")}
                  {r && <span className="text-[11.5px] text-[var(--color-fg-faint)]">{roleSecrets(r, secrets).map(s => s.name).join(", ")}</span>}
                  {(r?.id ?? "") === draft.role && <Check className="h-3.5 w-3.5 text-[var(--color-fg-dim)]" />}
                </span>
              </DropdownItem>
            ))}
            <DropdownSeparator />
            <DropdownItem data-testid="secrets-role-link" onSelect={() => {
              close();
              useApp.getState().openSettings("secrets", undefined, pickedRole ? `role:${pickedRole.id}` : undefined);
            }}>
              <span className="text-[12.5px]">{pickedRole ? t("cage.editRole", { role: pickedRole.name }) : t("cage.manageRoles")}</span>
            </DropdownItem>
            <div className="max-w-[260px] px-2 py-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">{t("cage.roleMenuNote")}</div>
          </DropdownMenu>
        </DropdownRoot>,
        "cage-row-role",
      )}
      {unapplied && (
        <Note testId="cage-role-unapplied" warn>
          {t("cage.roleUnapplied", { role: pickedRole?.name ?? draft.role })}{" "}
          <button type="button" data-testid="cage-role-fix" className="underline hover:text-[var(--color-fg)]"
            onClick={() => setDraft(d => ({ ...d, mode: d.mode === "enforce" ? "enforce" : "enforce-fs", block: true }))}>
            {t("cage.roleFix")}
          </button>
        </Note>
      )}
      {roleTurnedCageOn && <Note testId="cage-role-cage-note">{t("cage.roleTurnsCageOn")}</Note>}
      {roleDropped && <Note testId="cage-role-dropped" warn>{t("cage.roleDropped", { role: savedRoleName })}</Note>}

      {row(
        <Zap className="h-4 w-4" fill="none" style={{ color: caged ? "var(--color-ok)" : draft.yolo ? "var(--color-err)" : "var(--color-fg-faint)" }} />,
        t("cage.rowYolo"),
        caged ? t("cage.yoloForced") : draft.yolo ? t("cage.yoloOn") : t("cage.yoloOff"),
        sw(caged || draft.yolo, v => setDraft(d => ({ ...d, yolo: v })), caged, "cage-yolo", t("cage.rowYolo")),
        "cage-row-yolo",
      )}

      <div className="flex items-center gap-2 border-t border-[var(--color-border-soft)] pt-2.5">
        <button type="button" data-testid="cage-edit-sandbox" onClick={() => { close(); useUI.getState().openSandbox(task.id); }}
          className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
          {t("cage.sandboxSettings")}
        </button>
        <span className="flex-1" />
        {dirty ? (<>
          <button type="button" data-testid="cage-save" disabled={busy} onClick={() => void save(false)}
            className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-hover)] disabled:opacity-50">
            {t("cage.save")}
          </button>
          <button type="button" data-testid="cage-save-restart" disabled={busy} onClick={() => void save(true)}
            className="rounded bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-50">
            {t("cage.saveRestart")}
          </button>
        </>) : st.pending ? (
          <button type="button" data-testid="cage-restart" onClick={() => { close(); restartTaskAgents(task.id); }}
            className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-hover)]">
            {tD("editTask.restartAgents")}
          </button>
        ) : null}
      </div>
      {st.pending && !dirty && (
        <div data-testid="secrets-pending-banner" className="pt-1.5 text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
          {st.pendingWhy === "switched" && st.savedRole && st.role
            ? tS("task.pendingBanner", { saved: st.savedRole.name, running: st.role.role.name })
            : st.pendingWhy === "stale" && st.role ? tS("task.staleBanner", { role: st.role.role.name })
            : t("cage.kcPendingBanner")}
        </div>
      )}
    </div>
  );
}

function Note({ children, warn, testId }: { children: React.ReactNode; warn?: boolean; testId?: string }) {
  return (
    <div data-testid={testId} className={cn("-mt-1 pb-2 pl-[30px] text-[11.5px] leading-snug", warn ? "text-[var(--color-warn)]" : "text-[var(--color-fg-faint)]")}>
      {children}
    </div>
  );
}
