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
import { Shield, ShieldOff, Container, type LucideIcon } from "lucide-react";
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

/** Locale key for a mode under chrome:sandbox.modes. */
const MODE_KEY: Record<SandboxMode, string> = {
  off: "off", "enforce-fs": "enforceFs", monitor: "monitor", enforce: "enforce",
};

/** Translated label/shortLabel/desc for a mode. Takes the caller's `t` (bound
 *  to the chrome namespace) so the text re-renders on a language switch;
 *  SANDBOX_VISUALS keeps the English strings as the visual table's data, but
 *  user-visible surfaces should go through here. */
export function sandboxModeText(mode: SandboxMode, t: (k: string) => string): Pick<SandboxVisual, "label" | "shortLabel" | "desc"> {
  const k = `sandbox.modes.${MODE_KEY[mode]}`;
  return { label: t(`${k}.label`), shortLabel: t(`${k}.shortLabel`), desc: t(`${k}.desc`) };
}

/** Uppercase only the leading keyword for the picker's chip styling:
 *  "Enforcing (filesystem only)" → "ENFORCING (filesystem only)". */
export function sandboxPickerLabel(mode: SandboxMode): string {
  const l = SANDBOX_VISUALS[mode].label;
  const i = l.indexOf(" ");
  return i === -1 ? l.toUpperCase() : l.slice(0, i).toUpperCase() + l.slice(i);
}

/** Translated variant of sandboxPickerLabel. Chinese has no case, so the
 *  uppercase pass is a no-op there and the label renders as-is. */
export function sandboxPickerLabelT(mode: SandboxMode, t: (k: string) => string): string {
  const l = sandboxModeText(mode, t).label;
  const i = l.indexOf(" ");
  return i === -1 ? l.toUpperCase() : l.slice(0, i).toUpperCase() + l.slice(i);
}

/** Shared icon renderer. Glyph, color and fill ALL come from
 *  SANDBOX_VISUALS, so they cannot drift between surfaces.
 *
 *  There is deliberately no per-call glyph override. There was one, used by
 *  exactly one caller (the toolbar swapped in an Eye for monitoring), and it
 *  defeated the point of the table: the toolbar is the surface a user reads at
 *  a glance, and it was the only one disagreeing with the sidebar row, the
 *  footer chip and the mode picker about what monitoring looks like. A mode
 *  that wants a different glyph changes `Icon` in the table, where every
 *  surface picks it up.
 *
 *  (Activity state is shown by callers via opacity, not fill — fill always
 *  encodes the mode so the two enforce variants stay distinguishable.) */
export function SandboxIcon({ mode, className, active = true }: {
  mode: SandboxMode;
  className?: string;
  /** False = the task isn't currently running an agent - shows the same
   *  faint gray as OFF regardless of mode (enforce green, monitor amber,
   *  etc. are a LIVE status, not a settings badge; a task sitting idle
   *  shouldn't visually claim to be actively caging anything). True (the
   *  default) keeps every existing caller's behavior unchanged. */
  active?: boolean;
}) {
  const v = SANDBOX_VISUALS[mode];
  const Icon = v.Icon;
  const color = active ? v.color : "var(--color-fg-faint)";
  return <Icon className={className} style={{ color }} fill={v.filled ? "currentColor" : "none"} />;
}

/** Same green as Seatbelt's `enforce`/`enforce-fs` (`--color-ok`): Docker
 *  mode IS a real filesystem cage, same as those two, just via a different
 *  mechanism. (An earlier version of this used the red `--color-err`
 *  warning color, on the mistaken assumption it was already established
 *  for Seatbelt - that red is YOLO's "on without a cage" warning color,
 *  unrelated to any sandbox MODE's own identity.) */
export const DOCKER_SANDBOX_COLOR = "var(--color-ok)";

/** Docker's equivalent of `SandboxIcon` - same shape (a colored glyph,
 *  nothing else) so call sites that show "which cage" can drop this in
 *  next to `SandboxIcon` without a different contract. */
export function DockerSandboxIcon({ className, active = true }: { className?: string; active?: boolean }) {
  return <Container className={className} style={{ color: active ? DOCKER_SANDBOX_COLOR : "var(--color-fg-faint)" }} />;
}
