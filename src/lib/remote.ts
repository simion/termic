// Remote control, the desktop's half (docs/remote.md): phones paired with
// this computer, other machines this computer is connected to (paired
// computers and SSH servers), and their tasks.
//
// The Rust side (remote_client.rs) sends the machine list on
// `remote://machines` only when it changed. The store below keeps it in
// its own slice, apart from the app store, so a remote update never
// re-renders a local task row (docs/performance.md bear trap 8: and the
// list is compared before it is written, so an unchanged one is no write
// at all).

import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useEffect, useState } from "react";

// ───────────────────────── wire types (termic-remote) ─────────────────

export type RemoteState = "working" | "waiting" | "done" | "idle" | "inactive" | "unknown";

export interface RemoteQuestionOption {
  label: string;
  /** base64 keystrokes that pick it. */
  keys: string;
  selected: boolean;
}

export interface RemoteQuestion {
  id: string;
  kind: "command" | "edit" | "fetch" | "menu" | string;
  title: string;
  body: string;
  options: RemoteQuestionOption[];
}

export interface RemoteTab {
  id: string;
  title: string;
  agent: string;
  state: string;
  is_default: boolean;
  /** "agent" | "shell" | "terminal" | "run"; absent (an older host) = agent. */
  kind?: string;
  /** A PTY runs in it; absent (an older host) = openable. */
  live?: boolean;
  /** false: the host cannot stream it (a shell, a custom terminal). */
  viewable?: boolean;
  /** What the tab's agent labelled it with (`termic prop`). */
  props?: { key: string; value: string }[];
}

/** A task group or a project folder. `color` is an accent KEY (accents.ts). */
export interface RemoteGroup {
  id: string;
  name: string;
  color?: string;
}

export interface RemotePr {
  number: number;
  state?: string;
  title?: string;
  url?: string;
  provider?: string;
}

export interface RemoteTask {
  id: string;
  name: string;
  project: string;
  agent: string;
  branch?: string;
  state: RemoteState | string;
  tabs: RemoteTab[];
  diff?: { files_changed: number; insertions: number; deletions: number };
  created?: string;
  is_main_checkout: boolean;
  since_ms?: number;
  activity?: string;
  question?: RemoteQuestion;
  // How the host's sidebar files and marks it (absent from older hosts).
  group?: RemoteGroup;
  project_group?: RemoteGroup;
  pinned?: boolean;
  project_order?: number;
  order?: number;
  pr?: RemotePr;
}

export interface MachineView {
  id: string;
  kind: "computer" | "server";
  name: string;
  state: "connecting" | "online" | "offline" | "disconnected";
  /** The window label of the profile it belongs to ("main" for the root). */
  profile?: string;
  error: string | null;
  version: string | null;
  grant: "drive" | "reply" | null;
  caps: string[];
  tasks: RemoteTask[];
  ssh: string | null;
  /** A newer termic-server, installed and waiting for a restart
   *  (remote_client::auto_upgrade). */
  update?: string | null;
  /** That update is one this desktop needs: the server restarts onto it by
   *  itself once no agent is mid-turn. Otherwise Restart now is optional. */
  update_required?: boolean;
}

export interface ServerRecord {
  id: string;
  name: string;
  ssh: string;
  command: string | null;
  added_at_ms: number;
}

/** What the open remote terminal sends (Tauri channel). */
export type TermEvent =
  | { t: "term_reset"; task: string; tab?: string; cols: number; rows: number; data: string }
  | { t: "term_data"; data: string }
  | { t: "term_resize"; cols: number; rows: number }
  | { t: "term_closed"; reason: string };

/** Phones paired with this computer (peer_status.phones). */
export interface PhoneView {
  id: string;
  name: string;
  paired_at_ms: number;
  last_seen_ms: number | null;
  connected: boolean;
}

/** The QR code on offer (peer_status.phone_pairing). */
export interface PhonePairingView {
  link: string;
  svg: string;
  expires_at_ms: number;
  addresses: string[];
}

// ───────────────────────── ipc ────────────────────────────────────────

export const REMOTE_MACHINES_EVENT = "remote://machines";
export const PHONE_PAIRED_EVENT = "peer://phone-paired";

export const remoteMachines = () => invoke<MachineView[]>("remote_machines");
/** Run a termic-proto Request on a machine. Resolves to its Reply. */
export const remoteCall = (machine: string, request: Record<string, unknown>, timeoutMs?: number) =>
  invoke<{ ok: boolean; data?: any; error?: { code: string; message: string } }>("remote_call", { machine, request, timeoutMs });
