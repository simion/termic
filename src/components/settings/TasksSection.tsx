// Task settings: what happens when a task is created (branch naming, base
// refresh, worktree config) and how tasks behave once they exist (tab close
// confirmation, queued-message pacing).
//
// Split out of General, where "Fetch base before creating a task" and
// "Worktree config symlinks" sat fifteen rows apart despite both being
// new-task settings.

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { settingsSave } from "@/lib/ipc";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Settings } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { usePrefs } from "@/store/prefs";
import { Block, ListField, SectionTitle, Toggle, useBackendSettings, useTasksPathConflicts } from "./Controls";
import { cleanLines } from "@/lib/utils";
import {
  PORT_RANGE_DEFAULT, PORT_RANGE_FLOOR, portRangeError, resolvePortRange, tasksThatFit,
} from "@/lib/portRange";

/** Drop trailing slashes so the "where tasks go" preview never reads
 *  `~/work//<project>`. Keeps a bare `/` intact. */
function trimSlashes(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t || p;
}

export function TasksSection() {
  const { t } = useTranslation("settings");
  const { settings, store, patch } = useBackendSettings();
  const [busy, setBusy] = useState(false);
  // Pre-create base fetch (GH #79). Backend Settings field; saved immediately
  // on toggle. Absent in settings = on.
  const [fetchBeforeCreate, setFetchBeforeCreate] = useState(true);
  // Worktree config-dir symlinks (personal). One path per line, cleaned on
  // save. Empty disables the linking; absent in settings means the pre-filled
  // agent-dir defaults.
  const [symlinkPaths, setSymlinkPaths] = useState("");
  const [symlinkPathsOriginal, setSymlinkPathsOriginal] = useState("");
  // Global default tasks path. A REQUIRED field carrying a real value (the
  // backend seeds `~/termic/tasks`), not a placeholder over an empty box, so
  // the user can see and edit the default rather than guess at it.
  const [tasksPath, setTasksPath] = useState("");
  const [tasksPathOriginal, setTasksPathOriginal] = useState("");
  // Task port range (GH #271). Held as strings so the inputs can be cleared
  // mid-edit without the value snapping to 0; 0/absent in settings means the
  // default, and the fields show that default rather than an empty box, so
  // the range in force is always visible.
  const [portMin, setPortMin] = useState(String(PORT_RANGE_DEFAULT.min));
  const [portMax, setPortMax] = useState(String(PORT_RANGE_DEFAULT.max));
  const [portRangeOriginal, setPortRangeOriginal] = useState("");

  const branchPrefix = usePrefs(s => s.branchPrefix);
  const setBranchPrefix = usePrefs(s => s.setBranchPrefix);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const setUseBranchAsTaskName = usePrefs(s => s.setUseBranchAsTaskName);
  const queueMinIntervalMs = usePrefs(s => s.queueMinIntervalMs);
  const setQueueMinIntervalMs = usePrefs(s => s.setQueueMinIntervalMs);
  const confirmBeforeCloseAgentTab = usePrefs(s => s.confirmBeforeCloseAgentTab);
  const setConfirmBeforeCloseAgentTab = usePrefs(s => s.setConfirmBeforeCloseAgentTab);
  const confirmBeforeArchiveTask = usePrefs(s => s.confirmBeforeArchiveTask);
  const confirmBeforeAccountRestart = usePrefs(s => s.confirmBeforeAccountRestart);
  const setConfirmBeforeAccountRestart = usePrefs(s => s.setConfirmBeforeAccountRestart);
  const setConfirmBeforeArchiveTask = usePrefs(s => s.setConfirmBeforeArchiveTask);
  const archiveDeleteBranch = usePrefs(s => s.archiveDeleteBranch);
  const setArchiveDeleteBranch = usePrefs(s => s.setArchiveDeleteBranch);

  const hydrated = useRef(false);
  useEffect(() => {
    if (!settings || hydrated.current) return;
    hydrated.current = true;
    setFetchBeforeCreate(settings.fetch_before_create !== false);
    const links = (settings.worktree_symlink_paths ?? []).join("\n");
    setSymlinkPaths(links);
    setSymlinkPathsOriginal(links);
    const p = settings.default_tasks_path ?? "";
    setTasksPath(p);
    setTasksPathOriginal(p);
    const r = resolvePortRange(settings.task_port_min, settings.task_port_max);
    setPortMin(String(r.min));
    setPortMax(String(r.max));
    setPortRangeOriginal(`${r.min}-${r.max}`);
  }, [settings]);

  const symlinkDirty = symlinkPaths !== symlinkPathsOriginal;
  const trimmedTasksPath = tasksPath.trim();
  const tasksPathDirty = trimmedTasksPath !== tasksPathOriginal;
  // Which half of the setting's contract the typed value lands in. Relative
  // paths behave completely differently (per-repo, not one shared root), so
  // the preview below has to say which one is in play as the user types.
  // Must mirror `is_absolute_location` in lib.rs exactly. `~work` is NOT
  // absolute there (only `~` or a `~/` prefix is), so a looser test here
  // would preview one layout while the backend built the other.
  const tasksPathIsAbsolute = /^\/|^~$|^~\//.test(trimmedTasksPath);

  // Only check what the user has actually typed: on mount the field holds the
  // saved value, which was already validated when it was saved.
  const { names: conflicts, checking } = useTasksPathConflicts(
    tasksPathDirty ? trimmedTasksPath : "",
  );
  // One rule, one place — the save guard and the button's disabled state used
  // to spell it out separately. `checking` keeps the button dead while the
  // freshly-typed value is still being judged.
  const canSaveTasksPath =
    tasksPathDirty && !!trimmedTasksPath && !checking && conflicts.length === 0;
  const conflictNames = conflicts.length > 3
    ? `${conflicts.slice(0, 3).join(", ")}, and ${conflicts.length - 3} more`
    : conflicts.join(", ");

  async function saveFetchBeforeCreate(v: boolean) {
    setFetchBeforeCreate(v);
    if (!(await patch({ fetch_before_create: v }))) setFetchBeforeCreate(!v);
  }

  async function saveSymlinkPaths() {
    if (!settings) return;
    setBusy(true);
    try {
      const cleaned = cleanLines(symlinkPaths);
      const next: Settings = { ...settings, worktree_symlink_paths: cleaned };
      await settingsSave(next);
      store(next);
      setSymlinkPaths(cleaned.join("\n"));
      setSymlinkPathsOriginal(cleaned.join("\n"));
    } finally { setBusy(false); }
  }

  async function saveTasksPath() {
    if (!settings || !canSaveTasksPath) return;
    setBusy(true);
    try {
      // `patch` reads through useBackendSettings' ref and reverts on failure,
      // so a second save in the same session can't resurrect a stale object.
      if (await patch({ default_tasks_path: trimmedTasksPath })) {
        setTasksPath(trimmedTasksPath);
        setTasksPathOriginal(trimmedTasksPath);
      }
    } finally { setBusy(false); }
  }

  // Number() over parseInt: "3000abc" should be rejected, not silently read
  // as 3000. NaN then fails portRangeError's integer check.
  const portMinNum = Number(portMin);
  const portMaxNum = Number(portMax);
  const portRangeMsg = portRangeError(portMinNum, portMaxNum);
  const portRangeDirty = `${portMinNum}-${portMaxNum}` !== portRangeOriginal;
  const canSavePortRange = portRangeDirty && !portRangeMsg;

  async function savePortRange() {
    if (!settings || !canSavePortRange) return;
    setBusy(true);
    try {
      // Both fields always go together: a half-set pair resolves against the
      // DEFAULT for the missing half, which for a low range reads as inverted
      // and silently falls back (see `settings_resolve_to_a_usable_range`).
      if (await patch({ task_port_min: portMinNum, task_port_max: portMaxNum })) {
        setPortRangeOriginal(`${portMinNum}-${portMaxNum}`);
      }
    } finally { setBusy(false); }
  }

  async function browseTasksPath() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setTasksPath(sel);
  }

  const prefixPreview = (() => {
    const p = branchPrefix.trim().replace(/^\/+|\/+$/g, "");
    return p ? `${p}/my-task` : "my-task";
  })();

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title={t("rail.tasks")} />

      {/* Global default tasks path. Absolute = one shared root holding every
          project, a folder each (what Termic has always done). Relative = each
          project keeps its worktrees inside its own directory. Required, and
          seeded with the built-in default so the value is always visible. */}
      <Block first>
        <div className="text-[14px] font-medium">{t("tasks.path.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          <Trans
            t={t}
            i18nKey="tasks.path.hint"
            components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <Input
            value={tasksPath}
            onChange={(e) => setTasksPath(e.target.value)}
            className="font-mono"
            data-testid="default-tasks-path-input"
          />
          <Button variant="secondary" onClick={browseTasksPath}>{t("common:browse")}</Button>
        </div>
        <div className="mt-1.5 text-[12.5px] text-[var(--color-fg-faint)]">
          {!trimmedTasksPath && (
            <span className="text-[var(--color-err)]">{t("tasks.path.required")}</span>
          )}
          {!!trimmedTasksPath && conflicts.length > 0 && (
            <span className="text-[var(--color-err)]" data-testid="default-tasks-path-conflict">
              {conflicts.length === 1
                ? t("tasks.path.conflictOne", { names: conflictNames })
                : t("tasks.path.conflictMany", { count: conflicts.length, names: conflictNames })}
            </span>
          )}
          {!!trimmedTasksPath && conflicts.length === 0 && (
            <>
              {t("tasks.path.preview")}{" "}
              <code className="font-mono" data-testid="default-tasks-path-preview">
                {tasksPathIsAbsolute
                  ? `${trimSlashes(trimmedTasksPath)}/<project>/<task>`
                  : `<project>/${trimSlashes(trimmedTasksPath.replace(/^\.\//, ""))}/<task>`}
              </code>
            </>
          )}
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!canSaveTasksPath || busy} onClick={saveTasksPath}>
            {busy ? t("common:saving") : t("tasks.path.save")}
          </Button>
        </div>
      </Block>

      <Block>
        <div className="text-[14px] font-medium">{t("tasks.branchPrefix.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          <Trans
            t={t}
            i18nKey="tasks.branchPrefix.hint"
            values={{ preview: prefixPreview }}
            components={{ 1: <code className="font-mono" /> }}
          />
        </div>
        <div className="mt-2 max-w-xs">
          <Input value={branchPrefix} onChange={(e) => setBranchPrefix(e.target.value)} placeholder="feature" className="font-mono" />
        </div>
      </Block>

      {/* GH #260. Sits next to the branch prefix because both are about what
          a task ends up called. The typed name is not lost: it stays in the
          row tooltip and is still what rename edits. */}
      <Block>
        <Toggle
          label={t("tasks.branchName.label")}
          hint={t("tasks.branchName.hint")}
          value={useBranchAsTaskName}
          onChange={setUseBranchAsTaskName}
        />
      </Block>

      <Block>
        <Toggle
          label={t("tasks.fetch.label")}
          hint={t("tasks.fetch.hint")}
          value={fetchBeforeCreate}
          onChange={saveFetchBeforeCreate}
        />
      </Block>

      {/* Task port range (GH #271). Sits with the other new-task settings
          because that is the only thing it affects: a task's ports are frozen
          when it is created, so this never moves a live one. */}
      <Block>
        <div className="text-[14px] font-medium">{t("tasks.ports.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          <Trans
            t={t}
            i18nKey="tasks.ports.hint"
            components={{ 1: <code className="font-mono" /> }}
          />
        </div>
        <div className="mt-2 flex max-w-sm items-center gap-2">
          <Input
            type="number"
            min={PORT_RANGE_FLOOR}
            max={65535}
            value={portMin}
            onChange={(e) => setPortMin(e.target.value)}
            className="w-28 font-mono"
            data-testid="task-port-min-input"
          />
          <span className="text-[12.5px] text-[var(--color-fg-dim)]">{t("tasks.ports.to")}</span>
          <Input
            type="number"
            min={PORT_RANGE_FLOOR}
            max={65535}
            value={portMax}
            onChange={(e) => setPortMax(e.target.value)}
            className="w-28 font-mono"
            data-testid="task-port-max-input"
          />
        </div>
        <div className="mt-1.5 text-[12.5px] text-[var(--color-fg-faint)]">
          {portRangeMsg ? (
            <span className="text-[var(--color-err)]" data-testid="task-port-range-error">{portRangeMsg}</span>
          ) : (
            <span data-testid="task-port-range-hint">
              {t("tasks.ports.room", { count: tasksThatFit(portMinNum, portMaxNum) })}
              {portMinNum < PORT_RANGE_DEFAULT.min ? t("tasks.ports.lowWarn") : ""}
            </span>
          )}
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!canSavePortRange || busy} onClick={savePortRange}>
            {busy ? t("common:saving") : t("tasks.ports.save")}
          </Button>
        </div>
      </Block>

      {/* Worktree config symlinks (personal). A project's agent config
          (.claude/, .mcp.json etc.) is often gitignored, so a plain worktree
          checkout omits it and agents there lose their project subagents,
          skills and MCP servers. These repo-root paths get symlinked into each
          new worktree task. Only ones that exist in the repo are linked; clear
          the list to disable. Files as well as dirs (GH #251). */}
      <Block>
        <div className="text-[14px] font-medium">{t("tasks.symlinks.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("tasks.symlinks.hint")}
        </div>
        <div className="mt-3">
          <ListField label={t("tasks.symlinks.label")} placeholder={".claude\n.gemini\n.codex\n.mcp.json"} value={symlinkPaths} onChange={setSymlinkPaths} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!symlinkDirty || busy} onClick={saveSymlinkPaths}>
            {busy ? t("common:saving") : t("tasks.symlinks.save")}
          </Button>
        </div>
      </Block>

      <Block>
        <div className="text-[14px] font-medium">{t("tasks.queue.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("tasks.queue.hint")}
        </div>
        <div className="mt-2 flex max-w-xs items-center gap-2">
          <Input
            type="number"
            min={0}
            max={120}
            value={Math.round(queueMinIntervalMs / 1000)}
            onChange={(e) => setQueueMinIntervalMs((Number(e.target.value) || 0) * 1000)}
            className="w-24 font-mono"
          />
          <span className="text-[12.5px] text-[var(--color-fg-dim)]">{t("tasks.queue.seconds")}</span>
        </div>
      </Block>

      <Block>
        <Toggle
          label={t("tasks.confirmClose.label")}
          hint={t("tasks.confirmClose.hint")}
          value={confirmBeforeCloseAgentTab}
          onChange={setConfirmBeforeCloseAgentTab}
        />
      </Block>

      {/* The dialog's "Show this every time" checkbox writes this toggle, so
          anyone who unticked it there has a visible way back. */}
      <Block>
        <Toggle
          label={t("tasks.confirmArchive.label")}
          hint={t("tasks.confirmArchive.hint")}
          value={confirmBeforeArchiveTask}
          onChange={setConfirmBeforeArchiveTask}
        />
      </Block>

      {/* Always shown, whichever way the confirmation toggle is set. With the
          dialog on it seeds that dialog's checkbox, which is still the answer
          for that one archive; with the dialog off it IS the answer. Hiding it
          while confirmation was on meant a user who deletes branches every
          time had to re-tick the box on every single archive, with no way to
          change the default. */}
      {/* Same shape as the archive toggle above, and here for the same
          reason: its dialog can turn itself off, and a dialog you dismissed
          once is otherwise unreachable. */}
      <Block>
        <Toggle
          label={t("tasks.confirmRestart.label")}
          hint={t("tasks.confirmRestart.hint")}
          value={confirmBeforeAccountRestart}
          onChange={setConfirmBeforeAccountRestart}
        />
      </Block>

      <Block>
        <Toggle
          label={t("tasks.deleteBranch.label")}
          hint={confirmBeforeArchiveTask ? t("tasks.deleteBranch.hintOn") : t("tasks.deleteBranch.hintOff")}
          value={archiveDeleteBranch}
          onChange={setArchiveDeleteBranch}
        />
      </Block>
    </div>
  );
}
