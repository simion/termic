// Right panel: tab between All Files (filesystem list) and Git (Fork-style
// staging). Click a file → opens an Editor tab in the main area. Click a
// change → diff tab.

import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp, useActiveTask } from "@/store/app";
import { useUI } from "@/store/ui";
import {
  taskGitStatus, taskRunScriptStream, openPath, repoConfigLoad, repoConfigLoadAt,
  taskSpotlightResync,
} from "@/lib/ipc";
import { startSpotlight, stopSpotlight } from "@/lib/spotlight";
import { launchRunTabs, expandPreviewUrl } from "@/lib/runTabs";
import type { GitStatus, Task, TaskMember, Project, TerminalTab } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Play, ChevronDown, ChevronUp, Square, Globe, X, AudioWaveform, RefreshCw, Copy, Check, Settings, SquareArrowOutUpRight, PanelBottom } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { AuxTerminal } from "./AuxTerminal";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useScriptRuns, useRunState } from "@/store/scriptRuns";

/** Stable key for a composition member's `.termic.yaml` config maps.
 *  Inline members have no project id — key by their repo path (falling
 *  back to dir_name for legacy records that predate `repo_path`). */
const memberKey = (m: TaskMember) => m.repo_path || m.dir_name;

/** Tauri event names reject dots and other punctuation. Keep the app's
 *  user-facing member dir_name unchanged, but hex-encode it inside event
 *  topics so members like `phohanoi.ro` can stream setup/run output. */
