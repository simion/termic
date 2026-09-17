// Transient UI-only store (separate from the main app store so re-renders
// triggered by opening a dialog don't churn the task tree).

import { create } from "zustand";
import type { Prompt } from "@/store/prompts";
import type { TaskPhase } from "@/lib/taskPhase";

export interface ConfirmCheckbox {
  label: string;
  defaultValue?: boolean;
  branchName?: string;
}

/** Shape askConfirm resolves to once the request carries a `checkbox` or
 *  `dontAskAgain` (a plain boolean otherwise). `checked` is the checkbox
 *  state at dismissal, so it is meaningful ONLY when `confirmed` is true:
 *  ticking a box and then hitting Escape still reports it as ticked. */
export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
  dontAskAgain: boolean;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Action button label. Default: "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button red when true - use for archive /
   *  delete / "ripping the cage" style actions. */
  destructive?: boolean;
  checkbox?: ConfirmCheckbox;
  /** Renders a second, separate "Show this every time" checkbox under
   *  `checkbox`. The dialog only reports it back (as `dontAskAgain`); it is
   *  the CALLER's job to persist the opt-out, and to do so only when
   *  `confirmed` is also true. */
  dontAskAgain?: boolean;
  /** Identifies a prompt whose asker can go away before it is answered (a
   *  terminal pane's "restart to apply YOLO?", say — the tab can be closed or
   *  the task archived while it stands). The asker passes a key here and calls
   *  `withdrawConfirm(key)` on teardown; without one, the modal outlives the
   *  thing it was asking about and blocks the whole window. Only one confirm
   *  is on screen at a time, so an un-withdrawn prompt is not a small mess. */
  key?: string;
}

/** The three ways out of the scratchpad close prompt (GH #244). "save" opens
 *  the promote picker and the close only happens if that picker goes through;
 *  "discard" deletes the pad for good; "cancel" (including Esc / click-away)
 *  leaves both the tab and the pad exactly as they were. */
export type ScratchCloseChoice = "save" | "discard" | "cancel";

/** How the user chose to share a file dropped onto a sandboxed terminal. */
export type TerminalDropChoice =
  | { kind: "temp" }          // copy into TMPDIR, insert the staged path
  | { kind: "allow-folder" }  // add the file's folder to the sandbox allow-list
  | { kind: "allow-file" }    // add the exact file path to the allow-list
  | { kind: "cancel" };       // do nothing

export interface TerminalDropRequest {
  /** Absolute paths the user dropped. */
  paths: string[];
  /** Owning task id (for staging + allow-list mutations). */
  taskId: string;
}

/** Pre-fill for the New Task dialog. Every field is optional; the dialog
 *  falls back to its usual project/last-used defaults for anything absent,
 *  so a seed can carry as little as one field. */
export interface NewTaskSeed {
  /** Pre-fills "Branch from". */
  baseBranch?: string;
  /** Pre-fills the name field (a full name, not only a prefix, despite
   *  the historical key). */
  namePrefix?: string;
  /** Open straight into "import an existing worktree" mode. */
  importMode?: boolean;
  /** Open straight into the forge issue picker. Ignored for multi-repo and
   *  non-git projects, which have no issues to pick from. */
  issueMode?: boolean;
  /** Pre-fills the first-message textarea (GH #192, deep links). Sent to
   *  the agent after create; never auto-submitted from the link itself. */
  prompt?: string;
  /** Agent CLI id to pre-select. Ignored when it names an agent this
   *  install does not offer. */
  agent?: string;
  /** Task type to pre-select, overriding the user's remembered choice. */
  mode?: "worktree" | "repo_root";
  /** Bumped by `openNewTask` on every call. The dialog's reset effect keys
   *  on it, so a SECOND open for the same project re-seeds the form instead
   *  of no-op'ing — which is what a second deep link is (GH #192): the
   *  window raises, and without this it raises onto the first link's name
   *  and prompt. Assigned by the store; callers never set it. */
  nonce?: number;
}

