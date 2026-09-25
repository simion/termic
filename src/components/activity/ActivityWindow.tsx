// The Activity window: "which agent is eating my CPU / RAM?"
//
// This is the ROOT component of a second window (main.tsx branches on
// `?window=procmon`), not a modal. That is deliberate: the numbers only
// mean something while you are driving the agent that moves them, which a
// modal over the app makes impossible.
//
// Sampling discipline, because a monitor that costs what it measures is
// worthless:
//   - Rust holds no sampler thread. This component's interval IS the clock
//     (see src-tauri/src/procmon.rs).
//   - An occluded / minimised window backs off to a slow heartbeat rather
//     than stopping dead. Stopping was the first design and it was wrong
//     twice over: it leaves a hole in the history exactly when the user was
//     doing something else (the "what spiked while I was in Chrome?"
//     question this window exists to answer), and the cost it saves is
//     ~2ms every 5s.
//   - No Zustand writes on the sample path. Snapshots live in local state
//     in this component, so the app store's ~233 keys are never copied at
//     1 Hz (docs/performance.md bear trap 8).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity, Cpu, Folder, MemoryStick, Layers,
  Bot, TerminalSquare, Play, Wrench, Skull, Pause, PlayCircle, Container,
} from "lucide-react";
import * as ipc from "@/lib/ipc";
import type { ProcSnapshot, ProcRow } from "@/lib/ipc";
import type { Project, Task } from "@/lib/types";
import {
  groupRows, formatBytes, formatPct, formatRate, formatDuration,
  nextSort, DEFAULT_SORT, childSummary,
  type ActivityRow, type Sort, type SortColumn,
} from "@/lib/activityGroups";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/store/prefs";
import { subscribeActivityTitles } from "@/lib/activityTitleBridge";

/** Sampling period while the window is on screen. 1 Hz is what Activity
 *  Monitor and Chrome's task manager use: fast enough to see a spike, slow
 *  enough that the sampler (a few ms, and reported in the footer) rounds to
 *  nothing. */
const PERIOD_MS = 1000;
/** Period while the window is occluded or minimised. Slow, not stopped, so
 *  the history stays continuous for "what spiked while I was elsewhere?". */
const PERIOD_HIDDEN_MS = 5000;
/** How often the project / task lists are re-read. They only change when
 *  the user creates or archives a task, so this does not belong on the
 *  1 Hz path. */
const META_EVERY = 10;

