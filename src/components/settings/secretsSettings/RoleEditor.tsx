// The selected role's editor: name, colour, description, then three tabs:
// Simple (checkboxes, SimpleView.tsx), Rules (the rule blocks per secret and
// host) and JSON (RoleJsonPanel.tsx). Duplicate and delete below.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Copy, Trash2 } from "lucide-react";
import type { Role, SecretDef } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { ROLE_COLOURS, loginTakeovers, putRuleSet, roleColourVar, ruleBlocksFor, ruleSetFor } from "./model";
import { CommitInput, InfoTip, TabStrip } from "./parts";
import { RequestTester, blockKey, type TesterHit } from "./RequestTester";
import { RoleJsonPanel } from "./RoleJsonPanel";
import type { RoleDraft } from "./roleJson";
import { RuleBlock } from "./RuleBlock";
import { SimpleView } from "./SimpleView";

type EditorTab = "simple" | "rules" | "json";

export function RoleEditor({ role, secrets, runningTasks, defaultFor, onSave, onDuplicate, onDelete, onJsonAdd, onJsonReplace }: {
  role: Role; secrets: SecretDef[]; runningTasks: string[];
  /** "agent claude, project acme/widget", or "" when nothing defaults to it. */
  defaultFor: string;
  onSave: (r: Role) => void; onDuplicate: () => void; onDelete: () => void;
  onJsonAdd: (d: RoleDraft) => void; onJsonReplace: (d: RoleDraft) => Promise<boolean>;
}) {
  const { t } = useTranslation("secrets");
  const blocks = ruleBlocksFor(role, secrets);
  const [hit, setHit] = useState<TesterHit | null>(null);
  // simple when every secret is on checkboxes (custom ones show a banner
  // there), Rules once any has none. Picked once per role: the editor is
  // keyed by role id, so a hand edit does not yank the tab away.
  const [tab, setTab] = useState<EditorTab>(() =>
    role.secrets.every(id => !!role.simple?.[id] || !secrets.some(s => s.id === id)) ? "simple" : "rules");
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
          {defaultFor && <span data-testid="role-default-for" className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.defaultFor", { list: defaultFor })}</span>}
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

      <TabStrip attr="data-role-tab" value={tab} onChange={setTab} tabs={[
        { id: "simple", label: t("manage.simple.tabSimple") },
        { id: "rules", label: t("manage.simple.tabRules") },
        { id: "json", label: t("manage.json.open") },
      ]} />

      {tab === "simple" && <SimpleView role={role} secrets={secrets} onSave={onSave} onOpenRules={() => setTab("rules")} />}

      {tab === "rules" && blocks.length === 0 && (
        <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.noSecrets")}</div>
      )}
      {tab === "rules" && blocks.length > 0 && (
        <>
          <RequestTester role={role} blocks={blocks} onHit={setHit} />
          <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("manage.editor.order")}
            <InfoTip text={t("manage.editor.orderTip")} />
          </span>
        </>
      )}
      {tab === "rules" && blocks.map(b => (
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

      {tab === "json" && (
        <RoleJsonPanel role={role} secrets={secrets} onAdd={onJsonAdd}
          // an import carries no checkbox state, so Rules is where it shows.
          onReplace={d => void onJsonReplace(d).then(ok => { if (ok) setTab("rules"); })} />
      )}

      <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.footer")}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={onDuplicate} data-testid="role-duplicate"><Copy className="h-3.5 w-3.5" /> {t("manage.editor.duplicate")}</Button>
        <Button size="sm" variant="danger" onClick={onDelete} data-testid="role-delete"><Trash2 className="h-3.5 w-3.5" /> {t("manage.editor.delete")}</Button>
      </div>
    </div>
  );
}
