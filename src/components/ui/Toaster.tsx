// Bottom-right toast stack. One mount in <App/>; all transient
// success/info/warning/error feedback goes through useUI().pushToast().
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-react";
import { useUI, type Toast } from "@/store/ui";
import { cn } from "@/lib/utils";

const ICONS = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
};

const TONE = {
  success: "border-[var(--color-ok)]/40 text-[var(--color-ok)]",
  info:    "border-[var(--color-accent)]/40 text-[var(--color-accent)]",
  warning: "border-[var(--color-warn)]/40 text-[var(--color-warn)]",
  error:   "border-[var(--color-err)]/40 text-[var(--color-err)]",
};

const DEFAULT_TTL_MS = 3200;

export function Toaster() {
  const toasts = useUI(s => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[10000] flex flex-col gap-2">
      {toasts.map(t => <ToastItem key={t.id} t={t} />)}
    </div>
  );
}

function ToastItem({ t }: { t: Toast }) {
  const { t: tr } = useTranslation(); // defaultNS "common"
  const dismiss = useUI(s => s.dismissToast);
  useEffect(() => {
    if (t.sticky) return;
    const ttl = t.ttlMs ?? DEFAULT_TTL_MS;
    const h = setTimeout(() => dismiss(t.id), ttl);
    return () => clearTimeout(h);
  }, [t.id, t.ttlMs, t.sticky, dismiss]);
  const Ic = ICONS[t.kind];
  return (
    <div
      className={cn(
        // Wider ceiling for long path/URL messages; items-start so the
        // icon and action button stay aligned to the first line when
        // the message wraps to multiple lines. break-words so long
        // unbroken segments (paths, URLs) don't blow out the width.
        "pointer-events-auto flex max-w-[min(640px,calc(100vw-2rem))] items-start gap-2.5 rounded-md border bg-[var(--color-bg-1)] py-2 pl-3 pr-2 shadow-2xl",
        TONE[t.kind],
      )}
      role="status"
    >
      <Ic className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1 break-words text-[12.5px] leading-snug text-[var(--color-fg)]">{t.msg}</span>
      {t.action && (
        <button
          type="button"
          onClick={() => { t.action!.onClick(); dismiss(t.id); }}
          className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--color-fg)] hover:border-[var(--color-accent-soft)]"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismiss(t.id)}
        className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        aria-label={tr("dismiss")}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
