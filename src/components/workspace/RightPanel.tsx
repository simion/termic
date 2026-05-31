// Right panel: tab between All Files (filesystem list) and Changes (git status).
// Click a file → opens an Editor tab in the main area. Click a change → diff tab.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useApp, useActiveWorkspace } from "@/store/app";
import {
  workspaceChanges, workspaceRunScriptStream, workspaceStopScript, openPath, repoConfigLoad,
} from "@/lib/ipc";
import type { Changes, Workspace, WorkspaceMember, Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Play, ChevronDown, ChevronUp, ChevronRight, TerminalSquare, Square, Globe, X, Plus, GitBranch, Link2, Wrench, Copy, Check, Settings } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { AuxTerminal } from "./AuxTerminal";
import { FileTree } from "./FileTree";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useScriptRuns, useRunState, type RunStatus } from "@/store/scriptRuns";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem } from "@/components/ui/Dropdown";

const STATUS_LABEL: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", "??": "untracked", "!!": "ignored", U: "conflict" };
const STATUS_COLOR: Record<string, string> = { M: "var(--color-accent)", A: "var(--color-ok)", D: "var(--color-err)", R: "var(--color-accent)", "??": "var(--color-ok)", U: "var(--color-err)" };
const STATUS_CHAR: Record<string, string> = { M: "M", A: "+", "??": "+", D: "D", R: "R", U: "U", "!!": "!" };

type FootTab = "setup" | "run" | "term";

// Footer collapse persists across launches. Component-local (no other
// component reads it) so it's localStorage-backed directly rather than
// pushed through the app store — same pattern as DiffPane's view mode.
const LS_FOOT_COLLAPSED = "rightFooterCollapsed";

