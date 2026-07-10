// Shared OFF / MONITORING / ENFORCING selector used by both the New
// Task dialog and the Edit Sandbox dialog. All per-mode styling
// (icon, color, fill, labels, order) lives in SANDBOX_VISUALS — see
// SandboxIcon.tsx. This file is just the picker layout.
import { cn } from "@/lib/utils";
import type { SandboxMode } from "@/lib/types";
import { SANDBOX_VISUALS, SANDBOX_PICKER_ORDER, sandboxPickerLabel, SandboxIcon } from "@/components/SandboxIcon";

export function SandboxModeSelector({ value, onChange, osUnavailable = false, compact = false }: {
  value: SandboxMode;
  onChange: (m: SandboxMode) => void;
  /** Disable monitor/enforce (sandbox is macOS-only). OFF stays available. */
  osUnavailable?: boolean;
  /** Tighter padding/type (New Task dialog's narrower column). */
  compact?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {SANDBOX_PICKER_ORDER.map(id => {
        const v = SANDBOX_VISUALS[id];
        const active = value === id;
        const unsupported = osUnavailable && id !== "off";
        return (
          <button
            key={id}
            type="button"
            disabled={unsupported}
            onClick={() => onChange(id)}
            title={unsupported ? "Sandbox is macOS-only (requires sandbox-exec)." : v.desc}
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
                  so the four states are color-coded at a glance. */}
              <SandboxIcon mode={id} className="h-4 w-4 shrink-0" />
              <span className="text-[12px] font-semibold tracking-wide" style={{ color: active ? "var(--color-fg)" : "var(--color-fg-dim)" }}>{sandboxPickerLabel(id)}</span>
            </div>
            <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>{v.desc}</span>
          </button>
        );
      })}
    </div>
  );
}
