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

import { onClaimTerminal } from "@/lib/claimTerminal";
import { useArchivingTasks } from "@/store/archivingTasks";
import { terminalKeysAfter, terminalKeysBefore } from "@/lib/terminalKeys";
import { builtinBaseId } from "@/lib/agents";
import * as ipc from "@/lib/ipc";
import { attachCopyOnSelect } from "@/lib/terminalSelection";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Archive, Monitor, Play, Server, SquareTerminal, X, MonitorSmartphone } from "lucide-react";
import { useApp } from "@/store/app";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { Button } from "@/components/ui/Button";
import { AppDialog } from "@/components/ui/Dialog";
import i18n from "i18next";
import { useUI } from "@/store/ui";
import { loadTerminalRenderer } from "@/lib/terminalRenderer";
import { loadTerminalAddons, openTerminalLink, terminalLinkHandler, terminalLook, wireTerminalLinks } from "@/lib/terminalLook";
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

/** A task on a paired computer, shown here (server tasks are ordinary
 *  tasks and open in TaskView). */
export function RemoteTaskView({ machineId, taskId }: { machineId: string; taskId: string }) {
  const { t } = useTranslation("remote");
  const machine = useMachine(machineId);
  const task = machine?.tasks.find(x => x.id === taskId);
  const openTask = useRemote(s => s.openTask);
  const close = () => openTask(null);
  const online = machine?.state === "online";
  // The tab whose terminal is open: picked in the strip, else the task's
  // default agent tab (null asks the host for that one).
  const [picked, setPicked] = useState<string | null>(null);

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
          leave out, so nobody types into the wrong computer. A server task
          sits under the app's own top bar (name, Archive, Run), so it gets
          only the "On <server>" mark, at the end of its tab strip. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3">
        <span className={cn("shrink-0", CLI_BRAND_COLOR[icon])}><CliIcon cli={icon} className="h-4 w-4" /></span>
        <span className="truncate text-[14px] font-medium text-[var(--color-fg)]">{task.name}</span>
        <StateGlyph state={task.state} delegated={task.tabs.find(x => x.delegated)?.delegated} />
        <span className="shrink-0 text-[12px] text-[var(--color-fg-faint)]">{t(`states.${task.state}`, { defaultValue: task.state })}</span>
        <span className="mx-1 h-4 w-px shrink-0 bg-[var(--color-border-soft)]" />
        <MIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-dim)]" />
        <span data-testid="remote-task-location" className="shrink-0 text-[12.5px] text-[var(--color-fg-dim)]">{t("task.on", { machine: machine.name })}</span>
        <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-[var(--color-ok)]" : "bg-[var(--color-fg-faint)]")} />
        <span className="truncate text-[12.5px] text-[var(--color-fg-faint)]">{task.project}{task.branch ? ` · ${task.branch}` : ""}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" data-testid="remote-task-archive" disabled={!online} onClick={() => {
            // A server project's task is a desktop task too: its archive
            // (the same confirm as the sidebar's) runs the archive script,
            // archives on the box and clears it as the active task here.
            void archiveRemoteTask(machine.name, machineId, task, close);
          }}>
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
                {kind === "agent" && <StateGlyph state={tab.state} size={12} delegated={tab.delegated} />}
              </button>
            );
          })}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          {online && <RemoteTerminal key={tabId ?? "default"} machineId={machineId} taskId={task.id} tabId={tabId} agent={task.agent} />}
        </div>
      </div>
    </div>
  );
}

/** Archive a task on another computer, behind the sidebar's confirm. The
 *  task view's button and the remote row's menu both call it. */
export async function archiveRemoteTask(machineName: string, machineId: string, task: RemoteTask, close: () => void) {
  const t = (k: string, o?: Record<string, unknown>) => i18n.t(`remote:${k}`, o);
  const ok = await useUI.getState().askConfirm({
    title: t("task.archiveTitle", { task: task.name, machine: machineName }),
    message: t("task.archiveMessage", { machine: machineName }),
    confirmLabel: t("task.archive"),
    destructive: true,
  });
  if (!(typeof ok === "boolean" ? ok : ok.confirmed)) return;
  // Archiving takes a while there (worktree, archive script): the row says
  // so meanwhile, as a local task's row does, keyed by machine and task.
  const key = remoteArchivingKey(machineId, task.id);
  useArchivingTasks.getState().begin(key);
  try {
    const r = await remoteCall(machineId, req("archive", { task: task.id }), 330_000);
    if (!r.ok) throw new Error(r.error?.message ?? "archive failed");
    useUI.getState().pushToast(t("task.archived", { machine: machineName }), "success");
    close();
  } catch (e) {
    useUI.getState().pushToast(String(e), "error");
  } finally {
    useArchivingTasks.getState().end(key);
  }
}

