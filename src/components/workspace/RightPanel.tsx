// Right panel: tab between All Files (filesystem list) and Changes (git status).
// Click a file → opens an Editor tab in the main area. Click a change → diff tab.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useApp, useActiveWorkspace } from "@/store/app";
import {
  workspaceChanges, workspaceRunScriptStream, workspaceStopScript, openPath,
} from "@/lib/ipc";
import type { Changes, Workspace, Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Play, ChevronDown, ChevronUp, TerminalSquare, Square, Globe, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AuxTerminal } from "./AuxTerminal";
import { FileTree } from "./FileTree";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useScriptRuns, useRunState } from "@/store/scriptRuns";

const STATUS_LABEL: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", "??": "untracked", "!!": "ignored", U: "conflict" };
const STATUS_COLOR: Record<string, string> = { M: "var(--color-accent)", A: "var(--color-ok)", D: "var(--color-err)", R: "var(--color-accent)", "??": "var(--color-fg-faint)", U: "var(--color-err)" };

type FootTab = "setup" | "run" | "term";

export function RightPanel() {
  const ws = useActiveWorkspace();
  const addTab = useApp(s => s.addTab);
  const split = useApp(s => !!s.terminalSplit[ws?.id ?? ""]);
  const toggleSplit = useApp(s => s.toggleTerminalSplit);
  const [view, setView] = useState<"files" | "changes">("files");
  const [changes, setChanges] = useState<Changes>({ files: [], count: 0 });
  // Footer holds Setup / Run status only. Scratch shells live in the
  // bottom-split (⌘T) — having a second terminal slot here was redundant.
  const [footTab, setFootTab] = useState<FootTab>("run");
  // Expanded by default: the Setup / Run tabs are useless when collapsed,
  // and the bottom split is the dedicated scratch-shell surface — there's
  // nothing the user gains by hiding the footer on first open.
  const [footCollapsed, setFootCollapsed] = useState(false);
  // Footer height + right-panel width come from the persistent app store so
  // values survive reloads and can be set by the two drag handles below.
  const footHeight        = useApp(s => s.rightFooterHeight);
  const setFootHeight     = useApp(s => s.setRightFooterHeight);
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!ws) return;
    workspaceChanges(ws.id).then(setChanges).catch(() => setChanges({ files: [], count: 0 }));
    const id = window.setInterval(() => {
      workspaceChanges(ws.id).then(setChanges).catch(() => {});
    }, 4000);
    return () => window.clearInterval(id);
  }, [ws]);

  // Subscribe to streaming output for BOTH setup and run kinds on the active
  // workspace. We want output to keep flowing even when the user switches
  // footer tabs or briefly looks at the file tree — listeners stay mounted
  // for as long as the workspace is active.
  useEffect(() => {
    if (!ws) return;
    const wsId = ws.id;
    const { appendLine, finish } = useScriptRuns.getState();
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      for (const kind of ["setup", "run"] as const) {
        const u1 = await listen<{ line: string }>(`script-output://${wsId}:${kind}`, ev => {
          if (!cancelled) appendLine(wsId, kind, ev.payload.line);
        });
        const u2 = await listen<{ code: number | null; success: boolean }>(`script-done://${wsId}:${kind}`, ev => {
          if (!cancelled) finish(wsId, kind, ev.payload.code, ev.payload.success);
        });
        unlisteners.push(u1, u2);
      }
    })();
    return () => { cancelled = true; unlisteners.forEach(u => u()); };
  }, [ws?.id]);

  // Resolve project so we can expand `preview_url` for the Open button.
  const project = useApp(s => (ws ? s.projects.find(p => p.id === ws.project_id) ?? null : null));
  const footerTerm = useApp(s => (ws ? !!s.footerTerm[ws.id] : false));
  const footRun = useRunState(ws?.id, footTab === "term" ? "run" : footTab);

  if (!ws) return null;

  return (
    <aside ref={asideRef} className="relative flex h-full flex-col border-l border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
      {/* Drag the LEFT edge to resize the right panel's width. Reads fresh
          state from the store every frame so stale closures don't make it
          snap back to a few px after each move. */}
      <ResizeHandle
        direction="x"
        className="left-0"
        onDrag={(dx) => {
          // Measure CURRENT rendered width (the App.tsx clamp may have
          // capped it below stored preferred on a narrow window).
          // Drag from there so the resize feels responsive. The new
          // value becomes the user's preferred ceiling.
          const cur = asideRef.current?.getBoundingClientRect().width
            ?? useApp.getState().rightPanelWidth;
          // Drag-left grows the panel (dx negative), drag-right shrinks.
          const next = Math.round(Math.max(220, Math.min(900, cur - dx)));
          useApp.getState().setRightPanelWidth(next);
        }}
      />
      <header className="flex h-10 shrink-0 items-center gap-1 px-2.5">
        <RTab label="All files" active={view === "files"} onClick={() => setView("files")} />
        <RTab label="Changes" active={view === "changes"} onClick={() => setView("changes")}
          badge={changes.count > 0 ? changes.count : undefined} />
      </header>

      {/* Files / Changes — flexible, takes whatever's left after the footer */}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {view === "files" && <FileTree wsId={ws.id} />}

        {view === "changes" && (
          <div className="flex flex-col">
            {changes.files.length === 0 && (
              <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">No changes — working tree is clean.</div>
            )}
            {changes.files.map(f => {
              const key = f.status.length > 1 ? f.status : f.status.trim() || "M";
              return (
                <button
                  key={f.path}
                  className="flex items-center gap-2 px-3 py-1 text-left text-[13.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                  title={`${STATUS_LABEL[key] || key}: ${f.path}`}
                  onClick={() => addTab(ws.id, { id: crypto.randomUUID(), type: "diff", path: f.path, title: `Δ ${f.path.split("/").pop()}` })}
                >
                  <span className="inline-flex h-4 min-w-[18px] items-center justify-center rounded px-1 text-[11.5px] font-semibold text-black"
                        style={{ background: STATUS_COLOR[key] || "var(--color-fg-dim)" }}>{key}</span>
                  <span className="truncate font-mono text-[12.5px]">{f.path}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer: Setup / Run / Terminal tabs + Run action. Collapsible.
          Height is store-backed + drag-resizable from the top edge. */}
      <footer
        className="relative flex shrink-0 flex-col border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]"
        style={{ height: footCollapsed ? 32 : footHeight }}
      >
        {/* Top-edge drag handle — only shown when the footer is expanded.
            Resizes the footer height; the file list above adapts via flex-1. */}
        {!footCollapsed && (
          <ResizeHandle
            direction="y"
            className="top-0"
            onDrag={(dy) => {
              const cur = useApp.getState().rightFooterHeight;
              const asideH = asideRef.current?.clientHeight ?? 600;
              // dy positive = drag down = shrink footer (since handle is on
              // footer's top edge). Clamp so neither side collapses.
              const next = Math.round(Math.max(80, Math.min(asideH - 120, cur - dy)));
              setFootHeight(next);
            }}
          />
        )}
        <div className="flex h-8 min-w-0 shrink-0 items-center gap-0.5 overflow-hidden border-b border-[var(--color-border-soft)] px-1.5">
          {/* Leftmost: toggle the bottom split terminal in the main area
              (same action as ⌘T). Active state latches when the split is
              open. Sits before the collapse chevron because the user wants
              the most-used action in the leftmost slot. */}
          <button
            onClick={() => toggleSplit(ws.id)}
            title={split ? "Close bottom split (⌘T)" : "Open bottom split terminal (⌘T)"}
            className={cn(
              "rounded p-1 transition-colors",
              split
                ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            <TerminalSquare className="h-4 w-4" />
          </button>
          <button
            onClick={() => setFootCollapsed(c => !c)}
            title={footCollapsed ? "Expand" : "Collapse"}
            className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            {footCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <FTab label="Setup" active={footTab === "setup"} onClick={() => { setFootTab("setup"); setFootCollapsed(false); }} />
          <FTab label="Run"   active={footTab === "run"}   onClick={() => { setFootTab("run");   setFootCollapsed(false); }} />
          {/* Terminal tab is opt-in: only appears once the user clicks the
              `+` icon below. Avoids auto-spawning a scratch shell on every
              workspace open (was the source of the earlier "stop opening
              terminal in bottom right" complaint). */}
          {footerTerm && (
            <FTab
              label="Terminal"
              active={footTab === "term"}
              onClick={() => { setFootTab("term"); setFootCollapsed(false); }}
              onClose={() => {
                useApp.getState().disableFooterTerm(ws.id);
                setFootTab("run");
              }}
            />
          )}
          {!footerTerm && (
            <button
              onClick={() => {
                useApp.getState().enableFooterTerm(ws.id);
                setFootTab("term");
                setFootCollapsed(false);
              }}
              title="New terminal in this panel"
              className="ml-0.5 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}

          {footTab !== "term" && (
            <RunToolbar
              ws={ws} project={project} kind={footTab as "setup" | "run"} run={footRun}
              compact={footerTerm}
              onStart={() => {
                useScriptRuns.getState().start(ws.id, footTab as "setup" | "run");
                setFootCollapsed(false);
                workspaceRunScriptStream(ws.id, footTab as "setup" | "run").catch(err =>
                  console.error("workspace_run_script_stream failed:", err));
              }}
              onStop={() => {
                workspaceStopScript(ws.id, footTab as "setup" | "run").catch(err =>
                  console.error("workspace_stop_script failed:", err));
              }}
            />
          )}
        </div>

        {!footCollapsed && (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {footTab !== "term" && (
              <ScriptStream
                wsId={ws.id} kind={footTab as "setup" | "run"} run={footRun}
                onStart={() => {
                  useScriptRuns.getState().start(ws.id, footTab as "setup" | "run");
                  workspaceRunScriptStream(ws.id, footTab as "setup" | "run").catch(err =>
                    console.error("workspace_run_script_stream failed:", err));
                }}
              />
            )}
            {/* Keep the AuxTerminal mounted whenever the user has enabled
                it for this workspace, regardless of which tab is currently
                visible — switching to Setup/Run should NOT respawn the
                shell. visibility:hidden preserves the PTY + scrollback. */}
            {footerTerm && (
              <div
                className="absolute inset-x-0 bottom-0"
                style={{
                  top: 0,
                  visibility: footTab === "term" ? "visible" : "hidden",
                  zIndex: footTab === "term" ? 1 : 0,
                }}
              >
                <AuxTerminal wsPath={ws.path} active={footTab === "term"} />
              </div>
            )}
          </div>
        )}
      </footer>
    </aside>
  );
}

function FTab({ label, active, onClick, onClose }: {
  label: string; active: boolean; onClick: () => void; onClose?: () => void;
}) {
  return (
    <div
      className={cn(
        // shrink-0 so tabs hold their width when the row gets cramped
        // (a sibling like RunToolbar grows instead) and rounded-md
        // keeps the underline-active treatment intact.
        "group flex shrink-0 items-center rounded-md text-[12.5px] transition-colors",
        active ? "text-[var(--color-fg)] border-b-2 border-[var(--color-accent)]" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
      )}
      style={active ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : undefined}
    >
      <button onClick={onClick} className="px-1.5 py-1">{label}</button>
      {onClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="ml-0.5 mr-0.5 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] group-hover:opacity-100"
          title="Close tab"
        ><X className="h-3 w-3" /></button>
      )}
    </div>
  );
}

/** Resolve a project's preview_url template against a workspace's port +
 *  path. Supports `$TERMIC_PORT`, `${TERMIC_PORT}`, `$PORT` (legacy), and
 *  `${TERMIC_WORKSPACE_NAME}`. Returns null if no template is set so the
 *  toolbar can hide the Open button. */
function expandPreviewUrl(project: Project | null, ws: Workspace): string | null {
  const tmpl = project?.preview_url?.trim();
  if (!tmpl) return `http://localhost:${ws.port}`;
  // Expand `$VAR` and `${VAR}` for the variables we set in run_script env.
  // Includes legacy `$CONDUCTOR_*` aliases so preview_url templates saved
  // under the old name keep working after the rename.
  const port = String(ws.port);
  return tmpl
    .replaceAll("${TERMIC_PORT}",            port)
    .replaceAll("$TERMIC_PORT",              port)
    .replaceAll("${CONDUCTOR_PORT}",         port)
    .replaceAll("$CONDUCTOR_PORT",           port)
    .replaceAll("${PORT}",                   port)
    .replaceAll("$PORT",                     port)
    .replaceAll("${TERMIC_WORKSPACE_NAME}",  ws.name)
    .replaceAll("$TERMIC_WORKSPACE_NAME",    ws.name)
    .replaceAll("${CONDUCTOR_WORKSPACE_NAME}", ws.name)
    .replaceAll("$CONDUCTOR_WORKSPACE_NAME",   ws.name);
}

/** Right-aligned toolbar group: Open (if URL known) + Run / Stop (toggles by
 *  current run status). Open is enabled regardless of status so users can hit
 *  their dev server preview the moment they remember the URL is sticky. */
function RunToolbar({ ws, project, kind, run, onStart, onStop, compact }: {
  ws: Workspace; project: Project | null; kind: "setup" | "run";
  run: { status: "idle" | "running" | "done" | "error" };
  onStart: () => void; onStop: () => void;
  /** When the footer is cramped (Terminal tab open, panel narrow),
   *  collapse buttons to icon-only with the label moved to the title.
   *  Saves ~50px per button which is enough to keep everything in the
   *  panel without overflow. */
  compact?: boolean;
}) {
  const url = expandPreviewUrl(project, ws);
  const running = run.status === "running";
  // Square button when icon-only; pill with label otherwise.
  const btnCls = compact ? "h-6 w-6 p-0" : "h-6 gap-1 px-1.5 text-[12px]";
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {kind === "run" && url && (
        <Button
          size="sm" variant="secondary"
          onClick={() => openPath(url).catch(err => console.error("open failed:", err))}
          title={compact ? `Open ${url}` : url}
          className={btnCls}
        >
          <Globe className="h-3 w-3" />
          {!compact && <span>Open</span>}
        </Button>
      )}
      {running ? (
        <Button
          size="sm" variant="secondary"
          onClick={onStop}
          title="Stop"
          // Red tint so Stop reads as a destructive control without taking
          // over the whole toolbar with a full-red `danger` variant.
          className={cn(btnCls, "text-[var(--color-err)] hover:text-[var(--color-err)]")}
        >
          <Square className="h-3 w-3 fill-current" />
          {!compact && <span>Stop</span>}
        </Button>
      ) : (
        <Button
          size="sm" variant="secondary"
          onClick={onStart}
          title={kind === "setup" ? "Run setup" : "Run"}
          className={btnCls}
        >
          <Play className="h-3 w-3" />
          {!compact && <span>{kind === "setup" ? "Run setup" : "Run"}</span>}
        </Button>
      )}
    </div>
  );
}

/** Stream pane: shows live captured stdout/stderr with auto-scroll-to-bottom
 *  unless the user has scrolled up (then we pause to respect their position).
 *  Idle state shows the original empty hint so the panel doesn't look broken
 *  before the first run. */
function ScriptStream({ wsId, kind, run, onStart }: {
  wsId: string; kind: "setup" | "run";
  run: { status: "idle" | "running" | "done" | "error"; lines: string[]; exitCode: number | null };
  onStart: () => void;
}) {
  void wsId;
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Track whether the user is pinned to the bottom. If they scroll up, stop
  // auto-following; resume the moment they scroll back to within 8px of the
  // bottom. Avoids ripping the viewport away while they're reading old lines.
  function onScroll() {
    const el = boxRef.current; if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  }
  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [run.lines]);

  if (run.status === "idle") {
    // Empty-state — big Play icon, heading, primary action with ⌘R hint.
    // Matches the Termic mockup exactly so users don't have to hunt the
    // small toolbar Run button on a fresh workspace.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Play className="h-10 w-10 text-[var(--color-fg-faint)] opacity-40" />
        <div className="text-[13.5px] font-medium text-[var(--color-fg)]">
          {kind === "setup" ? "No setup script output" : "No run script output"}
        </div>
        <Button size="sm" variant="secondary" onClick={onStart} className="gap-1.5">
          <Play className="h-3 w-3" />
          {kind === "setup" ? "Run setup" : "Run workspace"}
          <kbd className="ml-1 text-[10.5px] text-[var(--color-fg-faint)]">⌘R</kbd>
        </Button>
        <p className="text-[12px] text-[var(--color-fg-faint)]">
          {kind === "setup"
            ? "Setup script output will appear here after running setup."
            : "Test your changes here."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div
        ref={boxRef} onScroll={onScroll}
        data-selectable
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-snug text-[var(--color-fg-dim)]"
      >
        {run.lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-words">{line}</div>
        ))}
        {run.status === "done"  && <div className="mt-1 text-[var(--color-ok)]">✓ exited 0</div>}
        {run.status === "error" && <div className="mt-1 text-[var(--color-err)]">✗ exited {run.exitCode ?? "?"}</div>}
      </div>
    </div>
  );
}

// Conductor-style pill tab: active = filled bg + bright fg, inactive
// = plain dim text, hover = soft hover. Count appears as plain faint
// text alongside the label (no accent-colored badge pill) so a "0"
// reads as informational rather than urgent.
function RTab({ label, active, badge, onClick }: { label: string; active: boolean; badge?: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
          : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      {label}
      {badge !== undefined && (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-accent)] px-1.5 text-[11px] font-semibold leading-none text-white tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}
