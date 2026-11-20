// A task on another machine, open in the main area (docs/remote.md): its
// terminal, like a local tab, under one header that says where it runs.
// The phone's extras (a question card, the transcript, a composer) are not
// here on purpose: they stand in for a keyboard, and a desktop has one.
//
// The terminal is this app's xterm drawing the remote PTY; keys typed here
// go there. Its size: a server's PTY has no screen of its own, so it
// follows this pane (`resize` in the welcome); another computer's is sized
// by that computer's window, and this draws at that size.
// xterm's own answers to terminal queries are never forwarded: the agent
// already has a terminal answering those, and a duplicate answer arrives as
// typed garbage.

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Archive, Monitor, Play, Plus, Server, SquareTerminal, X } from "lucide-react";
import { AuxTerminal } from "@/components/task/AuxTerminal";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { Button } from "@/components/ui/Button";
import { useUI } from "@/store/ui";
import { usePrefs, currentTerminalStack, currentTerminalTheme } from "@/store/prefs";
import { cn } from "@/lib/utils";
import {
  b64decodeBytes, b64encode, remoteCall, remoteTermClose, remoteTermOpen, remoteTermInput, remoteTermSize,
  req, useMachine, useRemote, isTerminalReply, type RemoteTask, type TermEvent,
} from "@/lib/remote";
import { StateGlyph } from "./RemoteMachines";


const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", opencode: "opencode", cursor: "Cursor" };
export const agentName = (id: string) => AGENT_NAMES[id] ?? id;

export function RemoteTaskOverlay() {
  const open = useRemote(s => s.open);
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-20 bg-[var(--color-bg)]">
      <RemoteTaskView key={`${open.machine}:${open.task}`} machineId={open.machine} taskId={open.task} />
    </div>
  );
}

/** A server task's open shell tabs and which tab shows, by task id: kept
 *  here so they outlive switching to another task (MainArea keeps the view
 *  mounted, hidden, while it has shells). */
export const useServerShells = create<{
  shells: Record<string, string[]>;
  view: Record<string, string>;
  /** A shell started to run something (Run): its tab label and the line it types. */
  meta: Record<string, { label?: string; input?: string }>;
  add: (task: string, meta?: { label?: string; input?: string }) => void;
  close: (task: string, id: string) => void;
  show: (task: string, id: string) => void;
}>((set) => ({
  shells: {},
  view: {},
  meta: {},
  add: (task, meta) => set(s => {
    const id = `shell-${Date.now()}`;
    return {
      shells: { ...s.shells, [task]: [...(s.shells[task] ?? []), id] },
      view: { ...s.view, [task]: id },
      meta: meta ? { ...s.meta, [id]: meta } : s.meta,
    };
  }),
  close: (task, id) => set(s => ({
    shells: { ...s.shells, [task]: (s.shells[task] ?? []).filter(x => x !== id) },
    view: s.view[task] === id ? { ...s.view, [task]: "agent" } : s.view,
  })),
  show: (task, id) => set(s => (s.view[task] === id ? s : { view: { ...s.view, [task]: id } })),
}));

const NO_SHELLS: string[] = [];

/** `taskPath`: a server project's task (its worktree on the box). Its view
 *  gets shell tabs beside the agent: each is an AuxTerminal, whose PTY
 *  runs on the box (termic-server pty_open via lib.rs `pty_spawn`). */
