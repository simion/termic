// Tab-close with an unsaved-changes guard.
//
// EVERY close path — the main strip's "×", a pane pill's "×", and ⌘W in
// either pane — routes through here so a dirty editor buffer or a live agent
// session can never be discarded without the user explicitly confirming.
// termic never auto-saves, so closing a dirty `edit` tab is genuinely
// destructive.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { i18n } from "@/lib/i18n";
import type { ScratchTab, Tab } from "@/lib/types";
import { agentDisplayName, isTerminalCli } from "@/lib/agents";
import { discardScratchPad } from "@/lib/scratchTabs";
import { isScheduled } from "@/lib/scheduledQueue";

/** Scheduled queue messages (GH #300) this close would delete. They live on
 *  the tab's durable record, so a close that keeps the record (the MAIN strip
 *  tab, which stays durable when closed) loses nothing; every other agent
 *  tab close drops the record and them with it. */
function scheduledLostOnClose(tab: Tab | undefined, paneTab: boolean): number {
  if (tab?.type !== "terminal") return 0;
  if (!paneTab && tab.is_default) return 0;
  return (tab.queue ?? []).filter(isScheduled).length;
}

const scheduledPhrase = (n: number) =>
  i18n.t(n === 1 ? "backend:closeTab.scheduledPhraseOne" : "backend:closeTab.scheduledPhraseOther", { count: n });

/** The scratchpad close prompt (GH #244), resolving true when the pad's tab
 *  may close. A pad has never been written anywhere the user chose, so
 *  closing it is destructive in a way quitting is not: a relaunch restores
 *  every pad untouched, an explicit close asks. Three outcomes, so it gets its
 *  own prompt rather than a fourth overload on askConfirm.
 *
 *  Used by the single-tab path AND by the bulk paths, one prompt per pad: a
 *  pad closed inside "Close others" is exactly as unsaved as one closed by its
 *  own ×, and folding several into one confirm would mean one click deciding
 *  the fate of several notes. */
async function confirmScratchClose(taskId: string, tab: ScratchTab): Promise<boolean> {
  const choice = await useUI.getState().askScratchClose(tab.liveTitle || tab.title);
  if (choice === "cancel") return false;
  if (choice === "discard") {
    await discardScratchPad(taskId, tab.scratchId);
    return true;
  }
  // "Save…": the close only happens if the promote actually goes through.
  // Backing out of the picker must leave the pad AND the tab alone, not
  // silently fall through to discarding it.
  return await useUI.getState().askScratchSave(taskId, tab.id);
}

/** Shared confirm gate: resolves true when closing `tab` is safe (nothing to
 *  lose, or the user confirmed). `paneTab` tweaks the agent copy — pane tabs
 *  are never durable, so closing an agent there always forgets the session. */
/** Does the task own a main-strip tab OTHER than `tabId`? That is the whole
 *  difference between a close that puts the task to sleep (and so auto-resumes
 *  on the next wake) and one that does not. */
function otherMainTabsOpen(taskId: string, tabId: string): boolean {
  return (useApp.getState().tabs[taskId] ?? [])
    .some(t => t.id !== tabId && !(t as { paneId?: string }).paneId);
}

