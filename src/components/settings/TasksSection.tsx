// Task settings: what happens when a task is created (branch naming, base
// refresh, worktree config) and how tasks behave once they exist (tab close
// confirmation, queued-message pacing).
//
// Split out of General, where "Fetch base before creating a task" and
// "Worktree config symlinks" sat fifteen rows apart despite both being
// new-task settings.

import { useEffect, useRef, useState } from "react";
import { settingsSave } from "@/lib/ipc";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Settings } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { usePrefs } from "@/store/prefs";
import { Block, ListField, SectionTitle, Toggle, useBackendSettings, useTasksPathConflicts } from "./Controls";
import { cleanLines } from "@/lib/utils";

/** Drop trailing slashes so the "where tasks go" preview never reads
 *  `~/work//<project>`. Keeps a bare `/` intact. */
function trimSlashes(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t || p;
}

export function TasksSection() {
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

  const branchPrefix = usePrefs(s => s.branchPrefix);
  const setBranchPrefix = usePrefs(s => s.setBranchPrefix);
  const queueMinIntervalMs = usePrefs(s => s.queueMinIntervalMs);
  const autoResumeOnLimit  = usePrefs(s => s.autoResumeOnLimit);
  const autoResumeMessage  = usePrefs(s => s.autoResumeMessage);
  const autoResumeMarginSec = usePrefs(s => s.autoResumeMarginSec);
  const setAutoResumeOnLimit = usePrefs(s => s.setAutoResumeOnLimit);
  const setAutoResumeMessage = usePrefs(s => s.setAutoResumeMessage);
  const setAutoResumeMarginSec = usePrefs(s => s.setAutoResumeMarginSec);
  const setQueueMinIntervalMs = usePrefs(s => s.setQueueMinIntervalMs);
  const confirmBeforeCloseAgentTab = usePrefs(s => s.confirmBeforeCloseAgentTab);
  const setConfirmBeforeCloseAgentTab = usePrefs(s => s.setConfirmBeforeCloseAgentTab);
  const confirmBeforeArchiveTask = usePrefs(s => s.confirmBeforeArchiveTask);
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
      <SectionTitle title="Tasks" />

      {/* Global default tasks path. Absolute = one shared root holding every
          project, a folder each (what Termic has always done). Relative = each
          project keeps its worktrees inside its own directory. Required, and
          seeded with the built-in default so the value is always visible. */}
      <Block first>
        <div className="text-[14px] font-medium">Default tasks path</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Where new task worktrees are created. A full path (one starting with <code className="font-mono">/</code> or <code className="font-mono">~</code>) keeps every project's tasks under one root, in a folder named after the project. A relative path puts each project's tasks inside that project's own directory instead. Existing tasks never move; this applies to the next one you create.
        </div>
        <div className="mt-2 flex gap-2">
          <Input
            value={tasksPath}
            onChange={(e) => setTasksPath(e.target.value)}
            className="font-mono"
            data-testid="default-tasks-path-input"
          />
          <Button variant="secondary" onClick={browseTasksPath}>Browse…</Button>
        </div>
        <div className="mt-1.5 text-[12.5px] text-[var(--color-fg-faint)]">
          {!trimmedTasksPath && (
            <span className="text-[var(--color-err)]">A tasks path is required.</span>
          )}
          {!!trimmedTasksPath && conflicts.length > 0 && (
            <span className="text-[var(--color-err)]" data-testid="default-tasks-path-conflict">
              {`This lands inside the repo itself for ${
                conflicts.length === 1 ? conflictNames : `${conflicts.length} projects: ${conflictNames}`
              }. New tasks there would be created on top of your working tree. Pick a directory outside the repo, or a subdirectory of it.`}
            </span>
          )}
          {!!trimmedTasksPath && conflicts.length === 0 && (
            <>
              New tasks go to{" "}
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
            {busy ? "Saving…" : "Save tasks path"}
          </Button>
        </div>
      </Block>

      <Block>
        <div className="text-[14px] font-medium">Branch prefix</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Prepended to auto-generated branch names for new tasks (<code className="font-mono">{prefixPreview}</code>). Leave empty for no prefix. You can still edit the branch per task.
        </div>
        <div className="mt-2 max-w-xs">
          <Input value={branchPrefix} onChange={(e) => setBranchPrefix(e.target.value)} placeholder="feature" className="font-mono" />
        </div>
      </Block>

      <Block>
        <Toggle
          label="Fetch base before creating a task"
          hint="Refresh the base branch from its remote (a quick, single-ref git fetch) right before a new task's branch is cut, so it starts from the latest commit instead of a stale local copy. Best-effort: if the remote is offline or unreachable, the task still creates from your local ref. Turn off on flaky networks."
          value={fetchBeforeCreate}
          onChange={saveFetchBeforeCreate}
        />
      </Block>

      {/* Worktree config symlinks (personal). A project's agent config
          (.claude/, .mcp.json etc.) is often gitignored, so a plain worktree
          checkout omits it and agents there lose their project subagents,
          skills and MCP servers. These repo-root paths get symlinked into each
          new worktree task. Only ones that exist in the repo are linked; clear
          the list to disable. Files as well as dirs (GH #251). */}
      <Block>
        <div className="text-[14px] font-medium">Worktree config symlinks</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Repo-root files and folders symlinked into each new worktree task, one per line, so agents keep project config (subagents, skills, commands, MCP servers) that is gitignored out of a plain checkout. Only entries that exist in the repo are linked. Clear the list to turn this off.
        </div>
        <div className="mt-3">
          <ListField label="Paths to symlink" placeholder={".claude\n.gemini\n.codex\n.mcp.json"} value={symlinkPaths} onChange={setSymlinkPaths} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!symlinkDirty || busy} onClick={saveSymlinkPaths}>
            {busy ? "Saving…" : "Save symlink paths"}
          </Button>
        </div>
      </Block>

      <Block>
        <div className="text-[14px] font-medium">Queue send interval</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Minimum delay between consecutive queued messages sent to an agent (the "ralph loop"). Even if the agent finishes faster, or a false "done" fires, the next message waits this long. Set to 0 to disable. "Send now" ignores this and sends immediately.
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
          <span className="text-[12.5px] text-[var(--color-fg-dim)]">seconds</span>
        </div>
      </Block>

      {/* Auto-resume on a usage limit. Ships off: it types into the agent
          with nobody watching, which is the one behaviour that has to be
          asked for. The sub-fields stay visible when it is off so the user
          can see exactly what would be sent before turning it on. */}
      <Block>
        <Toggle
          label="Resume automatically after a usage limit"
          hint={"When an agent stops because your subscription limit is used up, pick the \"wait for the limit to reset\" option for it and send a message once the printed reset time has passed. Never picks an option that costs money (upgrade, usage credits): if the wait option cannot be identified, the prompt is left for you. Off by default."}
          value={autoResumeOnLimit}
          onChange={setAutoResumeOnLimit}
        />
        <div className="mt-3">
          <div className="text-[12.5px] text-[var(--color-fg-dim)]">Message sent when the limit resets</div>
          <Input
            value={autoResumeMessage}
            onChange={(e) => setAutoResumeMessage(e.target.value)}
            placeholder="Continue where you left off."
            className="mt-1.5 max-w-md"
          />
          <div className="mt-1 text-[12px] text-[var(--color-fg-dim)]">
            Leave empty to send a bare Enter instead of text.
          </div>
        </div>
        <div className="mt-3 flex max-w-xs items-center gap-2">
          <Input
            type="number"
            min={0}
            max={3600}
            value={autoResumeMarginSec}
            onChange={(e) => setAutoResumeMarginSec(Number(e.target.value) || 0)}
            className="w-24 font-mono"
          />
          <span className="text-[12.5px] text-[var(--color-fg-dim)]">
            seconds of margin past the printed reset time
          </span>
        </div>
      </Block>

      <Block>
        <Toggle
          label="Confirm before closing an agent tab"
          hint="Ask before closing a non-shell terminal or agent tab. Turning this off (or unchecking it once from the close dialog) closes tabs immediately; a toast then points back to the '+' menu's Resume section to bring one back."
          value={confirmBeforeCloseAgentTab}
          onChange={setConfirmBeforeCloseAgentTab}
        />
      </Block>

      {/* The dialog's "Show this every time" checkbox writes this toggle, so
          anyone who unticked it there has a visible way back. */}
      <Block>
        <Toggle
          label="Confirm before archiving a task"
          hint={"Ask before archiving a task. With this off (or after unticking \"Show this every time\" in the dialog), archiving happens straight away and a toast points at History."}
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
      <Block>
        <Toggle
          label="Delete the branch when archiving"
          hint={confirmBeforeArchiveTask
            ? "Start the archive dialog's \"Delete the git branch\" box ticked. You can still untick it for any single archive. A project's main checkout is never affected."
            : "Archiving also deletes the task's branch. A project's main checkout is never affected."}
          value={archiveDeleteBranch}
          onChange={setArchiveDeleteBranch}
        />
      </Block>
    </div>
  );
}