export function remoteTermOpen(machine: string, task: string, tab: string | null, onEvent: (e: TermEvent) => void) {
  const ch = new Channel<TermEvent>();
  ch.onmessage = onEvent;
  return invoke<void>("remote_term_open", { machine, task, tab, onEvent: ch });
}
export const remoteTermClose = (machine: string) => invoke<void>("remote_term_close", { machine });
export const remoteTermInput = (machine: string, data: string) => invoke<void>("remote_term_input", { machine, data });
/** Size the open terminal's PTY. Only a host offering `resize` (a server)
 *  is sent it; for any other this is a no-op (see remote_client.rs). */
export const remoteTermSize = (machine: string, cols: number, rows: number) => invoke<void>("remote_term_size", { machine, cols, rows });
export const remoteReconnect = () => invoke<void>("remote_reconnect");
/** Switch a server's or paired computer's connection on or off (kept across restarts). */
export const remoteSetConnected = (machine: string, on: boolean) => invoke<void>("remote_set_connected", { machine, on });

export const serverAdd = (ssh: string, name: string) => invoke<ServerRecord>("server_add", { ssh, name });
export const serverRemove = (id: string) => invoke<void>("server_remove", { id });
export const serverRename = (id: string, name: string) => invoke<void>("server_rename", { id, name });

/** What the Add a server checklist learned (remote_client.rs `Probe`). */
export interface ServerProbe {
  reached: boolean;
  error: string | null;
  host_key: "ok" | "unknown" | "changed" | "unchecked";
  fingerprint: string | null;
  system: string | null;
  installed: string | null;
  details: string;
  millis: number;
}
export const serverProbe = (ssh: string) => invoke<ServerProbe>("server_probe", { ssh });
/** `fingerprint`: the one the user was shown; another key is refused. */
export const serverTrust = (ssh: string, fingerprint?: string | null) => invoke<ServerProbe>("server_trust", { ssh, fingerprint: fingerprint ?? null });
/** Upload termic-server over ssh; resolves to the installed version. */
export const serverInstall = (ssh: string) => invoke<string>("server_install", { ssh });

export const phonePairStart = () => invoke<PhonePairingView>("phone_pair_start");
export const phonePairCancel = () => invoke<void>("phone_pair_cancel");
export const phoneUnpair = (id: string) => invoke<void>("phone_unpair", { id });
export const phoneRename = (id: string, name: string) => invoke<void>("phone_rename", { id, name });

// ───────────────────────── helpers ────────────────────────────────────

export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decodeBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A Request as termic-proto spells it: `cmd` tag plus the verb's fields. */
export function req(cmd: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "", cmd, ...fields };
}

/** xterm answers some queries itself (device attributes, cursor position,
 *  focus reports, OSC colour queries). Those are not keystrokes. */
export function isTerminalReply(data: string): boolean {
  return /^\x1b\[[?>]?[\d;]*[cRn]$/.test(data)
    || /^\x1b\[[IO]$/.test(data)
    || /^\x1b\][\d;]+;[^\x07\x1b]*(\x07|\x1b\\)$/.test(data)
    || /^\x1bP[\s\S]*\x1b\\$/.test(data);
}

/** Which kind of network an address is on, for the reachability list. */
export function addressKind(addr: string): "lan" | "tailscale" | "other" {
  const ip = addr.replace(/:\d+$/, "");
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a === 127) return "lan";
  if (a === 100 && b >= 64 && b < 128) return "tailscale";
  return "other";
}

/** "4:52" */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A task name from a prompt: its first words, as a branch-safe slug. */
export function nameFromPrompt(prompt: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 5);
  return words.join("-").slice(0, 40).replace(/-+$/, "") || "task";
}

