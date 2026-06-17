// ⌘K command palette — a searchable list of every workspace / view / app
// action, grouped into sections, with the action's shortcut (if any) shown on
// the right. Modelled on the ⌘P file finder + ⌘N project picker (shared fuzzy
// matcher), plus a one-level "Change theme" submenu you navigate with the
// arrow keys. NO solid backdrop (the old `bg-black/40` overlay flickered the
// whole screen on open) — just a subtle dim + blur that fades in, ⌘K only.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Search, Plus, FileText, Pencil, GitBranch, Archive, Zap, ShieldCheck,
  PanelLeft, PanelRight, Palette, Keyboard, Settings as SettingsIcon,
  FolderCog, RefreshCw, ScrollText, Bug, SlidersHorizontal, Bot, BookText,
  Check, ChevronLeft, type LucideIcon,
} from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs, type ThemeMode } from "@/store/prefs";
import { useUpdate } from "@/store/update";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { bindingGlyphs, type ShortcutId } from "@/lib/shortcuts";
import { confirmAndArchive } from "@/lib/archiveWorkspace";
import { workspaceSetYolo, openPath } from "@/lib/ipc";
import { effectiveSandboxMode } from "@/lib/types";
import { cn } from "@/lib/utils";

// New-issue page for the project repo. Opened via the OS browser (open_path).
const ISSUE_URL = "https://github.com/simion/termic/issues/new";

// Section render order. Sections with no (filtered) commands are dropped.
const SECTION_ORDER = ["Workspace", "Agent", "View", "Application", "Settings"] as const;
type Section = (typeof SECTION_ORDER)[number];

interface Cmd {
  id: string;
  section: Section;
  label: string;
  /** Secondary line under the label (e.g. the YOLO warning). */
  hint?: string;
  /** Inline dimmed text right after the label, same row (e.g. the branch). */
  suffix?: string;
  icon: LucideIcon;
  /** Renders this shortcut's glyphs on the right, resolved from prefs. */
  shortcutId?: ShortcutId;
  /** Extra search terms (not shown) so e.g. "palette" finds "Command…". */
  keywords?: string;
  destructive?: boolean;
  run: () => void;
}

const THEME_LABELS: Record<ThemeMode, string> = {
  auto: "System (auto)",
  light: "Light",
  dark: "Dark",
  claude: "Claude",
  solarized: "Solarized",
  cobalt: "Cobalt",
  matrix: "Matrix",
};
const THEME_ORDER: ThemeMode[] = ["auto", "light", "dark", "claude", "solarized", "cobalt", "matrix"];

