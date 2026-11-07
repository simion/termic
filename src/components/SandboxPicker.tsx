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
import { SEATBELT_AVAILABLE } from "@/lib/platform";
import { Checkbox } from "@/components/ui/Checkbox";

/** Row-major order: OFF / ENFORCING (FS) on top, MONITORING / ENFORCING
 *  below, DOCKER on its own row - it's a different MECHANISM, not another
 *  intensity level of the same one, so it reads as a break from the grid
 *  rather than a fifth peer crammed into it. */
const ORDER: SandboxMode[] = ["off", "enforce-fs", "monitor", "enforce"];

export function SandboxPicker({
  value, onChange, seatbeltUnavailable = false, dockerOffered, dockerUnavailableReason,
  onEnableDocker, compact = false,
}: {
  /** null: nothing picked yet, no card highlighted (the schedule dialog,
   *  when the default it would seed is a cage it cannot offer). */
  value: SandboxSelection | null;
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
  // Off this OS's map entirely (Windows, Linux): the Seatbelt cards are not
  // shown at all, rather than shown disabled, so the choice reads as what it
  // is there: no cage, or Docker.
  const hideSeatbelt = !SEATBELT_AVAILABLE;
  const order: SandboxMode[] = hideSeatbelt ? ["off"] : ORDER;
  const { t } = useTranslation("chrome");
  return (
    <div className="flex flex-col gap-2">
      <div className={cn("grid gap-2", hideSeatbelt ? "grid-cols-1" : "grid-cols-2")}>
        {order.map(id => {
          const v = SANDBOX_VISUALS[id];
          const active = value === id;
          const unsupported = seatbeltUnavailable && id !== "off";
          return (
            <button
              key={id}
              type="button"
              disabled={unsupported}
              data-sandbox-option={id}
              aria-pressed={active}
              onClick={() => onChange(id)}
              title={unsupported ? t("sandbox.picker.macOnly") : sandboxModeText(id, t).desc}
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border text-left",
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
            data-sandbox-option="docker"
            aria-pressed={active}
            onClick={() => onChange("docker")}
            title={title}
            className={cn(
              "flex flex-col items-start gap-1 rounded-md border text-left",
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

/** The per-task Keychain block checkbox. Shared by New Task, Schedule (new
 *  parent), Sandbox and Edit, so none can set an enforcing mode without
 *  showing it; callers render it only for enforce / enforce-fs. `compact`
 *  matches the compact SandboxPicker it sits under (the create dialogs
 *  have a fixed height, so every line here costs a scrollbar). */
export function KeychainBlockField({ checked, onChange, compact = false }: { checked: boolean; onChange: (v: boolean) => void; compact?: boolean }) {
  const { t } = useTranslation("dialogs");
  return (
    <label className={cn("flex cursor-pointer items-start select-none", compact ? "gap-2" : "gap-3")}>
      <Checkbox checked={checked} onChange={onChange} data-testid="sandbox-block-keychain" />
      <div className="flex flex-col">
        <span className={cn("font-medium text-[var(--color-fg)]", compact ? "text-[12.5px]" : "text-[13.5px]")}>
          {t("taskSandbox.blockKeychainLabel")}
        </span>
        <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "mt-1 text-[12.5px] leading-relaxed")}>
          {t("taskSandbox.blockKeychainHint")}
        </span>
      </div>
    </label>
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
