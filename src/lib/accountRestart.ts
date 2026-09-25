// Restarting a task's agent onto a different account (GH #278).
//
// A switch only ever writes a setting: a running process cannot have its
// environment changed underneath it, so the new login lands on the NEXT spawn.
// That is honest but not much use mid-session, which is why this exists.
//
// It is safe to restart only because an account's store SHARES the agent's
// transcripts (`agent_dirs::shared_config_entries`). Without that the account
// dir is a blank agent and a restart would drop the conversation, which is the
// exact thing the switcher is supposed to protect. If that sharing is ever
// removed, this has to go with it.
//
// The restart itself is the pattern `ResumeOverrideDialog` established: flag
// the task so `TerminalPane`'s exit handler auto-respawns instead of showing
// the "exited" overlay, then SIGKILL the live pty. The respawn resumes the
// session on its own.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { ptyKill } from "@/lib/ipc";
import { sendMessageToPty } from "@/lib/agentSend";
import type { TerminalTab } from "@/lib/types";

/** How long to let the agent boot before typing into it. Same reasoning and
 *  the same generosity as `runPrompt`: agents are slow to become input-ready,
 *  and a prompt that lands on a splash screen is lost. */
const SETTLE_MS = 5000;
/** Give up waiting for the fresh pty. */
const RESPAWN_DEADLINE_MS = 12000;

/**
 * Open a tab in this task where the agent runs AS `account`, so its own login
 * can be run there (GH #278).
 *
 * The dead end this removes: an account starts out signed out, by design (termic
 * makes an empty directory and never handles a credential), and the only way to
 * fill it is the agent's own login. But the agent in front of the user is still
 * running on the OLD account, so typing `/login` there signs the old account in
 * again. We told people to "run its login" and gave them nowhere to do it.
 *
 * Nothing here is special-cased at the spawn: `pty_spawn` resolves the account
 * from the TASK, and `pick` has already written the new one, so an ordinary
 * agent tab in this task comes up on the new account with an empty store and a
 * login prompt. The sandbox follows the same resolution
 * (`task_login_store`), so a caged agent can write the credential it is about
 * to receive. All that was missing was the button.
 *
 * A NEW TAB rather than a restart, because the conversation in the running tab
 * is the thing the switcher exists to protect. Sign in beside it, then come
 * back and switch.
 */
export function openSignInTab(taskId: string, agentId: string, account: string): boolean {
  const app = useApp.getState();
  if (!app.tabs[taskId]) return false;
  app.addTab(taskId, {
    id: crypto.randomUUID(),
    type: "terminal",
    // Named for the job, not the agent: this tab is disposable, and a second
    // tab called "claude" beside the real one is the confusing version.
    title: i18n.t("backend:accountSwitching.signInTab", { account }),
    cli: agentId,
  });
  return true;
}

/** The task's primary agent tab, which is the one an account switch is about. */
export function primaryAgentTab(taskId: string, agentId: string): TerminalTab | undefined {
  const tabs = (useApp.getState().tabs[taskId] ?? []) as TerminalTab[];
  return tabs.find(t => t.type === "terminal" && t.cli === agentId && !!t.ptyId);
}

/**
 * Restart this task's agent so it picks up the account that was just chosen.
 *
 * `message` is sent once the fresh agent is up. The automatic switch uses it to
 * say "continue": the restart resumes the conversation, but the agent is then
 * sitting idle at a prompt, and the turn that hit the limit still has to be
 * asked for again. Nobody is at the keyboard when the automatic switch fires,
 * so nobody would type it.
 *
 * Returns false when there was nothing running to restart.
 */
export function restartAgentForAccount(
  taskId: string,
  agentId: string,
  opts: { message?: string } = {},
): boolean {
  const tab = primaryAgentTab(taskId, agentId);
  if (!tab?.ptyId) return false;
  const oldPty = tab.ptyId;

  useUI.getState().markPendingPtyRestart(taskId);
  // The overlay is ONLY for the case where a message follows, and it is
  // labelled with that message, because its copy reads "Sending X when it is
  // ready". Shown for a plain restart it stated something that was never going
  // to happen, and nothing cleared it: the clearing lives on the send path,
  // which a restart with no message never reaches. The tab sat under a
  // spinner for the rest of the session.
  if (opts.message) {
    useApp.getState().patchTab(taskId, tab.id, { promptPendingTitle: opts.message });
  }
  void ptyKill(oldPty).catch(() => {});

  if (!opts.message) return true;

  // Wait for a DIFFERENT pty id, not merely for one to exist: the old id is
  // still on the tab until the respawn patches it, so "has a ptyId" is true
  // the whole time and would send the message into the process we just killed.
  const deadline = Date.now() + RESPAWN_DEADLINE_MS;
  const tick = () => {
    const t = (useApp.getState().tabs[taskId] ?? []).find(t => t.id === tab.id) as TerminalTab | undefined;
    if (t?.ptyId && t.ptyId !== oldPty) {
      window.setTimeout(() => {
        // Re-read: the tab may have been closed, or restarted again, during
        // the settle window. Never write into a stale pty.
        const live = (useApp.getState().tabs[taskId] ?? []).find(x => x.id === tab.id) as TerminalTab | undefined;
        if (!live?.ptyId) return;
        sendMessageToPty(live.ptyId, opts.message!);
        useApp.getState().patchTab(taskId, tab.id, {
          lastInputAt: Date.now(),
          promptPendingTitle: null,
        });
      }, SETTLE_MS);
      return;
    }
    if (Date.now() < deadline) { window.setTimeout(tick, 150); return; }
    // Never came back. Drop the overlay rather than leaving the tab covered.
    useApp.getState().patchTab(taskId, tab.id, { promptPendingTitle: null });
  };
  window.setTimeout(tick, 300);
  return true;
}
