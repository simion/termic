// Global confirm modal. Driven by useUI().askConfirm({...}) which
// returns a Promise<boolean> (or { confirmed, checked } if a checkbox was requested),
// drop-in replacement for window.confirm() with our own chrome + theming + a clear "destructive" red variant.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export function ConfirmDialog() {
  const { t } = useTranslation("dialogs");
  const confirm = useUI(s => s.confirm);
  const resolve = useUI(s => s.resolveConfirm);

  const newProjectOpen = useUI(s => s.newProjectOpen);
  const newTaskProjectId = useUI(s => s.newTaskProjectId);
  const welcomeOpen = useUI(s => s.welcomeOpen);
  const changelogOpen = useUI(s => s.changelogOpen);
  const broadcastForTaskId = useUI(s => s.broadcastForTaskId);
  const sandboxForTaskId = useUI(s => s.sandboxForTaskId);

  const isAnotherDialogOpen =
    newProjectOpen ||
    newTaskProjectId !== null ||
    welcomeOpen ||
    changelogOpen ||
    broadcastForTaskId !== null ||
    sandboxForTaskId !== null;

  const [checked, setChecked] = useState(false);
  // Second, independent checkbox: "Show this every time", ticked by default.
  // Framed positively (issue #102) because the confirms that carry it guard
  // recoverable actions: unticking is the deliberate one-time act, and the
  // state on screen matches the setting it writes ("Confirm before archiving"
  // in Settings > Tasks), which "Don't ask again" inverted every time.
  const [showEveryTime, setShowEveryTime] = useState(true);

  useEffect(() => {
    if (confirm?.req?.checkbox) {
      setChecked(!!confirm.req.checkbox.defaultValue);
    } else {
      setChecked(false);
    }
    setShowEveryTime(true);
  }, [confirm]);

  // ⏎ confirms, Esc cancels. Esc is already handled by Radix Dialog's
  // onOpenChange (false), but the Enter handler is ours.
  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        resolve(true, checked, !showEveryTime);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, resolve, checked, showEveryTime]);

  if (!confirm) return null;
  const { req } = confirm;
  const destructive = !!req.destructive;

  return (
    <AppDialog
      open
      onOpenChange={(v) => { if (!v) resolve(false, checked, !showEveryTime); }}
      title={req.title}
      // Stacked confirms (popping on top of an open dialog) ALSO get a
      // warm warning ring + soft outer glow so they don't blend into
      // the parent dialog's chrome. The user kept missing the
      // "Save sandbox changes" prompt because the prior transparent
      // overlay rendered it as just another card on the page.
      className={cn(
        "max-w-xl",
        isAnotherDialogOpen && "ring-2 ring-[var(--color-warn)]/70 shadow-[0_0_0_8px_rgba(245,197,66,0.12),0_25px_50px_-12px_rgba(0,0,0,0.75)]",
      )}
      // When stacked, the parent dialog already painted the 65% black
      // backdrop — a second one would double-dim. Use a faint warning
      // wash instead so the layering reads as "this is a different,
      // more urgent prompt" rather than "another card in the same flow."
      overlayClassName={isAnotherDialogOpen ? "bg-[var(--color-warn)]/12" : undefined}
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <div className="flex flex-col gap-3.5 pt-1">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className={
              "mt-0.5 h-5 w-5 shrink-0 " +
              (destructive ? "text-[var(--color-err)]" : "text-[var(--color-warn)]")
            }
          />
          <p className="text-[14px] text-[var(--color-fg-dim)] leading-relaxed flex-1">
            {req.message}
          </p>
        </div>

        {req.checkbox && (
          <label className="ml-8 flex items-start gap-2.5 cursor-pointer select-none text-[13px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--color-border)] bg-[var(--color-bg-2)] text-[var(--color-accent)] focus:ring-0 focus:ring-offset-0 cursor-pointer shrink-0"
              data-testid="confirm-checkbox"
            />
            <div className="flex flex-col gap-1.5">
              <span>{req.checkbox.label}</span>
              {req.checkbox.branchName && (
                <code className="text-[13.5px] font-semibold font-mono text-[var(--color-accent)] bg-[var(--color-bg-2)] border border-[var(--color-border-soft)] px-2.5 py-0.5 rounded max-w-full break-all whitespace-pre-wrap select-text tracking-wide">
                  {req.checkbox.branchName}
                </code>
              )}
            </div>
          </label>
        )}

        {req.dontAskAgain && (
          <label className="ml-8 flex items-start gap-2.5 cursor-pointer select-none text-[13px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={showEveryTime}
              onChange={(e) => setShowEveryTime(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--color-border)] bg-[var(--color-bg-2)] text-[var(--color-accent)] focus:ring-0 focus:ring-offset-0 cursor-pointer shrink-0"
              data-testid="confirm-show-every-time"
            />
            <div className="flex flex-col gap-0.5">
              <span>{t("confirm.showEveryTime")}</span>
              {/* Unticking this runs the action with no confirmation from
                  here on, so name the way back. */}
              <span className="text-[12px] text-[var(--color-fg-dim)]/70">
                {t("confirm.showEveryTimeHint")}
              </span>
            </div>
          </label>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" type="button" onClick={() => resolve(false, checked, !showEveryTime)} data-testid="confirm-cancel">
          {req.cancelLabel ?? t("common:cancel")}
        </Button>
        <Button
          variant="primary"
          type="button"
          onClick={() => resolve(true, checked, !showEveryTime)}
          data-testid="confirm-ok"
          // Override accent → red for destructive actions so the
          // user has a visual "this is irreversible" before they click.
          className={
            destructive
              ? "bg-[var(--color-err)] border-[var(--color-err)] hover:brightness-110"
              : ""
          }
          autoFocus
        >
          {req.confirmLabel ?? t("common:confirm")}
        </Button>
      </div>
    </AppDialog>
  );
}
