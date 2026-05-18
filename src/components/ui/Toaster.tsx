// Bottom-right toast stack. One mount in <App/>; all transient
// success/info/error feedback goes through useUI().pushToast().
import { useEffect } from "react";
import { CheckCircle2, Info, XCircle, X } from "lucide-react";
import { useUI, type Toast } from "@/store/ui";
import { cn } from "@/lib/utils";

const ICONS = {
  success: CheckCircle2,
  info: Info,
  error: XCircle,
};

const TONE = {
  success: "border-[var(--color-ok)]/40 text-[var(--color-ok)]",
  info:    "border-[var(--color-accent)]/40 text-[var(--color-accent)]",
  error:   "border-[var(--color-err)]/40 text-[var(--color-err)]",
};

const TTL_MS = 3200;

export function Toaster() {
  const toasts = useUI(s => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[10000] flex flex-col gap-2">
      {toasts.map(t => <ToastItem key={t.id} t={t} />)}
    </div>
  );
}

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useUI(s => s.dismissToast);
  useEffect(() => {
    const h = setTimeout(() => dismiss(t.id), TTL_MS);
    return () => clearTimeout(h);
  }, [t.id, dismiss]);
  const Ic = ICONS[t.kind];
  return (
    <div
      className={cn(
        "pointer-events-auto flex max-w-[360px] items-center gap-2.5 rounded-md border bg-[var(--color-bg-1)] py-2 pl-3 pr-2 shadow-2xl",
        TONE[t.kind],
      )}
      role="status"
    >
      <Ic className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-[12.5px] text-[var(--color-fg)]">{t.msg}</span>
      <button
        type="button"
        onClick={() => dismiss(t.id)}
        className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
