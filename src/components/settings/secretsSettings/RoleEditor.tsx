// The selected role's editor: name, colour, description, the rule blocks
// per secret and host, duplicate and delete.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Braces, Copy, Trash2 } from "lucide-react";
import type { Role, SecretDef } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { ROLE_COLOURS, loginTakeovers, putRuleSet, roleColourVar, ruleBlocksFor, ruleSetFor } from "./model";
import { CommitInput, InfoTip } from "./parts";
import { RequestTester, blockKey, type TesterHit } from "./RequestTester";
import { RuleBlock } from "./RuleBlock";

export function RoleEditor({ role, secrets, runningTasks, onSave, onDuplicate, onDelete, onJson }: {
  role: Role; secrets: SecretDef[]; runningTasks: string[];
  onSave: (r: Role) => void; onDuplicate: () => void; onDelete: () => void;
  /** Swap the editor for the JSON export / import panel (RoleJsonPanel). */
  onJson?: () => void;
}) {
  const { t } = useTranslation("secrets");
  const blocks = ruleBlocksFor(role, secrets);
  const [hit, setHit] = useState<TesterHit | null>(null);
  return (
    <div className="flex flex-col gap-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] p-5" data-testid="role-editor">
      <div className="flex flex-wrap items-start gap-6">
        <label className="flex w-64 flex-col gap-1">
          <span className="text-[13px] font-medium">{t("manage.editor.name")}</span>
          <CommitInput data-testid="role-name" value={role.name} onCommit={v => { if (v.trim()) onSave({ ...role, name: v.trim() }); }} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{t("manage.editor.colour")}</span>
          <div className="flex h-9 items-center gap-2" role="radiogroup">
            {ROLE_COLOURS.map(c => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={role.colour === c}
                aria-label={t(`manage.editor.colourName.${c}`)}
                title={t(`manage.editor.colourName.${c}`)}
                data-role-colour={c}
                onClick={() => onSave({ ...role, colour: c })}
                className={cn("h-5 w-5 rounded-full ring-offset-2 ring-offset-[var(--color-bg-1)]", role.colour === c && "ring-2 ring-[var(--color-fg)]")}
                style={{ background: roleColourVar(c) }}
              />
            ))}
          </div>
        </div>
        <div className="ml-auto flex min-w-0 flex-col items-end gap-1.5">
          <span className="text-[12.5px] text-[var(--color-fg-dim)]">
            {runningTasks.length ? t("manage.editor.runningAs", { role: role.name }) : t("manage.editor.noneRunning", { role: role.name })}
          </span>
          <div className="flex flex-wrap justify-end gap-1.5">
            {runningTasks.map((n, i) => (
              <span key={`${n}-${i}`} className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-[12px]">{n}</span>
            ))}
          </div>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">{t("manage.editor.description")}</span>
        <CommitInput data-testid="role-description" value={role.description} placeholder={t("manage.editor.descriptionPlaceholder")} onCommit={v => onSave({ ...role, description: v })} />
      </label>

      {loginTakeovers(role, secrets).map(w => (
        <div key={`${w.agent}/${w.secret}`} data-testid="role-login-takeover" className="flex gap-2.5 rounded-md border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2.5 text-[12.5px]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <span>{t("manage.editor.loginTakeover", { agent: w.agent, env: w.env, secret: w.secret })}</span>
        </div>
      ))}

      {blocks.length === 0 && (
        <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.noSecrets")}</div>
      )}
      {blocks.length > 0 && (
        <>
          <RequestTester role={role} blocks={blocks} onHit={setHit} />
          <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("manage.editor.order")}
            <InfoTip text={t("manage.editor.orderTip")} />
          </span>
        </>
      )}
      {blocks.map(b => (
        <RuleBlock
          key={blockKey(b.secret.id, b.host)}
          title={t(b.kind === "git" ? "manage.editor.rulesGit" : "manage.editor.rulesApi", { secret: b.secret.name, host: b.host })}
          kind={b.kind}
          set={ruleSetFor(role, b.secret.id, b.host)}
          inherited={!role.rule_sets.some(r => r.secret === b.secret.id && r.host === b.host)}
          hit={hit?.key === blockKey(b.secret.id, b.host) ? hit.at : undefined}
          onChange={set => onSave(putRuleSet(role, set))}
        />
      ))}

      <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.footer")}</p>
      <div className="flex gap-2">
        {onJson && <Button size="sm" variant="ghost" onClick={onJson} data-testid="role-json-open"><Braces className="h-3.5 w-3.5" /> {t("manage.json.open")}</Button>}
        <Button size="sm" variant="ghost" onClick={onDuplicate} data-testid="role-duplicate"><Copy className="h-3.5 w-3.5" /> {t("manage.editor.duplicate")}</Button>
        <Button size="sm" variant="danger" onClick={onDelete} data-testid="role-delete"><Trash2 className="h-3.5 w-3.5" /> {t("manage.editor.delete")}</Button>
      </div>
    </div>
  );
}
