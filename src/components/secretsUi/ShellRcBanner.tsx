// Strip at the top of a shell running a role, shown once gh sent its own
// token instead of this shell's placeholder: an rc file (often ~/.zshrc)
// exported GH_TOKEN after Termic did, so this shell is using a token Termic
// does not manage. A clobbered HTTPS_PROXY cannot be seen, so only this.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Copy, X } from "lucide-react";
import { shellBrokerKey } from "@/lib/ipc";
import { copyToClipboard } from "@/lib/clipboard";
import { useShellCounts } from "@/lib/shellCounts";
import { useApp } from "@/store/app";

/** What "Copy a fix" puts on the clipboard: skip the export in a shell that
 *  runs a role. */
export const RC_FIX = `# Termic: keep a shell's Secrets role in charge of GH_TOKEN
if [ -z "$TERMIC_SECRETS_ROLE" ]; then
  export GH_TOKEN=...   # your existing line
fi
`;

export function ShellRcBanner({ taskId, tabId, active }: { taskId: string; tabId: string; active: boolean }) {
  const { t } = useTranslation("secrets");
  const visible = useApp(s => s.activeTaskId === taskId) && active;
  const counts = useShellCounts(visible ? shellBrokerKey(taskId, tabId) : null);
  // dismissed up to a count: a later foreign token brings it back.
  const [dismissedAt, setDismissedAt] = useState(0);
  const n = counts?.foreign_token ?? 0;
  // a new shell in the tab counts from zero (pty_kill forgets the old one's
  // events), so a dismissal never outlives the shell it was made in.
  if (counts && n < dismissedAt) setDismissedAt(0);
  if (n <= dismissedAt) return null;
  const btn = "flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2.5 py-1 text-[12px] font-medium hover:border-[var(--color-accent)] hover:bg-[var(--color-hover)]";
  return (
    <div
      data-testid="shell-rc-banner"
      style={{ background: "color-mix(in srgb, var(--color-warn) 14%, var(--color-bg-1))" }}
      className="flex shrink-0 items-start justify-between gap-3 px-3 py-1.5"
    >
      <span className="flex min-w-0 items-start gap-1.5 text-[12.5px] text-[var(--color-fg)]">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
        <span>{t("shell.rcBanner")}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <button type="button" data-testid="shell-rc-copy" className={btn} onClick={() => void copyToClipboard(RC_FIX, t("shell.rcFixLabel"))}>
          <Copy className="h-3.5 w-3.5" /> {t("shell.rcCopy")}
        </button>
        <button type="button" data-testid="shell-rc-dismiss" aria-label={t("shell.rcDismiss")} title={t("shell.rcDismiss")}
          className="rounded p-1 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)]" onClick={() => setDismissedAt(n)}>
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}
