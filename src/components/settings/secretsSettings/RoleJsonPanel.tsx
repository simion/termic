// A role as JSON: the current role to copy, an "Ask an agent" prompt, and a
// paste box that previews and imports. The role editor's JSON tab (with
// `role`, so Replace is offered) and New role's "Paste JSON instead" (without).

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, X } from "lucide-react";
import type { Role, SecretDef } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Eyebrow, InfoTip } from "./parts";
import { agentPrompt, describeImport, parseRoleJson, roleJsonText, type RoleDraft } from "./roleJson";

const area = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]";

export function RoleJsonPanel({ role, example, secrets, onAdd, onReplace, onClose }: {
  /** The role being exported; also the one Replace writes over. */
  role?: Role;
  /** The prompt's example role (defaults to `role`). */
  example?: Role;
  secrets: SecretDef[];
  onAdd: (draft: RoleDraft) => void;
  onReplace?: (draft: RoleDraft) => void;
  /** New role's flow only; in the editor the panel is a tab. */
  onClose?: () => void;
}) {
  const { t } = useTranslation("secrets");
  const tt = (k: string, o?: Record<string, unknown>) => t(k, o);
  const [ask, setAsk] = useState("");
  const [paste, setPaste] = useState("");
  const parsed = useMemo(() => paste.trim() ? parseRoleJson(paste, secrets, (k, o) => t(k, o)) : null, [paste, secrets, t]);
  const lines = parsed?.role ? describeImport(parsed.role, secrets, tt, role) : [];
  const ok = !!parsed?.role;

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] p-5" data-testid="role-json">
      <div className="flex items-center gap-2">
        <Eyebrow className="flex items-center gap-1.5">
          {role ? t("manage.json.heading", { name: role.name }) : t("manage.json.newHeading")}
          <InfoTip text={t("manage.json.headingTip")} />
        </Eyebrow>
        <span className="flex-1" />
        {role && (
          <Button size="sm" onClick={() => void copyToClipboard(roleJsonText(role, secrets), t("manage.json.copyLabel"))} data-testid="role-json-copy">
            <Copy className="h-3.5 w-3.5" /> {t("manage.json.copy")}
          </Button>
        )}
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="role-json-close">
            <X className="h-3.5 w-3.5" /> {t("manage.json.close")}
          </Button>
        )}
      </div>

      <div className={cn("grid gap-5", role && "md:grid-cols-2")}>
        {role && (
          <pre data-testid="role-json-export" className="max-h-[420px] min-w-0 overflow-auto rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[12px] leading-relaxed">
            {roleJsonText(role, secrets)}
          </pre>
        )}

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border-soft)] p-3">
            <Eyebrow className="flex items-center gap-1.5">{t("manage.json.askHeading")}<InfoTip text={t("manage.json.askTip")} /></Eyebrow>
            <textarea
              value={ask}
              onChange={e => setAsk(e.target.value)}
              rows={3}
              aria-label={t("manage.json.askLabel")}
              placeholder={t("manage.json.askPlaceholder")}
              data-testid="role-json-ask"
              className={area}
            />
            <div className="flex items-center gap-3">
              <Button size="sm" variant="primary" data-testid="role-json-copy-prompt"
                onClick={() => void copyToClipboard(agentPrompt(ask, secrets, example ?? role), t("manage.json.promptLabel"))}>
                {t("manage.json.copyPrompt")}
              </Button>
              <span className="text-[12px] text-[var(--color-fg-dim)]">{t("manage.json.askHint")}</span>
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">{t("manage.json.pasteLabel")}</span>
            <textarea
              value={paste}
              onChange={e => setPaste(e.target.value)}
              rows={8}
              placeholder={'{ "termic_role": 1, "name": "...", "secrets": { ... } }'}
              data-testid="role-json-paste"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              className={cn(area, "font-mono")}
            />
          </label>

          {parsed && (
            <div data-testid="role-json-preview" data-valid={ok || undefined} className="flex flex-col gap-1 rounded-md border border-[var(--color-border-soft)] p-3 font-mono text-[12px]">
              {parsed.role && <Eyebrow className="mb-1">{t("manage.json.previewHeading", { name: parsed.role.name })}</Eyebrow>}
              {parsed.errors.map((e, i) => <span key={`e${i}`} data-import-error className="text-[var(--color-err)]">{e}</span>)}
              {lines.map((l, i) => (
                <span key={`l${i}`} className={l.sign === "-" ? "text-[var(--color-err)]" : l.sign === "+" ? "text-[var(--color-ok)]" : "text-[var(--color-fg)]"}>{l.sign} {l.text}</span>
              ))}
              {parsed.warnings.map((w, i) => <span key={`w${i}`} className="text-[var(--color-warn)]">{w}</span>)}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={!ok} onClick={() => parsed?.role && onAdd(parsed.role)} data-testid="role-json-add">{t("manage.json.addNew")}</Button>
            {role && onReplace && (
              <Button size="sm" variant="primary" disabled={!ok} onClick={() => parsed?.role && onReplace(parsed.role)} data-testid="role-json-replace">{t("manage.json.replace")}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
