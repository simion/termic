// Other machines in the sidebar (docs/remote.md, "Paired computers in the
// sidebar"): one section per paired computer or server, below this
// computer's own projects, with its projects and tasks drawn like local
// ones. Clicking a task opens it in the main area (RemoteTaskView).
//
// Reads only the remote store's slice: a remote update never re-renders a
// local row, and a local change never re-renders these.

import { claimTerminal } from "@/lib/claimTerminal";
import { invoke } from "@tauri-apps/api/core";
import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bell, Check, ChevronDown, ChevronRight, Folder, MoreVertical, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Monitor, Pin, Plus, RefreshCw, Server, MonitorSmartphone, Smartphone, Plug, SlidersHorizontal, WifiOff } from "lucide-react";
import { Expand } from "@/components/ui/Expand";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { Spinner } from "@/components/ui/Spinner";
import { Tip } from "@/components/ui/Tooltip";
import { Button } from "@/components/ui/Button";
import { usePrefs, taskLocationIconShown, type RemoteDisplay } from "@/store/prefs";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { TaskBranchText } from "@/components/TaskBranchText";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { ACCENTS, accentCss } from "@/lib/accents";
import { ContextMenuContent, ContextMenuItem, ContextMenuRoot, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/ContextMenu";
import { useUI } from "@/store/ui";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator, DropdownSub, DropdownSubTrigger, DropdownSubContent } from "@/components/ui/Dropdown";
import type { Project } from "@/lib/types";
import { WINDOW_LABEL } from "@/lib/profileScope";

/** A machine listed in this window: it belongs to this window's profile. */
export const mine = (m: MachineView) => (m.profile ?? "main") === WINDOW_LABEL;
import { groupColorCss } from "@/lib/taskGroups";
import { prBadgeAppearance, type PrBadgeState } from "@/lib/prBadgeAppearance";
import { prNounShort, prRef } from "@/lib/forge";
import type { ForgeProvider } from "@/lib/types";
import { openPath, peerUnpair } from "@/lib/ipc";
import { copyToClipboard } from "@/lib/clipboard";
import { archiveRemoteTask, remoteArchivingKey, stopRemoteAgent } from "@/components/remote/RemoteTaskView";
import { useIsArchiving } from "@/store/archivingTasks";
import { GroupActionsMenuItems } from "@/components/sidebar/GroupActionsMenuItems";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import type { DelegatedWork } from "@/lib/delegatedWork";
import { copyRemoteAgentBriefing } from "@/lib/agentBriefing";
import { hostFold, joinableGroups, layoutRemote, orderMachines, profilesOf, visibleTasks, remoteCall, req, remoteProps, remoteReconnect, remoteSetConnected, remoteTaskRequest, serverRemove, useRemote, type RemoteTaskAction, type MachineView, type RemoteGroup, type RemoteProject, type RemoteTask, openNewTaskOnServer } from "@/lib/remote";

/** A top-level sidebar section header, styled as PROJECTS': a filled bar
 *  with the label, a fold, and its actions on the right. */