async function confirmTabClose(taskId: string, tab: Tab | undefined, paneTab: boolean): Promise<boolean> {
  if (tab?.type === "scratch") return confirmScratchClose(taskId, tab);
  if (tab?.type === "edit" && tab.dirty) {
    const name = tab.path.split("/").pop() || tab.path;
    // No checkbox in the request → askConfirm resolves a plain boolean; the
    // === true keeps TS happy across its overloads.
    const ok = await useUI.getState().askConfirm({
      title: i18n.t("backend:closeTab.unsavedTitle"),
      message: i18n.t("backend:closeTab.unsavedMessage", { name }),
      confirmLabel: i18n.t("backend:closeTab.unsavedConfirm"),
      destructive: true,
    });
    return ok === true;
  }
  // Scheduled messages outrank the close-confirm opt-out: that opt-out was
  // about stopping a process the Resume list can bring back, and the Resume
  // list does not bring these back.
  const lost = scheduledLostOnClose(tab, paneTab);
  if (lost) {
    const ok = await useUI.getState().askConfirm({
      title: i18n.t("backend:closeTab.scheduledTitle"),
      message: i18n.t(lost === 1 ? "backend:closeTab.scheduledMessageOne" : "backend:closeTab.scheduledMessageOther", { phrase: scheduledPhrase(lost) }),
      confirmLabel: i18n.t("backend:closeTab.closeTabConfirm"),
      destructive: true,
    });
    return ok === true;
  }
  // Agent-tab close semantics (issue #23): the MAIN agent tab stays durable
  // — closing it just ends the process and the session auto-resumes when the
  // task wakes, so it's not destructive. A SECONDARY ("+") agent tab or
  // a split-pane agent tab is FORGOTTEN on close — X is the way to get rid
  // of it for good — so that close is destructive and the copy says so.
  // Plain shells (cli === "shell") close instantly; there's nothing to lose.
  if (tab?.type === "terminal" && tab.cli !== "shell") {
    // Custom-command and registry-terminal tabs have no agent session to
    // end or resume — the confirm is only about killing the live process.
    const termLike = isTerminalCli(tab.cli, useApp.getState().agents);
    // Process already exited (ptyId cleared on exit) → nothing to stop, and
    // terminal-like tabs have no session to lose either. Close silently
    // instead of a fake "Stops the running process" confirm.
    if (termLike && !tab.ptyId) return true;
    // Fast path: the user opted out by unticking "Show this every time" in
    // the dialog below. The "+" menu's Resume section (backed by closedTabs)
    // makes undoing a close one click away, so a blocking modal on every
    // close is no longer the only safety net. requestCloseTab /
    // requestClosePaneTab toast a Resume shortcut once the close lands.
    if (!usePrefs.getState().confirmBeforeCloseAgentTab) return true;
    const label = tab.cli === "custom"
      ? (tab.title || i18n.t("backend:closeTab.thisCommand"))
      : agentDisplayName(tab.cli, useApp.getState().agents);
    const isMain = !paneTab && !!tab.is_default;
    // "The session resumes when you reopen the task" is only true when this
    // close EMPTIES the task: waking is what restores a durable tab, and a
    // task with another main tab still open never sleeps, so nothing wakes it.
    // Closing the main agent next to a shell puts it in the Resume list
    // instead (see ClosedTabEntry), and the copy has to say which.
    const sleeps = isMain && !otherMainTabsOpen(taskId, tab.id);
    // Only a PANE tab close is genuinely one-way: pane tabs are never
    // snapshotted into closedTabs (see app.ts's closeTab), so there is no
    // Resume entry to click afterwards. The main tab auto-resumes and a
    // secondary strip tab is one click away in the "+" menu, so neither
    // gets the red button or copy that implies loss (issue #102).
    const gone = !isMain && !termLike && paneTab;
    const ok = await useUI.getState().askConfirm({
      title: i18n.t("backend:closeTab.agentCloseTitle", { label }),
      message: termLike
        ? i18n.t("backend:closeTab.stopsProcess")
        : sleeps
          ? i18n.t("backend:closeTab.stopsProcessResumes")
          : gone
            ? i18n.t("backend:closeTab.endsSessionPane")
            : i18n.t("backend:closeTab.endsSessionResume"),
      confirmLabel: i18n.t("backend:closeTab.closeTabConfirm"),
      destructive: gone,
      dontAskAgain: true,
    });
    // Only persist the opt-out when the user actually confirmed the close —
    // unticking the box then backing out (Escape / Cancel / click-outside)
    // still resolves with dontAskAgain=true (ConfirmDialog reports whatever
    // the checkbox state was at dismissal), so gating on confirmed too
    // stops a cancelled close from silently disabling future confirmations.
    if (ok.confirmed && ok.dontAskAgain) usePrefs.getState().setConfirmBeforeCloseAgentTab(false);
    return ok.confirmed;
  }
  return true;
}

