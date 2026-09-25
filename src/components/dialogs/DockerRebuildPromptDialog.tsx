// Prompt shown right before a Docker-mode task's agent launches, when the
// sandbox image is due for a rebuild per Settings.docker_rebuild_frequency
// (off/daily/weekly, default daily). Agent CLIs baked into the image are
// unpinned/always-latest, so without this nudge an old image just keeps
// running whatever it happened to install last time it was built.
//
// Three actions, not a confirm-style yes/no: "Rebuild now" (default focus -
// the common case), "Skip for now" one click away for someone in a hurry, and
// "Always rebuild", which does this one AND stops asking. The last exists
// because the prompt's whole justification is that a rebuild delays the
// launch you just asked for; once you have decided you always want it, being
// asked every time is the annoyance rather than the safeguard. It writes a
// setting rather than a session flag, and Settings -> Docker Sandbox can undo
// it. The frequency selector is inline so changing your mind about how often
// this should ask doesn't require a trip to Settings.

import { useTranslation, Trans } from "react-i18next";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useBackendSettings } from "@/components/settings/Controls";
import { DockerRebuildFrequencyPicker } from "@/components/DockerRebuildFrequencyPicker";
import { describeLastBuildDate } from "@/lib/dockerDailyRebuild";
import { Container, RotateCw, SkipForward, Clock } from "lucide-react";

export function DockerRebuildPromptDialog() {
  const { t } = useTranslation("dialogs");
  const prompt = useUI(s => s.dockerRebuildPrompt);
  const resolve = useUI(s => s.resolveDockerRebuildPrompt);
  // Own settings fetch (not the caller's): this dialog can outlive whatever
  // triggered it and just needs the current frequency to display/edit.
  const { settings, patch } = useBackendSettings();

  if (!prompt) return null;
  const frequency = settings?.docker_rebuild_frequency ?? "daily";

  return (
    <AppDialog
      open
      onOpenChange={(v) => { if (!v) resolve("skip"); }}
      title={t("dockerRebuild.title")}
      className="max-w-xl"
    >
      <div className="flex flex-col gap-4 pt-1 text-[13.5px] text-[var(--color-fg-dim)] leading-relaxed">
        <p className="flex items-start gap-2.5">
          <Container className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span>
            <Trans
              t={t}
              i18nKey="dockerRebuild.bodyRunsIn"
              values={{ name: prompt.taskName }}
              components={{ b: <span className="font-medium text-[var(--color-fg)]" /> }}
            />{" "}
            {describeLastBuildDate(prompt.lastBuiltDate)} {t("dockerRebuild.bodyBehind")}
          </span>
        </p>

        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-faint)]">
            {t("dockerRebuild.frequency")}
          </div>
          <DockerRebuildFrequencyPicker value={frequency} onChange={v => patch({ docker_rebuild_frequency: v })} />
        </div>
      </div>

      {/* Three answers, which is the whole decision: not now, do it without
          bothering me again, or do it before this launch.

          There is no one-off "in background" button. Wanting the rebuild to
          not block you once is essentially never a one-time preference, and a
          fourth button was already overflowing this dialog. "Always" IS the
          background option, which is also what makes it the answer the
          feature is actually for: the point is that the image stays current
          on its own. */}
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost" type="button" onClick={() => resolve("skip")}>
          <SkipForward className="h-3.5 w-3.5" /> {t("dockerRebuild.skipForNow")}
        </Button>
        {/* Hidden on "off": there is no schedule to defer to, so the button
            would promise something it cannot deliver. */}
        {/* "Rebuild now" is no longer the accent button. Blocking a launch
            you already asked for is the costly answer, and the background one
            reaches the same place without the wait - so the colour should
            point at the action most people should take, not the most
            forceful-sounding one. It is also the default configuration, so
            anyone seeing this dialog turned that off and the button is how
            they turn it back on. */}
        <Button variant="secondary" type="button" onClick={() => resolve("rebuild")}>
          <RotateCw className="h-3.5 w-3.5" /> {t("dockerRebuild.rebuildNow")}
        </Button>
        {frequency !== "off" && (
          <Button
            variant="primary"
            type="button"
            autoFocus
            title={t("dockerRebuild.alwaysTitle")}
            onClick={() => resolve("always")}
          >
            <Clock className="h-3.5 w-3.5" /> {t("dockerRebuild.alwaysBackground")}
          </Button>
        )}
      </div>
    </AppDialog>
  );
}
