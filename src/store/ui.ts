// Transient UI-only store (separate from the main app store so re-renders
// triggered by opening a dialog don't churn the workspace tree).

import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Action button label. Default: "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button red when true - use for archive /
   *  delete / "ripping the cage" style actions. */
  destructive?: boolean;
}

interface UIState {
  // dialog visibility
  newProjectOpen: boolean;
  newWorkspaceProjectId: string | null;  // null = closed
  welcomeOpen: boolean;
  reviewForWsId: string | null;          // null = closed
  /** Open the Edit Sandbox dialog for a specific workspace. null = closed.
   *  Lives in UI store (not app) so flipping it doesn't churn the
   *  workspace tree on every re-render. */
  sandboxForWsId: string | null;
  /** Global "blocking work in flight" message. Shows a centered loader over
   *  the whole window so the user knows the freeze is intentional. Set for
   *  unavoidably-synchronous IPC calls like `workspace_archive` that take
   *  several seconds (git worktree remove + rm -rf). */
  busyMessage: string | null;
  /** Active confirm prompt, if any. null = nothing pending. The
   *  resolve callback fires with the user's choice when the modal
   *  closes; the ConfirmDialog component reads this and renders. */
  confirm: { req: ConfirmRequest; resolve: (ok: boolean) => void } | null;
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
  openNewWorkspace: (projectId: string) => void;
  closeNewWorkspace: () => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  openReview: (wsId: string) => void;
  closeReview: () => void;
  openSandbox: (wsId: string) => void;
  closeSandbox: () => void;
  setBusy: (msg: string | null) => void;
  /** Open the global confirm modal. Returns a Promise that resolves
   *  to true (user confirmed) or false (cancelled / dismissed). Drop-in
   *  replacement for `window.confirm()` with our own chrome + theming. */
  askConfirm: (req: ConfirmRequest) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;
  /** Mark a workspace for auto-restart on the next PTY exit. Called
   *  by the Sandbox dialog right before `workspace_set_sandbox` (the
   *  IPC that SIGKILL's the live agents). */
  markPendingSandboxRestart: (wsId: string) => void;
  /** Pop the marker — TerminalPane calls this after consuming a
   *  pending restart so a SUBSEQUENT real exit shows the overlay. */
  consumePendingSandboxRestart: (wsId: string) => boolean;
  /** Push a transient toast. Returns its id (so callers can dismiss
   *  early if needed). Auto-dismiss is handled by <Toaster/>. */
  pushToast: (msg: string, kind?: ToastKind) => string;
  dismissToast: (id: string) => void;
}

export type ToastKind = "success" | "info" | "error";
export interface Toast {
  id: string;
  msg: string;
  kind: ToastKind;
}

export const useUI = create<UIState>(set => ({
  newProjectOpen: false,
  newWorkspaceProjectId: null,
  welcomeOpen: false,
  reviewForWsId: null,
  sandboxForWsId: null,
  busyMessage: null,
  confirm: null,
  pendingSandboxRestarts: new Set<string>(),
  toasts: [],

  openNewProject:    () => set({ newProjectOpen: true }),
  closeNewProject:   () => set({ newProjectOpen: false }),
  openNewWorkspace:  (projectId) => set({ newWorkspaceProjectId: projectId }),
  closeNewWorkspace: () => set({ newWorkspaceProjectId: null }),
  openWelcome:       () => set({ welcomeOpen: true }),
  closeWelcome:      () => set({ welcomeOpen: false }),
  openReview:        (wsId) => set({ reviewForWsId: wsId }),
  closeReview:       () => set({ reviewForWsId: null }),
  openSandbox:       (wsId) => set({ sandboxForWsId: wsId }),
  closeSandbox:      () => set({ sandboxForWsId: null }),
  setBusy:           (msg) => set({ busyMessage: msg }),
  askConfirm: (req) =>
    new Promise<boolean>(resolve => set({ confirm: { req, resolve } })),
  resolveConfirm: (ok) => {
    const c = useUI.getState().confirm;
    if (c) c.resolve(ok);
    set({ confirm: null });
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
  pushToast: (msg, kind = "success") => {
    const id = crypto.randomUUID();
    set(s => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    return id;
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));
