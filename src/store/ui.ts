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
  /** Read-only "Keyboard shortcuts" cheat-sheet modal (⌘/). Distinct
   *  from Settings → Shortcuts (which edits them). */
  shortcutsHelpOpen: boolean;
  welcomeOpen: boolean;
  /** Changelog dialog — full per-version release notes. */
  changelogOpen: boolean;
  reviewForWsId: string | null;          // null = closed
  /** Broadcast dialog — send one message to several open agents in a
   *  workspace at once. null = closed. UI-store (not app) so opening it
   *  doesn't churn the workspace tree. */
  broadcastForWsId: string | null;
  /** Message queue dialog — workspace id whose agents' queues are being
   *  edited, null = closed. The dialog picks a target agent tab within
   *  the workspace. UI-store (not app) so opening it doesn't churn the
   *  workspace tree. */
  queueForWsId: string | null;
  /** Open the Edit Sandbox dialog for a specific workspace. null = closed.
   *  Lives in UI store (not app) so flipping it doesn't churn the
   *  workspace tree on every re-render. */
  sandboxForWsId: string | null;
  /** ⌘P file finder — workspace id to scope the search to; null = closed.
   *  Lives here so opening doesn't churn the workspace tree. */
  fileFinderWsId: string | null;
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
   *  explicitly hit "Save & restart" on the Sandbox dialog. The next
   *  pty-exit for any PTY belonging to one of these workspaces will
   *  trigger an immediate respawn (the TerminalPane checks the set on
   *  exit instead of showing the "Restart agent" overlay). Cleared
   *  per-(ws,tab) when the respawn fires. */
  pendingSandboxRestarts: Set<string>;
  /** Transient bottom-right toasts. Auto-dismiss handled in <Toaster/>. */
  toasts: Toast[];

  // actions
  openNewProject: () => void;
  closeNewProject: () => void;
  openNewWorkspace: (projectId: string, seed?: { baseBranch?: string; namePrefix?: string; importMode?: boolean }) => void;
  closeNewWorkspace: () => void;
  openCustomCommand: (projectId: string) => void;
  closeCustomCommand: () => void;
  openEditCommand: (wsId: string) => void;
  closeEditCommand: () => void;
  openShortcutsHelp: () => void;
  closeShortcutsHelp: () => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  openChangelog: () => void;
  closeChangelog: () => void;
  openReview: (wsId: string) => void;
  closeReview: () => void;
  openBroadcast: (wsId: string) => void;
  closeBroadcast: () => void;
  openQueue: (wsId: string) => void;
  closeQueue: () => void;
  openSandbox: (wsId: string) => void;
  closeSandbox: () => void;
  openFileFinder: (wsId: string) => void;
  closeFileFinder: () => void;
  openFindInFiles: (wsId: string) => void;
  closeFindInFiles: () => void;
  setBusy: (msg: string | null) => void;
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
  /** Mark a workspace for auto-restart on the next PTY exit. Called
   *  by the Sandbox dialog right before `workspace_set_sandbox` (the
   *  IPC that SIGKILL's the live agents). */
  markPendingSandboxRestart: (wsId: string) => void;
  /** Pop the marker — TerminalPane calls this after consuming a
   *  pending restart so a SUBSEQUENT real exit shows the overlay. */
  consumePendingSandboxRestart: (wsId: string) => boolean;
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
  shortcutsHelpOpen: false,
  welcomeOpen: false,
  changelogOpen: false,
  reviewForWsId: null,
  broadcastForWsId: null,
  queueForWsId: null,
  sandboxForWsId: null,
  fileFinderWsId: null,
  findInFilesWsId: null,
  busyMessage: null,
  confirm: null,
  terminalDrop: null,
  pendingSandboxRestarts: new Set<string>(),
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
  openShortcutsHelp:  () => set({ shortcutsHelpOpen: true }),
  closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),
  openWelcome:       () => set({ welcomeOpen: true }),
  closeWelcome:      () => set({ welcomeOpen: false }),
  openChangelog:     () => set({ changelogOpen: true }),
  closeChangelog:    () => set({ changelogOpen: false }),
  openReview:        (wsId) => set({ reviewForWsId: wsId }),
  closeReview:       () => set({ reviewForWsId: null }),
  openBroadcast:     (wsId) => set({ broadcastForWsId: wsId }),
  closeBroadcast:    () => set({ broadcastForWsId: null }),
  openQueue:         (wsId) => set({ queueForWsId: wsId }),
  closeQueue:        () => set({ queueForWsId: null }),
  openSandbox:       (wsId) => set({ sandboxForWsId: wsId }),
  closeSandbox:      () => set({ sandboxForWsId: null }),
  openFileFinder:    (wsId) => set({ fileFinderWsId: wsId }),
  closeFileFinder:   () => set({ fileFinderWsId: null }),
  openFindInFiles:   (wsId) => set({ findInFilesWsId: wsId }),
  closeFindInFiles:  () => set({ findInFilesWsId: null }),
  setBusy:           (msg) => set({ busyMessage: msg }),
  setNotifyRoute:    (route) => set({
    notifyRoute: route ? { ...route, firedAt: Date.now() } : null,
  }),
  askConfirm: (req: any) =>
    new Promise<any>(resolve => set({ confirm: { req, resolve } })),
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
  markPendingSandboxRestart: (wsId) => set(s => {
    const next = new Set(s.pendingSandboxRestarts);
    next.add(wsId);
    return { pendingSandboxRestarts: next };
  }),
  consumePendingSandboxRestart: (wsId) => {
    const s = useUI.getState();
    if (!s.pendingSandboxRestarts.has(wsId)) return false;
    const next = new Set(s.pendingSandboxRestarts);
    next.delete(wsId);
    useUI.setState({ pendingSandboxRestarts: next });
    return true;
  },
  pushToast: (msg, kind = "success", opts) => {
    const id = crypto.randomUUID();
    set(s => ({ toasts: [...s.toasts, { id, msg, kind, action: opts?.action, ttlMs: opts?.ttlMs }] }));
    return id;
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));
