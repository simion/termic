// Edit the sandbox config of an existing task. Saving SIGKILLs
// any live PTYs for the task so the next mount picks up the new
// profile - the user has to confirm before that lands. Without the
// kill the running agent would keep its OLD profile's permissions,
// which is exactly the thing we're trying to enforce against.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextareaHTMLAttributes } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { formatDockerArgv } from "@/lib/dockerArgv";
import { taskLabel } from "@/lib/taskLabel";
import {
  settingsLoad, taskSetSandbox, sandboxAvailable, taskSetDocker, dockerImageStatus, dockerCommandPreview,
  type DockerImageStatus, type DockerCommandPreview,
} from "@/lib/ipc";
import { effectiveSandboxMode, type SandboxMode, type SandboxSelection, type Settings } from "@/lib/types";
import { AlertTriangle, Shield, Zap, Save, RotateCw } from "lucide-react";
import { SandboxPicker, DockerEngineNote } from "@/components/SandboxPicker";
import { SANDBOX_PRESETS, presetHint, presetLabel } from "@/lib/sandboxPresets";
import { dockerToggleMessage, leaveDockerMessage } from "@/lib/sandboxSwitchCopy";

export function TaskSandboxDialog() {
  const { t } = useTranslation("dialogs");
  const taskId = useUI(s => s.sandboxForTaskId);
  const close = useUI(s => s.closeSandbox);
  const task = useApp(s => s.tasks.find(w => w.id === taskId) ?? null);
  // The project owns the "current defaults" - drives the "Reset to
  // project defaults" button. Task's frozen lists were seeded
  // from these at creation; if the user since updated the project,
  // this button re-syncs (one click, no auto-overwrite).
  const project = useApp(s => task ? s.projects.find(p => p.id === task.project_id) ?? null : null);
  const agent   = useApp(s => task ? s.agents.find(a => a.id === task.cli) ?? null : null);
  const loadAll = useApp(s => s.loadAll);
  const sandboxBypassPermissions = usePrefs(s => s.sandboxBypassPermissions);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);

  // Local edit state, snapshotted from the task whenever the
  // dialog opens for a new id. Saving pushes back via IPC; cancelling
  // discards. Stored as text so blank lines while typing don't fight
  // the array split.
  const [mode, setMode] = useState<SandboxMode>("off");
  const [rwText,    setRwText]    = useState("");
  const [hostsText, setHostsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);
  // OS sandbox support gate. macOS → true. Linux/Windows → false,
  // and we disable the enable button + show "unavailable" banner.
  // Probed once on mount; cheap (one Path::exists() check) but cached.
  const [osSandboxOk, setOsSandboxOk] = useState<boolean | null>(null);
  useEffect(() => {
    sandboxAvailable().then(setOsSandboxOk).catch(() => setOsSandboxOk(false));
  }, []);

  // Docker sandbox: independent cage, mutually exclusive with Seatbelt
  // (pty_spawn checks it first). Only offered once Settings → Docker Sandbox has
  // the master switch on AND an image is built - otherwise there's
  // nothing for the toggle to do. `taskSetDocker` SIGKILLs + saves
  // immediately, decoupled from the Seatbelt Save button above, so it
  // doesn't get tangled in this dialog's "dirty" tracking.
  const [dockerSettings, setDockerSettings] = useState<Settings | null>(null);
  const [dockerImage, setDockerImage] = useState<DockerImageStatus | null>(null);
  const [dockerBusy, setDockerBusy] = useState(false);
  // Re-fetch every time the dialog opens for a task, not just once at app
  // boot - the global Docker switch (Settings) or the image build can both
  // change while the app stays open, and this dialog instance never
  // unmounts (it renders null when taskId is falsy rather than being
  // removed), so a mount-only effect would go stale for the rest of the
  // session.
  useEffect(() => {
    if (!taskId) return;
    settingsLoad().then(setDockerSettings).catch(() => {});
    dockerImageStatus().then(setDockerImage).catch(() => {});
  }, [taskId]);
  const dockerOffered = !!dockerSettings?.docker_sandbox_enabled && !!dockerImage?.available;
  const dockerOn = !!task?.docker_sandbox_enabled;
  // Derived, not separate state: which cage MECHANISM is active reads
  // straight off the two independent underlying fields (dockerOn from the
  // saved task, mode from the Seatbelt draft), so the unified selector
  // never needs its own source of truth to fall out of sync with either.
  const selection: SandboxSelection = dockerOn ? "docker" : mode;
  // `enabled` = the SEATBELT cage specifically is on. Most of the form
  // (lists, presets, Save buttons) shows only when NOT Docker - Docker
  // being on must never leave a stale non-off `mode` draft (from before
  // switching selections) accidentally re-showing this section too.
  const enabled = !dockerOn && mode !== "off";
  // ENFORCING (FS): filesystem cage with the network sandbox OFF. The
  // host allow-list + any network-only copy are irrelevant, so they're
  // hidden in this mode.
  const fsOnly = mode === "enforce-fs";

  // Command preview: the exact `docker run ...` a launch would build right
  // now (docker_command_preview -> the SAME build_spec/render_argv the real
  // spawn path uses), fetched on demand rather than whenever the dialog
  // opens - it is not needed to decide the toggle, only to double-check it.
  const [showDockerPreview, setShowDockerPreview] = useState(false);
  const [dockerPreview, setDockerPreview] = useState<DockerCommandPreview | null>(null);
  const [dockerPreviewErr, setDockerPreviewErr] = useState<string | null>(null);
  const [dockerPreviewLoading, setDockerPreviewLoading] = useState(false);
  async function toggleDockerPreview() {
    if (!task) return;
    const next = !showDockerPreview;
    setShowDockerPreview(next);
    if (!next || dockerPreview) return;
    setDockerPreviewLoading(true);
    setDockerPreviewErr(null);
    try {
      setDockerPreview(await dockerCommandPreview(task.id));
    } catch (e) {
      setDockerPreviewErr(String(e));
    } finally {
      setDockerPreviewLoading(false);
    }
  }
  // Re-fetch on the task's own SIGKILL-and-relaunch triggers (toggling
  // Docker on/off, editing extra-args/extra-mounts) so a stale preview
  // never survives the thing it was showing changing under it.
  // Keyed on the CONTENT of the two lists, not their array identity. Every
  // `loadAll()` rebuilds the task objects, so identity changes on any
  // unrelated refresh and an open preview panel blanked itself for no
  // reason the user could see.
  const dockerPreviewKey = [
    task?.docker_sandbox_enabled ? "1" : "0",
    (task?.docker_extra_args ?? []).join("\u0000"),
    (task?.docker_extra_mounts ?? []).join("\u0000"),
  ].join("|");
  useEffect(() => {
    setDockerPreview(null);
  }, [dockerPreviewKey]);

  // Extra mounts: a dedicated per-task list (`host_path:container_path`,
  // Docker's own -v shape), NOT "Allowed paths" - that list is shared with
  // Seatbelt via live_sandbox_lists and has no concept of a container path.
  // Mainly for persisting something a fresh container otherwise loses on
  // every restart (an MCP server's own data dir, say) that the built-in
  // per-agent config dir mount doesn't cover. Commits immediately through
  // taskSetDocker, same as the toggle above, rather than joining the
  // Seatbelt draft-then-Save flow.
  const splitMountLines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
  const mountArrEq = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const [mountsText, setMountsText] = useState("");
  const [mountsBusy, setMountsBusy] = useState(false);
  const [mountsErr, setMountsErr] = useState<string | null>(null);
  useEffect(() => {
    setMountsText((task?.docker_extra_mounts ?? []).join("\n"));
    setMountsErr(null);
  }, [task?.id, task?.docker_extra_mounts]);
  const mountsDirty = task
    ? !mountArrEq(splitMountLines(mountsText), task.docker_extra_mounts ?? [])
    : false;
  async function saveDockerMounts() {
    if (!task || mountsBusy) return;
    setMountsBusy(true);
    setMountsErr(null);
    try {
      useUI.getState().markPendingPtyRestart(task.id);
      await taskSetDocker(task.id, true, task.docker_extra_args ?? [], splitMountLines(mountsText));
      await loadAll();
    } catch (e) {
      setMountsErr(String(e));
    } finally {
      setMountsBusy(false);
    }
  }

  async function toggleDocker(next: boolean) {
    if (!task || dockerBusy) return;
    const ok = await useUI.getState().askConfirm({
      title: next ? t("taskSandbox.dockerToggleTitleRun", { name: task.name }) : t("taskSandbox.dockerToggleTitleStop", { name: task.name }),
      message: dockerToggleMessage(next),
      confirmLabel: next ? t("taskSandbox.confirmRunDocker") : t("taskSandbox.confirmStopDocker"),
    });
    if (!ok) return;
    setDockerBusy(true);
    try {
      useUI.getState().markPendingPtyRestart(task.id);
      // Pass the mounts back explicitly. `task_set_docker` assigns
      // `docker_extra_mounts` unconditionally and the ipc wrapper defaults
      // the argument to [], so omitting it here ERASED the task's mount
      // list every time Docker was toggled - turn it off and back on and
      // the persisted paths were gone.
      await taskSetDocker(
        task.id, next,
        task.docker_extra_args ?? [],
        task.docker_extra_mounts ?? [],
      );
      await loadAll();
      // The confirm dialog just above IS the save step for Docker (unlike
      // Seatbelt's separate draft-then-Save flow) - closing here so the
      // dialog doesn't linger open over the terminal it just restarted,
      // looking like the choice didn't take or more input is still needed.
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setDockerBusy(false);
    }
  }

  useEffect(() => {
    if (!task) return;
    setMode(effectiveSandboxMode(task));
    setRwText((task.sandbox_rw_paths ?? []).join("\n"));
    setHostsText((task.sandbox_allowed_hosts ?? []).join("\n"));
    setErr(null);
    setBusy(false);
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!taskId) return null;

  // Has the form drifted from the saved task? Compare textareas
  // by their normalized line-array form (trim, drop blanks) so that
  // whitespace-only edits (an extra newline at the end) don't count
  // as dirty. The Save button stays disabled until something actually
  // changed — including the enable/disable toggle.
  const splitLines = (s: string) =>
    s.split("\n").map(l => l.trim()).filter(Boolean);
  const arrEq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const dirty = task ? (
    mode !== effectiveSandboxMode(task) ||
    !arrEq(splitLines(rwText),    task.sandbox_rw_paths      ?? []) ||
    !arrEq(splitLines(hostsText), task.sandbox_allowed_hosts ?? [])
  ) : false;

  async function save(restart: boolean) {
    if (!task || busy) return;
    // Pre-flight confirm. We don't have a live PTY count on the
    // frontend (the Rust side will tell us when the IPC returns),
    // so the dialog text is generic. The user is explicitly asking
    // for this; soft-warning is enough.
    const ok = await useUI.getState().askConfirm({
      title: t("taskSandbox.confirmSaveTitle", { name: taskLabel(task, useBranchAsTaskName) }),
      message: restart
        ? t("taskSandbox.confirmMsgRestart")
        : t("taskSandbox.confirmMsgNoRestart"),
      confirmLabel: restart ? t("taskSandbox.confirmRestart") : t("taskSandbox.confirmNoRestart"),
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
    try {
      // Mark BEFORE the IPC fires so TerminalPane sees the flag when
      // the pty-exit handler runs (the SIGKILL is fast - sometimes
      // exits land before this function's await even unblocks).
      if (restart) useUI.getState().markPendingPtyRestart(task.id);
      const killed = await taskSetSandbox(
        task.id, mode,
        lines(rwText), lines(hostsText),
        restart,
      );
      await loadAll();
      // Quiet success - the kill is the visible feedback (overlay
      // appears in the terminal). Only surface a toast-style message
      // when nothing died, so the user knows the save landed.
      if (killed === 0) {
        // Nothing to do; close.
      }
      close();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  // Switch mode. When turning the cage ON (monitor/enforce) from OFF
  // with empty lists, seed sensible defaults so the user doesn't start
  // from a blank cage. Going to OFF never clears the lists (so toggling
  // back doesn't lose work).
  async function chooseMode(next: SandboxMode) {
    const wasOff = mode === "off";
    setMode(next);
    if (next !== "off" && wasOff && !rwText.trim() && !hostsText.trim()) {
      try {
        const s = await settingsLoad();
        const merge = (g: string[] = [], pr: string[] = []) => {
          const seen = new Set<string>(); const out: string[] = [];
          for (const v of [...g, ...pr]) { if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
          return out.join("\n");
        };
        setRwText(merge(s.sandbox_default_rw_paths, project?.sandbox_rw_paths));
        setHostsText(merge(s.sandbox_default_allowed_hosts, project?.sandbox_allowed_hosts));
      } catch {}
    }
  }

  // The unified picker's click handler. Docker on/off still commits
  // IMMEDIATELY through its own confirm (toggleDocker, unchanged) rather
  // than joining the Seatbelt draft-then-Save flow below - the two engines
  // keep their existing, already-shipped commit semantics; this just picks
  // which one a click should drive. Unlike the old two-tier selector, a
  // Seatbelt card click here IS the final mode (no separate submode grid).
  /**
   * Leave Docker AND land on a Seatbelt mode, as one decision.
   *
   * This used to be `await toggleDocker(false); chooseMode(next)`, which
   * had two bugs feeding each other: `toggleDocker` closes the dialog on
   * success, so `chooseMode` then mutated a draft nobody could ever Save -
   * clicking ENFORCING on a Docker task turned the container OFF and the
   * seatbelt never ON, leaving the task fully uncaged. And when the user
   * CANCELLED the confirm, `toggleDocker` returned early but `chooseMode`
   * ran anyway, moving the picker to a mode that was never applied.
   *
   * The sandbox record is written BEFORE Docker is switched off, so there
   * is no window where the task has neither cage: `task_set_docker` is what
   * kills the PTYs, and by the time they respawn the Seatbelt mode is
   * already on the record.
   */
  async function leaveDockerFor(next: SandboxMode) {
    if (!task || dockerBusy) return;
    const ok = await useUI.getState().askConfirm({
      title: t("taskSandbox.leaveDockerTitle", { name: taskLabel(task, useBranchAsTaskName) }),
      message: leaveDockerMessage(next === "off" ? "off" : "seatbelt"),
      confirmLabel: next === "off" ? t("taskSandbox.confirmStopDocker") : t("taskSandbox.confirmSwitchSeatbelt"),
    });
    if (!ok) return;
    setDockerBusy(true);
    setErr(null);
    const lines = (v: string) => v.split("\n").map(l => l.trim()).filter(Boolean);
    try {
      useUI.getState().markPendingPtyRestart(task.id);
      // Order matters: record the cage first (no restart), then drop Docker,
      // which is the call that kills the PTYs.
      await taskSetSandbox(task.id, next, lines(rwText), lines(hostsText), false);
      await taskSetDocker(
        task.id, false,
        task.docker_extra_args ?? [],
        task.docker_extra_mounts ?? [],
      );
      await loadAll();
      setMode(next);
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setDockerBusy(false);
    }
  }

  async function choose(next: SandboxSelection) {
    if (next === "docker") {
      if (!dockerOn) await toggleDocker(true);
      return;
    }
    // Coming FROM Docker commits immediately (Docker's own semantics);
    // an ordinary Seatbelt pick stays a draft the Save button commits.
    if (dockerOn) {
      await leaveDockerFor(next);
      return;
    }
    chooseMode(next);
  }

  return (
    <AppDialog
      open={!!taskId}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title={task ? t("taskSandbox.titleNamed", { name: taskLabel(task, useBranchAsTaskName) }) : t("taskSandbox.titleFallback")}
      description={t("taskSandbox.description")}
      // Wider than the default max-w-md so the textareas don't get
      // squeezed into a column. Cap height to the viewport so the
      // body scrolls when content overflows (sandbox dialog has more
      // sections than other dialogs - editors, denies panel, test
      // panel, restart warning all stack up).
      className="max-w-4xl max-h-[90vh] overflow-hidden text-[13px]"
    >
      {/* Outer column: body scrolls; footer is shrink-0 so it stays
          pinned at the bottom of the dialog regardless of scroll. mt-2 gives
          the header/description room to breathe above the mode cards. */}
      <div className="mt-2 flex max-h-[calc(90vh-7rem)] flex-col">
        {/* px-0.5 pt-1: the scroll container clips overflow, which was cutting
            the focus ring off the top row of mode cards. A few px of inset
            gives the ring room to render. */}
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-0.5 pt-1 pr-1">
        {/* On/off panel. Big, color-coded, unambiguous - the prior
            "Unsandboxed" checkbox was a double-negative trap: users
            saw the box checked and assumed the cage was ON. State now
            reads from the color band (green = caged, red = open) and
            the verb on the action button ("Disable" vs "Enable"). */}
        {/* Unified picker: OFF / Seatbelt's 3 modes / Docker Container, five
            peer cards. Docker still commits immediately through its own
            confirm (choose -> toggleDocker, unchanged mechanics) while
            Seatbelt stays a draft the Save button below commits - this is
            just what makes the two read as ONE choice instead of Docker
            being a separate control bolted on beneath the mode grid. */}
        <SandboxPicker
          onEnableDocker={() => { close(); useApp.getState().openSettings("docker"); }}
          value={selection}
          onChange={choose}
          seatbeltUnavailable={osSandboxOk === false}
          dockerOffered={dockerOffered}
        />
        {mode === "monitor" && !dockerOn && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-3 py-2 text-[13px] text-[var(--color-fg-dim)]">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
            <span>
              <Trans
                t={t}
                i18nKey="taskSandbox.monitorNote"
                components={{ b: <b className="text-[var(--color-fg)]" /> }}
              />
            </span>
          </div>
        )}
        {osSandboxOk === false && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-3 py-2 text-[13px] text-[var(--color-fg-dim)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
            <span>
              <Trans
                t={t}
                i18nKey="taskSandbox.osUnavailable"
                components={{
                  b: <b className="text-[var(--color-fg)]" />,
                  code: <code className="mono" />,
                }}
              />
            </span>
          </div>
        )}

        {dockerOn && (
          <>
            <DockerEngineNote />
            <div>
              <Button variant="ghost" onClick={toggleDockerPreview} disabled={!task}>
                {showDockerPreview ? t("taskSandbox.hidePreview") : t("taskSandbox.previewCmd")}
              </Button>
              {showDockerPreview && (
                <div className="mt-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 text-[12px]">
                  {dockerPreviewLoading && (
                    <div className="text-[var(--color-fg-faint)]">{t("common:loading")}</div>
                  )}
                  {dockerPreviewErr && (
                    <div className="text-[var(--color-err)]">{dockerPreviewErr}</div>
                  )}
                  {dockerPreview && (
                    <>
                      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]">
                        {formatDockerArgv(dockerPreview.argv)}
                      </pre>
                      {!!dockerPreview.spec.warnings?.length && (
                        <div className="mt-2 flex flex-col gap-1 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-2.5 py-2 text-[11.5px] text-[var(--color-fg-dim)]">
                          {dockerPreview.spec.warnings!.map((w, i) => <div key={i}>{w}</div>)}
                        </div>
                      )}
                      <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--color-border-soft)] pt-2.5">
                        {dockerPreview.spec.mounts.map((m, i) => (
                          <div key={i} className="flex flex-col gap-0.5">
                            <div className="font-mono text-[11px] text-[var(--color-fg)]">
                              {m.host} <span className="text-[var(--color-fg-faint)]">→</span> {m.container}
                              <span className="ml-1.5 text-[var(--color-fg-faint)]">{m.read_only ? t("taskSandbox.readOnly") : t("taskSandbox.readWrite")}</span>
                            </div>
                            <div className="text-[11px] text-[var(--color-fg-faint)]">{m.why}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            <Field
              label={t("taskSandbox.extraMountsLabel")}
              hint={t("taskSandbox.extraMountsHint")}
            >
              <AutoGrowTextarea
                value={mountsText}
                onChange={e => setMountsText(e.target.value)}
                rows={3}
                placeholder={"$HOME/mcp-data:/data/mcp"}
                className="box-border w-full resize-none overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                disabled={mountsBusy}
              />
              <div className="mt-2 flex items-center gap-2">
                <Button variant="secondary" onClick={saveDockerMounts} disabled={!mountsDirty || mountsBusy}>
                  {mountsBusy ? t("common:saving") : t("taskSandbox.saveMounts")}
                </Button>
                {mountsErr && <span className="text-[12px] text-[var(--color-err)]">{mountsErr}</span>}
              </div>
            </Field>
          </>
        )}

        {/* YOLO trade-off note. Sandboxed agents auto-skip their own
            permission prompts because the seatbelt is the real boundary -
            users should know this is happening, not stumble onto it.
            Honors the Settings → Sandbox "Bypass permissions in sandboxed
            tasks" toggle. */}
        {(mode === "enforce" || mode === "enforce-fs") && sandboxBypassPermissions && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-ok)]/25 bg-[var(--color-ok)]/10 px-3 py-2 text-[13px] text-[var(--color-fg-dim)]">
            <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
            <span>
              <Trans
                t={t}
                i18nKey="taskSandbox.yoloNote"
                components={{ b: <b className="text-[var(--color-fg)]" /> }}
              />
            </span>
          </div>
        )}

        {/* Built-in defaults moved inline under each field below -
            the standalone <details> made users miss what was already
            covered, leading to redundant entries in the "Extra"
            textareas. Always-visible inline = "you don't need to
            list this; it's covered." */}

        {/* Presets - clobber the three textareas with a known-good
            starting point. User can still edit afterwards. The
            'Reset to project defaults' button is a separate action
            because the project's current defaults are user-owned
            (vs the bundled Presets which are app-owned). */}
        {enabled && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-[var(--color-fg-faint)]">{t("taskSandbox.presetLabel")}</span>
            {SANDBOX_PRESETS.map(p => (
              <button
                key={p.id} type="button"
                title={presetHint(p)}
                onClick={() => {
                  setRwText(p.rwPaths.join("\n"));
                  setHostsText(p.allowedHosts.join("\n"));
                }}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
              >
                {presetLabel(p)}
              </button>
            ))}
            {project && (
              <button
                type="button"
                title={t("taskSandbox.resetProjectDefaultsTitle", { project: project.name })}
                onClick={() => {
                  setRwText((project.sandbox_rw_paths ?? []).join("\n"));
                  setHostsText((project.sandbox_allowed_hosts ?? []).join("\n"));
                }}
                className="rounded-md border border-[var(--color-accent-soft)] bg-[var(--color-bg)] px-2 py-0.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]"
              >
                {t("taskSandbox.resetProjectDefaults")}
              </button>
            )}
          </div>
        )}

        {/* Allow-list config only matters when there's a cage (Monitoring
            uses it for would-block + to pre-build the Enforcing list).
            Hidden entirely for OFF — nothing to configure. */}
        {enabled && (<>
        <Field
          label={t("taskSandbox.allowedPathsLabel")}
          hint={t("taskSandbox.allowedPathsHint")}
        >
          {/* Two columns, locked to the same height. box-border on
              both so the explicit h-[] applies to the OUTER box
              (border + padding included) instead of the content
              area — otherwise the textarea (content-box default)
              renders ~2px taller than the panel and they don't line
              up. scrollbar-gutter:stable so the right panel reserves
              space for its scrollbar and the chips don't reflow when
              scrolling kicks in. */}
          <div className="grid grid-cols-2 items-stretch gap-3">
            <AutoGrowTextarea
              value={rwText}
              onChange={e => setRwText(e.target.value)}
              rows={4}
              placeholder={"$HOME/Work/other-project\n$HOME/Notes"}
              className="box-border h-[180px] w-full resize-none overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              disabled={!enabled}
            />
            <DefaultsPanel className="box-border h-[180px] overflow-y-auto [scrollbar-gutter:stable]">
              <ChipGroup tone="allow" label={t("taskSandbox.chipGroupRw")}>
                <Chip tone="allow">task</Chip>
                <Chip tone="allow">~/.npm</Chip>
                <Chip tone="allow">~/.cache</Chip>
                <Chip tone="allow">~/.cargo/registry</Chip>
                <Chip tone="allow">~/.bun</Chip>
                <Chip tone="allow">~/.deno</Chip>
                <Chip tone="allow">~/.local/share</Chip>
                <Chip tone="allow">~/.local/bin</Chip>
                <Chip tone="allow">~/.agents</Chip>
                <Chip tone="allow">~/Library/Caches</Chip>
                <Chip tone="allow">~/Library/Keychains</Chip>
                <Chip tone="allow">/private/tmp</Chip>
                <Chip tone="allow">TMPDIR</Chip>
                <Chip tone="allow" muted>{t("taskSandbox.chipShellDotfiles")}</Chip>
              </ChipGroup>
              <ChipGroup tone="allow" label={t("taskSandbox.chipGroupRo")}>
                <Chip tone="allow">/usr</Chip>
                <Chip tone="allow">/opt</Chip>
                <Chip tone="allow">/bin</Chip>
                <Chip tone="allow">/sbin</Chip>
                <Chip tone="allow">/dev</Chip>
                <Chip tone="allow">/etc</Chip>
                <Chip tone="allow">~/.ssh/known_hosts</Chip>
                <Chip tone="allow" muted>{t("taskSandbox.chipDyld")}</Chip>
                <Chip tone="allow" muted>{t("taskSandbox.chipLibLinux")}</Chip>
                <Chip tone="allow" muted>{t("taskSandbox.chipProcLinux")}</Chip>
              </ChipGroup>
              {agent && (agent.sandbox_allowed_paths?.length ?? 0) > 0 && (
                <ChipGroup tone="allow" label={t("taskSandbox.chipGroupAgent", { agent: agent.display_name || agent.id })}>
                  {(agent.sandbox_allowed_paths ?? []).map(p => (
                    <Chip key={p} tone="allow">{p.replace(/^\$HOME/, "~")}</Chip>
                  ))}
                </ChipGroup>
              )}
              <p className="mt-2 text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
                <Trans
                  t={t}
                  i18nKey="taskSandbox.allowlistNote"
                  components={{ i: <i />, mono: <span className="font-mono" /> }}
                />
              </p>
            </DefaultsPanel>
          </div>
        </Field>
        {fsOnly ? (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-3 py-2 text-[13px] text-[var(--color-fg-dim)]">
            <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
            <span>
              <Trans
                t={t}
                i18nKey="taskSandbox.fsOnlyNote"
                components={{ b: <b className="text-[var(--color-fg)]" /> }}
              />
            </span>
          </div>
        ) : (
          <Field label={t("taskSandbox.allowedHostsLabel")} hint={t("taskSandbox.allowedHostsHint")}>
            <div className="grid grid-cols-2 items-stretch gap-3">
              <AutoGrowTextarea
                value={hostsText}
                onChange={e => setHostsText(e.target.value)}
                rows={3}
                placeholder={"*.mycompany.com\nbitbucket.org"}
                className="h-full min-h-[100px] w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] [field-sizing:content]"
                disabled={!enabled}
              />
              <DefaultsPanel className="h-full">
                <ChipGroup tone="allow" label={t("taskSandbox.alwaysReachable")}>
                  <Chip tone="allow">{t("taskSandbox.chipVendorApi", { cli: task?.cli ?? t("taskSandbox.thisCli") })}</Chip>
                  <Chip tone="allow">github.com</Chip>
                  <Chip tone="allow">npmjs.org</Chip>
                  <Chip tone="allow">pypi.org</Chip>
                  <Chip tone="allow">crates.io</Chip>
                  <Chip tone="allow" muted>{t("taskSandbox.chipCaOcsp")}</Chip>
                </ChipGroup>
              </DefaultsPanel>
            </div>
          </Field>
        )}
        </>)}

        {/* "Recent denies" panel removed — the TerminalPane footer
            now shows a live deny counter chip per task, which
            is the discoverable surface. Detailed log lookups belong
            in the debug.log path, not buried in the dialog. */}

        {/* No restart warning here — the two Save buttons (with/without
            restart) make the behavior obvious on their own. */}
        {err && <p className="text-[13px] text-[var(--color-err)]">{err}</p>}
        </div>

        {/* Sticky footer — sits outside the scroll container so the
            Save button is always reachable no matter how long the form
            gets after autogrow expands the textareas. */}
        <div className="mt-3 flex shrink-0 justify-end gap-2 border-t border-[var(--color-border-soft)] pt-3">
          <Button variant="ghost" type="button" onClick={close} disabled={busy}>{t("common:cancel")}</Button>
          <Button
            variant="secondary" type="button" onClick={() => save(false)}
            disabled={busy || !dirty}
            title={!dirty
              ? t("taskSandbox.noChangesTitle")
              : t("taskSandbox.noRestartTitle")}
            className="gap-1.5"
          >
            <Save className="h-3.5 w-3.5" />
            {t("taskSandbox.saveWithoutRestart")}
          </Button>
          <Button
            variant="primary" type="button" onClick={() => save(true)}
            disabled={busy || !dirty}
            title={!dirty ? t("taskSandbox.noChangesTitle") : undefined}
            className="gap-1.5"
          >
            <RotateCw className="h-3.5 w-3.5" />
            {busy ? t("common:saving") : t("taskSandbox.saveRestart")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}

// Textarea that grows with its content. The CSS-only `field-sizing:
// content` approach didn't take in this WKWebView build, so we fall
// back to the JS recipe: collapse to auto, then size to scrollHeight
// on every value change. `overflow-hidden` kills the temporary
// scrollbar that would otherwise flicker during resize.
function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      {...props}
      style={{ overflow: "hidden", ...props.style }}
    />
  );
}

// Inline reminder of what's already covered by the built-in default
// set for this field. Sits between the field's hint and its textarea
// so users see "covered" stuff before they type something redundant.
function BuiltInsLine({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("dialogs");
  return (
    <div className="mb-1.5 text-[12px] leading-snug text-[var(--color-fg-faint)]">
      <span className="font-medium text-[var(--color-fg-dim)]">{t("taskSandbox.alreadyCoveredColon")}</span>{" "}
      {children}
    </div>
  );
}

// Replaces the old prose-with-middots BuiltInsLine for the two fields
// where the default set is more than a handful of paths. A bordered
// container holds one or more ChipGroups - each group has a tone
// (allow / deny) and a row of Chip pills. Reads top-to-bottom in
// O(scan) instead of forcing the user to parse a comma-soup.
function DefaultsPanel({ children, className }: { children: React.ReactNode; className?: string }) {
  const { t } = useTranslation("dialogs");
  return (
    <div className={cn(
      "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-2.5",
      className,
    )}>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-fg-faint)]">
        {t("taskSandbox.alreadyCovered")}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function ChipGroup({
  label,
  tone,
  children,
}: {
  label: string;
  tone: "allow" | "deny";
  children: React.ReactNode;
}) {
  // Tone drives the leading dot color + group label color. Keeping
  // each line as a flex-wrap row lets chips reflow naturally as the
  // dialog width changes.
  const dotColor = tone === "allow" ? "var(--color-ok)" : "var(--color-err)";
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: dotColor }}
          aria-hidden
        />
        <span className="text-[11.5px] font-medium text-[var(--color-fg-dim)]">{label}</span>
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Chip({
  tone,
  muted = false,
  children,
}: {
  tone: "allow" | "deny";
  // `muted` for category-summary chips like "+ XDG variants" or
  // "system dirs" - same shape, no colored border. Keeps the visual
  // weight of the literal paths higher than the umbrella terms.
  muted?: boolean;
  children: React.ReactNode;
}) {
  const borderVar = muted
    ? "var(--color-border)"
    : tone === "allow"
      ? "color-mix(in srgb, var(--color-ok) 35%, var(--color-border))"
      : "color-mix(in srgb, var(--color-err) 35%, var(--color-border))";
  const bgVar = muted
    ? "transparent"
    : tone === "allow"
      ? "color-mix(in srgb, var(--color-ok) 8%, transparent)"
      : "color-mix(in srgb, var(--color-err) 8%, transparent)";
  return (
    <code
      className="inline-flex items-center rounded border px-1.5 py-[1px] font-mono text-[11px] text-[var(--color-fg-dim)]"
      style={{ borderColor: borderVar, background: bgVar }}
    >
      {children}
    </code>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[11.5px] text-[var(--color-fg-dim)]">{children}</code>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[13px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[13px] text-[var(--color-fg-dim)]">{hint}</div>}
      <div className="mt-2">{children}</div>
    </div>
  );
}
