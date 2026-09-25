// "Close this scratchpad?" — the three-way prompt (GH #244).
//
// Quitting keeps your pads; closing ONE asks. That reads as a contradiction
// until you hold the rule: a pad is an unsaved buffer that happens to survive
// restarts, so persistence covers the relaunch case, never the explicit close.
//
// NOT built on ConfirmDialog, for the same reason CloseDialog isn't: that
// dialog has two outcomes and folds dismissal into cancel. Here there are
// three, and dismissal is the harmless one:
//
//   Save…    -> open the promote picker; the tab closes only if that goes through
//   Discard  -> delete the pad for good (destructive)
//   Esc / click-away / Cancel -> keep the tab AND the pad exactly as they were

import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { AlertTriangle } from "lucide-react";

export function ScratchCloseDialog() {
  const { t } = useTranslation("dialogs");
  const req = useUI(s => s.scratchClose);
  const resolve = useUI(s => s.resolveScratchClose);
  if (!req) return null;

  return (
    <AppDialog
      open
      onOpenChange={(v) => { if (!v) resolve("cancel"); }}
      title={t("scratchClose.title")}
      className="max-w-xl"
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <div className="flex items-start gap-3 pt-1">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-warn)]" />
        <p className="flex-1 text-[14px] leading-relaxed text-[var(--color-fg-dim)]">
          {/* Name what Discard costs in the copy, because the pad has never
              been written anywhere the user chose and there is no file to go
              looking for afterwards. */}
          {t("scratchClose.body", { title: req.title })}
        </p>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" type="button" onClick={() => resolve("cancel")} data-testid="scratch-close-cancel">
          {t("common:cancel")}
        </Button>
        <Button
          variant="ghost"
          type="button"
          onClick={() => resolve("discard")}
          data-testid="scratch-close-discard"
          className="text-[var(--color-err)] hover:bg-[var(--color-err)]/12"
        >
          {t("scratchClose.discard")}
        </Button>
        <Button variant="primary" type="button" onClick={() => resolve("save")} data-testid="scratch-close-save" autoFocus>
          {t("scratchClose.saveDots")}
        </Button>
      </div>
    </AppDialog>
  );
}