/** Same machine list? Compared by value, so an identical push is no write. */
function sameList(a: MachineView[], b: MachineView[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ───────────────────────── alerts ─────────────────────────────────────

/** Something on another machine worth a desktop notification. */
export interface RemoteAlert {
  machine: string;
  machineName: string;
  task: string;
  taskName: string;
  project: string;
  kind: "waiting" | "done";
  /** The question it is asking, when its screen could be read. */
  question?: string;
}

/** What moved between two machine lists that a person should hear about,
 *  as a local tab's needs-you and done do: a task that started waiting, or
 *  finished working. Only for tasks already known on a machine that is
 *  online in both lists, so the first snapshot, a new task and a reconnect
 *  each say nothing about tasks that were already in that state. */
export function remoteAlerts(prev: MachineView[], next: MachineView[]): RemoteAlert[] {
  const out: RemoteAlert[] = [];
  for (const m of next) {
    const was = prev.find(p => p.id === m.id);
    if (!was || was.state !== "online" || m.state !== "online") continue;
    for (const t of m.tasks) {
      const before = was.tasks.find(x => x.id === t.id);
      if (!before || before.state === t.state) continue;
      const kind = t.state === "waiting" ? "waiting" : t.state === "done" && before.state === "working" ? "done" : null;
      if (!kind) continue;
      out.push({ machine: m.id, machineName: m.name, task: t.id, taskName: t.name, project: t.project, kind, question: kind === "waiting" ? t.question?.title : undefined });
    }
  }
  return out;
}

const ALERT_DEBOUNCE_MS = 8000;
const lastAlerted = new Map<string, number>();

/** Ring the desktop for alerts, with the local notifier's rules: the
 *  Desktop notifications pref, never for the task the person is looking at
 *  in a focused window, and one per task per few seconds. */
function ring(alerts: RemoteAlert[]) {
  void Promise.all([import("@/store/prefs"), import("@/lib/ipc"), import("@/lib/i18n")]).then(([{ usePrefs }, { notify }, { i18n }]) => {
    if (!usePrefs.getState().desktopNotifications) return;
    const open = useRemote.getState().open;
    for (const a of alerts) {
      if (open?.machine === a.machine && open?.task === a.task && document.hasFocus()) continue;
      const key = `${a.machine}:${a.task}:${a.kind}`;
      const now = Date.now();
      if ((lastAlerted.get(key) ?? 0) + ALERT_DEBOUNCE_MS > now) continue;
      lastAlerted.set(key, now);
      const title = `${a.machineName} · ${a.project} · ${a.taskName}`;
      const body = a.kind === "waiting" ? (a.question || i18n.t("remote:alert.waiting")) : i18n.t("remote:alert.done");
      notify(title, body, undefined, { sound: a.kind === "done" }).catch(() => {});
    }
  });
}

// ───────────────────────── store ──────────────────────────────────────

export interface OpenRemote {
  machine: string;
  task: string;
}

interface RemoteStore {
  machines: MachineView[];
  /** The Connect a phone dialog is up. */
  phoneDialog: boolean;
  /** The Add a server dialog is up. */
  serverDialog: boolean;
  /** The machine whose New task dialog is up. */
  newTaskOn: string | null;
  /** The project New task opens with (a server project's own +). */
  newTaskProject: string | null;
  /** The branch the new task starts from (Duplicate on a server task). */
  newTaskBase: string | null;
  /** New task opens on its Add project field (a server's Add project). */
  newTaskAdding: boolean;
  setDialog(d: Partial<Pick<RemoteStore, "phoneDialog" | "serverDialog" | "newTaskOn" | "newTaskProject" | "newTaskBase" | "newTaskAdding">>): void;
  /** The remote task shown in the main area, or null. */
  open: OpenRemote | null;
  /** Machines whose sidebar section is folded. */
  folded: Record<string, boolean>;
  setMachines(list: MachineView[]): void;
  /** The last alerts raised from machine updates, newest last (kept short:
   *  what a test or a later "recent" view reads; the notification is sent
   *  as each is raised). */
  alerts: RemoteAlert[];
  openTask(o: OpenRemote | null): void;
  toggleFold(id: string): void;
}

const LS_REMOTE_FOLDED = "termic.remoteFolded";

function loadFolds(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(LS_REMOTE_FOLDED) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export const useRemote = create<RemoteStore>((set, get) => ({
  machines: [],
  phoneDialog: false,
  serverDialog: false,
  newTaskOn: null,
  newTaskProject: null,
  newTaskBase: null,
  newTaskAdding: false,
  setDialog(d) { set(d); },
  open: null,
  folded: loadFolds(),
  alerts: [],
  setMachines(list) {
    if (sameList(get().machines, list)) return;
    const raised = remoteAlerts(get().machines, list);
    if (raised.length === 0) {
      set({ machines: list });
      return;
    }
    set({ machines: list, alerts: [...get().alerts, ...raised].slice(-20) });
    ring(raised);
  },
  openTask(o) {
    const cur = get().open;
    if (cur?.machine === o?.machine && cur?.task === o?.task) return;
    set({ open: o });
  },
  toggleFold(id) {
    const folded = { ...get().folded, [id]: !get().folded[id] };
    try { localStorage.setItem(LS_REMOTE_FOLDED, JSON.stringify(folded)); } catch { /* per-viewer convenience */ }
    set({ folded });
  },
}));

let started = false;

/** Subscribe the store to the backend once, at app start. */
export function startRemote() {
  if (started) return;
  started = true;
  remoteMachines().then(l => useRemote.getState().setMachines(l)).catch(() => {});
  // Project folder colours live in the webview (localStorage), so the
  // rows this computer serves get them from here: once, then on change.
  void import("@/store/app").then(({ useApp }) => {
    const push = (colors: Record<string, string>) => { void invoke("remote_set_folder_colors", { colors }).catch(() => {}); };
    push(useApp.getState().groupColors);
    // And what this window's sidebar has folded, so a phone opens the same.
    const on = (m: Record<string, boolean>) => Object.keys(m).filter(k => m[k]);
    const pushFolds = (s: ReturnType<typeof useApp.getState>) => {
      void invoke("remote_set_sidebar_folds", { folds: { projects: on(s.collapsedProjects), folders: on(s.collapsedGroups), taskGroups: on(s.collapsedTaskGroups) } }).catch(() => {});
    };
    pushFolds(useApp.getState());
    useApp.subscribe((s, prev) => {
      if (s.groupColors !== prev.groupColors) push(s.groupColors);
      if (s.collapsedProjects !== prev.collapsedProjects || s.collapsedGroups !== prev.collapsedGroups || s.collapsedTaskGroups !== prev.collapsedTaskGroups) pushFolds(s);
    });
  });
  void listen<MachineView[]>(REMOTE_MACHINES_EVENT, e => useRemote.getState().setMachines(e.payload)).catch(() => {});
}

/** One machine's view, or undefined. */
export function useMachine(id: string | undefined) {
  return useRemote(s => (id ? s.machines.find(m => m.id === id) : undefined));
}

// ───────────────────────── sidebar layout ─────────────────────────────

export type RemoteSegment =
  | { kind: "task"; task: RemoteTask }
  | { kind: "group"; group: RemoteGroup; tasks: RemoteTask[] };
export interface RemoteProject { name: string; segments: RemoteSegment[] }
export type RemoteBlock =
  | { kind: "project"; project: RemoteProject }
  | { kind: "folder"; folder: RemoteGroup; projects: RemoteProject[] };

/** A machine's tasks laid out as its own sidebar draws them: projects in the
 *  host's order, those sharing a folder gathered under it at the first one's
 *  place, and inside a project each task group gathered into one block at
 *  its first member's place (lib/taskGroups.ts `layoutTaskList`). A host
 *  that sends no order (older, or termic-server) falls back to names. */
export function layoutRemote(tasks: RemoteTask[]): RemoteBlock[] {
  const rank = (t: RemoteTask) => [t.project_order ?? Number.MAX_SAFE_INTEGER, t.order ?? Number.MAX_SAFE_INTEGER] as const;
  const sorted = [...tasks].sort((a, b) => {
    const [pa, oa] = rank(a), [pb, ob] = rank(b);
    return pa - pb || a.project.localeCompare(b.project) || oa - ob || a.name.localeCompare(b.name);
  });
  const projects: RemoteProject[] = [];
  const folderOf = new Map<string, RemoteGroup | undefined>();
  for (const t of sorted) {
    let p = projects.find(x => x.name === t.project);
    if (!p) { p = { name: t.project, segments: [] }; projects.push(p); folderOf.set(t.project, t.project_group); }
    const g = t.group;
    if (!g) { p.segments.push({ kind: "task", task: t }); continue; }
    const seg = p.segments.find((x): x is Extract<RemoteSegment, { kind: "group" }> => x.kind === "group" && x.group.id === g.id);
    if (seg) seg.tasks.push(t);
    else p.segments.push({ kind: "group", group: g, tasks: [t] });
  }
  const out: RemoteBlock[] = [];
  for (const p of projects) {
    const f = folderOf.get(p.name);
    if (!f) { out.push({ kind: "project", project: p }); continue; }
    const block = out.find((b): b is Extract<RemoteBlock, { kind: "folder" }> => b.kind === "folder" && b.folder.id === f.id);
    if (block) block.projects.push(p);
    else out.push({ kind: "folder", folder: f, projects: [p] });
  }
  return out;
}

// ───────────────────────── task actions ───────────────────────────────

/** What a remote client may do to a task from its menu, as the host's own
 *  verbs (termic rename / pin / group), so the host applies them exactly as
 *  its sidebar would. The task is named by id: unique on that machine. */
export type RemoteTaskAction =
  | { kind: "rename"; name: string }
  | { kind: "pin"; pinned: boolean }
  | { kind: "join"; lead: string }
  | { kind: "newGroup"; color: string }
  | { kind: "leave" };

export function remoteTaskRequest(taskId: string, a: RemoteTaskAction): Record<string, unknown> {
  switch (a.kind) {
    case "rename": return req("rename", { task: taskId, name: a.name.trim() });
    case "pin": return req("pin", { task: taskId, pinned: a.pinned });
    case "join": return req("group", { task: taskId, join: a.lead });
    // Colouring a task in no group founds a group of one around it.
    case "newGroup": return req("group", { task: taskId, color: a.color });
    case "leave": return req("group", { task: taskId, leave: true });
  }
}

/** The groups a task could move into: the other groups in its project on
 *  that machine (a group never spans projects), each once. */
export function joinableGroups(tasks: RemoteTask[], task: RemoteTask): RemoteGroup[] {
  const out: RemoteGroup[] = [];
  for (const t of tasks) {
    if (t.project !== task.project || !t.group || t.group.id === task.group?.id) continue;
    if (!out.some(g => g.id === t.group!.id)) out.push(t.group);
  }
  return out;
}

/** A task's tab labels, collected like the local row's: each key once, in
 *  the order first seen, its distinct values joined. */
export function remoteProps(task: RemoteTask): string {
  const values = new Map<string, string[]>();
  for (const tab of task.tabs) {
    for (const p of tab.props ?? []) {
      const list = values.get(p.key) ?? [];
      if (!list.includes(p.value)) list.push(p.value);
      values.set(p.key, list);
    }
  }
  return [...values.values()].map(v => v.join(", ")).join(" · ");
}

/** Sections in the order a person scans them: what needs them first. */
export const STATE_ORDER: Record<string, number> = { waiting: 0, working: 1, done: 2, idle: 3, inactive: 4, unknown: 5 };

/** Which of the desktop's agents a server project's box can run, in the
 *  shape `detectedClis` has locally, so the same visibility rules apply
 *  (visibleCliIds). The registry is the desktop's; the box only answers
 *  `which` for each command (server_which, the TaskHost `which`). Empty
 *  until asked, and for a local project. Cached per project for the run. */
const serverClis = new Map<string, Record<string, import("@/lib/types").CliInfo>>();
export function useServerDetectedClis(projectId: string | undefined, isServer: boolean, agents: import("@/lib/types").Agent[], enabled = true): Record<string, import("@/lib/types").CliInfo> {
  const [map, setMap] = useState<Record<string, import("@/lib/types").CliInfo>>(() => (projectId && serverClis.get(projectId)) || {});
  useEffect(() => {
    if (!projectId || !isServer || !enabled) return;
    const cached = serverClis.get(projectId);
    if (cached) { setMap(cached); return; }
    const entries = agents.filter(a => a.command);
    let live = true;
    invoke<boolean[]>("server_which", { projectId, programs: entries.map(a => a.command) })
      .then(found => {
        const next: Record<string, import("@/lib/types").CliInfo> = {};
        entries.forEach((a, i) => { next[a.id] = { name: a.id, found: !!found[i], path: "", version: "" }; });
        serverClis.set(projectId, next);
        if (live) setMap(next);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [projectId, isServer, enabled, agents]);
  return isServer ? map : {};
}

/** New task on a server: the ordinary New task dialog for one of its
 *  projects (the named one, else the first), which creates the task with
 *  the desktop's own code on the box (task_host). With no project there
 *  yet, the server's Add project dialog, which then opens it. */
export async function openNewTaskOnServer(serverId: string, projectName?: string | null, baseBranch?: string | null): Promise<void> {
  const { useApp } = await import("@/store/app");
  const { useUI } = await import("@/store/ui");
  const mine = useApp.getState().projects.filter(p => p.server === serverId);
  const p = (projectName && mine.find(x => x.name === projectName)) || mine[0];
  if (!p) {
    useRemote.getState().setDialog({ newTaskOn: serverId, newTaskAdding: true });
    return;
  }
  requestAnimationFrame(() => useUI.getState().openNewTask(p.id, baseBranch ? { baseBranch } : undefined));
}
