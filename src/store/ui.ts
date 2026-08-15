// Transient UI-only store (separate from the main app store so re-renders
// triggered by opening a dialog don't churn the task tree).

import { create } from "zustand";
import type { Prompt } from "@/store/prompts";

export interface ConfirmCheckbox {
  label: string;
  defaultValue?: boolean;
  branchName?: string;
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
  /** Identifies a prompt whose asker can go away before it is answered (a
   *  terminal pane's "restart to apply YOLO?", say — the tab can be closed or
   *  the task archived while it stands). The asker passes a key here and calls
   *  `withdrawConfirm(key)` on teardown; without one, the modal outlives the
   *  thing it was asking about and blocks the whole window. Only one confirm
   *  is on screen at a time, so an un-withdrawn prompt is not a small mess. */
  key?: string;
}

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
  /** Progress overlay for a QUICK worktree create (sidebar inline row).
   *  Reuses the New Task dialog's ProgressBody: "creating" shows the
   *  worktree add / file-copy spinner, "error" surfaces the failure with a
   *  Close button. null = hidden. Main-checkout creates are instant and
   *  never set this. */
  taskCreateProgress: { phase: "creating" | "error"; err: string | null } | null;
  /** Read-only "Keyboard shortcuts" cheat-sheet modal (opened from the
   *  sidebar footer). Distinct from Settings → Shortcuts (which edits them). */
  /** True while Termic is in windowless mode (window closed to the menu bar,
   *  or launched `--headless` by the CLI). Agents keep running; MainArea
   *  collapses every task pane to ZERO GEOMETRY, which is the only thing that
   *  actually pauses xterm's renderers - hiding the NSWindow does not (a
   *  hidden window still reports full layout). See docs/performance.md bear
   *  trap 2 and the windowless block in src-tauri/src/lib.rs. */
  windowless: boolean;
  setWindowless: (v: boolean) => void;
  /** The window close prompt ("Keep in Menu Bar" / "Quit Termic" / dismiss).
   *  Opened by Rust's `termic://close-requested`, which only fires when the
   *  `close_action` setting is unset or "ask". */
  closePromptOpen: boolean;
  setClosePromptOpen: (v: boolean) => void;
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
  /** Global fuzzy project picker (⌘N) — search any loaded project and
   *  start a new task for it without scrolling the sidebar. */
  projectPickerOpen: boolean;
  /** ⇧⌘P command palette — searchable list of every command / action. */
  commandPaletteOpen: boolean;
  /** ⌥⌘P prompt palette — searchable list of library prompts (title only). */
  promptPaletteOpen: boolean;
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
  setTaskCreateProgress: (p: { phase: "creating" | "error"; err: string | null } | null) => void;
  openShortcutsHelp: () => void;
  closeShortcutsHelp: () => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  openChangelog: () => void;
  closeChangelog: () => void;
  openBroadcast: (taskId: string) => void;
  openProjectBroadcast: (projectId: string) => void;
  closeBroadcast: () => void;
  openRace: (projectId: string) => void;
  closeRace: () => void;
  openRaceCompare: (raceId: string) => void;
  closeRaceCompare: () => void;
  openSandbox: (taskId: string) => void;
  closeSandbox: () => void;
  openFileFinder: (taskId: string) => void;
  closeFileFinder: () => void;
  openProjectPicker: () => void;
  closeProjectPicker: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  openPromptPalette: () => void;
  closePromptPalette: () => void;
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
  /** Open the global confirm modal. Returns a Promise that resolves
   *  to true (user confirmed) or false (cancelled / dismissed). Drop-in
   *  replacement for `window.confirm()` with our own chrome + theming. */
  askConfirm: {
    (req: ConfirmRequest & { checkbox: ConfirmCheckbox }): Promise<{ confirmed: boolean; checked: boolean }>;
    (req: ConfirmRequest & { checkbox: undefined }): Promise<boolean>;
    (req: ConfirmRequest): Promise<boolean | { confirmed: boolean; checked: boolean }>;
  };
  resolveConfirm: (ok: boolean, checked?: boolean) => void;
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
  pushToast: (msg: string, kind?: ToastKind, opts?: { action?: ToastAction; ttlMs?: number }) => string;
  dismissToast: (id: string) => void;
}

export type ToastKind = "success" | "info" | "error";
export interface ToastAction { label: string; onClick: () => void; }
export interface Toast {
  id: string;
  msg: string;
  kind: ToastKind;
  action?: ToastAction;
  /** Override the global TTL for this toast (e.g. longer for undo). */
  ttlMs?: number;
}

/** Keys withdrawn while their confirm was still inside askConfirm's macrotask
 *  deferral. Consumed by that deferred open, so entries never accumulate. */
