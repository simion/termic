// ⇧⌘P command palette — a searchable list of every task / view / app
// action, grouped into sections, with the action's shortcut (if any) shown on
// the right. Modelled on the ⌘P file finder + ⌘N project picker (shared fuzzy
// matcher), plus a one-level "Change theme" submenu you navigate with the
// arrow keys. NO solid backdrop (the old `bg-black/40` overlay flickered the
// whole screen on open) — just a subtle dim + blur that fades in, ⇧⌘P only.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Search, Plus, FileText, Pencil, GitBranch, Archive, Zap, ShieldCheck,
  PanelLeft, PanelRight, PanelBottom, Palette, Keyboard, Settings as SettingsIcon,
  FolderCog, RefreshCw, ScrollText, Bug, SlidersHorizontal, Bot, BookText,
  Check, ChevronLeft, ListTodo, Bell, SquareTerminal, FolderPlus, History, Square,
  Play, Swords, Megaphone, Columns2, Rows2, Clock, UserPen, Activity, Code2,
  NotepadText, type LucideIcon,
} from "lucide-react";
import { useUI } from "@/store/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { useApp } from "@/store/app";
import { jumpToNextWaiting } from "@/lib/waitingAgents";
import { newScratchTab } from "@/lib/scratchTabs";
import { readRecents, recentIds, recordRecent } from "@/lib/paletteRecent";
import { usePrefs, type BuiltinThemeMode, type ThemeMode } from "@/store/prefs";
import { useUpdate } from "@/store/update";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { bindingGlyphs, type ShortcutId } from "@/lib/shortcuts";
import { confirmAndArchive } from "@/lib/archiveTask";
import { taskSetYolo, openPath, procmonOpenWindow } from "@/lib/ipc";
import { isCustomId } from "@/lib/customTheme";
import { effectiveLanguageId, languageLabel } from "@/lib/languages";
import { effectiveSandboxMode, isSandboxEnforced } from "@/lib/types";
import { cn } from "@/lib/utils";

// New-issue page for the project repo. Opened via the OS browser (open_path).
const ISSUE_URL = "https://github.com/simion/termic/issues/new";

// Section render order. Sections with no (filtered) commands are dropped.
const SECTION_ORDER = ["Task", "Agent", "View", "Application", "Settings"] as const;
type Section = (typeof SECTION_ORDER)[number];

/** Pseudo-section pinned above the rest, holding what you last ran (expiry and
 *  ordering live in lib/paletteRecent). Not in SECTION_ORDER: it is built from
 *  the other sections' commands rather than being a home for any of them. */
const RECENT_SECTION = "Recent";

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
  /** Float this command to the TOP of its section on an empty query. For a
   *  command whose relevance depends on what is on screen rather than on
   *  where it was pushed: "Set syntax…" is a minor view preference for a
   *  file, and the only way to declare what the buffer is for a scratchpad.
   *  Insertion order decides everything else, so this stays rare. */
  priority?: boolean;
  destructive?: boolean;
  /** Keep this command OUT of the Recent section. The top Recent row is the
   *  pre-selected one, so Enter on a freshly-opened palette runs it — which is
   *  fine for "Open settings" and emphatically not for anything that ends an
   *  agent or a task. Archiving twice in a row is not a workflow worth
   *  optimising; doing it by accident is a real risk, more so once the user has
   *  unticked "Show this every time" on the archive confirm. */
  noRecent?: boolean;
  run: () => void;
}

const THEME_LABELS: Record<BuiltinThemeMode, string> = {
  auto: "System (auto)",
  light: "Light",
  dark: "Dark",
  claude: "Claude",
  solarized: "Solarized",
  cobalt: "Cobalt",
  matrix: "Matrix",
  rosepine: "Rosé Pine",
};
const THEME_ORDER: BuiltinThemeMode[] = ["auto", "light", "dark", "claude", "solarized", "cobalt", "matrix", "rosepine"];

