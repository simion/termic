// Right panel: tab between All Files (filesystem list) and Git (Fork-style
// staging). Click a file → opens an Editor tab in the main area. Click a
// change → diff tab.

import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useApp, useActiveWorkspace } from "@/store/app";
import { useUI } from "@/store/ui";
import {
  workspaceGitStatus, workspaceRunScriptStream, openPath, repoConfigLoad, repoConfigLoadAt,
  workspaceSpotlightResync,
} from "@/lib/ipc";
import { startSpotlight, stopSpotlight } from "@/lib/spotlight";
import { launchRunTabs, expandPreviewUrl } from "@/lib/runTabs";
import type { GitStatus, Workspace, WorkspaceMember, Project, TerminalTab } from "@/lib/types";
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
const memberKey = (m: WorkspaceMember) => m.repo_path || m.dir_name;

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
  const ws = useActiveWorkspace();
  const addTab = useApp(s => s.addTab);
  const split = useApp(s => !!s.terminalSplit[ws?.id ?? ""]);
  const toggleSplit = useApp(s => s.toggleTerminalSplit);
  const [view, setView] = useState<"files" | "changes">("files");
  // A reveal-in-tree request (editor breadcrumb / locate button) forces the
  // "All files" view so the tree is on screen for FileTree to expand/scroll.
  const revealFile = useApp(s => s.revealFile);
  useEffect(() => {
    if (revealFile && ws && revealFile.wsId === ws.id) setView("files");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealFile, ws?.id]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  // Bumped by the header refresh button to force the FileTree to re-read
  // from disk. The Git side re-fetches via refreshGit() in the same click.
  const [fileTreeReload, setFileTreeReload] = useState(0);
  // Global reload signal (bumped from Settings when exclude patterns change,
  // since the tree is hidden behind the Settings overlay then). Folded into
  // the local token so either source forces a re-read.
  const fileTreeNonce = useUI(s => s.fileTreeNonce);
  // Bumped when an agent terminal in this workspace settles (app store). Drives
  // the file tree + Git refresh below so on-disk changes appear without a
  // window focus cycle or the 4s poll, and without a heavy FS watcher.
  const fsRevision = useApp(s => (ws ? s.fsRevision[ws.id] ?? 0 : 0));
  const [refreshing, setRefreshing] = useState(false);
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

  // Poll git status (staged/unstaged split) for the Git tab badges + panel.
  // The fetch is reused by GitPanel via the `refreshGit` callback so a
  // stage/unstage/commit reflects immediately instead of waiting for the
  // 4s tick.
  const refreshGit = React.useCallback(() => {
    if (!ws) return;
    workspaceGitStatus(ws.id).then(setGitStatus).catch(() => {});
  }, [ws?.id]);
  // Clear + reload ONLY on a real workspace switch (ws.id), not on every
  // ws-object re-patch (window refocus, attention/settled updates re-create the
  // object) — clearing then flashed the Git panel to "Loading…". The poll and
  // the focus refresh below swap fresh status in WITHOUT clearing.
  useEffect(() => {
    if (!ws) { setGitStatus(null); return; }
    setGitStatus(null);
    workspaceGitStatus(ws.id).then(setGitStatus).catch(() => {});
    const id = window.setInterval(() => {
      workspaceGitStatus(ws.id).then(setGitStatus).catch(() => {});
    }, 4000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.id]);

  // Window regained focus: the user may have run git in an external terminal
  // while away. Refresh in place (no clear, no "Loading…" flash).
  useEffect(() => {
    if (!ws) return;
    const onFocus = () => refreshGit();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ws?.id, refreshGit]);

  // Agent terminal settled → its file edits are reflected in git status too.
  // Refresh in place on the same signal that reloads the file tree below.
  // Skip the first run (initial fetch above already covers it).
  const fsGitFirst = useRef(true);
  useEffect(() => {
    if (fsGitFirst.current) { fsGitFirst.current = false; return; }
    refreshGit();
  }, [fsRevision, refreshGit]);

  // Header refresh button: re-read both the file tree and git status. The
  // brief `refreshing` flag spins the icon for feedback.
  const doRefresh = () => {
    refreshGit();
    setFileTreeReload(n => n + 1);
    setRefreshing(true);
    window.setTimeout(() => setRefreshing(false), 600);
  };

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
        const topicMember = scriptTopicMember(member);
        for (const kind of ["setup", "run"] as const) {
          const u1 = await listen<{ line: string }>(`script-output://${wsId}:${topicMember}:${kind}`, ev => {
            if (!cancelled) appendLine(wsId, kind, ev.payload.line, member);
          });
          const u2 = await listen<{ code: number | null; success: boolean }>(`script-done://${wsId}:${topicMember}:${kind}`, ev => {
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
  // behind the Settings overlay without needing a workspace switch.
  useEffect(() => {
    if (!ws) { setYamlPreviewUrls({}); setYamlSetupScripts({}); setYamlRunScripts({}); return; }
    // Host loads by project id; each member loads its .termic.yaml by path.
    const loaders: Array<Promise<readonly [string, string, string, string]>> = [
      repoConfigLoad(ws.project_id)
        .then(rc => [ws.project_id, rc?.scripts?.preview_url?.trim() ?? "", rc?.scripts?.setup?.trim() ?? "", rc?.scripts?.run?.trim() ?? ""] as const)
        .catch(() => [ws.project_id, "", "", ""] as const),
    ];
    for (const m of ws.composition ?? []) {
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
  }, [ws?.project_id, ws?.composition?.map(m => m.repo_path || m.dir_name).sort().join("|"), fileTreeNonce]);
  const footerTerm = useApp(s => (ws ? !!s.footerTerm[ws.id] : false));
  // Icon-only toolbar when the Terminal tab is open (the tab strip eats
  // horizontal room) OR the panel is simply narrow. ~380px is where the
  // full-text Setup / Stop / Open buttons (plus the Copy-URL icon and the
  // Run / Setup tabs) stop fitting; below it the labels clip off the edge.
  const compactToolbar = footerTerm || (asideWidth > 0 && asideWidth < 380);
  const setupRunState = useRunState(ws?.id, "setup", footTarget);
  // The Setup tab is transient: it only appears once Setup has been
  // invoked for this (workspace, target). Closing it resets the run
  // state back to idle and the tab disappears again.
  const showSetupTab = setupRunState.status !== "idle";
  const footRun = useRunState(ws?.id, footTab === "term" ? "run" : (footTab === "spotlight" ? "run" : footTab), footTarget);

  // ── spotlight ──────────────────────────────────────────────────
  // Available for single-repo, non-root, spotlight-enabled workspaces.
  const isSpotlighted = useApp(s => ws ? s.spotlightWsId[ws.project_id] === ws.id : false);
  // Spotlight syncs a worktree's changes back to the repo root, so it's
  // worktree-only: never for repo-root, multi-repo, or non-git workspaces.
  const spotlightAvailable = !!ws && !ws.is_repo_root
    && !!project?.spotlight_enabled
    && project?.type !== "multi"
    && !project?.non_git;

  // Sync log: array of timestamped entries shown in the Spotlight tab.
  const [spotlightLog, setSpotlightLog] = useState<Array<{ time: Date; msg: string; error?: boolean }>>([]);
  const addSpotlightLog = (msg: string, error = false) =>
    setSpotlightLog(prev => [...prev.slice(-199), { time: new Date(), msg, error }]);

  // Listen to spotlight events for this workspace.
  useEffect(() => {
    if (!ws) return;
    const projectId = ws.project_id;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    (async () => {
      const u1 = await listen<{
        project_id: string; ws_id: string;
        committed_files: string[]; uncommitted_files: string[]; untracked_files: string[];
      }>(
        "spotlight://synced",
        ev => {
          if (cancelled || ev.payload.project_id !== projectId || ev.payload.ws_id !== ws.id) return;
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
          if (cancelled || ev.payload.project_id !== projectId || ev.payload.ws_id !== ws.id) return;
          addSpotlightLog(ev.payload.message, true);
        },
      );
      unlisteners.push(u1, u2);
    })();
    return () => { cancelled = true; unlisteners.forEach(u => u()); };
  }, [ws?.id, ws?.project_id]);

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
  // from a worktree workspace and we land on one where it's NOT available
  // (repo-root, multi-repo, non-git), snap back to Run so the spotlight
  // panel can't leak onto a workspace it makes no sense for.
  useEffect(() => {
    if (!spotlightAvailable && footTab === "spotlight") setFootTab("run");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotlightAvailable]);
  // The footer Run area only renders when NO run script is configured (runs
  // live in terminal tabs). footTab defaults to "run", so on spotlight
  // workspaces with a script that combination would expand into an empty
  // void — snap to the Spotlight tab instead.
  useEffect(() => {
    if (!ws || !spotlightAvailable || footTab !== "run") return;
    if (project?.run_script?.trim() || yamlRunScripts[ws.project_id]?.trim()) {
      setFootTab("spotlight");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.id, spotlightAvailable, footTab, project?.run_script, yamlRunScripts]);

  // If the Setup tab vanishes, fall back to Spotlight (if available) or Run.
  useEffect(() => {
    if (!showSetupTab && footTab === "setup") {
      setFootTab(spotlightAvailable ? "spotlight" : "run");
    }
  }, [showSetupTab, footTab, spotlightAvailable]);

  if (!ws) return null;

  const hasComposition = (ws.composition?.length ?? 0) > 0;

  // Resolve the footer target's app key (host project or composition
  // member). Shared by the setup launch and the ScriptStream render below.
  const footMember = ws.composition?.find(m => m.dir_name === footTarget);
  const footAppKey = footMember ? memberKey(footMember) : ws.project_id;
  // Runs/setups ALWAYS live in terminal tabs now (GH #54) — the footer log
  // mode is gone; tabs + splits give full placement control. Launching is
  // shared logic in lib/runTabs (also used by RunControls + spotlight).
  const runsInTerminal = true;
  // Run targets known locally: only used to decide whether the footer shows
  // the "configure a run script" prompt (the sole remaining Run footer use).
  const runTargets = (() => {
    const targets: { member: string; script: string }[] = [];
    const hostScript = (project?.run_script || yamlRunScripts[ws.project_id] || "").trim();
    if (hostScript) targets.push({ member: "", script: hostScript });
    for (const m of ws.composition ?? []) {
      const script = (m.run_script || yamlRunScripts[memberKey(m)] || "").trim();
      if (script) targets.push({ member: m.dir_name, script });
    }
    return targets;
  })();
  // Footer Run area: runs NEVER stream down here — it only appears when no
  // run script is configured, to host the "configure a run script" prompt.
  const showRunLog = !runsInTerminal || runTargets.length === 0;
  // Multi-repo run controls moved to the UnifiedBar ("Run all" / "Stop all").
  // Do not keep the old member target strip alive at the bottom of the right
  // panel; show the footer only for non-run surfaces.
  const showFooter =
    !runsInTerminal ||
    showSetupTab ||
    footerTerm ||
    spotlightAvailable ||
    (!hasComposition && showRunLog);
  const onlySpotlightFooter =
    spotlightAvailable && !showRunLog && !showSetupTab && !footerTerm;
  const spotlightSelected =
    spotlightAvailable && (onlySpotlightFooter || footTab === "spotlight");

  // Shared start/stop. Setup auto-switches the footer view to the Setup
  // tab (which the user can close once they're done reading the log).
  const startScript = (kind: "setup" | "run") => {
    if (kind === "setup") {
      // Setup runs as a one-shot terminal tab (host or the selected member).
      const setupScript = ((footMember ? footMember.setup_script : project?.setup_script)
        || yamlSetupScripts[footAppKey] || "").trim();
      if (setupScript) {
        const st = useApp.getState();
        const existing = (st.tabs[ws.id] ?? []).find(
          (t): t is TerminalTab => t.type === "terminal"
            && (t as TerminalTab).runTab?.kind === "setup"
            && (t as TerminalTab).runTab?.member === footTarget,
        );
        if (existing) {
          window.dispatchEvent(new CustomEvent("termic-run-tab-restart", { detail: { tabId: existing.id } }));
        } else {
          st.addTabToActivePane(ws.id, {
            id: crypto.randomUUID(),
            type: "terminal",
            title: footTarget ? `Setup · ${footTarget}` : "Setup",
            cli: "custom",
            command: footTarget
              ? `cd "${ws.path.replace(/"/g, '\\"')}/${footTarget}"\n${setupScript}`
              : setupScript,
            runTab: { member: footTarget, kind: "setup" },
          });
        }
        return;
      }
      useUI.getState().pushToast("No setup script configured. Set one in Settings, Repositories.", "error");
      return;
    }
    // Run: ALWAYS terminal tabs, every project the same (GH #54) — runs
    // never stream into the footer. Spotlight-enabled projects' host tab
    // cd's to the repo root inside the tab command (see lib/runTabs).
    void launchRunTabs(ws.id);
  };

  // The UnifiedBar's top-right Run button can't drive the footer's
  // collapse/tab state (it lives here, not in the store), so it bumps a
  // nonce in the UI store and we react by running the run-script the same
  // way the in-panel Run button does. Guard on the nonce so we fire once
  // per click, and only for this (active) workspace.
  const runReq = useUI(s => s.runScriptRequest);
  const lastRunNonce = useRef(0);
  useEffect(() => {
    if (!runReq || !ws) return;
    if (runReq.nonce === lastRunNonce.current) return;
    lastRunNonce.current = runReq.nonce;
    if (runReq.wsId !== ws.id) return;
    startScript(runReq.kind ?? "run");
  }, [runReq, ws?.id]);

  const handleSpotlightStart = () => {
    // Log clearing happens in the isSpotlighted useEffect above, which fires
    // when the store confirms spotlight is active. startSpotlight also hands
    // off a running dev server from a previously-spotlighted workspace.
    startSpotlight(ws.project_id, ws.id).catch(err =>
      useUI.getState().pushToast(String(err), "error")
    );
  };
  const handleSpotlightStop = () => {
    // stopSpotlight also stops the root run (its Run tab stays, exited —
    // it can only be restarted from a spotlighted workspace).
    stopSpotlight(ws.id)
      .then(() => addSpotlightLog("Spotlight stopped"))
      .catch(err => {
        const msg = String(err);
        addSpotlightLog(msg, true);
        useUI.getState().pushToast(msg, "error");
      });
  };
  const handleSpotlightResync = () => {
    workspaceSpotlightResync(ws.id)
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
          <FileTree wsId={ws.id} reloadToken={fileTreeReload + fileTreeNonce + fsRevision} refreshToken={fileTreeReload} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <GitPanel
            ws={ws}
            status={gitStatus}
            refresh={refreshGit}
            onOpenDiff={(path) => useApp.getState().openPreviewTab(ws.id, { type: "diff", path, title: `Δ ${path.split("/").pop()}` })}
            onDoubleClickDiff={(path) => {
              const currentTabs = useApp.getState().tabs[ws.id] || [];
              const existing = currentTabs.find(t => t.type === "diff" && t.path === path);
              if (existing) {
                useApp.getState().persistTab(ws.id, existing.id);
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
          {/* Run tab: only for non-spotlight projects and repo-root workspaces,
              and hidden while the run is popped out into a RunPane tab. */}
          {showRunLog && (
            <FTab label="Run" active={footTab === "run"} onClick={() => { setFootTab("run"); setFootCollapsed(false); }} />
          )}
          {showSetupTab && (
            <FTab
              label="Setup"
              active={footTab === "setup"}
              onClick={() => { setFootTab("setup"); setFootCollapsed(false); }}
              onClose={() => {
                useScriptRuns.getState().reset(ws.id, "setup", footTarget);
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
                useApp.getState().disableFooterTerm(ws.id);
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
              ws={ws} project={project} yamlPreviewUrl={yamlPreviewUrls[ws.project_id]}
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
              const activeMember = ws.composition?.find(m => m.dir_name === footTarget);
              // Inline members have no project id — key yaml + dismiss state
              // by memberKey. Configure always opens the host project (where
              // members + their scripts are edited).
              const activeKey = activeMember ? memberKey(activeMember) : ws.project_id;
              const hasRunScript = !!((activeMember
                ? activeMember.run_script?.trim()
                : project?.run_script?.trim())
                || yamlRunScripts[activeKey]?.trim());
              return (
                <ScriptStream
                  wsId={ws.id} kind={footTab as "setup" | "run"} run={footRun}
                  hasScript={footTab === "run"
                    ? hasRunScript
                    : !!((activeMember ? activeMember.setup_script?.trim() : project?.setup_script?.trim()) || yamlSetupScripts[activeKey]?.trim())}
                  dismissKey={footTab === "run" ? `hideRunPrompt:${activeKey}` : undefined}
                  onStart={() => {
                    const kind = footTab as "setup" | "run";
                    useScriptRuns.getState().start(ws.id, kind, footTarget);
                    workspaceRunScriptStream(ws.id, kind, footTarget || undefined).catch(err =>
                      console.error("workspace_run_script_stream failed:", err));
                  }}
                  onConfigure={footTab === "run"
                    ? () => useApp.getState().openSettings("repositories", ws.project_id)
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
function RunToolbar({ ws, project, yamlPreviewUrl = "", compact }: {
  ws: Workspace; project: Project | null; yamlPreviewUrl?: string;
  /** When the footer is cramped (Terminal tab open, panel narrow),
   *  collapse buttons to icon-only with the label moved to the title.
   *  Saves ~50px per button which is enough to keep everything in the
   *  panel without overflow. */
  compact?: boolean;
}) {
  const url = expandPreviewUrl(project, ws, yamlPreviewUrl);
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