/** One confirm for a whole set (the context menu's "Close others" / "Close to
 *  the right"). A per-tab confirm would stack five modals on one gesture, so
 *  this dialog counts the losses and asks once. */
async function confirmBulkClose(tabs: Tab[]): Promise<boolean> {
  const agents = useApp.getState().agents;
  const dirty = tabs.filter(t => t.type === "edit" && t.dirty);
  // Same rule as confirmTabClose: an already-exited terminal-like tab has
  // neither a process to stop nor a session to lose.
  const live = tabs.filter(t =>
    t.type === "terminal" && t.cli !== "shell"
    && !(isTerminalCli(t.cli, agents) && !t.ptyId));
  // Pads are absent from this dialog on purpose: each one gets its OWN
  // three-way prompt afterwards (see closeSetWithScratchPrompts), because
  // "discard" on a pad is a per-note decision and there is no file to go back
  // to. A set of nothing BUT pads therefore skips this confirm entirely.
  // Bulk closes are main-strip or pane sets; either way the per-tab rule holds.
  const scheduled = tabs.reduce((n, t) => n + scheduledLostOnClose(t, !!(t as { paneId?: string }).paneId), 0);
  if (!dirty.length && !scheduled && (!live.length || !usePrefs.getState().confirmBeforeCloseAgentTab)) return true;
  const parts: string[] = [];
  if (dirty.length) {
    parts.push(i18n.t(dirty.length === 1 ? "backend:closeTab.bulkDirtyOne" : "backend:closeTab.bulkDirtyOther", { count: dirty.length }));
  }
  if (live.length) {
    parts.push(i18n.t(live.length === 1 ? "backend:closeTab.bulkLiveOne" : "backend:closeTab.bulkLiveOther", { count: live.length }));
  }
  if (scheduled) {
    parts.push(i18n.t("backend:closeTab.bulkScheduled", { phrase: scheduledPhrase(scheduled) }));
  }
  const ok = await useUI.getState().askConfirm({
    title: i18n.t(tabs.length === 1 ? "backend:closeTab.bulkTitleOne" : "backend:closeTab.bulkTitleOther", { count: tabs.length }),
    message: parts.join(" "),
    confirmLabel: i18n.t("backend:closeTab.closeTabsConfirm"),
    destructive: true,
  });
  return ok === true;
}

/** After a fast-path close (confirm skipped, see above), tell the user
 *  where the tab went. Secondary tabs snapshot into `closedTabs` on close
 *  (see app.ts's closeTab) so the toast's action can reopen the exact one
 *  that was just closed; the main tab already auto-resumes on its own, so
 *  it gets an explanatory toast with no action. No-op for shells (closed
 *  silently, nothing to report) and edit tabs (own confirm path, unrelated
 *  to this pref). */
function toastClosedTab(taskId: string, tab: Tab, paneTab: boolean) {
  if (tab.type !== "terminal" || tab.cli === "shell") return;
  const label = tab.cli === "custom"
    ? (tab.title || i18n.t("backend:closeTab.thisCommand"))
    : agentDisplayName(tab.cli, useApp.getState().agents);
  // Pane tabs are never snapshotted into closedTabs (see app.ts's closeTab) —
  // there's nothing to point the user back to, so just confirm the close.
  if (paneTab) {
    useUI.getState().pushToast(i18n.t("backend:closeTab.closedToast", { label }), "info");
    return;
  }
  // Same split as the confirm dialog's copy: only a close that emptied the
  // task auto-resumes. `toastClosedTab` runs AFTER the close, so an empty main
  // strip now IS "it slept". Anything else went into the Resume list, main tab
  // included, and the toast has to point there or it sends the user to a wake
  // that will never happen.
  const slept = !(useApp.getState().tabs[taskId] ?? [])
    .some(t => !(t as { paneId?: string }).paneId);
  if (slept) {
    useUI.getState().pushToast(i18n.t("backend:closeTab.closedSleptToast", { label }), "info");
    return;
  }
  // Bind THIS close's entry now (toastClosedTab runs synchronously right
  // after closeTab, so closedTabs[taskId][0] is guaranteed to be it) rather
  // than re-deriving "the latest entry" at click time — otherwise a second
  // close (or a menu Resume) within the toast's ttl would make this button
  // reopen the wrong tab. resumeClosedTab no-ops if the id is already gone.
  const entryId = useApp.getState().closedTabs[taskId]?.[0]?.id;
  useUI.getState().pushToast(i18n.t("backend:closeTab.closedResumeToast", { label }), "info", {
    ttlMs: 6000,
    action: {
      label: i18n.t("backend:closeTab.resume"),
      onClick: () => { if (entryId) useApp.getState().resumeClosedTab(taskId, entryId); },
    },
  });
}

