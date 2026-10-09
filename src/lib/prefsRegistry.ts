// Every localStorage key the app reads or writes, in one list.
//
// Each entry says whether the key goes through `scoped()`
// (src/lib/profileScope.ts, so a non-root profile window stores it as
// `profile-<slug>:<key>`), and whether it is a portable user preference
// ("sync") or tied to this machine ("local"). The classification follows
// docs/ideas/config-sync.md, "What syncs and what never does": anything that
// names a path, a binary, a hardware fact or a credential stays on the
// machine, and so does UI state (collapse, sizes, recents, the last-used
// mode of a control). Everything else follows the user.
//
// Config sync (src/lib/configSync.ts) reads this list: the "sync" keys are
// exactly what a window snapshots for export and what it accepts back from a
// pull, so classifying a key here IS deciding whether it syncs.
// prefsRegistry.test.ts fails when a key is added that nobody classified, or
// one is removed and left listed here.
//
// Static data, kept off the app-start path: configSync.ts is imported
// dynamically after first paint and by the lazily loaded Settings > Sync
// section, and nothing on a store or terminal path may import this list.
//
// Adding a key: add an entry in the section it belongs to. Renaming one is a
// different job: it loses every user's stored value unless
// src/lib/lsMigration.ts carries it across, and the old name then stays here
// as `legacy`.

/** Whether a key follows the user to another machine through config sync. */
export type PrefClass =
  | { class: "sync" }
  | { class: "local"; /** What ties it to this machine. */ reason: string };

export type PrefKey = PrefClass & {
  /** The key as the source spells it, before `scoped()` adds a profile prefix.
   *  For a `family`, the static prefix every key in the family starts with. */
  key: string;
  /** Written through `scoped()`, so each profile window keeps its own. */
  scoped: boolean;
  /** Keys built at runtime from this prefix plus a task id, a PR number or a
   *  member path. Matched by prefix. */
  family?: true;
  /** Read, never written: an old spelling kept so an upgrade does not lose
   *  the value it held. */
  legacy?: true;
};

const DEBUG_FLAG = "debug switch set by hand in the webview console";

