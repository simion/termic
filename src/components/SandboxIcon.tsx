// Single source of truth for how every sandbox MODE looks: which icon,
// what color, filled vs outline shield, and its labels. Every surface
// (mode picker, toolbar, footer status, sidebar badge + dropdown) reads
// from here so a styling change is a ONE-LINE edit in SANDBOX_VISUALS
// instead of a 5-file sweep.
//
// Convention recap (so the table reads at a glance):
//   off        → muted ShieldOff   (no cage)
//   monitor    → amber Shield      (observe only)
//   enforce-fs → green OUTLINE     (filesystem cage, network open)
//   enforce    → green FILLED      (filesystem + network cage)
// Both enforce modes share the green; FILL is what tells them apart.
import { Shield, ShieldOff, type LucideIcon } from "lucide-react";
import type { SandboxMode } from "@/lib/types";

export interface SandboxVisual {
  /** Mixed-case label, e.g. "Enforcing (filesystem only)". */
  label: string;
  /** Compact label for chips/menus, e.g. "Enforcing (FS)". */
  shortLabel: string;
  /** One-line description shown in the mode picker. */
  desc: string;
  /** Theme color var for the icon (and the picker's active border/bg). */
  color: string;
  /** Shield filled (full enforce) vs outline. The ONE fill source. */
  filled: boolean;
  /** Canonical icon for the mode. */
  Icon: LucideIcon;
}

export const SANDBOX_VISUALS: Record<SandboxMode, SandboxVisual> = {
  off: {
    label: "Off", shortLabel: "Off",
    desc: "Full filesystem + network access.",
    color: "var(--color-fg-faint)", filled: false, Icon: ShieldOff,
  },
  "enforce-fs": {
    label: "Enforcing (filesystem only)", shortLabel: "Enforcing (FS)",
    desc: "Filesystem cage only, network unrestricted.",
    color: "var(--color-ok)", filled: false, Icon: Shield,
  },
  monitor: {
    label: "Monitoring", shortLabel: "Monitoring",
    desc: "Allow everything, but LOG every file + network access.",
    color: "var(--color-warn)", filled: false, Icon: Shield,
  },
  enforce: {
    label: "Enforcing (filesystem + network)", shortLabel: "Enforcing",
    desc: "Real cage: deny outside the allow-list.",
    color: "var(--color-ok)", filled: true, Icon: Shield,
  },
};

/** Order the mode picker renders, row-major into a 2-col grid:
 *    OFF                  | ENFORCING (filesystem only)
 *    MONITORING           | ENFORCING (filesystem + network)  */
export const SANDBOX_PICKER_ORDER: SandboxMode[] = ["off", "enforce-fs", "monitor", "enforce"];

/** Uppercase only the leading keyword for the picker's chip styling:
 *  "Enforcing (filesystem only)" → "ENFORCING (filesystem only)". */
export function sandboxPickerLabel(mode: SandboxMode): string {
  const l = SANDBOX_VISUALS[mode].label;
  const i = l.indexOf(" ");
  return i === -1 ? l.toUpperCase() : l.slice(0, i).toUpperCase() + l.slice(i);
}

/** Shared icon renderer. Color + fill come from SANDBOX_VISUALS so they
 *  can never drift between surfaces. `icon` overrides the glyph (the
 *  toolbar uses Eye for monitoring); everything else is canonical.
 *  (Activity state is shown by callers via opacity, not fill — fill always
 *  encodes the mode so the two enforce variants stay distinguishable.) */
export function SandboxIcon({ mode, className, icon }: {
  mode: SandboxMode;
  className?: string;
  icon?: LucideIcon;
}) {
  const v = SANDBOX_VISUALS[mode];
  const Icon = icon ?? v.Icon;
  return <Icon className={className} style={{ color: v.color }} fill={v.filled ? "currentColor" : "none"} />;
}
