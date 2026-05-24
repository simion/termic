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
  Sun, Moon, Monitor, Zap, ArrowUpToLine, Sunrise, Droplet, Binary, Code2,
} from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { UpdaterBanner } from "@/components/UpdaterBanner";
import { openPath, workspaceRunScript, workspaceArchive, workspaceSendDiffToMain } from "@/lib/ipc";
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
  const sandboxBypassPermissions = usePrefs(s => s.sandboxBypassPermissions);
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
        {/* YOLO visualizes its safety state based on the active workspace's
            sandbox pin:
              - OFF                 → dim gray, neutral tooltip
              - ON  + sandboxed     → green, "safe" tooltip (sandbox cages
                                       any damage the agent could do)
              - ON  + NOT sandboxed → red, DANGER tooltip - the agent
                                       can rm -rf $HOME if it wants to
            The visual difference between "green safe" and "red dangerous"
            is the load-bearing UX: a casual glance has to communicate
            "you are taking on real risk right now."

            When sandbox is on we ALSO auto-pass YOLO at spawn even if
            the toggle is off (sandbox is the real boundary), so the
            toggle is informational in that case - it just affects
            unsandboxed workspaces. */}
        {(() => {
          const sandboxed = !!ws?.sandbox_enabled;
          // Sandboxed workspaces auto-pass YOLO at spawn unless the user
          // disabled it in Settings → General.
          const autoYolo = sandboxed && sandboxBypassPermissions;
          const dangerous = yoloMode && !sandboxed;
          const tipContent = dangerous
            ? "⚠️ YOLO ON without a sandbox — agents auto-approve EVERY action, including writes outside the worktree, network calls, and shell commands. Click to disable or enable the workspace sandbox first."
            : yoloMode && sandboxed
              ? "YOLO ON — safe: this workspace is sandboxed, so auto-approval is bounded by the seatbelt profile."
              : autoYolo
                ? "YOLO OFF (but this workspace is sandboxed, so YOLO is auto-on for it anyway)."
                : sandboxed
                  ? "YOLO OFF — this workspace is sandboxed but bypass-permissions is off, so agents still ask for approvals."
                  : "YOLO OFF — agents will ask for approvals. YOLO mode is automatically enabled for sandboxed agents.";
          return (
            <Tip content={tipContent} side="bottom">
              <Button
                size="icon" variant="icon" onClick={() => setYoloMode(!yoloMode)}
                className={cn(
                  dangerous && "text-white bg-[var(--color-err)] hover:bg-[var(--color-err)]/80 ring-1 ring-[var(--color-err)]",
                  yoloMode && sandboxed && "text-[var(--color-ok)] bg-[var(--color-ok)]/15",
                  !yoloMode && sandboxed && "text-[var(--color-ok)] opacity-70",
                )}
              >
                <Zap className="h-[18px] w-[18px]" />
              </Button>
            </Tip>
          );
        })()}
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
            <span className={cn("flex items-center self-center", CLI_BRAND_COLOR[ws.cli])}>
              <CliIcon cli={ws.cli} className="h-4 w-4" />
            </span>
            <span className="min-w-0 truncate pr-0.5 font-medium leading-tight text-[var(--color-fg)]">{ws.name}</span>
            <span className="leading-tight text-[var(--color-fg-faint)]">on</span>
            <span className="truncate font-mono text-[12px] leading-tight text-[var(--color-fg-dim)]">{ws.branch}</span>
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
                    const ok = await useUI.getState().askConfirm({
                      title: `Send "${ws.name}" to main?`,
                      message:
                        `Applies all tracked changes (committed + staged + unstaged) and copies untracked files into ${proj.root_path}. ` +
                        `The main checkout must be clean — commit or stash there first.`,
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
                      useUI.getState().pushToast(`Sent to main checkout — ${summary}`, "success");
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
            <Tip content="Archive workspace" side="bottom">
              <Button size="icon" variant="icon"
                onClick={async () => {
                  const ok = await useUI.getState().askConfirm({
                    title: `Archive "${ws.name}"?`,
                    // Repo-root entries aren't worktrees - archiving
                    // drops the Termic row only; the project checkout
                    // on disk is untouched and can be re-opened later.
                    message: ws.is_repo_root
                      ? "This removes the Termic entry for the project's main checkout. The repo on disk is NOT touched — you can re-open it any time. Any agent running here will be terminated."
                      : (ws.composition?.length ?? 0) > 0
                      ? `Branches stay in git — you can recreate the workspace later. This removes: the host worktree + every member worktree (${ws.composition!.filter(m => m.mode === "worktree").map(m => m.dir_name).join(", ") || "none"}), plus any member symlinks to live checkouts (those live repos are NOT touched). Any running agent will be terminated.`
                      : "The branch stays in git — you can spin up a fresh worktree on it later. This removes only the on-disk worktree directory (build artifacts: node_modules, .venv, untracked files) and terminates any running agent. Can't be undone from inside Termic.",
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
                    await workspaceArchive(ws.id, deleteBranch); setActive(null); await loadAll();
                  } catch (e) { console.error(e); }
                  finally { useUI.getState().setBusy(null); }
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
