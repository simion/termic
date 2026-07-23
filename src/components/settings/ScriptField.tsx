// A labelled multiline script field (setup / run / archive). Shared by the
// Repository settings page and the Run configuration dialog.

import React from "react";
import { cn } from "@/lib/utils";

export function ScriptField({ label, hint, value, onChange, placeholder, flash, rows = 2 }: {
  label: string;
  hint: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** When true (set by the parent for ~2s after a successful save of this
   *  field), the textarea gets a soft green ring. */
  flash?: boolean;
  rows?: number;
}) {
  return (
    <div>
      <div className="text-[13.5px] font-medium">{label}</div>
      <div className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">{hint}</div>
      <textarea
        value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className={cn(
          "mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]",
          "transition-colors",
          flash && "!border-[var(--color-ok)] focus:!border-[var(--color-ok)]",
        )}
      />
    </div>
  );
}
