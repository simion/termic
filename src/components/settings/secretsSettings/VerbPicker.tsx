// A rule row's methods: a button showing the chosen verbs that opens a
// popover of the verbs this block's requests can have, plus a field for any
// other verb.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/Popover";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { type BlockKind, normaliseVerb, toggleVerb, verbGroups } from "./model";
import { Eyebrow } from "./parts";

export function VerbPicker({ kind, methods, onChange }: { kind: BlockKind; methods: string[]; onChange: (m: string[]) => void }) {
  const { t } = useTranslation("secrets");
  const [custom, setCustom] = useState("");
  const [bad, setBad] = useState(false);
  const groups = verbGroups(kind);
  const known = new Set(groups.flatMap(g => g.verbs));
  const extra = methods.filter(m => !known.has(m) && m !== "*");
  const add = () => {
    const v = normaliseVerb(custom);
    if (!v) { setBad(true); return; }
    if (!methods.includes(v)) onChange(toggleVerb(methods, v));
    setCustom("");
    setBad(false);
  };
  const opt = (v: string, label = v) => (
    <button
      key={v}
      type="button"
      data-verb={v}
      aria-pressed={methods.includes(v)}
      onClick={() => onChange(toggleVerb(methods, v))}
      className={cn(
        "rounded border px-2 py-0.5 font-mono text-[11.5px]",
        methods.includes(v)
          ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
          : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
      )}
    >
      {label}
    </button>
  );
  return (
    <PopoverRoot onOpenChange={o => { if (!o) { setCustom(""); setBad(false); } }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-field="methods"
          aria-label={t("manage.editor.methods")}
          title={methods.join(", ")}
          className="flex h-8 w-40 shrink-0 items-center gap-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 text-left hover:border-[var(--color-fg-faint)]"
        >
          {methods.map(m => (
            <span key={m} className={cn("shrink-0 rounded px-1.5 font-mono text-[11.5px]", known.has(m) || m === "*" ? "bg-[var(--color-bg-2)]" : "bg-[var(--color-accent-soft)]")}>{m}</span>
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-72">
        <div data-testid="verb-picker" className="flex flex-col gap-2.5">
          {groups.map(g => (
            <div key={g.label} className="flex flex-col gap-1">
              <Eyebrow className="text-[10px]">
                {t(g.label === "git" ? "manage.editor.verbs.git" : g.label === "graphql" ? "manage.editor.verbs.graphql" : "manage.editor.verbs.http")}
              </Eyebrow>
              <div className="flex flex-wrap gap-1">{g.verbs.map(v => opt(v))}</div>
            </div>
          ))}
          {kind !== "git" && (
            <div className="flex flex-col gap-1">
              <Eyebrow className="text-[10px]">{t("manage.editor.verbs.any")}</Eyebrow>
              <div className="flex flex-wrap gap-1">{opt("*", t("manage.editor.verbs.anyHttp"))}</div>
            </div>
          )}
          <Input
            data-testid="verb-custom"
            aria-label={t("manage.editor.verbs.custom")}
            aria-invalid={bad || undefined}
            value={custom}
            placeholder={t("manage.editor.verbs.custom")}
            onChange={e => { setCustom(e.target.value); setBad(false); }}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            className={cn("h-8 font-mono text-[12px]", bad && "border-[var(--color-err)]")}
          />
          {bad && <span className="text-[11.5px] text-[var(--color-err)]">{t("manage.editor.verbs.badVerb")}</span>}
          {extra.length > 0 && <div className="flex flex-wrap gap-1">{extra.map(v => opt(v, `${v} ✕`))}</div>}
          <span className="text-[11.5px] text-[var(--color-fg-faint)]">{t(kind === "git" ? "manage.editor.verbs.hintGit" : kind === "api" ? "manage.editor.verbs.hintApi" : "manage.editor.verbs.hintHttp")}</span>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
