// Transient UI-only store (separate from the main app store so re-renders
// triggered by opening a dialog don't churn the workspace tree).

import { create } from "zustand";

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
  /** Owning workspace id (for staging + allow-list mutations). */
  wsId: string;
}

interface UIState {
  // dialog visibility
  newProjectOpen: boolean;
  newWorkspaceProjectId: string | null;  // null = closed
  /** Optional seed for the New worktree dialog — when set, the dialog
   *  pre-fills the branch-from field with this value. Used by the
   *  "Duplicate workspace" flow to branch a new worktree off an
   *  existing one's tip. Cleared when the dialog closes. */
  newWorkspaceSeed: { baseBranch?: string; namePrefix?: string; importMode?: boolean } | null;
  /** "Run a command in repo" dialog — project id to open it for, null =
   *  closed. Creates a repo-root workspace whose default tab runs a
   *  user-supplied launch command instead of an agent. */
  customCommandProjectId: string | null;
  /** "Edit launch command" dialog — workspace id to edit the custom
   *  launch command for, null = closed. Only opened for cli==="custom"
   *  workspaces. Lives in UI store so opening doesn't churn the
   *  workspace tree. */
  editCommandWsId: string | null;
  /** Workspace id whose resume-args override is being edited, null =
   *  closed. Lives in UI store so opening doesn't churn the workspace
   *  tree. */
  resumeOverrideWsId: string | null;
  /** Read-only "Keyboard shortcuts" cheat-sheet modal (⌘/). Distinct
   *  from Settings → Shortcuts (which edits them). */
  shortcutsHelpOpen: boolean;
  welcomeOpen: boolean;
  /** Changelog dialog — full per-version release notes. */
  changelogOpen: boolean;
  /** Broadcast dialog — send one message to several open agents in a
   *  workspace at once. null = closed. UI-store (not app) so opening it
   *  doesn't churn the workspace tree. */
  broadcastForWsId: string | null;
  /** Open the Edit Sandbox dialog for a specific workspace. null = closed.
   *  Lives in UI store (not app) so flipping it doesn't churn the
   *  workspace tree on every re-render. */
  sandboxForWsId: string | null;
  /** ⌘P file finder — workspace id to scope the search to; null = closed.
   *  Lives here so opening doesn't churn the workspace tree. */
  fileFinderWsId: string | null;
  /** Global fuzzy project picker (⌘N) — search any loaded project and
   *  start a new workspace for it without scrolling the sidebar. */
  projectPickerOpen: boolean;
  /** ⌘K command palette — searchable list of every command / action. */
  commandPaletteOpen: boolean;
  /** Fire-and-forget "start inline-rename on this workspace row" signal.
   *  The sidebar's WorkspaceRow watches the nonce and, when the wsId
   *  matches, flips its own local rename state (the same thing the row's
   *  dropdown "Rename" does). Lives here so the command palette can
   *  trigger the sidebar rename from outside the sidebar tree. The caller
   *  is responsible for expanding the row's project first (a collapsed
   *  project doesn't render the row, so the signal would be missed). */
  renameRequest: { wsId: string; nonce: number } | null;
  /** ⇧⌘F find-in-files dialog — workspace id, null = closed. */
  findInFilesWsId: string | null;
  /** Global "blocking work in flight" message. Shows a centered loader over
   *  the whole window so the user knows the freeze is intentional. Set for
   *  unavoidably-synchronous IPC calls like `workspace_archive` that take
   *  several seconds (git worktree remove + rm -rf). */
  busyMessage: string | null;
  /** Active confirm prompt, if any. null = nothing pending. The
   *  resolve callback fires with the user's choice when the modal
   *  closes; the ConfirmDialog component reads this and renders. */
  confirm: { req: ConfirmRequest; resolve: (res: any) => void } | null;
  /** Active sandboxed-terminal drop prompt, if any. The resolve callback
   *  fires with the user's choice when the modal closes. */
  terminalDrop: { req: TerminalDropRequest; resolve: (c: TerminalDropChoice) => void } | null;
  /** Workspaces whose PTYs are about to be SIGKILL'd because the user
   *  explicitly hit "Save & restart" on a config dialog (Sandbox or
   *  Resume override). The next pty-exit for any PTY belonging to one of
   *  these workspaces will trigger an immediate respawn (the TerminalPane
   *  checks the set on exit instead of showing the "Restart agent"
   *  overlay). Cleared per-(ws,tab) when the respawn fires. */
  pendingPtyRestarts: Set<string>;
  /** Transient bottom-right toasts. Auto-dismiss handled in <Toaster/>. */
  toasts: Toast[];
  /** Fire-and-forget "run the run-script now" signal from chrome outside
   *  the RightPanel (the UnifiedBar's top-right Run button). The RightPanel
   *  owns the footer's collapse/tab state plus the spotlight/members nuance,
   *  so rather than duplicate `startScript("run")` we bump a nonce here and
   *  let the matching RightPanel react. null = nothing pending. */
  runScriptRequest: { wsId: string; nonce: number; kind: "run" | "setup" } | null;
  /** Bumped to force the "All files" tree to re-read from disk — e.g. after
   *  the user edits exclude patterns in Settings (the tree is behind the
   *  Settings overlay, so it can't refresh itself). RightPanel folds this
   *  into its local reload token. */
  fileTreeNonce: number;

