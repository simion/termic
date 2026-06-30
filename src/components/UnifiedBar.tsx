// Single horizontal chrome strip spanning the whole window. Mirrors
// Termic's design: traffic-light reservation on the left, sidebar toggle,
// project/workspace breadcrumbs in the middle, action icons on the right.
// The whole strip is a drag region so the user can move the window from any
// empty space, with `no-drag` opted-in on every interactive child.

import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp, useActiveWorkspace } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import * as HoverCard from "@radix-ui/react-hover-card";
import { Check } from "lucide-react";
import {
  PanelLeft, PanelRight, FolderOpen, Archive,
  Sun, Moon, Monitor, ArrowUpToLine, Sunrise, Droplet, Binary, Code2, Eye,
  MessageSquareText, Library, Plus,
} from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { effectiveSandboxMode } from "@/lib/types";
import { SandboxIcon } from "@/components/SandboxIcon";
import type { TerminalTab } from "@/lib/types";
import { findLeaf } from "@/lib/splitTree";
import { UpdaterBanner } from "@/components/UpdaterBanner";
import { openPath, workspaceSendDiffToMain } from "@/lib/ipc";
import { archiveAndRefresh } from "@/lib/archiveWorkspace";
import { visibleCliIds, isTerminalEntry, tabLabel } from "@/lib/agents";
import { AppDialog } from "@/components/ui/Dialog";
import {
  DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator,
} from "@/components/ui/Dropdown";
import { usePromptLibrary, type Prompt } from "@/store/prompts";
import { runPrompt } from "@/lib/runPrompt";
import { useUI } from "@/store/ui";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { useIsFullscreen } from "@/hooks/useIsFullscreen";
import { cn } from "@/lib/utils";

// Reserve enough room for the 3 traffic lights + breathing room before the
// first interactive control. 16 (x offset) + ~58 (3 buttons + gaps) + 10 pad.
// In macOS full-screen the traffic lights are hidden, so the bar reclaims this
// space and the controls sit flush-left like the rest of the chrome.
const TRAFFIC_LIGHT_WIDTH = 84;

