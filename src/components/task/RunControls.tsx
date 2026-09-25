// Run controls (GH #54). Rendered in the UnifiedBar's top-right cluster
// (next to Prompts). Runs and setups ALWAYS launch as terminal tabs in the
// active pane — tabs + splits give full placement control, so there is no
// footer-log mode anymore. Visible Setup + Run/Stop buttons, extras (open
// URL, configure) behind a chevron. Individual Run tabs carry their own
// pill controls (play / restart / stop).
//
// Spotlight-enabled projects: while this task is spotlighted its run
// executes at the repo root (spawn-time cwd in TerminalPane) — the tooltip
// says which mode the next run will use.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useShallow } from "zustand/react/shallow";
import type { Task, TerminalTab } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import {
  DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem,
  DropdownLabel, DropdownSeparator,
} from "@/components/ui/Dropdown";
import { ptyKill } from "@/lib/ipc";
import { openWebUrlForProject } from "@/lib/previewBrowser";
import { launchRunTabs, launchSetupTab, launchCustomRun, customRunMember, isCustomRunMember, resolveRunTargets, runsAtRepoRoot, type RunTarget } from "@/lib/runTabs";
import { resolveCustomCommands, runCommandLabel, type ResolvedCommand } from "@/lib/runCommands";
import { Play, Square, ChevronDown, Wrench, Globe, Settings, SlidersHorizontal } from "lucide-react";

