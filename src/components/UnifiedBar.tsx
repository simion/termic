// Single horizontal chrome strip spanning the whole window. Mirrors
// Termic's design: traffic-light reservation on the left, sidebar toggle,
// project/task breadcrumbs in the middle, action icons on the right.
// The whole strip is a drag region so the user can move the window from any
// empty space, with `no-drag` opted-in on every interactive child.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp, useActiveTask } from "@/store/app";
import { useProfiles } from "@/store/profiles";
import { profileWashCss } from "@/lib/accents";
import { ProfileChip } from "@/components/ProfileChip";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import * as HoverCard from "@radix-ui/react-hover-card";
import { Check } from "lucide-react";
import {
  PanelLeft, PanelRight, Archive,
  Sun, Moon, Monitor, ArrowUpToLine, Sunrise, Droplet, Binary, Code2, Flower2,
  MessageSquareText, Library, Palette,
} from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { effectiveSandboxMode } from "@/lib/types";
import { taskLabel } from "@/lib/taskLabel";
import { SandboxIcon, DockerSandboxIcon } from "@/components/SandboxIcon";
import { UpdaterBanner } from "@/components/UpdaterBanner";
import { WaitingAgentsPill } from "@/components/WaitingAgentsPill";
import { themesDir, taskSendDiffToMain } from "@/lib/ipc";
import { OpenWithButton } from "@/components/OpenWithButton";
import { confirmAndArchive } from "@/lib/archiveTask";
import {
  DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator,
} from "@/components/ui/Dropdown";
import { usePromptLibrary, promptTitle } from "@/store/prompts";
import { useUI } from "@/store/ui";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { bindingGlyphs } from "@/lib/shortcuts";
import { useIsFullscreen } from "@/hooks/useIsFullscreen";
import { RunControls } from "@/components/task/RunControls";
import { CommandPaletteButton } from "@/components/CommandPaletteButton";
import { cn } from "@/lib/utils";

// Reserve enough room for the 3 traffic lights + breathing room before the
// first interactive control. 16 (x offset) + ~58 (3 buttons + gaps) + 10 pad.
// In macOS full-screen the traffic lights are hidden, so the bar reclaims this
// space and the controls sit flush-left like the rest of the chrome.
const TRAFFIC_LIGHT_WIDTH = 84;

