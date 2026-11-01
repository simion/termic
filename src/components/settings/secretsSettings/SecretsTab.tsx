// Secrets tab: health cards, the secrets table, the expanded row,
// and the Replace dialog.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Lock, Pencil, Plus } from "lucide-react";
import { secretProbe, secretStore, secretsExposed, secretsProtectedAvailable } from "@/lib/ipc";
import type { SecretDef, SecretExposure, SecretStatus } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { AppDialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { deliveredAs, secretProblem, storedIn, tasksByRole } from "./model";
import type { Delivery, SecretPreset } from "./model";
import { Eyebrow, HostChips, InfoTip, RoleDot } from "./parts";
import { AddSecretDialog } from "./AddSecretDialog";
import type { SecretsModel } from "./SecretsSection";

type Probe = SecretStatus | { status: "checking" };

/** A probe that could not run (command missing, IPC error) is "error", not
 *  a missing row: the table must still say SOMETHING about every secret. */
const probe = (id: string): Promise<SecretStatus> =>
  secretProbe(id).catch(e => ({ status: "error", detail: String(e) }) as SecretStatus);

export function SecretsTab({ model, initialAdd, onShowActivity }: {
  model: SecretsModel;
  /** Open the Add dialog on mount (the Env vars tab's "Add as a secret"). */
  initialAdd?: { fromVar?: string; preset?: SecretPreset } | null;
  onShowActivity: (secretId: string) => void;
}) {
  const { t } = useTranslation("secrets");
  const { secrets, roles } = model;
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [exposed, setExposed] = useState<SecretExposure[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ fromVar?: string; preset?: SecretPreset } | null>(initialAdd ?? null);
  const [replacing, setReplacing] = useState<SecretDef | null>(null);
  // null = unknown (not answered yet, or the IPC failed): say nothing.
  const [protectedOk, setProtectedOk] = useState<boolean | null>(null);
  useEffect(() => { secretsProtectedAvailable().then(setProtectedOk).catch(() => setProtectedOk(null)); }, []);

  const runProbe = useCallback((id: string) => {
    setProbes(p => ({ ...p, [id]: { status: "checking" } }));
    void probe(id).then(s => setProbes(p => ({ ...p, [id]: s })));
  }, []);

  // Probe every secret when the list loads, and any secret added since. Keyed
  // on the id list so editing a host does not re-read the Keychain. A secret
  // still being saved is skipped (onAdd probes it once the save lands): the
  // list updates optimistically, and probing it then raced settings_save.
  const savingIds = useRef(new Set<string>());
  const idsKey = secrets.map(s => s.id).join("\n");
  useEffect(() => {
    for (const id of idsKey ? idsKey.split("\n") : []) {
      if (!probes[id] && !savingIds.current.has(id)) runProbe(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, runProbe]);
  useEffect(() => { secretsExposed().then(setExposed).catch(() => setExposed([])); }, []);

  // Task counts per role, for "Used by". Settings is an overlay that only
  // mounts while open, so this subscription costs nothing the rest of the time.
  const tasks = useApp(s => s.tasks);
  const projects = useApp(s => s.projects);
  const agents = useApp(s => s.agents);
  const byRole = useMemo(() => tasksByRole(tasks, projects, agents, roles), [tasks, projects, agents, roles]);

  /** Rename is a label edit: the Keychain item is keyed by id (or is gh's,
   *  or one the user named), so nothing moves. Returns the problem that
   *  refused it, or null once it is saved or there was nothing to save. */
  function rename(s: SecretDef, draft: string): "name" | "nameTaken" | null {
    const name = draft.trim();
    if (name === s.name) return null;
    const p = secretProblem({ ...s, name }, secrets.filter(x => x.id !== s.id));
    if (p === "name" || p === "nameTaken") return p;
    void model.save({ secrets: secrets.map(x => x.id === s.id ? { ...x, name } : x) });
    return null;
  }

  async function remove(s: SecretDef) {
    const using = roles.filter(r => r.secrets.includes(s.id));
    // a pasted value is Termic's to delete (settings_save does); an item
    // another tool owns stays.
    const where = storedIn(s);
    const token = where.by === "termic" && where.what === "token";
    const lead = where.by !== "termic"
      ? t("manage.secrets.remove.keep")
      : where.store === "protected"
        ? token ? t("manage.secrets.remove.deleteProtectedToken") : t("manage.secrets.remove.deleteProtectedKey")
        : token ? t("manage.secrets.remove.deleteLoginToken") : t("manage.secrets.remove.deleteLoginKey");
    const roleLine = using.length === 0
      ? t("manage.secrets.remove.unused")
      : using.length === 1
        ? t("manage.secrets.remove.used_one", { count: 1 })
        : t("manage.secrets.remove.used_other", { count: using.length });
    let message = t("manage.secrets.remove.join", { a: lead, b: roleLine });
    if (token) message = t("manage.secrets.remove.join", { a: message, b: t("manage.secrets.remove.revoke") });
    const ok = await useUI.getState().askConfirm({
      title: t("manage.secrets.remove.title", { name: s.name }),
      message,
      confirmLabel: t("manage.secrets.remove.confirm"),
      destructive: true,
    });
    if (!ok) return;
    await model.save({
      secrets: secrets.filter(x => x.id !== s.id),
      roles: roles.map(r => r.secrets.includes(s.id)
        ? { ...r, secrets: r.secrets.filter(x => x !== s.id), rule_sets: r.rule_sets.filter(rs => rs.secret !== s.id) }
        : r),
    });
    setOpen(null);
  }

  return (
    <div className="flex flex-col gap-6">
      {protectedOk === false && (
        <div data-testid="secrets-unsigned" className="flex gap-3 rounded-lg border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-4 py-3.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" />
          <div className="min-w-0">
            <div className="text-[14px] font-medium">{t("manage.secrets.unsigned.title")}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
              {t("manage.secrets.unsigned.body")}
              <InfoTip text={t("manage.secrets.unsigned.tip")} />
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <HealthCard secrets={secrets} probes={probes} />
        {exposed.length > 0 && (
          <ExposedCard exposed={exposed} onAdd={v => setAdding({ fromVar: v })} />
        )}
      </div>

      <div className="flex items-center justify-between">
        <Eyebrow className="flex items-center gap-1.5">
          {t("manage.secrets.heading", { count: secrets.length })}
          <InfoTip text={t("manage.secrets.headingTip")} />
        </Eyebrow>
        <Button variant="primary" data-testid="secrets-add" onClick={() => setAdding({})}>
          <Plus className="h-4 w-4" /> {t("manage.secrets.add")}
        </Button>
      </div>

      {secrets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6 text-[13px] text-[var(--color-fg-dim)]">
          {t("manage.secrets.empty")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
          <table className="w-full table-fixed text-left text-[13px]" data-testid="secrets-table">
            <thead className="bg-[var(--color-bg-1)] text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
              <tr>
                <th className="w-[22%] px-3 py-2.5 font-medium">{t("manage.secrets.colName")}</th>
                <th className="w-[17%] px-3 py-2.5 font-medium">{t("manage.secrets.colStoredIn")}</th>
                <th className="w-[14%] px-3 py-2.5 font-medium">{t("manage.secrets.colDelivered")}</th>
                <th className="w-[19%] px-3 py-2.5 font-medium">{t("manage.secrets.colHosts")}</th>
                <th className="w-[15%] px-3 py-2.5 font-medium">{t("manage.secrets.colUsedBy")}</th>
                <th className="w-[13%] px-3 py-2.5 font-medium">{t("manage.secrets.colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {secrets.map(s => {
                const using = roles.filter(r => r.secrets.includes(s.id));
                const isOpen = open === s.id;
                return (
                  <Fragment key={s.id}>
                    <tr
                      data-secret-row={s.name}
                      onClick={() => setOpen(isOpen ? null : s.id)}
                      className="group cursor-pointer border-t border-[var(--color-border-soft)] align-top hover:bg-[var(--color-hover)]"
                    >
                      <td className="px-3 py-3 font-medium">
                        {renaming === s.id ? (
                          <RenameInput secret={s} onRename={name => rename(s, name)} onDone={() => setRenaming(null)} />
                        ) : (
                          <span className="flex items-start gap-1.5">
                            {isOpen
                              ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                              : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
                            {/* wraps, never truncates: the name is how you tell secrets apart */}
                            <span data-testid="secret-name" className="min-w-0 wrap-anywhere">{s.name}</span>
                            <button
                              type="button"
                              data-testid="secret-rename"
                              aria-label={t("manage.secrets.rename.pencil", { name: s.name })}
                              title={t("manage.secrets.row.rename")}
                              onClick={e => { e.stopPropagation(); setRenaming(s.id); }}
                              className="mt-0.5 shrink-0 rounded p-0.5 text-[var(--color-fg-faint)] opacity-0 hover:text-[var(--color-fg)] focus-visible:opacity-100 group-hover:opacity-100"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3" data-col="stored"><StoredInCell secret={s} /></td>
                      <td className="px-3 py-3" data-col="delivered">
                        <div className="flex flex-wrap gap-1">{deliveredAs(s).map(d => <DeliveryChip key={d.via} d={d} />)}</div>
                      </td>
                      <td className="px-3 py-3 font-mono text-[12.5px] text-[var(--color-fg-dim)]">{s.hosts.map(h => <div key={h} className="truncate" title={h}>{h}</div>)}</td>
                      <td className="px-3 py-3">
                        {using.length === 0
                          ? <span className="text-[var(--color-fg-faint)]">{t("manage.secrets.noRole")}</span>
                          : using.map(r => {
                            const n = byRole.get(r.id)?.length ?? 0;
                            return (
                              <div key={r.id} className="flex items-center gap-1.5">
                                <RoleDot colour={r.colour} />
                                <span className="truncate">{n === 1
                                  ? t("manage.secrets.usedBy_one", { role: r.name, count: n })
                                  : t("manage.secrets.usedBy_other", { role: r.name, count: n })}</span>
                              </div>
                            );
                          })}
                      </td>
                      <td className="px-3 py-3"><StatusCell probe={probes[s.id]} /></td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
                        <td colSpan={6} className="px-4 py-4">
                          <ExpandedRow
                            secret={s}
                            testing={probes[s.id]?.status === "checking"}
                            onHosts={hosts => void model.save({ secrets: secrets.map(x => x.id === s.id ? { ...x, hosts } : x) })}
                            onTest={() => runProbe(s.id)}
                            onShowActivity={() => onShowActivity(s.id)}
                            onRemove={() => void remove(s)}
                            onReplace={() => setReplacing(s)}
                            onRename={() => setRenaming(s.id)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddSecretDialog
          existing={secrets}
          fromVar={adding.fromVar}
          fromPreset={adding.preset}
          onClose={() => setAdding(null)}
          protectedOk={protectedOk}
          onAdd={async s => {
            savingIds.current.add(s.id);
            const ok = await model.save({ secrets: [...secrets, s] });
            savingIds.current.delete(s.id);
            if (ok) {
              setAdding(null);
              runProbe(s.id);
            }
            return ok;
          }}
        />
      )}

      {replacing && (
        <ReplaceDialog
          secret={replacing}
          onClose={() => setReplacing(null)}
          onReplaced={async kind => {
            // the item moved stores (a signed build replacing a login-keychain
            // value): the secret must say where it is now, or reads miss it.
            if (kind !== replacing.kind) {
              await model.save({ secrets: secrets.map(x => x.id === replacing.id ? { ...x, kind } : x) });
            }
            setReplacing(null);
            runProbe(replacing.id);
          }}
        />
      )}
    </div>
  );
}

// status is only "can Termic read it": whether a role uses it is the Used by
// column's job, and folding that in here hid the result of Test access.
function StatusCell({ probe }: { probe: Probe | undefined }) {
  const { t } = useTranslation("secrets");
  const st = probe?.status ?? "checking";
  const look: Record<string, { cls: string; icon?: React.ReactNode }> = {
    readable: { cls: "text-[var(--color-ok)]", icon: <Check className="h-3.5 w-3.5" /> },
    locked: { cls: "text-[var(--color-warn)]", icon: <Lock className="h-3.5 w-3.5" /> },
    missing: { cls: "text-[var(--color-err)]", icon: <AlertTriangle className="h-3.5 w-3.5" /> },
    denied: { cls: "text-[var(--color-err)]", icon: <AlertTriangle className="h-3.5 w-3.5" /> },
    error: { cls: "text-[var(--color-fg-faint)]" },
    checking: { cls: "text-[var(--color-fg-faint)]" },
  };
  const l = look[st] ?? look.error;
  return (
    <span
      data-status={st}
      title={probe?.status === "error" ? probe.detail : undefined}
      className={cn("inline-flex items-center gap-1.5", l.cls)}
    >
      {l.icon}{t(`manage.secrets.status.${st in look ? st : "error"}`)}
    </span>
  );
}

/** The table's "Stored in" cell: who holds the value, and a faint line on
 *  what it is. */
function StoredInCell({ secret }: { secret: SecretDef }) {
  const { t } = useTranslation("secrets");
  const w = storedIn(secret);
  let main: React.ReactNode, sub: string;
  if (w.by === "termic") {
    main = (
      <span className="inline-flex items-center gap-1.5" data-stored={w.store}>
        <Lock className={cn("h-3.5 w-3.5 shrink-0", w.store === "protected" ? "text-[var(--color-fg-dim)]" : "text-[var(--color-warn)]")} />
        {w.store === "protected" ? t("manage.secrets.stored.termicProtected") : t("manage.secrets.stored.termicLogin")}
      </span>
    );
    sub = w.what === "token" ? t("manage.secrets.stored.pastedToken") : t("manage.secrets.stored.pastedKey");
  } else if (w.by === "gh") {
    main = <span data-stored="gh">{t("manage.secrets.stored.gh", { account: w.account })}</span>;
    sub = t("manage.secrets.stored.keptByGh");
  } else {
    main = <span data-stored="item" className="font-mono text-[12.5px]">{t("manage.secrets.stored.item", { service: w.service, account: w.account })}</span>;
    sub = t("manage.secrets.stored.itemNote");
  }
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <div>{main}</div>
      <div className="text-[12px] text-[var(--color-fg-faint)]">{sub}</div>
    </div>
  );
}

/** Rotate an owned secret's value in place. `secret_store` overwrites, so
 *  the definition only changes if the value landed in a different store. */
function ReplaceDialog({ secret, onClose, onReplaced }: {
  secret: SecretDef; onClose: () => void; onReplaced: (kind: "protected" | "generic") => void | Promise<void>;
}) {
  const { t } = useTranslation("secrets");
  const token = secret.recipe === "github";
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const kind = await secretStore(secret.id, secret.name, value);
      await onReplaced(kind);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }
  return (
    <AppDialog
      open
      onOpenChange={v => { if (!v) onClose(); }}
      title={token ? t("manage.secrets.replace.titleToken", { name: secret.name }) : t("manage.secrets.replace.titleKey", { name: secret.name })}
      description={token ? t("manage.secrets.replace.bodyToken") : t("manage.secrets.replace.bodyKey")}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4" data-testid="replace-secret-dialog">
        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{token ? t("manage.secrets.replace.fieldToken") : t("manage.secrets.replace.fieldKey")}</span>
          <Input data-testid="replace-secret-value" type="password" autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} className="font-mono" />
          <span className="text-[12px] text-[var(--color-fg-dim)]">{token ? t("manage.secrets.replace.hintToken") : t("manage.secrets.replace.hintKey")}</span>
        </label>
        <div className="flex items-center justify-end gap-2">
          {error && (
            <span data-testid="replace-secret-problem" className="mr-auto text-[12.5px] text-[var(--color-err)]">
              {t("manage.add.storeFailed", { error })}
            </span>
          )}
          <Button onClick={onClose}>{t("common:cancel")}</Button>
          <Button variant="primary" data-testid="replace-secret-submit" disabled={busy || !value.trim()} onClick={() => void submit()}>
            {t("manage.secrets.replace.submit")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}

function HealthCard({ secrets, probes }: { secrets: SecretDef[]; probes: Record<string, Probe> }) {
  const { t } = useTranslation("secrets");
  const done = secrets.map(s => ({ s, p: probes[s.id] })).filter(x => x.p && x.p.status !== "checking");
  const ok = done.filter(x => x.p!.status === "readable").length;
  const bad = done.find(x => x.p!.status !== "readable");
  let detail: string;
  if (secrets.length === 0) detail = t("manage.secrets.health.none");
  else if (!bad) detail = t("manage.secrets.health.checkedNow");
  else {
    const p = bad.p as SecretStatus;
    detail = p.status === "error"
      ? t("manage.secrets.health.error", { name: bad.s.name, detail: p.detail })
      : t(`manage.secrets.health.${p.status}`, { name: bad.s.name });
  }
  return (
    <div data-testid="secrets-health" className="flex gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] px-4 py-3.5">
      {bad
        ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" />
        : <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-ok)]" />}
      <div className="min-w-0">
        <div className="text-[14px] font-medium">{t("manage.secrets.health.allReadable", { ok, total: secrets.length })}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{detail}</div>
      </div>
    </div>
  );
}

function ExposedCard({ exposed, onAdd }: { exposed: SecretExposure[]; onAdd: (varName: string) => void }) {
  const { t } = useTranslation("secrets");
  const agents = useApp(s => s.agents);
  const first = exposed[0];
  const agentName = agents.find(a => a.id === first.agent_id)?.display_name ?? first.agent_id;
  return (
    <div data-testid="secrets-exposed" className="flex gap-3 rounded-lg border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-4 py-3.5">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" />
      <div className="min-w-0">
        <div className="text-[14px] font-medium">
          {exposed.length === 1
            ? t("manage.secrets.exposed.title_one", { count: 1 })
            : t("manage.secrets.exposed.title_other", { count: exposed.length })}
        </div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("manage.secrets.exposed.agentEnv", { agent: agentName, var: first.var_name })}
        </div>
        <button
          type="button"
          data-testid="secrets-exposed-add"
          onClick={() => onAdd(first.var_name)}
          className="mt-1 text-[12.5px] text-[var(--color-accent)] underline underline-offset-2 hover:brightness-110"
        >
          {t("manage.secrets.exposed.action")}
        </button>
      </div>
    </div>
  );
}

/** A "Delivered as" chip for one active route (model.ts `deliveredAs`). */
function DeliveryChip({ d }: { d: Delivery }) {
  const { t } = useTranslation("secrets");
  const label = d.via === "gh" ? t("manage.secrets.delivered.gh")
    : d.via === "git" ? t("manage.secrets.delivered.git")
    : d.via === "baseUrl" ? t("manage.secrets.delivered.baseUrl", { var: d.env })
    : t("manage.secrets.delivered.proxy");
  return (
    <span data-delivered={d.via} className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-px font-mono text-[11.5px] [overflow-wrap:anywhere]">
      {label}
    </span>
  );
}

/** The name cell while renaming. Enter or blur saves, Esc cancels; an empty
 *  or taken name is refused in place and the field stays open. */
function RenameInput({ secret, onRename, onDone }: {
  secret: SecretDef; onRename: (name: string) => "name" | "nameTaken" | null; onDone: () => void;
}) {
  const { t } = useTranslation("secrets");
  const [draft, setDraft] = useState(secret.name);
  const [problem, setProblem] = useState<"name" | "nameTaken" | null>(null);
  // Enter and Esc unmount the field, and a blur fired by that must not
  // commit a second time.
  const settled = useRef(false);
  const commit = () => {
    if (settled.current) return;
    const p = onRename(draft);
    if (p) { setProblem(p); return; }
    settled.current = true;
    onDone();
  };
  return (
    <span className="flex min-w-0 flex-col gap-1" onClick={e => e.stopPropagation()}>
      <Input
        autoFocus
        value={draft}
        onChange={e => { setDraft(e.target.value); setProblem(null); }}
        onFocus={e => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          // stop here, or Settings' own Esc handler arms its close
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); settled.current = true; onDone(); }
        }}
        aria-label={t("manage.secrets.rename.label")}
        aria-invalid={problem !== null}
        data-testid="secret-rename-input"
        className="h-7 px-2 text-[13px]"
      />
      {problem && (
        <span data-testid="secret-rename-problem" className="text-[12px] font-normal text-[var(--color-err)]">
          {problem === "name" ? t("manage.add.problem.name") : t("manage.add.problem.nameTaken")}
        </span>
      )}
    </span>
  );
}

function ExpandedRow({ secret, testing, onHosts, onTest, onShowActivity, onRemove, onReplace, onRename }: {
  secret: SecretDef; testing: boolean;
  onHosts: (h: string[]) => void; onTest: () => void; onShowActivity: () => void; onRemove: () => void; onReplace: () => void; onRename: () => void;
}) {
  const { t } = useTranslation("secrets");
  const where = storedIn(secret);
  const api = secret.recipe === "api_key" ? secret.api : undefined;
  const base = deliveredAs(secret).find((d): d is Extract<Delivery, { via: "baseUrl" }> => d.via === "baseUrl");
  const code = <code className="font-mono text-[12px] text-[var(--color-fg)]" />;
  const step = "flex min-w-0 flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-[12.5px] text-[var(--color-fg-dim)] [overflow-wrap:anywhere]";
  const title = "font-medium text-[var(--color-fg)]";
  return (
    <div className="flex flex-col gap-4" data-testid="secret-expanded">
      {/* where the value lives, what the agent holds instead, and where the
          real one goes back in */}
      <div className="grid grid-cols-3 gap-3">
        <div className={step} data-testid="secret-stored-box" data-stored={where.by === "termic" ? where.store : where.by}>
          <Eyebrow>{t("manage.secrets.row.step1")}</Eyebrow>
          {where.by === "termic" ? <>
            <span className={cn("flex items-center gap-1.5", title)}>
              <Lock className={cn("h-3.5 w-3.5 shrink-0", where.store === "protected" ? "text-[var(--color-fg-dim)]" : "text-[var(--color-warn)]")} />
              {where.store === "protected" ? t("manage.secrets.row.storedProtected") : t("manage.secrets.row.storedLogin")}
            </span>
            {where.store === "protected"
              ? <span className="flex items-center gap-1.5">{t("manage.secrets.row.storedProtectedNote")}<InfoTip text={t("manage.secrets.row.storedProtectedTip")} /></span>
              : <span>{t("manage.secrets.row.storedLoginNote")}</span>}
          </> : where.by === "gh" ? <>
            <span className={title}>{t("manage.secrets.row.storedGh")}</span>
            <span className="flex items-center gap-1.5">
              <span><Trans t={t} i18nKey="manage.secrets.row.pinned" values={{ account: where.account }} components={{ 1: code }} /></span>
              <InfoTip text={t("manage.secrets.row.pinnedTip")} />
            </span>
          </> : <>
            <span className={title}>{t("manage.secrets.row.storedItem")}</span>
            <span><Trans t={t} i18nKey="manage.secrets.row.item" values={{ service: where.service, account: where.account }} components={{ 1: code, 2: code }} /></span>
          </>}
        </div>
        <div className={step}>
          <Eyebrow>{t("manage.secrets.row.step2")}</Eyebrow>
          <span className={title}>
            {api
              ? <Trans t={t} i18nKey="manage.secrets.row.agentGetsEnv" values={{ var: api.env }} components={{ 1: code, 2: code }} />
              : <Trans t={t} i18nKey="manage.secrets.row.agentGets" components={{ 1: code }} />}
          </span>
          <span className="flex items-center gap-1.5">{t("manage.secrets.row.fresh")}<InfoTip text={t("manage.secrets.row.freshTip")} /></span>
          {base && <span><Trans t={t} i18nKey="manage.secrets.row.endpoint" values={{ var: base.env }} components={{ 1: code }} /></span>}
        </div>
        <div className={step}>
          <Eyebrow>{t("manage.secrets.row.step3")}</Eyebrow>
          <span className={title}>{t("manage.secrets.row.swapped")}</span>
          <span>
            {api
              ? <Trans t={t} i18nKey="manage.secrets.row.swappedHeader" values={{ header: api.scheme ? `${api.header}: ${api.scheme} …` : `${api.header}: …` }} components={{ 1: code }} />
              : t("manage.secrets.row.swappedHosts")}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
          {t("manage.secrets.row.hosts")}
          <InfoTip text={t("manage.secrets.row.hostsTip", { name: secret.name })} />
        </span>
        <HostChips hosts={secret.hosts} onChange={onHosts} testid="secret-hosts" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onTest} disabled={testing} data-testid="secret-test">
          {testing ? t("manage.secrets.row.testing") : t("manage.secrets.row.test")}
        </Button>
        <InfoTip text={t(where.by === "termic" ? "manage.secrets.row.testNoteOwned" : where.by === "gh" ? "manage.secrets.row.testNoteGh" : "manage.secrets.row.testNote")} />
        <Button size="sm" onClick={onShowActivity} data-testid="secret-activity">{t("manage.secrets.row.showActivity")}</Button>
        {where.by === "termic" && (
          <Button size="sm" onClick={onReplace} data-testid="secret-replace">
            {where.what === "token" ? t("manage.secrets.row.replaceToken") : t("manage.secrets.row.replaceKey")}
          </Button>
        )}
        <Button size="sm" onClick={onRename} data-testid="secret-rename-button">{t("manage.secrets.row.rename")}</Button>
        <Button size="sm" variant="danger" className="ml-auto" onClick={onRemove} data-testid="secret-remove">{t("manage.secrets.row.remove")}</Button>
      </div>
    </div>
  );
}
