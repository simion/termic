// "Allow · <scope> ▾" on every blocked row of Activity. The face acts on
// `scope` (Activity's default, when one is set); the caret opens the scopes
// valid for this row kind and allows on the one picked, without changing
// the default, so it is how an exception is made. With no scope the face
// opens the menu instead of guessing. Once allowed it turns into a green
// "✓ Allowed · <scope>" that undoes on a click.

import { useState } from "react";
import { Check, ChevronDown, Undo2 } from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel } from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";

/** `short` is what the button reads after "Allow ·" ("this project"). */
export type ScopeOption<T extends string> = { id: T; label: string; short?: string; hint: string };

export function AllowSplitButton<T extends string>({ allow, heading, options, scope, onAllow, busy, disabled, title, testId, allowed, allowedLabel, undoLabel, onUndo }: {
  /** "Allow" */
  allow: string;
  /** above the menu's options, e.g. "Allow this request for" */
  heading: string;
  options: ScopeOption<T>[];
  scope: T | null;
  onAllow: (scope: T) => void;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  testId?: string;
  /** the scope this row was allowed on, here: the button becomes its undo. */
  allowed?: T | null;
  /** "Allowed" */
  allowedLabel?: string;
  /** "Undo" */
  undoLabel?: string;
  onUndo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.id === scope);
  if (allowed && onUndo) {
    const was = options.find(o => o.id === allowed);
    return (
      <button
        type="button"
        data-testid={testId}
        data-allowed={allowed}
        disabled={busy}
        onClick={onUndo}
        title={undoLabel}
        className="group inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-[var(--color-ok)]/50 bg-[var(--color-ok)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-ok)] hover:border-[var(--color-warn)]/50 hover:bg-[var(--color-warn)]/10 hover:text-[var(--color-warn)] disabled:opacity-50"
      >
        <Check className="h-3 w-3 group-hover:hidden" />
        <Undo2 className="hidden h-3 w-3 group-hover:block" />
        {busy ? "…" : (<>
          <span className="group-hover:hidden">{allowedLabel} · {was?.short ?? was?.label ?? allowed}</span>
          <span className="hidden group-hover:inline">{undoLabel}</span>
        </>)}
      </button>
    );
  }
  const btn = "px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] hover:bg-[var(--color-ok)]/10 hover:text-[var(--color-ok)] disabled:opacity-50";
  return (
    <DropdownRoot open={open} onOpenChange={setOpen}>
      <span className="inline-flex shrink-0 items-stretch overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg-2)]">
        <button
          type="button"
          data-testid={testId}
          data-scope={scope ?? undefined}
          disabled={busy || disabled}
          title={title}
          onClick={() => (current ? onAllow(current.id) : setOpen(true))}
          className={cn(btn, "whitespace-nowrap")}
        >
          {busy ? "…" : current ? `${allow} · ${current.short ?? current.label}` : `${allow}…`}
        </button>
        <DropdownTrigger asChild>
          <button
            type="button"
            data-testid={testId ? `${testId}-scope` : undefined}
            disabled={busy || disabled}
            aria-label={heading}
            className={cn(btn, "border-l border-[var(--color-border)] px-1")}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownTrigger>
      </span>
      <DropdownMenu align="end">
        <div data-testid="allow-scope-menu" className="max-w-[300px]">
          <DropdownLabel>{heading}</DropdownLabel>
          {options.map(o => (
            <DropdownItem key={o.id} data-scope-option={o.id} data-checked={o.id === scope || undefined} onSelect={() => onAllow(o.id)}
              className={cn(o.id === scope && "bg-[var(--color-accent)]/10")}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[12.5px]">{o.label}</span>
                <span className="text-[11px] leading-snug text-[var(--color-fg-faint)]">{o.hint}</span>
              </span>
            </DropdownItem>
          ))}
        </div>
      </DropdownMenu>
    </DropdownRoot>
  );
}