export function CommandPalette() {
  const open = useUI(s => s.commandPaletteOpen);
  const close = useUI(s => s.closeCommandPalette);
  const activeWsId = useApp(s => s.activeWorkspaceId);
  const workspaces = useApp(s => s.workspaces);
  const projects = useApp(s => s.projects);
  const themeMode = usePrefs(s => s.themeMode);
  const binds = usePrefs(s => s.shortcuts);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  // "root" = the full command list, "theme" = the Change-theme submenu.
  const [view, setView] = useState<"root" | "theme">("root");
  const listRef = useRef<HTMLDivElement>(null);
  // Element focused before the palette opened — the terminal (main / split /
  // aux), an input, whatever. Restored on close so focus doesn't fall to
  // <body>. Captured in onOpenAutoFocus (before Radix moves focus inward).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The ORIGINAL theme while the Change-theme submenu is previewing live.
  // null when no preview is active (never entered, or committed). Set means
  // "roll back to this if the user cancels / closes without choosing".
  const themeOriginalRef = useRef<ThemeMode | null>(null);

  const ws = useMemo(() => workspaces.find(w => w.id === activeWsId) ?? null, [workspaces, activeWsId]);
  const proj = useMemo(() => (ws ? projects.find(p => p.id === ws.project_id) ?? null : null), [projects, ws]);

  // Roll the live theme preview back and leave the submenu.
  const cancelThemePreview = () => {
    if (themeOriginalRef.current) {
      usePrefs.getState().setThemeMode(themeOriginalRef.current);
      themeOriginalRef.current = null;
    }
    setView("root"); setQuery("");
  };

  // Reset on open; roll back an uncommitted theme preview on close (outside
  // click / ⌘K while still previewing).
  useEffect(() => {
    if (open) { setQuery(""); setActiveIdx(0); setView("root"); }
    else if (themeOriginalRef.current) {
      usePrefs.getState().setThemeMode(themeOriginalRef.current);
      themeOriginalRef.current = null;
    }
  }, [open]);
  // Reset the highlight on query change…
  useEffect(() => { setActiveIdx(0); }, [query]);
  // …but when entering the theme submenu, start on the CURRENT theme so the
  // live preview doesn't jump the instant you open it.
  useEffect(() => {
    if (view === "theme") {
      const cur = themeOriginalRef.current ?? usePrefs.getState().themeMode;
      setActiveIdx(Math.max(0, THEME_ORDER.indexOf(cur)));
    } else setActiveIdx(0);
  }, [view]);

  /** Wrap an action so it closes the palette, then runs on the NEXT frame.
   *  The defer matters when the action opens another dialog (Archive → confirm,
   *  Sandbox, New workspace): the palette is non-modal, so the click that
   *  triggered the row would otherwise reach the freshly-mounted dialog's
   *  dismissable layer and dismiss it instantly. One frame lets the click
   *  fully settle first. Harmless for synchronous actions. */
  const act = (fn: () => void) => () => { close(); requestAnimationFrame(fn); };

  // Build the full command list. Workspace/agent rows only exist when a
  // workspace is active. Everything reads live store state at build time.
  const commands = useMemo<Cmd[]>(() => {
    if (view === "theme") {
      return THEME_ORDER.map<Cmd>(m => ({
        id: `theme:${m}`,
        section: "View",
        label: THEME_LABELS[m],
        icon: m === themeMode ? Check : Palette,
        keywords: "theme appearance color",
        // Commit: the live preview already applied it; clear the rollback
        // marker so close() won't revert, then close.
        run: () => { themeOriginalRef.current = null; usePrefs.getState().setThemeMode(m); close(); },
      }));
    }

    const cmds: Cmd[] = [];

    // ── Workspace ──────────────────────────────────────────────────────
    cmds.push({
      id: "new-workspace", section: "Workspace", label: "New workspace…",
      icon: Plus, shortcutId: "new-workspace-quick", keywords: "create worktree project",
      run: act(() => useUI.getState().openProjectPicker()),
    });
    if (ws) {
      cmds.push({
        id: "file-picker", section: "Workspace", label: "File picker",
        icon: FileText, shortcutId: "file-finder", keywords: "open goto fuzzy",
        run: act(() => useUI.getState().openFileFinder(ws.id)),
      });
      cmds.push({
        id: "find-in-files", section: "Workspace", label: "Find in files",
        icon: Search, shortcutId: "find-in-files", keywords: "grep search ripgrep",
        run: act(() => useUI.getState().openFindInFiles(ws.id)),
      });
      cmds.push({
        id: "rename-workspace", section: "Workspace", label: "Rename workspace",
        icon: Pencil, keywords: "name title",
        run: act(() => startRename(ws.id, ws.project_id)),
      });
      if (ws.branch) {
        cmds.push({
          id: "copy-branch", section: "Workspace", label: "Copy branch name",
          suffix: ws.branch, icon: GitBranch, keywords: "git clipboard",
          run: act(() => {
            navigator.clipboard.writeText(ws.branch).catch(() => {});
            useUI.getState().pushToast(`Copied "${ws.branch}"`);
          }),
        });
      }
      cmds.push({
        // Not styled destructive — confirmAndArchive shows a confirm modal
        // (with the delete-branch checkbox), so the red isn't needed here.
        id: "archive-workspace", section: "Workspace", label: `Archive "${ws.name}"`,
        icon: Archive, keywords: "delete remove close worktree",
        run: act(() => { void confirmAndArchive(ws); }),
      });
    }

    // ── Agent ──────────────────────────────────────────────────────────
    if (ws) {
      const enforced = effectiveSandboxMode(ws) === "enforce";
      cmds.push({
        id: "toggle-yolo", section: "Agent",
        label: enforced ? "YOLO is forced on (Enforcing)" : ws.yolo ? "Disable YOLO" : "Enable YOLO",
        suffix: "Dangerously skip permissions",
        icon: Zap, keywords: "auto approve permissions dangerous",
        run: act(() => {
          if (enforced) return;
          const next = !ws.yolo;
          useApp.getState().setWorkspaceYolo(ws.id, next);
          void workspaceSetYolo(ws.id, next);
          useUI.getState().pushToast(next ? "YOLO enabled" : "YOLO disabled");
        }),
      });
      cmds.push({
        id: "sandbox", section: "Agent", label: "Sandbox settings",
        suffix: effectiveSandboxMode(ws),
        icon: ShieldCheck, keywords: "cage security enable disable",
        run: act(() => useUI.getState().openSandbox(ws.id)),
      });
    }

    // ── View ───────────────────────────────────────────────────────────
    cmds.push({
      id: "toggle-left-sidebar", section: "View", label: "Toggle left sidebar",
      icon: PanelLeft, shortcutId: "toggle-left-sidebar", keywords: "projects collapse hide",
      run: act(() => useApp.getState().toggleCompactSidebar()),
    });
    cmds.push({
      id: "toggle-right-sidebar", section: "View", label: "Toggle right sidebar",
      icon: PanelRight, shortcutId: "toggle-right-sidebar", keywords: "panel diff changes hide",
      run: act(() => useApp.getState().toggleRightPanel()),
    });
    cmds.push({
      id: "change-theme", section: "View", label: "Change theme…",
      suffix: THEME_LABELS[themeMode], icon: Palette, keywords: "appearance color dark light",
      run: () => {
        // Enter the submenu and start a live preview — arrowing through the
        // themes applies each one; cancelling restores this captured original.
        themeOriginalRef.current = usePrefs.getState().themeMode;
        setView("theme"); setQuery("");
      },
    });
    cmds.push({
      id: "shortcuts", section: "View", label: "Keyboard shortcuts",
      icon: Keyboard, shortcutId: "open-shortcuts", keywords: "keys bindings cheat sheet",
      run: act(() => useUI.getState().openShortcutsHelp()),
    });

    // ── Application ─────────────────────────────────────────────────────
    cmds.push({
      id: "settings", section: "Application", label: "Settings",
      icon: SettingsIcon, shortcutId: "open-settings", keywords: "preferences config",
      run: act(() => useApp.getState().openSettings()),
    });
    if (proj) {
      cmds.push({
        id: "project-settings", section: "Application", label: "Project settings",
        suffix: proj.name, icon: FolderCog, keywords: "repository scripts setup run archive",
        run: act(() => useApp.getState().openSettings("repositories", proj.id)),
      });
    }
    cmds.push({
      id: "check-updates", section: "Application", label: "Check for updates",
      icon: RefreshCw, keywords: "version upgrade",
      run: act(async () => {
        const r = await useUpdate.getState().checkNow();
        useUI.getState().pushToast(
          r === "available" ? "Update available" : r === "error" ? "Update check failed" : "You're up to date",
          r === "error" ? "error" : "success",
        );
      }),
    });
    cmds.push({
      id: "changelog", section: "Application", label: "Open changelog",
      icon: ScrollText, keywords: "release notes whats new version",
      run: act(() => useUI.getState().openChangelog()),
    });
    cmds.push({
      id: "open-issue", section: "Application", label: "Open an issue",
      icon: Bug, keywords: "github bug report feedback",
      run: act(() => { void openPath(ISSUE_URL); }),
    });

    // ── Settings (deep links) ───────────────────────────────────────────
    const settingsLinks: Array<[string, string, LucideIcon]> = [
      ["general", "General settings", SlidersHorizontal],
      ["appearance", "Appearance settings", Palette],
      ["agents", "Agent CLIs settings", Bot],
      ["prompts", "Prompt library", BookText],
      ["shortcuts", "Keyboard shortcuts settings", Keyboard],
    ];
    for (const [tab, label, icon] of settingsLinks) {
      cmds.push({
        id: `settings:${tab}`, section: "Settings", label, icon, keywords: "settings preferences",
        run: act(() => useApp.getState().openSettings(tab as any)),
      });
    }

    return cmds;
  }, [view, ws, proj, themeMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter + score against the query, preserving section order. Each command
  // matches on "<label> <keywords>"; only label-range hits are highlighted.
  const filtered = useMemo(() => {
    type Scored = { cmd: Cmd; score: number; labelMatches: number[] };
    const out: Scored[] = [];
    for (const cmd of commands) {
      if (!query) { out.push({ cmd, score: 0, labelMatches: [] }); continue; }
      const hay = cmd.keywords ? `${cmd.label} ${cmd.keywords}` : cmd.label;
      const m = fuzzyMatch(hay, query);
      if (!m) continue;
      out.push({ cmd, score: m.score, labelMatches: m.matches.filter(i => i < cmd.label.length) });
    }
    // Group by section (in SECTION_ORDER); within a section, querying sorts by
    // score so the strongest match floats up, otherwise keep insertion order.
    const bySection = new Map<Section, Scored[]>();
    for (const s of out) {
      const arr = bySection.get(s.cmd.section) ?? [];
      arr.push(s);
      bySection.set(s.cmd.section, arr);
    }
    const groups: Array<{ section: Section; items: Scored[] }> = [];
    for (const section of SECTION_ORDER) {
      const items = bySection.get(section);
      if (!items || items.length === 0) continue;
      if (query) items.sort((a, b) => b.score - a.score);
      groups.push({ section, items });
    }
    const rows: Scored[] = groups.flatMap(g => g.items);
    return { groups, rows };
  }, [commands, query]);

  const rows = filtered.rows;

  // Clamp the active index to the current row count.
  useEffect(() => {
    if (activeIdx > rows.length - 1) setActiveIdx(Math.max(0, rows.length - 1));
  }, [rows.length, activeIdx]);

  // Scroll the active row into view on keyboard nav.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Live theme preview — apply the highlighted theme as you move through the
  // submenu. Just a CSS-var swap, fully reversible (cancelThemePreview).
  useEffect(() => {
    if (view !== "theme") return;
    const id = rows[activeIdx]?.cmd.id;
    if (id?.startsWith("theme:")) usePrefs.getState().setThemeMode(id.slice(6) as ThemeMode);
  }, [view, activeIdx, rows]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[activeIdx]?.cmd.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (view === "theme") cancelThemePreview(); else close();
    } else if (e.key === "Backspace" && !query && view === "theme") {
      e.preventDefault();
      cancelThemePreview();
    }
  }

  // Resolve a command's shortcut glyphs (if it has a binding).
  const glyphsFor = (id?: ShortcutId) => (id && binds[id] ? bindingGlyphs(binds[id]) : null);

  let rowIdx = -1; // running index across sections for keyboard nav mapping

  return (
    // Non-modal: the palette never traps focus / hides siblings. This is what
    // lets an action open ANOTHER dialog (Archive → confirm, Sandbox settings,
    // etc.) — a modal palette lingering through its 130ms close animation would
    // keep the new dialog inert/aria-hidden until it unmounted. Non-modal also
    // matches the "no backdrop" intent; outside-click dismissal still works via
    // Radix's dismissable layer (no overlay needed). The blur lives on the
    // panel itself (backdrop-blur), so there's nothing full-screen to flicker.
    <Dialog.Root open={open} onOpenChange={(v) => (v ? null : close())} modal={false}>
      <Dialog.Portal>
        <Dialog.Content
          // Capture whatever was focused BEFORE Radix pulls focus into the
          // palette (terminal main/split/aux, an input, …) so we can restore it.
          onOpenAutoFocus={() => { returnFocusRef.current = (document.activeElement as HTMLElement) ?? null; }}
          // On close, return focus to that element — but only if nothing else
          // legitimately claimed it (a dialog a command opened). rAF lets the
          // panel unmount and any follow-up surface grab focus first.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const el = returnFocusRef.current;
            requestAnimationFrame(() => {
              const ae = document.activeElement;
              if ((!ae || ae === document.body) && el && document.contains(el)) el.focus();
            });
          }}
          // Translucent so the blurred app shows through (Conductor look). The
          // lower the percentage, the more the (blurred) app behind bleeds
          // through — the strong backdrop-blur keeps it readable.
          style={{ background: "color-mix(in srgb, var(--color-bg-1) 42%, transparent)" }}
          className="termic-pop fixed left-1/2 top-[14vh] z-50 w-[min(620px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl outline-none backdrop-blur-md"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">Search and run a command.</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
            {view === "theme" ? (
              <button
                type="button"
                onClick={cancelThemePreview}
                className="shrink-0 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
                title="Back"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : (
              <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
            )}
            <input
              // No `autoFocus` — React's autofocus would fire before our
              // onOpenAutoFocus capture and clobber the return-focus element.
              // Radix focuses this input (first focusable) right after capture.
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder={view === "theme" ? "Pick a theme…" : "Type a command or search…"}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
          </div>
          <div ref={listRef} className="no-scrollbar max-h-[min(60vh,440px)] overflow-y-auto py-1">
            {rows.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">No matching commands</div>
            )}
            {filtered.groups.map(group => (
              <div key={group.section}>
                <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">
                  {group.section}
                </div>
                {group.items.map(({ cmd, labelMatches }) => {
                  rowIdx += 1;
                  const i = rowIdx;
                  const Icon = cmd.icon;
                  const glyphs = glyphsFor(cmd.shortcutId);
                  return (
                    <button
                      key={cmd.id}
                      data-row={i}
                      onClick={() => cmd.run()}
                      onMouseMove={() => setActiveIdx(i)}
                      // Subtle neutral highlight (Conductor-style) — a faint
                      // fg-tinted overlay, theme-aware, no accent/border.
                      style={i === activeIdx ? { background: "color-mix(in srgb, var(--color-fg) 8%, transparent)" } : undefined}
                      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                    >
                      <Icon className={cn(
                        "h-4 w-4 shrink-0",
                        cmd.destructive ? "text-[var(--color-err)]" : "text-[var(--color-fg-dim)]",
                      )} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className={cn(
                            "truncate text-[13px]",
                            cmd.destructive ? "text-[var(--color-err)]" : "text-[var(--color-fg)]",
                          )}>
                            {query ? <Highlighted text={cmd.label} matches={labelMatches} /> : cmd.label}
                          </span>
                          {cmd.suffix && (
                            <span className="shrink-0 text-[11.5px] text-[var(--color-fg-faint)]">{cmd.suffix}</span>
                          )}
                        </div>
                        {cmd.hint && (
                          <div className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{cmd.hint}</div>
                        )}
                      </div>
                      {glyphs && (
                        // Plain gray glyph text on the right (Conductor-style),
                        // not boxed keycaps.
                        <span className="shrink-0 text-[12px] tracking-wide text-[var(--color-fg-faint)]">
                          {glyphs.join("")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );

  // Start the sidebar's inline rename for `wsId`. The row only exists when its
  // project is expanded (and the row is selected/scrolled into view), so
  // expand + select first, then fire the rename signal the row watches.
  function startRename(wsId: string, projectId: string) {
    const app = useApp.getState();
    app.setProjectCollapsed(projectId, false);
    if (app.compactSidebar) app.toggleCompactSidebar(); // full-width row needed to show the input
    app.setActiveWorkspace(wsId);
    useUI.getState().requestWorkspaceRename(wsId);
  }
}
