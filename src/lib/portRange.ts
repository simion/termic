// GH #271: the port window task blocks are allocated from.
//
// The rules here MIRROR `PortRange::from_settings` in lib.rs and exist for a
// different reason: Rust sanitizes silently so a bad settings file can never
// leave the app unable to create the task that would fix it, while this tells
// the user WHY the value they typed is not allowed, before they save it.
// Keep the two in step - a UI that accepts a range Rust then ignores is worse
// than one that never accepted it.

import { i18n } from "@/lib/i18n";

/** Default window. Chosen to sit above the ports ordinary dev servers use,
 *  which is exactly what a user narrowing it to 3000-4000 gives up. */
export const PORT_RANGE_DEFAULT = { min: 18100, max: 65535 } as const;

/** Below this a port is privileged or reserved; the allocator never hands one
 *  out, and `PORT_ALLOC_MIN` in lib.rs clamps anything lower. */
export const PORT_RANGE_FLOOR = 1024;

/** Smallest block the allocator ever asks for: 1 ($TERMIC_PORT) + the 5-port
 *  buffer, for a single-repo task with no extra named ports. `block_len` in
 *  lib.rs. A range that cannot fit one is not a range. */
export const PORT_BLOCK_MIN = 6;

export type PortRange = { min: number; max: number };

/** What the backend will actually use for the stored pair, 0 meaning unset. */
export function resolvePortRange(
  min: number | undefined,
  max: number | undefined,
): PortRange {
  const m = !min ? PORT_RANGE_DEFAULT.min : Math.max(min, PORT_RANGE_FLOOR);
  const x = !max ? PORT_RANGE_DEFAULT.max : max;
  if (x <= m || x - m < PORT_BLOCK_MIN) return { ...PORT_RANGE_DEFAULT };
  return { min: m, max: x };
}

/** The message to show under the inputs, or null when the range is savable.
 *  One string per distinct mistake: "invalid" alone leaves the user guessing
 *  which of the two numbers to change. */
export function portRangeError(min: number, max: number): string | null {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return i18n.t("backend:portRange.wholeNumbers");
  if (min < PORT_RANGE_FLOOR) return i18n.t("backend:portRange.floor", { floor: PORT_RANGE_FLOOR });
  if (max > 65535) return i18n.t("backend:portRange.max65535");
  if (max <= min) return i18n.t("backend:portRange.maxAboveMin");
  if (max - min < PORT_BLOCK_MIN) return `A range needs at least ${PORT_BLOCK_MIN} ports: each task takes a consecutive block.`;
  return null;
}

/** Roughly how many tasks the range holds, for the hint under the inputs.
 *  Deliberately the SMALLEST block size: a multi-repo task or one with extra
 *  named ports takes more, so this is an upper bound, and the hint says so. */
export function tasksThatFit(min: number, max: number): number {
  return Math.max(0, Math.floor((max - min + 1) / PORT_BLOCK_MIN));
}
