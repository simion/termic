// A shell running a Secrets role (docs/sandbox.md "Shells"). A shell gets
// nothing until the user picks a role for that shell: no default ever
// applies, and a plain shell's spawn args stay exactly what they were.

import { useEffect, useState } from "react";
import * as ipc from "./ipc";
import { sandboxAvailable } from "./ipc";
import { i18n } from "@/lib/i18n";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { ensureSecretsSync, useSecrets } from "@/store/secrets";
import type { Role, SecretDef } from "./types";

/** The `pty_spawn` field for a shell's role. A plain shell gets `{}`, so the
 *  key is absent and Rust spawns it as it always has. */
export function shellSecretsArg(taskId: string | undefined, tabId: string | undefined, role: string | undefined) {
  return taskId && tabId && role ? { shell_secrets: { task_id: taskId, tab_id: tabId, role } } : {};
}

const NO_ROLES: Role[] = [];
// one IPC per app session: the answer never changes while it runs.
let avail: Promise<boolean> | null = null;
let availNow: boolean | null = null;

/** The roles a shell can start with: none off macOS (no broker) or when no
 *  role exists, which hides every shell-role entry point. */
export function useShellRoles(): Role[] {
  ensureSecretsSync();
  const roles = useSecrets(s => s.roles);
  const [ok, setOk] = useState(availNow === true);
  useEffect(() => {
    if (availNow !== null) return;
    let alive = true;
    (avail ??= sandboxAvailable().catch(() => false)).then(v => { availNow = v; if (alive) setOk(v); });
    return () => { alive = false; };
  }, []);
  return ok ? roles : NO_ROLES;
}

/** The secrets a role binds, in the role's order. */
export function roleSecrets(role: Role, secrets: SecretDef[]): SecretDef[] {
  return role.secrets.map(id => secrets.find(s => s.id === id)).filter((s): s is SecretDef => !!s);
}

/** Whether a secret points at gh's own login (a `gh:<host>` Keychain item):
 *  any shell can print that one with `security`, which the launcher says. */
export const isGhLogin = (s: SecretDef) => s.service.startsWith("gh:");

// pty id per shell tab, so the restart confirm can ask what still runs in a
// bottom-split shell (its pty id lives in AuxTerminal, not the store). A
// plain map: never rendered, so it must not be store state.
const shellPtys = new Map<string, string>();
export function setShellPty(tabId: string | undefined, ptyId: string | null) {
  if (!tabId) return;
  if (ptyId) shellPtys.set(tabId, ptyId); else shellPtys.delete(tabId);
}

/** Switch a shell's role: the broker binding is fixed at spawn, so this ends
 *  the shell and the tab respawns with `role` (undefined = a plain shell).
 *  Confirms first when something still runs under it. */
export async function restartShellWithRole(taskId: string, tabId: string, role: Role | null) {
  const ptyId = shellPtys.get(tabId);
  const procs = ptyId ? await ipc.ptyChildren(ptyId).catch(() => [] as string[]) : [];
  if (procs.length) {
    const ok = await useUI.getState().askConfirm({
      title: role ? i18n.t("secrets:shell.confirmTitle", { role: role.name }) : i18n.t("secrets:shell.confirmTitleNone"),
      message: i18n.t("secrets:shell.confirmBody", { procs: [...new Set(procs)].join(", ") }),
      confirmLabel: i18n.t("secrets:shell.confirm"),
      destructive: true,
    });
    if (!ok) return;
  }
  useApp.getState().setShellSecretsRole(taskId, tabId, role?.id);
}

/** A shell tab a role can apply to: a plain login shell. Command, run and
 *  setup tabs do not take a role (not built yet; docs/sandbox.md "Shells"). */
export function shellRoleTarget(taskId: string, tab: { type: string; cli?: string; command?: string; runTab?: unknown; secretsRole?: string }) {
  return tab.type === "terminal" && tab.cli === "shell" && !tab.command && !tab.runTab
    ? { taskId, role: tab.secretsRole }
    : undefined;
}

/** A shell of a task running a Secrets role: main, split-pane or bottom tab. */
export type RoleShell = { tabId: string; role: string; title: string; key: string };

type ShellTabs = { tabs: Record<string, { id: string; type?: string; cli?: string; title?: string; secretsRole?: string }[]>;
  bottomTabs: Record<string, { id: string; title?: string; secretsRole?: string }[]> };

/** Every shell of `taskId` running a role, as ONE string so a component can
 *  select it without a fresh array on every store write (bear trap 8);
 *  `parseRoleShells` turns it back into rows. */
export function roleShellsKey(s: ShellTabs, taskId: string): string {
  const main = (s.tabs[taskId] ?? []).filter(t => t.type === "terminal" && t.cli === "shell" && t.secretsRole);
  const bottom = (s.bottomTabs[taskId] ?? []).filter(t => t.secretsRole);
  return [...main, ...bottom].map(t => [t.id, t.secretsRole, (t.title ?? "").replace(/[\t\n]/g, " ")].join("\t")).join("\n");
}

export function parseRoleShells(taskId: string, key: string): RoleShell[] {
  if (!key) return [];
  return key.split("\n").map(line => {
    const [tabId, role, title] = line.split("\t");
    return { tabId, role, title, key: ipc.shellBrokerKey(taskId, tabId) };
  });
}