export function CommandPalette() {
  const open = useUI(s => s.commandPaletteOpen);
  const close = useUI(s => s.closeCommandPalette);
  const activeTaskId = useApp(s => s.activeTaskId);
  const tasks = useApp(s => s.tasks);
  const projects = useApp(s => s.projects);
  const themeMode = usePrefs(s => s.themeMode);
  const customThemes = usePrefs(s => s.customThemes);
  const binds = usePrefs(s => s.shortcuts);
  const inlineBlame = usePrefs(s => s.inlineBlame);

  // Built-ins first, then the custom theme files — the submenu's order.
  const themeEntries = useMemo<{ id: ThemeMode; label: string }[]>(
    () => [
      ...THEME_ORDER.map(m => ({ id: m as ThemeMode, label: THEME_LABELS[m] })),
      ...customThemes.map(t => ({ id: t.id as ThemeMode, label: t.name })),
    ],
    [customThemes],
  );
  const themeLabel = (m: ThemeMode) =>
    themeEntries.find(e => e.id === m)?.label ?? (isCustomId(m) ? m.slice("custom:".length) : m);

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

  const task = useMemo(() => tasks.find(w => w.id === activeTaskId) ?? null, [tasks, activeTaskId]);
  // The active main-pane tab when it is an editor. "Set syntax" re-highlights
  // ONE buffer, so the row only exists while there is a buffer to act on.
  const activeEditTab = useApp(s => {
    const id = s.activeTaskId;
    if (!id) return null;
    const t = (s.tabs[id] ?? []).find(tt => tt.id === s.activeTab[id]);
    // Scratchpads too (GH #244): with no extension to go on, the picker is
    // the only way to tell the buffer what it is.
    return t?.type === "edit" || t?.type === "scratch" ? t : null;
  });
  const proj = useMemo(() => (task ? projects.find(p => p.id === task.project_id) ?? null : null), [projects, task]);

  // Roll the live theme preview back and leave the submenu.
  const cancelThemePreview = () => {
    if (themeOriginalRef.current) {
      usePrefs.getState().setThemeMode(themeOriginalRef.current);
      themeOriginalRef.current = null;
    }
    setView("root"); setQuery("");
  };

  // Reset on open; roll back an uncommitted theme preview on close (outside
  // click / ⇧⌘P while still previewing).
  useEffect(() => {
    if (open) { setQuery(""); setActiveIdx(0); setView("root"); }
    else if (themeOriginalRef.current) {
      usePrefs.getState().setThemeMode(themeOriginalRef.current);
      themeOriginalRef.current = null;
    }
  }, [open]);
  // When entering the theme submenu, start on the CURRENT theme so the
  // live preview doesn't jump the instant you open it.
  useEffect(() => {
    if (view === "theme") {
      const cur = themeOriginalRef.current ?? usePrefs.getState().themeMode;
      setActiveIdx(Math.max(0, themeEntries.findIndex(e => e.id === cur)));
    } else setActiveIdx(0);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Wrap an action so it closes the palette, then runs once the click that
   *  triggered it has fully settled.
   *
   *  The defer matters when the action opens another dialog (Archive → confirm,
   *  Sandbox, New task): the palette is non-modal, so the click that triggered
   *  the row would otherwise reach the freshly-mounted dialog's dismissable
   *  layer and dismiss it instantly. Harmless for synchronous actions.
   *
   *  A TIMER, not `requestAnimationFrame`: rAF is frozen while the window is
   *  occluded (another Space, another window on top), so a deferred effect
   *  would sit queued until the window is visible again and then fire at an
   *  arbitrary later moment — opening a dialog over whatever the user is doing
   *  by then. A macrotask runs after event dispatch completes, which is all
   *  this needs, and it runs whether the window is on screen or not. Same
   *  reason `mouseDrag` in the e2e helpers yields with a timer. */
  const act = (fn: () => void) => () => { close(); setTimeout(fn, 0); };

  // Build the full command list. Task/agent rows only exist when a
  // task is active. Everything reads live store state at build time.
  const commands = useMemo<Cmd[]>(() => {
    if (view === "theme") {
      return themeEntries.map<Cmd>(({ id: m, label }) => ({
        id: `theme:${m}`,
        section: "View",
        label,
        icon: m === themeMode ? Check : Palette,
        keywords: "theme appearance color",
        // Commit: the live preview already applied it; clear the rollback
        // marker so close() won't revert, then close.
        run: () => { themeOriginalRef.current = null; usePrefs.getState().setThemeMode(m); close(); },
      }));
    }

    const cmds: Cmd[] = [];

    // ── Task ──────────────────────────────────────────────────────
    cmds.push({
      id: "new-task", section: "Task", label: "New task…",
      icon: Plus, shortcutId: "new-task-quick", keywords: "create worktree project",
      run: act(() => useUI.getState().openProjectPicker()),
    });
    cmds.push({
      id: "new-project", section: "Task", label: "Add project…",
      icon: FolderPlus, keywords: "repository repo clone discover add new",
      run: act(() => useUI.getState().openNewProject()),
    });
    if (task) {
      cmds.push({
        id: "file-picker", section: "Task", label: "File picker",
        icon: FileText, shortcutId: "file-finder", keywords: "open goto fuzzy",
        run: act(() => useUI.getState().openFileFinder(task.id)),
      });
      cmds.push({
        id: "find-in-files", section: "Task", label: "Find in files",
        icon: Search, shortcutId: "find-in-files", keywords: "grep search ripgrep",
        run: act(() => useUI.getState().openFindInFiles(task.id)),
      });
      cmds.push({
        id: "new-scratchpad", section: "Task", label: "New scratchpad",
        icon: NotepadText, shortcutId: "new-scratchpad",
        keywords: "note untitled buffer temporary todo jot draft",
        run: act(() => { void newScratchTab(task.id); }),
      });
      cmds.push({
        id: "rename-task", section: "Task", label: "Rename task",
        icon: Pencil, keywords: "name title",
        run: act(() => startRename(task.id, task.project_id)),
      });
      if (task.branch) {
        cmds.push({
          id: "copy-branch", section: "Task", label: "Copy branch name",
          suffix: task.branch, icon: GitBranch, keywords: "git clipboard",
          run: act(() => { void copyToClipboard(task.branch, `"${task.branch}"`); }),
        });
      }
      cmds.push({
        id: "resume-override", section: "Task", label: "Resume options…",
        icon: History, keywords: "session continue previous conversation args",
        run: act(() => useUI.getState().openResumeOverride(task.id)),
      });
      cmds.push({
        // Ends every PTY in the task but keeps the task itself (GH #119).
        // Also the only way to release a mounted task's terminals, which is
        // what the idle-cost work made concrete.
        id: "stop-task", section: "Task", label: `Stop "${task.name}"`,
        suffix: "Ends its agents, keeps the task",
        icon: Square, keywords: "kill terminate close ptys unmount free memory",
        noRecent: true,
        run: act(() => useApp.getState().stopTask(task.id)),
      });
      cmds.push({
        // Not styled destructive — confirmAndArchive normally shows a confirm
        // modal (with the delete-branch checkbox), so the red isn't needed.
        // Once the user has unticked "Show this every time" there, this entry archives
        // on Enter with no prompt; Settings › Tasks is the way back.
        id: "archive-task", section: "Task", label: `Archive "${task.name}"`,
        icon: Archive, keywords: "delete remove close worktree",
        noRecent: true,
        run: act(() => { void confirmAndArchive(task); }),
      });
    }
    if (proj) {
      cmds.push({
        id: "run-commands", section: "Task", label: "Run commands…",
        suffix: proj.name, icon: Play, keywords: "script dev server build custom",
        run: act(() => useUI.getState().openRunCommands(proj.id)),
      });
    }

    // ── Agent ──────────────────────────────────────────────────────────
    cmds.push({
      id: "prompt-palette", section: "Agent", label: "Prompt library…",
      icon: BookText, shortcutId: "prompt-palette", keywords: "prompts snippets send template",
      run: act(() => useUI.getState().openPromptPalette()),
    });
    cmds.push({
      // Store-driven (lib/waitingAgents), shared with the top-bar jump pill —
      // so it does the same thing from here as from the pill.
      id: "jump-next-waiting", section: "Agent", label: "Jump to next waiting agent",
      icon: Bell, shortcutId: "jump-next-waiting", keywords: "attention blocked done next cycle",
      run: act(() => { jumpToNextWaiting(); }),
    });
    if (proj) {
      cmds.push({
        id: "race", section: "Agent", label: "Agent Race…",
        suffix: proj.name, icon: Swords, keywords: "compare parallel multiple contest winner",
        run: act(() => useUI.getState().openRace(proj.id)),
      });
      cmds.push({
        id: "broadcast-project", section: "Agent", label: "Broadcast to project…",
        suffix: proj.name, icon: Megaphone, keywords: "send all tasks message every agent",
        run: act(() => useUI.getState().openProjectBroadcast(proj.id)),
      });
    }
    if (task) {
      cmds.push({
        id: "broadcast", section: "Agent", label: "Broadcast to agents…",
        icon: Megaphone, shortcutId: "broadcast", keywords: "send message all tabs",
        run: act(() => useUI.getState().openBroadcast(task.id)),
      });
    }
    if (task) {
      const enforced = isSandboxEnforced(effectiveSandboxMode(task));
      cmds.push({
        id: "toggle-yolo", section: "Agent",
        label: enforced ? "YOLO is forced on (Enforcing)" : task.yolo ? "Disable YOLO" : "Enable YOLO",
        suffix: "Dangerously skip permissions",
        icon: Zap, keywords: "auto approve permissions dangerous",
        run: act(() => {
          if (enforced) return;
          const next = !task.yolo;
          useApp.getState().setTaskYolo(task.id, next);
          void taskSetYolo(task.id, next);
          useUI.getState().pushToast(next ? "YOLO enabled" : "YOLO disabled");
        }),
      });
      cmds.push({
        id: "sandbox", section: "Agent", label: "Sandbox settings",
        suffix: effectiveSandboxMode(task),
        icon: ShieldCheck, keywords: "cage security enable disable",
        run: act(() => useUI.getState().openSandbox(task.id)),
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
    if (task) {
      cmds.push({
        id: "toggle-terminal", section: "View", label: "Toggle terminal panel",
        icon: PanelBottom, shortcutId: "toggle-terminal", keywords: "bottom split shell console hide show",
        run: act(() => useApp.getState().toggleBottomTerminal(task.id)),
      });
      // splitPane targets the store's active pane, not DOM focus, so it means
      // the same thing from here as from the chord. Its focus-dependent
      // siblings (new-tab, close-tab, clear-terminal) are deliberately NOT
      // here: each reads document.activeElement to decide WHICH pane it acts
      // on, and from the palette that is the palette's own input.
      cmds.push({
        id: "split-right", section: "View", label: "Split pane right",
        icon: Columns2, shortcutId: "split-pane-right", keywords: "pane vertical divider new",
        run: act(() => { useApp.getState().splitPane(task.id, "v"); }),
      });
      cmds.push({
        id: "split-down", section: "View", label: "Split pane down",
        icon: Rows2, shortcutId: "split-pane-below", keywords: "pane horizontal divider new",
        run: act(() => { useApp.getState().splitPane(task.id, "h"); }),
      });
    }
    if (task && activeEditTab) {
      // On a SCRATCHPAD this is not a view preference, it is the only way to
      // say what the buffer is: there is no extension, so nothing else can
      // answer. It moves to the front section for that case rather than
      // sitting third, under View, behind rows about panels and splits.
      const pad = activeEditTab.type === "scratch";
      cmds.push({
        id: "set-syntax", section: pad ? "Task" : "View", label: "Set syntax…",
        priority: pad,
        suffix: languageLabel(effectiveLanguageId(activeEditTab)), icon: Code2,
        keywords: "language highlighting grammar mode colour color file type markdown json",
        run: act(() => useUI.getState().openSyntaxPalette(task.id, activeEditTab.id)),
      });
    }
    cmds.push({
      id: "toggle-inline-blame", section: "View", label: "Toggle inline git blame",
      suffix: inlineBlame ? "On" : "Off", icon: UserPen,
      keywords: "annotation decoration author commit who changed line history",
      run: act(() => usePrefs.getState().toggleInlineBlame()),
    });
    cmds.push({
      id: "change-theme", section: "View", label: "Change theme…",
      suffix: themeLabel(themeMode), icon: Palette, keywords: "appearance color dark light",
      run: () => {
        // Refresh the custom theme files so the submenu reflects the folder
        // (same refetch-on-open the picker does on trigger hover).
        void usePrefs.getState().loadCustomThemes();
        // Enter the submenu and start a live preview — arrowing through the
        // themes applies each one; cancelling restores this captured original.
        themeOriginalRef.current = usePrefs.getState().themeMode;
        setView("theme"); setQuery("");
      },
    });
    cmds.push({
      id: "shortcuts", section: "View", label: "Keyboard shortcuts",
      icon: Keyboard, keywords: "keys bindings cheat sheet",
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
      id: "activity-monitor", section: "Application", label: "Activity monitor",
      icon: Activity,
      keywords: "cpu memory ram process task manager profiling performance slow hog",
      run: act(() => { void procmonOpenWindow(); }),
    });
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
      ["tasks", "Task settings", ListTodo],
      ["notifications", "Notification settings", Bell],
      ["prompts", "Prompt library", BookText],
      ["shortcuts", "Keyboard shortcuts settings", Keyboard],
      ["sandbox", "Sandbox settings", ShieldCheck],
      ["cli", "CLI & MCP settings", SquareTerminal],
    ];
    for (const [tab, label, icon] of settingsLinks) {
      cmds.push({
        id: `settings:${tab}`, section: "Settings", label, icon, keywords: "settings preferences",
        run: act(() => useApp.getState().openSettings(tab as any)),
      });
    }

    return cmds;
  }, [view, task, proj, themeMode, themeEntries, inlineBlame, activeEditTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recents, re-read on every open so an hour spent with the palette closed
  // expires them (the list is only ever consulted at build time). Empty query
  // only: once you are searching, you want the best match, and a pinned
  // section would push it down and duplicate rows.
  const recents = useMemo(
    () => (open && view === "root" && !query
      ? recentIds(readRecents(), new Set(commands.map(c => c.id)))
      : []),
    [open, view, query, commands],
  );

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
    const groups: Array<{ section: string; items: Scored[] }> = [];
    // Recent goes first and its members are LIFTED out of their home sections
    // rather than duplicated — the same command twice in one list makes the
    // arrow keys feel broken.
    const recentSet = new Set(recents);
    if (recentSet.size > 0) {
      const byId = new Map(out.map(s => [s.cmd.id, s]));
      const items = recents.map(id => byId.get(id)).filter(Boolean) as Scored[];
      if (items.length > 0) groups.push({ section: RECENT_SECTION, items });
    }
    for (const section of SECTION_ORDER) {
      const items = (bySection.get(section) ?? []).filter(s => !recentSet.has(s.cmd.id));
      if (items.length === 0) continue;
      if (query) items.sort((a, b) => b.score - a.score);
      // Empty query: insertion order, except that a `priority` command floats
      // to the head of its section. Array.prototype.sort is stable, so every
      // other row keeps the order it was pushed in.
      else items.sort((a, b) => Number(!!b.cmd.priority) - Number(!!a.cmd.priority));
      groups.push({ section, items });
    }
    const rows: Scored[] = groups.flatMap(g => g.items);
    return { groups, rows };
  }, [commands, query, recents]);

  const rows = filtered.rows;

  // Jump the highlight to the strongest match on query change, without
  // touching row order (sections and insertion order stay put — see
  // `filtered` above). Without this the highlight sat on row 0, i.e.
  // whichever section happens to sort first, even when a later row is
  // the obviously-intended match (e.g. "upd" landing on "Jump to next
  // waiting agent" over "Check for updates").
  useEffect(() => {
    if (!query) { setActiveIdx(0); return; }
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].score > bestScore) { bestScore = rows[i].score; bestIdx = i; }
    }
    setActiveIdx(bestIdx);
  }, [query, rows]);

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
      const c = rows[activeIdx]?.cmd;
      if (c) runCmd(c);
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

  /** Every path that runs a command goes through here, so recording can't drift
   *  from invocation. Theme submenu entries are not recorded: they are a live
   *  preview you arrow through, and remembering the last one you happened to
   *  land on is noise, not intent. */
  const runCmd = (cmd: Cmd) => {
    if (view === "root" && !cmd.noRecent) recordRecent(cmd.id);
    cmd.run();
  };

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
        {/* Soft animated dim. Non-blocking (pointer-events-none) so outside-click
            still dismisses via Radix's dismissable layer; data-state mirrors the
            panel so it fades out on close instead of snapping. */}
        <div
          aria-hidden
          data-state={open ? "open" : "closed"}
          className="termic-backdrop pointer-events-none fixed inset-0 z-40 bg-black/30"
        />
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
          style={{ background: "color-mix(in srgb, var(--color-bg-1) 86%, transparent)" }}
          className="termic-pop fixed left-1/2 top-[14vh] z-50 w-[min(620px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl outline-none backdrop-blur-lg"
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
              <div
                key={group.section}
                // Hairline under Recent so it reads as pinned above the real
                // list rather than as just another section.
                className={group.section === RECENT_SECTION
                  ? "mb-1 border-b border-[var(--color-border-soft)] pb-1"
                  : undefined}
              >
                <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">
                  {group.section === RECENT_SECTION && <Clock className="h-3 w-3" />}
                  {group.section}
                  {group.section === RECENT_SECTION && (
                    <span className="normal-case tracking-normal opacity-70">· what you just ran</span>
                  )}
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
                      // Stable handle for the e2e suite: row order shifts with
                      // the query, the command's id does not.
                      data-cmd-id={cmd.id}
                      onClick={() => runCmd(cmd)}
                      onMouseMove={() => setActiveIdx(i)}
                      // Subtle neutral highlight (Conductor-style) — a faint
                      // fg-tinted overlay, theme-aware, no accent/border.
                      style={i === activeIdx ? { background: "color-mix(in srgb, var(--color-fg) 13%, transparent)" } : undefined}
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

  // Start the sidebar's inline rename for `taskId`. The row only exists when its
  // project is expanded (and the row is selected/scrolled into view), so
  // expand + select first, then fire the rename signal the row watches.
  function startRename(taskId: string, projectId: string) {
    const app = useApp.getState();
    app.setProjectCollapsed(projectId, false);
    if (app.compactSidebar) app.toggleCompactSidebar(); // full-width row needed to show the input
    app.setActiveTask(taskId);
    useUI.getState().requestTaskRename(taskId);
  }
}
