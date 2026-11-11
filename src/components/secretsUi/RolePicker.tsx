// Task-side Secrets pieces shared by the create / edit / sandbox / schedule
// dialogs and the sidebar + title bar key.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, ShieldCheck, Check, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";
import { keychainBlocked, type Role, type SecretDef, type Task } from "@/lib/types";
import { roleColour, ruleSummary, brokerEnvPreview, configuredRole } from "@/lib/secretsUi";
import { useSecrets, useTaskRole, ensureSecretsSync } from "@/store/secrets";

/** One option of a role picker. `id` null is the project's "Each agent's
 *  choice"; "" is No secrets. `colour` null draws a dashed dot, `"none"` no
 *  dot at all. */
export interface RoleOption { id: string | null; name: string; desc: string; colour: string | null | "none" }

/** The options every picker starts from: No secrets, then one per role with
 *  its secrets (and description) as the summary. */
export function roleOptions(roles: Role[], secrets: SecretDef[], t: (k: string) => string): RoleOption[] {
  const secretName = (id: string) => secrets.find(s => s.id === id)?.name ?? id;
  return [
    { id: "", name: t("secrets:task.noSecrets"), desc: t("secrets:task.noSecretsDesc"), colour: null },
    ...roles.map(r => ({
      id: r.id,
      name: r.name,
      desc: [r.secrets.map(secretName).join(", "), r.description].filter(Boolean).join(". ") || t("secrets:task.roleHasNoSecrets"),
      colour: r.colour ?? "blue",
    })),
  ];
}

/** The one role picker (task dialogs, Settings > Agents, Settings >
 *  Project): a radio list of rows, each a radio, the role's dot, its name
 *  and its secrets. Rows carry `data-role-option` (`none` for No secrets,
 *  `inherit` for Each agent's choice). */
