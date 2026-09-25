// Notifications and status: how Termic tells you an agent needs you, both
// out of the app (desktop notification, sound) and inside it (the tab and
// sidebar indicators).

import { useTranslation, Trans } from "react-i18next";
import { ensureNotifyPermission, previewCompletionSound } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { usePrefs } from "@/store/prefs";
import { useApp } from "@/store/app";
import { AGENT_HOOKS_HIGHLIGHT } from "./AgentHooksBlock";
import { Block, SectionTitle, Toggle } from "./Controls";
import { cn } from "@/lib/utils";
import { taskLabel } from "@/lib/taskLabel";
import { COMPLETION_SOUND_OPTIONS, COMPLETION_SOUND_SUPPORTED } from "@/lib/notificationSounds";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import type { DelegatedWork } from "@/lib/delegatedWork";

/** A stand-in report, so the rows can draw the marks that depend on one. */
const HELD: DelegatedWork = { label: "subagent", count: 2, ids: [] };

export function NotificationsSection() {
  const { t } = useTranslation("settings");
  const desktopNotifications = usePrefs(s => s.desktopNotifications);
  const setDesktopNotifications = usePrefs(s => s.setDesktopNotifications);
  const completionSound = usePrefs(s => s.completionSound);
  const setCompletionSound = usePrefs(s => s.setCompletionSound);
  const completionSoundId = usePrefs(s => s.completionSoundId);
  const setCompletionSoundId = usePrefs(s => s.setCompletionSoundId);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const setSettledHighlight = usePrefs(s => s.setSettledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const partialDoneIndicator = usePrefs(s => s.partialDoneIndicator);
  const setPartialDoneIndicator = usePrefs(s => s.setPartialDoneIndicator);
  const attentionIndicator = usePrefs(s => s.attentionIndicator);
  const setAttentionIndicator = usePrefs(s => s.setAttentionIndicator);
  const setWorkingIndicator = usePrefs(s => s.setWorkingIndicator);

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title={t("rail.notifications")} />

      <Block first>
        <Toggle
          label={t("notifications.desktop.label")}
          hint={t("notifications.desktop.hint")}
          value={desktopNotifications}
          onChange={(v) => {
            setDesktopNotifications(v);
            // Trigger the macOS permission prompt the moment the user opts
            // in, so the dialog appears in context instead of mid-task.
            if (v) ensureNotifyPermission();
          }}
        />
      </Block>

      {/* macOS-only: the sound catalog is macOS system-sound names (plus a
          .caf installed into ~/Library/Sounds) — none resolve elsewhere. */}
      {COMPLETION_SOUND_SUPPORTED && (
      <Block>
        {/* The sound plays INSIDE the desktop notification — with
            notifications off it can never fire, so lock the controls
            instead of letting Preview suggest otherwise. */}
        <div className={cn(!desktopNotifications && "pointer-events-none opacity-50 select-none")}>
        <Toggle
          label={t("notifications.sound.label")}
          hint={t("notifications.sound.hint")}
          value={completionSound}
          onChange={setCompletionSound}
        />
        <div className="mt-3 max-w-sm">
          <div className="flex items-center gap-2">
            <select
              value={completionSoundId}
              onChange={(e) => setCompletionSoundId(e.target.value as typeof completionSoundId)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 text-[13px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]"
            >
              {COMPLETION_SOUND_OPTIONS.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="md"
              className="h-9 shrink-0"
              onClick={() => {
                // Preview with a real project · task title so the
                // banner looks exactly like an agent-finished notification.
                const st = useApp.getState();
                const task =
                  st.tasks.find(w => w.id === st.activeTaskId && !w.archived) ??
                  st.tasks.find(w => !w.archived);
                const proj = task && st.projects.find(p => p.id === task.project_id);
                const label = task
                  ? taskLabel(task, usePrefs.getState().useBranchAsTaskName)
                  : "";
                const title = task && proj?.name
                  ? `${proj.name} · ${label || t("notifications.sound.taskFallback")}`
                  : (label || t("notifications.sound.titleFallback"));
                previewCompletionSound(completionSoundId, { title, body: t("notifications.sound.body") });
              }}
              title={t("notifications.sound.previewTip")}
            >
              {t("notifications.sound.preview")}
            </Button>
          </div>
        </div>
        </div>
        {!desktopNotifications && (
          <p className="mt-2 text-[12px] text-[var(--color-fg-faint)]">
            {t("notifications.sound.lockedNote")}
          </p>
        )}
      </Block>
      )}

      {/* One block, one row per mark, each row showing the mark it governs.
          They were four separate blocks of prose describing small circles,
          which is the hardest possible way to answer "which dot is that".

          The order and the indent are the model: everything mid-turn hangs
          off Working, because "do not show me busy agents" is one question,
          and a user who answers no does not want a quieter ring instead. */}
      <Block>
        <div className="text-[13px] font-medium text-[var(--color-fg)]">
          {t("notifications.marksTitle")}
        </div>
        <div className="mt-3 flex flex-col gap-3.5">
          <Toggle
            mark={<TaskWorkBadge reason="working" preview />}
            label={t("notifications.markWorking.label")}
            hint={t("notifications.markWorking.hint")}
            value={workingIndicator}
            onChange={setWorkingIndicator}
          />
          {/* Both children go dim when Working is off, because neither can
              draw: one has no switch of its own and the other's is moot.
              Showing them live under a dead parent is a switch that does
              nothing, which reads as a bug. */}
          <div className={cn("ml-6 flex items-start gap-2", !workingIndicator && "opacity-40")}>
            <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
              <TaskWorkBadge reason="delegated" delegated={HELD} preview />
            </span>
            <div className="text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
              {t("notifications.markDelegated")}
            </div>
          </div>
          <div className="ml-6">
            <Toggle
              mark={<TaskWorkBadge reason="working" delegated={{ ...HELD, partial: true }} preview />}
              label={t("notifications.markPartial.label")}
              hint={t("notifications.markPartial.hint")}
              value={partialDoneIndicator}
              onChange={setPartialDoneIndicator}
              disabled={!workingIndicator}
            />
          </div>
          <Toggle
            mark={<TaskWorkBadge reason="done" preview />}
            label={t("notifications.markDone.label")}
            hint={t("notifications.markDone.hint")}
            value={settledHighlight}
            onChange={setSettledHighlight}
          />
          <Toggle
            mark={<TaskWorkBadge reason="attention" preview />}
            label={t("notifications.markAttention.label")}
            hint={t("notifications.markAttention.hint")}
            value={attentionIndicator}
            onChange={setAttentionIndicator}
          />
        </div>
      </Block>

      {/* The marks above are all downstream of work-state detection,
          and agent hooks is where that detection comes from. It lives on the
          Agents page because it writes into an agent's own config, so this is
          a pointer rather than the thing itself. */}
      <p className="text-[12.5px] text-[var(--color-fg-dim)]">
        <Trans
          t={t}
          i18nKey="notifications.hooksNote"
          components={{ 1: (
            <button
              type="button"
              className="text-[var(--color-accent)] hover:underline"
              onClick={() => useApp.getState().openSettings("agents", undefined, AGENT_HOOKS_HIGHLIGHT)}
            />
          ) }}
        />
      </p>
    </div>
  );
}
