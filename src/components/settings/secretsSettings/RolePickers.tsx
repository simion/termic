// Role defaults outside the Secrets page: the per-agent select (Agents &
// Terminals) and the project's "New tasks default to" cards (mock M3).

import { useTranslation } from "react-i18next";
import type { Role } from "@/lib/types";
import { useApp } from "@/store/app";
import { ensureSecretsSync, useSecrets } from "@/store/secrets";
import { cn } from "@/lib/utils";
import { roleColourVar } from "./model";
import { RoleDot } from "./parts";

/** The shared mirror (store/secrets.ts), which the Secrets page updates on
 *  every save, so a role made there shows here without a reload. */
function useRoles() {
  ensureSecretsSync();
  return { roles: useSecrets(s => s.roles), secrets: useSecrets(s => s.secrets) };
}

/** The "Default role" row on an agent's card in Agents & Terminals. */
export function AgentRoleField({ agentId, value, onChange }: { agentId: string; value: string | null | undefined; onChange: (v: string | null) => void }) {
  const { t } = useTranslation("secrets");
  const { roles } = useRoles();
  // A role deleted since keeps showing as "No secrets", which is what the
  // spawn resolves it to anyway.
  const current = value && roles.some(r => r.id === value) ? value : "";
  return (
    <div>
      <div className="text-[13px] font-medium">{t("manage.agentDefault.label")}</div>
      <div className="mt-0.5 mb-1.5 text-[12px] text-[var(--color-fg-dim)]">{t("manage.agentDefault.hint")}</div>
      <div className="flex items-center gap-3">
      <select
        data-testid="agent-default-role"
        data-agent={agentId}
        value={current}
        onChange={e => onChange(e.target.value || null)}
        className="h-9 min-w-[200px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
      >
        <option value="">{t("manage.agentDefault.none")}</option>
        {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button
        type="button"
        onClick={() => useApp.getState().openSettings("secrets")}
        className="text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-accent)]"
      >
        {t("manage.agentDefault.manage")}
      </button>
      </div>
    </div>
  );
}

export function ProjectRoleCards({ value, onChange }: { value: string | null | undefined; onChange: (v: string | null) => void }) {
  const { t } = useTranslation("secrets");
  const { roles, secrets } = useRoles();
  // null inherits each agent's default; "" is an explicit No secrets that
  // stops the chain (secrets.rs resolve_role). A role deleted since resolves
  // to nothing, so it reads as No secrets.
  const current = value == null ? null : roles.some(r => r.id === value) ? value : "";

  const describe = (r: Role) => {
    if (r.description) return r.description;
    const names = r.secrets.map(id => secrets.find(s => s.id === id)?.name).filter(Boolean).join(", ");
    if (!names) return t("manage.project.noSecretsInRole");
    return r.rule_sets.length ? t("manage.project.withRules", { secrets: names }) : t("manage.project.noRules", { secrets: names });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="project-secrets">
      <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.project.intro")}</p>
      <div>
        <div className="text-[14px] font-medium">{t("manage.project.defaultTitle")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.project.defaultHint")}</div>
        <div className="mt-3 grid grid-cols-3 gap-3" role="radiogroup">
          <Card selected={current === null} colour={null} name={t("manage.project.inheritName")} desc={t("manage.project.inheritDesc")} id="inherit" onPick={() => onChange(null)} />
          <Card selected={current === ""} colour={null} name={t("manage.roles.noSecrets")} desc={t("manage.project.noSecretsDesc")} id="" onPick={() => onChange("")} />
          {roles.map(r => (
            <Card key={r.id} selected={current === r.id} colour={r.colour} name={r.name} desc={describe(r)} id={r.id} onPick={() => onChange(r.id)} />
          ))}
        </div>
        {roles.length === 0 && (
          <div className="mt-3 flex items-center gap-2 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("manage.project.noRoles")}
            <button type="button" onClick={() => useApp.getState().openSettings("secrets")} className="text-[var(--color-accent)] hover:underline">
              {t("manage.project.manage")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ selected, colour, name, desc, id, onPick }: {
  selected: boolean; colour: string | null; name: string; desc: string; id: string; onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-role-card={id || "none"}
      onClick={onPick}
      // the selected border takes the role's own colour, as in M3. Inline
      // because the token is per role. No transition-colors: WKWebView does
      // not repaint a transitioned themed border (CLAUDE.md, profiles).
      style={{ borderColor: selected ? (colour ? roleColourVar(colour) : "var(--color-fg-dim)") : "var(--color-border)" }}
      className={cn(
        "flex flex-col gap-1 rounded-lg border bg-[var(--color-bg-1)] px-4 py-3 text-left hover:bg-[var(--color-hover)]",
        selected && "bg-[var(--color-bg-2)]",
      )}
    >
      <span className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide">
        <RoleDot colour={colour} />{name}
      </span>
      <span className="text-[12.5px] text-[var(--color-fg-dim)]">{desc}</span>
    </button>
  );
}
