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

interface UIState {
  // dialog visibility
  newProjectOpen: boolean;
  newTaskProjectId: string | null;  // null = closed
  /** Optional seed for the New worktree dialog — when set, the dialog
   *  pre-fills the branch-from field with this value. Used by the
   *  "Duplicate task" flow to branch a new worktree off an
   *  existing one's tip. Cleared when the dialog closes. */
  newTaskSeed: { baseBranch?: string; namePrefix?: string; importMode?: boolean } | null;
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
  /** ⌘K command palette — searchable list of every command / action. */
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
  openNewTask: (projectId: string, seed?: { baseBranch?: string; namePrefix?: string; importMode?: boolean }) => void;
  closeNewTask: () => void;
  openCustomCommand: (projectId: string, mode?: "worktree" | "repo_root") => void;
  closeCustomCommand: () => void;
  openEditCommand: (taskId: string) => void;
  closeEditCommand: () => void;
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
  /** Most recent OS notification we forwarded — consumed by
   *  useAttentionNotifier's focus router so clicking the banner
   *  (which surfaces the app window) routes the user to the tab
   *  that emitted it. Stored at module scope rather than the ref
   *  inside useAttentionNotifier so any source (OSC 9, markAttention)
   *  can seed it. ROUTE_WINDOW_MS gating + clearing on consumption
   *  live inside the hook. */
  notifyRoute: { taskId: string; tabId: string; firedAt: number } | null;
  setNotifyRoute: (route: { taskId: string; tabId: string } | null) => void;
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

export const useUI = create<UIState>(set => ({
  newProjectOpen: false,
  newTaskProjectId: null,
  newTaskSeed: null,
  customCommandProjectId: null,
  customCommandMode: "repo_root",
  editCommandTaskId: null,
  resumeOverrideTaskId: null,
  taskCreateProgress: null,
  shortcutsHelpOpen: false,
  welcomeOpen: false,
  changelogOpen: false,
  broadcastForTaskId: null,
  broadcastForProjectId: null,
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
  notifyRoute: null,

  openNewProject:    () => set({ newProjectOpen: true }),
  closeNewProject:   () => set({ newProjectOpen: false }),
  openNewTask:  (projectId, seed) => set({ newTaskProjectId: projectId, newTaskSeed: seed ?? null }),
  closeNewTask: () => set({ newTaskProjectId: null, newTaskSeed: null }),
  openCustomCommand:  (projectId, mode = "repo_root") => set({ customCommandProjectId: projectId, customCommandMode: mode }),
  closeCustomCommand: () => set({ customCommandProjectId: null }),
  openEditCommand:    (taskId) => set({ editCommandTaskId: taskId }),
  closeEditCommand:   () => set({ editCommandTaskId: null }),
  openResumeOverride: (taskId) => set({ resumeOverrideTaskId: taskId }),
  closeResumeOverride:() => set({ resumeOverrideTaskId: null }),
  setTaskCreateProgress: (p) => set({ taskCreateProgress: p }),
  openShortcutsHelp:  () => set({ shortcutsHelpOpen: true }),
  closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),
  openWelcome:       () => set({ welcomeOpen: true }),
  closeWelcome:      () => set({ welcomeOpen: false }),
  openChangelog:     () => set({ changelogOpen: true }),
  closeChangelog:    () => set({ changelogOpen: false }),
  openBroadcast:     (taskId) => set({ broadcastForTaskId: taskId, broadcastForProjectId: null }),
  openProjectBroadcast: (projectId) => set({ broadcastForProjectId: projectId, broadcastForTaskId: null }),
  closeBroadcast:    () => set({ broadcastForTaskId: null, broadcastForProjectId: null }),
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
  setNotifyRoute:    (route) => set({
    notifyRoute: route ? { ...route, firedAt: Date.now() } : null,
  }),
  askConfirm: (req: any) =>
    // Defer mounting the confirm dialog by a macrotask. When a Radix
    // ContextMenu / Dropdown item's onSelect calls askConfirm, the menu is
    // still mounted and holds a `pointer-events: none` lock on <body>. If the
    // dialog mounts synchronously it captures that `none` as its own baseline,
    // and on close restores `none` — leaving the whole UI unclickable (an
    // invisible layer over everything). setTimeout(0) runs after React has
    // flushed the menu's unmount + its body cleanup, so the dialog mounts with
    // a clean `pointer-events: ""` baseline. (GH #43: discard via right-click.)
    new Promise<any>(resolve => setTimeout(() => set({ confirm: { req, resolve } }), 0)),
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
