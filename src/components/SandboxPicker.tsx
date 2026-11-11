// Single flat selector for "how is this task caged", replacing the earlier
// two-tier SandboxEngineSelector (engine) + SandboxModeSelector (Seatbelt
// submode) split. Five peer options: Off, Seatbelt's three modes, and
// Docker, as cards or (`layout="row"`, New Task) one segmented strip.
// Still a UI-only view over the SAME two independent backend fields
// (`sandbox_mode` / `docker_sandbox_enabled`, see SandboxSelection in
// lib/types.ts) - no new data model, just one picker instead of two.
import type { ReactNode } from "react";
import { useTranslation, Trans } from "react-i18next";
import { cn } from "@/lib/utils";
import type { SandboxMode, SandboxSelection } from "@/lib/types";
import { SANDBOX_VISUALS, sandboxPickerLabelT, sandboxModeText, SandboxIcon, DockerSandboxIcon, DOCKER_SANDBOX_COLOR } from "@/components/SandboxIcon";
import { SEATBELT_AVAILABLE } from "@/lib/platform";
import { Checkbox } from "@/components/ui/Checkbox";
import { InfoTip } from "@/components/ui/InfoTip";
import { SANDBOX_PRESETS, presetHint, presetLabel, type SandboxPreset } from "@/lib/sandboxPresets";

/** Row-major order: OFF / ENFORCING (FS) on top, MONITORING / ENFORCING
 *  below, DOCKER on its own row - it's a different MECHANISM, not another
 *  intensity level of the same one, so it reads as a break from the grid
 *  rather than a fifth peer crammed into it. */
const ORDER: SandboxMode[] = ["off", "enforce-fs", "monitor", "enforce"];
const ROW_ORDER: SandboxMode[] = ["off", "monitor", "enforce-fs", "enforce"];

