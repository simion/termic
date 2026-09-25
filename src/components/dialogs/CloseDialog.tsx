// The window close prompt: "Keep in Menu Bar" vs "Quit Termic", with
// "Don't ask again".
//
// NOT built on ConfirmDialog, deliberately. That dialog has two outcomes and
// folds dismissal into cancel (Esc -> onOpenChange(false) -> resolve(false)),
// so whichever action sat on `cancel` would also fire on Escape. Both mappings
// are wrong here: Esc must not quit and kill running agents, and Esc must not
// be the only way to reach Quit either.
//
// So this prompt has THREE outcomes, and dismissal is the harmless one:
//
//   Keep in Menu Bar  -> background, agents keep running (primary, ⏎)
//   Quit Termic       -> teardown, every agent dies (destructive)
//   Esc / click-away  -> CANCEL THE CLOSE, window stays exactly as it was
//
// Rust only emits `termic://close-requested` when close_action is unset or
// "ask", so a user who ticked "Don't ask again" never sees this.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export function CloseDialog() {
  const { t } = useTranslation("dialogs");
  const open = useUI(s => s.closePromptOpen);
  const nonce = useUI(s => s.closePromptNonce);
  const setOpen = useUI(s => s.setClosePromptOpen);
  const [checked, setChecked] = useState(false);

  // Same stacking treatment ConfirmDialog uses. A close prompt can land on top
  // of an already-open dialog (New Task open, then click the red button), and
  // without this it renders as just another card on the page - the exact way
  // people missed the "Save sandbox changes" prompt. Includes the race dialog,
  // which ConfirmDialog's list misses.
  const stacked = useUI(s =>
    s.newProjectOpen || s.newTaskProjectId !== null || s.welcomeOpen ||
    s.changelogOpen || s.broadcastForTaskId !== null ||
    s.sandboxForTaskId !== null || s.raceProjectId !== null);

  // Fresh checkbox per REQUEST, keyed on the nonce rather than on `open`: a
  // second close request while the prompt is already open leaves open
  // true->true, which an [open] effect would not see, silently carrying a
  // previous tick into a decision the user thinks is fresh.
  useEffect(() => { setChecked(false); }, [nonce]);

  if (!open) return null;

  const choose = (action: "menubar" | "quit") => {
    setOpen(false);
    void invoke("window_close_choice", { action, remember: checked });
  };

  return (
    <AppDialog
      open
      // Dismissal cancels the close outright - no IPC, nothing happens.
      onOpenChange={(v) => { if (!v) setOpen(false); }}
      title={t("closeDialog.title")}
      className={cn(
        "max-w-xl",
        stacked && "ring-2 ring-[var(--color-warn)]/70 shadow-[0_0_0_8px_rgba(245,197,66,0.12),0_25px_50px_-12px_rgba(0,0,0,0.75)]",
      )}
      // Stacked, the parent already painted the dim backdrop; a second would
      // double-dim, so use a faint warning wash instead.
      overlayClassName={stacked ? "bg-[var(--color-warn)]/12" : undefined}
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <div className="flex flex-col gap-3.5 pt-1">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-warn)]" />
          <p className="text-[14px] text-[var(--color-fg-dim)] leading-relaxed flex-1">
            {t("closeDialog.body")}
          </p>
        </div>

        <label className="ml-8 flex items-start gap-2.5 cursor-pointer select-none text-[13px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--color-border)] bg-[var(--color-bg-2)] text-[var(--color-accent)] focus:ring-0 focus:ring-offset-0 cursor-pointer shrink-0"
            data-testid="close-dont-ask"
          />
          <div className="flex flex-col gap-0.5">
            <span>{t("closeDialog.dontAskAgain")}</span>
            {/* Ticking this next to "Quit Termic" arms the red button to stop
                every agent with no confirmation, so name the way back. */}
            <span className="text-[12px] text-[var(--color-fg-dim)]/70">
              {t("closeDialog.changeLater")}
            </span>
          </div>
        </label>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          type="button"
          onClick={() => choose("quit")}
          className="text-[var(--color-err)] hover:bg-[var(--color-err)]/10"
          data-testid="close-quit"
        >
          {t("closeDialog.quit")}
        </Button>
        <Button
          variant="primary"
          type="button"
          onClick={() => choose("menubar")}
          autoFocus
          data-testid="close-menubar"
        >
          {t("closeDialog.keepInMenuBar")}
        </Button>
      </div>
    </AppDialog>
  );
}