export function RemoteTaskView({ machineId, taskId, taskPath, active = true }: { machineId: string; taskId: string; taskPath?: string; active?: boolean }) {
  const { t } = useTranslation("remote");
  const machine = useMachine(machineId);
  const task = machine?.tasks.find(x => x.id === taskId);
  const openTask = useRemote(s => s.openTask);
  const close = () => openTask(null);
  const online = machine?.state === "online";
  // The tab whose terminal is open: picked in the strip, else the task's
  // default agent tab (null asks the host for that one).
  const [picked, setPicked] = useState<string | null>(null);
  const shells = useServerShells(s => s.shells[taskId] ?? NO_SHELLS);
  const view = useServerShells(s => s.view[taskId] ?? "agent");
  const meta = useServerShells(s => s.meta);
  const setView = (id: string) => useServerShells.getState().show(taskId, id);

  if (!machine) {
    return <Gone message={t("task.gone", { machine: "" })} onClose={close} />;
  }
  if (!task) {
    return online
      ? <Gone message={t("task.gone", { machine: machine.name })} onClose={close} />
      : <Gone message={t("task.offline", { machine: machine.name })} onClose={close} />;
  }
  const MIcon = machine.kind === "server" ? Server : Monitor;
  const icon = resolveIconId(task.agent, []);
  const tabs = task.tabs ?? [];
  const tabId = (picked && tabs.some(x => x.id === picked) ? picked : null) ?? tabs.find(x => x.is_default)?.id ?? null;

  return (
    <div data-testid="remote-task-view" data-task={task.id} className="flex h-full min-h-0 flex-col">
      {/* The task, and where it runs: the one thing a remote view must never
          leave out, so nobody types into the wrong computer. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[icon])}><CliIcon cli={icon} className="h-4 w-4" /></span>
        <span className="truncate text-[14px] font-medium text-[var(--color-fg)]">{task.name}</span>
        <StateGlyph state={task.state} />
        <span className="shrink-0 text-[12px] text-[var(--color-fg-faint)]">{t(`states.${task.state}`, { defaultValue: task.state })}</span>
        <span className="mx-1 h-4 w-px shrink-0 bg-[var(--color-border-soft)]" />
        <MIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
        <span data-testid="remote-task-location" className="shrink-0 text-[12.5px] text-[var(--color-fg-dim)]">{t("task.on", { machine: machine.name })}</span>
        <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-[var(--color-ok)]" : "bg-[var(--color-fg-faint)]")} />
        <span className="truncate text-[12.5px] text-[var(--color-fg-faint)]">{task.project}{task.branch ? ` · ${task.branch}` : ""}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" data-testid="remote-task-archive" disabled={!online} onClick={() => void archive(machine.name, machineId, task, close, t)}>
            <Archive className="h-3.5 w-3.5" />
            {t("task.archive")}
          </Button>
          <button type="button" aria-label={t("task.close")} data-testid="remote-task-close" onClick={close} className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* The task's tabs, as its own strip lists them: another agent, a
          shell, the run output. Only when there is a choice. */}
      {tabs.length > 1 && (
        <div role="tablist" data-testid="remote-tabs" className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-border-soft)] px-2">
          {tabs.map(tab => {
            const kind = tab.kind || "agent";
            const TabIcon = kind === "run" ? Play : kind === "agent" ? null : SquareTerminal;
            const ti = resolveIconId(tab.agent, []);
            const dead = tab.live === false;
            const local = tab.viewable === false;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === tabId}
                data-testid={`remote-tab-${tab.id}`}
                data-kind={kind}
                disabled={dead || local}
                data-viewable={local ? "false" : undefined}
                title={local ? t("task.tabLocalOnly") : dead ? t("task.tabNotRunning") : undefined}
                onClick={() => setPicked(tab.id)}
                className={cn(
                  "flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px]",
                  tab.id === tabId ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]",
                  (dead || local) && "opacity-50",
                )}
              >
                {TabIcon ? <TabIcon className="h-3.5 w-3.5 shrink-0" /> : <span className={cn("shrink-0", CLI_BRAND_COLOR[ti])}><CliIcon cli={ti} className="h-3.5 w-3.5" /></span>}
                <span className="truncate">{tab.title}</span>
                {kind === "agent" && <StateGlyph state={tab.state} size={12} />}
              </button>
            );
          })}
        </div>
      )}

      {taskPath && (
        <div role="tablist" data-testid="server-task-tabs" className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-border-soft)] px-2">
          {["agent", ...shells].map((id, i) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              data-testid={`server-tab-${id === "agent" ? "agent" : "shell"}`}
              onClick={() => setView(id)}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px]",
                view === id ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]",
              )}
            >
              {id === "agent"
                ? <span className={cn("shrink-0", CLI_BRAND_COLOR[icon])}><CliIcon cli={icon} className="h-3.5 w-3.5" /></span>
                : <SquareTerminal className="h-3.5 w-3.5 shrink-0" />}
              <span>{id === "agent" ? t("task.agentTab") : meta[id]?.label ?? t("task.shellTab", { n: i })}</span>
              {id !== "agent" && (
                <span
                  role="button"
                  aria-label={t("task.closeShell")}
                  onClick={(e) => { e.stopPropagation(); useServerShells.getState().close(taskId, id); }}
                  className="rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
                ><X className="h-3 w-3" /></span>
              )}
            </button>
          ))}
          <button
            type="button"
            data-testid="server-new-shell"
            aria-label={t("task.newShell")}
            title={t("task.newShell")}
            disabled={!online}
            onClick={() => useServerShells.getState().add(taskId)}
            className="rounded p-1 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-40"
          ><Plus className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0" style={{ display: view === "agent" ? undefined : "none" }}>
          {online && active && <RemoteTerminal key={tabId ?? "default"} machineId={machineId} machineName={machine.name} taskId={task.id} tabId={tabId} ownsSize={machine.caps.includes("resize")} />}
        </div>
        {taskPath && shells.map(id => (
          <div key={id} className="absolute inset-0" style={{ display: view === id ? undefined : "none" }}>
            <AuxTerminal taskId={task.id} tabId={id} taskPath={taskPath} active={active && view === id} initialInput={meta[id]?.input} />
          </div>
        ))}
      </div>
    </div>
  );
}