export function RightPanel() {
  const ws = useActiveWorkspace();
  const addTab = useApp(s => s.addTab);
  const split = useApp(s => !!s.terminalSplit[ws?.id ?? ""]);
  const toggleSplit = useApp(s => s.toggleTerminalSplit);
  const [view, setView] = useState<"files" | "changes">("files");
  const [changes, setChanges] = useState<Changes>({ files: [], count: 0 });
  // Multi-repo workspaces add a Target selector to the footer so
  // Setup/Run can target a composition member. Stored as the
  // member's dir_name. Single-repo workspaces keep this empty
  // (legacy "host" path) since there are no members to target.
  // Default = first member for multi-repo, "" for single.
  const [footTarget, setFootTarget] = useState<string>("");
  useEffect(() => {
    // Pick the first member for multi-repo workspaces; legacy single
    // repo keeps "" (the project's own scripts run with empty member).
    const first = ws?.composition?.[0]?.dir_name ?? "";
    setFootTarget(first);
  }, [ws?.id]);
  // Footer holds Setup / Run status only. Scratch shells live in the
  // bottom-split (⇧⌘D) — having a second terminal slot here was redundant.
  const [footTab, setFootTab] = useState<FootTab>("run");
  // Expanded by default on a fresh install: the Setup / Run tabs are
  // useless when collapsed, and the bottom split is the dedicated
  // scratch-shell surface — nothing gained by hiding the footer on
  // first open. After that, the user's choice persists across launches.
  const [footCollapsed, setFootCollapsed] = useState(() => {
    try { return localStorage.getItem(LS_FOOT_COLLAPSED) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_FOOT_COLLAPSED, footCollapsed ? "1" : "0"); } catch {}
  }, [footCollapsed]);
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
    // Targets to subscribe to: host ("" — also covers single-repo
    // workspaces) + every composition member's dir_name. Each target
    // gets two channels (output + done) × two kinds (setup + run).
    const targets: string[] = ["", ...(ws.composition ?? []).map(m => m.dir_name)];
    (async () => {
      for (const member of targets) {
        for (const kind of ["setup", "run"] as const) {
          const u1 = await listen<{ line: string }>(`script-output://${wsId}:${member}:${kind}`, ev => {
            if (!cancelled) appendLine(wsId, kind, ev.payload.line, member);
          });
          const u2 = await listen<{ code: number | null; success: boolean }>(`script-done://${wsId}:${member}:${kind}`, ev => {
            if (!cancelled) finish(wsId, kind, ev.payload.code, ev.payload.success, member);
          });
          unlisteners.push(u1, u2);
        }
      }
    })();
    return () => { cancelled = true; unlisteners.forEach(u => u()); };
    // Re-subscribe if composition changes (frozen at create-time, so
    // this normally only fires once per workspace, but stringify the
    // composition for safety).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.id, ws?.composition?.map(m => m.dir_name).join("|")]);

  // Resolve project so we can expand `preview_url` for the Open button.
  const project = useApp(s => (ws ? s.projects.find(p => p.id === ws.project_id) ?? null : null));
  // Fallback preview URLs + setup scripts from each project's committed
  // .termic.yaml. Keyed by project_id so both single-repo and multi-repo
  // members resolve. Setup-script presence drives whether the toolbar
  // even shows a Setup button — projects with no setup configured (in
  // either the in-app config or .termic.yaml) hide it entirely.
  const [yamlPreviewUrls, setYamlPreviewUrls] = useState<Record<string, string>>({});
  const [yamlSetupScripts, setYamlSetupScripts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!ws) { setYamlPreviewUrls({}); setYamlSetupScripts({}); return; }
    const ids = [ws.project_id, ...(ws.composition ?? []).map(m => m.project_id)];
    const unique = [...new Set(ids)].filter(Boolean);
    Promise.all(unique.map(id =>
      repoConfigLoad(id)
        .then(rc => [id, rc?.scripts?.preview_url?.trim() ?? "", rc?.scripts?.setup?.trim() ?? ""] as const)
        .catch(() => [id, "", ""] as const),
    )).then(entries => {
      setYamlPreviewUrls(Object.fromEntries(entries.map(([id, url]) => [id, url])));
      setYamlSetupScripts(Object.fromEntries(entries.map(([id, , setup]) => [id, setup])));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.project_id, ws?.composition?.map(m => m.project_id).sort().join("|")]);
  const footerTerm = useApp(s => (ws ? !!s.footerTerm[ws.id] : false));
  const setupRunState = useRunState(ws?.id, "setup", footTarget);
  const runRunState   = useRunState(ws?.id, "run",   footTarget);
  // The Setup tab is transient: it only appears once Setup has been
  // invoked for this (workspace, target). Closing it resets the run
  // state back to idle and the tab disappears again.
  const showSetupTab = setupRunState.status !== "idle";
  const footRun = useRunState(ws?.id, footTab === "term" ? "run" : footTab, footTarget);

  // If the Setup tab vanishes (close button or workspace switch) while
  // the user is currently viewing it, fall back to Run so the footer
  // doesn't render an empty stream.
  useEffect(() => {
    if (!showSetupTab && footTab === "setup") setFootTab("run");
  }, [showSetupTab, footTab]);

  if (!ws) return null;

  // Shared start/stop. Setup auto-switches the footer view to the Setup
  // tab (which the user can close once they're done reading the log).
  const startScript = (kind: "setup" | "run") => {
    useScriptRuns.getState().start(ws.id, kind, footTarget);
    setFootCollapsed(false);
    // Snap the footer view to whichever stream we just started — otherwise
    // hitting Run while still on the Setup tab leaves the user staring at
    // an empty Setup log while output streams into the hidden Run tab.
    setFootTab(kind);
    workspaceRunScriptStream(ws.id, kind, footTarget || undefined).catch(err =>
      console.error("workspace_run_script_stream failed:", err));
  };
  const stopScript = (kind: "setup" | "run") => {
    useScriptRuns.getState().finish(ws.id, kind, null, false, footTarget);
    workspaceStopScript(ws.id, kind, footTarget || undefined).catch(err =>
      console.error("workspace_stop_script failed:", err));
  };

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
          <ChangesView
            ws={ws}
            changes={changes}
            onOpenDiff={(path) => useApp.getState().openPreviewTab(ws.id, { type: "diff", path, title: `Δ ${path.split("/").pop()}` })}
            onDoubleClickDiff={(path) => {
              const currentTabs = useApp.getState().tabs[ws.id] || [];
              const existing = currentTabs.find(t => t.type === "diff" && t.path === path);
              if (existing) {
                useApp.getState().persistTab(ws.id, existing.id);
              }
            }}
          />
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
        {(ws.composition?.length ?? 0) > 0 ? (
          // Multi-repo: NESTED tab strip.
          //   Row 1 = REPO targets (pydpf, shopilo, ...) + terminal.
          //   Row 2 = SETUP / RUN sub-tabs for the selected repo +
          //           Open / Run-Stop actions on the right.
          // Splitting into two thin rows keeps each item readable;
          // jamming all of it on one row was the prior "too crowded"
          // complaint.
          <>
            <div className={cn(
              "flex h-8 min-w-0 shrink-0 items-center gap-0.5 overflow-hidden px-1.5",
              // border-b separates the strip from the content below it.
              // Collapsed → no content below → drop it, else it stacks
              // with the footer's own border-t into a doubled line.
              !footCollapsed && "border-b border-[var(--color-border-soft)]",
            )}>
              <button
                onClick={() => setFootCollapsed(c => !c)}
                title={footCollapsed ? "Expand" : "Collapse"}
                className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
              >
                {footCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {/* Member targets. Tabs that fit render inline; the rest
                  collapse into a "+N" overflow menu so the strip never
                  spills and the Run-all / Open-all toolbar is never
                  clipped off the right edge. The active member is always
                  kept inline. */}
              <MemberTabStrip
                members={ws.composition!}
                wsId={ws.id}
                activeDir={footTab !== "term" ? footTarget : null}
                onSelect={(dir) => { setFootTab(footTab === "term" ? "run" : footTab); setFootTarget(dir); setFootCollapsed(false); }}
              />
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
              {/* Stack-level actions: Run all / Stop all / Open all
                  across every member at once. Lives on the right of
                  the target tab strip — same row as the targets so
                  the relationship is obvious ("these buttons
                  affect those tabs"). */}
              <AllMembersToolbar ws={ws} project={project} yamlPreviewUrls={yamlPreviewUrls} onExpand={() => setFootCollapsed(false)} />
            </div>
            {/* Row 2 — only for non-terminal targets (terminal has
                no setup/run, just the shell). */}
            {footTab !== "term" && !footCollapsed && (() => {
              // For Open: substitute the MEMBER's project + the
              // member's actual port into RunToolbar's context, so
              // expandPreviewUrl uses the right URL (otherwise it
              // falls back to ws.port = the host's 18103 even though
              // member services are on 18104/18105/...).
              const memberIdx = ws.composition!.findIndex(m => m.dir_name === footTarget);
              const m = memberIdx >= 0 ? ws.composition![memberIdx] : null;
              const memberProject = m
                ? (useApp.getState().projects.find(p => p.id === m.project_id) ?? null)
                : project;
              const memberPort = m
                ? (m.port && m.port > 0 ? m.port : ws.port + memberIdx + 1)
                : ws.port;
              const syntheticWs: Workspace = { ...ws, port: memberPort };
              return (
                <div className="flex h-8 min-w-0 shrink-0 items-center gap-0.5 overflow-hidden border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/50 px-1.5">
                  <FTab label="Run"   active={footTab === "run"}   onClick={() => setFootTab("run")} />
                  {showSetupTab && (
                    <FTab
                      label="Setup"
                      active={footTab === "setup"}
                      onClick={() => setFootTab("setup")}
                      onClose={() => {
                        useScriptRuns.getState().reset(ws.id, "setup", footTarget);
                        setFootTab("run");
                      }}
                    />
                  )}
                  <RunToolbar
                    ws={syntheticWs} project={memberProject} yamlPreviewUrl={yamlPreviewUrls[m?.project_id ?? ""]}
                    hasSetup={!!(m?.setup_script?.trim() || memberProject?.setup_script?.trim() || yamlSetupScripts[m?.project_id ?? ""]?.trim())}
                    setupStatus={setupRunState.status} runStatus={runRunState.status}
                    compact={footerTerm}
                    onSetupStart={() => startScript("setup")}
                    onSetupStop={()  => stopScript("setup")}
                    onRunStart={()   => startScript("run")}
                    onRunStop={()    => stopScript("run")}
                  />
                </div>
              );
            })()}
          </>
        ) : (
        <div className={cn(
          "flex h-8 min-w-0 shrink-0 items-center gap-0.5 overflow-hidden px-1.5",
          // Collapsed → nothing below the strip → drop border-b so it
          // doesn't stack with the footer's border-t into a double line.
          !footCollapsed && "border-b border-[var(--color-border-soft)]",
        )}>
          <button
            onClick={() => setFootCollapsed(c => !c)}
            title={footCollapsed ? "Expand" : "Collapse"}
            className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            {footCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <FTab label="Run"   active={footTab === "run"}   onClick={() => { setFootTab("run");   setFootCollapsed(false); }} />
          {showSetupTab && (
            <FTab
              label="Setup"
              active={footTab === "setup"}
              onClick={() => { setFootTab("setup"); setFootCollapsed(false); }}
              onClose={() => {
                useScriptRuns.getState().reset(ws.id, "setup", footTarget);
                setFootTab("run");
              }}
            />
          )}
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
          {footTab !== "term" && (
            <RunToolbar
              ws={ws} project={project} yamlPreviewUrl={yamlPreviewUrls[ws.project_id]}
              hasSetup={!!(project?.setup_script?.trim() || yamlSetupScripts[ws.project_id]?.trim())}
              setupStatus={setupRunState.status} runStatus={runRunState.status}
              compact={footerTerm}
              onSetupStart={() => startScript("setup")}
              onSetupStop={()  => stopScript("setup")}
              onRunStart={()   => startScript("run")}
              onRunStop={()    => stopScript("run")}
            />
          )}
        </div>
        )}

        {!footCollapsed && (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {footTab !== "term" && (() => {
              const activeMember = ws.composition?.find(m => m.dir_name === footTarget);
              const activeProjectId = activeMember?.project_id ?? ws.project_id;
              const hasRunScript = !!(activeMember
                ? activeMember.run_script?.trim()
                : project?.run_script?.trim());
              return (
                <ScriptStream
                  wsId={ws.id} kind={footTab as "setup" | "run"} run={footRun}
                  hasScript={footTab === "run"
                    ? hasRunScript
                    : !!(project?.setup_script?.trim() || yamlSetupScripts[ws.project_id]?.trim())}
                  dismissKey={footTab === "run" ? `hideRunPrompt:${activeProjectId}` : undefined}
                  onStart={() => {
                    const kind = footTab as "setup" | "run";
                    useScriptRuns.getState().start(ws.id, kind, footTarget);
                    workspaceRunScriptStream(ws.id, kind, footTarget || undefined).catch(err =>
                      console.error("workspace_run_script_stream failed:", err));
                  }}
                  onConfigure={footTab === "run"
                    ? () => useApp.getState().openSettings("repositories", activeProjectId)
                    : undefined}
                  onDismiss={footTab === "run" ? () => setFootCollapsed(true) : undefined}
                />
              );
            })()}
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
        "group flex shrink-0 items-center rounded-md text-[12.5px] transition-colors border-b-2",
        active ? "text-[var(--color-fg)] border-[var(--color-accent)]" : "text-[var(--color-fg-dim)] border-transparent hover:text-[var(--color-fg)]",
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

// Width reserved for the "+N" overflow trigger when some members don't
// fit. Slightly generous so a two-digit count never re-spills the strip.
const OVERFLOW_BTN_W = 50;
// gap-0.5 between strip children = 2px. Folded into each tab's effective
// width so the fit math accounts for inter-tab spacing.
const STRIP_GAP = 2;

/** Live run/setup status for a composition member, collapsed to one
 *  value for the status dot. Running and error are the only states worth
 *  surfacing; done/idle read as quiet. */
function memberRunStatus(runs: Record<string, { status: RunStatus }>, wsId: string, dir: string): RunStatus {
  const r = runs[`${wsId}:${dir}:run`]?.status;
  const s = runs[`${wsId}:${dir}:setup`]?.status;
  if (r === "running" || s === "running") return "running";
  if (r === "error" || s === "error") return "error";
  if (r === "done" || s === "done") return "done";
  return "idle";
}

/** Fixed-width status dot. Always occupies the same box (transparent when
 *  idle/done) so a tab's measured width never changes as scripts start or
 *  stop — keeps the overflow math from churning on every status change. */
function StatusDot({ status }: { status: RunStatus }) {
  const color = status === "running" ? "var(--color-ok)"
    : status === "error" ? "var(--color-err)"
    : "transparent";
  return (
    <span
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", status === "running" && "animate-pulse")}
      style={{ background: color }}
    />
  );
}

/** A single member target tab with a leading status dot. */
function MemberTab({ label, status, active, onClick }: {
  label: string; status: RunStatus; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border-b-2 px-1.5 py-1 text-[12.5px] transition-colors",
        active ? "text-[var(--color-fg)] border-[var(--color-accent)]" : "text-[var(--color-fg-dim)] border-transparent hover:text-[var(--color-fg)]",
      )}
      style={active ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : undefined}
    >
      <StatusDot status={status} />
      {label}
    </button>
  );
}

/** Member target strip with overflow handling.
 *
 *  Measures each member tab's natural width from an invisible layer, then
 *  greedily fills the strip's available width left-to-right. Members that
 *  don't fit drop into a "+N" dropdown. The active member is always kept
 *  inline (forced into the visible set first) so the user never loses
 *  sight of what they're targeting. Recomputes on panel resize via a
 *  ResizeObserver and re-measures when the member set or fonts change. */
function MemberTabStrip({ members, wsId, activeDir, onSelect }: {
  members: WorkspaceMember[];
  wsId: string;
  activeDir: string | null;
  onSelect: (dir: string) => void;
}) {
  const runs = useScriptRuns(s => s.runs);
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(0);
  const [tabWidths, setTabWidths] = useState<number[]>([]);

  // Track the strip's available width (already excludes the chevron,
  // Terminal tab, and Run-all toolbar — they're flex siblings, this is
  // flex-1 with min-w-0 so it gets exactly the leftover space).
  useEffect(() => {
    const el = stripRef.current; if (!el) return;
    setAvailW(el.clientWidth);
    const ro = new ResizeObserver(() => setAvailW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure each tab's natural width from the hidden layer. The dot slot
  // is fixed-width so status changes never alter these — re-measure only
  // when the member set changes (or once fonts settle, since glyph widths
  // shift between the fallback and Inter).
  const memberKey = members.map(m => m.dir_name).join("|");
  useEffect(() => {
    const measure = () => {
      const layer = measureRef.current; if (!layer) return;
      setTabWidths(Array.from(layer.children).map(c => (c as HTMLElement).offsetWidth));
    };
    measure();
    document.fonts?.ready.then(measure).catch(() => {});
  }, [memberKey]);

  const n = members.length;
  const activeIdx = activeDir ? members.findIndex(m => m.dir_name === activeDir) : -1;
  const ready = tabWidths.length === n && availW > 0;

  let visibleIdx = members.map((_, i) => i);
  let overflowIdx: number[] = [];
  if (ready) {
    const eff = tabWidths.map(w => w + STRIP_GAP);
    const total = eff.reduce((a, b) => a + b, 0);
    if (total > availW) {
      const budget = availW - OVERFLOW_BTN_W;
      const chosen = new Set<number>();
      let used = 0;
      // Reserve the active tab first so it always stays inline.
      if (activeIdx >= 0) { chosen.add(activeIdx); used += eff[activeIdx]; }
      for (let i = 0; i < n; i++) {
        if (chosen.has(i)) continue;
        if (used + eff[i] <= budget) { chosen.add(i); used += eff[i]; }
        else break; // keep the visible run contiguous from the left
      }
      visibleIdx = [...chosen].sort((a, b) => a - b);
      overflowIdx = members.map((_, i) => i).filter(i => !chosen.has(i));
    }
  }

  return (
    <div ref={stripRef} className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
      {/* Hidden measurement layer — identical markup to the real tabs so
          offsetWidth matches. h-0 + invisible keeps it out of layout and
          paint; the strip's overflow-hidden clips it. */}
      <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 flex h-0 items-center gap-0.5 whitespace-nowrap">
        {members.map(m => (
          <MemberTab key={m.dir_name} label={m.dir_name} status="idle" active={false} onClick={() => {}} />
        ))}
      </div>
      {visibleIdx.map(i => {
        const m = members[i];
        return (
          <MemberTab
            key={m.dir_name}
            label={m.dir_name}
            status={memberRunStatus(runs, wsId, m.dir_name)}
            active={activeIdx === i}
            onClick={() => onSelect(m.dir_name)}
          />
        );
      })}
      {overflowIdx.length > 0 && (
        <DropdownRoot>
          <DropdownTrigger asChild>
            <button
              title={`${overflowIdx.length} more`}
              className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[12.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
            >
              +{overflowIdx.length}<ChevronDown className="h-3 w-3" />
            </button>
          </DropdownTrigger>
          <DropdownMenu align="start">
            {overflowIdx.map(i => {
              const m = members[i];
              return (
                <DropdownItem key={m.dir_name} onSelect={() => onSelect(m.dir_name)} className="items-center gap-2">
                  <StatusDot status={memberRunStatus(runs, wsId, m.dir_name)} />
                  <span className="font-mono text-[12.5px]">{m.dir_name}</span>
                </DropdownItem>
              );
            })}
          </DropdownMenu>
        </DropdownRoot>
      )}
    </div>
  );
}

/** Resolve a project's preview_url template against a workspace's port +
 *  path. Supports `$TERMIC_PORT`, `${TERMIC_PORT}`, `$PORT` (legacy), and
 *  `${TERMIC_WORKSPACE_NAME}`. Returns null if no template is set so the
 *  toolbar can hide the Open button. */
function expandPreviewUrl(project: Project | null, ws: Workspace, yamlUrl = ""): string | null {
  const tmpl = project?.preview_url?.trim() || yamlUrl.trim();
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

/** Right-aligned toolbar group: Setup / Run / Open. Setup and Run each toggle
 *  to Stop when their script is running; Open is always enabled when a preview
 *  URL is known so users can hit the dev server preview the moment they want.
 *  Setup is one-shot in practice (run at create-time) but kept available for
 *  re-runs after dep bumps or script edits — its output streams into a
 *  transient Setup tab that only appears post-invocation. */
function RunToolbar({ ws, project, yamlPreviewUrl = "", hasSetup, setupStatus, runStatus, onSetupStart, onSetupStop, onRunStart, onRunStop, compact }: {
  ws: Workspace; project: Project | null; yamlPreviewUrl?: string;
  /** Whether a setup script is configured for this project/member — gates
   *  the Setup button entirely. Projects without setup (e.g. simple
   *  scratch repos) get a tidier toolbar. */
  hasSetup: boolean;
  setupStatus: "idle" | "running" | "done" | "error";
  runStatus: "idle" | "running" | "done" | "error";
  onSetupStart: () => void; onSetupStop: () => void;
  onRunStart: () => void; onRunStop: () => void;
  /** When the footer is cramped (Terminal tab open, panel narrow),
   *  collapse buttons to icon-only with the label moved to the title.
   *  Saves ~50px per button which is enough to keep everything in the
   *  panel without overflow. */
  compact?: boolean;
}) {
  const url = expandPreviewUrl(project, ws, yamlPreviewUrl);
  const setupRunning = setupStatus === "running";
  const runRunning = runStatus === "running";
  const btnCls = compact ? "h-6 w-6 p-0" : "h-6 gap-1 px-1.5 text-[12px]";
  const stopCls = cn(btnCls, "text-[var(--color-err)] hover:text-[var(--color-err)]");
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {hasSetup && (setupRunning ? (
        <Button size="sm" variant="secondary" onClick={onSetupStop} title="Stop setup" className={stopCls}>
          <Square className="h-3 w-3 fill-current" />
          {!compact && <span>Stop setup</span>}
        </Button>
      ) : (
        <Button size="sm" variant="secondary" onClick={onSetupStart} title="Run setup" className={btnCls}>
          <Wrench className="h-3 w-3" />
          {!compact && <span>Setup</span>}
        </Button>
      ))}
      {runRunning ? (
        <Button size="sm" variant="secondary" onClick={onRunStop} title="Stop" className={stopCls}>
          <Square className="h-3 w-3 fill-current" />
          {!compact && <span>Stop</span>}
        </Button>
      ) : (
        <Button size="sm" variant="secondary" onClick={onRunStart} title="Run" className={btnCls}>
          <Play className="h-3 w-3" />
          {!compact && <span>Run</span>}
        </Button>
      )}
      {url && (
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
      {url && <CopyUrlButton url={url} />}
    </div>
  );
}

/** Icon-only "copy preview URL" button. Flashes a checkmark for ~1.2s after
 *  copy so the user gets feedback without a toast. Tooltip carries the URL
 *  so users can see what's about to be copied before clicking. */
function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.error("clipboard write failed:", err);
    }
  };
  return (
    <Tip content={copied ? "Copied" : `Copy ${url}`} side="top">
      <Button size="sm" variant="secondary" onClick={doCopy} className="h-6 w-6 p-0">
        {copied
          ? <Check className="h-3 w-3 text-[var(--color-ok)]" />
          : <Copy  className="h-3 w-3" />}
      </Button>
    </Tip>
  );
}

// Strip ANSI escape sequences + lone control bytes from a line so
// the script-output pane shows readable text instead of raw color
// codes (the agents and tooling like pnpm emit a lot of SGR codes
// like \x1b[38;5;208m). We don't render colors yet — just clean the
// noise. Switch to a parser (anser, ansi-to-html) when colored
// output becomes a feature request.
function stripAnsi(s: string): string {
  return s
    // CSI: ESC [ ... <final byte 0x40-0x7E>
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    // OSC: ESC ] ... BEL  (window title sequences etc.)
    .replace(/\][^]*/g, "")
    // DCS/SOS/PM/APC: ESC <P|X|^|_> ... ESC \
    .replace(/[PX^_][\s\S]*?\\/g, "")
    // Stray control bytes (NUL, BEL, BS, SO, SI, etc.) except
    // tab / LF / CR which the renderer wants to preserve.
    .replace(/[ --]/g, "");
}

/** Stream pane: shows live captured stdout/stderr with auto-scroll-to-bottom
 *  unless the user has scrolled up (then we pause to respect their position).
 *  Idle state shows the original empty hint so the panel doesn't look broken
 *  before the first run. */
function ScriptStream({ wsId, kind, run, hasScript, dismissKey, onStart, onConfigure, onDismiss }: {
  wsId: string; kind: "setup" | "run";
  run: { status: "idle" | "running" | "done" | "error"; lines: string[]; exitCode: number | null };
  hasScript: boolean;
  dismissKey?: string;
  onStart: () => void;
  onConfigure?: () => void;
  onDismiss?: () => void;
}) {
  void wsId;
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [dismissed, setDismissed] = useState(() => {
    if (!dismissKey) return false;
    try { return localStorage.getItem(dismissKey) === "1"; } catch { return false; }
  });

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

  function handleDismiss() {
    if (dismissKey) { try { localStorage.setItem(dismissKey, "1"); } catch {} }
    setDismissed(true);
    onDismiss?.();
  }

  if (run.status === "idle") {
    if (!hasScript && kind === "run" && !dismissed) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <Settings className="h-8 w-8 text-[var(--color-fg-faint)] opacity-40" />
          <div className="text-[13.5px] font-medium text-[var(--color-fg)]">No run script configured</div>
          <p className="text-[12px] text-[var(--color-fg-faint)]">
            Add a run script in project settings to start your dev server here.
          </p>
          <div className="flex flex-col items-center gap-1.5">
            {onConfigure && (
              <Button size="sm" variant="secondary" onClick={onConfigure} className="gap-1.5">
                <Settings className="h-3 w-3" /> Configure project
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={handleDismiss} className="text-[var(--color-fg-faint)]">
              No thanks
            </Button>
          </div>
        </div>
      );
    }
    // Empty-state — big Play icon, heading, primary action with ⌘R hint.
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
          <div key={i} className="whitespace-pre-wrap break-words">{stripAnsi(line)}</div>
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

/** Changes view. For single-repo workspaces the file list is flat
 *  (one host group). For multi-repo workspaces it splits into
 *  collapsible per-repo sections — host first, then each composition
 *  member with the branch shown next to the dir name. Files inside a
 *  repo_root group are non-clickable (their canonical path resolves
 *  outside the wrapper and the safe_workspace_path check rejects
 *  them, so opening would fail with a confusing error). */
function ChangesView({ ws, changes, onOpenDiff, onDoubleClickDiff }: {
  ws: Workspace;
  changes: Changes;
  onOpenDiff: (path: string) => void;
  onDoubleClickDiff: (path: string) => void;
}) {
  const groups = changes.groups ?? [];
  // Single-repo workspaces look exactly like before: flat list, no
  // section header. We detect that by group count + the single group
  // being the host, and fall back to the legacy renderer.
  const isMulti = groups.length > 1;

  // Per-group collapse state — host expanded by default, members
  // expanded only when they have changes. Re-derives on changes object
  // identity so a workspace switch starts fresh.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const g of groups) {
      // Collapse empty-by-default for tidy first impression; expand
      // groups with changes so the user lands looking at actual files.
      next[g.name] = g.files.length === 0;
    }
    setCollapsed(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id]);

  if (changes.count === 0) {
    return (
      <div className="px-3 py-3 text-[13.5px] text-[var(--color-fg-faint)]">
        No changes — working tree is clean.
      </div>
    );
  }

  if (!isMulti) {
    // Legacy flat list path (single-repo, repo-root, or empty
    // composition). Files are top-level since `groups` may be missing
    // from older backends; fall back to `changes.files` if so.
    const flat = groups[0]?.files ?? changes.files;
    return (
      <div className="flex flex-col">
        {flat.map(f => <ChangeRow key={f.path} file={f} onOpen={onOpenDiff} onDoubleClick={onDoubleClickDiff} clickable />)}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {groups.map(g => {
        const isCollapsed = collapsed[g.name] ?? false;
        // Members in repo_root mode point at the live checkout. Their
        // files canonicalize outside the wrapper, so we disable the
        // diff click (it would fail safe_workspace_path) and add a
        // "live" badge so the user knows.
        const clickable = g.kind !== "repo_root";
        const KindIcon = g.kind === "repo_root" ? Link2 : GitBranch;
        return (
          <div key={g.name} className="flex flex-col">
            <button
              type="button"
              onClick={() => setCollapsed(prev => ({ ...prev, [g.name]: !prev[g.name] }))}
              className="flex items-center gap-2 px-3 py-1.5 text-left text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
            >
              {isCollapsed
                ? <ChevronRight className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
                : <ChevronDown  className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />}
              <span className="flex-1 truncate">{g.name}</span>
              {g.branch && (
                <span className="flex items-center gap-1 font-mono text-[11px] normal-case text-[var(--color-fg-faint)]">
                  <KindIcon className="h-3 w-3" /> {g.branch}
                </span>
              )}
              {g.kind === "repo_root" && (
                <span className="rounded bg-[var(--color-warn)]/15 px-1.5 text-[10px] uppercase tracking-wider text-[var(--color-warn)]">live</span>
              )}
              <span className="tabular-nums text-[11px] text-[var(--color-fg-faint)]">{g.files.length}</span>
            </button>
            {!isCollapsed && g.files.length > 0 && (
              <div className="flex flex-col pb-1">
                {g.files.map(f => (
                  <ChangeRow
                    key={f.path}
                    file={f}
                    onOpen={onOpenDiff}
                    onDoubleClick={onDoubleClickDiff}
                    clickable={clickable}
                  />
                ))}
              </div>
            )}
            {!isCollapsed && g.files.length === 0 && (
              <div className="px-8 pb-1 text-[12px] text-[var(--color-fg-faint)]">clean</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChangeRow({ file, onOpen, onDoubleClick, clickable }: {
  file: { status: string; path: string };
  onOpen: (p: string) => void;
  onDoubleClick: (p: string) => void;
  clickable: boolean;
}) {
  const key = file.status.length > 1 ? file.status : file.status.trim() || "M";
  return (
    <button
      type="button"
      disabled={!clickable}
      className={cn(
        "flex items-center gap-2 px-3 py-1 text-left text-[13.5px] text-[var(--color-fg-dim)]",
        clickable
          ? "hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] cursor-pointer"
          : "cursor-default opacity-75",
      )}
      title={clickable
        ? `${STATUS_LABEL[key] || key}: ${file.path}`
        : `${STATUS_LABEL[key] || key}: ${file.path} — open via terminal (live checkout, no in-app diff)`
      }
      onClick={() => clickable && onOpen(file.path)}
      onDoubleClick={() => clickable && onDoubleClick(file.path)}
    >
      <span className="inline-flex h-4 min-w-[18px] items-center justify-center rounded px-1 text-[11.5px] font-semibold text-black"
            style={{ background: STATUS_COLOR[key] || "var(--color-fg-dim)" }}>{STATUS_CHAR[key] || key}</span>
      <span className="truncate font-mono text-[12.5px]">{file.path}</span>
    </button>
  );
}

// TargetSelector was the previous pill-style chooser; replaced by
// per-target FTabs in the footer top row for multi-repo workspaces.

/** Stack-level toolbar for multi-repo workspaces: fires Run, Stop,
 *  and Open across every member at once. Lives next to the per-
 *  member tab strip so the relationship is visible ("these buttons
 *  control all of those tabs"). Per-member RunToolbar (Row 2) stays
 *  for individual control. */
function AllMembersToolbar({ ws, project, yamlPreviewUrls, onExpand }: {
  ws: Workspace;
  project: Project | null;
  yamlPreviewUrls: Record<string, string>;
  onExpand: () => void;
}) {
  // Project is the multi-repo HOST project. We need each member
  // project to look up its own preview_url for "Open all".
  const allProjects = useApp(s => s.projects);
  // Live run state across all members so the toolbar can decide
  // whether to show Run-all vs Stop-all when some/all are running.
  // For simplicity always show all three buttons; status badge on
  // each member tab (future) handles "which is running".
  const members = ws.composition ?? [];
  if (members.length === 0) return null;

  const fireOne = (kind: "setup" | "run", dir: string) => {
    useScriptRuns.getState().start(ws.id, kind, dir);
    workspaceRunScriptStream(ws.id, kind, dir).catch(err =>
      console.error("workspace_run_script_stream failed:", err));
  };
  const stopOne = (kind: "setup" | "run", dir: string) => {
    useScriptRuns.getState().finish(ws.id, kind, null, false, dir);
    workspaceStopScript(ws.id, kind, dir).catch(err =>
      console.error("workspace_stop_script failed:", err));
  };

  const runAll = () => {
    onExpand();
    for (const m of members) {
      if (m.run_script && m.run_script.trim()) fireOne("run", m.dir_name);
    }
  };
  const stopAll = () => {
    for (const m of members) {
      stopOne("run", m.dir_name);
      // Also try the setup lane in case a long-running setup is
      // still going (rare but cheap to be safe).
      stopOne("setup", m.dir_name);
    }
  };
  const openAll = () => {
    // Each member's preview URL uses its own project's preview_url
    // template, expanded with the member's per-member port (so two
    // members on PORT=$TERMIC_PORT npm run dev open the right URLs).
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const mp = allProjects.find(p => p.id === m.project_id);
      const port = m.port && m.port > 0 ? m.port : ws.port + i + 1;
      // Synthesize a Workspace-shaped object so expandPreviewUrl
      // can swap $TERMIC_PORT for the member's port instead of the
      // workspace's. Cheap; the function only reads .port + .name.
      const synthetic: Workspace = { ...ws, port };
      const url = expandPreviewUrl(mp ?? null, synthetic, yamlPreviewUrls[m.project_id]);
      if (url) openPath(url).catch(err => console.error("openPath failed:", err));
    }
  };
  // Skip the OPEN button on workspaces where no member has a
  // preview_url (personal or yaml) — avoids opening a wave of
  // `http://localhost:<port>` defaults at the user.
  void project;
  const anyPreview = members.some(m => {
    const mp = allProjects.find(p => p.id === m.project_id);
    return !!mp?.preview_url?.trim() || !!yamlPreviewUrls[m.project_id];
  });

  // Toggle Run all ↔ Stop all based on whether any member is
  // currently running. Showing both at once doubles the toolbar
  // width and lets the user click Stop with nothing running.
  const runsMap = useScriptRuns(s => s.runs);
  const anyRunning = members.some(m =>
    ["run", "setup"].some(kind => runsMap[`${ws.id}:${m.dir_name}:${kind}`]?.status === "running"),
  );
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5 border-l border-[var(--color-border-soft)] pl-1.5">
      {!anyRunning && (
      <Tip content="Run all members' run scripts in parallel" side="top">
        <button
          type="button"
          onClick={runAll}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <Play className="h-3 w-3" /> Run all
        </button>
      </Tip>
      )}
      {anyRunning && (
      <Tip content="SIGTERM every member's running script (setup + run)" side="top">
        <button
          type="button"
          onClick={stopAll}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-err)]"
        >
          <Square className="h-3 w-3 fill-current" /> Stop all
        </button>
      </Tip>
      )}
      {anyPreview && (
        <Tip content="Open every member's preview URL in the browser" side="top">
          <button
            type="button"
            onClick={openAll}
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            <Globe className="h-3 w-3" /> Open all
          </button>
        </Tip>
      )}
    </div>
  );
}
