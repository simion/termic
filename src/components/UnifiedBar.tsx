// Single horizontal chrome strip spanning the whole window. Mirrors
// Termic's design: traffic-light reservation on the left, sidebar toggle,
// project/workspace breadcrumbs in the middle, action icons on the right.
// The whole strip is a drag region so the user can move the window from any
// empty space, with `no-drag` opted-in on every interactive child.

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp, useActiveWorkspace } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import * as HoverCard from "@radix-ui/react-hover-card";
import { Check } from "lucide-react";
import {
  PanelLeft, PanelRight, FolderOpen, Play, Archive, ShieldCheck,
  Sun, Moon, Monitor, Zap, ArrowUpToLine, Coffee, Sunrise,
} from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { openPath, workspaceRunScript, workspaceArchive, workspaceSendDiffToMain } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { cn } from "@/lib/utils";

// Reserve enough room for the 3 traffic lights + breathing room before the
// first interactive control. 16 (x offset) + ~58 (3 buttons + gaps) + 10 pad.
const TRAFFIC_LIGHT_WIDTH = 84;

export function UnifiedBar() {
  const compact = useApp(s => s.compactSidebar);
  const toggleCompact = useApp(s => s.toggleCompactSidebar);
  const toggleRP = useApp(s => s.toggleRightPanel);
  const setActive = useApp(s => s.setActiveWorkspace);
  const loadAll = useApp(s => s.loadAll);
  const ws = useActiveWorkspace();
  const proj = useApp(s => ws ? s.projects.find(p => p.id === ws.project_id) : null);
  const openReview = useUI(s => s.openReview);
  const themeMode = usePrefs(s => s.themeMode);
  const setThemeMode = usePrefs(s => s.setThemeMode);
  const yoloMode = usePrefs(s => s.yoloMode);
  const setYoloMode = usePrefs(s => s.setYoloMode);
  // When the user picked an explicit theme, show that theme's icon.
  // When "auto" is selected, show the icon for whatever the OS resolved
  // to (Sun / Moon) — that's the theme they're actually looking at — and
  // overlay a small "A" badge so the auto distinction is visible.
  // The old Monitor/computer icon felt too generic ("display settings")
  // and didn't communicate the resolved theme at a glance.
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
        paddingLeft: TRAFFIC_LIGHT_WIDTH,
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
        <Tip content={yoloMode
          ? "YOLO ON — auto-approve everything. Gemini updates live; claude/codex need a fresh tab."
          : "YOLO OFF — agents will ask for approvals."} side="bottom">
          <Button
            size="icon" variant="icon" onClick={() => setYoloMode(!yoloMode)}
            className={cn(yoloMode && "text-[var(--color-accent)] bg-[var(--color-accent-soft)]")}
          >
            <Zap className="h-[18px] w-[18px]" />
          </Button>
        </Tip>
      </div>

      {/* Breadcrumbs / title — text doesn't select on drag (matches AppKit title bar). */}
      <div className="ml-2 flex min-w-0 flex-1 select-none items-center gap-2 text-[14px]">
        {ws && proj ? (
          <>
            <span className="text-[var(--color-fg-faint)]">{proj.name}</span>
            <span className="text-[var(--color-fg-faint)]">/</span>
            <span className={cn("flex items-center", CLI_BRAND_COLOR[ws.cli])}>
              <CliIcon cli={ws.cli} className="h-4 w-4" />
            </span>
            <span className="truncate font-medium text-[var(--color-fg)]">{ws.name}</span>
            <span className="text-[var(--color-fg-faint)]">on</span>
            <span className="truncate font-mono text-[12px] text-[var(--color-fg-dim)]">{ws.branch}</span>
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
            <Tip content="Run" side="bottom">
              <Button size="icon" variant="icon" onClick={() => workspaceRunScript(ws.id).catch(() => {})}>
                <Play className="h-4 w-4" />
              </Button>
            </Tip>
            <Tip content="AI code review" side="bottom">
              <Button size="sm" variant="ghost" onClick={() => openReview(ws.id)} className="gap-1.5">
                <ShieldCheck className="h-4 w-4" />
                <span>Review</span>
              </Button>
            </Tip>
            {/* Send-to-main: only shown on actual worktrees, not the
                repo-root pseudo-workspace (which IS the main checkout —
                nothing to send). Hard-blocks on a dirty main checkout
                rather than risk mixing change sets; the error bubbles
                up via the alert below. */}
            {!ws.is_repo_root && (
              <Tip content="Bring this worktree's diff into the project's main checkout" side="bottom">
                <Button size="sm" variant="ghost" className="gap-1.5"
                  onClick={async () => {
                    if (!confirm(
                      `Send "${ws.name}" diff into the main checkout?\n\n` +
                      `This applies all tracked changes (committed + staged + unstaged) ` +
                      `and copies untracked files into ${proj.root_path}.\n\n` +
                      `The main checkout must be clean — commit or stash there first.`,
                    )) return;
                    try {
                      const r = await workspaceSendDiffToMain(ws.id);
                      alert(
                        `Sent to main checkout.\n\n` +
                        `Tracked file diffs applied: ${r.tracked_files}\n` +
                        `Untracked files copied: ${r.untracked_files}`,
                      );
                    } catch (e) {
                      alert(`Send to main failed:\n\n${e}`);
                    }
                  }}>
                  <ArrowUpToLine className="h-4 w-4" />
                  <span>Send to main</span>
                </Button>
              </Tip>
            )}
            <Tip content="Archive workspace" side="bottom">
              <Button size="icon" variant="icon"
                onClick={async () => {
                  if (!confirm(`Archive workspace "${ws.name}"? The worktree will be removed from git.`)) return;
                  try { await workspaceArchive(ws.id); setActive(null); await loadAll(); } catch (e) { console.error(e); }
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
    { id: "dark",      label: "Dark",           icon: Moon },
    { id: "espresso",  label: "Espresso",       icon: Coffee },
    { id: "solarized", label: "Solarized Dark", icon: Sunrise },
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
            Tip: run <span className="mono text-[var(--color-fg-dim)]">/theme</span> inside claude / gemini / codex once to match. The setting persists.
          </div>
        </div>
      )}
    </div>
  );
}