async function archive(machineName: string, machineId: string, task: RemoteTask, close: () => void, t: (k: string, o?: Record<string, unknown>) => string) {
  const ok = await useUI.getState().askConfirm({
    title: t("task.archiveTitle", { task: task.name, machine: machineName }),
    message: t("task.archiveMessage", { machine: machineName }),
    confirmLabel: t("task.archive"),
    destructive: true,
  });
  if (!(typeof ok === "boolean" ? ok : ok.confirmed)) return;
  try {
    const r = await remoteCall(machineId, req("archive", { task: task.id }), 330_000);
    if (!r.ok) throw new Error(r.error?.message ?? "archive failed");
    useUI.getState().pushToast(t("task.archived", { machine: machineName }), "success");
    close();
  } catch (e) {
    useUI.getState().pushToast(String(e), "error");
  }
}

function Gone({ message, onClose }: { message: string; onClose: () => void }) {
  const { t } = useTranslation("remote");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-[var(--color-fg-dim)]">
      <p>{message}</p>
      <Button variant="secondary" size="sm" onClick={onClose}>{t("task.close")}</Button>
    </div>
  );
}

/** `ownsSize`: the host's PTY has no screen of its own (a server), so this
 *  pane sizes it, like a local tab. Otherwise (another computer) its own
 *  window owns the size and this follows it. */
function RemoteTerminal({ machineId, machineName, taskId, tabId, ownsSize }: { machineId: string; machineName: string; taskId: string; tabId: string | null; ownsSize: boolean }) {
  const { t } = useTranslation("remote");
  const host = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: currentTerminalStack(),
      fontSize: usePrefs.getState().terminalFontSize,
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1.0,
      theme: currentTerminalTheme() as never,
      scrollback: 5000,
      allowProposedApi: true,
      cursorBlink: false,
    });
    term.open(host.current);
    // A keyboard is the point of opening it here: typing goes straight in.
    term.focus();
    let alive = true;
    let opened = () => {};
    const onEvent = (e: TermEvent) => {
      // What arrived last, for a reader of the DOM (the e2e suite).
      host.current?.setAttribute("data-last-event", e.t);
      if (!alive) return;
      if (e.t === "term_reset") {
        term.resize(e.cols, e.rows);
        setSize({ cols: e.cols, rows: e.rows });
        term.reset();
        term.write(b64decodeBytes(e.data));
        setClosed(null);
      } else if (e.t === "term_data") {
        term.write(b64decodeBytes(e.data));
      } else if (e.t === "term_resize") {
        host.current?.setAttribute("data-size", `${e.cols}x${e.rows}`);
        term.resize(e.cols, e.rows);
        setSize({ cols: e.cols, rows: e.rows });
      } else if (e.t === "term_closed") {
        setClosed(e.reason);
      }
    };
    const sub = term.onData(data => {
      if (isTerminalReply(data)) return;
      void remoteTermInput(machineId, b64encode(data)).catch(() => {});
    });
    // A server's PTY follows this pane: propose the size that fits, and
    // draw at it once the server confirms (term_resize), so the grid here
    // and the PTY there never disagree. Debounced: a drag sends one size.
    let stopFit = () => {};
    if (ownsSize) {
      const fit = new FitAddon();
      term.loadAddon(fit);
      let sent = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const propose = () => {
        const d = fit.proposeDimensions();
        if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 1 || d.rows < 1) return;
        const key = `${d.cols}x${d.rows}`;
        if (key === sent) return;
        sent = key;
        void remoteTermSize(machineId, d.cols, d.rows).catch(() => {});
      };
      const ro = new ResizeObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(propose, 80);
      });
      ro.observe(host.current);
      // The first size goes with the open, before any resize happens.
      opened = () => { sent = ""; propose(); };
      stopFit = () => { clearTimeout(timer); ro.disconnect(); };
    }
    void remoteTermOpen(machineId, taskId, tabId, onEvent)
      .then(() => { host.current?.setAttribute("data-opened", "true"); opened(); })
      .catch(err => setClosed(String(err)));
    return () => {
      alive = false;
      stopFit();
      sub.dispose();
      void remoteTermClose(machineId).catch(() => {});
      term.dispose();
    };
  }, [machineId, taskId, tabId, generation, ownsSize]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {closed && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("task.terminalClosed", { reason: closed })}
          <Button size="sm" variant="secondary" onClick={() => setGeneration(g => g + 1)}>{t("task.reopen")}</Button>
        </div>
      )}
      {size && !ownsSize && (
        <div className="shrink-0 px-3 pt-1 text-[11px] text-[var(--color-fg-faint)]">{t("task.sizeNote", { cols: size.cols, machine: machineName })}</div>
      )}
      {/* Another computer's PTY size wins: a narrower pane scrolls, it never
          reflows. A server's fills the pane. */}
      <div className={cn("min-h-0 flex-1 p-2", ownsSize ? "overflow-hidden" : "overflow-auto")}>
        <div ref={host} data-testid="remote-terminal" data-owns-size={ownsSize} className={ownsSize ? "h-full w-full" : "inline-block"} />
      </div>
    </div>
  );
}
