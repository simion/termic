// Secrets + roles as the task-side surfaces read them (sidebar key, title bar
// key, footer chip, dialogs). Settings owns the records; this is a read-only
// mirror refreshed when Settings closes, plus a per-task "something
// suspicious happened" flag the footer's existing 2s poll feeds.
//
// Kept out of the app store on purpose: a write here (rare) must not wake the
// ~233-key app state's subscribers, and the app store's writes (constant)
// must not re-run these selectors more than the one `find` each costs.

import { create } from "zustand";
import * as ipc from "@/lib/ipc";
import { resolveRole, type Role, type SecretDef, type Task } from "@/lib/types";
import { configuredRole } from "@/lib/secretsUi";
import { useApp } from "./app";

const EMPTY_ROLES: Role[] = [];
const EMPTY_SECRETS: SecretDef[] = [];

interface SecretsState {
  roles: Role[];
  secrets: SecretDef[];
  /** Task ids whose broker reported a Suspicious event. Only ever holds
   *  `true`; absent = none seen. */
  suspicious: Record<string, true>;
  load: () => Promise<void>;
  /** Take lists a save just wrote, so task-side surfaces see an edit
   *  without waiting for Settings to close. Bails when nothing changed. */
  put: (next: { roles?: Role[]; secrets?: SecretDef[] }) => void;
  /** Bails on an unchanged value: it is called from a poll. */
  setSuspicious: (taskId: string, on: boolean) => void;
}

export const useSecrets = create<SecretsState>((set, get) => ({
  roles: EMPTY_ROLES,
  secrets: EMPTY_SECRETS,
  suspicious: {},
  load: async () => {
    const s = await ipc.settingsLoad().catch(() => null);
    if (!s) return;
    const roles = s.roles?.length ? s.roles : EMPTY_ROLES;
    const secrets = s.secrets?.length ? s.secrets : EMPTY_SECRETS;
    get().put({ roles, secrets });
  },
  put: (next) => {
    // keep identity when nothing changed, so every row's key does not
    // re-render on each Settings close.
    const cur = get();
    const roles = next.roles ? (next.roles.length ? next.roles : EMPTY_ROLES) : cur.roles;
    const secrets = next.secrets ? (next.secrets.length ? next.secrets : EMPTY_SECRETS) : cur.secrets;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (same(cur.roles, roles) && same(cur.secrets, secrets)) return;
    set({ roles, secrets });
  },
  setSuspicious: (taskId, on) => {
    const cur = get().suspicious;
    if (!!cur[taskId] === on) return;
    const next = { ...cur };
    if (on) next[taskId] = true; else delete next[taskId];
    set({ suspicious: next });
  },
}));

let started = false;
/** Load once, then reload whenever the Settings overlay closes (that is where
 *  roles are edited). Idempotent; called from the hooks below. */
export function ensureSecretsSync(): void {
  if (started) return;
  started = true;
  void useSecrets.getState().load();
  let wasOpen = !!useApp.getState().view.settingsOpen;
  useApp.subscribe(s => {
    const open = !!s.view.settingsOpen;
    if (wasOpen && !open) void useSecrets.getState().load();
    wasOpen = open;
  });
}

type RoleTask = Pick<Task, "id" | "project_id" | "role" | "sandbox_mode" | "sandbox_enabled" | "sandbox_block_keychain" | "docker_sandbox_enabled"> & { cli?: string };

/** The role a task runs with (`role`), and the one it would run with if its
 *  Keychain were blocked (`configured`, for the uncaged notice). Both
 *  selectors return strings or stable references, so an unrelated app-store
 *  write never re-renders the caller (performance.md bear trap 8). */
export function useTaskRole(task: RoleTask | null | undefined): { role: Role | null; configured: Role | null } {
  ensureSecretsSync();
  const roles = useSecrets(s => s.roles);
  // with no roles (most installs) every row skips the two finds, which would
  // otherwise run on each app-store write for nothing.
  const live = !!task && roles.length > 0;
  const pDef = useApp(s => (live ? s.projects.find(p => p.id === task.project_id)?.default_role : undefined));
  const aDef = useApp(s => (live ? s.agents.find(a => a.id === task.cli)?.default_role : undefined));
  if (!live) return { role: null, configured: null };
  const project = { default_role: pDef };
  const agent = { default_role: aDef };
  return {
    role: resolveRole(task, project, agent, roles),
    configured: configuredRole(task, project, agent, roles),
  };
}