/** The archiving store's key for a remote task (ids only unique per machine). */
export const remoteArchivingKey = (machine: string, task: string) => `remote:${machine}:${task}`;

function Gone({ message, onClose }: { message: string; onClose: () => void }) {
  const { t } = useTranslation("remote");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-[var(--color-fg-dim)]">
      <p>{message}</p>
      <Button variant="secondary" size="sm" onClick={onClose}>{t("task.close")}</Button>
    </div>
  );
}

/** Another computer's terminal, where the last window worked in owns the
 *  size (as tmux's "latest"): this one claims it when the terminal is
 *  opened, or on a click or a key in this window, and follows this pane while it
 *  owns it; when that computer takes it back, this draws at its size,
 *  scaled to fit the pane. A terminal cannot be two sizes at once (one
 *  program draws for one width), so the other window scales instead. */
function RemoteTerminal({ machineId, taskId, tabId, agent }: { machineId: string; taskId: string; tabId: string | null; agent: string }) {
  const { t } = useTranslation("remote");
  const host = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  /** Another screen owns this terminal's size: the overlay is up. */
  const [elsewhere, setElsewhere] = useState(false);
  const continueHere = useRef<(() => void) | null>(null);
  // Reopen re-runs the effect: its cleanup must not send a close, which
  // could reach the host after the new open and shut it again. The host's
  // open replaces the old terminal by itself.
  const reopening = useRef(false);

  useEffect(() => {
    const box = host.current;
    if (!box) return;
    // The configured browser is per task on this machine; a remote task
    // has none here, so links take the default opener.
    const openLink = (uri: string) => openTerminalLink(uri, null, "remote");
    const term = new Terminal({
      ...terminalLook(),
      linkHandler: terminalLinkHandler(openLink),
      scrollback: 5000,
      cursorBlink: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Drawn as a local terminal is: the agent's tables and boxes rely on
    // xterm's own box-drawing glyphs (the WebGL renderer joins them cell to
    // cell; the DOM renderer took them from the font, with gaps between
    // rows) and on Unicode 11 widths (⌘ / ⌥ in a row moved its right border).
    // Widths, the OSC 52 clipboard and inline images, as every terminal has.
    loadTerminalAddons(term);
    term.open(box);
    // Links, as in a local terminal: OSC 8 (Claude's), plain URLs, Cmd+click.
    const disposeLinks = wireTerminalLinks(term, box, openLink);
    const renderer = loadTerminalRenderer(term);
    const disposeCopyOnSelect = attachCopyOnSelect(term, box);
    let alive = true;
    // What this pane fits, and whether the PTY is at it (this window owns
    // the size) or at another window's (draw scaled).
    const own = () => {
      const d = fit.proposeDimensions();
      return d && Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols >= 1 && d.rows >= 1 ? { cols: d.cols, rows: d.rows } : null;
    };
    // At another screen's size: the terminal is hidden (display:none, so it
    // stops drawing) behind an overlay whose Continue here takes the size
    // back. Not while opening: the first screen arrives at the other size a
    // moment before this pane's claim lands, and would flash the overlay.
    let opening = true;
    const draw = () => {
      const d = own();
      const el = term.element;
      if (!el) return;
      const mine = !!d && d.cols === term.cols && d.rows === term.rows;
      if (mine) opening = false;
      box.dataset.owner = String(mine);
      const away = !mine && !opening;
      el.style.display = away ? "none" : "";
      setElsewhere(away);
    };
    let claimed = false;
    const claim = () => {
      const d = own();
      if (!d) return;
      claimed = true;
      if (term.element?.style.display === "none") {
        term.element.style.display = "";
        setElsewhere(false);
      }
      if (d.cols === term.cols && d.rows === term.rows) return;
      void remoteTermSize(machineId, d.cols, d.rows).catch(() => {});
    };
    const sized = (cols: number, rows: number) => {
      box.setAttribute("data-size", `${cols}x${rows}`);
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      const d = own();
      // A size that is not ours: the other computer took it back.
      if (!d || d.cols !== cols || d.rows !== rows) claimed = false;
      requestAnimationFrame(draw);
    };
    const onEvent = (e: TermEvent) => {
      // What arrived last, for a reader of the DOM (the e2e suite).
      box.setAttribute("data-last-event", e.t);
      if (!alive) return;
      if (e.t === "term_reset") {
        term.reset();
        sized(e.cols, e.rows);
        term.write(b64decodeBytes(e.data));
        setClosed(null);
      } else if (e.t === "term_data") {
        term.write(b64decodeBytes(e.data));
      } else if (e.t === "term_resize") {
        sized(e.cols, e.rows);
      } else if (e.t === "term_closed") {
        setClosed(e.reason);
      }
    };
    // The keys every terminal shares (lib/terminalKeys: the IME guard, app
    // shortcuts, Shift+Enter as a newline, ⌘⌫, ⌘←/⌘→, copy/paste off
    // macOS), with this view's one of its own between them: Ctrl+V.
    const keys = {
      term,
      write: (bytes: number[]) => void remoteTermInput(machineId, b64encode(String.fromCharCode(...bytes))).catch(() => {}),
      agentBaseId: () => builtinBaseId(agent, useApp.getState().agents),
    };
    term.attachCustomKeyEventHandler(e => {
      if (terminalKeysBefore(e) === false) return false;
      // Ctrl+V is the agents' "attach the clipboard image", and they read the
      // clipboard of the computer they run on, which is not this one. So the
      // image on this clipboard is put on that computer's first, then the
      // keystroke follows and the agent attaches it natively. No image: the
      // keystroke goes as it always did.
      if (e.type === "keydown" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "v" || e.key === "V")) {
        const sendCtrlV = () => keys.write([0x16]);
        ipc.clipboardImagePngB64()
          .then(png => remoteCall(machineId, req("clipboard_image", { png })))
          .then(sendCtrlV, sendCtrlV);
        return false;
      }
      if (terminalKeysAfter(e, keys) === false) return false;
      return true;
    });
    const sub = term.onData(data => {
      if (isTerminalReply(data)) return;
      void remoteTermInput(machineId, b64encode(data)).catch(() => {});
    });
    // Only Continue here (the overlay) takes the size back once another
    // screen has it: a click anywhere did before, and two focused screens
    // traded the size on every touch.
    continueHere.current = () => { claim(); term.focus(); };
    // Picked in the sidebar: take it back as Continue here would (claim
    // does nothing when this window already has the size).
    const unclaim = onClaimTerminal(taskId, () => continueHere.current?.());
    // While this window owns the size it follows the pane (debounced: a
    // drag sends one size); otherwise a resize here only rescales.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => (claimed && !opening ? claim() : draw()), 80);
    });
    ro.observe(box);
    void remoteTermOpen(machineId, taskId, tabId, onEvent)
      .then(() => {
        box.setAttribute("data-opened", "true");
        // Opening it is working in it: typing goes straight in, at this size.
        term.focus();
        claim();
        // Already at this size (no resize will come back): open is done.
        const d = own();
        if (d && d.cols === term.cols && d.rows === term.rows) opening = false;
        // A claim that never lands (an older computer) still ends opening.
        setTimeout(() => { opening = false; draw(); }, 1500);
      })
      .catch(err => setClosed(String(err)));
    return () => {
      alive = false;
      clearTimeout(timer);
      ro.disconnect();
      continueHere.current = null;
      unclaim();
      sub.dispose();
      disposeCopyOnSelect();
      if (reopening.current) reopening.current = false;
      else void remoteTermClose(machineId).catch(() => {});
      renderer.dispose();
      disposeLinks();
      term.dispose();
    };
  }, [machineId, taskId, tabId, generation, agent]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {closed && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("task.terminalClosed", { reason: closed })}
          <Button size="sm" variant="secondary" onClick={() => { reopening.current = true; setClosed(null); setGeneration(g => g + 1); }}>{t("task.reopen")}</Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        <div ref={host} data-testid="remote-terminal" className="h-full w-full overflow-hidden" />
        {elsewhere && (
          <div data-testid="terminal-elsewhere" className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)] text-[13px] text-[var(--color-fg-dim)]">
            <MonitorSmartphone data-testid="terminal-elsewhere-icon" className="h-10 w-10 text-[var(--color-fg-faint)]" strokeWidth={1.5} />
            <p className="text-[14px] text-[var(--color-fg)]">{t("task.elsewhere")}</p>
            <Button size="sm" data-testid="terminal-continue-here" onClick={() => continueHere.current?.()}>{t("task.continueHere")}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export type ServerCloseChoice = "close" | "stop" | "cancel";

/** ⌘W on a remote agent's tab: the agent runs on the other machine past
 *  any tab, so closing asks what is meant. Three outcomes, dismissal the
 *  harmless one (like ScratchCloseDialog). */
export const useServerClose = create<{
  req: { task: string; machine: string; resolve: (c: ServerCloseChoice) => void } | null;
  ask: (task: string, machine: string) => Promise<ServerCloseChoice>;
}>((set) => ({
  req: null,
  ask: (task, machine) => new Promise(resolve => set({
    req: { task, machine, resolve: c => { set({ req: null }); resolve(c); } },
  })),
}));

export function ServerCloseDialog() {
  const { t } = useTranslation("remote");
  const req = useServerClose(s => s.req);
  if (!req) return null;
  return (
    <AppDialog
      open
      onOpenChange={v => { if (!v) req.resolve("cancel"); }}
      title={t("task.closeTitle", { task: req.task })}
      className="max-w-lg"
      onCloseAutoFocus={e => e.preventDefault()}
    >
      <p data-testid="server-close-dialog" className="text-[13.5px] leading-relaxed text-[var(--color-fg-dim)]">
        {t("task.closeBody", { machine: req.machine })}
      </p>
      {/* A keyboard dialog (it opens from Cmd+W): the focused choice is ringed
          from the start, not only after a Tab (the app ring is
          :focus-visible, which an autofocus does not trigger), and the
          arrows move between the choices. Tab is the buttons' own. */}
      <div
        className="mt-4 flex justify-end gap-2 [&>button:focus]:outline-2 [&>button:focus]:outline-offset-2 [&>button:focus]:outline-[var(--color-accent-soft)]"
        onKeyDown={e => {
          const buttons = Array.from(e.currentTarget.querySelectorAll("button"));
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (i < 0) return;
          // Enter presses the FOCUSED choice. Pressed here explicitly: left to
          // the button, the e2e's Enter never closed the dialog (something
          // outside the row takes the keydown; not pinned down which).
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); buttons[i].click(); return; }
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length].focus();
        }}
      >
        <Button variant="ghost" type="button" data-testid="server-close-cancel" onClick={() => req.resolve("cancel")}>{t("common:cancel")}</Button>
        <Button variant="ghost" type="button" data-testid="server-close-stop" onClick={() => req.resolve("stop")}
          className="text-[var(--color-err)] hover:bg-[var(--color-err)]/12">{t("task.stopAgent")}</Button>
        <Button variant="primary" type="button" data-testid="server-close-view" autoFocus onClick={() => req.resolve("close")}>{t("task.closeView")}</Button>
      </div>
    </AppDialog>
  );
}

/** Stop a remote task's agent. A server project's task is a desktop task
 *  whose tabs run on the box: the local stop (its PTYs end there). A paired
 *  computer's task is that computer's: ask it, with the view closed first,
 *  since an open terminal there starts its agent again. */
export async function stopRemoteAgent(machineId: string, taskId: string, machineName: string): Promise<void> {
  const app = useApp.getState();
  if (app.tasks.some(t => t.id === taskId)) {
    app.stopTask(taskId);
    return;
  }
  if (app.activeTaskId === taskId) app.setActiveTask(null);
  const remote = useRemote.getState();
  if (remote.open?.task === taskId) remote.openTask(null);
  try {
    const r = await remoteCall(machineId, req("stop", { task: taskId }));
    if (!r.ok) throw new Error(r.error?.message ?? "stop failed");
  } catch (e) {
    useUI.getState().pushToast(i18n.t("remote:task.stopFailed", { machine: machineName, error: String(e) }), "error");
  }
}