export function ActivityWindow() {
  const { t } = useTranslation("chrome");
  const [snap, setSnap] = useState<ProcSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [paused, setPaused] = useState(false);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({});
  const sessionRef = useRef<number | null>(null);
  const tickRef = useRef(0);

  // Live tab titles (what the main window's tab strip actually shows right
  // now) come from a SEPARATE webview, so they're bridged in on request —
  // see lib/activityTitleBridge.ts for why this can't just read Zustand.
  // Subscribed once; `titleBridgeRef.current.request()` rides the sample
  // tick (see the poll loop below), NOT loadMeta's every-tenth: a title is
  // the one piece of metadata here that moves while you watch, because an
  // agent rewrites its tab title as it works. The request is an emit of a
  // small map, and the bridge drops a reply identical to the last one before
  // it reaches React, so the steady-state cost is the emit alone.
  const titleBridgeRef = useRef<{ request: () => void; stop: () => void } | null>(null);
  useEffect(() => {
    const bridge = subscribeActivityTitles(setLiveTitles);
    titleBridgeRef.current = bridge;
    bridge.request();
    return () => bridge.stop();
  }, []);

  // Paint in the user's theme. Importing the prefs store is what does it:
  // the module applies the persisted theme's CSS vars at load, and
  // localStorage is shared across windows of the same origin. A theme
  // change made in the main window reaches this one when it next opens
  // (Zustand state itself does not cross webviews).
  usePrefs(s => s.themeMode);

  const loadMeta = useCallback(() => {
    Promise.all([ipc.projectsList(), ipc.tasksList()])
      .then(([p, t]) => { setProjects(p); setTasks(t); })
      .catch(() => { /* names degrade to ids; the numbers still work */ });
  }, []);

  // Session lifecycle. `start` is what allocates state in Rust and `stop`
  // is what frees it, so both edges matter: the effect's cleanup covers a
  // reload, and Rust's own window-destroyed handler covers the red button.
  useEffect(() => {
    let cancelled = false;
    ipc.procmonStart()
      .then(first => {
        if (cancelled) { void ipc.procmonStop(first.session); return; }
        sessionRef.current = first.session;
        setSnap(first);
      })
      .catch(e => setError(String(e)));
    loadMeta();
    return () => {
      cancelled = true;
      const s = sessionRef.current;
      sessionRef.current = null;
      if (s !== null) void ipc.procmonStop(s);
    };
  }, [loadMeta]);

  // The poll loop. Pause is the only full stop; an occluded window just
  // samples slowly (see PERIOD_HIDDEN_MS).
  useEffect(() => {
    if (paused) return;
    let timer: number | undefined;
    let stopped = false;
    const period = () => (document.hidden ? PERIOD_HIDDEN_MS : PERIOD_MS);

    const tick = async () => {
      if (stopped) return;
      if (sessionRef.current === null) {
        timer = window.setTimeout(tick, period());
        return;
      }
      try {
        const next = await ipc.procmonSample(sessionRef.current);
        if (stopped) return;
        setSnap(next);
        setError(null);
        titleBridgeRef.current?.request();
        if (++tickRef.current % META_EVERY === 0) loadMeta();
      } catch (e) {
        if (stopped) return;
        // A stale session (the webview reloaded under us) is recoverable:
        // start a fresh one rather than leaving a dead window on screen.
        try {
          const fresh = await ipc.procmonStart();
          // Unmounted while that was in flight: the cleanup below already ran
          // and stopped the OLD session, so adopting this one would leave it
          // with nobody to stop it.
          if (stopped) { void ipc.procmonStop(fresh.session); return; }
          sessionRef.current = fresh.session;
          setSnap(fresh);
          setError(null);
        } catch {
          setError(String(e));
        }
      }
      if (!stopped) timer = window.setTimeout(tick, period());
    };

    timer = window.setTimeout(tick, period());
    // Coming back to the window should not wait out a slow-period timer. The
    // pending timer MUST be cancelled first: `tick` re-arms at its end, so
    // ticking without clearing leaves two chains running, and every further
    // app switch adds another — the sampling rate would climb for the life of
    // the window, in the one feature that cannot afford to leak CPU.
    const onVisible = () => {
      if (document.hidden) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [paused, loadMeta]);

  const grouped = useMemo(
    () => groupRows(snap?.rows ?? [], projects, tasks, sort, liveTitles),
    [snap, projects, tasks, sort, liveTitles],
  );

  return (
    // One elevation stop above the app's content background. This is a
    // floating utility window, not a content area, and at `--color-bg` it read
    // as a black hole floating over the app (the group headers at
    // `--color-bg-1` were the only thing separating from it). Same direction
    // every other piece of chrome in the app elevates: index.css says chrome
    // sits one stop lighter than content.
    <div className="flex h-screen w-screen flex-col bg-[var(--color-bg-1)] text-[var(--color-fg)]">
      <Header
        cpu={grouped.totalCpuPct}
        mem={grouped.totalMemBytes}
        paused={paused}
        onTogglePause={() => setPaused(p => !p)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="m-3 rounded-md border border-[var(--color-err)] bg-[var(--color-err)]/10 px-3 py-2 text-[12.5px]">
            {error}
          </div>
        )}

        <Columns sort={sort} onSort={col => setSort(s => nextSort(s, col))} />

        {grouped.projects.length === 0 && grouped.orphans.length === 0 && (
          <div className="px-4 py-6 text-[12.5px] text-[var(--color-fg-faint)]">
            {t("activity.empty")}
          </div>
        )}

        {grouped.projects.map(p => (
          <section key={p.projectId || "unknown"}>
            <GroupHeader
              icon={<Folder className="h-3.5 w-3.5" />}
              name={p.projectName}
              cpu={p.cpuPct}
              mem={p.memBytes}
              level={0}
            />
            {p.tasks.map(t => (
              <div key={t.taskId}>
                <GroupHeader
                  icon={<Layers className="h-3.5 w-3.5" />}
                  name={t.taskName}
                  detail={t.branch ?? undefined}
                  cpu={t.cpuPct}
                  mem={t.memBytes}
                  level={1}
                />
                {t.rows.map(r => (
                  <Row key={r.key} row={r} />
                ))}
              </div>
            ))}
          </section>
        ))}

        {grouped.orphans.length > 0 && (
          <section>
            <GroupHeader
              icon={<TerminalSquare className="h-3.5 w-3.5" />}
              name={t("activity.notInTask")}
              cpu={null}
              mem={grouped.orphans.reduce((a, r) => a + r.memBytes, 0)}
              level={0}
            />
            {grouped.orphans.map(r => (
              <Row key={r.key} row={r} />
            ))}
          </section>
        )}

        {grouped.self.length > 0 && (
          <section>
            <GroupHeader
              icon={<Activity className="h-3.5 w-3.5" />}
              name={t("activity.termicItself")}
              // Honest about a gap rather than quietly reporting a smaller
              // number: a dev build launched from a terminal cannot prove
              // which WebContent process is its own (macOS assigns
              // responsibility to the terminal).
              detail={snap?.webkitUnavailable ? t("activity.webkitGap") : undefined}
              cpu={grouped.selfCpuPct}
              mem={grouped.selfMemBytes}
              level={0}
            />
            {grouped.self.map(r => (
              <Row key={r.key} row={r} />
            ))}
          </section>
        )}
      </div>

      <Footer snap={snap} paused={paused} />
    </div>
  );
}

function Header({ cpu, mem, paused, onTogglePause }: {
  cpu: number | null; mem: number; paused: boolean; onTogglePause: () => void;
}) {
  const { t } = useTranslation("chrome");
  return (
    // No `data-tauri-drag-region` here: this window keeps its NATIVE title
    // bar (that is what you grab to move it), and the drag-region attribute
    // needs `core:window:allow-start-dragging`, a permission the default
    // capability grants to the "main" window only.
    <div className="flex shrink-0 items-center gap-4 border-b border-[var(--color-border-soft)] px-3 py-2 select-none">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-[var(--color-accent)]" />
        <span className="text-[13px] font-medium">{t("activity.windowTitle")}</span>
      </div>
      <div className="flex items-center gap-3 text-[12.5px] text-[var(--color-fg-dim)]">
        <span className="flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums text-[var(--color-fg)]">{formatPct(cpu)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <MemoryStick className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums text-[var(--color-fg)]">{formatBytes(mem)}</span>
        </span>
      </div>
      <button
        onClick={onTogglePause}
        data-testid="activity-pause"
        className="ml-auto flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
      >
        {paused ? <PlayCircle className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        {paused ? t("activity.resume") : t("activity.pause")}
      </button>
    </div>
  );
}

/** Column header. Kept in one place so the row grid and this cannot drift. */
const GRID = "grid grid-cols-[minmax(0,1fr)_58px_74px_66px_58px_62px] items-center gap-2 px-3";

const COLUMNS: { col: SortColumn; labelKey: string; align: "left" | "right"; tipKey?: string }[] = [
  { col: "name", labelKey: "activity.colProcess", align: "left" },
  {
    col: "cpu", labelKey: "activity.colCpu", align: "right",
    // Say it in the tooltip rather than let it look like a bug: the ORDER is
    // smoothed even though the number shown is instantaneous.
    tipKey: "activity.tipSortCpu",
  },
  { col: "mem", labelKey: "activity.colMemory", align: "right", tipKey: "activity.tipSortMemory" },
  { col: "out", labelKey: "activity.colOutput", align: "right", tipKey: "activity.tipSortOutput" },
  { col: "uptime", labelKey: "activity.colUptime", align: "right", tipKey: "activity.tipSortUptime" },
  { col: "pid", labelKey: "activity.colPid", align: "right", tipKey: "activity.tipSortPid" },
];

function Columns({ sort, onSort }: { sort: Sort; onSort: (col: SortColumn) => void }) {
  const { t } = useTranslation("chrome");
  return (
    <div className={cn(
      GRID,
      // Opaque, because it is sticky over scrolling rows. Sentence case, not
      // uppercase: it matches Activity Monitor and Chrome's task manager, and
      // WebKit resets `text-transform` on <button> anyway now that each header
      // is a sort control, so an `uppercase` here would be dead CSS.
      "sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg-1)] text-[11px] text-[var(--color-fg-faint)]",
    )}>
      {COLUMNS.map(c => {
        const active = sort.column === c.col;
        return (
          <button
            key={c.col}
            onClick={() => onSort(c.col)}
            title={c.tipKey ? t(c.tipKey) : undefined}
            data-testid={`activity-sort-${c.col}`}
            data-active={active ? sort.dir : undefined}
            className={cn(
              "flex items-center gap-1 py-1.5 hover:text-[var(--color-fg)]",
              c.align === "right" ? "justify-end" : "justify-start",
              active && "text-[var(--color-fg)]",
            )}
          >
            {t(c.labelKey)}
            {/* The caret is the only thing that says which column is active,
                so it holds its 8px of width whether or not it is shown. */}
            <span className="w-2 text-[9px] leading-none">
              {active ? (sort.dir === "desc" ? "▼" : "▲") : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function GroupHeader({ icon, name, detail, cpu, mem, level }: {
  icon: React.ReactNode; name: string; detail?: string;
  cpu: number | null; mem: number; level: 0 | 1;
}) {
  return (
    // The window sits at --color-bg-1, so a project header has to elevate
    // AGAIN to read as a band; a task header stays flush and separates by
    // weight and indent instead, or three stacked bands fight each other.
    <div className={cn(
      GRID,
      "py-1.5",
      level === 0
        ? "border-y border-[var(--color-border-soft)] bg-[var(--color-bg-2)] text-[12.5px] font-medium"
        : "text-[12.5px] text-[var(--color-fg-dim)]",
    )}>
      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: level * 14 }}>
        <span className="text-[var(--color-fg-faint)]">{icon}</span>
        <span className="truncate">{name}</span>
        {detail && (
          <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{detail}</span>
        )}
      </div>
      <span className="text-right font-mono text-[12px] tabular-nums">{formatPct(cpu)}</span>
      <span className="text-right font-mono text-[12px] tabular-nums">{formatBytes(mem)}</span>
      <span />
      <span />
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]";
  if (kind === "agent") return <Bot className={cls} />;
  if (kind === "run" || kind === "custom") return <Play className={cls} />;
  if (kind === "setup") return <Wrench className={cls} />;
  if (kind === "app" || kind.startsWith("webkit-")) return <Activity className={cls} />;
  return <TerminalSquare className={cls} />;
}

function Row({ row }: { row: ActivityRow }) {
  const { t } = useTranslation("chrome");
  const canSignal = row.ptyId !== null;
  return (
    <>
      <div
        className={cn(GRID, "group py-1 hover:bg-[var(--color-hover)]")}
        data-testid="activity-row"
        data-row-key={row.key}
      >
        <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: 28 }}>
          <KindIcon kind={row.kind} />
          {/* No expand affordance: for a one-process row it only repeated the
              Process and PID columns, which is most rows. The per-child
              breakdown that DOES add something lives in the tooltip. */}
          <span className="truncate text-[12.5px]" title={childSummary(row)}>
            {row.title}
          </span>
          {row.isDocker && (
            <span
              className="flex shrink-0 items-center gap-0.5 rounded bg-[var(--color-bg-3)] px-1 py-px text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]"
              title={t("activity.dockerTip")}
            >
              <Container className="h-2.5 w-2.5" />
              Docker
            </span>
          )}
          {!row.alive && (
            <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{t("activity.exited")}</span>
          )}
          <Spark history={row.cpuHistory} />
          {canSignal && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <SignalButton
                pid={row.pid} signal="STOP" title={t("activity.pauseProc")}
                icon={<Pause className="h-3 w-3" />}
              />
              <SignalButton
                pid={row.pid} signal="CONT" title={t("activity.resumeProc")}
                icon={<PlayCircle className="h-3 w-3" />}
              />
              <SignalButton
                pid={row.pid} signal="TERM" title={t("activity.stopProc")}
                icon={<Skull className="h-3 w-3" />}
              />
            </span>
          )}
        </div>
        <span className="text-right font-mono text-[12px] tabular-nums">{formatPct(row.cpuPct)}</span>
        <span className="text-right font-mono text-[12px] tabular-nums text-[var(--color-fg-dim)]">
          {formatBytes(row.memBytes)}
        </span>
        <span className="text-right font-mono text-[11.5px] tabular-nums text-[var(--color-fg-faint)]">
          {formatRate(row.outBps)}
        </span>
        <span className="text-right font-mono text-[11.5px] tabular-nums text-[var(--color-fg-faint)]">
          {formatDuration(row.uptimeMs)}
        </span>
        <span className="text-right font-mono text-[11.5px] tabular-nums text-[var(--color-fg-faint)]">
          {row.pid}
        </span>
      </div>
    </>
  );
}

function SignalButton({ pid, signal, title, icon }: {
  pid: number; signal: "STOP" | "CONT" | "TERM"; title: string; icon: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      data-testid={`activity-signal-${signal}`}
      onClick={() => { void ipc.procmonSignal(pid, signal).catch(() => {}); }}
      className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
    >
      {icon}
    </button>
  );
}

/** CPU sparkline. ONE `<path>` per row, not one node per point: at 90
 *  points and a table of rows, per-point DOM is how a monitor becomes the
 *  thing that needs monitoring. */
function Spark({ history }: { history: number[] }) {
  const d = useMemo(() => {
    if (history.length < 2) return null;
    const w = 46, h = 12;
    // Scale to the row's own peak (floor 25%) so an idle row stays flat
    // instead of amplifying rounding noise into a mountain range.
    const peak = Math.max(25, ...history);
    const step = w / (history.length - 1);
    return history
      .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - (v / peak) * h).toFixed(1)}`)
      .join(" ");
  }, [history]);
  if (!d) return null;
  return (
    <svg width={46} height={12} className="shrink-0 opacity-70" aria-hidden>
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={1} />
    </svg>
  );
}

function Footer({ snap, paused }: { snap: ProcSnapshot | null; paused: boolean }) {
  const { t } = useTranslation("chrome");
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--color-border-soft)] px-3 py-1.5 text-[11px] text-[var(--color-fg-faint)]">
      <span data-testid="activity-status">
        {paused
          ? t("activity.pausedStatus")
          : t("activity.sampling", { seconds: PERIOD_MS / 1000 })}
      </span>
      {/* Our own cost, stated rather than assumed. */}
      <span className="font-mono tabular-nums">
        {snap ? t("activity.sampleStats", { ms: snap.sampleMs.toFixed(1), count: snap.rows.length }) : t("activity.starting")}
      </span>
    </div>
  );
}