export function RoleOptions({ options, value, onChange, disabled = false, label, compact = false }: {
  options: RoleOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  label: string;
  compact?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      {options.map(o => {
        const active = !disabled && value === o.id;
        return (
          <button
            key={o.id ?? "inherit"}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            data-role-option={o.id === null ? "inherit" : o.id || "none"}
            onClick={() => onChange(o.id)}
            // no transition-colors: WKWebView does not repaint a transitioned
            // themed border (docs/gotchas.md).
            className={cn(
              "flex w-full min-w-0 items-start gap-2.5 rounded-md border px-2.5 text-left",
              compact ? "py-1.5" : "py-2",
              active ? "border-[var(--color-fg-dim)] bg-[var(--color-bg-2)]" : "border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-hover)]",
              disabled && "cursor-not-allowed opacity-40 hover:bg-[var(--color-bg)]",
            )}
          >
            <span className={cn(
              "mt-[2px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px]",
              active ? "border-[var(--color-fg)]" : "border-[var(--color-fg-faint)]",
            )}>
              {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-fg)]" />}
            </span>
            {o.colour !== "none" && (
              <span className="mt-[2px] flex h-3.5 w-3 shrink-0 items-center justify-center">
                {o.colour === null
                  ? <CircleDashed className="h-3 w-3 text-[var(--color-fg-faint)]" />
                  : <span className="h-2 w-2 rounded-full" style={{ background: roleColour(o.colour) }} />}
              </span>
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={cn("truncate text-[var(--color-fg)]", compact ? "text-[12.5px]" : "text-[13px]")}>{o.name}</span>
              <span className={cn("line-clamp-2 leading-snug text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px]")}>{o.desc}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The task dialogs' role section: "This task runs as" over the one picker.
 *  `disabledReason` greys it out with that text underneath (the sandbox
 *  choice cannot carry a role); `note` is a line underneath that does not
 *  grey it. `seededFrom` says the pick came from a default, on create only.
 *  The caller owns the sandbox coupling: picking a role must turn on an
 *  enforcing mode and the Keychain block (`withRoleCage`), and clearing the
 *  block must clear the role. */
export function RolePicker({
  roles, secrets, value, onChange, seededFrom = null, disabledReason, note = null, compact = false,
}: {
  roles: Role[];
  secrets: SecretDef[];
  /** Role id, "" for No secrets. */
  value: string;
  onChange: (id: string) => void;
  /** Where a create dialog's untouched pick came from: the project's default
   *  or the named agent's. */
  seededFrom?: { source: "project" } | { source: "agent"; agent: string } | null;
  disabledReason: string | null;
  note?: string | null;
  compact?: boolean;
}) {
  const { t } = useTranslation("secrets");
  const disabled = disabledReason !== null;
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
      <RoleOptions
        options={roleOptions(roles, secrets, t)}
        value={value}
        onChange={id => onChange(id ?? "")}
        disabled={disabled}
        label={t("task.roleLabel")}
        compact={compact}
      />
      {!disabled && seededFrom && (
        <span data-testid="role-seeded-from" className={cn("rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] px-2.5 py-1.5 leading-snug text-[var(--color-fg-dim)]", compact ? "text-[11px]" : "text-[11.5px]")}>
          {seededFrom.source === "project" ? t("task.seededFromProject") : t("task.seededFromAgent", { agent: seededFrom.agent })}
        </span>
      )}
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

/** The New Task dialog's right-column summary for a picked role. */
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
 *  amber when a role is set but cannot apply, nothing when the task has no
 *  role. Its own component so the row or
 *  bar that hosts it never subscribes to the secrets store itself. */
export function TaskRoleKey({ task, className, wrapClassName }: { task: Task; className?: string; wrapClassName?: string }) {
  const { t } = useTranslation("secrets");
  const { role, configured } = useTaskRole(task);
  const suspicious = useSecrets(s => !!s.suspicious[task.id]);
  // amber: a role is set but nothing it needs is there (no Keychain block,
  // Monitor, Docker), so it does not apply.
  const shown = role ?? configured;
  if (!shown) return null;
  const colour = !role ? "var(--color-warn)" : suspicious ? "var(--color-err)" : roleColour(role.colour);
  return (
    <span
      data-testid="task-role-key"
      data-role={shown.id}
      data-applied={!!role}
      data-suspicious={(role && suspicious) || undefined}
      title={t(!role ? "task.keyUnappliedTip" : suspicious ? "task.keySuspiciousTip" : "task.keyTip", { role: shown.name })}
      className={cn("flex shrink-0 items-center", wrapClassName)}
    >
      <KeyRound className={className ?? "h-3.5 w-3.5"} style={{ color: colour }} />
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

/** The modes a role can apply in (with the Keychain block). */
export const enforcing = (mode: string) => mode === "enforce" || mode === "enforce-fs";

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
 *  Seeded on `openKey` with the task's own role, so ticking the block back
 *  on shows it again. `roleOk` = the draft sandbox is Enforce or Enforce FS;
 *  `block` = the draft Keychain block. Only a draft that both allow counts,
 *  and `store` is what `taskSetRole` should get. */
export function useRoleDraft(
  task: Task | null, roleOk: boolean, block: boolean, setBlock: (v: boolean) => void, openKey: unknown,
) {
  ensureSecretsSync();
  const roles = useSecrets(s => s.roles);
  const secrets = useSecrets(s => s.secrets);
  const seeded = configuredRole(task, roles)?.id ?? "";
  const [pick, setPick] = useState(seeded);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPick(seeded), [openKey, seeded]);
  const gate = roleOk && block;
  return {
    roles, secrets,
    /** What the cards show as picked. */
    value: gate ? pick : "",
    /** Changed vs the record: a different pick, or a block / mode change that
     *  drops a role the task actually stores. */
    dirty: !!task && (gate ? pick !== seeded : keychainBlocked(task) && !!task.role),
    /** The pick as the task should own it, "" for No secrets. */
    store: gate ? pick : null,
    /** Picking a role turns the Keychain block on. */
    onPick: (id: string) => { setPick(id); if (id) setBlock(true); },
    /** Clearing the block clears the role. */
    onBlock: (v: boolean) => { setBlock(v); if (!v) setPick(""); },
    /** Call when the sandbox draft leaves Enforce / Enforce FS. */
    clear: () => setPick(""),
  };
}
