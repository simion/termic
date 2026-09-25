// Everything the footer's account control DECIDES (GH #278), separated from
// what it draws.
//
// A hook rather than component state because the automatic switch lives here,
// and it has to keep working while nothing is open: it fires when an account
// passes its limit, which is exactly a moment nobody is looking at a popover.
// Held in the always-mounted footer chip, it runs whether or not the panel is
// on screen.

import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import * as ipc from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { usePrefs } from "@/store/prefs";
import { useAgentUsage, usageKey, type UsageEntry } from "@/store/agentUsage";
import { pillLabel, pillText } from "@/lib/accountPill";
import { switchCandidate, switchedNotice, switchedAndResumedNotice } from "@/lib/autoSwitch";
import { restartAgentForAccount, primaryAgentTab, openSignInTab } from "@/lib/accountRestart";
import type { AgentAccounts } from "@/hooks/useAgentAccounts";

export interface AccountSwitching {
  /** The account to move to, or null. Already filtered for "not the one that
   *  is staged", so the panel can render it as an offer without re-checking. */
  candidate: string | null;
  /** Is there an offer to show? False while the automatic switch is on: it
   *  acts rather than asking. */
  offering: boolean;
  /** Is there anything the user should look at? Drives the chip's colour. */
  alert: boolean;
  auto: boolean;
  notice: string | null;
  clearNotice: () => void;
  /** The configured account's name, which is what the tick marks. */
  label: string | null;
  /** What to print: the RUNNING account, and the staged one for the tooltip. */
  shown: { now: string; next: string | null };
  pick: (name: string) => Promise<void>;
  toggleAuto: (on: boolean) => Promise<void>;
}

