// Transient UI-only store (separate from the main app store so re-renders
// triggered by opening a dialog don't churn the workspace tree).

import { create } from "zustand";

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
}

export const useUI = create<UIState>(set => ({
  newProjectOpen: false,
  newWorkspaceProjectId: null,
  welcomeOpen: false,
  reviewForWsId: null,
  sandboxForWsId: null,
  busyMessage: null,

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
}));
