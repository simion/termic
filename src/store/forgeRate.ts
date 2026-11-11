// GitHub rate ledger, mirrored from Rust (forge_rate.rs): per host, the
// account's limit and what is left, termic's own spend this hour by
// feature, and whether background polling is paused. Read by the Settings
// forge block and the top-bar pill. Does NOT write to useApp (bear traps 5
// and 8): it changes on every GitHub answer.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { forgeRateStatus } from "@/lib/ipc";
import { i18n } from "@/lib/i18n";
import type { ForgeRatePause, ForgeRateStatus } from "@/lib/types";

interface ForgeRateState {
  hosts: ForgeRateStatus[];
  /** Ask Rust for the ledger. `probe` seeds unknown hosts first. */
  refresh: (probe?: boolean) => Promise<void>;
}

/** The first host whose background polling is paused right now, or null.
 *  A pause whose time has passed does not count: the ledger lifts it by
 *  itself and only says so on the next answer. */
export function activePause(hosts: ForgeRateStatus[], nowSecs = Date.now() / 1000): (ForgeRatePause & { host: string }) | null {
  for (const h of hosts) {
    if (h.paused && h.paused.until > nowSecs) return { ...h.paused, host: h.host };
  }
  return null;
}

/** "14:05", the local clock time of an epoch-seconds instant. */
export function clockAt(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The sentence for a lookup GitHub refused on a limit (status
 *  "rate-limited"), timed from the ledger's pause. Rust's own message is
 *  English and in Rust's clock; this follows the UI language. */
export function rateLimitedText(until = activePause(useForgeRate.getState().hosts)?.until): string {
  return until
    ? i18n.t("chrome:forgeRatePill.refused", { time: clockAt(until) })
    : i18n.t("chrome:forgeRatePill.refusedSoon");
}

/** The line under a lookup that did not answer: for "rate-limited", the
 *  UI's own sentence timed from the lookup's `retry_at` (Rust's message is
 *  English and in Rust's clock); anything else, Rust's message. */
export function lookupMessage(a: { status: string; message: string; retry_at?: number | null }): string {
  return a.status === "rate-limited" ? rateLimitedText(a.retry_at ?? undefined) : a.message;
}

/** setTimeout's ceiling. Rust caps a pause a day ahead, well under it; this
 *  keeps a pause past it from wrapping into an immediate re-fire loop. */
const MAX_TIMER_MS = 2 ** 31 - 1;

let liftTimer: number | null = null;
/** Bumped by every pushed event. A pull that resolves after an event landed
 *  while it was in flight is dropped: Rust orders its pushes, but a pull's
 *  snapshot may predate the event and would hide a pause Rust is holding. */
let eventSeq = 0;

/** Writes through `useForgeRate.setState` by property lookup on purpose:
 *  the e2e spec (settings.e2e.ts, forge rate describe) holds the store on
 *  its seed by replacing that property, so a real ledger event cannot swap a
 *  real hostname into its screenshot. Writing through `create`'s own `set`
 *  would silently bypass the hold. */
function apply(hosts: ForgeRateStatus[]) {
  // Unchanged answers write nothing, so a steady ledger re-renders nobody.
  if (JSON.stringify(hosts) !== JSON.stringify(useForgeRate.getState().hosts)) {
    useForgeRate.setState({ hosts });
  }
  // A pause ends on a clock, not an event: look again when it should lift,
  // so the pill does not outlive it.
  if (liftTimer !== null) clearTimeout(liftTimer);
  liftTimer = null;
  const p = activePause(hosts);
  if (p) {
    const ms = Math.min(MAX_TIMER_MS, Math.max(1000, (p.until + 1) * 1000 - Date.now()));
    liftTimer = window.setTimeout(() => { void useForgeRate.getState().refresh(); }, ms);
  }
}

export const useForgeRate = create<ForgeRateState>(() => ({
  hosts: [],
  refresh: async (probe = false) => {
    const seq = eventSeq;
    try {
      const hosts = await forgeRateStatus(probe);
      if (seq === eventSeq) apply(hosts);
    } catch { /* keep the last answer */ }
  },
}));

let started = false;

/** Listen for ledger changes and seed it once. Idempotent; called from App
 *  after the forge CLIs are detected (the probe needs their host list). */
export function initForgeRate() {
  if (started) return;
  started = true;
  void listen<ForgeRateStatus[]>("termic://forge-rate-changed", (e) => { eventSeq++; apply(e.payload); });
  void useForgeRate.getState().refresh(true);
}
