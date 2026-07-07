// Run controls (GH #54). Rendered in the UnifiedBar's top-right cluster
// (next to Prompts). Runs and setups ALWAYS launch as terminal tabs in the
// active pane — tabs + splits give full placement control, so there is no
// footer-log mode anymore. Visible Setup + Run/Stop buttons, extras (open
// URL, configure) behind a chevron. Individual Run tabs carry their own
// pill controls (play / restart / stop).
//
// Spotlight-enabled projects: while this workspace is spotlighted its run
// executes at the repo root (spawn-time cwd in TerminalPane) — the tooltip
// says which mode the next run will use.

import { useEffect, useState } from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useShallow } from "zustand/react/shallow";
import type { Workspace, TerminalTab } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import {
  DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem,
  DropdownLabel, DropdownSeparator,
} from "@/components/ui/Dropdown";
import { ptyKill, openPath } from "@/lib/ipc";
import { launchRunTabs, resolveRunTargets, runsAtRepoRoot, type RunTarget } from "@/lib/runTabs";
import { Play, Square, ChevronDown, Wrench, Globe, Settings } from "lucide-react";

export function RunControls({ ws }: { ws: Workspace }) {
  // ALL run tabs — multi-repo workspaces have one per repo (host + members).
  // useShallow: filter() returns a fresh array each call.
  const runTabs = useApp(useShallow(s => (s.tabs[ws.id] ?? []).filter(
    (t): t is TerminalTab => t.type === "terminal" && !!(t as TerminalTab).runTab,
  )));
  const project = useApp(s => s.projects.find(p => p.id === ws.project_id));
  const hasSetup = !!project?.setup_script?.trim();
  const isSpotlighted = useApp(s => s.spotlightWsId[ws.project_id] === ws.id);
  const atRoot = runsAtRepoRoot(project);
  const isMultiRepo = (ws.composition?.length ?? 0) > 0;
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const runLabel = isMultiRepo ? "Run all" : "Run";
  const stopLabel = isMultiRepo ? "Stop all" : "Stop";
  const stopTip = isMultiRepo ? "Stop all running scripts" : "Stop the running scripts";
  const runTip = isMultiRepo
    ? "Run all configured run scripts"
    : atRoot && isSpotlighted
      ? "Run at the repository root (spotlight is active)"
      : atRoot && !ws.is_repo_root
        ? "Run in this worktree. Spotlighted workspaces run at the repository root."
        : "Run (opens the run terminal tabs)";
  // ptyId is cleared on process exit, so its presence ≈ "running".
  const running = runTabs.some(t => !!t.ptyId);
  // Host preview URL resolved from CURRENT config (Settings / `.termic.yaml`),
  // not the run tab's launch-time snapshot — otherwise configuring preview
  // after a run started, or a single-repo workspace (no baked target), would
  // leave the URL empty. The URL is a local dev server, so the browser button
  // is still gated on `running` to avoid opening a connection-refused page.
  const previewUrl = targets.find(t => t.member === "")?.previewUrl ?? null;

  // Resolve run targets (incl. host preview URL) for EVERY workspace, not just
  // multi-repo — single-repo needs the host target too. One `.termic.yaml`
  // read per workspace switch (RunControls renders only for the active
  // workspace), so the cost is negligible.
  useEffect(() => {
    let cancelled = false;
    resolveRunTargets(ws.id)
      .then(next => { if (!cancelled) setTargets(next); })
      .catch(() => { if (!cancelled) setTargets([]); });
    return () => { cancelled = true; };
  }, [ws.id, ws.composition, project?.run_script, project?.preview_url, ws.port, ws.name]);

  return (
    <>
      {/* Icon-only shortcut to open the preview in the browser. Shown only
          while running (the dev server is up) and a preview URL is set. The
          full URL still lives (with text) in the chevron dropdown below. */}
      {running && previewUrl && (
        <Tip content={`Open preview (${previewUrl})`} side="bottom">
          <Button
            size="sm" variant="ghost" className="px-1.5" data-no-drag
            aria-label="Open preview in browser"
            onClick={() => { openPath(previewUrl).catch(() => {}); }}
          >
            <Globe className="h-3.5 w-3.5" />
          </Button>
        </Tip>
      )}
      {running ? (
        <Tip content={stopTip} side="bottom">
          <Button
            size="sm" variant="ghost" className="gap-1.5" data-no-drag
            onClick={() => { for (const t of runTabs) if (t.ptyId) ptyKill(t.ptyId).catch(() => {}); }}
          >
            {/* Only the icon is red — a red label read as a constant alarm. */}
            <Square className="h-3 w-3 text-[var(--color-err)]" fill="currentColor" />
            <span>{stopLabel}</span>
          </Button>
        </Tip>
      ) : (
        <Tip
          content={runTip}
          side="bottom"
        >
          <Button
            size="sm" variant="ghost" className="gap-1.5" data-no-drag
            onClick={() => { void launchRunTabs(ws.id); }}
          >
            <Play className="h-3.5 w-3.5" />
            <span>{runLabel}</span>
          </Button>
        </Tip>
      )}
      <DropdownRoot>
        <DropdownTrigger asChild>
          <Button size="sm" variant="ghost" className="px-1" data-no-drag>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownTrigger>
        <DropdownMenu align="end">
          {isMultiRepo && targets.length > 0 && (
            <>
              <DropdownLabel>Run scripts</DropdownLabel>
              {targets.map(target => {
                const tab = runTabs.find(t =>
                  ((t.runTab?.kind ?? "run") === "run") &&
                  t.runTab?.member === target.member
                );
                const runningTarget = !!tab?.ptyId;
                return (
                  <DropdownItem
                    key={target.member || "__host__"}
                    onSelect={() => {
                      if (runningTarget && tab?.ptyId) ptyKill(tab.ptyId).catch(() => {});
                      else void launchRunTabs(ws.id, target.member);
                    }}
                  >
                    {runningTarget
                      ? <Square className="h-4 w-4 text-[var(--color-err)]" fill="currentColor" />
                      : <Play className="h-4 w-4" />}
                    <span>{target.label}</span>
                  </DropdownItem>
                );
              })}
              <DropdownSeparator />
            </>
          )}
          {/* Setup is a one-time action — dropdown, not a standing button. */}
          {hasSetup && (
            <DropdownItem onSelect={() => useUI.getState().requestRunScript(ws.id, "setup")}>
              <Wrench className="h-4 w-4" />
              <span>Run setup</span>
            </DropdownItem>
          )}
          {previewUrl && (
            <DropdownItem onSelect={() => openPath(previewUrl).catch(() => {})}>
              <Globe className="h-4 w-4" />
              <span>Open {previewUrl}</span>
            </DropdownItem>
          )}
          <DropdownItem onSelect={() => useApp.getState().openSettings("repositories", ws.project_id)}>
            <Settings className="h-4 w-4" />
            <span>Configure</span>
          </DropdownItem>
        </DropdownMenu>
      </DropdownRoot>
      {/* Separator between the run section and the rest of the cluster. */}
      <div className="mx-1 h-4 w-px shrink-0 bg-[var(--color-border-soft)]" />
    </>
  );
}
