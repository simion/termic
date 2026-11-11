// Role defaults outside the Secrets page: an agent's "New <agent> tasks start
// as" (Agents & Terminals) and the project's "New tasks here start as". Both
// only seed a new task's role; neither moves an existing task.

import { useTranslation } from "react-i18next";
import { isTerminalEntry } from "@/lib/agents";
import { useApp } from "@/store/app";
import { ensureSecretsSync, useSecrets } from "@/store/secrets";
import { RoleOptions, roleOptions } from "@/components/secretsUi/RolePicker";

/** The shared mirror (store/secrets.ts), which the Secrets page updates on
 *  every save, so a role made there shows here without a reload. */
function useRoles() {
  ensureSecretsSync();
  return { roles: useSecrets(s => s.roles), secrets: useSecrets(s => s.secrets) };
}

function ManageRoles() {
  const { t } = useTranslation("secrets");
  return (
    <button
      type="button"
      onClick={() => useApp.getState().openSettings("secrets")}
      className="text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-accent)]"
    >
      {t("manage.agentDefault.manage")}
    </button>
  );
}

/** The role row on an agent's card in Agents & Terminals. */
export function AgentRoleField({ agentId, agentName, value, onChange }: {
  agentId: string; agentName: string; value: string | null | undefined; onChange: (v: string | null) => void;
}) {
  const { t } = useTranslation("secrets");
  const { roles, secrets } = useRoles();
  // A role deleted since keeps showing as "No secrets", which is what a new
  // task would be seeded with anyway.
  const current = value && roles.some(r => r.id === value) ? value : "";
  const label = t("manage.agentDefault.label", { agent: agentName });
  return (
    <div data-testid="agent-default-role" data-agent={agentId}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-medium">{label}</div>
        <ManageRoles />
      </div>
      <div className="mt-0.5 mb-1.5 text-[12px] text-[var(--color-fg-dim)]">{t("manage.agentDefault.hint")}</div>
      <RoleOptions options={roleOptions(roles, secrets, t)} value={current} onChange={id => onChange(id || null)} label={label} compact />
    </div>
  );
}

export function ProjectRoleCards({ value, onChange }: { value: string | null | undefined; onChange: (v: string | null) => void }) {
  const { t } = useTranslation("secrets");
  const { roles, secrets } = useRoles();
  const agents = useApp(s => s.agents);
  // null leaves it to each agent's default; "" is No secrets. A role deleted
  // since seeds nothing, so it reads as No secrets.
  const current = value == null ? null : roles.some(r => r.id === value) ? value : "";
  // what "Each agent's choice" gives a new task: the agents with a role by
  // name, the rest as one "No secrets".
  const live = agents.filter(a => !a.disabled && !isTerminalEntry(a));
  const withRole = live.flatMap(a => {
    const r = roles.find(x => x.id === a.default_role);
    return r ? [t("manage.project.inheritItem", { agent: a.display_name || a.id, role: r.name })] : [];
  });
  const each = withRole.length === 0 ? t("manage.project.inheritNone")
    : t(withRole.length < live.length ? "manage.project.inheritSome" : "manage.project.inheritAll", { list: withRole.join(", ") });
  const options = [
    { id: null, name: t("manage.project.inheritName"), desc: each, colour: "none" as const },
    ...roleOptions(roles, secrets, t),
  ];

  return (
    <div className="flex flex-col gap-6" data-testid="project-secrets">
      <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.project.intro")}</p>
      <div>
        <div className="text-[14px] font-medium">{t("manage.project.defaultTitle")}</div>
        <div className="mt-0.5 mb-3 text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.project.defaultHint")}</div>
        <RoleOptions options={options} value={current} onChange={onChange} label={t("manage.project.defaultTitle")} />
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