const withdrawnConfirms = new Set<string>();

export const useUI = create<UIState>(set => ({
  newProjectOpen: false,
  newTaskProjectId: null,
  newTaskSeed: null,
  customCommandProjectId: null,
  customCommandMode: "repo_root",
  editCommandTaskId: null,
  runCommandsDialog: null,
  resumeOverrideTaskId: null,
  taskCreateProgress: null,
  windowless: false,
  closePromptOpen: false,
  closePromptNonce: 0,
  shortcutsHelpOpen: false,
  welcomeOpen: false,
  changelogOpen: false,
  broadcastForTaskId: null,
  broadcastForProjectId: null,
  raceProjectId: null,
  raceCompareId: null,
  sandboxForTaskId: null,
  fileFinderTaskId: null,
  findInFilesTaskId: null,
  projectPickerOpen: false,
  commandPaletteOpen: false,
  promptPaletteOpen: false,
  promptFire: null,
  renameRequest: null,
  busyMessage: null,
  fileTreeNonce: 0,
  confirm: null,
  terminalDrop: null,
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
  setTaskCreateProgress: (p) => set({ taskCreateProgress: p }),
  setWindowless: (v) => set({ windowless: v }),
  setClosePromptOpen: (v) => set({ closePromptOpen: v }),
  requestClosePrompt: () =>
    set(s => ({ closePromptOpen: true, closePromptNonce: s.closePromptNonce + 1 })),
  openShortcutsHelp:  () => set({ shortcutsHelpOpen: true }),
  closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),
  openWelcome:       () => set({ welcomeOpen: true }),
  closeWelcome:      () => set({ welcomeOpen: false }),
  openChangelog:     () => set({ changelogOpen: true }),
  closeChangelog:    () => set({ changelogOpen: false }),
  openBroadcast:     (taskId) => set({ broadcastForTaskId: taskId, broadcastForProjectId: null }),
  openProjectBroadcast: (projectId) => set({ broadcastForProjectId: projectId, broadcastForTaskId: null }),
  closeBroadcast:    () => set({ broadcastForTaskId: null, broadcastForProjectId: null }),
  openRace:          (projectId) => set({ raceProjectId: projectId }),
  closeRace:         () => set({ raceProjectId: null }),
  openRaceCompare:   (raceId) => set({ raceCompareId: raceId }),
  closeRaceCompare:  () => set({ raceCompareId: null }),
  openSandbox:       (taskId) => set({ sandboxForTaskId: taskId }),
  closeSandbox:      () => set({ sandboxForTaskId: null }),
  openFileFinder:    (taskId) => set({ fileFinderTaskId: taskId }),
  closeFileFinder:   () => set({ fileFinderTaskId: null }),
  openFindInFiles:   (taskId) => set({ findInFilesTaskId: taskId }),
  closeFindInFiles:  () => set({ findInFilesTaskId: null }),
  openProjectPicker: () => set({ projectPickerOpen: true }),
  closeProjectPicker:() => set({ projectPickerOpen: false }),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette:() => set({ commandPaletteOpen: false }),
  openPromptPalette: () => set({ promptPaletteOpen: true }),
  closePromptPalette:() => set({ promptPaletteOpen: false }),
  openPromptFire:    (prompt) => set({ promptFire: { prompt, body: prompt.body } }),
  closePromptFire:   () => set({ promptFire: null }),
  setPromptFireBody: (body) => set(s => (s.promptFire ? { promptFire: { ...s.promptFire, body } } : s)),
  requestTaskRename: (taskId) => set(s => ({
    renameRequest: { taskId, nonce: (s.renameRequest?.nonce ?? 0) + 1 },
  })),
  setBusy:           (msg) => set({ busyMessage: msg }),
  reloadFileTree:    () => set(s => ({ fileTreeNonce: s.fileTreeNonce + 1 })),
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
        resolve(req.checkbox ? { confirmed: false, checked: false } : false);
        return;
      }
      set({ confirm: { req, resolve } });
    }, 0)),
  resolveConfirm: (ok, checked) => {
    const c = useUI.getState().confirm;
    if (c) {
      if (c.req.checkbox) {
        c.resolve({ confirmed: ok, checked: !!checked });
      } else {
        c.resolve(ok);
      }
    }
    set({ confirm: null });
  },
  withdrawConfirm: (key) => {
    const c = useUI.getState().confirm;
    if (c?.req.key === key) {
      c.resolve(c.req.checkbox ? { confirmed: false, checked: false } : false);
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
    set(s => ({ toasts: [...s.toasts, { id, msg, kind, action: opts?.action, ttlMs: opts?.ttlMs }] }));
    return id;
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));
