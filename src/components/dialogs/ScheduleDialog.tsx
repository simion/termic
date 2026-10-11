// The schedule dialog (GH #300). Three shapes, one form:
//   - New schedule: a new main-checkout parent task, so the agent, model,
//     YOLO and sandbox are chosen here and become the parent's.
//   - "Schedule..." on a task: that task becomes the parent. Its agent
//     settings are what every run copies (runSpecFromParent), so they are
//     not asked for again.
//   - Edit: the schedule's own fields. The agent settings are the parent's
//     and are edited on the parent.
// The sandbox is seeded from the project the way New Task seeds it, except
// Docker: scheduled runs do not support it, so a Docker default seeds NOTHING
// and Create waits for a choice, rather than quietly running on the host.
// A Seatbelt choice opens the cage's allow-lists in a second column, the
// layout New Task uses, and the dialog takes New Task's two widths for it.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { usePromptLibrary, promptTitle } from "@/store/prompts";
import { useProfiles } from "@/store/profiles";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { SandboxPicker, KeychainBlockField } from "@/components/SandboxPicker";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { isTerminalCli, visibleCliIds, workDoneCapable, defaultCliFirst } from "@/lib/agents";
import { settingsLoad } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { SEATBELT_AVAILABLE } from "@/lib/platform";
import { mergeLists, projectYoloDefault, yoloForCreate } from "@/lib/projectSandboxDefault";
import { SANDBOX_PRESETS, presetHint, presetLabel } from "@/lib/sandboxPresets";
import { selectionToFields, type CadenceKind, type SandboxSelection } from "@/lib/types";
import { createSchedule, updateSchedule } from "@/lib/schedules/runner";
import {
  DEFAULT_KEEP_RUNS, DEFAULT_REPORT_DAYS, MAX_KEEP_RUNS, REPORT_DAY_CHOICES, scheduleSandboxSeed, type ScheduleInput,
} from "@/lib/schedules/record";
import { weekdayName } from "@/lib/schedules/display";
import { reportFolder, scheduleSlug } from "@/lib/schedules/runSpec";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function ScheduleDialog() {
  const { t, i18n } = useTranslation("dialogs");
  const { t: tc } = useTranslation("common");
  const { t: tch } = useTranslation("chrome");
  const target = useUI(s => s.scheduleDialog);
  const close = useUI(s => s.closeScheduleDialog);
  const open = target !== null;
  const parent = useApp(s => (target?.parentTaskId ? s.tasks.find(x => x.id === target.parentTaskId) ?? null : null));
  const projects = useApp(s => s.projects);
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const prompts = usePromptLibrary(s => s.prompts);
  const notificationsOn = usePrefs(s => s.desktopNotifications);
  const profilesExist = useProfiles(s => s.current !== null);

  const editing = !!target?.edit && !!parent?.schedule;
  const newParent = !parent;

  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [cli, setCli] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptId, setPromptId] = useState("");
  const [kind, setKind] = useState<CadenceKind>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [selection, setSelection] = useState<SandboxSelection | null>("off");
  const [dockerSeeded, setDockerSeeded] = useState(false);
  const [yolo, setYolo] = useState(false);
  // The cage's allow-lists as multi-line text, split at submit, so a blank
  // line while typing does not fight the split (New Task does the same).
  const [sbRw, setSbRw] = useState("");
  const [sbHosts, setSbHosts] = useState("");
  const [blockKc, setBlockKc] = useState(false);
  const [catchUp, setCatchUp] = useState(false);
  const [keepRuns, setKeepRuns] = useState(DEFAULT_KEEP_RUNS);
  const [reportDays, setReportDays] = useState<number | null>(DEFAULT_REPORT_DAYS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const liveProjects = projects;
  const project = liveProjects.find(p => p.id === projectId) ?? null;

  // Agents a run can use: shown, installed, and able to say they finished.
  const agentChoices = useMemo(() => {
    const visible = visibleCliIds(agents.map(a => a.id), agents, detectedClis);
    return defaultCliFirst(
      agents.filter(a => visible.has(a.id) && !a.disabled && !isTerminalCli(a.id, agents) && workDoneCapable(a.id, agents)),
      project?.default_cli,
    );
  }, [agents, detectedClis, project?.default_cli]);

  // Seed once per open. Every field the dialog does not show in a mode still
  // gets a value, so switching nothing is a no-op on save.
  useEffect(() => {
    if (!target) return;
    setErr(null);
    setBusy(false);
    const s = editing ? parent!.schedule! : null;
    const pid = parent?.project_id ?? target.projectId ?? liveProjects[0]?.id ?? "";
    setProjectId(pid);
    setName(s?.name ?? parent?.name ?? "");
    setPrompt(s?.prompt ?? "");
    setPromptId(s?.prompt_id ?? "");
    setKind(s?.cadence.kind ?? "daily");
    setTime(s?.cadence.time ?? "09:00");
    setWeekday(s?.cadence.weekday ?? 1);
    setCatchUp(s?.catch_up ?? false);
    setKeepRuns(s?.keep_runs ?? DEFAULT_KEEP_RUNS);
    setReportDays(s ? s.report_days : DEFAULT_REPORT_DAYS);
    setModel("");
    const p = liveProjects.find(x => x.id === pid) ?? null;
    const seeded = scheduleSandboxSeed(p, usePrefs.getState().globalDefaultSandboxKind, SEATBELT_AVAILABLE);
    setDockerSeeded(seeded === "docker");
    setSelection(seeded === "docker" ? null : seeded);
    setYolo(projectYoloDefault(p, usePrefs.getState().defaultYolo));
    setBlockKc(false);
    // Depends on the TARGET only: re-seeding when the task list moves would
    // throw away what the user typed.
  }, [target]);

  // The agent follows the project for a new parent.
  useEffect(() => {
    if (!open || !newParent) return;
    if (!agentChoices.some(a => a.id === cli)) setCli(agentChoices[0]?.id ?? "");
  }, [open, newParent, agentChoices, cli]);

  // The allow-lists follow the project: its own lists at once, then the
  // app-wide defaults merged in front once Settings loads. Changing the
  // project re-seeds them, since the old project's paths mean nothing there.
  useEffect(() => {
    if (!open || !newParent) return;
    const p = useApp.getState().projects.find(x => x.id === projectId) ?? null;
    setSbRw((p?.sandbox_rw_paths ?? []).join("\n"));
    setSbHosts((p?.sandbox_allowed_hosts ?? []).join("\n"));
    let stale = false;
    settingsLoad().then(st => {
      if (stale) return;
      setSbRw(mergeLists(st.sandbox_default_rw_paths, p?.sandbox_rw_paths).join("\n"));
      setSbHosts(mergeLists(st.sandbox_default_allowed_hosts, p?.sandbox_allowed_hosts).join("\n"));
    }).catch(() => {});
    return () => { stale = true; };
  }, [open, newParent, projectId]);

  const sandboxMode = selection ? selectionToFields(selection).mode : "off";
  // enforcing modes only, and only sent while shown (same rule as New Task).
  const kcRow = sandboxMode === "enforce" || sandboxMode === "enforce-fs";
  // The second column exists only while a Seatbelt mode is picked, so there
  // is no ghost width when the cage is off.
  const cage = newParent && sandboxMode !== "off";

  const lang = i18n.language;
  const takenSlugs = useApp.getState().tasks.filter(x => x.project_id === projectId && x.schedule && x.id !== parent?.id)
    .map(x => x.schedule!.slug);
  const folder = reportFolder(editing ? parent!.schedule!.slug : scheduleSlug(name || "schedule", takenSlugs));

  async function submit() {
    if (!name.trim()) return setErr(t("schedule.errName"));
    if (!prompt.trim() && !promptId) return setErr(t("schedule.errPrompt"));
    if (newParent && !cli) return setErr(t("schedule.errAgent"));
    if (newParent && !selection) return setErr(t("schedule.errSandbox"));
    const input: ScheduleInput = {
      name: name.trim(),
      prompt,
      prompt_id: promptId || undefined,
      cadence: kind === "weekly" ? { kind, time, weekday } : { kind, time },
      catch_up: catchUp,
      keep_runs: Math.min(MAX_KEEP_RUNS, Math.max(1, Math.round(keepRuns) || 1)),
      report_days: reportDays,
    };
    setBusy(true);
    setErr(null);
    try {
      if (editing) {
        await updateSchedule(parent!.id, { ...input, prompt_id: promptId || "" });
      } else if (parent) {
        await createSchedule({ projectId: parent.project_id, parentTaskId: parent.id, input });
      } else {
        const sel = selection!;
        const { mode } = selectionToFields(sel);
        const sandbox = mode === "off"
          ? { enabled: false, rwPaths: [], allowedHosts: [] }
          : { enabled: true, mode, rwPaths: splitLines(sbRw), allowedHosts: splitLines(sbHosts), blockKeychain: kcRow && blockKc };
        await createSchedule({
          projectId,
          agent: {
            cli,
            agentArgs: model.trim() ? ["--model", model.trim()] : [],
            yolo: yoloForCreate(yolo, sel, true),
            sandbox,
          },
          input,
        });
      }
      close();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const title = editing ? t("schedule.titleEdit")
    : parent ? t("schedule.titleFromTask", { name: parent.name })
    : t("schedule.titleNew");
  const enabledPrompts = prompts.filter(p => p.enabled || p.id === promptId);

  return (
    <AppDialog
      open={open}
      onOpenChange={v => { if (!v) close(); }}
      title={title}
      // New Task's two widths, on the one thing they depend on: whether
      // there is a right column. A `w-*` here does nothing, because
      // AppDialog's own `max-w-md` still caps it.
      className={cage ? "max-w-[72rem]" : "max-w-xl"}
      stickyFooter={
        <div className="flex items-center gap-3">
          {err && <span className="min-w-0 flex-1 text-[12px] text-[var(--color-err)]" data-testid="schedule-error">{err}</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={close}>{tc("cancel")}</Button>
            <Button
              variant="primary"
              data-testid="schedule-submit"
              onClick={() => { void submit(); }}
              disabled={busy || (newParent && !selection)}
            >
              {editing ? tc("save") : t("schedule.create")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex" data-testid="schedule-dialog">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <p className="text-[12px] leading-snug text-[var(--color-fg-faint)]" data-testid="schedule-ceiling">
          {tch("scheduled.ceiling")}
          {profilesExist && <> {tch("scheduled.ceilingProfile")}</>}
        </p>

        {newParent && (
          <Field label={t("schedule.project")}>
            <select
              data-testid="schedule-project"
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className={selectClass}
            >
              {liveProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}

        <Field label={t("schedule.name")}>
          <Input
            data-testid="schedule-name"
            value={name}
            placeholder={t("schedule.namePlaceholder")}
            onChange={e => setName(e.target.value)}
          />
        </Field>

        {newParent ? (
          <Field label={t("schedule.agent")}>
            <div className="inline-flex flex-wrap items-stretch gap-y-1 self-start rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
              {agentChoices.map(a => (
                <button
                  key={a.id}
                  type="button"
                  data-testid={`schedule-agent-${a.id}`}
                  aria-pressed={cli === a.id}
                  onClick={() => setCli(a.id)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors",
                    cli === a.id
                      ? "bg-[var(--color-accent-deep)] text-white"
                      : cn("text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]", CLI_BRAND_COLOR[a.icon_id]),
                  )}
                >
                  <CliIcon cli={a.icon_id} className="h-3.5 w-3.5" />
                  {a.display_name}
                </button>
              ))}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[12px] text-[var(--color-fg-dim)]">{t("schedule.model")}</span>
              <Input data-testid="schedule-model" value={model} onChange={e => setModel(e.target.value)} className="max-w-[220px]" />
            </div>
            <p className="text-[11.5px] text-[var(--color-fg-faint)]">{t("schedule.modelHint")}</p>
          </Field>
        ) : (
          <p className="text-[12px] text-[var(--color-fg-dim)]" data-testid="schedule-inherits">{t("schedule.inherits")}</p>
        )}

        <Field label={t("schedule.prompt")} hint={t("schedule.reportHint", { folder })}>
          <textarea
            data-testid="schedule-prompt"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={t("schedule.promptPlaceholder")}
            rows={3}
            className="min-h-[64px] resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-[var(--color-fg-dim)]">{t("schedule.library")}</span>
            <select
              data-testid="schedule-library"
              value={promptId}
              onChange={e => setPromptId(e.target.value)}
              className={cn(selectClass, "max-w-[260px]")}
            >
              <option value="">{t("schedule.libraryNone")}</option>
              {enabledPrompts.map(p => <option key={p.id} value={p.id}>{promptTitle(p, tch)}</option>)}
            </select>
          </div>
          {promptId && <p className="text-[11.5px] text-[var(--color-fg-faint)]">{t("schedule.libraryHint")}</p>}
        </Field>

        <Field label={t("schedule.cadence")}>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={kind}
              onChange={v => setKind(v as CadenceKind)}
              options={[
                { id: "daily", label: t("schedule.daily") },
                { id: "weekdays", label: t("schedule.weekdays") },
                { id: "weekly", label: t("schedule.weekly") },
              ]}
              testId="schedule-cadence"
            />
            {kind === "weekly" && (
              <select
                data-testid="schedule-weekday"
                aria-label={t("schedule.weekday")}
                value={weekday}
                onChange={e => setWeekday(Number(e.target.value))}
                className={selectClass}
              >
                {WEEK_ORDER.map(d => <option key={d} value={d}>{weekdayName(d, lang)}</option>)}
              </select>
            )}
            <input
              type="time"
              data-testid="schedule-time"
              aria-label={t("schedule.time")}
              value={time}
              onChange={e => setTime(e.target.value || "09:00")}
              className={selectClass}
            />
          </div>
        </Field>

        {newParent && (
          <Field label={t("schedule.sandbox")}>
            <SandboxPicker
              value={selection}
              onChange={s => { setSelection(s); setDockerSeeded(false); }}
              seatbeltUnavailable={!SEATBELT_AVAILABLE}
              dockerOffered={false}
              dockerUnavailableReason={t("schedule.dockerUnavailable")}
              compact
            />
            {kcRow && <KeychainBlockField checked={blockKc} onChange={setBlockKc} compact />}
            {dockerSeeded && !selection && (
              <p className="text-[11.5px] text-[var(--color-warn)]" data-testid="schedule-docker-pick">{t("schedule.dockerPick")}</p>
            )}
            <label className="mt-1 flex items-center gap-2 text-[12.5px] text-[var(--color-fg)]">
              <Checkbox checked={yolo} onChange={setYolo} data-testid="schedule-yolo" />
              {t("newTask.yoloLabel")}
            </label>
          </Field>
        )}

        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-[12.5px] text-[var(--color-fg)]">
            <Checkbox checked={catchUp} onChange={setCatchUp} data-testid="schedule-catch-up" />
            <span>
              {t("schedule.catchUp")}
              <span className="block text-[11.5px] text-[var(--color-fg-faint)]">{t("schedule.catchUpHint")}</span>
            </span>
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-[var(--color-fg)]">{t("schedule.keepRuns")}</span>
            <input
              type="number"
              min={1}
              max={MAX_KEEP_RUNS}
              data-testid="schedule-keep-runs"
              value={keepRuns}
              onChange={e => setKeepRuns(Number(e.target.value))}
              className={cn(selectClass, "w-16")}
            />
            <span className="text-[11.5px] text-[var(--color-fg-faint)]">{t("schedule.keepRunsHint")}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-[var(--color-fg)]">{t("schedule.reports")}</span>
            <Segmented
              value={reportDays == null ? "forever" : String(reportDays)}
              onChange={v => setReportDays(v === "forever" ? null : Number(v))}
              options={REPORT_DAY_CHOICES.map(d => ({
                id: d == null ? "forever" : String(d),
                label: d == null ? t("schedule.reportForever") : t("schedule.reportDays", { count: d }),
              }))}
              testId="schedule-retention"
            />
          </div>
        </div>

        {!notificationsOn && (
          <p className="text-[12px] text-[var(--color-fg-dim)]" data-testid="schedule-notifications-off">
            {t("schedule.notificationsOff")}{" "}
            <button
              type="button"
              className="text-[var(--color-accent)] hover:underline"
              onClick={() => { close(); useApp.getState().openSettings("notifications"); }}
            >
              {t("schedule.notificationsOn")}
            </button>
          </p>
        )}
      </div>

      {cage && (
        <div
          data-testid="schedule-cage-column"
          className="ml-8 flex min-w-0 flex-1 flex-col gap-3 border-l border-[var(--color-border-soft)] pl-6"
        >
          <div className="text-[11.5px] uppercase tracking-[0.1em] text-[var(--color-fg-faint)]">
            {t("schedule.sandboxConfigTitle")}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-[var(--color-fg-faint)]">{t("newTask.presetLabel")}</span>
            {SANDBOX_PRESETS.map(p => (
              <button
                key={p.id}
                type="button"
                title={presetHint(p)}
                onClick={() => { setSbRw(p.rwPaths.join("\n")); setSbHosts(p.allowedHosts.join("\n")); }}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[12px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
              >
                {presetLabel(p)}
              </button>
            ))}
          </div>
          <Field label={t("newTask.allowedPathsLabel")} hint={t("newTask.allowedPathsHint")}>
            <textarea
              data-testid="schedule-rw-paths"
              value={sbRw}
              onChange={e => setSbRw(e.target.value)}
              rows={3}
              placeholder={"$HOME/Work/other-project\n$HOME/Notes"}
              className={listClass}
            />
          </Field>
          {/* Enforcing (FS) leaves the network alone, so the host list is moot. */}
          {sandboxMode !== "enforce-fs" ? (
            <Field label={t("newTask.allowedHostsLabel")} hint={t("newTask.allowedHostsHint")}>
              <textarea
                data-testid="schedule-allowed-hosts"
                value={sbHosts}
                onChange={e => setSbHosts(e.target.value)}
                rows={3}
                placeholder={"*.mycompany.com\nbitbucket.org"}
                className={listClass}
              />
            </Field>
          ) : (
            <p className="text-[12px] leading-snug text-[var(--color-fg-faint)]">{t("newTask.enforceFsNote")}</p>
          )}
        </div>
      )}
      </div>
    </AppDialog>
  );
}

const selectClass =
  "h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]";

const listClass =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]";

const splitLines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] font-medium text-[var(--color-fg)]">{label}</label>
      {hint && <div className="-mt-1 text-[12px] leading-snug text-[var(--color-fg-faint)]">{hint}</div>}
      {children}
    </div>
  );
}

/** A small segmented control. The selected segment is marked by its fill and
 *  `aria-pressed`, never by a themed border colour transition. */
function Segmented({ value, onChange, options, testId }: {
  value: string; onChange: (v: string) => void; options: { id: string; label: string }[]; testId: string;
}) {
  return (
    <div className="inline-flex items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]" data-testid={testId}>
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          data-value={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "h-6 rounded-[5px] px-2.5 text-[12px]",
            value === o.id ? "bg-[var(--color-accent-deep)] text-white" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