export const PREF_KEYS: readonly PrefKey[] = [
  // ── Appearance: theme, fonts, editor ──
  { key: "themeMode", scoped: false, class: "sync" },
  { key: "uiLanguage", scoped: false, class: "sync" },
  { key: "uiScale", scoped: false, class: "local", reason: "display density, follows this machine's screen" },
  { key: "customThemeCache", scoped: false, class: "local", reason: "first-paint cache of a themes/ file; themeMode and the file itself are what sync" },
  { key: "editorFont", scoped: false, class: "sync" },
  { key: "editorFontSize", scoped: false, class: "sync" },
  { key: "editorThemeId", scoped: false, class: "sync" },
  { key: "editorThemeIdLight", scoped: false, class: "sync" },
  { key: "editorWordWrap", scoped: false, class: "sync" },
  { key: "codeLigatures", scoped: false, class: "sync" },
  { key: "inlineBlame", scoped: false, class: "sync" },
  { key: "showAllInstalledFonts", scoped: false, class: "sync" },
  { key: "splitPaneDim", scoped: false, class: "sync" },
  { key: "splitPaneDimAmount", scoped: false, class: "sync" },
  { key: "sidebarHoverReveal", scoped: false, class: "sync" },
  { key: "profileSidebarWash", scoped: false, class: "sync" },
  { key: "markdownDefaultView", scoped: false, class: "local", reason: "last-used view, rewritten by every toggle in a markdown tab" },
  { key: "svgDefaultView", scoped: false, class: "local", reason: "last-used view, rewritten by every toggle in an SVG tab" },
  { key: "htmlDefaultView", scoped: false, class: "local", reason: "last-used view, rewritten by every toggle in an HTML tab" },

  // ── Terminal ──
  { key: "terminalFont", scoped: false, class: "sync" },
  { key: "terminalFontSize", scoped: false, class: "sync" },
  { key: "terminalLetterSpacing", scoped: false, class: "sync" },
  { key: "terminalScrollback", scoped: false, class: "sync" },
  { key: "terminalOptionAsMeta", scoped: false, class: "sync" },
  { key: "terminalCopyOnSelect", scoped: false, class: "sync" },
  { key: "terminalRenderer", scoped: false, class: "local", reason: "renderer choice follows this machine's GPU" },
  { key: "terminalGpuEnabled", scoped: false, class: "local", reason: "hardware: whether this machine's GPU renders terminals" },

  // ── Shortcuts ──
  { key: "shortcutBindings", scoped: false, class: "sync" },
  { key: "doubleShiftMode", scoped: false, class: "sync" },
  { key: "ctrlTabMode", scoped: false, class: "sync" },

  // ── Notifications, indicators, confirm-before prompts ──
  { key: "desktopNotifications", scoped: false, class: "sync" },
  { key: "completionSound", scoped: false, class: "sync" },
  { key: "completionSoundId", scoped: false, class: "sync" },
  { key: "settledHighlight", scoped: false, class: "sync" },
  { key: "workingIndicator", scoped: false, class: "sync" },
  { key: "partialDoneIndicator", scoped: false, class: "sync" },
  { key: "attentionIndicator", scoped: false, class: "sync" },
  { key: "confirmBeforeCloseAgentTab", scoped: false, class: "sync" },
  { key: "confirmBeforeArchiveTask", scoped: false, class: "sync" },
  { key: "confirmBeforeAccountRestart", scoped: false, class: "sync" },
  { key: "confirmBeforeCodeIntel", scoped: false, class: "sync" },
  { key: "offerTouchIdForSudo", scoped: false, class: "local", reason: "hardware: Touch ID, and the offer edits this machine's sudo config" },

  // ── Tasks, the board, the queue ──
  { key: "branchPrefix", scoped: false, class: "sync" },
  { key: "useBranchAsTaskName", scoped: false, class: "sync" },
  { key: "archiveDeleteBranch", scoped: false, class: "sync" },
  { key: "queueMinIntervalMs", scoped: false, class: "sync" },
  { key: "queueStallMs", scoped: false, class: "sync" },
  { key: "boardArchiveLimitMode", scoped: true, class: "sync" },
  { key: "boardArchiveLimit", scoped: true, class: "sync" },
  { key: "boardPinnedColumns", scoped: true, class: "sync" },
  { key: "openWithApp", scoped: false, class: "local", reason: "names an app installed on this machine" },
  { key: "findInFilesRegex", scoped: false, class: "local", reason: "last-used toggle in the find-in-files bar" },
  { key: "findInFilesMatchCase", scoped: false, class: "local", reason: "last-used toggle in the find-in-files bar" },

  // ── New Task dialog memory ──
  { key: "newTaskLastMode", scoped: true, class: "local", reason: "last-used New Task mode" },
  { key: "newTaskLastSandboxMode", scoped: true, class: "local", reason: "last-used New Task sandbox mode" },
  { key: "newTaskMemberModes", scoped: true, class: "local", reason: "keyed by member root_path, a path on this machine" },
  { key: "newTaskMemberSets", scoped: true, class: "local", reason: "member subsets stored as root_paths, paths on this machine" },

  // ── Sandbox and YOLO defaults ──
  // Sync: they are the user's own preferences (docs/ideas/config-sync.md,
  // open question 2). A sync that would change one has to show it before
  // applying, because it can switch approvals off on another machine.
  { key: "globalDefaultSandboxKind", scoped: false, class: "sync" },
  { key: "globalDefaultSandbox", scoped: false, class: "local", reason: "old name, read only as a fallback; globalDefaultSandboxKind is what syncs", legacy: true },
  { key: "sandboxBypassPermissions", scoped: false, class: "sync" },
  { key: "sandboxAllowScope", scoped: false, class: "sync" },
  { key: "defaultYolo", scoped: false, class: "sync" },
  { key: "loadRemoteImages", scoped: false, class: "sync" },

  // ── Code intelligence ──
  { key: "codeIntelligence", scoped: false, class: "sync" },
  { key: "codeIntelDiagnostics", scoped: false, class: "sync" },
  { key: "codeIntelServers", scoped: false, class: "local", reason: "which server binary runs here usually follows what is installed here" },
  { key: "codeIntelCommands", scoped: false, class: "local", reason: "command lines naming binaries on this machine" },
  { key: "usagesPopupSize", scoped: false, class: "local", reason: "panel size" },

  // ── Agents ──
  { key: "agentFooterHidden", scoped: false, class: "sync" },
  { key: "usageUnknownDismissed", scoped: true, class: "local", reason: "dismisses a notice about this machine's hook install state" },
  { key: "agentRaces", scoped: false, class: "local", reason: "keyed by task id, and tasks are per machine" },

  // ── Sidebar ──
  { key: "groupColors", scoped: true, class: "sync" },
  { key: "taskExpandMode", scoped: true, class: "sync" },
  { key: "showStatusSection", scoped: true, class: "sync" },
  { key: "showBoard", scoped: true, class: "sync" },
  { key: "scheduledNav", scoped: true, class: "sync" },
  { key: "taskLocationIcon", scoped: true, class: "sync" },
  { key: "taskPrBadge", scoped: true, class: "sync" },
  { key: "prSnapshots", scoped: true, class: "local", reason: "last-known PR status per task, a first-paint cache the next poll overwrites" },
  { key: "hideInactiveProjects", scoped: true, class: "local", reason: "sidebar filter toggled in place, over this machine's tasks" },
  { key: "compactSidebar", scoped: false, class: "local", reason: "collapse state" },
  { key: "collapsedProjects", scoped: true, class: "local", reason: "collapse state" },
  { key: "collapsedTasks", scoped: true, class: "local", reason: "collapse state" },
  { key: "collapsedGroups", scoped: true, class: "local", reason: "collapse state" },
  { key: "collapsedTaskGroups", scoped: true, class: "local", reason: "collapse state" },
  { key: "statusBucketCollapsed", scoped: true, class: "local", reason: "collapse state" },
  { key: "statusSectionCollapsed", scoped: true, class: "local", reason: "collapse state" },
  { key: "statusTaskExpanded", scoped: true, class: "local", reason: "collapse state" },
  { key: "statusGroupCollapsed", scoped: true, class: "local", reason: "collapse state" },
  { key: "recentTasks", scoped: true, class: "local", reason: "recent tasks, and tasks are per machine" },
  { key: "commandPaletteRecent", scoped: false, class: "local", reason: "recent palette commands" },
  { key: "sidebarWidth", scoped: false, class: "local", reason: "panel size" },

  // ── Task view layout ──
  { key: "rightPanelHidden", scoped: false, class: "local", reason: "collapse state" },
  { key: "rightPanelWidth", scoped: false, class: "local", reason: "panel size" },
  { key: "rightFooterHeight", scoped: false, class: "local", reason: "panel size" },
  { key: "terminalSplit", scoped: false, class: "local", reason: "split state, keyed by task id" },
  { key: "terminalSplitHeight", scoped: false, class: "local", reason: "split size, keyed by task id" },
  { key: "terminalSplitCollapsed", scoped: false, class: "local", reason: "collapse state, keyed by task id" },
  { key: "fileViewed", scoped: false, class: "local", reason: "review progress, keyed by task id" },
  { key: "pinnedFolders", scoped: true, class: "local", reason: "file-tree pins, keyed by project id, which a profile owns" },
  { key: "pinnedSectionCollapsed", scoped: false, class: "local", reason: "collapse state" },
  { key: "diffMode", scoped: false, class: "local", reason: "last-used toggle in the diff pane" },

  // ── Git panel ──
  { key: "gitPanelView", scoped: false, class: "local", reason: "last-used tab of the Git panel" },
  { key: "gitViewMode", scoped: false, class: "local", reason: "last-used tree/list toggle" },
  { key: "gitHideUntracked", scoped: false, class: "local", reason: "last-used toggle in the Git panel" },
  { key: "gitPushDefault", scoped: false, class: "local", reason: "last-used commit button (commit, or commit and push)" },
  { key: "gitCompareMergeBase", scoped: false, class: "local", reason: "last-used toggle in Compare" },
  { key: "gitSplitRatio", scoped: false, class: "local", reason: "panel size" },
  { key: "gitUnstagedCollapsed", scoped: false, class: "local", reason: "collapse state" },
  { key: "gitStagedCollapsed", scoped: false, class: "local", reason: "collapse state" },

  // ── Prompt library ──
  { key: "promptLibrary", scoped: true, class: "sync" },

  // ── App install state ──
  { key: "updateDismissedVersion", scoped: false, class: "local", reason: "about the build installed here" },
  { key: "updateLastSeenVersion", scoped: false, class: "local", reason: "about the build installed here" },
  { key: "desktopEntryPrompted", scoped: false, class: "local", reason: "whether this machine was asked to install a desktop entry" },

  // ── Debug flags ──
  { key: "ptyDebug", scoped: false, class: "local", reason: DEBUG_FLAG },
  { key: "ptyDebugRaw", scoped: false, class: "local", reason: DEBUG_FLAG },
  { key: "debugWorkDone", scoped: false, class: "local", reason: DEBUG_FLAG },
  { key: "editorDebug", scoped: false, class: "local", reason: DEBUG_FLAG },
  { key: "workDoneCeilingMs", scoped: false, class: "local", reason: DEBUG_FLAG },
  { key: "delegatedGraceMs", scoped: false, class: "local", reason: DEBUG_FLAG },

  // ── Families: built from a runtime value ──
  // Both spellings, `prMergeHandled:<task>:<provider>:<number>` and the
  // pre-provider `prMergeHandled:<task>:<number>` that pr.ts still reads.
  { key: "prMergeHandled:", family: true, scoped: false, class: "local", reason: "notification bookkeeping for this machine's tasks" },
  { key: "hideRunPrompt:", family: true, scoped: false, class: "local", reason: "keyed by a member repo path or project id, dismisses a hint" },

  // ── Renamed by src/lib/lsMigration.ts (workspace -> task) ──
  // Read once at boot, copied to the new name and deleted.
  { key: "workspaceExpandMode", scoped: false, class: "local", reason: "old name, migrated at boot; taskExpandMode is what syncs", legacy: true },
  { key: "collapsedWorkspaces", scoped: false, class: "local", reason: "old name, migrated at boot", legacy: true },
  { key: "newWorkspaceLastMode", scoped: false, class: "local", reason: "old name, migrated at boot", legacy: true },
  { key: "newWorkspaceLastSandboxMode", scoped: false, class: "local", reason: "old name, migrated at boot", legacy: true },
];