export function SidebarSectionHeader({ testId, icon, label, badge, badgeTitle, folded, onToggle, children }: { testId: string; icon: ReactNode; label: string; badge?: string; badgeTitle?: string; folded: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <div data-testid={testId} className="group mb-1.5 flex h-8 select-none items-center justify-between rounded-md bg-[var(--color-bg-2)] pl-1 pr-0.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-dim)]">
      <button type="button" onClick={onToggle} aria-expanded={!folded} className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left">
        {folded ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        {icon}
        {/* A button resets text-transform: the case goes on the label. */}
        <span className="truncate uppercase">{label}</span>
        {/* The settings rail's experimental pill, the same look. */}
        {badge && <span data-testid={`${testId}-badge`} title={badgeTitle} className="shrink-0 rounded bg-[var(--color-bg-3)] px-1 py-px text-[10px] font-normal uppercase tracking-wider text-[var(--color-fg-faint)]">{badge}</span>}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">{children}</div>
    </div>
  );
}

/** A machine's connection, as its icon's colour: green, amber, faded. */
const statusIcon = (state: string) =>
  state === "online" ? "text-[var(--color-ok)]" : state === "connecting" ? "text-[var(--color-warn)]" : "text-[var(--color-fg-faint)] opacity-60";

const stateLabel = (state: string, t: (k: string) => string) =>
  state === "connecting" ? t("sidebar.connecting") : state === "disconnected" ? t("sidebar.disconnected") : t("sidebar.offline");

const headerBtn = "rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]";

/** REMOTE: the sidebar's half of Settings > Remote. Always shown (outside
 *  the compact rail), so its + is where you add a server, connect a phone
 *  or pair a computer. Servers come first, each a row (its state, New
 *  task, a menu) with its projects under it, drawn by the sidebar's own
 *  renderProject; then paired computers, each drawn from what it reports.
 *  Phones get no rows: they have no tasks to show. */
/** Whether REMOTE has any rows: a server or a paired computer of this
 *  profile. Phones have no rows. Without any, the section is not drawn and
 *  its add menu lives on the footer's globe instead (`RemoteFooterButton`). */
export function useHasRemoteRows(): boolean {
  return useRemote(s => s.machines.some(mine));
}

/** Add a server / Connect a phone / Pair a computer, on any trigger. */
function RemoteAddMenu({ children }: { children: ReactNode }) {
  const { t } = useTranslation("remote");
  const setDialog = useRemote(s => s.setDialog);
  const openSettings = useApp(s => s.openSettings);
  return (
    <DropdownRoot>
      <Tip content={t("sidebar.addRemote")}>
        <DropdownTrigger asChild>{children}</DropdownTrigger>
      </Tip>
      {/* Focus does not go back to the trigger on close: it would open the
          trigger's tooltip over the spot the menu just left. */}
      <DropdownMenu onCloseAutoFocus={e => e.preventDefault()}>
        <DropdownItem data-testid="sidebar-connect-phone" onSelect={() => setDialog({ phoneDialog: true })}><Smartphone className="h-4 w-4" />{t("phones.connect")}</DropdownItem>
        <DropdownItem data-testid="sidebar-pair-computer" onSelect={() => openSettings("remote")}><Monitor className="h-4 w-4" />{t("sidebar.pairComputer")}</DropdownItem>
        <DropdownItem data-testid="sidebar-add-server" onSelect={() => setDialog({ serverDialog: true })}><Server className="h-4 w-4" />{t("sidebar.addServer")}</DropdownItem>
      </DropdownMenu>
    </DropdownRoot>
  );
}

/** The footer's globe: the way in to remote control while REMOTE has no rows. */
export function RemoteFooterButton({ className }: { className: string }) {
  const { t } = useTranslation("remote");
  const shown = usePrefs(s => s.showRemote);
  if (useHasRemoteRows() || !shown) return null;
  return (
    <RemoteAddMenu>
      <Button size="icon" variant="icon" data-testid="sidebar-footer-remote" aria-label={t("sidebar.addRemote")}><MonitorSmartphone className={className} /></Button>
    </RemoteAddMenu>
  );
}

/** Drag a paired computer by its header to reorder the list. Pointer
 *  events, as the project drag does (WKWebView's HTML5 drag is unreliable):
 *  past 4px it is a drag, the order follows the cursor live, and the click
 *  that ends it does not also fold the computer. */
function useMachineDrag(ids: string[]) {
  const [id, setId] = useState<string | null>(null);
  const live = useRef(ids);
  live.current = ids;
  const down = (e: ReactPointerEvent, machine: string) => {
    if (e.button !== 0 || !(e.target as HTMLElement).closest("[data-machine-head]")) return;
    if ((e.target as HTMLElement).closest("[role=switch], [data-no-drag]")) return;
    const startY = e.clientY;
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        active = true;
        setId(machine);
      }
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-machine-id]"));
      const over = rows.find(r => { const b = r.getBoundingClientRect(); return ev.clientY >= b.top && ev.clientY < b.bottom; });
      const target = over?.dataset.machineId;
      if (!target || target === machine) return;
      const next = live.current.filter(x => x !== machine);
      next.splice(next.indexOf(target) + (live.current.indexOf(target) > live.current.indexOf(machine) ? 1 : 0), 0, machine);
      useRemote.getState().setMachineOrder(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!active) return;
      setId(null);
      // The drag ended on the header's fold button: eat that one click.
      window.addEventListener("click", ev => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { id, down };
}

/** A computer that cannot be used right now: switched off, or not reachable. */
// Unreachable, not switched off: a computer you turned off is available,
// one tap from connecting, so it keeps its own row and switch.
const isOffline = (m: MachineView) => m.state === "offline";

/** The New task "+" on a remote row, per REMOTE's display menu. */
// A header's + shows on hover, as a local project's does beside its New
// task row.
const HOVER_PLUS = "opacity-0 focus-visible:opacity-100 group-hover:opacity-100";

/** What a folded computer is doing: working and finished tasks, so it can
 *  stay folded until one of them is worth opening it for. */
function FoldedCounts({ tasks }: { tasks: RemoteTask[] }) {
  const working = tasks.filter(t => t.state === "working").length;
  const done = tasks.filter(t => t.state === "done").length;
  if (!working && !done) return null;
  return (
    <span data-testid="machine-counts" className="flex items-center gap-1 px-0.5 text-[11px] tabular-nums text-[var(--color-fg-faint)]">
      {working > 0 && <><Spinner size={10} />{working}</>}
      {done > 0 && <><span className="ml-0.5 block h-1.5 w-1.5 rounded-full bg-[var(--color-info)]" />{done}</>}
    </span>
  );
}

/** REMOTE's own display menu: how other computers are drawn, separately
 *  from Projects' (they can be quieter than your own work). */
function RemoteDisplayMenu() {
  const { t } = useTranslation("remote");
  const d = usePrefs(s => s.remoteDisplay);
  const set = usePrefs(s => s.setRemoteDisplay);
  const check = (on: boolean) => <Check className={cn("h-3.5 w-3.5", !on && "invisible")} />;
  return (
    <DropdownRoot>
      <Tip content={t("display.title")}>
        <DropdownTrigger asChild>
          <Button size="icon" variant="icon" data-testid="remote-display-menu" aria-label={t("display.title")}><SlidersHorizontal className="h-4 w-4" /></Button>
        </DropdownTrigger>
      </Tip>
      <DropdownMenu align="end" className="w-64">
        <DropdownItem data-testid="remote-display-new-task" onSelect={e => { e.preventDefault(); set({ newTask: d.newTask === "never" ? "always" : "never" }); }}>{check(d.newTask !== "never")}{t("display.newTask")}</DropdownItem>
        <DropdownItem data-testid="remote-display-switch" onSelect={e => { e.preventDefault(); set({ hideSwitch: !d.hideSwitch }); }}>{check(!d.hideSwitch)}{t("display.connectSwitch")}</DropdownItem>
        <DropdownItem data-testid="remote-display-counts" onSelect={e => { e.preventDefault(); set({ counts: !d.counts }); }}>{check(d.counts)}{t("display.counts")}</DropdownItem>
        <DropdownItem data-testid="remote-display-inactive" onSelect={e => { e.preventDefault(); set({ inactiveAtBottom: !d.inactiveAtBottom }); }}>{check(d.inactiveAtBottom)}{t("display.inactive")}</DropdownItem>
        <DropdownSeparator />
        <DropdownItem data-testid="remote-display-offline-gather" onSelect={() => set({ offline: "gather" })}>{check(d.offline === "gather")}{t("display.offlineGather")}</DropdownItem>
        <DropdownItem data-testid="remote-display-offline-each" onSelect={() => set({ offline: "each" })}>{check(d.offline === "each")}{t("display.offlineEach")}</DropdownItem>
      </DropdownMenu>
    </DropdownRoot>
  );
}

/** "Inactive projects" under a computer: the ones with nothing running,
 *  folded away like the local list's, one level in. */
function InactiveFold({ id, count, children }: { id: string; count: number; children: ReactNode }) {
  const { t } = useTranslation("sidebar");
  const open = useRemote(s => !!s.folded[`inactive:${id}`]);
  const toggle = useRemote(s => s.toggleFold);
  if (count === 0) return null;
  return (
    <div data-testid={`remote-inactive-${id}`}>
      <button type="button" aria-expanded={open} onClick={() => toggle(`inactive:${id}`)}
        className="flex h-[var(--task-row-h)] w-full select-none items-center gap-1.5 rounded-md px-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg-dim)]">
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="truncate">{t("inactiveHeader")}</span>
        <span className="ml-auto tabular-nums">{count}</span>
      </button>
      <Expand open={open}><div className="flex flex-col gap-0.5">{children}</div></Expand>
    </div>
  );
}

export function RemoteSidebarSection({ projects, renderProject, isActive }: { projects: Project[]; renderProject: (p: Project) => ReactNode; isActive: (projectId: string) => boolean }) {
  const { t } = useTranslation("remote");
  const all = useRemote(s => s.machines);
  const order = useRemote(s => s.machineOrder);
  const display = usePrefs(s => s.remoteDisplay);
  const servers = useMemo(() => all.filter(m => m.kind === "server" && mine(m)), [all]);
  const computers = useMemo(() => orderMachines(all.filter(m => m.kind !== "server" && mine(m)), order), [all, order]);
  const drag = useMachineDrag(computers.map(m => m.id));
  const folded = useRemote(s => !!s.folded["section:remote"]);
  const offOpen = useRemote(s => !!s.folded["section:offline"]);
  const toggle = useRemote(s => s.toggleFold);
  const { t: ts } = useTranslation("settings");
  const shown = usePrefs(s => s.showRemote);
  if (!shown || (servers.length === 0 && computers.length === 0)) return null;
  const machineRow = (m: MachineView) => m.kind === "server"
    ? <ServerBlock key={m.id} m={m} projects={projects.filter(p => p.server === m.id)} renderProject={renderProject} isActive={isActive} />
    : (
      <div key={m.id} data-machine-id={m.id} onPointerDown={e => drag.down(e, m.id)} className={cn(drag.id === m.id && "opacity-60")}>
        <MachineSection m={m} />
      </div>
    );
  // Unreachable computers gather in one line at the bottom (never hidden:
  // each is one tap away there). A single one is itself. Switched-off ones
  // stay in the list with their switch.
  const live = [...servers, ...computers].filter(m => !isOffline(m));
  const off = [...servers, ...computers].filter(isOffline);
  const gather = display.offline === "gather" && off.length > 1;
  return (
    <div data-testid="remote-sidebar-section" className="pt-1.5">
      <SidebarSectionHeader testId="remote-section-header" icon={<MonitorSmartphone className="h-4 w-4 shrink-0" />} label={t("sidebar.remoteHeader")} badge={ts("rail.badgeExp")} badgeTitle={t("sidebar.badgeExperimental")}
        folded={folded} onToggle={() => toggle("section:remote")}>
        <RemoteDisplayMenu />
        <RemoteAddMenu>
          <Button size="icon" variant="icon" data-testid="sidebar-add-remote" aria-label={t("sidebar.addRemote")}><Plug className="h-4 w-4" /></Button>
        </RemoteAddMenu>
      </SidebarSectionHeader>
      <Expand open={!folded}>
        <div className="flex flex-col gap-1">
          {live.map(machineRow)}
          {gather ? (
            <div data-testid="remote-offline-group">
              <button type="button" aria-expanded={offOpen} onClick={() => toggle("section:offline")}
                className="flex h-8 w-full select-none items-center gap-1.5 rounded-md pl-1 pr-2 text-left text-[13px] text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg-dim)]">
                {offOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                <WifiOff className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{t("sidebar.offlineCount", { count: off.length })}</span>
              </button>
              <Expand open={offOpen}><div className="ml-3 flex flex-col gap-0.5">{off.map(machineRow)}</div></Expand>
            </div>
          ) : off.map(machineRow)}
        </div>
      </Expand>
    </div>
  );
}

const NO_PROFILES: string[] = [];
type MenuItem = (p: { onSelect: () => void; children: ReactNode; testId?: string; danger?: boolean }) => ReactNode;

/** A server's or paired computer's menu (its ⋮ and right-click). */
function MachineMenuItems({ m, Item, Sep }: { m: MachineView; Item: MenuItem; Sep: () => ReactNode }) {
  const { t } = useTranslation("remote");
  const { t: ts } = useTranslation("settings");
  const setDialog = useRemote(s => s.setDialog);
  const openSettings = useApp(s => s.openSettings);
  const server = m.kind === "server";
  const online = m.state === "online";
  const off = m.state === "disconnected";
  // A computer's profiles: which of them this sidebar shows.
  // From the machine as it arrived, not the filtered view the section
  // passes: a hidden profile must stay in the list to be ticked back on.
  const allTasks = useRemote(s => s.machines.find(x => x.id === m.id)?.tasks) ?? m.tasks;
  const profiles = useMemo(() => (server ? [] : profilesOf(allTasks)), [server, allTasks]);
  const hidden = useRemote(s => s.hiddenProfiles[m.id]) ?? NO_PROFILES;
  const toggleProfile = useRemote(s => s.toggleProfile);
  const switchTo = (on: boolean) => void remoteSetConnected(m.id, on).catch(e => useUI.getState().pushToast(String(e), "error"));
  const remove = async () => {
    const ok = await useUI.getState().askConfirm({ title: t("servers.removeTitle", { name: m.name }), message: t("servers.removeMessage", { name: m.name }), confirmLabel: t("servers.remove"), destructive: true });
    if (!(typeof ok === "boolean" ? ok : ok.confirmed)) return;
    await serverRemove(m.id).catch(e => useUI.getState().pushToast(String(e), "error"));
  };
  // A paired computer's id is its pairing id (remote_client.rs).
  const unpair = async () => {
    const ok = await useUI.getState().askConfirm({ title: ts("peers.paired.unpairTitle", { name: m.name }), message: ts("peers.paired.unpairMessage", { name: m.name }), confirmLabel: ts("peers.paired.unpair"), destructive: true });
    if (!(typeof ok === "boolean" ? ok : ok.confirmed)) return;
    await peerUnpair(m.id).catch(e => useUI.getState().pushToast(String(e), "error"));
  };
  return (
    <>
      {server && online && <Item testId="server-menu-add-project" onSelect={() => useUI.getState().openNewProject(m.id)}>{t("sidebar.addProject")}</Item>}
      {!online && !off && <Item testId="server-menu-reconnect" onSelect={() => void remoteReconnect()}>{t("sidebar.reconnect")}</Item>}
      {off
        ? <Item testId="machine-menu-connect" onSelect={() => switchTo(true)}>{t("sidebar.connect")}</Item>
        : <Item testId="machine-menu-disconnect" onSelect={() => switchTo(false)}>{t("sidebar.disconnect")}</Item>}
      {profiles.length > 1 && <>
        <Sep />
        {profiles.map(p => {
          const on = !hidden.includes(p.id);
          return (
            <Item key={p.id} testId={`machine-menu-profile-${p.id}`} onSelect={() => toggleProfile(m.id, p.id)}>
              <span className="flex items-center gap-2" data-checked={on}>
                <span className="flex w-3.5 justify-center">{on && <Check className="h-3.5 w-3.5" />}</span>
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: p.accent }} />
                {p.name}
              </span>
            </Item>
          );
        })}
        <Sep />
      </>}
      <Item testId="server-menu-settings" onSelect={() => openSettings(server ? "servers" : "remote")}>{server ? t("sidebar.serverSettings") : t("sidebar.pairingSettings")}</Item>
      <Sep />
      {server
        ? <Item testId="server-menu-remove" danger onSelect={() => void remove()}>{t("sidebar.removeServer")}</Item>
        : <Item testId="machine-menu-unpair" danger onSelect={() => void unpair()}>{t("sidebar.unpairComputer")}</Item>}
    </>
  );
}