export function RunControls({ task }: { task: Task }) {
  const { t } = useTranslation("panels");
  // ALL run tabs — multi-repo tasks have one per repo (host + members).
  // useShallow: filter() returns a fresh array each call.
  const runTabs = useApp(useShallow(s => (s.tabs[task.id] ?? []).filter(
    (t): t is TerminalTab => t.type === "terminal" && !!(t as TerminalTab).runTab,
  )));
  const project = useApp(s => s.projects.find(p => p.id === task.project_id));
  // Preview opens in the user's configured browser (GH #245): the project
  // overrides the app-wide setting, empty means the OS default.
  const previewBrowser = useApp(s => s.previewBrowser);
  const hasSetup = !!project?.setup_script?.trim();
  const isSpotlighted = useApp(s => s.spotlightTaskId[task.project_id] === task.id);
  const atRoot = runsAtRepoRoot(project);
  const isMultiRepo = (task.composition?.length ?? 0) > 0;
  const [targets, setTargets] = useState<RunTarget[]>([]);
  // Custom run commands (GH #124), personal + committed. Ad-hoc, keyed by
  // their own run-tab members (see `customRunMember`), so they're kept OUT of
  // the primary Run/Stop button below and get their own dropdown section.
  const [customCmds, setCustomCmds] = useState<ResolvedCommand[]>([]);
  const primaryRunTabs = runTabs.filter(t => !isCustomRunMember(t.runTab?.member));
  const runLabel = isMultiRepo ? t("runControls.runAll") : t("runControls.run");
  const stopLabel = isMultiRepo ? t("runControls.stopAll") : t("runControls.stop");
  const stopTip = isMultiRepo ? t("runControls.stopAllTip") : t("runControls.stopTip");
  const runTip = isMultiRepo
    ? t("runControls.runAllTip")
    : atRoot && isSpotlighted
      ? t("runControls.runAtRootTip")
      : atRoot && !task.is_main_checkout
        ? t("runControls.runWorktreeTip")
        : t("runControls.runTip");
  // ptyId is cleared on process exit, so its presence ≈ "running". Only the
  // PRIMARY run tabs (host + composition members) drive the main button —
  // a running custom command must not flip Run into Stop.
  const running = primaryRunTabs.some(t => !!t.ptyId);
  // Host preview URL resolved from CURRENT config (Settings / `.termic.yaml`),
  // not the run tab's launch-time snapshot — otherwise configuring preview
  // after a run started, or a single-repo task (no baked target), would
  // leave the URL empty. The URL is a local dev server, so the browser button
  // is still gated on `running` to avoid opening a connection-refused page.
  const previewUrl = targets.find(t => t.member === "")?.previewUrl ?? null;

  // Resolve run targets (incl. host preview URL) for EVERY task, not just
  // multi-repo — single-repo needs the host target too. One `.termic.yaml`
  // read per task switch (RunControls renders only for the active
  // task), so the cost is negligible.
  useEffect(() => {
    let cancelled = false;
    resolveRunTargets(task.id)
      .then(next => { if (!cancelled) setTargets(next); })
      .catch(() => { if (!cancelled) setTargets([]); });
    return () => { cancelled = true; };
  }, [task.id, task.composition, project?.run_script, project?.preview_url, task.port, task.name]);

  // Resolve the custom run commands (personal + committed) for the dropdown.
  // Runs on mount + personal-list change, and again whenever the dropdown
  // opens so a just-added committed (`.termic.yaml`) command shows without a
  // task switch.
  const refreshCustomCmds = useCallback(() => {
    resolveCustomCommands(task.project_id)
      .then(setCustomCmds)
      .catch(() => setCustomCmds([]));
  }, [task.project_id]);
  useEffect(() => { refreshCustomCmds(); }, [refreshCustomCmds, project?.run_scripts]);

  return (
    <>
      {/* Icon-only shortcut to open the preview in the browser. Shown only
          while running (the dev server is up) and a preview URL is set. The
          full URL still lives (with text) in the chevron dropdown below. */}
      {running && previewUrl && (
        <Tip content={t("runControls.openPreviewTip", { url: previewUrl })} side="bottom">
          <Button
            size="sm" variant="ghost" className="px-1.5" data-no-drag
            aria-label={t("runControls.openPreviewAria")}
            onClick={() => { void openWebUrlForProject(previewUrl, previewBrowser, project); }}
          >
            <Globe className="h-3.5 w-3.5" />
          </Button>
        </Tip>
      )}
      {running ? (
        <Tip content={stopTip} side="bottom">
          <Button
            size="sm" variant="ghost" className="gap-1.5" data-no-drag
            onClick={() => { for (const t of primaryRunTabs) if (t.ptyId) ptyKill(t.ptyId).catch(() => {}); }}
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
            onClick={() => { void launchRunTabs(task.id); }}
          >
            <Play className="h-3.5 w-3.5" />
            <span>{runLabel}</span>
          </Button>
        </Tip>
      )}
      <DropdownRoot onOpenChange={(open) => { if (open) refreshCustomCmds(); }}>
        <DropdownTrigger asChild>
          <Button size="sm" variant="ghost" className="px-1" data-no-drag>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownTrigger>
        {/* All items here are single-line, so vertically center the leading
            icon against the label (the shared DropdownItem top-aligns for the
            two-line items other menus use, which leaves single-line icons
            high). The extra 1px nudge optically centers the icon against the
            lowercase-heavy labels (file names, command labels), whose visual
            mass sits below the font box center. Scoped here so only the Run
            dropdown changes. */}
        <DropdownMenu align="end" className="[&_[role=menuitem]]:items-center [&_[role=menuitem]>svg]:mt-0 [&_[role=menuitem]>svg]:translate-y-[1px]">
          {isMultiRepo && targets.length > 0 && (
            <>
              <DropdownLabel>{t("runControls.runScripts")}</DropdownLabel>
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
                      else void launchRunTabs(task.id, target.member);
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
          {/* Custom run commands (GH #124) — the curated per-repo list,
              personal + committed. Each toggles its own run tab, keyed by
              `customRunMember`; independent of the primary Run button above. */}
          {customCmds.length > 0 && (
            <>
              <DropdownLabel>{t("runControls.runCommands")}</DropdownLabel>
              {customCmds.map((cmd, i) => {
                const tab = runTabs.find(t => t.runTab?.member === customRunMember(cmd));
                const runningCmd = !!tab?.ptyId;
                return (
                  <DropdownItem
                    key={`${cmd.source}:${cmd.label}:${i}`}
                    onSelect={() => {
                      if (runningCmd && tab?.ptyId) ptyKill(tab.ptyId).catch(() => {});
                      else launchCustomRun(task.id, cmd);
                    }}
                  >
                    {runningCmd
                      ? <Square className="h-4 w-4 text-[var(--color-err)]" fill="currentColor" />
                      : <Play className="h-4 w-4" />}
                    <span className="min-w-0 flex-1 truncate">{runCommandLabel(cmd)}</span>
                  </DropdownItem>
                );
              })}
              <DropdownSeparator />
            </>
          )}
          {/* Setup is a one-time action — dropdown, not a standing button.
              Explicit click, so it's fine to focus the tab (unlike the
              silent background launch right after task creation). */}
          {hasSetup && (
            <DropdownItem onSelect={() => { launchSetupTab(task.id).catch(() => {}); }}>
              <Wrench className="h-4 w-4" />
              <span>{t("runControls.runSetup")}</span>
            </DropdownItem>
          )}
          {previewUrl && (
            <DropdownItem onSelect={() => { void openWebUrlForProject(previewUrl, previewBrowser, project); }}>
              <Globe className="h-4 w-4" />
              <span>{t("runControls.openUrl", { url: previewUrl })}</span>
            </DropdownItem>
          )}
          <DropdownItem onSelect={() => useUI.getState().openRunCommands(task.project_id)}>
            <SlidersHorizontal className="h-4 w-4" />
            <span>{t("runControls.runConfig")}</span>
          </DropdownItem>
          <DropdownItem onSelect={() => useApp.getState().openSettings("repositories", task.project_id)}>
            <Settings className="h-4 w-4" />
            <span>{t("runControls.repoSettings")}</span>
          </DropdownItem>
        </DropdownMenu>
      </DropdownRoot>
      {/* Separator between the run section and the rest of the cluster. */}
      <div className="mx-1 h-4 w-px shrink-0 bg-[var(--color-border-soft)]" />
    </>
  );
}