export function UnifiedBar() {
  const { t } = useTranslation("chrome");
  const agents = useApp(s => s.agents);
  // The profile's accent as a wash across the left of the bar (GH #280).
  // Selected as the finished CSS string so this bar re-renders only when the
  // colour actually changes, not on every profile-store touch.
  const profileWash = useProfiles(s => {
    const me = s.profiles.find(p => p.slug === s.current);
    return profileWashCss(me?.accent, s.profiles.length > 0);
  });
  const compact = useApp(s => s.compactSidebar);
  const toggleCompact = useApp(s => s.toggleCompactSidebar);
  const toggleRP = useApp(s => s.toggleRightPanel);
  const task = useActiveTask();
  const proj = useApp(s => task ? s.projects.find(p => p.id === task.project_id) : null);
  const openSettings = useApp(s => s.openSettings);
  const enabledPrompts = usePromptLibrary(s => s.prompts).filter(p => p.enabled);
  // Picking a prompt opens the shared destination modal (running agents +
  // new-agent CLIs) — a modal, not a submenu, which flipped to the wrong
  // side near the window edge. Shared (not local state) so the ⌥⌘P prompt
  // palette's fallback path can open the same dialog.
  const openPromptFire = useUI(s => s.openPromptFire);
  // Breadcrumb label for the task: its typed name, or its branch when the
  // "use branch as task name" pref is on (GH #260).
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const taskCrumb = task ? taskLabel(task, useBranchAsTaskName) : "";
  const themeMode = usePrefs(s => s.themeMode);
  const setThemeMode = usePrefs(s => s.setThemeMode);
  // When the user picked an explicit theme, show that theme's icon.
  // When "auto" is selected, show the icon for whatever the OS resolved
  // to (Sun / Moon) — that's the theme they're actually looking at — and
  // overlay a small "A" badge so the auto distinction is visible.
  // The old Monitor/computer icon felt too generic ("display settings")
  // and didn't communicate the resolved theme at a glance.
  const isFullscreen = useIsFullscreen();
  // Tooltips that name a shortcut read it from the LIVE bindings, never a
  // hard-coded "⌥⌘P": every one of these is rebindable in settings, and a
  // tooltip naming a key that no longer does anything is worse than a
  // tooltip with no key at all.
  const binds = usePrefs(s => s.shortcuts);
  const tipWithKey = (text: string, id: import("@/lib/shortcuts").ShortcutId) => {
    const g = binds[id] ? bindingGlyphs(binds[id]).join("") : "";
    return g ? `${text} (${g})` : text;
  };
  const isAuto = themeMode === "auto";
  const resolved = resolveTheme(themeMode);
  const ThemeIcon = (themeMode === "light" || (isAuto && resolved === "light")) ? Sun : Moon;

  return (
    <header
      data-tauri-drag-region
      // Which task the chrome has actually RENDERED, which is not the same
      // fact as useApp's activeTaskId. The store setter is synchronous but
      // React 19 renders concurrently, so between the two the archive button
      // below still closes over the PREVIOUS task. A test that drives the
      // store and then clicks was archiving the wrong task on any machine
      // slow enough to lose that race (e2e/helpers.ts ensureActiveTask).
      data-active-task={task?.id ?? ""}
      // Imperative fallback: data-tauri-drag-region + -webkit-app-region: drag
      // both *should* work, but for whatever reason the WKWebView in this build
      // ignores both. onMouseDown → startDragging() is the bulletproof escape
      // hatch. Guarded so we only drag on a primary click that hits the bar
      // itself (or a non-interactive descendant like the breadcrumb text).
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement;
        if (t.closest("[data-no-drag]") || t.closest("button") || t.closest("input")) return;
        getCurrentWindow().startDragging().catch(() => {});
      }}
      onDoubleClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("[data-no-drag]") || t.closest("button") || t.closest("input")) return;
        // macOS convention: double-click title bar zooms the window.
        getCurrentWindow().toggleMaximize().catch(() => {});
      }}
      className="relative flex h-11 shrink-0 items-center gap-1 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2"
      style={{
        // px-2 (8px) already pads the left in full-screen; only reserve the
        // wide traffic-light gap when the lights are actually there.
        paddingLeft: isFullscreen ? undefined : TRAFFIC_LIGHT_WIDTH,
        WebkitAppRegion: "drag",
        // The profile's accent, washed in from the left and gone by the first
        // third (GH #280). Backed by a real product: JetBrains tints this
        // exact strip per project, and it works because the bar is the one
        // surface always on screen in EVERY window, so "which profile is this"
        // is answered by peripheral vision rather than by reading a name.
        //
        // A gradient rather than a fill: the bar carries the breadcrumb and
        // the toolbar, and a solid accent behind them fights the text. The
        // fade also puts the colour where the eye already goes on a window
        // (top-left, next to the traffic lights).
        //
        // Painted here rather than as an overlay child so nothing has to be
        // excluded from the drag region.
        backgroundImage: profileWash,
      } as any}
    >
      {/* Sidebar toggle + theme cycler */}
      <div
        data-tauri-drag-region="false"
        className="flex items-center gap-2"
        style={{ WebkitAppRegion: "no-drag" } as any}
      >
        <Tip content={compact ? t("unifiedBar.expandSidebar") : t("unifiedBar.collapseSidebar")} side="bottom">
          <Button size="icon" variant="icon" onClick={() => {
            // Suppress the 220ms grid-template-columns transition for
            // this single toggle. Animating the column lerp makes the
            // toggle feel laggy — user clicked a button, they expect
            // instant. We restore the transition on the next frame so
            // RightPanel show/hide still animates normally.
            const root = document.documentElement;
            root.style.setProperty("--cols-transition", "none");
            toggleCompact();
            requestAnimationFrame(() => requestAnimationFrame(() => {
              root.style.removeProperty("--cols-transition");
            }));
          }}>
            <PanelLeft className="h-[18px] w-[18px]" />
          </Button>
        </Tip>
        {/* Self-update pill — only renders when an update is actually
            available. Sits next to the theme picker so it's findable
            but not intrusive. */}
        {/* The profile, in the accent wash this bar already carries. Renders
            nothing until profiles exist, so a dormant install sees the bar it
            has always seen. */}
        <ProfileChip />
        <UpdaterBanner />
        {/* Waiting-agents pill (issue #56): appears only when an agent needs
            you, jumps to the next on click. Sits with the other status pills
            so a live "N waiting" is glanceable from anywhere. */}
        <WaitingAgentsPill />
        {/* YOLO is per-task only — controlled from the task's
            sidebar dropdown ("YOLO: on/off"), with a red ⚡ status badge
            on the sidebar row. No top-bar toggle (it had no global
            meaning and was redundant with the per-task control). */}
      </div>

      {/* Breadcrumbs / title — text doesn't select on drag (matches AppKit title bar). */}
      <div data-testid="task-breadcrumb" className="ml-2 flex min-w-0 flex-1 select-none items-baseline gap-2 text-[14px]">
        {task && proj ? (
          <>
            <span className="text-[var(--color-fg-faint)]">{proj.name}</span>
            <span className="text-[var(--color-fg-faint)]">/</span>
            {/* self-center pulls the icon off the baseline so it
                stays vertically centered next to text — items-baseline
                on the parent would otherwise stick the icon's bottom
                to the text baseline and float it too high. */}
            <span className={cn("flex items-center self-center", CLI_BRAND_COLOR[resolveIconId(task.cli, agents)])}>
              <CliIcon cli={resolveIconId(task.cli, agents)} className="h-4 w-4" />
            </span>
            {/* Task name == branch means the user never renamed it, so
                "<branch> on <branch>" reads as noise: show just the branch
                plus the location icon. The icon (main checkout vs worktree)
                makes the task's checkout kind explicit. The same collapse
                applies when the branch IS the label (GH #260) — the "on"
                clause would then repeat the crumb it follows. */}
            {taskCrumb === task.branch ? (
              <>
                <span className="truncate font-mono text-[13px] leading-tight text-[var(--color-fg)]">{task.branch}</span>
                <TaskLocationIcon isMainCheckout={task.is_main_checkout} className="self-center" />
              </>
            ) : (
              <>
                <span className="min-w-0 truncate pr-0.5 font-medium leading-tight text-[var(--color-fg)]" title={taskCrumb === task.name ? undefined : t("taskNameTitle", { name: task.name })}>{taskCrumb}</span>
                <span className="leading-tight text-[var(--color-fg-faint)]">{t("unifiedBar.onBranch")}</span>
                <span className="truncate font-mono text-[12px] leading-tight text-[var(--color-fg-dim)]">{task.branch}</span>
                <TaskLocationIcon isMainCheckout={task.is_main_checkout} className="self-center" />
              </>
            )}
            {/* Multi-repo: just a small chip with the member count.
                The full per-member breakdown (which dir_name, which
                branch, worktree vs live) lives in the right-panel
                target tabs where it actually matters. Stuffing it
                into the breadcrumb made the bar unreadable past 2
                members and pushed real chrome (Review / Send to main)
                off-screen on narrow windows. */}
            {(task.composition?.length ?? 0) > 0 && (
              <span
                className="ml-1 inline-flex shrink-0 items-center rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider leading-none text-[var(--color-fg-dim)]"
                title={task.composition!.map(m => m.mode === "worktree" ? `${m.dir_name} @${m.branch}` : `${m.dir_name} ${t("unifiedBar.live")}`).join(" · ")}
              >
                {t("unifiedBar.repoCount", { count: task.composition!.length })}
              </span>
            )}
          </>
        ) : (
          <span className="text-[var(--color-fg-faint)]">{t("unifiedBar.noTask")}</span>
        )}
      </div>

      {/* Right-aligned actions */}
      <div
        data-tauri-drag-region="false"
        className="flex items-center gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as any}
      >
        {/* Command palette. First in the cluster and outside the task guard:
            it is the only control here that is never task-scoped, and the
            palette's global commands (new task, project picker, settings)
            work with nothing selected. */}
        <CommandPaletteButton />
        {task && proj && (
          <>
            <div className="mx-1 h-4 w-px bg-[var(--color-border-soft)]" />
            {/* Popped-out run controls (GH #54): Setup + Run/Stop live up
                here, next to Prompts, while runs open as terminal tabs. */}
            <RunControls task={task} />
            <DropdownRoot>
              {/* The dropdown is the mouse path; ⌥⌘P opens the searchable
                  palette over the same list. Naming the binding here is the
                  only place the two surfaces meet. Glyphs come from the live
                  binding, so a rebind can't leave the tooltip lying. */}
              <Tip content={tipWithKey(t("unifiedBar.prompts"), "prompt-palette")} side="bottom">
                <DropdownTrigger asChild>
                  <Button size="sm" variant="ghost" className="gap-1.5" data-no-drag data-testid="prompts-menu">
                    <MessageSquareText className="h-4 w-4" />
                    <span>{t("unifiedBar.prompts")}</span>
                  </Button>
                </DropdownTrigger>
              </Tip>
              {/* preventDefault on close keeps focus from snapping back to the
                  trigger, which would re-fire its focus-triggered tooltip and
                  leave it stuck open after picking a prompt. */}
              <DropdownMenu align="end" className="min-w-[200px]" onCloseAutoFocus={(e) => e.preventDefault()}>
                {enabledPrompts.length === 0 && (
                  <div className="px-2 py-1.5 text-[13px] text-[var(--color-fg-faint)]">{t("unifiedBar.promptsEmpty")}</div>
                )}
                {enabledPrompts.map(p => (
                  <DropdownItem key={p.id} onSelect={() => openPromptFire(p)}>
                    <span className="min-w-0 flex-1 truncate">{promptTitle(p, t)}</span>
                  </DropdownItem>
                ))}
                <DropdownSeparator />
                <DropdownItem onSelect={() => openSettings("prompts")}>
                  <Library className="h-4 w-4" />
                  <span>{t("unifiedBar.managePrompts")}</span>
                </DropdownItem>
              </DropdownMenu>
            </DropdownRoot>

            {/* Send-to-main: only shown on actual worktrees, not the
                repo-root pseudo-task (which IS the main checkout —
                nothing to send). Hard-blocks on a dirty main checkout
                rather than risk mixing change sets; the error bubbles
                up via the alert below. */}
            {!task.is_main_checkout && (
              <Tip content={t("unifiedBar.sendToMainTip")} side="bottom">
                <Button size="sm" variant="ghost" className="gap-1.5"
                  onClick={async () => {
                    const ok = await useUI.getState().askConfirm({
                      title: t("unifiedBar.sendToMainTitle", { name: taskCrumb }),
                      message: t("unifiedBar.sendToMainMessage", { path: proj.root_path }),
                      confirmLabel: t("unifiedBar.sendToMain"),
                    });
                    if (!ok) return;
                    try {
                      const r = await taskSendDiffToMain(task.id);
                      // Build a compact, human-readable summary. Quietly
                      // omit the zero halves so it reads as a result, not
                      // a checklist of nothings-happened.
                      const parts: string[] = [];
                      if (r.tracked_files)   parts.push(t(r.tracked_files === 1 ? "unifiedBar.trackedOne" : "unifiedBar.trackedMany", { count: r.tracked_files }));
                      if (r.untracked_files) parts.push(t(r.untracked_files === 1 ? "unifiedBar.untrackedOne" : "unifiedBar.untrackedMany", { count: r.untracked_files }));
                      const summary = parts.length ? parts.join(", ") : t("unifiedBar.noChanges");
                      useUI.getState().pushToast(t("unifiedBar.sentToast", { summary }), "success");
                    } catch (e) {
                      await useUI.getState().askConfirm({
                        title: t("unifiedBar.sendToMainFailed"),
                        message: String(e),
                        confirmLabel: t("ok", { ns: "common" }),
                        cancelLabel: "",
                        destructive: true,
                      });
                    }
                  }}>
                  <ArrowUpToLine className="h-4 w-4" />
                  <span>{t("unifiedBar.sendToMain")}</span>
                </Button>
              </Tip>
            )}
            {(() => {
              if (task.docker_sandbox_enabled) {
                return (
                  <Tip content={t("unifiedBar.sbDockerTip")} side="bottom">
                    <Button size="icon" variant="icon"
                      onClick={() => useUI.getState().openSandbox(task.id)}
                    >
                      <DockerSandboxIcon className="h-4 w-4" />
                    </Button>
                  </Tip>
                );
              }
              const sbMode = effectiveSandboxMode(task);
              const tip = sbMode === "enforce" ? t("unifiedBar.sbEnforce")
                : sbMode === "enforce-fs" ? t("unifiedBar.sbEnforceFs")
                : sbMode === "monitor" ? t("unifiedBar.sbMonitor")
                : t("unifiedBar.sbOff");
              return (
                <Tip content={tip} side="bottom">
                  <Button size="icon" variant="icon"
                    onClick={() => useUI.getState().openSandbox(task.id)}
                  >
                    {/* Glyph, color and fill ALL come from SANDBOX_VISUALS.
                        This used to swap in an Eye for monitoring, which made
                        the one surface a user reads at a glance the only one
                        disagreeing with the sidebar row, the footer chip and
                        the mode picker about what monitoring looks like. */}
                    <SandboxIcon mode={sbMode} className="h-4 w-4" />
                  </Button>
                </Tip>
              );
            })()}
            <Tip content={t("unifiedBar.archiveTask")} side="bottom">
              {/* Copy, delete-branch checkbox and the "Show this every time"
                  opt-out all live in confirmAndArchive - this button used to
                  inline its own near-copy of the prompt, which then drifted
                  from the sidebar's. */}
              <Button size="icon" variant="icon"
                onClick={() => { void confirmAndArchive(task); }}
                data-testid="archive-task"
              ><Archive className="h-4 w-4" /></Button>
            </Tip>
            <OpenWithButton task={task} />
            <div className="mx-1 h-4 w-px bg-[var(--color-border-soft)]" />
            <Tip content={tipWithKey(t("unifiedBar.toggleRightPanel"), "toggle-right-sidebar")} side="bottom">
              <Button size="icon" variant="icon" onClick={toggleRP} data-testid="toggle-right-panel">
                <PanelRight className="h-4 w-4" />
              </Button>
            </Tip>
          </>
        )}
      </div>
    </header>
  );
}