export function useAccountSwitching(
  taskId: string,
  agentId: string,
  accounts: AgentAccounts,
  visible: boolean,
): AccountSwitching {
  const { view, current, account, refresh } = accounts;
  const [notice, setNotice] = useState<string | null>(null);

  const label = pillLabel(view, current);
  // The reading that decides: the RUNNING account's, not the configured one.
  // One entry, selected by key, so this is Object.is-stable against every
  // report that is not its own.
  const usage = useAgentUsage(s => s.byAgent[usageKey(agentId, account)]);
  // Every account's last reading, so the rotation can skip one it already
  // knows is spent instead of walking the user onto a second wall.
  //
  // `useShallow` is load-bearing, not tidiness: this selector BUILDS an object,
  // so without it every status-line report from any agent would re-render
  // every mounted footer in the window, once per turn per task. Panes stay
  // mounted, so that is all of them (docs/performance.md bear trap 8, and
  // `selectorFanout.test.ts` pins the count).
  const names = view?.accounts.map(a => a.name) ?? [];
  const seen = useAgentUsage(useShallow(s => {
    const out: Record<string, UsageEntry | undefined> = {};
    for (const n of names) out[n] = s.byAgent[usageKey(agentId, n)];
    return out;
  }));
  const raw = switchCandidate({ view, current: account, usage, seen, now: Date.now() });
  // Nothing left to offer once the switch is already staged. The running
  // process still reports the spent account (it keeps its login until it
  // restarts), so without this the panel would keep offering the account the
  // user just accepted, which reads as the click having failed.
  const candidate = raw && raw !== label ? raw : null;

  const pick = useCallback(async (name: string) => {
    try {
      await ipc.taskSetAccount(taskId, agentId, name);
      refresh();
      // A switch only writes a setting, so the agent in front of the user is
      // still on the OLD account until it restarts. Offer the restart rather
      // than doing it: this is a running conversation, and nobody should have
      // one killed by a menu click they thought only changed a preference.
      //
      // Only when something is actually running. With no live agent the
      // setting is all there is to change, and a dialog would be asking about
      // nothing.
      if (!primaryAgentTab(taskId, agentId)) return;
      // Not signed in yet: restarting would drop the agent on a login screen,
      // and the offer's promise ("resumes this conversation") would be false.
      //
      // So OPEN THE PLACE THE LOGIN CAN HAPPEN rather than describing it. The
      // old copy said "start this agent on it and run its login", which was
      // true and useless: the agent in front of the user was still on the old
      // account, so every `/login` available to them signed the OLD account in
      // again. The tab this opens is on the new account (the write above is
      // what decides that), so its login lands in the new store.
      if (!view?.accounts.find(a => a.name === name)?.signedIn) {
        const opened = openSignInTab(taskId, agentId, name);
        setNotice(opened
          ? `${name} has no login yet. Opened a tab on it: run this agent's own login there, then pick ${name} again to move this task over. The conversation beside it is untouched.`
          : `${name} has no login yet. Start this agent on it and run its login, then the switch takes hold.`);
        return;
      }
      // Asked once per user, not once per switch. Someone who switches often
      // gets the same sentence every time about an action that is recoverable
      // (the conversation resumes, and switching back is one more click), so
      // the dialog turns itself off. Settings, Tasks re-exposes it, because a
      // dialog you dismissed once is otherwise unreachable.
      if (!usePrefs.getState().confirmBeforeAccountRestart) {
        restartAgentForAccount(taskId, agentId);
        return;
      }
      const res = await useUI.getState().askConfirm({
        key: `account-restart-${taskId}`,
        title: i18n.t("backend:accountSwitching.restartTitle", { agent: agentId, name }),
        message: i18n.t("backend:accountSwitching.restartMessage", { name }),
        confirmLabel: i18n.t("backend:accountSwitching.restartNow"),
        cancelLabel: i18n.t("backend:accountSwitching.later"),
        dontAskAgain: true,
      });
      // Only remember the opt-out when they went THROUGH with it. The
      // checkbox reports its state at dismissal, so ticking it and then
      // pressing Later would otherwise silently arm every future switch to
      // restart without asking.
      if (res.confirmed && res.dontAskAgain) {
        usePrefs.getState().setConfirmBeforeAccountRestart(false);
      }
      if (res.confirmed) restartAgentForAccount(taskId, agentId);
    } catch { /* the task may have been archived */ }
  }, [agentId, refresh, taskId, view]);

  // The automatic half.
  //
  // Fires once per candidate. `current` moves to the new account as soon as
  // the write lands, so the next evaluation looks at an account with no
  // reading and returns null on its own; the ref is belt and braces against a
  // re-render arriving before the refresh does.
  const autoDoneRef = useRef<string | null>(null);
  const auto = !!view?.autoSwitch;
  useEffect(() => {
    if (!visible || !auto || !candidate) return;
    const mark = `${account ?? ""}->${candidate}`;
    if (autoDoneRef.current === mark) return;
    autoDoneRef.current = mark;
    void (async () => {
      try {
        await ipc.taskSetAccount(taskId, agentId, candidate);
        refresh();
        // NO confirm here, by design: the point of the automatic switch is
        // that it works while nobody is watching, and a dialog waiting for a
        // click is the one thing that cannot.
        //
        // "continue" because the restart resumes the conversation but leaves
        // the agent idle at a prompt, and the turn that hit the limit still
        // has to be asked for again. Nobody is at the keyboard to type it.
        const restarted = restartAgentForAccount(taskId, agentId, { message: "continue" });
        setNotice(restarted ? switchedAndResumedNotice(candidate) : switchedNotice(candidate));
      } catch { /* archived, or the account went away under us */ }
    })();
  }, [account, agentId, auto, candidate, refresh, taskId, visible]);

  const toggleAuto = useCallback(async (on: boolean) => {
    try {
      await ipc.accountSetAutoSwitch(agentId, on);
      refresh();
    } catch { /* an agent with no usage feed refuses, and says why */ }
  }, [agentId, refresh]);

  // Something to say only when the user could act on it: an offer while the
  // automatic switch is off, or a report that it already acted.
  const offering = !!candidate && !auto;
  return {
    candidate,
    offering,
    alert: offering || !!notice,
    auto,
    notice,
    clearNotice: useCallback(() => setNotice(null), []),
    label,
    shown: pillText(view, current, account),
    pick,
    toggleAuto,
  };
}
