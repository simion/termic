export type CompletionSoundId =
  | "conductor"
  | "choo_choo"
  | "basso"
  | "blow"
  | "funk"
  | "glass"
  | "hero"
  | "ping"
  | "pop"
  | "submarine"
  | "tink";

import { IS_MAC } from "@/lib/shortcuts";

/** The string notify.m maps back to the real default-sound constant. */
export const MACOS_DEFAULT_SOUND = "NSUserNotificationDefaultSoundName";

/** The whole completion-sound feature is macOS-only: every catalog entry
 *  is a macOS system-sound name (or a .caf installed into ~/Library/Sounds),
 *  none of which resolve as Linux/Windows notification sounds. Gates both
 *  the Settings UI and the notify-time resolver. */
export const COMPLETION_SOUND_SUPPORTED = IS_MAC;

export type CompletionSoundOption = {
  id: CompletionSoundId;
  label: string;
  /** The name macOS resolves via its Library/Sounds search path. System
   *  sounds use their stock name; bundled sounds (choo_choo) use the
   *  extension-less name they're installed under (see
   *  install_notification_sound). THE single sound catalog — the resolver
   *  in ipc.ts derives from this, so adding a sound is one entry here. */
  macName: string;
};

export const LS_COMPLETION_SOUND = "completionSound";
export const LS_COMPLETION_SOUND_ID = "completionSoundId";
export const DEFAULT_COMPLETION_SOUND_ID: CompletionSoundId = "funk";

export const COMPLETION_SOUND_OPTIONS: CompletionSoundOption[] = [
  { id: "funk", label: "Funk", macName: "Funk" },
  { id: "conductor", label: "macOS", macName: MACOS_DEFAULT_SOUND },
  { id: "choo_choo", label: "Choo Choo", macName: "termic_choo_choo" },
  { id: "ping", label: "Ping", macName: "Ping" },
  { id: "blow", label: "Blow", macName: "Blow" },
  { id: "basso", label: "Basso", macName: "Basso" },
  { id: "glass", label: "Glass", macName: "Glass" },
  { id: "hero", label: "Hero", macName: "Hero" },
  { id: "pop", label: "Pop", macName: "Pop" },
  { id: "submarine", label: "Submarine", macName: "Submarine" },
  { id: "tink", label: "Tink", macName: "Tink" },
];

const COMPLETION_SOUND_IDS = new Set<CompletionSoundId>(COMPLETION_SOUND_OPTIONS.map(o => o.id));

export function isCompletionSoundId(value: string): value is CompletionSoundId {
  return COMPLETION_SOUND_IDS.has(value as CompletionSoundId);
}

export function completionSoundMacName(id: CompletionSoundId): string {
  return COMPLETION_SOUND_OPTIONS.find(o => o.id === id)!.macName;
}

// ── Shared localStorage readers ──
// Both the prefs store (reactive, for the Settings UI) and the notify
// resolver in ipc.ts (lazy, at notification time) need these prefs. The
// parse-and-validate lives HERE, once — ipc.ts can't read the prefs store
// directly (prefs.ts imports ipc.ts), and two hand-rolled copies were how
// the readers drifted in review.

export function readCompletionSoundEnabled(): boolean {
  try { return localStorage.getItem(LS_COMPLETION_SOUND) === "1"; } catch { return false; }
}

export function readCompletionSoundId(): CompletionSoundId {
  try {
    const raw = localStorage.getItem(LS_COMPLETION_SOUND_ID) ?? DEFAULT_COMPLETION_SOUND_ID;
    return isCompletionSoundId(raw) ? raw : DEFAULT_COMPLETION_SOUND_ID;
  } catch {
    return DEFAULT_COMPLETION_SOUND_ID;
  }
}