interface UIState {
  // dialog visibility
  newProjectOpen: boolean;
  newTaskProjectId: string | null;  // null = closed
  /** Optional seed for the New worktree dialog — when set, the dialog
   *  pre-fills fields with these values. Used by the "Duplicate task" flow
   *  (branch off an existing task's tip) and by `termic://` deep links
   *  (GH #192), which can additionally seed the prompt, agent and task
   *  type. Cleared when the dialog closes. */
  newTaskSeed: NewTaskSeed | null;
  /** "Run a command" dialog — project id to open it for, null = closed.
   *  Creates a task whose default tab runs a user-supplied launch command
   *  instead of an agent. `customCommandMode` picks worktree vs main
   *  checkout (the sidebar `+` menu toggle drives it). */
  customCommandProjectId: string | null;
  customCommandMode: "worktree" | "repo_root";
  /** "Edit launch command" dialog — task id to edit the custom
   *  launch command for, null = closed. Only opened for cli==="custom"
   *  tasks. Lives in UI store so opening doesn't churn the
   *  task tree. */
  editCommandTaskId: string | null;
  /** "Run commands" manager dialog (GH #124). `projectId` = which repo's
   *  commands to manage, null = closed. `initialAdd`, when set, pre-appends a
   *  new row (e.g. opened from a file-tree "Add to Run scripts"). Lives in the
   *  UI store so opening it doesn't churn the project/task trees. */
  runCommandsDialog: { projectId: string; initialAdd?: { label: string; command: string } } | null;
  /** Task id whose resume-args override is being edited, null =
   *  closed. Lives in UI store so opening doesn't churn the task
   *  tree. */
  resumeOverrideTaskId: string | null;
  /** Task id whose GOAL is being edited, null = closed. The goal is free
   *  text recording what the task is for; a task carrying one with no
   *  `started_at` is what the dashboard draws as Planned. Lives in the UI
   *  store, like every other per-task dialog, so opening it doesn't churn
   *  the task tree. */
  taskGoalTaskId: string | null;
  /** Task id being PARKED, null = closed. Only the park half opens a dialog
   *  (it asks for the optional reason); unparking is immediate from the menu,
   *  because there is nothing to ask. */
  parkTaskId: string | null;
  /** Read-only "Keyboard shortcuts" cheat-sheet modal (opened from the
   *  sidebar footer). Distinct from Settings → Shortcuts (which edits them). */
  /** True while Termic is in windowless mode (window closed to the menu bar,
   *  or launched `--headless` by the CLI). Agents keep running; MainArea
   *  collapses every task pane to ZERO GEOMETRY, which is the only thing that
   *  actually pauses xterm's renderers - hiding the NSWindow does not (a
   *  hidden window still reports full layout). See docs/performance.md bear
   *  trap 2 and the windowless block in src-tauri/src/lib.rs. */
  windowless: boolean;
  /** True while Termic's window has OS focus. Distinct from `windowless`,
   *  which is the window being gone entirely: a Termic sitting behind the
   *  user's browser is present but unwatched, and treating that as "watched"
   *  meant a turn finishing while they were in another app produced no badge
   *  at all, because the badge was suppressed as already-seen. Set from
   *  `initWindowFocus`. */
  windowFocused: boolean;
  setWindowFocused: (v: boolean) => void;
  setWindowless: (v: boolean) => void;
  /** The window close prompt ("Keep in Menu Bar" / "Quit Termic" / dismiss).
   *  Opened by Rust's `termic://close-requested`, which only fires when the
   *  `close_action` setting is unset or "ask". */
  closePromptOpen: boolean;
  setClosePromptOpen: (v: boolean) => void;
  /** The New Profile wizard (GH #280). A profile opens in its own window, so
   *  this is a create flow, never a switcher. */
  newProfileOpen: boolean;
  openNewProfile: () => void;
  setNewProfileOpen: (v: boolean) => void;
  /** The profile the delete dialog is confirming, by slug. `null` = closed. */
  deleteProfileSlug: string | null;
  setDeleteProfileSlug: (slug: string | null) => void;
  /** Bumped on every close REQUEST. Opening alone is not enough to reset the
   *  dialog's "Don't ask again" tick: a second request while the prompt is
   *  already open leaves `closePromptOpen` true->true, which React sees as no
   *  change. Same nonce trick as the sidebar rename signal. */
  closePromptNonce: number;
  requestClosePrompt: () => void;
  shortcutsHelpOpen: boolean;
  welcomeOpen: boolean;
  /** Changelog dialog — full per-version release notes. */
  changelogOpen: boolean;
  createPrForTaskId: string | null;      // null = closed
  /** Broadcast dialog — send one message to several open agents in a
   *  task at once. null = closed. UI-store (not app) so opening it
   *  doesn't churn the task tree. */
  broadcastForTaskId: string | null;
  /** Project-scoped broadcast: the same dialog, but targeting the MAIN agent
   *  of every task in this project. null = closed. Mutually exclusive
   *  with broadcastForTaskId (both cleared by closeBroadcast). */
  broadcastForProjectId: string | null;
  /** Agent Race launcher: project id to start a race for, null = closed.
   *  UI-store (not app) so opening it doesn't churn the task tree. */
  raceProjectId: string | null;
  /** Agent Race compare surface: race id whose racers' worktree diffs are
   *  shown N-up, null = closed. Separate from the launcher so a finished
   *  race can be re-compared without relaunching. */
  raceCompareId: string | null;
  /** Open the Edit Sandbox dialog for a specific task. null = closed.
   *  Lives in UI store (not app) so flipping it doesn't churn the
   *  task tree on every re-render. */
  sandboxForTaskId: string | null;
  /** ⌘P file finder — task id to scope the search to; null = closed.
   *  Lives here so opening doesn't churn the task tree. */
  fileFinderTaskId: string | null;
  /** Search Everywhere (double-Shift, GH #174): files always, symbols when a
   *  checkout is armed. Separate from the file finder on purpose — ⌘P stays a
   *  single-purpose thing, since most people never turn code intelligence on. */
  searchEverywhereTaskId: string | null;
  /** Global fuzzy project picker (⌘N) — search any loaded project and
   *  start a new task for it without scrolling the sidebar. */
  projectPickerOpen: boolean;
  /** What the picked project is FOR. "task" opens the standard New Task
   *  dialog; "issue" opens it straight into the forge issue picker. Same
   *  picker either way, because "which project" is the first question in
   *  both cases and asking it twice would be the wrong shape. */
  projectPickerIntent: "task" | "issue";
  /** ⇧⌘P command palette — searchable list of every command / action. */
  commandPaletteOpen: boolean;
  /** ⌥⌘P prompt palette — searchable list of library prompts (title only). */
  promptPaletteOpen: boolean;
  /** "Set syntax" picker — which editor tab it will re-highlight; null =
   *  closed. Keyed by tab (not just task) because the pick applies to one
   *  buffer, and the palette can outlive a tab switch underneath it. */
  syntaxPaletteFor: { taskId: string; tabId: string } | null;
  /** The prompt-destination picker: "Run "<title>"" modal shared by the
   *  Prompts dropdown and the prompt palette's fallback. `body` is a
   *  one-shot editable copy of the
   *  prompt text for this send only — doesn't touch the saved library entry.
   *  null = closed. */
  promptFire: { prompt: Prompt; body: string } | null;
  /** Fire-and-forget "start inline-rename on this task row" signal.
   *  The sidebar's TaskRow watches the nonce and, when the taskId
   *  matches, flips its own local rename state (the same thing the row's
   *  dropdown "Rename" does). Lives here so the command palette can
   *  trigger the sidebar rename from outside the sidebar tree. The caller
   *  is responsible for expanding the row's project first (a collapsed
   *  project doesn't render the row, so the signal would be missed). */
  renameRequest: { taskId: string; nonce: number } | null;
  /** ⇧⌘F find-in-files dialog — task id, null = closed. */
  findInFilesTaskId: string | null;
  /** Global "blocking work in flight" message. Shows a centered loader over
   *  the whole window so the user knows the freeze is intentional. Set for
   *  unavoidably-synchronous IPC calls like `task_archive` that take
   *  several seconds (git worktree remove + rm -rf). */
  busyMessage: string | null;
  /** Active confirm prompt, if any. null = nothing pending. The
   *  resolve callback fires with the user's choice when the modal
   *  closes; the ConfirmDialog component reads this and renders. */
  confirm: { req: ConfirmRequest; resolve: (res: any) => void } | null;
  /** Active sandboxed-terminal drop prompt, if any. The resolve callback
   *  fires with the user's choice when the modal closes. */
  terminalDrop: { req: TerminalDropRequest; resolve: (c: TerminalDropChoice) => void } | null;
  /** Active "close this scratchpad?" prompt (GH #244). null = nothing
   *  pending. Deliberately NOT built on `confirm`: this has THREE outcomes
   *  and ConfirmDialog folds dismissal into cancel, exactly the reason
   *  CloseDialog is its own component too. Here dismissal IS the harmless
   *  outcome (Esc keeps the pad and the tab), so the mapping works out. */
  scratchClose: { title: string; resolve: (c: ScratchCloseChoice) => void } | null;
  /** The "Save to project" picker for a scratchpad: which pad is being
   *  promoted, and into which task. Resolves true once the pad is a real
   *  file, so the close flow can tell "saved, now close the tab" from
   *  "backed out, keep it". null = closed. */
  scratchSave: { taskId: string; tabId: string; resolve: (saved: boolean) => void } | null;
  /** Active Docker sandbox rebuild-nudge prompt, if any. Fired from
   *  `maybeRebuildDockerImageForLaunch` right before a Docker-mode task's
   *  agent spawns. The resolve callback fires with the user's choice
   *  ("rebuild" awaits a fresh --no-cache build; "skip" launches
   *  immediately on whatever image already exists) when the modal closes;
   *  DockerRebuildPromptDialog reads this and renders. */
  dockerRebuildPrompt: { taskName: string; lastBuiltDate: string | null; resolve: (choice: "rebuild" | "skip" | "always" | "background") => void } | null;
  /** Tasks whose PTYs are about to be SIGKILL'd because the user
   *  explicitly hit "Save & restart" on a config dialog (Sandbox or
   *  Resume override). The next pty-exit for any PTY belonging to one of
   *  these tasks will trigger an immediate respawn (the TerminalPane
   *  checks the set on exit instead of showing the "Restart agent"
   *  overlay). Cleared per-(task,tab) when the respawn fires. */
  pendingPtyRestarts: Set<string>;
  /** Transient bottom-right toasts. Auto-dismiss handled in <Toaster/>. */
  toasts: Toast[];
  /** Bumped to force the "All files" tree to re-read from disk — e.g. after
   *  the user edits exclude patterns in Settings (the tree is behind the
   *  Settings overlay, so it can't refresh itself). RightPanel folds this
   *  into its local reload token. */
  fileTreeNonce: number;
  /** Dashboard phase filter; `null` is "All". Session-only ON PURPOSE: the
   *  dashboard unmounts the moment a task is opened, so component state would
   *  reset on every visit anyway, and a filter is not worth a localStorage
   *  key (or the migration and pruning that come with one). */
  dashboardPhase: TaskPhase | null;

