// Shared Off / Daily / Weekly pill selector for Settings.docker_rebuild_frequency,
// used by both Settings → Docker Sandbox and DockerRebuildPromptDialog (the inline
// "change your mind" control on the launch-time nudge).
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type Frequency = "off" | "daily" | "weekly";
const FREQUENCIES: Frequency[] = ["off", "daily", "weekly"];

export function DockerRebuildFrequencyPicker({ value, onChange }: {
  value: Frequency;
  onChange: (v: Frequency) => void;
}) {
  const { t } = useTranslation("chrome");
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {FREQUENCIES.map(f => {
        const active = value === f;
        return (
          <button
            key={f}
            type="button"
            onClick={() => onChange(f)}
            className={cn(
              "rounded-md border px-2 py-1.5 text-[12px] font-medium transition-[color,background-color]",
              active
                ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-fg)]"
                : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)]",
            )}
          >
            {t(`dockerRebuild.${f}`)}
          </button>
        );
      })}
    </div>
  );
}
