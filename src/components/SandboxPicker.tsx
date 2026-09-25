// Single flat selector for "how is this task caged", replacing the earlier
// two-tier SandboxEngineSelector (engine) + SandboxModeSelector (Seatbelt
// submode) split. Five peer cards: Off, Seatbelt's three modes, and Docker.
// Still a UI-only view over the SAME two independent backend fields
// (`sandbox_mode` / `docker_sandbox_enabled`, see SandboxSelection in
// lib/types.ts) - no new data model, just one picker instead of two.
import { useTranslation, Trans } from "react-i18next";
import { cn } from "@/lib/utils";
import type { SandboxMode, SandboxSelection } from "@/lib/types";
import { SANDBOX_VISUALS, sandboxPickerLabelT, sandboxModeText, SandboxIcon, DockerSandboxIcon, DOCKER_SANDBOX_COLOR } from "@/components/SandboxIcon";

/** Row-major order: OFF / ENFORCING (FS) on top, MONITORING / ENFORCING
 *  below, DOCKER on its own row - it's a different MECHANISM, not another
 *  intensity level of the same one, so it reads as a break from the grid
 *  rather than a fifth peer crammed into it. */
const ORDER: SandboxMode[] = ["off", "enforce-fs", "monitor", "enforce"];

export function SandboxPicker({
  value, onChange, seatbeltUnavailable = false, dockerOffered, dockerUnavailableReason,
  onEnableDocker, compact = false,
}: {
  value: SandboxSelection;
  onChange: (s: SandboxSelection) => void;
  /** Disable every Seatbelt card except OFF (sandbox is macOS-only). */
  seatbeltUnavailable?: boolean;
  /** Docker card enabled only once Settings -> Docker Sandbox is on AND an
   *  image is built - there's nothing for it to do otherwise. */
  dockerOffered: boolean;
  /** Tooltip shown on the disabled Docker card explaining why, and the label
   *  of the set-up link below it when `onEnableDocker` is given. */
  dockerUnavailableReason?: string;
  /** Called from a link under the picker when Docker is not offered. Takes
   *  the user to Settings -> Docker Sandbox; without it the disabled card is
   *  a dead end that names a feature and no way to reach it. */
  onEnableDocker?: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("chrome");
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {ORDER.map(id => {
          const v = SANDBOX_VISUALS[id];
          const active = value === id;
          const unsupported = seatbeltUnavailable && id !== "off";
          return (
            <button
              key={id}
              type="button"
              disabled={unsupported}
              onClick={() => onChange(id)}
              title={unsupported ? t("sandbox.picker.macOnly") : sandboxModeText(id, t).desc}
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border text-left transition-colors",
                compact ? "px-3 py-2" : "px-3 py-2.5",
                active ? "bg-[var(--color-bg-2)]" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
                unsupported && "opacity-40 cursor-not-allowed",
              )}
              style={active ? { borderColor: v.color, background: `color-mix(in srgb, ${v.color} 10%, transparent)` } : undefined}
            >
              <div className="flex items-center gap-1.5">
                {/* Icon always wears its mode's tone (even when not selected)
                    so the states are color-coded at a glance. */}
                <SandboxIcon mode={id} className="h-4 w-4 shrink-0" />
                <span className="text-[12px] font-semibold tracking-wide" style={{ color: active ? "var(--color-fg)" : "var(--color-fg-dim)" }}>
                  {sandboxPickerLabelT(id, t)}
                </span>
              </div>
              <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>{sandboxModeText(id, t).desc}</span>
            </button>
          );
        })}
      </div>

      {/* Docker: full-width row of its own, visually breaking from the
          Seatbelt grid above it since it's a different cage mechanism, not
          another intensity level. */}
      {(() => {
        const active = value === "docker";
        const disabled = !dockerOffered;
        const desc = t("sandbox.picker.dockerDesc");
        const title = disabled
          ? (dockerUnavailableReason ?? t("sandbox.picker.dockerEnableHint"))
          : desc;
        return (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange("docker")}
            title={title}
            className={cn(
              "flex flex-col items-start gap-1 rounded-md border text-left transition-colors",
              compact ? "px-3 py-2" : "px-3 py-2.5",
              active ? "bg-[var(--color-bg-2)]" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
              disabled && "opacity-40 cursor-not-allowed",
            )}
            style={active ? { borderColor: DOCKER_SANDBOX_COLOR, background: `color-mix(in srgb, ${DOCKER_SANDBOX_COLOR} 10%, transparent)` } : undefined}
          >
            <div className="flex items-center gap-1.5">
              <DockerSandboxIcon className="h-4 w-4 shrink-0" />
              <span className="text-[12px] font-semibold tracking-wide" style={{ color: active ? "var(--color-fg)" : "var(--color-fg-dim)" }}>
                {t("sandbox.picker.dockerTitle")}
              </span>
            </div>
            <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>{desc}</span>
          </button>
        );
      })()}

      {/* A disabled card with a tooltip is not a route anywhere: it says the
          option exists and leaves the reader to guess where to turn it on,
          and a tooltip is invisible to anyone who does not hover a control
          that looks dead. When Docker is not offered, the way to fix that is
          a click here. */}
      {!dockerOffered && onEnableDocker && (
        <button
          type="button"
          onClick={onEnableDocker}
          data-testid="sandbox-picker-enable-docker"
          className="self-start rounded text-left text-[11.5px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]"
        >
          {dockerUnavailableReason ?? t("sandbox.picker.dockerSetup")}
        </button>
      )}
    </div>
  );
}

/** Shown under the picker when "Docker Container" is the picked selection -
 *  the one thing every Docker surface in this app repeats: it's currently
 *  a filesystem-only cage. */
export function DockerEngineNote({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>
      <Trans i18nKey="sandbox.dockerNote" ns="chrome" components={{ u: <u /> }} />
    </div>
  );
}
