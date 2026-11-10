// The status bar's one cage chip: `[cage] <mode> · [role] <role> · <tail>`.
// Pure, so every state on the "one cage chip" board is a table row in
// cageChip.test.ts instead of a screenshot.

import { effectiveSandboxMode, keychainBlocked, type BrokerCounts, type Role, type SandboxMode } from "./types";

export type CageMode = SandboxMode | "docker";

export type CageTail =
  | { kind: "suspicious"; count: number }
  | { kind: "paused" }
  | { kind: "blocked"; count: number }
  | { kind: "accesses"; count: number };

export interface CageChipState {
  mode: CageMode;
  /** the role part, absent when the task has none. `applied` false = set but
   *  cannot apply (no Keychain block, Monitor, Docker): drawn struck through. */
  role: { role: Role; applied: boolean } | null;
  /** the saved role, when a live spawn runs another one. */
  savedRole: Role | null;
  tail: CageTail | null;
  /** a change saved while the agent runs: "restart to apply". */
  pending: boolean;
  /** what the pending restart is for, so the popover can say which. */
  pendingWhy: "switched" | "stale" | "keychain" | null;
}

type ChipTask = Parameters<typeof keychainBlocked>[0];

/** `role` is the applied role (`resolveRole`), `configured` the one the task
 *  would run with if caged (`configuredRole`). `denyTotal` is the cage's own
 *  count: denies, or accesses in Monitor. `kcOpen` is how many live agents
 *  can still reach the Keychain (null until a poll answers). `shells` are the
 *  task's role shells' counts: their suspicious and blocked rows add to the
 *  tail whatever the task's own mode or role, since a shell is never caged. */
export function cageChipState(
  task: ChipTask,
  counts: BrokerCounts | null,
  denyTotal: number,
  role: Role | null,
  configured: Role | null,
  opts: { roles: Role[]; kcOpen: number | null; shells?: (BrokerCounts | null)[] },
): CageChipState {
  const mode: CageMode = task?.docker_sandbox_enabled ? "docker" : effectiveSandboxMode(task ?? {});
  let shown: CageChipState["role"] = null;
  let savedRole: Role | null = null;
  let pendingWhy: CageChipState["pendingWhy"] = null;
  if (role) {
    // what the broker ENFORCES, which is not the saved pick after a switch
    // (a role applies at spawn). The saved resolution stands in while nothing
    // is live.
    const live = counts?.roles ?? [];
    const running = (live.length ? opts.roles.find(r => r.id === live[0]) : undefined) ?? role;
    shown = { role: running, applied: true };
    if (live.length > 0 && !live.includes(role.id)) { savedRole = role; pendingWhy = "switched"; }
    else if (counts?.stale) pendingWhy = "stale";
  } else if (configured) {
    shown = { role: configured, applied: false };
  }
  if (!pendingWhy && keychainBlocked(task) && (opts.kcOpen ?? 0) > 0) pendingWhy = "keychain";

  let tail: CageTail | null = null;
  const brokered = role ? counts : null;
  const shells = opts.shells ?? [];
  const shellSum = (f: (c: BrokerCounts) => number) => shells.reduce((n, c) => n + (c ? f(c) : 0), 0);
  const suspicious = (brokered?.suspicious ?? 0) + shellSum(c => c.suspicious);
  const shellBlocked = shellSum(c => c.blocked);
  if (suspicious > 0) tail = { kind: "suspicious", count: suspicious };
  else if (brokered?.paused) tail = { kind: "paused" };
  else if (mode === "monitor" && denyTotal > 0) tail = { kind: "accesses", count: denyTotal };
  else {
    const cage = mode === "off" || mode === "docker" || mode === "monitor" ? 0 : denyTotal;
    const n = cage + (brokered?.blocked ?? 0) + shellBlocked;
    tail = n > 0 ? { kind: "blocked", count: n } : null;
  }
  return { mode, role: shown, savedRole, tail, pending: pendingWhy !== null, pendingWhy };
}
