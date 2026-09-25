import { useTranslation } from "react-i18next";
import { Copy, Fingerprint, Play, X } from "lucide-react";
import * as ipc from "@/lib/ipc";
import { copyToClipboard } from "@/lib/clipboard";
import { i18n } from "@/lib/i18n";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";

// "Enable Touch ID for sudo?" strip, shown while a terminal sits at a sudo
// password prompt (Rust decides that, see sudo_touchid.rs). Same shape and
// same three answers as iTerm2's offer, and the same transparency: nothing is
// elevated behind the user's back. "Run in new tab" types the script's path
// into a fresh shell, where it prints its own source and then asks sudo for
// the password; "Copy command" hands over the exact line to run anywhere.
//
// Every button also dismisses the strip for this sudo prompt. Rust only
// re-raises it on the next prompt.
export function SudoTouchIdBanner({ taskId, onDismiss }: {
  /** The task the install tab opens in. Without one, only Copy is offered. */
  taskId?: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("task");
  const run = async () => {
    onDismiss();
    if (!taskId) return;
    try {
      const { path } = await ipc.sudoTouchIdScript();
      openTouchIdInstallTab(taskId, path);
    } catch (e) {
      useUI.getState().pushToast(t("sudoTouchId.prepareFailed", { error: String(e) }), "error");
    }
  };
  const copy = async () => {
    onDismiss();
    try {
      const { command } = await ipc.sudoTouchIdScript();
      await copyToClipboard(command, "command");
    } catch (e) {
      useUI.getState().pushToast(t("sudoTouchId.prepareFailed", { error: String(e) }), "error");
    }
  };
  const never = () => {
    onDismiss();
    usePrefs.getState().setOfferTouchIdForSudo(false);
    useUI.getState().pushToast(t("sudoTouchId.neverToast"), "info");
  };

  const btn = "flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2.5 py-1 text-[12px] font-medium hover:border-[var(--color-accent)] hover:bg-[var(--color-hover)]";
  return (
    <div
      data-testid="sudo-touchid-banner"
      style={{ background: "color-mix(in srgb, var(--color-accent) 12%, var(--color-bg-1))" }}
      className="flex shrink-0 items-center justify-between gap-3 px-3 py-1.5"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-fg)]">
        <Fingerprint className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
        <span className="truncate">{t("sudoTouchId.offer")}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {taskId && (
          <button type="button" onClick={run} className={`${btn} text-[var(--color-fg)]`} data-testid="sudo-touchid-run">
            <Play className="h-3.5 w-3.5" /> {t("sudoTouchId.runInNewTab")}
          </button>
        )}
        <button type="button" onClick={copy} className={`${btn} text-[var(--color-fg)]`} data-testid="sudo-touchid-copy">
          <Copy className="h-3.5 w-3.5" /> {t("sudoTouchId.copyCommand")}
        </button>
        <button type="button" onClick={never} className={`${btn} text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]`} data-testid="sudo-touchid-never">
          {t("sudoTouchId.dontAskAgain")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common:dismiss")}
          className="rounded p-1 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          data-testid="sudo-touchid-dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

/** A plain shell tab with the script's path typed at its prompt. A shell
 *  rather than a custom-command tab so the output stays on screen after the
 *  script exits, and so nothing re-runs it: main-panel shells are not
 *  restored on relaunch, and `sudoTouchIdInstall` is never persisted. */
function openTouchIdInstallTab(taskId: string, path: string) {
  useApp.getState().addTabToActivePane(taskId, {
    id: crypto.randomUUID(),
    type: "terminal",
    title: i18n.t("task:sudoTouchId.tabTitle"),
    cli: "shell",
    sudoTouchIdInstall: `'${path.replace(/'/g, `'\\''`)}'\r`,
  });
}
