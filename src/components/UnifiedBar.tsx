// Single horizontal chrome strip spanning the whole window. Mirrors
// Termic's design: traffic-light reservation on the left, sidebar toggle,
// project/workspace breadcrumbs in the middle, action icons on the right.
// The whole strip is a drag region so the user can move the window from any
// empty space, with `no-drag` opted-in on every interactive child.

import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp, useActiveWorkspace } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import * as HoverCard from "@radix-ui/react-hover-card";
import { Check } from "lucide-react";
import {
  PanelLeft, PanelRight, FolderOpen, Play, Archive, ShieldCheck,
  Sun, Moon, Monitor, Zap,
} from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { openPath, workspaceRunScript, workspaceArchive } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
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
  const ThemeIcon = themeMode === "light" ? Sun : themeMode === "dark" ? Moon : Monitor;

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
          <Button size="icon" variant="icon" onClick={toggleCompact}>
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
  themeMode: "auto" | "light" | "dark";
  setThemeMode: (m: "auto" | "light" | "dark") => void;
  Icon: typeof Sun;
}) {
  const items: { id: "auto" | "light" | "dark"; label: string; icon: typeof Sun }[] = [
    // "System" = follow OS prefers-color-scheme. Stored as `auto` for backward
    // compatibility with existing localStorage values.
    { id: "auto",  label: "System", icon: Monitor },
    { id: "light", label: "Light",  icon: Sun },
    { id: "dark",  label: "Dark",   icon: Moon },
  ];
  // Controlled open so clicking an item doesn't close the dropdown — the
  // theme switch re-renders the whole tree (html.light/.dark class flips
  // + every component subscribed to themeMode updates), and Radix's
  // uncontrolled HoverCard sometimes loses its open state through that
  // churn. Keeping `open` in our own state survives the re-render and
  // lets the user click through multiple themes without re-hovering.
  const [open, setOpen] = useState(false);
  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={120} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <Button size="icon" variant="icon" onClick={() => { /* hover handles open */ }}>
          <Icon className="h-[18px] w-[18px]" />
        </Button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          align="start" sideOffset={4}
          className={cn(
            "z-50 min-w-[140px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-1 shadow-xl",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
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
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
