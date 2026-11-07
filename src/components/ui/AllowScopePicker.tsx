// "where does Allow save to" for the footer popovers (sandbox denies, secrets
// blocks). Collapsed it is one "Saving to X · Change" row; expanded it is a
// radio list, one option per line with a hint. Stays expanded while nothing
// is chosen, since an Allow with no scope has nowhere to go.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type ScopeOption<T extends string> = { id: T; label: string; hint: string };

export function AllowScopePicker<T extends string>({ options, value, onChange, heading, savingTo, change, changeTip, testId }: {
  options: ScopeOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  /** above the radio list, e.g. "Save allowed paths to:" */
  heading: string;
  /** collapsed row prefix, e.g. "Saving to" */
  savingTo: string;
  change: string;
  changeTip: string;
  testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const chosen = value !== null;
  const expanded = !chosen || editing;
  return (
    <div data-testid={testId} className={cn(
      "rounded-md border px-2 py-1.5",
      chosen ? "border-[var(--color-border-soft)]" : "border-[var(--color-warn)]/60",
    )}>
      {expanded ? (<>
        <div className={cn(
          "mb-1 flex items-center gap-1.5 text-[11px]",
          chosen ? "text-[var(--color-fg-faint)]" : "font-medium text-[var(--color-warn)]",
        )}>
          <span>{heading}</span>
        </div>
        <div className="flex flex-col gap-0.5" role="radiogroup" aria-label={heading}>
          {options.map(s => {
            const active = value === s.id;
            return (
              <button
                key={s.id}
                type="button"
                data-scope-option={s.id}
                role="radio"
                aria-checked={active}
                onClick={() => { onChange(s.id); setEditing(false); }}
                className={cn(
                  "flex items-center gap-2 rounded px-1.5 py-1 text-left",
                  active ? "bg-[var(--color-accent)]/10" : "hover:bg-[var(--color-hover)]",
                )}
              >
                <span className={cn(
                  "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                  active ? "border-[var(--color-accent)]" : "border-[var(--color-border)]",
                )}>
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />}
                </span>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className={cn("shrink-0 text-[12px] font-medium", active ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]")}>{s.label}</span>
                  <span className="truncate text-[11px] text-[var(--color-fg-faint)]">{s.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </>) : (
        <button
          type="button"
          data-testid={testId ? `${testId}-change` : undefined}
          onClick={() => setEditing(true)}
          className="flex w-full items-center gap-1.5 rounded text-left text-[11px] text-[var(--color-fg-faint)] transition-colors hover:text-[var(--color-fg-dim)]"
          title={changeTip}
        >
          <span>{savingTo}</span>
          <span className="font-medium text-[var(--color-fg-dim)]">{options.find(s => s.id === value)?.label}</span>
          <span className="ml-auto inline-flex items-center gap-0.5 text-[var(--color-fg-faint)]">
            {change}
            <ChevronDown className="h-3 w-3" />
          </span>
        </button>
      )}
    </div>
  );
}
