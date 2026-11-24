// The pieces Settings > Remote control and Servers are built from (phones, paired
// computers, servers), so the three read as one page: a Card with its icon,
// title, one-line lead and action; device rows inside it; an empty state.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export const inline = "h-8 rounded-md border border-transparent bg-transparent px-1.5 outline-none hover:border-[var(--color-border-soft)] focus:border-[var(--color-accent)]/50 focus:bg-[var(--color-bg)]";

/** One area of the page: what it is and its action on top, its list, then
 *  an optional footer (the switch that governs it). */
export function Card({ icon, title, lead, action, footer, children }: {
  icon: React.ReactNode; title: string; lead: React.ReactNode; action: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
      <header className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-hover)] text-[var(--color-fg-dim)]">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium leading-8">{title}</div>
          <div className="text-[12.5px] text-[var(--color-fg-dim)]">{lead}</div>
        </div>
        <div className="pt-0.5">{action}</div>
      </header>
      <div className="px-2 pb-2">{children}</div>
      {footer && <div className="border-t border-[var(--color-border-soft)] px-4 py-3">{footer}</div>}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-2 mb-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-3 text-center text-[12.5px] text-[var(--color-fg-faint)]">
      {children}
    </div>
  );
}

/** A device in a list: its icon with a status dot, a renameable name, the
 *  status line under it, and its actions on the right. */
export function DeviceRow({ testId, dataState, icon, dot, name, onRename, renameLabel, renameTestId, placeholder, status, detail, actions }: {
  testId: string; dataState: Record<string, string>; icon: React.ReactNode; dot: string; name: string;
  onRename: (next: string) => Promise<void>; renameLabel: string; renameTestId?: string; placeholder?: string;
  status: React.ReactNode; detail?: React.ReactNode; actions: React.ReactNode;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => { setDraft(name); }, [name]);
  async function save() {
    const next = draft.trim();
    if (!next || next === name) { setDraft(name); return; }
    await onRename(next);
  }
  return (
    <div data-testid={testId} {...dataState} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] text-[var(--color-fg-dim)]">
        {icon}
        <span aria-hidden className={cn("absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-bg-1)]", dot)} />
      </span>
      <div className="min-w-0 flex-1">
        <input
          aria-label={renameLabel}
          data-testid={renameTestId}
          placeholder={placeholder}
          value={draft}
          maxLength={60}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={e => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { e.stopPropagation(); setDraft(name); }
          }}
          className={cn(inline, "w-full text-[14px] font-medium text-[var(--color-fg)]")}
        />
        <div className="truncate px-1.5 text-[12px] text-[var(--color-fg-faint)]">{status}</div>
        {detail}
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  );
}