  // actions
  openNewProject: () => void;
  closeNewProject: () => void;
  openNewTask: (projectId: string, seed?: NewTaskSeed) => void;
  closeNewTask: () => void;
  openCustomCommand: (projectId: string, mode?: "worktree" | "repo_root") => void;
  closeCustomCommand: () => void;
  openEditCommand: (taskId: string) => void;
  closeEditCommand: () => void;
  openRunCommands: (projectId: string, initialAdd?: { label: string; command: string }) => void;
  closeRunCommands: () => void;
  openResumeOverride: (taskId: string) => void;
  closeResumeOverride: () => void;
  openTaskGoal: (taskId: string) => void;
  closeTaskGoal: () => void;
  openParkTask: (taskId: string) => void;
  closeParkTask: () => void;
  openShortcutsHelp: () => void;
  closeShortcutsHelp: () => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  openChangelog: () => void;
  closeChangelog: () => void;
  openCreatePr: (taskId: string) => void;
  closeCreatePr: () => void;
  openBroadcast: (taskId: string) => void;
  openProjectBroadcast: (projectId: string) => void;
  closeBroadcast: () => void;
  openRace: (projectId: string) => void;
  closeRace: () => void;
  openRaceCompare: (raceId: string) => void;
  closeRaceCompare: () => void;
  openSandbox: (taskId: string) => void;
  /** "Show this commit in History": the blame popup's second button. Read by
   *  RightPanel (open the Git tab), GitPanel (switch to the History view) and
   *  HistoryPanel (select, expand and scroll to the sha). One request rather
   *  than three, because the three live in different components and the editor
   *  has no handle on any of them.
   *
   *  `at` is what makes it a REQUEST and not a state: asking for the same sha
   *  twice must reveal it twice, and a plain `{taskId, sha}` compares equal the
   *  second time and does nothing. Deliberately not named `open*`: it is not a
   *  dialog, and CommandPalette.coverage.test.ts polices that prefix. */
  commitReveal: { taskId: string; sha: string; at: number } | null;
  revealCommitInHistory: (taskId: string, sha: string) => void;
  /** Consume the request. MUST be called once it has been honoured: a reveal
   *  that stays in the store is a standing order, and RightPanel re-runs its
   *  effect on every task switch, so an un-consumed one pins the panel to the
   *  Git tab for the rest of the session. Found the hard way, see ui.md. */
  clearCommitReveal: () => void;
  closeSandbox: () => void;
  openFileFinder: (taskId: string) => void;
  closeFileFinder: () => void;
  openSearchEverywhere: (taskId: string) => void;
  closeSearchEverywhere: () => void;
  openProjectPicker: (intent?: "task" | "issue") => void;
  closeProjectPicker: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  openPromptPalette: () => void;
  closePromptPalette: () => void;
  openSyntaxPalette: (taskId: string, tabId: string) => void;
  closeSyntaxPalette: () => void;
  /** Open the destination picker for `prompt`, seeding the editable body. */
  openPromptFire: (prompt: Prompt) => void;
  closePromptFire: () => void;
  setPromptFireBody: (body: string) => void;
  /** Ask the sidebar to start inline-renaming `taskId`. */
  requestTaskRename: (taskId: string) => void;
  openFindInFiles: (taskId: string) => void;
  closeFindInFiles: () => void;
  setBusy: (msg: string | null) => void;
  reloadFileTree: () => void;
  /** Pick the dashboard's phase filter, or `null` for All. */
  setDashboardPhase: (phase: TaskPhase | null) => void;
  /** Open the global confirm modal. Returns a Promise that resolves
   *  to true (user confirmed) or false (cancelled / dismissed). Drop-in
   *  replacement for `window.confirm()` with our own chrome + theming. */
  askConfirm: {
    (req: ConfirmRequest & { checkbox: ConfirmCheckbox }): Promise<ConfirmResult>;
    // `true`, not `boolean`: a request that passes `dontAskAgain: false` gets
    // no second checkbox, so confirmAnswer hands back a bare boolean. Typing
    // that call as ConfirmResult would compile and then read `.confirmed` off
    // a boolean at runtime, silently turning a confirm into a cancel.
    (req: ConfirmRequest & { dontAskAgain: true }): Promise<ConfirmResult>;
    (req: ConfirmRequest & { checkbox: undefined }): Promise<boolean>;
    (req: ConfirmRequest): Promise<boolean | ConfirmResult>;
  };
  resolveConfirm: (ok: boolean, checked?: boolean, dontAskAgain?: boolean) => void;
  /** Take back a keyed confirm the asker no longer wants answered (its pane
   *  unmounted, its task was archived, or it is about to ask again). Resolves
   *  the pending promise as "cancelled" and closes the modal. Safe to call
   *  before the prompt has appeared — askConfirm defers by a macrotask, so a
   *  withdrawal that lands in that gap suppresses it when it fires. */
  withdrawConfirm: (key: string) => void;
  /** Open the sandboxed-terminal drop prompt. Resolves with the chosen
   *  sharing strategy (or {kind:"cancel"} on dismiss). */
  askTerminalDrop: (req: TerminalDropRequest) => Promise<TerminalDropChoice>;
  resolveTerminalDrop: (choice: TerminalDropChoice) => void;
  /** Open the scratchpad close prompt. Resolves with the user's choice
   *  ("cancel" on dismiss). */
  askScratchClose: (title: string) => Promise<ScratchCloseChoice>;
  resolveScratchClose: (choice: ScratchCloseChoice) => void;
  /** Open the promote picker. Resolves true when the pad became a file,
   *  false on cancel/dismiss. */
  askScratchSave: (taskId: string, tabId: string) => Promise<boolean>;
  resolveScratchSave: (saved: boolean) => void;
  /** Open the Docker sandbox rebuild-nudge prompt. Resolves "rebuild" or
   *  "skip" once the user answers (DockerRebuildPromptDialog). */
  /** "always" = rebuild now AND stop asking (persists docker_rebuild_auto). */
  askDockerRebuild: (taskName: string, lastBuiltDate: string | null) => Promise<"rebuild" | "skip" | "always" | "background">;
  resolveDockerRebuildPrompt: (choice: "rebuild" | "skip" | "always" | "background") => void;
  /** Mark a task for auto-restart on the next PTY exit. Called by
   *  dialogs that change spawn-time config and then kill the live agent so
   *  it relaunches with the new settings (the Sandbox dialog before
   *  `task_set_sandbox`, the Resume override dialog before its kill). */
  markPendingPtyRestart: (taskId: string) => void;
  /** Pop the marker — TerminalPane calls this after consuming a
   *  pending restart so a SUBSEQUENT real exit shows the overlay. */
  consumePendingPtyRestart: (taskId: string) => boolean;
  /** Push a transient toast. Returns its id (so callers can dismiss
   *  early if needed). Auto-dismiss is handled by <Toaster/>.
   *  `opts.action` adds a button (e.g. "Undo") whose click runs the
   *  callback AND dismisses the toast. */
  pushToast: (msg: string, kind?: ToastKind, opts?: { action?: ToastAction; ttlMs?: number; sticky?: boolean }) => string;
  dismissToast: (id: string) => void;
}

