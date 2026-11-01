// Roles tab: the roles x secrets matrix and the new-role menu. The selected
// role's editor lives in RoleEditor.tsx, its rule blocks in RuleBlock.tsx.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plus } from "lucide-react";
import type { Role } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { DropdownItem, DropdownMenu, DropdownRoot, DropdownTrigger } from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";
import { defaultsFor, duplicateRole, hostConflicts, roleFromTemplate, tasksByRole, toggleSecret, type RoleTemplate } from "./model";
import { Eyebrow, RoleDot } from "./parts";
import { RoleEditor } from "./RoleEditor";
import { RoleJsonPanel } from "./RoleJsonPanel";
import type { RoleDraft } from "./roleJson";
import type { SecretsModel } from "./SecretsSection";

export function RolesTab({ model, initialRole }: { model: SecretsModel; initialRole?: string | null }) {
  const { t } = useTranslation("secrets");
  const { secrets, roles } = model;
  const [selected, setSelected] = useState<string | null>(initialRole ?? roles[0]?.id ?? null);
  // the JSON panel in place of the editor: for the selected role, or New role.
  const [json, setJson] = useState<"edit" | "new" | null>(null);
  // A deleted role (or a first load) leaves nothing picked; fall to the first.
  useEffect(() => {
    if (!selected || !roles.some(r => r.id === selected)) setSelected(roles[0]?.id ?? null);
  }, [roles, selected]);

  const tasks = useApp(s => s.tasks);
  const projects = useApp(s => s.projects);
  const agents = useApp(s => s.agents);
  const byRole = useMemo(() => tasksByRole(tasks, projects, agents, roles), [tasks, projects, agents, roles]);

  const saveRole = (next: Role) => model.save({ roles: roles.map(r => r.id === next.id ? next : r) });

  function toggle(role: Role, secretId: string, on: boolean) {
    const next = toggleSecret(role, secretId, on);
    const dup = hostConflicts(next.secrets, secrets);
    if (dup.length) {
      useUI.getState().pushToast(t("manage.roles.conflict", { role: role.name, hosts: dup.join(", ") }), "error");
      return;
    }
    void saveRole(next);
  }

  async function create(tpl: RoleTemplate) {
    // i18n.t, not the hook's t: the template's names and notes are stored
    // data, minted once in the current language.
    // the templates' rules are GitHub's; an API key secret that happens to
    // be listed first must not be bound to a role the user did not aim at it.
    const gh = secrets.find(s => s.recipe === "github");
    const role = roleFromTemplate(tpl, crypto.randomUUID(), gh, roles.map(r => r.colour), k => i18n.t(`secrets:${k}`));
    if (await model.save({ roles: [...roles, role] })) setSelected(role.id);
  }

  async function duplicate(role: Role) {
    const copy = duplicateRole(role, crypto.randomUUID(), roles,
      (name, n) => i18n.t(n === 1 ? "secrets:manage.editor.copyName" : "secrets:manage.editor.copyNameN", { name, n }));
    if (await model.save({ roles: [...roles, copy] })) setSelected(copy.id);
  }

  async function addFromJson(draft: RoleDraft) {
    const role: Role = { ...draft, id: crypto.randomUUID() };
    if (await model.save({ roles: [...roles, role] })) { setSelected(role.id); setJson(null); }
  }

  // same id, so running tasks and the agents and projects defaulting to it
  // keep pointing at it.
  async function replaceFromJson(id: string, draft: RoleDraft) {
    if (await saveRole({ ...draft, id })) setJson(null);
  }

  async function remove(role: Role) {
    const ok = await useUI.getState().askConfirm({
      title: t("manage.editor.deleteTitle", { name: role.name }),
      message: t("manage.editor.deleteMessage"),
      confirmLabel: t("manage.editor.delete"),
      destructive: true,
    });
    if (ok) await model.save({ roles: roles.filter(r => r.id !== role.id) });
  }

  const running = (n: number) => n === 1 ? t("manage.roles.running_one", { count: n }) : t("manage.roles.running_other", { count: n });
  const sel = roles.find(r => r.id === selected) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-[13px] text-[var(--color-fg-dim)]">{t("manage.roles.intro")}</p>

      <div className="flex items-center justify-between">
        <Eyebrow>{t("manage.roles.heading", { count: roles.length })}</Eyebrow>
        <DropdownRoot>
          <DropdownTrigger asChild>
            <Button variant="primary" data-testid="roles-new"><Plus className="h-4 w-4" /> {t("manage.roles.new")} <ChevronDown className="h-3.5 w-3.5" /></Button>
          </DropdownTrigger>
          <DropdownMenu>
            <DropdownItem data-role-template="empty" onSelect={() => void create("empty")}>{t("manage.tpl.menuEmpty")}</DropdownItem>
            <DropdownItem data-role-template="reviewer" onSelect={() => void create("reviewer")}>{t("manage.tpl.menuReviewer")}</DropdownItem>
            <DropdownItem data-role-template="maintainer" onSelect={() => void create("maintainer")}>{t("manage.tpl.menuMaintainer")}</DropdownItem>
            <DropdownItem data-role-template="json" onSelect={() => setJson("new")}>{t("manage.json.menu")}</DropdownItem>
          </DropdownMenu>
        </DropdownRoot>
      </div>

      {secrets.length === 0 && (
        <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.roles.noSecretsYet")}</div>
      )}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-left text-[13px]" data-testid="roles-matrix">
          <thead className="bg-[var(--color-bg-1)] text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
            <tr>
              <th className="px-3 py-2.5 font-medium">{t("manage.roles.colRole")}</th>
              {secrets.map(s => (
                <th key={s.id} className="px-3 py-2.5 text-center font-mono font-medium normal-case tracking-normal">{s.name}</th>
              ))}
              <th className="px-3 py-2.5 font-medium">{t("manage.roles.colDefaultFor")}</th>
              <th className="px-3 py-2.5 font-medium">{t("manage.roles.colRunning")}</th>
            </tr>
          </thead>
          <tbody>
            {roles.map(r => {
              const d = defaultsFor(r.id, projects, agents);
              const def = [
                ...d.agents.map(name => t("manage.roles.defaultAgent", { name })),
                ...d.projects.map(name => t("manage.roles.defaultProject", { name })),
              ].join(", ");
              return (
                <tr
                  key={r.id}
                  data-role-row={r.name}
                  data-selected={r.id === selected || undefined}
                  onClick={() => setSelected(r.id)}
                  className={cn(
                    "cursor-pointer border-t border-[var(--color-border-soft)] hover:bg-[var(--color-hover)]",
                    r.id === selected && "bg-[var(--color-bg-2)]",
                  )}
                >
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2 font-medium"><RoleDot colour={r.colour} />{r.name}</span>
                  </td>
                  {secrets.map(s => (
                    <td key={s.id} className="px-3 py-2.5">
                      <div className="flex justify-center">
                        <Checkbox
                          data-role-secret={`${r.name}/${s.name}`}
                          aria-label={`${r.name}: ${s.name}`}
                          checked={r.secrets.includes(s.id)}
                          onChange={on => toggle(r, s.id, on)}
                        />
                      </div>
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-[var(--color-fg-dim)]">{def}</td>
                  <td className="px-3 py-2.5">{running(byRole.get(r.id)?.length ?? 0)}</td>
                </tr>
              );
            })}
            <tr className="border-t border-[var(--color-border-soft)] text-[var(--color-fg-dim)]">
              <td className="px-3 py-2.5">
                <span className="flex items-center gap-2">
                  <RoleDot colour={null} />{t("manage.roles.noSecrets")}
                  <span className="text-[10.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">{t("manage.roles.builtIn")}</span>
                </span>
              </td>
              {secrets.map(s => <td key={s.id} className="px-3 py-2.5 text-center text-[var(--color-fg-faint)]">·</td>)}
              <td className="px-3 py-2.5">{t("manage.roles.everythingElse")}</td>
              <td className="px-3 py-2.5">{running(byRole.get("")?.length ?? 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {json && <RoleJsonPanel key={json === "edit" ? sel?.id : "new"} role={json === "edit" && sel ? sel : undefined} example={sel ?? undefined} secrets={secrets}
        onAdd={d => void addFromJson(d)} onReplace={d => sel && void replaceFromJson(sel.id, d)} onClose={() => setJson(null)} />}
      {json ? null : sel
        ? <RoleEditor key={sel.id} role={sel} secrets={secrets} runningTasks={byRole.get(sel.id)?.map(x => x.name) ?? []} onSave={saveRole} onDuplicate={() => void duplicate(sel)} onDelete={() => void remove(sel)} onJson={() => setJson("edit")} />
        : roles.length > 0 && <div className="text-[12.5px] text-[var(--color-fg-faint)]">{t("manage.roles.selectHint")}</div>}
    </div>
  );
}