export function SandboxPicker({
  value, onChange, seatbeltUnavailable = false, dockerOffered, dockerUnavailableReason,
  onEnableDocker, compact = false, layout = "cards",
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
  /** "row": one segmented strip with the picked mode's description under it.
   *  "column": the same options stacked, each with its description, for a
   *  pane with width to spare beside them (the New Task dialog's Sandbox
   *  section). Every other surface keeps the cards. `compact` only applies to
   *  the cards. */
  layout?: "cards" | "row" | "column";
}) {
  // Off this OS's map entirely (Windows, Linux): the Seatbelt cards are not
  // shown at all, rather than shown disabled, so the choice reads as what it
  // is there: no cage, or Docker.
  const hideSeatbelt = !SEATBELT_AVAILABLE;
  const order: SandboxMode[] = hideSeatbelt ? ["off"] : ORDER;
  const { t } = useTranslation("chrome");
  // A disabled card with a tooltip is not a route anywhere: it says the
  // option exists and leaves the reader to guess where to turn it on, and a
  // tooltip is invisible to anyone who does not hover a control that looks
  // dead. When Docker is not offered, the way to fix that is a click here.
  const dockerLink = !dockerOffered && onEnableDocker && (
    <button
      type="button"
      onClick={onEnableDocker}
      data-testid="sandbox-picker-enable-docker"
      className="self-start rounded text-left text-[11.5px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]"
    >
      {dockerUnavailableReason ?? t("sandbox.picker.dockerSetup")}
    </button>
  );
  if (layout === "row" || layout === "column") {
    const opts: { id: SandboxSelection; label: string; desc: string; color: string; disabled: boolean; title: string }[] = [
      // the row reads as a scale, loosest to tightest: off, monitor, fs-only, full.
      ...(hideSeatbelt ? ["off" as const] : ROW_ORDER).map(id => {
        const text = sandboxModeText(id, t);
        const unsupported = seatbeltUnavailable && id !== "off";
        return {
          id, label: text.shortLabel, desc: text.desc, color: SANDBOX_VISUALS[id].color,
          disabled: unsupported, title: unsupported ? t("sandbox.picker.macOnly") : text.desc,
        };
      }),
      {
        id: "docker", label: t("sandbox.picker.dockerShort"), desc: t("sandbox.picker.dockerDesc"),
        color: DOCKER_SANDBOX_COLOR, disabled: !dockerOffered,
        title: !dockerOffered ? (dockerUnavailableReason ?? t("sandbox.picker.dockerEnableHint")) : t("sandbox.picker.dockerDesc"),
      },
    ];
    const picked = opts.find(o => o.id === value);
    if (layout === "column") return (
      <div className="flex flex-col gap-1.5">
        <div role="radiogroup" className="flex flex-col gap-1">
          {opts.map(o => {
            const active = value === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={o.disabled}
                data-sandbox-option={o.id}
                aria-pressed={active}
                onClick={() => onChange(o.id)}
                title={o.disabled ? o.title : undefined}
                // No transition-colors: WKWebView does not repaint a themed
                // colour mid-transition (docs/gotchas.md).
                className={cn(
                  "flex w-full min-w-0 items-start gap-2.5 rounded-md border px-2.5 py-2 text-left",
                  active ? "" : "border-transparent hover:bg-[var(--color-hover)]",
                  o.disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
                style={active ? { background: `color-mix(in srgb, ${o.color} 14%, transparent)`, borderColor: o.color } : undefined}
              >
                <span className="mt-[1px] flex shrink-0" style={{ color: o.color }}>
                  {o.id === "docker"
                    ? <DockerSandboxIcon className="h-3.5 w-3.5" />
                    : <SandboxIcon mode={o.id as SandboxMode} className="h-3.5 w-3.5" />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className={cn("text-[12.5px] font-medium", active ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]")}>{o.label}</span>
                  <span className="text-[11.5px] leading-snug text-[var(--color-fg-faint)]">{o.disabled ? o.title : o.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
        {dockerLink}
      </div>
    );
    return (
      <div className="flex flex-col gap-1.5">
        {/* No transition-colors: WKWebView does not repaint a themed colour
            mid-transition (docs/gotchas.md), and the tint IS the selection. */}
        <div className="flex gap-1 rounded-lg bg-[var(--color-bg)] p-1">
          {opts.map(o => {
            const active = value === o.id;
            return (
              <button
                key={o.id}
                type="button"
                disabled={o.disabled}
                data-sandbox-option={o.id}
                aria-pressed={active}
                onClick={() => onChange(o.id)}
                title={o.title}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 py-1.5 text-center text-[12px] font-medium leading-tight",
                  active ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                  o.disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[var(--color-fg-dim)]",
                )}
                style={active ? { background: `color-mix(in srgb, ${o.color} 18%, transparent)`, boxShadow: `inset 0 0 0 1px ${o.color}` } : undefined}
              >
                {o.id === "docker"
                  ? <DockerSandboxIcon className="h-3.5 w-3.5 shrink-0" />
                  : <SandboxIcon mode={o.id as SandboxMode} className="h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 truncate">{o.label}</span>
              </button>
            );
          })}
        </div>
        {picked && (
          <p data-testid="sandbox-mode-desc" className="text-[11.5px] leading-snug text-[var(--color-fg-dim)]">{picked.desc}</p>
        )}
        {dockerLink}
      </div>
    );
  }
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

      {dockerLink}
    </div>
  );
}

/** The per-task Keychain block checkbox. Shared by New Task, Schedule (new
 *  parent), Sandbox and Edit, so none can set an enforcing mode without
 *  showing it; callers render it only for enforce / enforce-fs. `compact`
 *  matches the compact SandboxPicker it sits under (the create dialogs
 *  have a fixed height, so every line here costs a scrollbar). */
export function KeychainBlockField({ checked, onChange, compact = false, tip = false }: {
  checked: boolean; onChange: (v: boolean) => void; compact?: boolean;
  /** Hint behind an (i) instead of under the label. */
  tip?: boolean;
}) {
  const { t } = useTranslation("dialogs");
  if (tip) {
    // the (i) sits outside the label, so clicking it never toggles the box.
    return (
      <div className="flex items-center gap-1.5">
        <label className="flex cursor-pointer items-center gap-2 select-none">
          <Checkbox checked={checked} onChange={onChange} data-testid="sandbox-block-keychain" />
          <span className="text-[12.5px] font-medium text-[var(--color-fg)]">{t("taskSandbox.blockKeychainLabel")}</span>
        </label>
        <InfoTip text={t("taskSandbox.blockKeychainHint")} />
      </div>
    );
  }
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

const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** "Preset:" and one button per bundled preset, shared by every dialog that
 *  edits a task's sandbox lists. The preset the lists already match stays
 *  pressed, so a click always shows. The presets differ only in their hosts,
 *  so in Enforcing (FS), where the host list is hidden, they change nothing
 *  you can see and are left out (`children`, such as a reset button, stay). */
export function SandboxPresetRow({ mode, rw, hosts, onPick, className, children }: {
  mode: SandboxMode;
  /** The two textareas' current text, newline separated. */
  rw: string;
  hosts: string;
  onPick: (p: SandboxPreset) => void;
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation("dialogs");
  const presets = mode === "enforce-fs" ? [] : SANDBOX_PRESETS;
  if (!presets.length && !children) return null;
  return (
    <div data-testid="sandbox-presets" className={cn("flex flex-wrap items-center gap-2 text-[12px]", className)}>
      <span className="text-[var(--color-fg-faint)]">{t("newTask.presetLabel")}</span>
      {presets.map(p => {
        const on = same(lines(rw), p.rwPaths) && same(lines(hosts), p.allowedHosts);
        return (
          <button
            key={p.id} type="button"
            data-preset={p.id}
            aria-pressed={on}
            title={presetHint(p)}
            onClick={() => onPick(p)}
            className={cn(
              "rounded-md border px-2 py-0.5",
              on
                ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-fg)]"
                : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]",
            )}
          >
            {presetLabel(p)}
          </button>
        );
      })}
      {children}
    </div>
  );
}