export type ToastKind = "success" | "info" | "warning" | "error";
export interface ToastAction { label: string; onClick: () => void; }
export interface Toast {
  id: string;
  msg: string;
  kind: ToastKind;
  action?: ToastAction;
  /** Override the global TTL for this toast (e.g. longer for undo). */
  ttlMs?: number;
  /** Never auto-dismiss - only a click (the action, or the X) removes it.
   *  For a toast that asks the user to actually decide something (e.g. "PR
   *  merged, archive?"): a few-second TTL guarantees it's gone before
   *  anyone reads it if it lands while they're looking at a different
   *  task, which a merge notice usually does. */
  sticky?: boolean;
}

/** Keys withdrawn while their confirm was still inside askConfirm's macrotask
 *  deferral. Consumed by that deferred open, so entries never accumulate. */
const withdrawnConfirms = new Set<string>();

/** Shape the answer to match what the request asked for: a bare boolean for a
 *  plain confirm, the full object once either checkbox is in play. Every exit
 *  from a confirm (answered, dismissed, withdrawn) goes through here, so a
 *  caller awaiting the object form can never be handed a boolean instead. */
function confirmAnswer(
  req: ConfirmRequest, confirmed: boolean, checked: boolean, dontAskAgain: boolean,
): boolean | ConfirmResult {
  if (!req.checkbox && !req.dontAskAgain) return confirmed;
  return { confirmed, checked, dontAskAgain };
}

