// Task-side Secrets pieces shared by the create / edit / sandbox / schedule
// dialogs (M4) and the sidebar + title bar (M5 key).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, ShieldCheck, Check, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";
import { keychainBlocked, type Agent, type Project, type Role, type SecretDef, type Task } from "@/lib/types";
import { roleColour, ruleSummary, brokerEnvPreview, roleDefault, roleToStore, configuredRole } from "@/lib/secretsUi";
import { useSecrets, useTaskRole, ensureSecretsSync } from "@/store/secrets";

/** Role cards: No secrets + one per role. `disabledReason` greys them all
 *  out with that text underneath (the sandbox choice cannot carry a role);
 *  `note` is a line underneath that does not grey them. The caller owns the
 *  sandbox coupling: picking a role must turn on an enforcing mode and the
 *  Keychain block (`withRoleCage`), and clearing the block must clear the
 *  role. */
export function RolePicker({
  roles, secrets, value, onChange, def, disabledReason, note = null, compact = false,
}: {
  roles: Role[];
  secrets: SecretDef[];
  /** Role id, "" for No secrets. */
  value: string;
  onChange: (id: string) => void;
  def: { id: string; source: "project" | "agent" } | null;
  disabledReason: string | null;
  note?: string | null;
  compact?: boolean;
}) {
  const { t } = useTranslation("secrets");
  const disabled = disabledReason !== null;
  const secretName = (id: string) => secrets.find(s => s.id === id)?.name ?? id;
  const cards: { id: string; name: string; desc: string; colour: string | null }[] = [
    { id: "", name: t("task.noSecrets"), desc: t("task.noSecretsDesc"), colour: null },
    ...roles.map(r => ({
      id: r.id,
      name: r.name,
      desc: [r.secrets.map(secretName).join(", "), r.description].filter(Boolean).join(". "),
      colour: roleColour(r.colour),
    })),
  ];
  return (
    <div
      data-testid="role-section"
      data-disabled={disabled || undefined}
      className={cn("flex flex-col rounded-md border border-[var(--color-border)]", compact ? "gap-2 p-2.5" : "gap-2.5 p-3")}
    >
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 text-[var(--color-accent)]" />
          <span className={cn("font-medium text-[var(--color-fg)]", compact ? "text-[12.5px]" : "text-[13px]")}>{t("task.roleLabel")}</span>
          <span className="rounded bg-[var(--color-accent)]/15 px-1 text-[10px] uppercase tracking-wider text-[var(--color-accent)]">{t("task.experimental")}</span>
        </div>
        <span className={cn("text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[12px]")}>{t("task.roleHint")}</span>
      </div>
      <div role="radiogroup" className={cn("grid gap-2", compact ? "grid-cols-2" : "grid-cols-3")}>
        {cards.map(c => {
          const active = !disabled && value === c.id;
          return (
            <button
              key={c.id || "none"}
              type="button"
              disabled={disabled}
              data-role-option={c.id || "none"}
              role="radio"
              aria-checked={active}
              onClick={() => onChange(c.id)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left",
                active ? "bg-[var(--color-bg-2)]" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
                disabled && "cursor-not-allowed opacity-40 hover:border-[var(--color-border)]",
              )}
              style={active ? { borderColor: c.colour ?? "var(--color-fg-faint)" } : undefined}
            >
              <span className="flex w-full min-w-0 items-start gap-1.5">
                {c.colour
                  ? <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: c.colour }} />
                  : <CircleDashed className="mt-[2px] h-3 w-3 shrink-0 text-[var(--color-fg-faint)]" />}
                <span className="min-w-0 truncate text-[12px] font-semibold uppercase tracking-wide" style={{ color: active ? "var(--color-fg)" : "var(--color-fg-dim)" }}>{c.name}</span>
                {def?.id === c.id && c.id !== "" && (
                  <span data-testid="role-default-badge" className="ml-auto shrink-0 text-right text-[9.5px] font-semibold uppercase leading-tight tracking-wide" style={{ color: c.colour ?? undefined }}>
                    {t(def.source === "project" ? "task.projectDefault" : "task.agentDefault")}
                  </span>
                )}
              </span>
              <span className={cn("line-clamp-2 text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>{c.desc}</span>
            </button>
          );
        })}
      </div>
      {!disabledReason && note && (
        <span data-testid="role-cage-note" className={cn("text-[var(--color-fg-faint)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>
          {note}
        </span>
      )}
      {disabledReason && (
        <span data-testid="role-disabled-reason" className={cn("text-[var(--color-fg-faint)]", compact ? "text-[11px]" : "text-[11.5px] leading-snug")}>
          {disabledReason}
        </span>
      )}
    </div>
  );
}

/** The New Task dialog's right-column summary for a picked role (M4). */
export function SecretsForTask({ role, secrets }: { role: Role; secrets: SecretDef[] }) {
  const { t } = useTranslation("secrets");
  const mine = secrets.filter(s => role.secrets.includes(s.id));
  const others = secrets.filter(s => !role.secrets.includes(s.id));
  const env = brokerEnvPreview(mine);
  return (
    <div data-testid="secrets-for-task" className="flex min-w-0 flex-col gap-3">
      <div className="text-[11.5px] uppercase tracking-[0.1em] text-[var(--color-fg-faint)]">{t("task.secretsForTask")}</div>
      <div className="flex items-center gap-2 rounded-md border border-[var(--color-ok)]/30 bg-[var(--color-ok)]/10 px-3 py-2 text-[12.5px] text-[var(--color-fg-dim)]">
        <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--color-ok)]" />
        <span><b className="text-[var(--color-fg)]">{t("task.brokered")}</b> {t("task.brokeredBody")}</span>
      </div>
      <div className="flex flex-col rounded-md border border-[var(--color-border)]">
        {mine.map(s => (
          <div key={s.id} data-secret={s.id} className="flex flex-col gap-1 border-b border-[var(--color-border-soft)] px-3 py-2.5 last:border-b-0">
            <div className="flex items-center gap-1.5 text-[12.5px]">
              <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
              <span className="font-mono font-medium text-[var(--color-fg)]">{s.name}</span>
              <span className="text-[var(--color-fg-dim)]">{t("task.viaGh")}</span>
            </div>
            <div className="pl-5 text-[12px] leading-snug text-[var(--color-fg-dim)]">
              {t("task.reaches", { hosts: s.hosts.join(", ") })}
              {ruleSummary(role.rule_sets.filter(rs => rs.secret === s.id), t).map(line => (
                <div key={line} className="text-[var(--color-fg-faint)]">{line}</div>
              ))}
            </div>
          </div>
        ))}
        {mine.length === 0 && (
          <div className="px-3 py-2.5 text-[12px] text-[var(--color-fg-faint)]">{t("task.roleHasNoSecrets")}</div>
        )}
        {others.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-[var(--color-border-soft)] px-3 py-2.5">
            <span className="text-[12px] text-[var(--color-fg-faint)]">{t("task.notAvailable")}</span>
            <div className="flex flex-wrap gap-1.5">
              {others.map(s => (
                <span key={s.id} className="rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 font-mono text-[11.5px] text-[var(--color-fg-faint)]">{s.name}</span>
              ))}
            </div>
          </div>
        )}
      </div>
      {env.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-[var(--color-fg-faint)]">{t("task.envTitle")}</span>
          <pre data-testid="secrets-env-preview" className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]">
            {env.map(e => (
              <div key={e.line}>
                {e.line}
                {e.note && <span className="text-[var(--color-fg-faint)]">{"   # "}{t(e.note === "placeholder" ? "task.envPlaceholder" : "task.envSocket")}</span>}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Key in the role's colour, red once the broker saw something suspicious,
 *  nothing when the task resolves no role. Its own component so the row or
 *  bar that hosts it never subscribes to the secrets store itself. */
export function TaskRoleKey({ task, className, wrapClassName }: { task: Task; className?: string; wrapClassName?: string }) {
  const { t } = useTranslation("secrets");
  const { role } = useTaskRole(task);
  const suspicious = useSecrets(s => !!s.suspicious[task.id]);
  if (!role) return null;
  return (
    <span
      data-testid="task-role-key"
      data-role={role.id}
      data-suspicious={suspicious || undefined}
      title={t(suspicious ? "task.keySuspiciousTip" : "task.keyTip", { role: role.name })}
      className={cn("flex shrink-0 items-center", wrapClassName)}
    >
      <KeyRound className={className ?? "h-3.5 w-3.5"} style={{ color: suspicious ? "var(--color-err)" : roleColour(role.colour) }} />
    </span>
  );
}

/** Shared draft rules for every dialog that edits a role next to a sandbox
 *  choice. A role needs the Keychain block (plan "No Keychain block, no
 *  secrets"), which needs Enforce / Enforce FS. Docker cannot carry a role
 *  yet, so only Docker greys the picker: on any other selection, picking a
 *  role switches the draft to an enforcing mode (`withRoleCage`).
 *  Returns the reason the picker is greyed, or null. */
export function roleDisabledReason(
  t: (k: string) => string,
  sel: { docker: boolean; mode: string; seatbelt: boolean },
): string | null {
  if (sel.docker) return t("secrets:task.disabledDocker");
  // no Seatbelt here: nothing to switch to.
  if (!sel.seatbelt && !enforcing(sel.mode)) return t("secrets:task.disabledNoSeatbelt");
  return null;
}

const enforcing = (mode: string) => mode === "enforce" || mode === "enforce-fs";

/** The line under the picker when picking a role would change the sandbox
 *  draft, so the switch is never a surprise. */
export function roleCageNote(t: (k: string) => string, sel: { docker: boolean; mode: string }): string | null {
  return !sel.docker && !enforcing(sel.mode) ? t("secrets:task.roleSwitchesCage") : null;
}

/** Wrap a dialog's role pick so a role on an uncaged draft first moves the
 *  sandbox to Enforcing (FS), the mode that keeps the network as it was.
 *  `pick` turns the Keychain block on itself. */
export function withRoleCage(
  mode: string, chooseMode: (m: "enforce-fs") => void, pick: (id: string) => void,
): (id: string) => void {
  return id => {
    if (id && !enforcing(mode)) chooseMode("enforce-fs");
    pick(id);
  };
}

/** Role draft for the dialogs that edit an EXISTING task (Sandbox, Edit).
 *  Seeded on `openKey` with the role the task is configured for, so ticking
 *  the block back on shows it again. `roleOk` = the draft sandbox is Enforce
 *  or Enforce FS; `block` = the draft Keychain block. Only a draft that both
 *  allow counts, and `store` is what `taskSetRole` should get. */
export function useRoleDraft(
  task: Task | null, project: Project | null, agent: Agent | null,
  roleOk: boolean, block: boolean, setBlock: (v: boolean) => void, openKey: unknown,
) {
  ensureSecretsSync();
  const roles = useSecrets(s => s.roles);
  const secrets = useSecrets(s => s.secrets);
  const def = roleDefault(project, agent);
  const seeded = configuredRole(task, project, agent, roles)?.id ?? "";
  const [pick, setPick] = useState(seeded);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPick(seeded), [openKey, seeded]);
  const gate = roleOk && block;
  return {
    roles, secrets, def,
    /** What the cards show as picked. */
    value: gate ? pick : "",
    /** Changed vs the record: a different pick, or a block / mode change that
     *  drops a role the task actually stores. */
    dirty: !!task && (gate ? pick !== seeded : keychainBlocked(task) && task.role != null),
    store: gate ? roleToStore(pick, def) : null,
    /** Picking a role turns the Keychain block on. */
    onPick: (id: string) => { setPick(id); if (id) setBlock(true); },
    /** Clearing the block clears the role. */
    onBlock: (v: boolean) => { setBlock(v); if (!v) setPick(""); },
    /** Call when the sandbox draft leaves Enforce / Enforce FS. */
    clear: () => setPick(""),
  };
}