/** On / off for a machine's connection, right on its row: the settings
 *  switch (Controls.tsx Toggle), sized for a sidebar row. */
/** Turn a computer on and show what it brings back, unfolded. The switch
 *  does this, and so does a click on a switched-off computer's row: it has
 *  nothing to fold open, so connecting is what the click means. */
function connectAndOpen(m: MachineView) {
  if (useRemote.getState().folded[m.id]) useRemote.getState().toggleFold(m.id);
  void remoteSetConnected(m.id, true).catch(err => useUI.getState().pushToast(String(err), "error"));
}

function MachineSwitch({ m }: { m: MachineView }) {
  const { t } = useTranslation("remote");
  const on = m.state !== "disconnected";
  const label = on ? t("sidebar.disconnect") : t("sidebar.connect");
  return (
    <Tip content={label}>
      <button
        type="button" role="switch" aria-checked={on} aria-label={label}
        data-testid={`machine-switch-${m.id}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!on) return connectAndOpen(m);
          void remoteSetConnected(m.id, false).catch(err => useUI.getState().pushToast(String(err), "error"));
        }}
        className="relative mx-1 inline-block h-4 w-7 shrink-0 rounded-full p-0"
        // Off is a grey track, not bg-3: on a hovered row bg-3 vanished and
        // only the knob showed.
        style={{ background: on ? "var(--color-accent)" : "color-mix(in srgb, var(--color-fg-faint) 55%, transparent)", transition: "background-color 150ms" }}
      >
        <span className="absolute top-0.5 h-3 w-3 rounded-full"
          style={{ left: on ? 14 : 2, background: on ? "var(--color-accent-fg)" : "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left 150ms, background-color 150ms" }} />
      </button>
    </Tip>
  );
}

/** The ⋮ button that opens a machine's menu. */
function MachineMenuButton({ m }: { m: MachineView }) {
  const { t } = useTranslation("remote");
  return (
    <DropdownRoot>
      <DropdownTrigger asChild>
        <button type="button" data-testid={`server-menu-${m.id}`} aria-label={t("sidebar.serverSettings")} className={headerBtn}><MoreVertical className="h-3.5 w-3.5" /></button>
      </DropdownTrigger>
      <DropdownMenu>
        <MachineMenuItems m={m} Sep={() => <DropdownSeparator />}
          Item={({ onSelect, children, testId, danger }) => <DropdownItem onSelect={onSelect} data-testid={testId} className={danger ? "text-[var(--color-err)]" : undefined}>{children}</DropdownItem>} />
      </DropdownMenu>
    </DropdownRoot>
  );
}

/** Right-click on a machine's row opens the same menu. */
function MachineContextMenu({ m, children }: { m: MachineView; children: ReactNode }) {
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <MachineMenuItems m={m} Sep={() => <ContextMenuSeparator />}
          Item={({ onSelect, children: c, danger }) => <ContextMenuItem onSelect={onSelect} destructive={danger}>{c}</ContextMenuItem>} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

/** A newer termic-server is on the box and agents are running there:
 *  restarting stops them (they resume in their sessions), so it asks. */
function ServerUpdate({ m }: { m: MachineView }) {
  const { t } = useTranslation("remote");
  const [busy, setBusy] = useState(false);
  return (
    <div data-testid={`server-update-${m.id}`} data-required={m.update_required ? "true" : "false"} className="mx-2 mb-1 mt-0.5 flex items-center gap-2 text-[11.5px] text-[var(--color-fg-dim)]">
      <span className="min-w-0 flex-1">{m.update_required ? t("sidebar.updateReady") : t("sidebar.updateOptional")}</span>
      <button
        type="button"
        data-testid={`server-restart-${m.id}`}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          // `quit`, or over ssh for a daemon from before it (server_restart).
          invoke<void>("server_restart", { machine: m.id })
            .catch(e => { setBusy(false); useUI.getState().pushToast(String(e), "error"); });
        }}
        className="shrink-0 rounded px-1.5 py-0.5 font-medium text-[var(--color-accent)] hover:bg-[var(--color-hover)] disabled:opacity-50"
      >
        {t("sidebar.restartServer")}
      </button>
    </div>
  );
}

const ServerBlock = memo(function ServerBlock({ m, projects, renderProject, isActive }: { m: MachineView; projects: Project[]; renderProject: (p: Project) => ReactNode; isActive: (projectId: string) => boolean }) {
  const { t } = useTranslation("remote");
  const display = usePrefs(s => s.remoteDisplay);
  const folded = useRemote(s => !!s.folded[m.id]);
  const toggle = useRemote(s => s.toggleFold);
  const setDialog = useRemote(s => s.setDialog);
  const online = m.state === "online";
  // Switched off: the row stays, its projects fold away until it is back on.
  const off = m.state === "disconnected";
  const waiting = m.tasks.filter(x => x.state === "waiting").length;
  const header = (
    <div data-testid={`server-block-${m.id}`} data-state={m.state}
      className={cn("group flex h-8 select-none items-center justify-between rounded-md pl-1 pr-0.5 text-[13px] font-medium text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]", !online && "opacity-70")}>
      <button type="button" onClick={() => (off ? connectAndOpen(m) : toggle(m.id))} aria-expanded={!folded && !off} className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left">
        {folded || off ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        <Server data-testid={`server-icon-${m.id}`} className={cn("h-4 w-4 shrink-0", statusIcon(m.state))} />
        <span className="truncate text-[var(--color-fg)]">{m.name}</span>
        {!online && <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{stateLabel(m.state, t)}</span>}
        {online && waiting > 0 && <span className="flex items-center gap-0.5 px-1 text-[11px] tabular-nums text-[var(--color-warn)]"><Bell className="h-3 w-3" />{waiting}</span>}
        {online && folded && display.counts && <FoldedCounts tasks={m.tasks} />}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        {!online && !off && (
          <Tip content={m.error ?? t("sidebar.reconnect")}>
            <button type="button" aria-label={t("sidebar.reconnect")} onClick={() => void remoteReconnect()} className={headerBtn}><RefreshCw className="h-3.5 w-3.5" /></button>
          </Tip>
        )}
        {/* No New task here: a server holds several projects, and New task
            belongs to the project row it starts in. The switch is on the row
            only when REMOTE's display menu asks (it is always in ⋯). */}
        {!display.hideSwitch && <MachineSwitch m={m} />}
        <MachineMenuButton m={m} />
      </div>
    </div>
  );
  return (
    <div>
      <MachineContextMenu m={m}>{header}</MachineContextMenu>
      {!online && !off && !folded && m.error && (
        <div className="mx-2 mt-0.5 text-[11.5px] text-[var(--color-fg-faint)]">{m.error}</div>
      )}
      {online && m.update && <ServerUpdate m={m} />}
      {/* Its projects, one step in under it, the idle ones folded into
          its own Inactive projects. */}
      <Expand open={!folded && !off}>
        <div className="ml-3 flex flex-col gap-0.5">
          {projects.length === 0
            ? <div className="flex h-[var(--task-row-h)] items-center px-2 text-[12.5px] text-[var(--color-fg-faint)]">{t("sidebar.noServerProjects")}</div>
            : display.inactiveAtBottom
            ? <>
                {projects.filter(p => isActive(p.id)).map(renderProject)}
                <InactiveFold id={m.id} count={projects.filter(p => !isActive(p.id)).length}>
                  {projects.filter(p => !isActive(p.id)).map(renderProject)}
                </InactiveFold>
              </>
            : projects.map(renderProject)}
        </div>
      </Expand>
    </div>
  );
});

/** The glyph a task's state draws, the desktop's own language
 *  (docs/agent-states.md): amber bell, spinner, blue dot, nothing; and the
 *  local row's ring while the agent waits on work it handed off (a subagent,
 *  a background shell), which is not a model computing. */
export function StateGlyph({ state, size = 13, delegated }: { state: string; size?: number; delegated?: DelegatedWork | null }) {
  if (delegated && state !== "waiting") {
    return <TaskWorkBadge reason={state === "working" ? "working" : state === "done" ? "done" : "delegated"} delegated={delegated} testId="remote-work-badge" />;
  }
  if (state === "waiting") return <Bell className="shrink-0 text-[var(--color-warn)]" style={{ width: size, height: size }} />;
  if (state === "working") return <Spinner size={size - 1} />;
  if (state === "done") return <span className="block h-2 w-2 shrink-0 rounded-full bg-[var(--color-info)]" />;
  return null;
}

const MachineSection = memo(function MachineSection({ m: all }: { m: MachineView }) {
  const { t } = useTranslation("remote");
  // The profiles this window hides (its menu's checklist) leave its rows,
  // its bell count and every menu built from its tasks.
  const hidden = useRemote(s => s.hiddenProfiles[all.id]);
  const tasks = useMemo(() => visibleTasks(all.tasks, hidden), [all.tasks, hidden]);
  const m = useMemo(() => (tasks === all.tasks ? all : { ...all, tasks }), [all, tasks]);
  const folded = useRemote(s => !!s.folded[m.id]);
  const toggle = useRemote(s => s.toggleFold);
  const setDialog = useRemote(s => s.setDialog);
  const openSettings = useApp(s => s.openSettings);
  const online = m.state === "online";
  const drives = m.grant !== "reply";
  const waiting = m.tasks.filter(t => t.state === "waiting").length;
  // Offline sections fold: rows that may be stale and cannot be acted on
  // are worse than none.
  const showRows = online && !folded;

  // As the host's own sidebar files them: folders, projects, groups.
  const blocks = useMemo(() => layoutRemote(m.tasks), [m.tasks]);
  const display = usePrefs(s => s.remoteDisplay);
  // A project whose every task's agent is stopped is inactive, as locally.
  const quiet = (b: (typeof blocks)[number]) => b.kind === "project"
    && b.project.segments.every(seg => (seg.kind === "task" ? [seg.task] : seg.tasks).every(x => x.state === "inactive"));
  const shownBlocks = display.inactiveAtBottom ? blocks.filter(b => !quiet(b)) : blocks;
  const idleBlocks = display.inactiveAtBottom ? blocks.filter(quiet) : [];
  const renderBlock = (b: (typeof blocks)[number]) => b.kind === "project"
    ? <RemoteProjectRows key={`p:${b.project.name}`} m={m} project={b.project} />
    : <RemoteFolder key={`f:${b.folder.id}`} m={m} folder={b.folder} projects={b.projects} />;

  const Icon = m.kind === "server" ? Server : Monitor;
  return (
    <div data-testid={`remote-machine-${m.id}`} data-state={m.state}>
      <MachineContextMenu m={m}>
      <div
        data-machine-head=""
        className={cn(
          "group flex h-8 select-none items-center justify-between rounded-md pl-1 pr-0.5 text-[13px] font-medium text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]",
          !online && "opacity-70",
        )}
      >
        <button
          type="button"
          // Switched off, the row's click connects it (connectAndOpen).
          onClick={() => (m.state === "disconnected" ? connectAndOpen(m) : toggle(m.id))}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
          aria-expanded={showRows}
        >
          {folded || !online ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
          <Icon className={cn("h-4 w-4 shrink-0", statusIcon(m.state))} />
          <span className="truncate text-[var(--color-fg)]">{m.name}</span>
          {!online && (
            <span className="truncate text-[11px] font-normal normal-case tracking-normal text-[var(--color-fg-faint)]">
              {stateLabel(m.state, t)}
            </span>
          )}
          {online && folded && display.counts && <FoldedCounts tasks={m.tasks} />}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {online && waiting > 0 && (
            <Tip content={t("sidebar.needsYou", { count: waiting })}>
              <span className="flex items-center gap-0.5 px-1 text-[11px] font-medium normal-case tabular-nums text-[var(--color-warn)]">
                <Bell className="h-3 w-3" />{waiting}
              </span>
            </Tip>
          )}
          {!online && m.state !== "disconnected" && (
            <Tip content={m.error ?? t("sidebar.reconnect")}>
              <button
                type="button"
                aria-label={t("sidebar.reconnect")}
                onClick={() => void remoteReconnect()}
                className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </Tip>
          )}
          {/* On hover always: REMOTE's option is only the row under tasks. */}
          {online && drives && (
            <Tip content={t("sidebar.newTask", { name: m.name })}>
              <button
                type="button"
                data-testid={`remote-new-task-${m.id}`}
                aria-label={t("sidebar.newTask", { name: m.name })}
                onClick={() => void openNewTaskOnServer(m.id)}
                className={cn("rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]", HOVER_PLUS)}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </Tip>
          )}
          {!display.hideSwitch && <MachineSwitch m={m} />}
          <MachineMenuButton m={m} />
        </div>
      </div>
      </MachineContextMenu>
      {!online && m.state !== "disconnected" && !folded && m.error && (
        <button
          type="button"
          onClick={() => openSettings(m.kind === "server" ? "remote" : "mcp")}
          className="mx-2 mt-1 block text-left text-[11.5px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]"
        >
          {m.error}
        </button>
      )}
      <Expand open={showRows}>
        <div className="ml-3 mt-0.5 flex flex-col gap-0.5">
          {m.grant === "reply" && (
            <div className="px-3 text-[11.5px] text-[var(--color-fg-faint)]">{t("sidebar.replyOnly")}</div>
          )}
          {blocks.length === 0 && drives && (
            <div className="flex h-[var(--task-row-h)] items-center px-3 text-[12.5px] text-[var(--color-fg-faint)]">{t("sidebar.noTasks")}</div>
          )}
          {shownBlocks.map(renderBlock)}
          <InactiveFold id={m.id} count={idleBlocks.length}>{idleBlocks.map(renderBlock)}</InactiveFold>
        </div>
      </Expand>
    </div>
  );
});

/** A project folder on the host: its name in the folder's colour, its
 *  projects under a guide line, as the local sidebar nests them. */
/** A paired computer's fold for one project, task group or folder: the
 *  host's own sidebar state, unless folded or opened here since (hostFold). */
function useHostFold(key: string, host: boolean): [boolean, () => void] {
  const folded = useRemote(s => hostFold(s.foldOver[key], host));
  const toggle = useRemote(s => s.toggleHostFold);
  // The host moved its fold: what was folded here against the old state goes.
  useEffect(() => { useRemote.getState().dropStaleFold(key, host); }, [key, host]);
  return [folded, () => toggle(key, host)];
}

function RemoteFolder({ m, folder, projects }: { m: MachineView; folder: RemoteGroup; projects: RemoteProject[] }) {
  const color = accentCss(folder.color);
  const [folded, toggleIt] = useHostFold(`folder:${m.id}:${folder.id}`, !!folder.collapsed);
  return (
    <div data-testid={`remote-folder-${folder.id}`} data-color={folder.color ?? ""} data-folded={folded}>
      <button type="button" data-testid={`remote-folder-fold-${folder.id}`} aria-expanded={!folded} onClick={toggleIt}
        className="flex h-7 w-full select-none items-center gap-1.5 rounded-md px-2 text-left text-[12px] font-medium text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]" style={color ? { color } : undefined}>
        {folded ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{folder.name}</span>
      </button>
      <Expand open={!folded}>
        <div className="ml-3.5 border-l border-[var(--color-border-soft)] pl-1" style={color ? { borderColor: color } : undefined}>
          {projects.map(p => <RemoteProjectRows key={p.name} m={m} project={p} />)}
        </div>
      </Expand>
    </div>
  );
}

function RemoteProjectRows({ m, project }: { m: MachineView; project: RemoteProject }) {
  const { t } = useTranslation("remote");
  const newTask = usePrefs(s => s.remoteDisplay.newTask);
  // As the host's own sidebar has it (any of its tasks says so).
  const hostFolded = project.segments.some(seg => (seg.kind === "task" ? seg.task : seg.tasks[0])?.project_collapsed);
  const [folded, toggleIt] = useHostFold(`project:${m.id}:${project.name}`, !!hostFolded);
  // The header's + shows on hover whenever New task is possible; REMOTE's
  // display option only adds or removes the row under the tasks.
  const canNew = m.state === "online" && m.grant !== "reply";
  const startNew = () => void openNewTaskOnServer(m.id, project.name);
  return (
    <div data-testid={`remote-project-${project.name}`} data-folded={folded} className="[[data-testid^=remote-project-]+&]:mt-0.5">
      {/* The local project header: its band, type, chevron and padding, and
          it folds the same way (the fold is this computer's, per machine). */}
      {/* Quieter than a local project's band: it already sits one step in
          under its computer. */}
      <div className="group flex items-center rounded-md hover:bg-[var(--color-hover)]">
        <button type="button" data-testid={`remote-project-fold-${project.name}`} aria-expanded={!folded} onClick={toggleIt}
          className="flex min-w-0 flex-1 select-none items-center gap-1.5 py-1.5 pl-2 pr-0 text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-dim)]">
          {folded
            ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
            : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
          <span className="truncate">{project.name}</span>
        </button>
        {/* New task in this project there, as a local project's + does; on
            hover only, beside the row under the tasks (as locally). */}
        {canNew && (
          <Tip content={t("newTask.title", { name: m.name })}>
            <button type="button" data-testid={`remote-project-new-task-${project.name}`}
              aria-label={t("newTask.title", { name: m.name })}
              onClick={startNew}
              className={cn("mr-0.5 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]", HOVER_PLUS)}>
              <Plus className="h-3.5 w-3.5" />
            </button>
          </Tip>
        )}
      </div>
      <Expand open={!folded}>
        {project.segments.map(seg => seg.kind === "task"
          ? <RemoteTaskRow key={seg.task.id} m={m} task={seg.task} />
          : (
            <RemoteGroupBlock key={`g:${seg.group.id}`} m={m} group={seg.group} tasks={seg.tasks} />
          ))}
        {/* The New task row under the tasks, as a local project's: REMOTE's
            display menu shows or hides it. */}
        {canNew && newTask !== "never" && (
          <div className="ml-3 mr-1 mb-px">
            <button type="button" data-testid={`remote-project-new-task-row-${project.name}`}
              aria-label={t("newTask.title", { name: m.name })} title={t("newTask.title", { name: m.name })}
              onClick={startNew}
              className="flex h-[var(--task-row-h)] w-full items-center justify-center rounded-md bg-transparent px-2 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]">
              <Plus className="h-4 w-4 shrink-0" />
            </button>
          </div>
        )}
      </Expand>
    </div>
  );
}

/** A task group on a paired computer: the local block's caption in the
 *  group's colour and its members on a rail of it, folding open and shut
 *  like the local one (the fold is this computer's, keyed per machine). */
function RemoteGroupBlock({ m, group, tasks }: { m: MachineView; group: RemoteGroup; tasks: RemoteTask[] }) {
  const { t } = useTranslation("sidebar");
  const [folded, toggleIt] = useHostFold(`group:${m.id}:${group.id}`, !!group.collapsed);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The local group's menu (colour, rename, ungroup), run on that machine
  // through its `group` verb on a member task. Only where it lets this one.
  const canAct = m.state === "online" && m.grant !== "reply" && m.kind !== "server" && tasks.length > 0;
  const member = tasks[0];
  const run = (a: Record<string, unknown>) => void remoteCall(m.id, req("group", { task: member.id, ...a }))
    .then(r => { if (!r.ok) throw new Error(r.error?.message ?? "refused"); })
    .catch(e => useUI.getState().pushToast(`${m.name}: ${e instanceof Error ? e.message : String(e)}`, "error"));
  const commitRename = () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (name && name !== group.name) run({ name });
  };
  const header = renaming !== null ? (
    <div className="ml-3 flex h-[var(--task-row-h)] items-center px-1">
      <input
        autoFocus
        data-testid={`remote-group-rename-${group.id}`}
        value={renaming}
        onChange={e => setRenaming(e.target.value)}
        onBlur={commitRename}
        onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
        className="m-0 min-w-0 flex-1 rounded-sm border-0 bg-[var(--color-bg)] p-0 text-[13px] font-medium text-inherit outline outline-1 outline-offset-2 outline-[var(--color-accent)]"
      />
    </div>
  ) : (
    <button type="button" aria-expanded={!folded} onClick={toggleIt}
      className="ml-3 flex h-[var(--task-row-h)] w-[calc(100%-0.75rem)] select-none items-center gap-1 rounded-md px-1 text-left text-[13px] font-medium hover:bg-[var(--color-hover)]"
      style={{ color: groupColorCss(group) }}>
      {folded ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{group.name}</span>
      <span className="ml-auto shrink-0 pr-1 text-[11px] font-normal tabular-nums text-[var(--color-fg-faint)]">{tasks.length}</span>
    </button>
  );
  return (
    <div data-testid={`remote-group-${group.id}`} data-color={group.color ?? ""} data-folded={folded}>
      {canAct && renaming === null ? (
        <ContextMenuRoot>
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent>
            <GroupActionsMenuItems
              name={group.name}
              accent={group.color ? groupColorCss(group) : undefined}
              onSetColor={color => { if (color) run({ color }); }}
              noDefaultColour
              onRename={() => setRenaming(group.name)}
              // Every member leaves: the group is gone on that machine.
              onUngroup={() => { for (const x of tasks) void remoteCall(m.id, req("group", { task: x.id, leave: true })); }}
              ungroupLabel={t("taskGroup.ungroupTasks")}
            />
          </ContextMenuContent>
        </ContextMenuRoot>
      ) : header}
      <Expand open={!folded}>
        <div className="ml-6 border-l" style={{ borderColor: groupColorCss(group) }}>
          <div className="-ml-[calc(var(--spacing)*1.5-1px)]">
            {tasks.map(task => <RemoteTaskRow key={task.id} m={m} task={task} />)}
          </div>
        </div>
      </Expand>
    </div>
  );
}

/** The task's PR as the host last read it: the local badge's icon and
 *  colour rules (prBadgeAppearance), without its live checks. */
function RemotePrBadge({ task, showIcon, showNumber }: { task: RemoteTask; showIcon: boolean; showNumber: boolean }) {
  const pr = task.pr;
  if (!pr) return null;
  const state = (["open", "draft", "merged", "closed"].includes(pr.state ?? "") ? pr.state : null) as PrBadgeState;
  const provider = (pr.provider ?? null) as ForgeProvider | null;
  const { color, struck } = prBadgeAppearance(state, null);
  const Icon = state === "merged" ? GitMerge : state === "closed" ? GitPullRequestClosed : state === "draft" ? GitPullRequestDraft : GitPullRequest;
  const label = `${prNounShort(provider)} ${prRef(provider, pr.number)}${pr.title ? ` · ${pr.title}` : ""}`;
  return (
    <Tip content={label} delay={0}>
      <button
        type="button"
        data-testid="remote-pr-badge"
        data-pr-state={state ?? "unknown"}
        onClick={e => { e.stopPropagation(); if (pr.url) openPath(pr.url).catch(() => {}); }}
        className="flex shrink-0 items-center gap-0.5 rounded p-px hover:bg-[var(--color-bg-3)]"
        style={{ color }}
      >
        {showIcon && <Icon className="h-3 w-3" />}
        {showNumber && <span className={cn("text-[11px] tabular-nums leading-none", struck && "tc-pr-struck")}>{prRef(provider, pr.number)}</span>}
      </button>
    </Tip>
  );
}

/** Run a task action on its machine, saying what failed if it did. */
async function act(m: MachineView, task: RemoteTask, a: RemoteTaskAction) {
  try {
    const r = await remoteCall(m.id, remoteTaskRequest(task.id, a));
    if (!r.ok) throw new Error(r.error?.message ?? "refused");
  } catch (e) {
    useUI.getState().pushToast(`${m.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

const RemoteTaskRow = memo(function RemoteTaskRow({ m, task }: { m: MachineView; task: RemoteTask }) {
  const { t } = useTranslation("remote");
  const machine = m.id;
  const active = useRemote(s => s.open?.machine === machine && s.open?.task === task.id);
  const archiving = useIsArchiving(remoteArchivingKey(machine, task.id));
  const openTask = useRemote(s => s.openTask);
  const [renaming, setRenaming] = useState<string | null>(null);
  // That machine's agents, asked when the New tab submenu opens.
  const [agents, setAgents] = useState<{ id: string }[]>([]);
  const loadAgents = async () => {
    const r = await remoteCall(m.id, req("agents")).catch(() => null);
    const list = (r?.ok ? (r.data as { agents?: { id: string; kind: string; usable: boolean }[] } | undefined)?.agents : undefined) ?? [];
    setAgents(list.filter(a => a.kind === "agent" && a.usable));
  };
  const icon = resolveIconId(task.agent, []);
  const props = remoteProps(task);
  // The sidebar's own row settings, as a local task row reads them.
  const showLocation = usePrefs(s => taskLocationIconShown(s.taskLocationIcon, task.is_main_checkout));
  const prMode = usePrefs(s => s.taskPrBadge);
  const branchMode = usePrefs(s => s.taskBranchName);
  const branch = branchMode !== "none" && task.branch && task.branch !== "HEAD" && task.branch !== task.name ? task.branch : null;
  const below = branchMode === "below" && !!branch;
  // The menu acts on the other machine, so only where it lets this one.
  const canAct = m.state === "online" && m.grant !== "reply";
  // A server has no pins or task groups (termic-server answers neither
  // verb): its menu is Rename alone.
  const files = m.kind !== "server";
  const groups = joinableGroups(m.tasks, task);
  const used = new Set(m.tasks.filter(x => x.project === task.project && x.group?.color).map(x => x.group!.color!));
  const freshColor = (ACCENTS.find(a => !used.has(a.key)) ?? ACCENTS[0]).key;
  const commitRename = () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (name && name !== task.name) void act(m, task, { kind: "rename", name });
  };
  const row = (
    <div
      role="button"
      tabIndex={0}
      data-testid={`remote-task-${task.id}`}
      data-state={task.state}
      onClick={() => { openTask({ machine, task: task.id }); claimTerminal(task.id); }}
      onKeyDown={e => { if (e.key === "Enter") openTask({ machine, task: task.id }); }}
      className={cn(
        "ml-3 flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors",
        below ? "min-h-[var(--task-row-h)] py-1" : "h-[var(--task-row-h)]",
        active ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
        // Greyed while its agent is not running, as a local or server task's
        // row is (the sidebar's `isLoaded`); every row read as started.
        (task.state === "inactive" || task.state === "unknown") && "opacity-60",
        archiving && "pointer-events-none opacity-60",
      )}
      data-task-archiving={archiving || undefined}
    >
      {archiving
        ? <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--color-fg-faint)]"><Spinner size={14} /></span>
        : <span className={cn("shrink-0", CLI_BRAND_COLOR[icon])}><CliIcon cli={icon} className="h-4 w-4" /></span>}
      {renaming !== null ? (
        <input
          autoFocus
          data-testid={`remote-task-rename-${task.id}`}
          value={renaming}
          onChange={e => setRenaming(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setRenaming(null);
            e.stopPropagation();
          }}
          onClick={e => e.stopPropagation()}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className="m-0 min-w-0 flex-1 rounded-sm border-0 bg-[var(--color-bg)] p-0 font-medium text-inherit outline outline-1 outline-offset-2 outline-[var(--color-accent)]"
        />
      ) : below ? (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{task.name}</span>
          <TaskBranchText branch={branch!} placement="below" />
        </span>
      ) : (
        <span className="min-w-0 truncate font-medium">{task.name}</span>
      )}
      {showLocation && <TaskLocationIcon isMainCheckout={task.is_main_checkout} branch={task.branch} size="h-3.5 w-3.5" />}
      {branchMode === "inline" && branch && <TaskBranchText branch={branch} placement="inline" />}
      {/* Tab labels after the name, as the local row draws them. */}
      {props && <span data-testid="remote-task-props" className="min-w-0 shrink-[3] truncate text-[11px] text-[var(--color-fg-dim)]">{props}</span>}
      {branchMode === "right" && branch ? <TaskBranchText branch={branch} placement="right" /> : <span className="flex-1" />}
      {task.pinned && <Pin data-testid="remote-task-pinned" aria-hidden className="h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />}
      {prMode !== "none" && <RemotePrBadge task={task} showIcon={prMode !== "number"} showNumber={prMode !== "icon"} />}
      <span className="flex w-4 shrink-0 justify-center"><StateGlyph state={task.state} delegated={task.tabs.find(x => x.delegated)?.delegated} /></span>
    </div>
  );
  if (!canAct) return row;
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setRenaming(task.name)}>{t("menu.rename")}</ContextMenuItem>
        {files && <>
        <ContextMenuItem onSelect={() => void act(m, task, { kind: "pin", pinned: !task.pinned })}>
          {task.pinned ? t("menu.unpin") : t("menu.pin")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>{t("menu.moveToGroup")}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {groups.map(g => (
              <ContextMenuItem key={g.id} onSelect={() => void act(m, task, { kind: "join", lead: g.id })}>
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: groupColorCss(g) }} />{g.name}
              </ContextMenuItem>
            ))}
            {groups.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem onSelect={() => void act(m, task, { kind: "newGroup", color: freshColor })}>{t("menu.newGroup")}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        {task.group && <ContextMenuItem onSelect={() => void act(m, task, { kind: "leave" })}>{t("menu.leaveGroup")}</ContextMenuItem>}
        </>}
        {files && <>
          <ContextMenuSeparator />
          {/* A new tab in the task there: the same agent, or another one. */}
          <ContextMenuSub onOpenChange={o => { if (o) void loadAgents(); }}>
            <ContextMenuSubTrigger>{t("menu.newTab")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => void act(m, task, { kind: "tab", tab: { tab: "default" } })}>{t("menu.sameAgent")}</ContextMenuItem>
              {agents.length > 0 && <ContextMenuSeparator />}
              {agents.map(a => (
                <ContextMenuItem key={a.id} onSelect={() => void act(m, task, { kind: "tab", tab: { tab: "agent", id: a.id } })}>{a.id}</ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {(task.state === "inactive" || task.state === "unknown") && (
            <ContextMenuItem onSelect={() => void act(m, task, { kind: "open" })}>{t("menu.restartAgent")}</ContextMenuItem>
          )}
          {!task.is_main_checkout && task.branch && task.branch !== "HEAD" && (
            <ContextMenuItem onSelect={() => requestAnimationFrame(() => useRemote.getState().setDialog({ newTaskOn: m.id, newTaskProject: task.project, newTaskBase: task.branch! }))}>
              {t("sidebar:duplicateWorktree")}
            </ContextMenuItem>
          )}
        </>}
        {/* The local row's remaining items, run on that machine. */}
        <ContextMenuSeparator />
        {task.branch && task.branch !== "HEAD" && (
          <ContextMenuItem onSelect={() => copyToClipboard(task.branch!, "branch")}>{t("sidebar:copyBranch")}</ContextMenuItem>
        )}
        {files && (
          <ContextMenuItem onSelect={() => void copyRemoteAgentBriefing(task, { id: m.id, name: m.name })}>{t("sidebar:copyBriefing")}</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {task.state !== "inactive" && task.state !== "unknown" && (
          <ContextMenuItem onSelect={() => void stopRemoteAgent(m.id, task.id, m.name)}>{t("sidebar:stopTask")}</ContextMenuItem>
        )}
        <ContextMenuItem destructive onSelect={() => void archiveRemoteTask(m.name, m.id, task, () => {
          if (useRemote.getState().open?.task === task.id) useRemote.getState().openTask(null);
        })}>{t("sidebar:archiveTask")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
});