  // actions
  openNewProject: () => void;
  closeNewProject: () => void;
  openNewWorkspace: (projectId: string, seed?: { baseBranch?: string; namePrefix?: string; importMode?: boolean }) => void;
  closeNewWorkspace: () => void;
  openCustomCommand: (projectId: string) => void;
  closeCustomCommand: () => void;
  openEditCommand: (wsId: string) => void;
  closeEditCommand: () => void;
  openResumeOverride: (wsId: string) => void;
  closeResumeOverride: () => void;
  openShortcutsHelp: () => void;
  closeShortcutsHelp: () => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  openChangelog: () => void;
  closeChangelog: () => void;
  openBroadcast: (wsId: string) => void;
  closeBroadcast: () => void;
  openSandbox: (wsId: string) => void;
  closeSandbox: () => void;
  openFileFinder: (wsId: string) => void;
  closeFileFinder: () => void;
  openProjectPicker: () => void;
  closeProjectPicker: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  /** Ask the sidebar to start inline-renaming `wsId`. */
  requestWorkspaceRename: (wsId: string) => void;
  openFindInFiles: (wsId: string) => void;
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
  /** Mark a workspace for auto-restart on the next PTY exit. Called by
   *  dialogs that change spawn-time config and then kill the live agent so
   *  it relaunches with the new settings (the Sandbox dialog before
   *  `workspace_set_sandbox`, the Resume override dialog before its kill). */
  markPendingPtyRestart: (wsId: string) => void;
  /** Pop the marker — TerminalPane calls this after consuming a
   *  pending restart so a SUBSEQUENT real exit shows the overlay. */
  consumePendingPtyRestart: (wsId: string) => boolean;
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
  notifyRoute: { wsId: string; tabId: string; firedAt: number } | null;
  setNotifyRoute: (route: { wsId: string; tabId: string } | null) => void;
  /** Ask the workspace's RightPanel to start its run-script (or setup
   *  script) — used by chrome outside the RightPanel: the UnifiedBar's Run
   *  button and the TabBar's popped-out RunControls. No-op if that
   *  workspace isn't mounted. */
  requestRunScript: (wsId: string, kind?: "run" | "setup") => void;
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
  newWorkspaceProjectId: null,
  newWorkspaceSeed: null,
  customCommandProjectId: null,
  editCommandWsId: null,
  resumeOverrideWsId: null,
  shortcutsHelpOpen: false,
  welcomeOpen: false,
  changelogOpen: false,
  broadcastForWsId: null,
  sandboxForWsId: null,
  fileFinderWsId: null,
  findInFilesWsId: null,
  projectPickerOpen: false,
  commandPaletteOpen: false,
  renameRequest: null,
  busyMessage: null,
  runScriptRequest: null,
  fileTreeNonce: 0,
  confirm: null,
  terminalDrop: null,
  pendingPtyRestarts: new Set<string>(),
  toasts: [],
  notifyRoute: null,

  openNewProject:    () => set({ newProjectOpen: true }),
  closeNewProject:   () => set({ newProjectOpen: false }),
  openNewWorkspace:  (projectId, seed) => set({ newWorkspaceProjectId: projectId, newWorkspaceSeed: seed ?? null }),
  closeNewWorkspace: () => set({ newWorkspaceProjectId: null, newWorkspaceSeed: null }),
  openCustomCommand:  (projectId) => set({ customCommandProjectId: projectId }),
  closeCustomCommand: () => set({ customCommandProjectId: null }),
  openEditCommand:    (wsId) => set({ editCommandWsId: wsId }),
  closeEditCommand:   () => set({ editCommandWsId: null }),
  openResumeOverride: (wsId) => set({ resumeOverrideWsId: wsId }),
  closeResumeOverride:() => set({ resumeOverrideWsId: null }),
  openShortcutsHelp:  () => set({ shortcutsHelpOpen: true }),
  closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),
  openWelcome:       () => set({ welcomeOpen: true }),
  closeWelcome:      () => set({ welcomeOpen: false }),
  openChangelog:     () => set({ changelogOpen: true }),
  closeChangelog:    () => set({ changelogOpen: false }),
  openBroadcast:     (wsId) => set({ broadcastForWsId: wsId }),
  closeBroadcast:    () => set({ broadcastForWsId: null }),
  openSandbox:       (wsId) => set({ sandboxForWsId: wsId }),
  closeSandbox:      () => set({ sandboxForWsId: null }),
  openFileFinder:    (wsId) => set({ fileFinderWsId: wsId }),
  closeFileFinder:   () => set({ fileFinderWsId: null }),
  openFindInFiles:   (wsId) => set({ findInFilesWsId: wsId }),
  closeFindInFiles:  () => set({ findInFilesWsId: null }),
  openProjectPicker: () => set({ projectPickerOpen: true }),
  closeProjectPicker:() => set({ projectPickerOpen: false }),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette:() => set({ commandPaletteOpen: false }),
  requestWorkspaceRename: (wsId) => set(s => ({
    renameRequest: { wsId, nonce: (s.renameRequest?.nonce ?? 0) + 1 },
  })),
  setBusy:           (msg) => set({ busyMessage: msg }),
  reloadFileTree:    () => set(s => ({ fileTreeNonce: s.fileTreeNonce + 1 })),
  setNotifyRoute:    (route) => set({
    notifyRoute: route ? { ...route, firedAt: Date.now() } : null,
  }),
  requestRunScript:  (wsId, kind = "run") => set(s => ({
    runScriptRequest: { wsId, nonce: (s.runScriptRequest?.nonce ?? 0) + 1, kind },
  })),
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
  markPendingPtyRestart: (wsId) => set(s => {
    const next = new Set(s.pendingPtyRestarts);
    next.add(wsId);
    return { pendingPtyRestarts: next };
  }),
  consumePendingPtyRestart: (wsId) => {
    const s = useUI.getState();
    if (!s.pendingPtyRestarts.has(wsId)) return false;
    const next = new Set(s.pendingPtyRestarts);
    next.delete(wsId);
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
