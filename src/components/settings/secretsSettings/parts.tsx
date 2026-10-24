// Small pieces shared by the Secrets screens and the role pickers.

import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { roleColourVar } from "./model";

/** The role's colour dot. `null` draws the dashed "No secrets" ring. */
export function RoleDot({ colour, className }: { colour: string | null; className?: string }) {
  if (colour === null) {
    return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-[var(--color-fg-faint)]", className)} />;
  }
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} style={{ background: roleColourVar(colour) }} />;
}

/** A text input that edits locally and commits on blur or Enter. Settings
 *  round-trips the whole file per save, so a write per keystroke is waste,
 *  and a parsed field ("GET, POST") would eat the comma being typed. Follows
 *  `value` whenever it is not focused, so a reorder or reload shows through. */
export function CommitInput({ value, onCommit, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  /** Return false to refuse the edit: the field goes back to `value`. */
  value: string; onCommit: (v: string) => void | boolean;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const commit = () => { if (draft !== value && onCommit(draft) === false) setDraft(value); };
  return (
    <Input
      {...rest}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={e => { if (e.key === "Enter") commit(); }}
      className={className}
    />
  );
}

/** Host chips with remove buttons and an add field. Refuses to drop the last
 *  host: a secret with no host can never be sent anywhere, and secrets.rs
 *  rejects it on save. */
export function HostChips({ hosts, onChange, testid }: { hosts: string[]; onChange: (h: string[]) => void; testid?: string }) {
  const { t } = useTranslation("secrets");
  const [adding, setAdding] = useState("");
  const add = () => {
    const h = adding.trim().toLowerCase();
    if (h && !hosts.includes(h)) onChange([...hosts, h]);
    setAdding("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testid}>
      {hosts.map(h => (
        <span key={h} data-host={h} className="inline-flex items-center gap-1 rounded-full border border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 py-0.5 pl-2.5 pr-1 font-mono text-[12px] text-[var(--color-fg)]">
          {h}
          <button
            type="button"
            aria-label={t("manage.secrets.row.removeHost", { host: h })}
            title={hosts.length === 1 ? t("manage.secrets.row.lastHost") : t("manage.secrets.row.removeHost", { host: h })}
            disabled={hosts.length === 1}
            onClick={() => onChange(hosts.filter(x => x !== h))}
            className="rounded-full p-0.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)] disabled:opacity-40"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <Input
          value={adding}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={t("manage.secrets.row.addHost")}
          data-testid={testid ? `${testid}-input` : undefined}
          className="h-7 w-40 rounded-full px-2.5 font-mono text-[12px]"
        />
        <button
          type="button"
          aria-label={t("manage.secrets.row.addHost")}
          onClick={add}
          data-testid={testid ? `${testid}-add` : undefined}
          className="rounded-full p-1 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

/** Underline tab strip, the same look as the project page's sub-tabs. */
export function TabStrip<T extends string>({ tabs, value, onChange, attr }: {
  tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void; attr: string;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)]">
      {tabs.map(th => (
        <button
          key={th.id}
          type="button"
          {...{ [attr]: th.id }}
          onClick={() => onChange(th.id)}
          className={cn(
            "relative -mb-px px-3 py-2 text-[13px] font-medium transition-colors",
            value === th.id ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
          )}
        >
          {th.label}
          {value === th.id && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]" />}
        </button>
      ))}
    </div>
  );
}

/** 11.5px uppercase label over a group, as in the mocks. */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("text-[11.5px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]", className)}>{children}</div>;
}
