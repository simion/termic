// New role: pick a starter, a name and the secrets it uses. Creates a role on
// checkboxes (simpleRole.ts), so it opens in the Simple tab.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { Role, SecretDef } from "@/lib/types";
import { i18n } from "@/lib/i18n";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { hostConflicts } from "./model";
import { Eyebrow, RoleDot } from "./parts";
import { CAPS, STARTERS, roleFromStarter, type StarterId } from "./simpleRole";

export function NewRolePanel({ secrets, roles, onCreate, onJson, onClose }: {
  secrets: SecretDef[]; roles: Role[];
  onCreate: (r: Role) => void; onJson: () => void; onClose: () => void;
}) {
  const { t } = useTranslation("secrets");
  const title = (id: StarterId) => t(`manage.starter.${id}.title`);
  const firstGh = secrets.find(s => s.recipe === "github");
  const [starter, setStarter] = useState<StarterId>("reviewer");
  const [name, setName] = useState(title("reviewer"));
  const [touched, setTouched] = useState(false);
  const [uses, setUses] = useState<string[]>(firstGh ? [firstGh.id] : []);
  const conflicts = hostConflicts(uses, secrets);
  const st = STARTERS.find(x => x.id === starter)!;

  function pick(id: StarterId) {
    setStarter(id);
    if (!touched) setName(id === "empty" ? t("manage.starter.emptyName") : title(id));
    if (id === "model") setUses(secrets.filter(s => s.recipe === "api_key").slice(0, 1).map(s => s.id));
  }

  function create() {
    // i18n.t, not the hook's t: names, descriptions and rule notes are
    // stored data, minted once in the current language (docs/i18n.md).
    const base = name.trim();
    let n = 2, unique = base;
    while (roles.some(r => r.name === unique)) unique = `${base} ${n++}`;
    onCreate(roleFromStarter(starter, {
      id: crypto.randomUUID(), name: unique, secrets: uses,
      description: st.empty ? "" : i18n.t(`secrets:manage.starter.${starter}.desc`),
    }, secrets, roles.map(r => r.colour), k => i18n.t(`secrets:${k}`)));
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] p-5" data-testid="new-role">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-medium">{t("manage.newRole.heading")}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onJson} data-testid="new-role-json">{t("manage.newRole.pasteJson")}</Button>
        <button type="button" aria-label={t("manage.newRole.close")} onClick={onClose} className="rounded p-1 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {STARTERS.map(s => (
          <button
            key={s.id}
            type="button"
            data-starter={s.id}
            aria-pressed={starter === s.id}
            onClick={() => pick(s.id)}
            className={cn(
              "flex flex-col gap-1 rounded-lg border p-3 text-left",
              starter === s.id ? "border-[var(--color-accent)] bg-[var(--color-bg-2)]" : "border-[var(--color-border-soft)] hover:border-[var(--color-border)]",
            )}
          >
            <span className="flex items-center gap-2 text-[13px] font-medium"><RoleDot colour={s.empty ? null : s.colour} />{title(s.id)}</span>
            <span className="text-[12px] text-[var(--color-fg-dim)]">{t(`manage.starter.${s.id}.desc`)}</span>
            <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11.5px]">
              {s.keyOnly ? <span className="text-[var(--color-ok)]">{t("manage.starter.anyCall")}</span>
                : s.empty ? <span className="text-[var(--color-fg-faint)]">{t("manage.starter.refusesAll")}</span>
                : CAPS.map(c => (
                  <span key={c.id} className={s.caps.includes(c.id) ? "text-[var(--color-ok)]" : "text-[var(--color-fg-faint)] line-through"}>{t(`manage.starter.short.${c.id}`)}</span>
                ))}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <label className="flex w-56 flex-col gap-1">
          <span className="text-[13px] font-medium">{t("manage.newRole.name")}</span>
          <Input data-testid="new-role-name" value={name} onChange={e => { setName(e.target.value); setTouched(true); }} />
        </label>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Eyebrow>{t("manage.newRole.uses")}</Eyebrow>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {secrets.map(s => (
              <label key={s.id} className="flex items-center gap-1.5 text-[13px]">
                <Checkbox data-new-role-secret={s.name} aria-label={s.name} checked={uses.includes(s.id)}
                  onChange={on => setUses(on ? [...uses, s.id] : uses.filter(x => x !== s.id))} />
                <span className="font-mono">{s.name}</span>
                <span className="text-[12px] text-[var(--color-fg-dim)]">{s.recipe === "github" ? t("manage.simple.github") : t("manage.simple.apiKey")}</span>
              </label>
            ))}
          </div>
          <span className="text-[12px] text-[var(--color-fg-dim)]">{st.keyOnly ? t("manage.newRole.usesHintKey") : t("manage.newRole.usesHint")}</span>
          {conflicts.length > 0 && (
            <span data-testid="new-role-conflict" className="text-[12px] text-[var(--color-err)]">{t("manage.newRole.conflict", { hosts: conflicts.join(", ") })}</span>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>{t("manage.newRole.cancel")}</Button>
        <Button size="sm" variant="primary" disabled={conflicts.length > 0 || !name.trim()} onClick={create} data-testid="new-role-create">{t("manage.newRole.create")}</Button>
      </div>
    </div>
  );
}
