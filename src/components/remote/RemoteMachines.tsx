// Other machines in the sidebar (docs/remote.md, "Paired computers in the
// sidebar"): one section per paired computer or server, below this
// computer's own projects, with its projects and tasks drawn like local
// ones. Clicking a task opens it in the main area (RemoteTaskView).
//
// Reads only the remote store's slice: a remote update never re-renders a
// local row, and a local change never re-renders these.

import { invoke } from "@tauri-apps/api/core";
import { memo, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bell, Check, ChevronDown, ChevronRight, Folder, MoreVertical, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Monitor, Pin, Plus, RefreshCw, Server, MonitorSmartphone, Smartphone } from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { Spinner } from "@/components/ui/Spinner";
import { Tip } from "@/components/ui/Tooltip";
import { Button } from "@/components/ui/Button";
import { usePrefs, taskLocationIconShown } from "@/store/prefs";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { TaskBranchText } from "@/components/TaskBranchText";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { ACCENTS, accentCss } from "@/lib/accents";
import { ContextMenuContent, ContextMenuItem, ContextMenuRoot, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/ContextMenu";
import { useUI } from "@/store/ui";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
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
import { archiveRemoteTask, stopRemoteAgent } from "@/components/remote/RemoteTaskView";
import { joinableGroups, layoutRemote, profilesOf, visibleTasks, remoteCall, remoteProps, remoteReconnect, remoteSetConnected, remoteTaskRequest, serverRemove, useRemote, type RemoteTaskAction, type MachineView, type RemoteGroup, type RemoteProject, type RemoteTask, openNewTaskOnServer } from "@/lib/remote";

/** A top-level sidebar section header, styled as PROJECTS': a filled bar
 *  with the label, a fold, and its actions on the right. */
export function SidebarSectionHeader({ testId, icon, label, badge, folded, onToggle, children }: { testId: string; icon: ReactNode; label: string; badge?: string; folded: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <div data-testid={testId} className="group mb-1.5 flex h-8 select-none items-center justify-between rounded-md bg-[var(--color-bg-2)] pl-1 pr-0.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-dim)]">
      <button type="button" onClick={onToggle} aria-expanded={!folded} className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left">
        {folded ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        {icon}
        {/* A button resets text-transform: the case goes on the label. */}
        <span className="truncate uppercase">{label}</span>
        {/* The settings rail's experimental pill, the same look. */}
        {badge && <span data-testid={`${testId}-badge`} className="shrink-0 rounded bg-[var(--color-bg-3)] px-1 py-px text-[10px] font-normal uppercase tracking-wider text-[var(--color-fg-faint)]">{badge}</span>}
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

export function RemoteSidebarSection({ projects, renderProject }: { projects: Project[]; renderProject: (p: Project) => ReactNode }) {
  const { t } = useTranslation("remote");
  const all = useRemote(s => s.machines);
  const servers = useMemo(() => all.filter(m => m.kind === "server" && mine(m)), [all]);
  const computers = useMemo(() => all.filter(m => m.kind !== "server" && mine(m)), [all]);
  const folded = useRemote(s => !!s.folded["section:remote"]);
  const toggle = useRemote(s => s.toggleFold);
  const { t: ts } = useTranslation("settings");
  const shown = usePrefs(s => s.showRemote);
  if (!shown || (servers.length === 0 && computers.length === 0)) return null;
  return (
    <div data-testid="remote-sidebar-section" className="mt-3">
      <SidebarSectionHeader testId="remote-section-header" icon={<MonitorSmartphone className="h-4 w-4 shrink-0" />} label={t("sidebar.remoteHeader")} badge={ts("rail.badgeExp")}
        folded={folded} onToggle={() => toggle("section:remote")}>
        <RemoteAddMenu>
          <button type="button" data-testid="sidebar-add-remote" aria-label={t("sidebar.addRemote")} className={headerBtn}><Plus className="h-3.5 w-3.5" /></button>
        </RemoteAddMenu>
      </SidebarSectionHeader>
      {!folded && (
        <div className="flex flex-col gap-1">
          {servers.map(m => <ServerBlock key={m.id} m={m} projects={projects.filter(p => p.server === m.id)} renderProject={renderProject} />)}
          {computers.map(m => <MachineSection key={m.id} m={m} />)}
        </div>
      )}
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
      {server && online && <Item testId="server-menu-add-project" onSelect={() => setDialog({ newTaskOn: m.id, newTaskAdding: true })}>{t("sidebar.addProject")}</Item>}
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
          // Switched on: show what it brings back, unfolded.
          if (!on && useRemote.getState().folded[m.id]) useRemote.getState().toggleFold(m.id);
          void remoteSetConnected(m.id, !on).catch(err => useUI.getState().pushToast(String(err), "error"));
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

const ServerBlock = memo(function ServerBlock({ m, projects, renderProject }: { m: MachineView; projects: Project[]; renderProject: (p: Project) => ReactNode }) {
  const { t } = useTranslation("remote");
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
      <button type="button" onClick={() => toggle(m.id)} aria-expanded={!folded && !off} className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left">
        {folded || off ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        <Server data-testid={`server-icon-${m.id}`} className={cn("h-4 w-4 shrink-0", statusIcon(m.state))} />
        <span className="truncate text-[var(--color-fg)]">{m.name}</span>
        {!online && <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{stateLabel(m.state, t)}</span>}
        {online && waiting > 0 && <span className="flex items-center gap-0.5 px-1 text-[11px] tabular-nums text-[var(--color-warn)]"><Bell className="h-3 w-3" />{waiting}</span>}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        {!online && !off && (
          <Tip content={m.error ?? t("sidebar.reconnect")}>
            <button type="button" aria-label={t("sidebar.reconnect")} onClick={() => void remoteReconnect()} className={headerBtn}><RefreshCw className="h-3.5 w-3.5" /></button>
          </Tip>
        )}
        {/* No New task here: a server holds several projects, and New task
            belongs to the project row it starts in. */}
        <MachineSwitch m={m} />
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
      {!folded && !off && (
        <div className="flex flex-col gap-0.5">
          {projects.length === 0
            ? <div className="flex h-[var(--task-row-h)] items-center px-2 text-[12.5px] text-[var(--color-fg-faint)]">{t("sidebar.noServerProjects")}</div>
            : projects.map(renderProject)}
        </div>
      )}
    </div>
  );
});

/** The glyph a task's state draws, the desktop's own language
 *  (docs/agent-states.md): amber bell, spinner, blue dot, nothing. */
export function StateGlyph({ state, size = 13 }: { state: string; size?: number }) {
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

  const Icon = m.kind === "server" ? Server : Monitor;
  return (
    <div data-testid={`remote-machine-${m.id}`} data-state={m.state}>
      <MachineContextMenu m={m}>
      <div
        className={cn(
          "group flex h-8 select-none items-center justify-between rounded-md pl-1 pr-0.5 text-[13px] font-medium text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]",
          !online && "opacity-70",
        )}
      >
        <button
          type="button"
          onClick={() => toggle(m.id)}
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
          {online && drives && (
            <Tip content={t("sidebar.newTask", { name: m.name })}>
              <button
                type="button"
                data-testid={`remote-new-task-${m.id}`}
                aria-label={t("sidebar.newTask", { name: m.name })}
                onClick={() => void openNewTaskOnServer(m.id)}
                className="rounded p-1 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] group-hover:opacity-100"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </Tip>
          )}
          <MachineSwitch m={m} />
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
      {showRows && (
        <div className="mt-1 flex flex-col gap-0.5">
          {m.grant === "reply" && (
            <div className="px-3 text-[11.5px] text-[var(--color-fg-faint)]">{t("sidebar.replyOnly")}</div>
          )}
          {blocks.length === 0 && drives && (
            <div className="flex h-[var(--task-row-h)] items-center px-3 text-[12.5px] text-[var(--color-fg-faint)]">{t("sidebar.noTasks")}</div>
          )}
          {blocks.map(b => b.kind === "project"
            ? <RemoteProjectRows key={`p:${b.project.name}`} m={m} project={b.project} />
            : <RemoteFolder key={`f:${b.folder.id}`} m={m} folder={b.folder} projects={b.projects} />)}
        </div>
      )}
    </div>
  );
});

/** A project folder on the host: its name in the folder's colour, its
 *  projects under a guide line, as the local sidebar nests them. */
function RemoteFolder({ m, folder, projects }: { m: MachineView; folder: RemoteGroup; projects: RemoteProject[] }) {
  const color = accentCss(folder.color);
  return (
    <div data-testid={`remote-folder-${folder.id}`} data-color={folder.color ?? ""}>
      <div className="flex h-7 items-center gap-1.5 px-2 text-[12px] font-medium text-[var(--color-fg-dim)]" style={color ? { color } : undefined}>
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{folder.name}</span>
      </div>
      <div className="ml-3.5 border-l border-[var(--color-border-soft)] pl-1" style={color ? { borderColor: color } : undefined}>
        {projects.map(p => <RemoteProjectRows key={p.name} m={m} project={p} />)}
      </div>
    </div>
  );
}

function RemoteProjectRows({ m, project }: { m: MachineView; project: RemoteProject }) {
  const key = `project:${m.id}:${project.name}`;
  const folded = useRemote(s => !!s.folded[key]);
  const toggle = useRemote(s => s.toggleFold);
  return (
    <div data-testid={`remote-project-${project.name}`} data-folded={folded} className="[[data-testid^=remote-project-]+&]:mt-0.5">
      {/* The local project header: its band, type, chevron and padding, and
          it folds the same way (the fold is this computer's, per machine). */}
      <button type="button" aria-expanded={!folded} onClick={() => toggle(key)}
        className="group flex w-full select-none items-center gap-1.5 rounded-md bg-[var(--color-bg-2)]/50 py-1.5 pl-2 pr-0 text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]">
        {folded
          ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
          : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
        <span className="truncate">{project.name}</span>
      </button>
      {!folded && project.segments.map(seg => seg.kind === "task"
        ? <RemoteTaskRow key={seg.task.id} m={m} task={seg.task} />
        : (
          <RemoteGroupBlock key={`g:${seg.group.id}`} m={m} group={seg.group} tasks={seg.tasks} />
        ))}
    </div>
  );
}

/** A task group on a paired computer: the local block's caption in the
 *  group's colour and its members on a rail of it, folding open and shut
 *  like the local one (the fold is this computer's, keyed per machine). */
function RemoteGroupBlock({ m, group, tasks }: { m: MachineView; group: RemoteGroup; tasks: RemoteTask[] }) {
  const key = `group:${m.id}:${group.id}`;
  const folded = useRemote(s => !!s.folded[key]);
  const toggle = useRemote(s => s.toggleFold);
  return (
    <div data-testid={`remote-group-${group.id}`} data-color={group.color ?? ""} data-folded={folded}>
      <button type="button" aria-expanded={!folded} onClick={() => toggle(key)}
        className="ml-3 flex h-[var(--task-row-h)] w-[calc(100%-0.75rem)] select-none items-center gap-1 rounded-md px-1 text-left text-[13px] font-medium hover:bg-[var(--color-hover)]"
        style={{ color: groupColorCss(group) }}>
        {folded ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{group.name}</span>
        <span className="ml-auto shrink-0 pr-1 text-[11px] font-normal tabular-nums text-[var(--color-fg-faint)]">{tasks.length}</span>
      </button>
      {!folded && (
        <div className="ml-6 border-l" style={{ borderColor: groupColorCss(group) }}>
          <div className="-ml-[calc(var(--spacing)*1.5-1px)]">
            {tasks.map(task => <RemoteTaskRow key={task.id} m={m} task={task} />)}
          </div>
        </div>
      )}
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
  const openTask = useRemote(s => s.openTask);
  const [renaming, setRenaming] = useState<string | null>(null);
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
      onClick={() => openTask({ machine, task: task.id })}
      onKeyDown={e => { if (e.key === "Enter") openTask({ machine, task: task.id }); }}
      className={cn(
        "ml-3 flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors",
        below ? "min-h-[var(--task-row-h)] py-1" : "h-[var(--task-row-h)]",
        active ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
        // Greyed while its agent is not running, as a local or server task's
        // row is (the sidebar's `isLoaded`); every row read as started.
        (task.state === "inactive" || task.state === "unknown") && "opacity-60",
      )}
    >
      <span className={cn("shrink-0", CLI_BRAND_COLOR[icon])}><CliIcon cli={icon} className="h-4 w-4" /></span>
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
      <span className="flex w-4 shrink-0 justify-center"><StateGlyph state={task.state} /></span>
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
        {/* The local row's remaining items, run on that machine. */}
        {task.branch && task.branch !== "HEAD" && <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copyToClipboard(task.branch!, "branch")}>{t("sidebar:copyBranch")}</ContextMenuItem>
        </>}
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