/** Close a main-pane tab, asking first when closing is destructive.
 *  Resolves once the tab is closed or the user backs out. */
export async function requestCloseTab(taskId: string, tabId: string) {
  const tab = useApp.getState().tabs[taskId]?.find(t => t.id === tabId);
  if (!(await confirmTabClose(taskId, tab, false))) return;
  const fastClose = tab?.type === "terminal" && tab.cli !== "shell" && !usePrefs.getState().confirmBeforeCloseAgentTab;
  useApp.getState().closeTab(taskId, tabId);
  if (fastClose && tab) toastClosedTab(taskId, tab, false);
}

/** Close a split-pane tab with the same confirm gate as the main path.
 *  Returns true when the tab was actually closed (so callers can chain a
 *  closePane when it was the pane's last tab), false when the user backed
 *  out. */
export async function requestClosePaneTab(taskId: string, paneId: string, tabId: string): Promise<boolean> {
  const tab = useApp.getState().tabs[taskId]?.find(t => t.id === tabId);
  if (!(await confirmTabClose(taskId, tab, true))) return false;
  const fastClose = tab?.type === "terminal" && tab.cli !== "shell" && !usePrefs.getState().confirmBeforeCloseAgentTab;
  useApp.getState().closePaneTab(taskId, paneId, tabId);
  if (fastClose && tab) toastClosedTab(taskId, tab, true);
  return true;
}

/** Close every tab in `tabs`, prompting once per scratchpad. Non-pads close
 *  straight away (the ONE bulk confirm above already covered them); each pad
 *  asks, and a Cancel keeps THAT pad's tab while the rest of the set still
 *  closes. Cancel meaning "spare this one" rather than "abort the whole
 *  thing" is the only reading that survives the fact that the tabs before it
 *  are already gone by then. */
async function closeSetWithScratchPrompts(
  taskId: string, tabs: Tab[], close: (tab: Tab) => void,
) {
  for (const t of tabs) {
    if (t.type === "scratch") {
      // Re-read: an earlier pad's Save… promoted through a modal, and the
      // user could have acted on this tab while it was open.
      const live = (useApp.getState().tabs[taskId] ?? []).find(x => x.id === t.id);
      if (!live) continue;
      if (live.type === "scratch" && !(await confirmScratchClose(taskId, live))) continue;
    }
    close(t);
  }
}

/** Close a set of main-pane tabs behind ONE confirm. Secondary agent tabs still
 *  snapshot into `closedTabs`, so the "+" menu's Resume section can bring any of
 *  them back. */
export async function requestCloseTabs(taskId: string, tabIds: string[]) {
  const tabs = (useApp.getState().tabs[taskId] ?? []).filter(t => tabIds.includes(t.id));
  if (!tabs.length) return;
  if (!(await confirmBulkClose(tabs))) return;
  await closeSetWithScratchPrompts(taskId, tabs, t => useApp.getState().closeTab(taskId, t.id));
}

/** Close a set of split-pane tabs behind ONE confirm. The clicked tab always
 *  survives both menu actions, so the pane can never end up empty here. */
export async function requestClosePaneTabs(taskId: string, paneId: string, tabIds: string[]) {
  const tabs = (useApp.getState().tabs[taskId] ?? []).filter(t => tabIds.includes(t.id));
  if (!tabs.length) return;
  if (!(await confirmBulkClose(tabs))) return;
  await closeSetWithScratchPrompts(taskId, tabs, t => useApp.getState().closePaneTab(taskId, paneId, t.id));
}
