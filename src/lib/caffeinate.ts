import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type CaffeinateMode = "off" | "duration" | "until" | "agents" | "indefinite";
/** The duration preset that means "until turned off". */
export const INDEFINITE = "∞";
/** The popover's three tabs; indefinite lives under Duration as its ∞ preset. */
export type CaffeinateTab = Exclude<CaffeinateMode, "off" | "indefinite">;
export interface CaffeinateStatus {
  mode: CaffeinateMode;
  active: boolean;
  closed_lid: boolean;
  display: boolean;
  lid_active: boolean;
  lid_supported: boolean;
  lid_permission: boolean;
  deadline_ms: number | null;
  duration_minutes: number | null;
  working: number;
  waiting: number;
  unknown: number;
  recovery_pending: boolean;
  limited: boolean;
  error: string | null;
  revision: number;
}
export interface CaffeinateRequest {
  mode: CaffeinateMode;
  duration_minutes?: number;
  until_ms?: number;
  closed_lid?: boolean;
  display?: boolean;
}
export const useCaffeinate = create<{ status: CaffeinateStatus | null; error: string | null }>(() => ({ status: null, error: null }));
let started = false;
let revision = 0;
function receive(status: CaffeinateStatus): void {
  const current = useCaffeinate.getState().status;
  if (!current || status.revision >= current.revision) useCaffeinate.setState({ status, error: null });
}

/** One listener per WINDOW, even when both sidebar variants are mounted. */
export async function initCaffeinate(): Promise<void> {
  if (started) return;
  started = true;
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<CaffeinateStatus>("caffeinate://status", event => {
      revision += 1;
      receive(event.payload);
    });
    const before = revision;
    const status = await invoke<CaffeinateStatus>("caffeinate_status");
    if (before === revision) receive(status);
  } catch (error) {
    unlisten?.();
    started = false;
    useCaffeinate.setState({ error: String(error) });
  }
}
export async function setCaffeinate(request: CaffeinateRequest): Promise<void> {
  const status = await invoke<CaffeinateStatus>("caffeinate_set", { request });
  receive(status);
}
export async function caffeinatePermission(install: boolean): Promise<void> {
  const status = await invoke<CaffeinateStatus>("caffeinate_permission", { install });
  receive(status);
}
export async function recoverCaffeinate(): Promise<void> {
  const status = await invoke<CaffeinateStatus>("caffeinate_recover");
  receive(status);
}
const LS_HOURS = "caffeinateHours";
/** The duration last started (hours, or ∞), so the next session offers it
 *  again instead of the 2-hour default. Machine-wide, like caffeinate. */
export function lastCaffeinateHours(): string {
  try {
    const saved = localStorage.getItem(LS_HOURS)?.trim() ?? "";
    if (saved === INDEFINITE) return saved;
    const n = Number(saved);
    return saved && Number.isFinite(n) && n > 0 && n <= 24 ? saved : "2";
  } catch { return "2"; }
}
export function rememberCaffeinateHours(hours: string): void {
  try { localStorage.setItem(LS_HOURS, hours.trim()); } catch { /* private mode */ }
}
const LS_FLAGS = "caffeinateFlags";
/** The two checkboxes as last applied, offered again when nothing is running. */
export function lastCaffeinateFlags(): { closedLid: boolean; display: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_FLAGS) ?? "{}");
    return { closedLid: saved?.closedLid === true, display: saved?.display === true };
  } catch { return { closedLid: false, display: false }; }
}
export function rememberCaffeinateFlags(closedLid: boolean, display: boolean): void {
  try { localStorage.setItem(LS_FLAGS, JSON.stringify({ closedLid, display })); } catch { /* private mode */ }
}
export function localDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Compare the original duration, not a running timer's remaining time. */
export function matchesCaffeinateSettings(status: CaffeinateStatus | null, mode: CaffeinateTab, hours: string, until: string, closedLid: boolean, display: boolean): boolean {
  if (!status || status.closed_lid !== closedLid || status.display !== display) return false;
  const indefinite = mode === "duration" && hours.trim() === INDEFINITE;
  if (status.mode !== (indefinite ? "indefinite" : mode)) return false;
  if (indefinite) return true;
  if (mode === "duration") return status.duration_minutes != null && !!hours.trim()
    && Math.abs(Number(hours) * 60 - status.duration_minutes) < 0.000001;
  if (mode === "until") return status.deadline_ms != null && localDateTime(new Date(status.deadline_ms)) === until;
  return true;
}
export function requestFromDraft(mode: CaffeinateTab, hours: string, until: string, closedLid: boolean, display: boolean, now = Date.now()): CaffeinateRequest | "invalidDuration" | "invalidTime" {
  const options = { closed_lid: closedLid, display };
  if (mode === "duration") {
    if (hours.trim() === INDEFINITE) return { mode: "indefinite", ...options };
    const value = Number(hours);
    if (!hours.trim() || !Number.isFinite(value) || value <= 0 || value > 24) return "invalidDuration";
    return { mode, duration_minutes: value * 60, ...options };
  }
  if (mode === "until") {
    const date = new Date(until);
    const end = date.getTime();
    // Reject nonexistent local times rather than silently shifting a DST gap.
    if (!Number.isFinite(end) || localDateTime(date) !== until || end <= now || end - now > 86_400_000) return "invalidTime";
    return { mode, until_ms: end, ...options };
  }
  return { mode, ...options };
}