export function UnifiedBar() {
  const agents = useApp(s => s.agents);
  const compact = useApp(s => s.compactSidebar);
  const toggleCompact = useApp(s => s.toggleCompactSidebar);
  const toggleRP = useApp(s => s.toggleRightPanel);
  const ws = useActiveWorkspace();
  const proj = useApp(s => ws ? s.projects.find(p => p.id === ws.project_id) : null);
  const openSettings = useApp(s => s.openSettings);
  const enabledPrompts = usePromptLibrary(s => s.prompts).filter(p => p.enabled);
  // Live agents in the active workspace = the prompt destinations (+ New agent).
  const wsTabs = useApp(s => (ws ? s.tabs[ws.id] : undefined));
  const liveAgents = (wsTabs ?? []).filter(
    (t): t is TerminalTab => t.type === "terminal" && !!t.ptyId,
  );
  const focusedAgentId = useApp(s => {
    if (!ws) return undefined;
    const tabKey = s.activeTab[ws.id];
    const tree = tabKey ? s.splitTree[tabKey] : undefined;
    if (tree) {
      const leaf = findLeaf(tree, s.activePaneId[tabKey!] ?? "");
      if (leaf?.tabId) return leaf.tabId;
    }
    return s.activeTab[ws.id];
  });
  // Picking a prompt opens a destination modal (running agents + new-agent
  // CLIs) instead of a submenu, which flipped to the wrong side near the edge.
  const [firingPrompt, setFiringPrompt] = useState<Prompt | null>(null);
  // Editable copy of the prompt body for this send only (does not touch the
  // saved library prompt). Seeded when a prompt is picked.
  const [firingBody, setFiringBody] = useState("");
  const detectedClis = useApp(s => s.detectedClis);
  // Spawnable agents for "start a new agent" — installed + enabled, no plain
  // terminal entries. Same list the new-tab (+) menu offers. Memoized so the
  // always-mounted bar doesn't rebuild the visibility Set per-agent each render.
  const newAgentChoices = useMemo(() => {
    const vis = visibleCliIds(agents.map(x => x.id), agents, detectedClis);
    return agents.filter(a => vis.has(a.id) && !isTerminalEntry(a));
  }, [agents, detectedClis]);
  const themeMode = usePrefs(s => s.themeMode);
  const setThemeMode = usePrefs(s => s.setThemeMode);
  // When the user picked an explicit theme, show that theme's icon.
  // When "auto" is selected, show the icon for whatever the OS resolved
  // to (Sun / Moon) — that's the theme they're actually looking at — and
  // overlay a small "A" badge so the auto distinction is visible.
  // The old Monitor/computer icon felt too generic ("display settings")
  // and didn't communicate the resolved theme at a glance.
  const isFullscreen = useIsFullscreen();
  const isAuto = themeMode === "auto";
  const resolved = resolveTheme(themeMode);
  const ThemeIcon = (themeMode === "light" || (isAuto && resolved === "light")) ? Sun : Moon;

  return (
    <header
      data-tauri-drag-region
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
      className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2"
      style={{
        // px-2 (8px) already pads the left in full-screen; only reserve the
        // wide traffic-light gap when the lights are actually there.
        paddingLeft: isFullscreen ? undefined : TRAFFIC_LIGHT_WIDTH,
        WebkitAppRegion: "drag",
      } as any}
    >
      {/* Sidebar toggle + theme cycler */}
      <div
        data-tauri-drag-region="false"
        className="flex items-center gap-2"
        style={{ WebkitAppRegion: "no-drag" } as any}
      >
        <Tip content={compact ? "Expand sidebar" : "Collapse sidebar"} side="bottom">
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
        {/* Theme picker — Radix dropdown opens on hover (and click).
            Three explicit options, never silently cycles. */}
        <ThemePicker themeMode={themeMode} setThemeMode={setThemeMode} Icon={ThemeIcon} />
        {/* Self-update pill — only renders when an update is actually
            available. Sits next to the theme picker so it's findable
            but not intrusive. */}
        <UpdaterBanner />
        {/* YOLO is per-workspace only — controlled from the workspace's
            sidebar dropdown ("YOLO: on/off"), with a red ⚡ status badge
            on the sidebar row. No top-bar toggle (it had no global
            meaning and was redundant with the per-workspace control). */}
      </div>

      {/* Breadcrumbs / title — text doesn't select on drag (matches AppKit title bar). */}
      <div className="ml-2 flex min-w-0 flex-1 select-none items-baseline gap-2 text-[14px]">
        {ws && proj ? (
          <>
            <span className="text-[var(--color-fg-faint)]">{proj.name}</span>
            <span className="text-[var(--color-fg-faint)]">/</span>
            {/* self-center pulls the icon off the baseline so it
                stays vertically centered next to text — items-baseline
                on the parent would otherwise stick the icon's bottom
                to the text baseline and float it too high. */}
            <span className={cn("flex items-center self-center", CLI_BRAND_COLOR[resolveIconId(ws.cli, agents)])}>
              <CliIcon cli={resolveIconId(ws.cli, agents)} className="h-4 w-4" />
            </span>
            {/* Workspace name == branch means the user never renamed it,
                so "<branch> on <branch>" reads as noise. Mirror the
                sidebar: render the REPO ROOT chip for the repo-root
                pseudo-workspace; otherwise just show the branch alone. */}
            {ws.is_repo_root && ws.name === ws.branch ? (
              <span className="shrink-0 rounded px-1 py-px text-[10.5px] font-semibold uppercase tracking-wide bg-[var(--color-bg-3)] text-[var(--color-fg-dim)]">
                REPO ROOT
              </span>
            ) : ws.name === ws.branch ? (
              <span className="truncate font-mono text-[13px] leading-tight text-[var(--color-fg)]">{ws.branch}</span>
            ) : (
              <>
                <span className="min-w-0 truncate pr-0.5 font-medium leading-tight text-[var(--color-fg)]">{ws.name}</span>
                <span className="leading-tight text-[var(--color-fg-faint)]">on</span>
                <span className="truncate font-mono text-[12px] leading-tight text-[var(--color-fg-dim)]">{ws.branch}</span>
              </>
            )}
            {/* Multi-repo: just a small chip with the member count.
                The full per-member breakdown (which dir_name, which
                branch, worktree vs live) lives in the right-panel
                target tabs where it actually matters. Stuffing it
                into the breadcrumb made the bar unreadable past 2
                members and pushed real chrome (Review / Send to main)
                off-screen on narrow windows. */}
            {(ws.composition?.length ?? 0) > 0 && (
              <span
                className="ml-1 inline-flex shrink-0 items-center rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider leading-none text-[var(--color-fg-dim)]"
                title={ws.composition!.map(m => m.mode === "worktree" ? `${m.dir_name} @${m.branch}` : `${m.dir_name} (live)`).join(" · ")}
              >
                {ws.composition!.length} repos
              </span>
            )}
          </>
        ) : (
          <span className="text-[var(--color-fg-faint)]">No workspace selected</span>
        )}
      </div>

      {/* Right-aligned actions */}
      <div
        data-tauri-drag-region="false"
        className="flex items-center gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as any}
      >
        {ws && proj && (
          <>
            <DropdownRoot>
              <DropdownTrigger asChild>
                <Button size="sm" variant="ghost" className="gap-1.5" data-no-drag>
                  <MessageSquareText className="h-4 w-4" />
                  <span>Prompts</span>
                </Button>
              </DropdownTrigger>
              <DropdownMenu align="end" className="min-w-[200px]">
                {enabledPrompts.length === 0 && (
                  <div className="px-2 py-1.5 text-[13px] text-[var(--color-fg-faint)]">No prompts yet.</div>
                )}
                {enabledPrompts.map(p => (
                  <DropdownItem key={p.id} onSelect={() => { setFiringPrompt(p); setFiringBody(p.body); }}>
                    <span className="truncate">{p.title}</span>
                  </DropdownItem>
                ))}
                <DropdownSeparator />
                <DropdownItem onSelect={() => openSettings("prompts")}>
                  <Library className="h-4 w-4" />
                  <span>Manage prompts…</span>
                </DropdownItem>
              </DropdownMenu>
            </DropdownRoot>

            {/* Destination picker: where should this prompt run? A running
                agent (send / queue), or a new agent with the CLI of your
                choice. A modal, not a submenu (which flipped to the wrong
                side near the window edge). */}
            {firingPrompt && (
              <AppDialog
                open
                onOpenChange={(v) => { if (!v) setFiringPrompt(null); }}
                title={`Run "${firingPrompt.title}"`}
                description="Tweak the prompt if needed, then pick where it runs."
                className="max-w-5xl"
              >
                <div className="mt-1 flex h-[58vh] gap-4">
                  {/* Left: editable prompt for THIS send (does not change the
                      saved library prompt). */}
                  <textarea
                    value={firingBody}
                    onChange={(e) => setFiringBody(e.target.value)}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    autoComplete="off"
                    className="h-full min-w-0 flex-1 resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                  />

                  {/* Right: where to run it. */}
                  <div className="flex w-[260px] shrink-0 flex-col gap-3 overflow-y-auto pr-0.5">
                    {liveAgents.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <div className="px-0.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">Send to a running agent</div>
                        {liveAgents.map(a => {
                          const current = a.id === focusedAgentId;
                          const busy = a.workState === "working";
                          return (
                            <button
                              key={a.id}
                              onClick={() => { runPrompt(ws.id, { ...firingPrompt, body: firingBody }, { kind: "agent", tabId: a.id }); setFiringPrompt(null); }}
                              className={cn(
                                "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                                current
                                  ? "border-[var(--color-border)] bg-[var(--color-bg-2)]"
                                  : "border-[var(--color-border)] hover:border-[var(--color-accent-soft)] hover:bg-[var(--color-hover)]",
                              )}
                            >
                              <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(a.cli, agents)])}>
                                <CliIcon cli={resolveIconId(a.cli, agents)} className="h-5 w-5" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] text-[var(--color-fg)]">
                                  {tabLabel(a)}
                                </span>
                                {(current || busy) && (
                                  <span className="block text-[10.5px]">
                                    {current && <span className="text-[var(--color-accent)]">current</span>}
                                    {current && busy && <span className="text-[var(--color-fg-faint)]"> · </span>}
                                    {busy && <span className="text-[var(--color-fg-faint)]">busy</span>}
                                  </span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex flex-col gap-0.5">
                      <div className="mb-0.5 flex items-center gap-1 px-0.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">
                        <Plus className="h-3 w-3" /> Start a new agent
                      </div>
                      {newAgentChoices.length === 0 ? (
                        <div className="px-0.5 py-1 text-[12.5px] text-[var(--color-fg-faint)]">No agents available.</div>
                      ) : newAgentChoices.map(a => (
                        <button
                          key={a.id}
                          onClick={() => { runPrompt(ws.id, { ...firingPrompt, body: firingBody }, { kind: "new", cli: a.id }); setFiringPrompt(null); }}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-hover)]"
                        >
                          <span className={cn("shrink-0 opacity-80", CLI_BRAND_COLOR[a.icon_id])}>
                            <CliIcon cli={a.icon_id} className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-fg-dim)]">{a.display_name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </AppDialog>
            )}
            {/* Send-to-main: only shown on actual worktrees, not the
                repo-root pseudo-workspace (which IS the main checkout —
                nothing to send). Hard-blocks on a dirty main checkout
                rather than risk mixing change sets; the error bubbles
                up via the alert below. */}
            {!ws.is_repo_root && (
              <Tip content="Bring this worktree's diff into the project's main checkout" side="bottom">
                <Button size="sm" variant="ghost" className="gap-1.5"
                  onClick={async () => {
                    const ok = await useUI.getState().askConfirm({
                      title: `Send "${ws.name}" to main?`,
                      message:
                        `Applies all tracked changes (committed + staged + unstaged) and copies untracked files into ${proj.root_path}. ` +
                        `The main checkout must be clean. Commit or stash there first.`,
                      confirmLabel: "Send to main",
                    });
                    if (!ok) return;
                    try {
                      const r = await workspaceSendDiffToMain(ws.id);
                      // Build a compact, human-readable summary. Quietly
                      // omit the zero halves so it reads as a result, not
                      // a checklist of nothings-happened.
                      const parts: string[] = [];
                      if (r.tracked_files)   parts.push(`${r.tracked_files} tracked diff${r.tracked_files === 1 ? "" : "s"} applied`);
                      if (r.untracked_files) parts.push(`${r.untracked_files} untracked file${r.untracked_files === 1 ? "" : "s"} copied`);
                      const summary = parts.length ? parts.join(", ") : "no changes to send";
                      useUI.getState().pushToast(`Sent to main checkout: ${summary}`, "success");
                    } catch (e) {
                      await useUI.getState().askConfirm({
                        title: "Send to main failed",
                        message: String(e),
                        confirmLabel: "OK",
                        cancelLabel: "",
                        destructive: true,
                      });
                    }
                  }}>
                  <ArrowUpToLine className="h-4 w-4" />
                  <span>Send to main</span>
                </Button>
              </Tip>
            )}
            {(() => {
              const sbMode = effectiveSandboxMode(ws);
              const tip = sbMode === "enforce" ? "Sandbox: Enforcing"
                : sbMode === "enforce-fs" ? "Sandbox: Enforcing filesystem (network open)"
                : sbMode === "monitor" ? "Sandbox: Monitoring (logging access)"
                : "Sandbox: off — click to enable";
              return (
                <Tip content={tip} side="bottom">
                  <Button size="icon" variant="icon"
                    onClick={() => useUI.getState().openSandbox(ws.id)}
                  >
                    {/* Color + fill come from SANDBOX_VISUALS; the toolbar
                        just swaps the glyph to an Eye for monitoring. */}
                    <SandboxIcon mode={sbMode} className="h-4 w-4" icon={sbMode === "monitor" ? Eye : undefined} />
                  </Button>
                </Tip>
              );
            })()}
            <Tip content="Archive workspace" side="bottom">
              <Button size="icon" variant="icon"
                onClick={async () => {
                  const ok = await useUI.getState().askConfirm({
                    title: `Archive "${ws.name}"?`,
                    // Repo-root entries aren't worktrees - archiving
                    // drops the Termic row only; the project checkout
                    // on disk is untouched and can be re-opened later.
                    message: ws.is_repo_root
                      ? "This removes the Termic entry for the project's main checkout. The repo on disk is NOT touched, so you can re-open it any time. Any agent running here will be terminated."
                      : (ws.composition?.length ?? 0) > 0
                      ? `Branches stay in git, so you can recreate the workspace later. This removes: the host worktree + every member worktree (${ws.composition!.filter(m => m.mode === "worktree").map(m => m.dir_name).join(", ") || "none"}), plus any member symlinks to live checkouts (those live repos are NOT touched). Any running agent will be terminated.`
                      : "The branch stays in git, so you can spin up a fresh worktree on it later. This removes only the on-disk worktree directory (build artifacts: node_modules, .venv, untracked files) and terminates any running agent. Can't be undone from inside Termic.",
                    confirmLabel: ws.is_repo_root ? "Remove entry" : "Archive",
                    destructive: true,
                    checkbox: ws.is_repo_root
                      ? undefined
                      : (ws.composition?.length ?? 0) > 0
                      ? {
                          label: "Delete the git branches",
                          defaultValue: false,
                        }
                      : {
                          label: "Delete the git branch:",
                          branchName: ws.branch || undefined,
                          defaultValue: false,
                        },
                  });
                  const confirmed = typeof ok === "boolean" ? ok : ok.confirmed;
                  const deleteBranch = typeof ok === "boolean" ? false : ok.checked;
                  if (!confirmed) return;
                  try {
                    useUI.getState().setBusy(`Archiving "${ws.name}"…`);
                    await archiveAndRefresh(ws.id, deleteBranch);
                  } finally { useUI.getState().setBusy(null); }
                }}
              ><Archive className="h-4 w-4" /></Button>
            </Tip>
            <Tip content="Open in Finder" side="bottom">
              <Button size="icon" variant="icon" onClick={() => openPath(ws.path).catch(() => {})}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </Tip>
            <div className="mx-1 h-4 w-px bg-[var(--color-border-soft)]" />
            <Tip content="Toggle right panel" side="bottom">
              <Button size="icon" variant="icon" onClick={toggleRP}>
                <PanelRight className="h-4 w-4" />
              </Button>
            </Tip>
          </>
        )}
      </div>
    </header>
  );
}

/** Theme picker — uses Radix HoverCard, which is purpose-built for "hover
 *  to reveal a panel". Handles cursor transit between trigger and content,
 *  open/close timing, and pointer leave/enter race conditions internally —
 *  the hand-rolled DropdownMenu + setTimeout approach flickered. */
function ThemePicker({
  themeMode, setThemeMode, Icon,
}: {
  /** The user's selection. The `auto` value drives the small "A"
   *  badge overlay so the user can tell their pick is "follow OS"
   *  rather than an explicit light/dark. Espresso + Solarized are
   *  dark-family palettes that the OS can't infer; they only ever
   *  come from an explicit dropdown pick. */
  themeMode: import("@/store/prefs").ThemeMode;
  setThemeMode: (m: import("@/store/prefs").ThemeMode) => void;
  /** Already resolved to Sun/Moon by the caller — when in auto mode
   *  this reflects the OS theme (not a generic Monitor icon). */
  Icon: typeof Sun;
}) {
  type Item = { id: import("@/store/prefs").ThemeMode; label: string; icon: typeof Sun };
  const items: Item[] = [
    // "System" = follow OS prefers-color-scheme. Stored as `auto` for backward
    // compatibility with existing localStorage values.
    { id: "auto",      label: "System",         icon: Monitor },
    { id: "light",     label: "Light",          icon: Sun },
    { id: "claude",    label: "Claude",         icon: Moon },
    { id: "dark",      label: "Dark+",          icon: Code2 },
    { id: "solarized", label: "Solarized Dark", icon: Sunrise },
    { id: "cobalt",    label: "Cobalt",         icon: Droplet },
    { id: "matrix",    label: "Matrix",         icon: Binary },
  ];
  // Plain DOM dropdown — Radix HoverCard's pointer-tracking kept
  // closing on item click (the theme-change re-render storm triggers
  // pointer-out detection somewhere internally). Manual implementation
  // gives us absolute control: opens on trigger hover, stays open until
  // outside click or cursor leaves the WHOLE region (trigger + content)
  // for closeDelayMs. Item clicks never close it — user can cycle
  // through System / Light / Dark to compare freely.
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const cancelClose = () => {
    if (closeTimerRef.current) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 200);
  };
  // Outside click closes immediately.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
    >
      <Button size="icon" variant="icon" onClick={() => setOpen(v => !v)}>
        <span className="relative inline-flex h-[18px] w-[18px] items-center justify-center">
          <Icon className="h-[18px] w-[18px]" />
          {themeMode === "auto" && (
            // Tiny "A" badge in the bottom-right corner to signal that
            // the visible Sun/Moon is the OS-resolved theme, not an
            // explicit user choice. Outline matches button bg so it
            // reads as a sticker on top of the icon, not part of it.
            <span
              className="absolute -bottom-1 -right-1 flex h-[10px] w-[10px] items-center justify-center rounded-full bg-[var(--color-accent)] text-[7px] font-bold leading-none text-white ring-1 ring-[var(--color-bg)]"
              aria-label="auto"
            >A</span>
          )}
        </span>
      </Button>
      {open && (
        <div
          className={cn(
            "absolute left-0 top-full z-50 mt-1 min-w-[170px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-1 shadow-xl",
          )}
        >
          {items.map(it => {
            const Ic = it.icon;
            const active = it.id === themeMode;
            return (
              <button
                key={it.id}
                onClick={() => setThemeMode(it.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13.5px] text-[var(--color-fg)]",
                  "hover:bg-[var(--color-hover)]",
                )}
              >
                <Check className={cn("h-3.5 w-3.5 text-[var(--color-accent)]", active ? "opacity-100" : "opacity-0")} />
                <Ic className="h-4 w-4 text-[var(--color-fg-dim)]" />
                <span>{it.label}</span>
              </button>
            );
          })}
          {/* One-time tip: agent CLIs persist their own theme. We set
              COLORFGBG on spawn so most TUIs auto-pick, but claude /
              gemini / codex also expose a `/theme` slash command that
              writes to ~/.claude / ~/.gemini / ~/.codex - persists
              across launches. Surfacing this here so users discover it
              the first time they switch themes. */}
          <div className="mt-1 border-t border-[var(--color-border-soft)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
            Tip: run <span className="mono text-[var(--color-fg-dim)]">/theme</span> inside claude / codex / gemini once to match. The setting persists.
          </div>
        </div>
      )}
    </div>
  );
}
