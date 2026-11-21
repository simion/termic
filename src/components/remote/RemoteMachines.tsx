// Other machines in the sidebar (docs/remote.md, "Paired computers in the
// sidebar"): one section per paired computer or server, below this
// computer's own projects, with its projects and tasks drawn like local
// ones. Clicking a task opens it in the main area (RemoteTaskView).
//
// Reads only the remote store's slice: a remote update never re-renders a
// local row, and a local change never re-renders these.

import { memo, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bell, ChevronDown, ChevronRight, Folder, MoreVertical, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Monitor, Pin, Plus, RefreshCw, Server } from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { Spinner } from "@/components/ui/Spinner";
import { Tip } from "@/components/ui/Tooltip";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { ACCENTS, accentCss } from "@/lib/accents";
import { ContextMenuContent, ContextMenuItem, ContextMenuRoot, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/ContextMenu";
import { useUI } from "@/store/ui";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
import type { Project } from "@/lib/types";
import { groupColorCss } from "@/lib/taskGroups";
import { prBadgeAppearance, type PrBadgeState } from "@/lib/prBadgeAppearance";
import { prNounShort, prRef } from "@/lib/forge";
import type { ForgeProvider } from "@/lib/types";
import { openPath } from "@/lib/ipc";
import { joinableGroups, layoutRemote, remoteCall, remoteProps, remoteReconnect, remoteTaskRequest, serverRemove, useRemote, type RemoteTaskAction, type MachineView, type RemoteGroup, type RemoteProject, type RemoteTask } from "@/lib/remote";

/** A top-level sidebar section header, styled as PROJECTS': a filled bar
 *  with the label, a fold, and its actions on the right. */
export function SidebarSectionHeader({ testId, icon, label, folded, onToggle, children }: { testId: string; icon: ReactNode; label: string; folded: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <div data-testid={testId} className="group mb-1.5 flex h-8 select-none items-center justify-between rounded-md bg-[var(--color-bg-2)] pl-1 pr-0.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-dim)]">
      <button type="button" onClick={onToggle} aria-expanded={!folded} className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left">
        {folded ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        {icon}
        {/* A button resets text-transform: the case goes on the label. */}
        <span className="truncate uppercase">{label}</span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5">{children}</div>
    </div>
  );
}

/** A machine's connection, as its icon's colour: green, amber, faded. */
const statusIcon = (state: string) =>
  state === "online" ? "text-[var(--color-ok)]" : state === "connecting" ? "text-[var(--color-warn)]" : "text-[var(--color-fg-faint)] opacity-60";

const headerBtn = "rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]";

/** SERVERS: each server a row (its state, New task, a menu to manage it)
 *  with its projects under it, drawn by the sidebar's own renderProject. */
export function ServersSection({ projects, renderProject }: { projects: Project[]; renderProject: (p: Project) => ReactNode }) {
  const { t } = useTranslation("remote");
  const all = useRemote(s => s.machines);
  const servers = useMemo(() => all.filter(m => m.kind === "server"), [all]);
  const folded = useRemote(s => !!s.folded["section:servers"]);
  const toggle = useRemote(s => s.toggleFold);
  if (servers.length === 0) return null;
  return (
    <div data-testid="servers-section" className="mt-3">
      <SidebarSectionHeader testId="servers-section-header" icon={<Server className="h-4 w-4 shrink-0" />} label={t("sidebar.serversHeader")}
        folded={folded} onToggle={() => toggle("section:servers")}>
        <Tip content={t("sidebar.addServer")}>
          <button type="button" data-testid="sidebar-add-server" aria-label={t("sidebar.addServer")} className={headerBtn}
            onClick={() => useRemote.getState().setDialog({ serverDialog: true })}><Plus className="h-3.5 w-3.5" /></button>
        </Tip>
      </SidebarSectionHeader>
      {!folded && (
        <div className="flex flex-col gap-1">
          {servers.map(m => <ServerBlock key={m.id} m={m} projects={projects.filter(p => p.server === m.id)} renderProject={renderProject} />)}
        </div>
      )}
    </div>
  );
}

function ServerMenuItems({ m, Item, Sep }: { m: MachineView; Item: (p: { onSelect: () => void; children: ReactNode; testId?: string; danger?: boolean }) => ReactNode; Sep: () => ReactNode }) {
  const { t } = useTranslation("remote");
  const setDialog = useRemote(s => s.setDialog);
  const openSettings = useApp(s => s.openSettings);
  const online = m.state === "online";
  const remove = async () => {
    const ok = await useUI.getState().askConfirm({ title: t("servers.removeTitle", { name: m.name }), message: t("servers.removeMessage", { name: m.name }), confirmLabel: t("servers.remove"), destructive: true });
    if (!(typeof ok === "boolean" ? ok : ok.confirmed)) return;
    await serverRemove(m.id).catch(e => useUI.getState().pushToast(String(e), "error"));
  };
  return (
    <>
      {online && <Item testId="server-menu-new-task" onSelect={() => setDialog({ newTaskOn: m.id })}>{t("sidebar.newTaskItem")}</Item>}
      {online && <Item testId="server-menu-add-project" onSelect={() => setDialog({ newTaskOn: m.id, newTaskAdding: true })}>{t("sidebar.addProject")}</Item>}
      {!online && <Item testId="server-menu-reconnect" onSelect={() => void remoteReconnect()}>{t("sidebar.reconnect")}</Item>}
      <Item testId="server-menu-settings" onSelect={() => openSettings("remote")}>{t("sidebar.serverSettings")}</Item>
      <Sep />
      <Item testId="server-menu-remove" danger onSelect={() => void remove()}>{t("sidebar.removeServer")}</Item>
    </>
  );
}

const ServerBlock = memo(function ServerBlock({ m, projects, renderProject }: { m: MachineView; projects: Project[]; renderProject: (p: Project) => ReactNode }) {
  const { t } = useTranslation("remote");
  const folded = useRemote(s => !!s.folded[m.id]);
  const toggle = useRemote(s => s.toggleFold);
  const setDialog = useRemote(s => s.setDialog);
  const online = m.state === "online";
  const waiting = m.tasks.filter(x => x.state === "waiting").length;
  const header = (
    <div data-testid={`server-block-${m.id}`} data-state={m.state}
      className={cn("group flex h-8 select-none items-center justify-between rounded-md pl-1 pr-0.5 text-[13px] font-medium text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]", !online && "opacity-70")}>
      <button type="button" onClick={() => toggle(m.id)} aria-expanded={!folded} className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left">
        {folded ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        <Server data-testid={`server-icon-${m.id}`} className={cn("h-4 w-4 shrink-0", statusIcon(m.state))} />
        <span className="truncate text-[var(--color-fg)]">{m.name}</span>
        {!online && <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{m.state === "connecting" ? t("sidebar.connecting") : t("sidebar.offline")}</span>}
        {online && waiting > 0 && <span className="flex items-center gap-0.5 px-1 text-[11px] tabular-nums text-[var(--color-warn)]"><Bell className="h-3 w-3" />{waiting}</span>}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        {!online && (
          <Tip content={m.error ?? t("sidebar.reconnect")}>
            <button type="button" aria-label={t("sidebar.reconnect")} onClick={() => void remoteReconnect()} className={headerBtn}><RefreshCw className="h-3.5 w-3.5" /></button>
          </Tip>
        )}
        {online && (
          <Tip content={t("sidebar.newTask", { name: m.name })}>
            <button type="button" data-testid={`server-new-task-${m.id}`} aria-label={t("sidebar.newTask", { name: m.name })} onClick={() => setDialog({ newTaskOn: m.id })} className={headerBtn}><Plus className="h-3.5 w-3.5" /></button>
          </Tip>
        )}
        <DropdownRoot>
          <DropdownTrigger asChild>
            <button type="button" data-testid={`server-menu-${m.id}`} aria-label={t("sidebar.serverSettings")} className={headerBtn}><MoreVertical className="h-3.5 w-3.5" /></button>
          </DropdownTrigger>
          <DropdownMenu>
            <ServerMenuItems m={m} Sep={() => <DropdownSeparator />}
              Item={({ onSelect, children, testId, danger }) => <DropdownItem onSelect={onSelect} data-testid={testId} className={danger ? "text-[var(--color-err)]" : undefined}>{children}</DropdownItem>} />
          </DropdownMenu>
        </DropdownRoot>
      </div>
    </div>
  );
  return (
    <div>
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
        <ContextMenuContent>
          <ServerMenuItems m={m} Sep={() => <ContextMenuSeparator />}
            Item={({ onSelect, children, danger }) => <ContextMenuItem onSelect={onSelect} destructive={danger}>{children}</ContextMenuItem>} />
        </ContextMenuContent>
      </ContextMenuRoot>
      {!online && !folded && m.error && (
        <div className="mx-2 mt-0.5 text-[11.5px] text-[var(--color-fg-faint)]">{m.error}</div>
      )}
      {!folded && (
        <div className="flex flex-col gap-0.5">
          {projects.length === 0
            ? <div className="flex h-[var(--task-row-h)] items-center px-2 text-[12.5px] text-[var(--color-fg-faint)]">{t("sidebar.noServerProjects")}</div>
            : projects.map(renderProject)}
        </div>
      )}
    </div>
  );
});

/** PAIRED COMPUTERS: other Termic apps paired with this one (docs/peers.md),
 *  each drawn from what it reports. */
export function RemoteMachines() {
  const { t } = useTranslation("remote");
  const all = useRemote(s => s.machines);
  const machines = useMemo(() => all.filter(m => m.kind !== "server"), [all]);
  const folded = useRemote(s => !!s.folded["section:paired"]);
  const toggle = useRemote(s => s.toggleFold);
  const openSettings = useApp(s => s.openSettings);
  if (machines.length === 0) return null;
  return (
    <div data-testid="remote-machines" className="mt-3">
      <SidebarSectionHeader testId="paired-section-header" icon={<Monitor className="h-4 w-4 shrink-0" />} label={t("sidebar.pairedHeader")}
        folded={folded} onToggle={() => toggle("section:paired")}>
        <Tip content={t("sidebar.pairComputer")}>
          <button type="button" data-testid="sidebar-pair-computer" aria-label={t("sidebar.pairComputer")} className={headerBtn}
            onClick={() => openSettings("peers")}><Plus className="h-3.5 w-3.5" /></button>
        </Tip>
      </SidebarSectionHeader>
      {!folded && <div className="flex flex-col gap-2">{machines.map(m => <MachineSection key={m.id} m={m} />)}</div>}
    </div>
  );
}

/** The glyph a task's state draws, the desktop's own language
 *  (docs/agent-states.md): amber bell, spinner, blue dot, nothing. */
export function StateGlyph({ state, size = 13 }: { state: string; size?: number }) {
  if (state === "waiting") return <Bell className="shrink-0 text-[var(--color-warn)]" style={{ width: size, height: size }} />;
  if (state === "working") return <Spinner size={size - 1} />;
  if (state === "done") return <span className="block h-2 w-2 shrink-0 rounded-full bg-[var(--color-info)]" />;
  return null;
}

const MachineSection = memo(function MachineSection({ m }: { m: MachineView }) {
  const { t } = useTranslation("remote");
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
              {m.state === "connecting" ? t("sidebar.connecting") : t("sidebar.offline")}
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
          {!online && (
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
                onClick={() => setDialog({ newTaskOn: m.id })}
                className="rounded p-1 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] group-hover:opacity-100"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </Tip>
          )}
        </div>
      </div>
      {!online && !folded && m.error && (
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
  return (
    <div data-testid={`remote-project-${project.name}`}>
      <div className="flex h-7 items-center px-2 text-[12px] font-medium text-[var(--color-fg-dim)]">{project.name}</div>
      {project.segments.map(seg => seg.kind === "task"
        ? <RemoteTaskRow key={seg.task.id} m={m} task={seg.task} />
        : (
          // The local TaskGroupBlock's look, read-only: the caption in the
          // group's colour, the members on a rail of it.
          <div key={`g:${seg.group.id}`} data-testid={`remote-group-${seg.group.id}`} data-color={seg.group.color ?? ""}>
            <div className="ml-3 flex h-[var(--task-row-h)] select-none items-center gap-1 px-1 text-[13px] font-medium" style={{ color: groupColorCss(seg.group) }}>
              <span className="mx-0.5 block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: groupColorCss(seg.group) }} />
              <span className="truncate">{seg.group.name}</span>
              <span className="ml-auto shrink-0 pr-1 text-[11px] font-normal tabular-nums text-[var(--color-fg-faint)]">{seg.tasks.length}</span>
            </div>
            <div className="ml-6 border-l" style={{ borderColor: groupColorCss(seg.group) }}>
              <div className="-ml-[calc(var(--spacing)*1.5-1px)]">
                {seg.tasks.map(task => <RemoteTaskRow key={task.id} m={m} task={task} />)}
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}

/** The task's PR as the host last read it: the local badge's icon and
 *  colour rules (prBadgeAppearance), without its live checks. */
function RemotePrBadge({ task }: { task: RemoteTask }) {
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
        <Icon className="h-3 w-3" />
        <span className={cn("text-[11px] tabular-nums leading-none", struck && "tc-pr-struck")}>{prRef(provider, pr.number)}</span>
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
        "ml-3 flex h-[var(--task-row-h)] cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors",
        active ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
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
      ) : (
        <span className="min-w-0 truncate font-medium">{task.name}</span>
      )}
      {/* Tab labels after the name, as the local row draws them. */}
      {props && <span data-testid="remote-task-props" className="min-w-0 shrink-[3] truncate text-[11px] text-[var(--color-fg-dim)]">{props}</span>}
      <span className="flex-1" />
      {task.pinned && <Pin data-testid="remote-task-pinned" aria-hidden className="h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />}
      <RemotePrBadge task={task} />
      {task.diff && (task.diff.insertions > 0 || task.diff.deletions > 0) && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-[var(--color-ok)]/80">+{task.diff.insertions}</span>{" "}
          <span className="text-[var(--color-err)]/80">-{task.diff.deletions}</span>
        </span>
      )}
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
      </ContextMenuContent>
    </ContextMenuRoot>
  );
});