export const useUI = create<UIState>(set => ({
  newProjectOpen: false,
  newTaskProjectId: null,
  newTaskSeed: null,
  customCommandProjectId: null,
  customCommandMode: "repo_root",
  editCommandTaskId: null,
  runCommandsDialog: null,
  resumeOverrideTaskId: null,
  taskGoalTaskId: null,
  parkTaskId: null,
  windowless: false,
  // Assume focused until told otherwise: a first paint that guessed "away"
  // would badge a turn the user watched finish.
  windowFocused: true,
  closePromptOpen: false,
  newProfileOpen: false,
  deleteProfileSlug: null,
  closePromptNonce: 0,
  shortcutsHelpOpen: false,
  welcomeOpen: false,
  changelogOpen: false,
  createPrForTaskId: null,
  broadcastForTaskId: null,
  broadcastForProjectId: null,
  raceProjectId: null,
  raceCompareId: null,
  sandboxForTaskId: null,
  fileFinderTaskId: null,
  searchEverywhereTaskId: null,
  findInFilesTaskId: null,
  projectPickerOpen: false,
  projectPickerIntent: "task",
  commandPaletteOpen: false,
  promptPaletteOpen: false,
  syntaxPaletteFor: null,
  promptFire: null,
  renameRequest: null,
  busyMessage: null,
  fileTreeNonce: 0,
  dashboardPhase: null,
  confirm: null,
  terminalDrop: null,
  scratchClose: null,
  scratchSave: null,
  dockerRebuildPrompt: null,
  pendingPtyRestarts: new Set<string>(),
  toasts: [],

  openNewProject:    () => set({ newProjectOpen: true }),
  closeNewProject:   () => set({ newProjectOpen: false }),
  // Every open carries a fresh nonce, including a seedless one: "open the New
  // Task dialog" means a fresh form even when it is already up for the same
  // project, and only the store can guarantee the value actually changes.
  openNewTask:  (projectId, seed) => set(s => ({
    newTaskProjectId: projectId,
    newTaskSeed: { ...(seed ?? {}), nonce: (s.newTaskSeed?.nonce ?? 0) + 1 },
  })),
  closeNewTask: () => set({ newTaskProjectId: null, newTaskSeed: null }),
  openCustomCommand:  (projectId, mode = "repo_root") => set({ customCommandProjectId: projectId, customCommandMode: mode }),
  closeCustomCommand: () => set({ customCommandProjectId: null }),
  openEditCommand:    (taskId) => set({ editCommandTaskId: taskId }),
  closeEditCommand:   () => set({ editCommandTaskId: null }),
  openRunCommands:    (projectId, initialAdd) => set({ runCommandsDialog: { projectId, initialAdd } }),
  closeRunCommands:   () => set({ runCommandsDialog: null }),
  openResumeOverride: (taskId) => set({ resumeOverrideTaskId: taskId }),
  closeResumeOverride:() => set({ resumeOverrideTaskId: null }),
  openTaskGoal:       (taskId) => set({ taskGoalTaskId: taskId }),
  closeTaskGoal:      () => set({ taskGoalTaskId: null }),
  openParkTask:       (taskId) => set({ parkTaskId: taskId }),
  closeParkTask:      () => set({ parkTaskId: null }),
  setWindowless: (v) => set({ windowless: v }),
  setWindowFocused: (v) => set(s => (s.windowFocused === v ? s : { windowFocused: v })),
  setClosePromptOpen: (v) => set({ closePromptOpen: v }),
  openNewProfile: () => set({ newProfileOpen: true }),
  setNewProfileOpen: (v) => set({ newProfileOpen: v }),
  setDeleteProfileSlug: (slug) => set({ deleteProfileSlug: slug }),
  requestClosePrompt: () =>
    set(s => ({ closePromptOpen: true, closePromptNonce: s.closePromptNonce + 1 })),
  openShortcutsHelp:  () => set({ shortcutsHelpOpen: true }),
  closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),
  openWelcome:       () => set({ welcomeOpen: true }),
  closeWelcome:      () => set({ welcomeOpen: false }),
  openChangelog:     () => set({ changelogOpen: true }),
  closeChangelog:    () => set({ changelogOpen: false }),
  openCreatePr:      (taskId) => set({ createPrForTaskId: taskId }),
  closeCreatePr:     () => set({ createPrForTaskId: null }),
  openBroadcast:     (taskId) => set({ broadcastForTaskId: taskId, broadcastForProjectId: null }),
  openProjectBroadcast: (projectId) => set({ broadcastForProjectId: projectId, broadcastForTaskId: null }),
  closeBroadcast:    () => set({ broadcastForTaskId: null, broadcastForProjectId: null }),
  openRace:          (projectId) => set({ raceProjectId: projectId }),
  closeRace:         () => set({ raceProjectId: null }),
  openRaceCompare:   (raceId) => set({ raceCompareId: raceId }),
  closeRaceCompare:  () => set({ raceCompareId: null }),
  openSandbox:       (taskId) => set({ sandboxForTaskId: taskId }),
  commitReveal: null,
  revealCommitInHistory: (taskId, sha) =>
    // Un-hiding the right panel is RightPanel's job, not this store's: app.ts
    // already imports this module, and reaching back the other way would make
    // the two stores a cycle.
    set({ commitReveal: { taskId, sha, at: Date.now() } }),
  clearCommitReveal: () => set({ commitReveal: null }),
  closeSandbox:      () => set({ sandboxForTaskId: null }),
  openFileFinder:    (taskId) => set({ fileFinderTaskId: taskId }),
  openSearchEverywhere:  (taskId) => set({ searchEverywhereTaskId: taskId }),
  closeSearchEverywhere: () => set({ searchEverywhereTaskId: null }),
  closeFileFinder:   () => set({ fileFinderTaskId: null }),
  openFindInFiles:   (taskId) => set({ findInFilesTaskId: taskId }),
  closeFindInFiles:  () => set({ findInFilesTaskId: null }),
  openProjectPicker: (intent = "task") => set({ projectPickerOpen: true, projectPickerIntent: intent }),
  closeProjectPicker:() => set({ projectPickerOpen: false }),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette:() => set({ commandPaletteOpen: false }),
  openPromptPalette: () => set({ promptPaletteOpen: true }),
  closePromptPalette:() => set({ promptPaletteOpen: false }),
  openSyntaxPalette: (taskId: string, tabId: string) => set({ syntaxPaletteFor: { taskId, tabId } }),
  closeSyntaxPalette:() => set({ syntaxPaletteFor: null }),
  openPromptFire:    (prompt) => set({ promptFire: { prompt, body: prompt.body } }),
  closePromptFire:   () => set({ promptFire: null }),
  setPromptFireBody: (body) => set(s => (s.promptFire ? { promptFire: { ...s.promptFire, body } } : s)),
  requestTaskRename: (taskId) => set(s => ({
    renameRequest: { taskId, nonce: (s.renameRequest?.nonce ?? 0) + 1 },
  })),
  setBusy:           (msg) => set({ busyMessage: msg }),
  reloadFileTree:    () => set(s => ({ fileTreeNonce: s.fileTreeNonce + 1 })),
  // Bails on an unchanged value like `setWindowFocused` does: re-picking the
  // pill that is already selected must not copy the store and wake every
  // subscriber (docs/performance.md bear trap 8).
  setDashboardPhase: (phase) => set(s => (s.dashboardPhase === phase ? s : { dashboardPhase: phase })),
  askConfirm: (req: any) =>
    // Defer mounting the confirm dialog by a macrotask. When a Radix
    // ContextMenu / Dropdown item's onSelect calls askConfirm, the menu is
    // still mounted and holds a `pointer-events: none` lock on <body>. If the
    // dialog mounts synchronously it captures that `none` as its own baseline,
    // and on close restores `none` — leaving the whole UI unclickable (an
    // invisible layer over everything). setTimeout(0) runs after React has
    // flushed the menu's unmount + its body cleanup, so the dialog mounts with
    // a clean `pointer-events: ""` baseline. (GH #43: discard via right-click.)
    new Promise<any>(resolve => setTimeout(() => {
      // Withdrawn during the deferral gap → never show it.
      if (req.key && withdrawnConfirms.delete(req.key)) {
        resolve(confirmAnswer(req, false, false, false));
        return;
      }
      set({ confirm: { req, resolve } });
    }, 0)),
  resolveConfirm: (ok, checked, dontAskAgain) => {
    const c = useUI.getState().confirm;
    if (c) c.resolve(confirmAnswer(c.req, ok, !!checked, !!dontAskAgain));
    set({ confirm: null });
  },
  withdrawConfirm: (key) => {
    const c = useUI.getState().confirm;
    if (c?.req.key === key) {
      c.resolve(confirmAnswer(c.req, false, false, false));
      set({ confirm: null });
      return;
    }
    // Not on screen yet. Leave a note for the deferred open above; it is
    // consumed there, so this set only ever holds in-flight keys.
    withdrawnConfirms.add(key);
  },
  askTerminalDrop: (req) =>
    new Promise<TerminalDropChoice>(resolve => set({ terminalDrop: { req, resolve } })),
  resolveTerminalDrop: (choice) => {
    const d = useUI.getState().terminalDrop;
    d?.resolve(choice);
    set({ terminalDrop: null });
  },
  askScratchClose: (title) =>
    // Same macrotask deferral askConfirm uses: this prompt is reached from a
    // tab context-menu item, and a dialog mounted while Radix still holds its
    // `pointer-events: none` lock on <body> restores that lock on close and
    // leaves the whole window unclickable (GH #43).
    new Promise<ScratchCloseChoice>(resolve =>
      setTimeout(() => set({ scratchClose: { title, resolve } }), 0)),
  resolveScratchClose: (choice) => {
    const c = useUI.getState().scratchClose;
    c?.resolve(choice);
    set({ scratchClose: null });
  },
  askScratchSave: (taskId, tabId) =>
    new Promise<boolean>(resolve =>
      // Deferred like askConfirm / askScratchClose: this can open straight
      // off the close prompt's "Save…" button, i.e. while another dialog is
      // still unmounting (GH #43's pointer-events lock).
      setTimeout(() => set({ scratchSave: { taskId, tabId, resolve } }), 0)),
  resolveScratchSave: (saved) => {
    const d = useUI.getState().scratchSave;
    d?.resolve(saved);
    set({ scratchSave: null });
  },
  askDockerRebuild: (taskName, lastBuiltDate) =>
    new Promise(resolve => set({ dockerRebuildPrompt: { taskName, lastBuiltDate, resolve } })),
  resolveDockerRebuildPrompt: (choice) => {
    const p = useUI.getState().dockerRebuildPrompt;
    p?.resolve(choice);
    set({ dockerRebuildPrompt: null });
  },
  markPendingPtyRestart: (taskId) => set(s => {
    const next = new Set(s.pendingPtyRestarts);
    next.add(taskId);
    return { pendingPtyRestarts: next };
  }),
  consumePendingPtyRestart: (taskId) => {
    const s = useUI.getState();
    if (!s.pendingPtyRestarts.has(taskId)) return false;
    const next = new Set(s.pendingPtyRestarts);
    next.delete(taskId);
    useUI.setState({ pendingPtyRestarts: next });
    return true;
  },
  pushToast: (msg, kind = "success", opts) => {
    const id = crypto.randomUUID();
    set(s => ({ toasts: [...s.toasts, { id, msg, kind, action: opts?.action, ttlMs: opts?.ttlMs, sticky: opts?.sticky }] }));
    return id;
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));
