// Shared OFF / MONITORING / ENFORCING selector used by both the New
// Workspace dialog and the Edit Sandbox dialog. Single source of truth for
// the mode list + styling so the two can't drift.
import { Shield, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SandboxMode } from "@/lib/types";

const MODES: { id: SandboxMode; label: string; desc: string; icon: typeof Shield; tone: string }[] = [
  { id: "off",     label: "OFF",        desc: "Full filesystem + network access.",                     icon: ShieldOff, tone: "var(--color-err)" },
  { id: "monitor", label: "MONITORING", desc: "Allow everything, but LOG every file + network access.", icon: Shield,    tone: "var(--color-warn)" },
  { id: "enforce", label: "ENFORCING",  desc: "Real cage: deny outside the allow-list.",                icon: Shield,    tone: "var(--color-ok)" },
];

export function SandboxModeSelector({ value, onChange, osUnavailable = false, compact = false }: {
  value: SandboxMode;
  onChange: (m: SandboxMode) => void;
  /** Disable monitor/enforce (sandbox is macOS-only). OFF stays available. */
  osUnavailable?: boolean;
  /** Tighter padding/type (New Workspace dialog's narrower column). */
  compact?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {MODES.map(m => {
        const active = value === m.id;
        const unsupported = osUnavailable && m.id !== "off";
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            type="button"
            disabled={unsupported}
            onClick={() => onChange(m.id)}
            title={unsupported ? "Sandbox is macOS-only (requires sandbox-exec)." : m.desc}
            className={cn(
              "flex flex-col items-start gap-1 rounded-md border text-left transition-colors",
              compact ? "px-3 py-2" : "px-3 py-2.5",
              active ? "bg-[var(--color-bg-2)]" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
              unsupported && "opacity-40 cursor-not-allowed",
            )}
            style={active ? { borderColor: m.tone, background: `color-mix(in srgb, ${m.tone} 10%, transparent)` } : undefined}
          >
            <div className="flex items-center gap-1.5">
              <Icon className="h-4 w-4 shrink-0" style={{ color: active ? m.tone : "var(--color-fg-faint)" }}
                fill={active && m.id === "enforce" ? "currentColor" : "none"} />
              <span className="text-[12px] font-semibold tracking-wide" style={{ color: active ? "var(--color-fg)" : "var(--color-fg-dim)" }}>{m.label}</span>
            </div>
            <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>{m.desc}</span>
          </button>
        );
      })}
    </div>
  );
}
