// Main-pane view while a Docker-mode task's agent waits on the sandbox image
// being rebuilt before launch.
//
// Modelled on CreatingTaskPane deliberately: this is the same situation - the
// pane belongs to a task that cannot show its real content yet, and the
// honest thing is to show what is actually happening in it. A toast alone
// left the pane empty for minutes with no way to tell a slow build (a
// --no-cache build of a multi-GB image genuinely takes a while) from a wedged
// one, which is exactly how a hang went unnoticed once.
//
// Temporary by construction: `useDockerBuild` clears itself on success, so the
// terminal takes the pane back the moment the agent can start. A FAILED build
// is left on screen instead - the log is the only explanation the user gets,
// and the agent is about to launch on the old image anyway.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertTriangle, Container } from "lucide-react";
import { useDockerBuild } from "@/store/dockerBuild";
import { cn } from "@/lib/utils";

export function DockerBuildPane({ taskId }: { taskId: string }) {
  // Selectors, not the whole store: log lines land several times a second and
  // only this pane should re-render for them.
  const active = useDockerBuild(s => s.taskId === taskId);
  const lines = useDockerBuild(s => s.lines);
  const status = useDockerBuild(s => s.status);
  const clear = useDockerBuild(s => s.clear);
  const outputRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("panels");

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  if (!active) return null;
  const failed = status === "failed";

  return (
    <div
      data-testid="docker-build-pane"
      className="absolute inset-0 z-10 flex h-full min-h-0 flex-col bg-[var(--color-bg)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] px-4 py-2.5 text-[13px] font-medium">
        {failed
          ? <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-err)]" />
          : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--color-fg-dim)]" />}
        <Container className="h-4 w-4 shrink-0 text-[var(--color-fg-dim)]" />
        <span className="truncate">{t("dockerBuild.title")}</span>
        <span className={cn("shrink-0", failed ? "text-[var(--color-err)]" : "text-[var(--color-fg-faint)]")}>
          {failed ? t("dockerBuild.failed") : t("dockerBuild.rebuilding")}
        </span>
        {failed && (
          <button
            type="button"
            onClick={clear}
            className="ml-auto shrink-0 rounded px-2 py-0.5 text-[12px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            {t("dismiss", { ns: "common" })}
          </button>
        )}
      </div>
      <div
        ref={outputRef}
        data-testid="docker-build-log"
        data-selectable
        className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]"
      >
        {lines.length === 0
          ? <span className="text-[var(--color-fg-faint)]">{t("dockerBuild.waiting")}</span>
          : lines.map((line, i) => <div key={i} className="whitespace-pre-wrap break-words">{line}</div>)}
      </div>
    </div>
  );
}
