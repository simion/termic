// The footer's one source of truth for "which account is this task on"
// (GH #278).
//
// A hook rather than a fetch inside each chip, because the account pill and
// the usage chip are two views of ONE fact and they were wrong about it in two
// different ways when each fetched for itself:
//
//   - the pill's opt-in checkbox and the usage popover's opt-in checkbox are
//     the same setting, so toggling one left the other showing the old value
//     until something happened to remount it. Caught by an e2e case that
//     toggled it in one place and read it in the other.
//   - the usage chip keys its reading by account, so it needs exactly the
//     account the pill is naming, and a second fetch is a second chance to
//     disagree.
//
// One fetch, one refresh, both chips.

import { useCallback, useEffect, useRef, useState } from "react";

/** Back-off between re-reads after a failed accounts read. */
export const RETRY_MS = [1_000, 3_000, 10_000];
import * as ipc from "@/lib/ipc";
import type { AgentAccountsView } from "@/lib/types";

export interface AgentAccounts {
  /** The agent's accounts, or null before the first answer arrives. */
  view: AgentAccountsView | null;
  /** This task's override, `null` when it follows the agent's default. */
  current: string | null;
  /** The account whose USAGE this task's numbers belong to.
   *
   *  The RUNNING process's login, because that is what the numbers were spent
   *  on. The configured account only when nothing has spawned yet: there is no
   *  reading to misattribute then, and keying a not-yet-started task to the
   *  unnamed login would show it the wrong account's percentage for as long as
   *  it took to boot.
   *
   *  `null` is a REAL answer here, not an absence: it is the agent's ordinary
   *  login, which is what every process spawned before the user named a
   *  credential set is running as. Collapsing it into "nothing has spawned"
   *  broke exactly that case: naming the first account re-keyed a running
   *  task's chip to the new name, and its usage vanished mid-session. */
  account: string | null;
  refresh: () => void;
}

export function useAgentAccounts(
  taskId: string,
  agentId: string,
  docker: boolean,
  /** What the running process was spawned with. `null` means "the agent's
   *  ordinary login", `undefined` means nothing has spawned in this task yet.
   *  The two are NOT the same and must not be merged with `??`. */
  liveAccount: string | null | undefined,
  visible: boolean,
): AgentAccounts {
  const [view, setView] = useState<AgentAccountsView | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  // A failed read keeps what was last known and tries again: it used to set
  // the view to null, which hides the usage chip, and nothing re-read it
  // until some unrelated accounts event came along. One transient failure
  // (a login file mid-write, a scanner holding it on Windows) then cost the
  // footer its chip for the rest of the session.
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (!visible) return;
    if (retry.current) { clearTimeout(retry.current); retry.current = null; }
    const read = (attempt: number) => {
      void ipc.agentAccounts(agentId, docker).then(setView).catch(() => {
        if (attempt < RETRY_MS.length) retry.current = setTimeout(() => read(attempt + 1), RETRY_MS[attempt]);
      });
    };
    read(0);
    void ipc.taskAccount(taskId, agentId).then(setCurrent).catch(() => setCurrent(null));
  }, [agentId, docker, taskId, visible]);
  useEffect(() => {
    refresh();
    return () => { if (retry.current) clearTimeout(retry.current); };
  }, [refresh]);

  // Any window may add, remove or re-default an account, and the STORES are
  // global, so this listens rather than only fetching on its own actions: a
  // set added from Settings did not reach the footer until something happened
  // to remount it.
  useEffect(() => {
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("termic://agent-accounts-changed", () => refresh()).then(f => { un = f; }));
    return () => un?.();
  }, [refresh]);

  const configured = current ?? view?.accounts.find(a => a.isDefault)?.name ?? null;
  return {
    view,
    current,
    // `=== undefined`, never `??`: see `account` above.
    account: liveAccount === undefined ? configured : liveAccount,
    refresh,
  };
}
