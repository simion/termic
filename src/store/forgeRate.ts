// GitHub rate ledger, mirrored from Rust (forge_rate.rs): per host, the
// account's limit and what is left, termic's own spend this hour by
// feature, and whether background polling is paused. Read by the Settings
// forge block and the top-bar pill. Does NOT write to useApp (bear traps 5
// and 8): it changes on every GitHub answer.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { forgeRateStatus } from "@/lib/ipc";
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

let liftTimer: number | null = null;

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
    const ms = Math.max(1000, (p.until + 1) * 1000 - Date.now());
    liftTimer = window.setTimeout(() => { void useForgeRate.getState().refresh(); }, ms);
  }
}

export const useForgeRate = create<ForgeRateState>(() => ({
  hosts: [],
  refresh: async (probe = false) => {
    try { apply(await forgeRateStatus(probe)); } catch { /* keep the last answer */ }
  },
}));

let started = false;

/** Listen for ledger changes and seed it once. Idempotent; called from App
 *  after the forge CLIs are detected (the probe needs their host list). */
export function initForgeRate() {
  if (started) return;
  started = true;
  void listen<ForgeRateStatus[]>("termic://forge-rate-changed", (e) => apply(e.payload));
  void useForgeRate.getState().refresh(true);
}
