// Central dialog mount point. Each dialog is its own component reading its
// open state from useUI(), so they're cheap to add and don't pollute App.

import { useEffect } from "react";
import { useUI } from "@/store/ui";
import { settingsLoad } from "@/lib/ipc";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { QuickCreateProgressDialog } from "./QuickCreateProgressDialog";
import { CustomCommandDialog } from "./CustomCommandDialog";
import { EditCommandDialog } from "./EditCommandDialog";
import { ResumeOverrideDialog } from "./ResumeOverrideDialog";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { WelcomeDialog } from "./WelcomeDialog";
import { ChangelogDialog } from "./ChangelogDialog";
import { BroadcastDialog } from "./BroadcastDialog";
import { RaceDialog } from "./RaceDialog";
import { RaceCompare } from "@/components/task/RaceCompare";
import { TaskSandboxDialog } from "./TaskSandboxDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { TerminalDropDialog } from "./TerminalDropDialog";
import { FileFinderDialog } from "./FileFinderDialog";
import { FindInFilesDialog } from "./FindInFilesDialog";
import { ProjectPickerDialog } from "./ProjectPickerDialog";
import { CommandPalette } from "./CommandPalette";
import { PromptDestinationDialog } from "./PromptDestinationDialog";
import { PromptPalette } from "./PromptPalette";
import { Loader2 } from "lucide-react";

export function Dialogs() {
  const openWelcome = useUI(s => s.openWelcome);
  const busyMessage = useUI(s => s.busyMessage);

  // Fire the welcome wizard on first launch (no settings.welcomed flag yet).
  useEffect(() => {
    settingsLoad().then(s => { if (!s.welcomed) openWelcome(); }).catch(() => {});
  }, [openWelcome]);

  return (
    <>
      <NewProjectDialog />
      <NewTaskDialog />
      <QuickCreateProgressDialog />
      <CustomCommandDialog />
      <EditCommandDialog />
      <ResumeOverrideDialog />
      <ShortcutsHelpDialog />
      <WelcomeDialog />
      <ChangelogDialog />
      <BroadcastDialog />
      <RaceDialog />
      <RaceCompare />
      <TaskSandboxDialog />
      <ConfirmDialog />
      <TerminalDropDialog />
      <FileFinderDialog />
      <FindInFilesDialog />
      <ProjectPickerDialog />
      <CommandPalette />
      <PromptDestinationDialog />
      <PromptPalette />
      {/* Blocking work overlay: shown while a slow IPC call is in flight
          (archive task, etc.). Click-blocks the whole window so users
          don't fire the action twice mid-wait. */}
      {busyMessage && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55">
          <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] px-4 py-3 text-[13px] shadow-2xl">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent)]" />
            <span>{busyMessage}</span>
          </div>
        </div>
      )}
    </>
  );
}