function scriptTopicMember(member: string): string {
  if (!member) return "";
  return Array.from(new TextEncoder().encode(member))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

type FootTab = "setup" | "run" | "term" | "spotlight";

// Footer collapse persists across launches. Component-local (no other
// component reads it) so it's localStorage-backed directly rather than
// pushed through the app store — same pattern as DiffPane's view mode.

export function RightPanel() {
  const task = useActiveTask();
  const addTab = useApp(s => s.addTab);
  const split = useApp(s => !!s.terminalSplit[task?.id ?? ""]);
  const toggleSplit = useApp(s => s.toggleTerminalSplit);
  const [view, setView] = useState<"files" | "changes">("files");
  // A reveal-in-tree request (editor breadcrumb / locate button) forces the
  // "All files" view so the tree is on screen for FileTree to expand/scroll.
  const revealFile = useApp(s => s.revealFile);
  useEffect(() => {
    if (revealFile && task && revealFile.taskId === task.id) setView("files");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealFile, task?.id]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  // Bumped by the header refresh button to force the FileTree to re-read
  // from disk. The Git side re-fetches via refreshGit() in the same click.
  const [fileTreeReload, setFileTreeReload] = useState(0);
  // Global reload signal (bumped from Settings when exclude patterns change,
  // since the tree is hidden behind the Settings overlay then). Folded into
  // the local token so either source forces a re-read.
  const fileTreeNonce = useUI(s => s.fileTreeNonce);
  // Bumped when an agent terminal in this task settles (app store). Drives
  // the file tree + Git refresh below so on-disk changes appear without a
  // window focus cycle or the 4s poll, and without a heavy FS watcher.
  const fsRevision = useApp(s => (task ? s.fsRevision[task.id] ?? 0 : 0));
  // Lighter sibling: git-status-only tick (editor save, tree rename/delete).
  // Refreshes the Git tab without forcing the tree or open editors to re-read.
  const gitRevision = useApp(s => (task ? s.gitRevision[task.id] ?? 0 : 0));
  // Bumped on window refocus (rate-limited) so files changed externally
  // while away show up in the tree. Folded into FileTree's reloadToken;
  // its sameChildren gate makes the no-change case render-free.
  const [focusReload, setFocusReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Multi-repo tasks add a Target selector to the footer so
  // Setup/Run can target a composition member. Stored as the
  // member's dir_name. Single-repo tasks keep this empty
  // (legacy "host" path) since there are no members to target.
  // Default = first member for multi-repo, "" for single.
  const [footTarget, setFootTarget] = useState<string>("");
  useEffect(() => {
    // Pick the first member for multi-repo tasks; legacy single
    // repo keeps "" (the project's own scripts run with empty member).
    const first = task?.composition?.[0]?.dir_name ?? "";
    setFootTarget(first);
  }, [task?.id]);
  // Footer holds Setup / Run status only. Scratch shells live in the
  // bottom-split (⇧⌘D) — having a second terminal slot here was redundant.
  const [footTab, setFootTab] = useState<FootTab>("run");
  // ALWAYS starts collapsed: runs live in terminal tabs now, so the footer
  // is mostly the Spotlight strip. It auto-expands when spotlight starts
  // (see the isSpotlighted effect) or when the user clicks a tab.
  const [footCollapsed, setFootCollapsed] = useState(true);
  // Footer height + right-panel width come from the persistent app store so
  // values survive reloads and can be set by the two drag handles below.
  const footHeight        = useApp(s => s.rightFooterHeight);
  const setFootHeight     = useApp(s => s.setRightFooterHeight);
  const asideRef = useRef<HTMLElement>(null);
  // The footer action toolbar (Setup / Stop / Open) clips off the right
  // edge on a narrow right panel. We collapse it to icon-only below a
  // width threshold (the same `compact` treatment used when the Terminal
  // tab is open). Measured live so it tracks panel resizes and window
  // size changes, not just a one-shot read.
  const [asideWidth, setAsideWidth] = useState(0);
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    setAsideWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setAsideWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Swap a fresh status in ONLY when it actually differs. The 4s poll
  // mostly returns an identical payload; keeping the previous reference
  // skips the RightPanel + GitPanel re-render that a fresh object would
  // force every tick. Deterministic serialization (serde preserves field
  // order) makes the stringify compare sound, and the per-file `fp`
  // fingerprints mean any content change defeats it.
  const applyGitStatus = React.useCallback((next: GitStatus) => {
    setGitStatus(prev =>
      prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
  }, []);

  // Poll git status (staged/unstaged split) for the Git tab badges + panel.
  // The fetch is reused by GitPanel via the `refreshGit` callback so a
  // stage/unstage/commit reflects immediately instead of waiting for the
  // 4s tick.
  const refreshGit = React.useCallback(() => {
    if (!task) return;
    taskGitStatus(task.id).then(applyGitStatus).catch(() => {});
  }, [task?.id, applyGitStatus]);

  // Window focus mirror for gating the poll. Tauri's onFocusChanged (not
  // DOM focus/blur): proven reliable in this webview (useAttentionNotifier
  // uses the same event). A ref, not state — a focus flip must not re-run
  // the poll effect, just steer the next tick.
  const winFocused = useRef(true);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const u = await getCurrentWindow().onFocusChanged(({ payload }) => {
          winFocused.current = payload;
        });
        if (!alive) u(); else unlisten = u;
      } catch { /* keep polling unconditionally if the event isn't available */ }
    })();
    return () => { alive = false; unlisten?.(); };
  }, []);

  // Clear + reload ONLY on a real task switch (task.id), not on every
  // task-object re-patch (window refocus, attention/settled updates re-create the
  // object) — clearing then flashed the Git panel to "Loading…". The poll and
  // the focus refresh below swap fresh status in WITHOUT clearing.
  // Ticks are skipped while the window is unfocused (3 git subprocesses per
  // repo per tick add up in the background); the focus handler below does
  // the catch-up fetch on return.
  useEffect(() => {
    if (!task) { setGitStatus(null); return; }
    setGitStatus(null);
    taskGitStatus(task.id).then(setGitStatus).catch(() => {});
    const id = window.setInterval(() => {
      if (!winFocused.current) return;
      taskGitStatus(task.id).then(applyGitStatus).catch(() => {});
    }, 4000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  // Window regained focus: the user may have run git in an external terminal
  // while away. Refresh in place (no clear, no "Loading…" flash), and give
  // the file tree a rate-limited nudge so externally created/deleted files
  // appear too (its sameChildren gate keeps the no-change case free). The
  // limiter absorbs rapid Cmd+Tab flips.
  const lastFocusReloadAt = useRef(0);
  useEffect(() => {
    if (!task) return;
    const onFocus = () => {
      refreshGit();
      const now = Date.now();
      if (now - lastFocusReloadAt.current > 3000) {
        lastFocusReloadAt.current = now;
        setFocusReload(n => n + 1);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [task?.id, refreshGit]);

  // Agent terminal settled (fsRevision) or a git-only mutation happened
  // (gitRevision: editor save, tree rename/delete) → refresh git status in
  // place. Skip the first run (initial fetch above already covers it).
  const fsGitFirst = useRef(true);
  useEffect(() => {
    if (fsGitFirst.current) { fsGitFirst.current = false; return; }
    refreshGit();
  }, [fsRevision, gitRevision, refreshGit]);

  // Header refresh button: re-read both the file tree and git status. The
  // brief `refreshing` flag spins the icon for feedback.
  const doRefresh = () => {
    refreshGit();
    setFileTreeReload(n => n + 1);
    setRefreshing(true);
    window.setTimeout(() => setRefreshing(false), 600);
  };

  // Subscribe to streaming output for BOTH setup and run kinds on the active
  // task. We want output to keep flowing even when the user switches
  // footer tabs or briefly looks at the file tree — listeners stay mounted
  // for as long as the task is active.
  useEffect(() => {
    if (!task) return;
    const taskId = task.id;
    const { appendLine, finish } = useScriptRuns.getState();
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    // Targets to subscribe to: host ("" — also covers single-repo
    // tasks) + every composition member's dir_name. Each target
    // gets two channels (output + done) × two kinds (setup + run).
    const targets: string[] = ["", ...(task.composition ?? []).map(m => m.dir_name)];
    (async () => {
      for (const member of targets) {
        const topicMember = scriptTopicMember(member);
        for (const kind of ["setup", "run"] as const) {
          const u1 = await listen<{ line: string }>(`script-output://${taskId}:${topicMember}:${kind}`, ev => {
            if (!cancelled) appendLine(taskId, kind, ev.payload.line, member);
          });
          const u2 = await listen<{ code: number | null; success: boolean }>(`script-done://${taskId}:${topicMember}:${kind}`, ev => {
            if (cancelled) return;
            finish(taskId, kind, ev.payload.code, ev.payload.success, member);
            // A finished setup/run has usually written to disk (deps,
            // lockfiles, build output) — fan out the same refresh an agent
            // settle does. Consumers dedupe, so a no-op script is cheap.
            useApp.getState().bumpFsRevision(taskId);
          });
          unlisteners.push(u1, u2);
        }
      }
    })();
    return () => { cancelled = true; unlisteners.forEach(u => u()); };
    // Re-subscribe if composition changes (frozen at create-time, so
    // this normally only fires once per task, but stringify the
    // composition for safety).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.composition?.map(m => m.dir_name).join("|")]);

  // Resolve project so we can expand `preview_url` for the Open button.
  const project = useApp(s => (task ? s.projects.find(p => p.id === task.project_id) ?? null : null));
  // Fallback preview URLs + setup scripts from each repo's committed
  // .termic.yaml. Keyed by the host's project_id and, for multi-repo
  // members, by `memberKey` (their repo path) — inline members aren't
  // registered projects, so they load their `.termic.yaml` by path.
  // Setup-script presence drives whether the toolbar even shows a Setup
  // button — repos with no setup configured hide it entirely.
  const [yamlPreviewUrls, setYamlPreviewUrls] = useState<Record<string, string>>({});
  const [yamlSetupScripts, setYamlSetupScripts] = useState<Record<string, string>>({});
  const [yamlRunScripts, setYamlRunScripts] = useState<Record<string, string>>({});
  // Re-reads on `fileTreeNonce` too: Settings bumps it after writing a
  // `.termic.yaml` change, so the Setup/Run tabs pick up scripts edited
  // behind the Settings overlay without needing a task switch.
  useEffect(() => {
    if (!task) { setYamlPreviewUrls({}); setYamlSetupScripts({}); setYamlRunScripts({}); return; }
    // Host loads by project id; each member loads its .termic.yaml by path.
    const loaders: Array<Promise<readonly [string, string, string, string]>> = [
      repoConfigLoad(task.project_id)
        .then(rc => [task.project_id, rc?.scripts?.preview_url?.trim() ?? "", rc?.scripts?.setup?.trim() ?? "", rc?.scripts?.run?.trim() ?? ""] as const)
        .catch(() => [task.project_id, "", "", ""] as const),
    ];
    for (const m of task.composition ?? []) {
      const key = memberKey(m);
      if (!m.repo_path) continue;
      loaders.push(
        repoConfigLoadAt(m.repo_path)
          .then(rc => [key, rc?.scripts?.preview_url?.trim() ?? "", rc?.scripts?.setup?.trim() ?? "", rc?.scripts?.run?.trim() ?? ""] as const)
          .catch(() => [key, "", "", ""] as const),
      );
    }
    Promise.all(loaders).then(entries => {
      setYamlPreviewUrls(Object.fromEntries(entries.map(([id, url]) => [id, url])));
      setYamlSetupScripts(Object.fromEntries(entries.map(([id, , setup]) => [id, setup])));
      setYamlRunScripts(Object.fromEntries(entries.map(([id, , , run]) => [id, run])));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.project_id, task?.composition?.map(m => m.repo_path || m.dir_name).sort().join("|"), fileTreeNonce]);
  const footerTerm = useApp(s => (task ? !!s.footerTerm[task.id] : false));
  // Icon-only toolbar when the Terminal tab is open (the tab strip eats
  // horizontal room) OR the panel is simply narrow. ~380px is where the
  // full-text Setup / Stop / Open buttons (plus the Copy-URL icon and the
  // Run / Setup tabs) stop fitting; below it the labels clip off the edge.
  const compactToolbar = footerTerm || (asideWidth > 0 && asideWidth < 380);
  const setupRunState = useRunState(task?.id, "setup", footTarget);
  // The Setup tab is transient: it only appears once Setup has been
  // invoked for this (task, target). Closing it resets the run
  // state back to idle and the tab disappears again.
  const showSetupTab = setupRunState.status !== "idle";
  const footRun = useRunState(task?.id, footTab === "term" ? "run" : (footTab === "spotlight" ? "run" : footTab), footTarget);

  // ── spotlight ──────────────────────────────────────────────────
  // Available for single-repo, non-root, spotlight-enabled tasks.
  const isSpotlighted = useApp(s => task ? s.spotlightTaskId[task.project_id] === task.id : false);
  // Spotlight syncs a worktree's changes back to the repo root, so it's
  // worktree-only: never for repo-root, multi-repo, or non-git tasks.
  const spotlightAvailable = !!task && !task.is_main_checkout
    && !!project?.spotlight_enabled
    && project?.type !== "multi"
    && !project?.non_git;

  // Sync log: array of timestamped entries shown in the Spotlight tab.
  const [spotlightLog, setSpotlightLog] = useState<Array<{ time: Date; msg: string; error?: boolean }>>([]);
  const addSpotlightLog = (msg: string, error = false) =>
    setSpotlightLog(prev => [...prev.slice(-199), { time: new Date(), msg, error }]);

  // Listen to spotlight events for this task.
  useEffect(() => {
    if (!task) return;
    const projectId = task.project_id;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    (async () => {
      const u1 = await listen<{
        project_id: string; ws_id: string;
        committed_files: string[]; uncommitted_files: string[]; untracked_files: string[];
      }>(
        "spotlight://synced",
        ev => {
          if (cancelled || ev.payload.project_id !== projectId || ev.payload.ws_id !== task.id) return;
          const { committed_files, uncommitted_files, untracked_files } = ev.payload;
          // Union of all synced paths (a file can be in committed AND uncommitted).
          const all = Array.from(new Set([...committed_files, ...uncommitted_files, ...untracked_files]));
          if (all.length === 0) {
            addSpotlightLog("Synced · no changes");
            return;
          }
          const shown = all.slice(0, 12);
          const lines = [
            `Synced ${all.length} file${all.length !== 1 ? "s" : ""}:`,
            ...shown.map(f => `  ${f}`),
            ...(all.length > shown.length ? [`  +${all.length - shown.length} more`] : []),
          ];
          addSpotlightLog(lines.join("\n"));
        },
      );
      const u2 = await listen<{ project_id: string; ws_id: string; message: string }>(
        "spotlight://error",
        ev => {
          if (cancelled || ev.payload.project_id !== projectId || ev.payload.ws_id !== task.id) return;
          addSpotlightLog(ev.payload.message, true);
        },
      );
      unlisteners.push(u1, u2);
    })();
    return () => { cancelled = true; unlisteners.forEach(u => u()); };
  }, [task?.id, task?.project_id]);

  // When spotlight starts: clear stale log, jump to Spotlight tab, expand.
  const prevSpotlightedRef = useRef(false);
  useEffect(() => {
    if (isSpotlighted && !prevSpotlightedRef.current) {
      setSpotlightLog([]);          // fresh log — events after this point fill it
      setFootTab("spotlight");
      setFootCollapsed(false);
    }
    prevSpotlightedRef.current = isSpotlighted;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpotlighted]);

  // Spotlight is worktree-only. If a "spotlight" tab carried over
  // from a worktree task and we land on one where it's NOT available
  // (repo-root, multi-repo, non-git), snap back to Run so the spotlight
  // panel can't leak onto a task it makes no sense for.
  useEffect(() => {
    if (!spotlightAvailable && footTab === "spotlight") setFootTab("run");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlightAvailable]);
  // The footer Run area only renders when NO run script is configured (runs
  // live in terminal tabs). footTab defaults to "run", so on spotlight
  // tasks with a script that combination would expand into an empty
  // void — snap to the Spotlight tab instead.
  useEffect(() => {
    if (!task || !spotlightAvailable || footTab !== "run") return;
    if (project?.run_script?.trim() || yamlRunScripts[task.project_id]?.trim()) {
      setFootTab("spotlight");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, spotlightAvailable, footTab, project?.run_script, yamlRunScripts]);

  // If the Setup tab vanishes, fall back to Spotlight (if available) or Run.
  useEffect(() => {
    if (!showSetupTab && footTab === "setup") {
      setFootTab(spotlightAvailable ? "spotlight" : "run");
    }
  }, [showSetupTab, footTab, spotlightAvailable]);

  if (!task) return null;

  // Resolve the footer target's app key (host project or composition
  // member). Shared by the setup launch and the ScriptStream render below.
  const footMember = task.composition?.find(m => m.dir_name === footTarget);
  const footAppKey = footMember ? memberKey(footMember) : task.project_id;
  // Run/setup live entirely in main-area terminal tabs now (GH #54) + the
  // top-bar Run controls. The bottom footer NEVER hosts a Run tab or a
  // "configure a run script" prompt. Keeping this false also makes
  // `onlySpotlightFooter` true, so the footer defaults straight to the
  // spotlight strip instead of an empty/run surface.
  const showRunLog = false;
  // The bottom section exists ONLY for spotlight (enabled per project + this
  // being a worktree task where spotlight applies). Otherwise it's hidden.
  const showFooter = spotlightAvailable;
  const onlySpotlightFooter =
    spotlightAvailable && !showRunLog && !showSetupTab && !footerTerm;
  const spotlightSelected =
    spotlightAvailable && (onlySpotlightFooter || footTab === "spotlight");

  const handleSpotlightStart = () => {
    // Log clearing happens in the isSpotlighted useEffect above, which fires
    // when the store confirms spotlight is active. startSpotlight also hands
    // off a running dev server from a previously-spotlighted task.
    startSpotlight(task.project_id, task.id).catch(err =>
      useUI.getState().pushToast(String(err), "error")
    );
  };
  const handleSpotlightStop = () => {
    // stopSpotlight also stops the root run (its Run tab stays, exited —
    // it can only be restarted from a spotlighted task).
    stopSpotlight(task.id)
      .then(() => addSpotlightLog("Spotlight stopped"))
      .catch(err => {
        const msg = String(err);
        addSpotlightLog(msg, true);
        useUI.getState().pushToast(msg, "error");
      });
  };
  const handleSpotlightResync = () => {
    taskSpotlightResync(task.id)
      .then(() => {})
      .catch(err => {
        const msg = String(err);
        addSpotlightLog(msg, true);
        useUI.getState().pushToast(msg, "error");
      });
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
      <header className="flex h-10 shrink-0 items-stretch border-b border-[var(--color-border-soft)]">
        <RTab label="All files" active={view === "files"} onClick={() => setView("files")} />
        <RTab label="Git" active={view === "changes"} onClick={() => setView("changes")}
          badge={(gitStatus?.total_changed ?? 0) > 0 ? gitStatus!.total_changed : undefined}
          repoBadge={(gitStatus?.repos_changed ?? 0) > 1 ? gitStatus!.repos_changed : undefined} />
        <div className="flex shrink-0 items-center px-1.5">
          <Tip content="Refresh files and git status" side="bottom">
            <button
              onClick={doRefresh}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            </button>
          </Tip>
        </div>
      </header>

      {/* Files / Git — flexible, takes whatever's left after the footer.
          Files scrolls inside this wrapper; Git manages its own panes +
          scrolling so it gets the bare flex-1 height with no overflow. */}
      {view === "files" ? (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <FileTree taskId={task.id} reloadToken={fileTreeReload + fileTreeNonce + fsRevision + focusReload} refreshToken={fileTreeReload} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <GitPanel
            task={task}
            status={gitStatus}
            refresh={refreshGit}
            onOpenDiff={(path, pane) => useApp.getState().openPreviewTab(task.id, { type: "diff", path, scope: pane, title: `Δ ${path.split("/").pop()}` })}
            onDoubleClickDiff={(path) => {
              const currentTabs = useApp.getState().tabs[task.id] || [];
              const existing = currentTabs.find(t => t.type === "diff" && t.path === path);
              if (existing) {
                useApp.getState().persistTab(task.id, existing.id);
              }
            }}
          />
        </div>
      )}

      {/* Footer: Setup / Run / Terminal tabs + Run action. Collapsible.
          Height is store-backed + drag-resizable from the top edge.
          Fully hidden when the run is popped out (GH #54) and nothing else
          lives down here — an empty strip with a lone chevron + wrench was
          just confusing chrome. */}
      {showFooter && (
      <footer
        className="relative flex shrink-0 flex-col bg-[var(--color-bg-1)]"
        style={{ height: footCollapsed ? "var(--bottom-bar-h)" : footHeight }}
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
        <div className={cn(
          "flex h-[var(--bottom-bar-h)] min-w-0 shrink-0 items-center gap-0.5 overflow-hidden border-t border-[var(--color-border-soft)] px-1.5",
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
          {/* Spotlight is toolbar-only when it is the footer's only surface;
              keep a real tab only when it is competing with Run/Setup/Terminal. */}
          {spotlightAvailable && !onlySpotlightFooter && (
            <FTab
              label="Spotlight"
              icon={isSpotlighted
                ? <AudioWaveform className="termic-spotlight-wave h-3 w-3 text-[var(--color-accent)]" />
                : undefined}
              active={spotlightSelected}
              onClick={() => { setFootTab("spotlight"); setFootCollapsed(false); }}
            />
          )}
          {showSetupTab && (
            <FTab
              label="Setup"
              active={footTab === "setup"}
              onClick={() => { setFootTab("setup"); setFootCollapsed(false); }}
              onClose={() => {
                useScriptRuns.getState().reset(task.id, "setup", footTarget);
                setFootTab(isSpotlighted ? "spotlight" : "run");
              }}
            />
          )}
          {footerTerm && (
            <FTab
              label="Terminal"
              active={footTab === "term"}
              onClick={() => { setFootTab("term"); setFootCollapsed(false); }}
              onClose={() => {
                useApp.getState().disableFooterTerm(task.id);
                setFootTab(isSpotlighted ? "spotlight" : "run");
              }}
            />
          )}
          {/* Right-side controls depend on tab + spotlight state */}
          {spotlightSelected && isSpotlighted ? (
            // Active: Resync + Stop
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <button
                onClick={handleSpotlightResync}
                title="Resync spotlight"
                className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={handleSpotlightStop}
                className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium bg-[var(--color-bg-3)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] hover:bg-[var(--color-hover)]"
              >
                <Square className="h-3 w-3" fill="currentColor" />
                Stop
              </button>
            </div>
          ) : spotlightSelected && !isSpotlighted ? (
            // Idle: CTA Start button on the right
            <div className="ml-auto flex shrink-0 items-center">
              <button
                onClick={handleSpotlightStart}
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] hover:border-[var(--color-accent)]"
              >
                <AudioWaveform className="h-3 w-3" />
                Spotlight
              </button>
            </div>
          ) : footTab !== "term" ? (
            <RunToolbar
              task={task} project={project} yamlPreviewUrl={yamlPreviewUrls[task.project_id]}
              compact={compactToolbar}
            />
          ) : null}
        </div>

        {!footCollapsed && (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {/* Spotlight content — idle (start button) or active (log + run) */}
            {spotlightSelected && (
              <SpotlightContent
                isSpotlighted={isSpotlighted}
                log={spotlightLog}
                onStart={handleSpotlightStart}
              />
            )}
            {footTab !== "term" && !spotlightSelected && showRunLog && (() => {
              const activeMember = task.composition?.find(m => m.dir_name === footTarget);
              // Inline members have no project id — key yaml + dismiss state
              // by memberKey. Configure always opens the host project (where
              // members + their scripts are edited).
              const activeKey = activeMember ? memberKey(activeMember) : task.project_id;
              const hasRunScript = !!((activeMember
                ? activeMember.run_script?.trim()
                : project?.run_script?.trim())
                || yamlRunScripts[activeKey]?.trim());
              return (
                <ScriptStream
                  taskId={task.id} kind={footTab as "setup" | "run"} run={footRun}
                  hasScript={footTab === "run"
                    ? hasRunScript
                    : !!((activeMember ? activeMember.setup_script?.trim() : project?.setup_script?.trim()) || yamlSetupScripts[activeKey]?.trim())}
                  dismissKey={footTab === "run" ? `hideRunPrompt:${activeKey}` : undefined}
                  onStart={() => {
                    const kind = footTab as "setup" | "run";
                    useScriptRuns.getState().start(task.id, kind, footTarget);
                    taskRunScriptStream(task.id, kind, footTarget || undefined).catch(err =>
                      console.error("task_run_script_stream failed:", err));
                  }}
                  onConfigure={footTab === "run"
                    ? () => useApp.getState().openSettings("repositories", task.project_id)
                    : undefined}
                  onDismiss={footTab === "run" ? () => setFootCollapsed(true) : undefined}
                />
              );
            })()}
            {/* Keep the AuxTerminal mounted whenever the user has enabled
                it for this task, regardless of which tab is currently
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
                <AuxTerminal taskId={task.id} taskPath={task.path} active={footTab === "term"} />
              </div>
            )}
          </div>
        )}
      </footer>
      )}
    </aside>
  );
}

function FTab({ label, icon, active, onClick, onClose }: {
  label: string; icon?: React.ReactNode; active: boolean; onClick: () => void; onClose?: () => void;
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
      <button onClick={onClick} className="flex items-center gap-1 px-1.5 py-1">
        {icon}{label}
      </button>
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

/** Right-aligned toolbar group: preview-URL actions only. Run/Stop live in
 *  the UnifiedBar (RunControls) and Setup in its dropdown — runs and setups
 *  are terminal tabs now (GH #54), so the footer carries no script buttons. */
function RunToolbar({ task, project, yamlPreviewUrl = "", compact }: {
  task: Task; project: Project | null; yamlPreviewUrl?: string;
  /** When the footer is cramped (Terminal tab open, panel narrow),
   *  collapse buttons to icon-only with the label moved to the title.
   *  Saves ~50px per button which is enough to keep everything in the
   *  panel without overflow. */
  compact?: boolean;
}) {
  const url = expandPreviewUrl(project, task, yamlPreviewUrl);
  const btnCls = compact ? "h-6 w-6 p-0" : "h-6 gap-1 px-1.5 text-[12px]";
  // In compact (icon-only) mode the inline label is gone, so the action name
  // moves to an INSTANT app tooltip (Tip, delay 0) instead of a slow native
  // `title`. Non-compact keeps the visible label and needs no tooltip.
  const tipWrap = (tip: string, node: React.ReactNode) =>
    compact ? <Tip content={tip} side="top">{node}</Tip> : node;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {url && tipWrap(`Open ${url}`,
        <Button
          size="sm" variant="secondary"
          onClick={() => openPath(url).catch(err => console.error("open failed:", err))}
          title={!compact ? url : undefined}
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
function ScriptStream({ taskId, kind, run, hasScript, dismissKey, onStart, onConfigure, onDismiss }: {
  taskId: string; kind: "setup" | "run";
  run: { status: "idle" | "running" | "done" | "error"; lines: string[]; exitCode: number | null };
  hasScript: boolean;
  dismissKey?: string;
  onStart: () => void;
  onConfigure?: () => void;
  onDismiss?: () => void;
}) {
  void taskId;
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
          {kind === "setup" ? "Run setup" : "Run task"}
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
function RTab({ label, active, badge, repoBadge, onClick }: { label: string; active: boolean; badge?: number; repoBadge?: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 border-b-2 text-[13px] font-medium transition-colors",
        active
          ? "border-[var(--color-accent)] bg-[var(--color-bg)] text-[var(--color-fg)]"
          : "border-transparent text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
      )}
    >
      {label}
      {/* Repos-changed badge (green) — only when more than one repo has
          changes. Sits before the total so it reads "N repos, M files". */}
      {repoBadge !== undefined && (
        <span
          title={`${repoBadge} repos changed`}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-ok)] px-1.5 text-[11px] font-semibold leading-none text-black tabular-nums"
        >
          {repoBadge}
        </span>
      )}
      {/* Total changed files (accent). */}
      {badge !== undefined && (
        <span
          title={`${badge} files changed`}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-accent)] px-1.5 text-[11px] font-semibold leading-none text-[var(--color-accent-fg)] tabular-nums"
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ─────────────────────────── spotlight content ───────────────────────────

/** Content for the Spotlight footer tab.
 *
 *  Not spotlighted: lamp icon + "Start spotlight" centered call-to-action.
 *  Spotlighted: scrollable sync log. (Run lives in its own tab, which only
 *  appears while spotlight is active.)
 */
function SpotlightContent({
  isSpotlighted, log, onStart,
}: {
  isSpotlighted: boolean;
  log: Array<{ time: Date; msg: string; error?: boolean }>;
  onStart: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log to bottom on new entries.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  if (!isSpotlighted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AudioWaveform className="h-10 w-10 text-[var(--color-fg-faint)] opacity-30" />
        <button
          onClick={onStart}
          className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] px-4 py-2 text-[13.5px] font-medium text-[var(--color-fg)] hover:border-[var(--color-accent)] hover:bg-[var(--color-hover)] transition-colors"
        >
          Start spotlight
        </button>
        <p className="text-[12px] text-[var(--color-fg-faint)]">
          Sync your changes to the repository root.
        </p>
      </div>
    );
  }

  // Active: sync log.
  const fmt = (d: Date) =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div
      ref={logRef}
      className="h-full overflow-auto px-3 py-2 font-mono text-[11.5px] leading-snug text-[var(--color-fg-dim)]"
    >
      {log.length === 0 && (
        <div className="text-[var(--color-fg-faint)]">Spotlight started. Waiting for changes…</div>
      )}
      {log.map((entry, i) => (
        <div key={i} className={cn("whitespace-pre-wrap", entry.error && "text-[var(--color-err)]")}>
          <span className="mr-2 text-[var(--color-fg-faint)]">{fmt(entry.time)}</span>
          {entry.msg}
        </div>
      ))}
    </div>
  );
}
