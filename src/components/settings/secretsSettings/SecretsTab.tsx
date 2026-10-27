// Secrets tab: health cards, the secrets table, the expanded row,
// and the Add secret dialog.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Lock, Plus } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { secretForgetUnsaved, secretProbe, secretStore, secretsExposed, secretsGhAccounts, secretsProtectedAvailable } from "@/lib/ipc";
import type { ApiKeyCfg, SecretDef, SecretExposure, SecretStatus } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { AppDialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { API_KEY_PRESETS, GITHUB_HOSTS, OWNED_ACCOUNT, apiKeyProblem, deliveredAs, ownedService, secretProblem, storedIn, tasksByRole } from "./model";
import type { SecretPreset } from "./model";
import { Eyebrow, HostChips, RoleDot } from "./parts";
import { KeptOutCard } from "./KeptOut";
import type { SecretsModel } from "./SecretsSection";

type Probe = SecretStatus | { status: "checking" };

/** A probe that could not run (command missing, IPC error) is "error", not
 *  a missing row: the table must still say SOMETHING about every secret. */
const probe = (id: string): Promise<SecretStatus> =>
  secretProbe(id).catch(e => ({ status: "error", detail: String(e) }) as SecretStatus);

export function SecretsTab({ model, onShowActivity }: { model: SecretsModel; onShowActivity: (secretId: string) => void }) {
  const { t } = useTranslation("secrets");
  const { secrets, roles } = model;
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [exposed, setExposed] = useState<SecretExposure[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ fromVar?: string; preset?: SecretPreset } | null>(null);
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
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.secrets.unsigned.body")}</div>
          </div>
        </div>
      )}
      <p className="text-[13px] text-[var(--color-fg-dim)]">{t("manage.secrets.intro")}</p>

      <div className="flex flex-col gap-3">
        <HealthCard secrets={secrets} probes={probes} />
        {exposed.length > 0 && (
          <ExposedCard exposed={exposed} onAdd={v => setAdding({ fromVar: v })} />
        )}
        <KeptOutCard onAddSecret={(v, preset) => setAdding({ fromVar: v, preset })} />
      </div>

      <div className="flex items-center justify-between">
        <Eyebrow>{t("manage.secrets.heading", { count: secrets.length })}</Eyebrow>
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
                <th className="w-[15%] px-3 py-2.5 font-medium">{t("manage.secrets.colName")}</th>
                <th className="w-[22%] px-3 py-2.5 font-medium">{t("manage.secrets.colStoredIn")}</th>
                <th className="w-[11%] px-3 py-2.5 font-medium">{t("manage.secrets.colDelivered")}</th>
                <th className="w-[20%] px-3 py-2.5 font-medium">{t("manage.secrets.colHosts")}</th>
                <th className="w-[18%] px-3 py-2.5 font-medium">{t("manage.secrets.colUsedBy")}</th>
                <th className="w-[14%] px-3 py-2.5 font-medium">{t("manage.secrets.colStatus")}</th>
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
                      className="cursor-pointer border-t border-[var(--color-border-soft)] align-top hover:bg-[var(--color-hover)]"
                    >
                      <td className="px-3 py-3 font-medium">
                        <span className="flex items-center gap-1.5">
                          {isOpen
                            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
                          <span className="truncate">{s.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-3" data-col="stored"><StoredInCell secret={s} /></td>
                      <td className="px-3 py-3 [overflow-wrap:anywhere]" data-col="delivered">{deliveredAs(s).join(", ")}</td>
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
                      <td className="px-3 py-3"><StatusCell probe={probes[s.id]} unused={using.length === 0} /></td>
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

function StatusCell({ probe, unused }: { probe: Probe | undefined; unused: boolean }) {
  const { t } = useTranslation("secrets");
  const st = probe?.status ?? "checking";
  // An unused secret that reads fine has nothing to say beyond "unused"; one
  // that does NOT read still shows why, so it can be fixed before it is used.
  if (unused && st === "readable") {
    return <span data-status="unused" className="text-[var(--color-fg-faint)]">{t("manage.secrets.status.unused")}</span>;
  }
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

function ExpandedRow({ secret, testing, onHosts, onTest, onShowActivity, onRemove, onReplace }: {
  secret: SecretDef; testing: boolean;
  onHosts: (h: string[]) => void; onTest: () => void; onShowActivity: () => void; onRemove: () => void; onReplace: () => void;
}) {
  const { t } = useTranslation("secrets");
  const where = storedIn(secret);
  const code = <code className="font-mono text-[12px] text-[var(--color-fg)]" />;
  const chip = "rounded-full border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2.5 py-0.5 text-[12px]";
  return (
    <div className="grid grid-cols-2 gap-6" data-testid="secret-expanded">
      <div className="flex min-w-0 flex-col gap-2">
        {where.by === "termic" ? <>
          <Eyebrow>{t("manage.secrets.row.storedIn")}</Eyebrow>
          <div data-testid="secret-stored-box" data-stored={where.store} className="flex min-w-0 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12.5px]">
            <Lock className={cn("h-3.5 w-3.5 shrink-0", where.store === "protected" ? "text-[var(--color-fg-dim)]" : "text-[var(--color-warn)]")} />
            <span className="shrink-0 font-medium">{where.store === "protected" ? t("manage.secrets.row.storeProtected") : t("manage.secrets.row.storeLogin")}</span>
            <span className="min-w-0 truncate font-mono text-[12px] text-[var(--color-fg-faint)]" title={secret.service}>{secret.service}</span>
          </div>
          <p className="text-[12.5px] text-[var(--color-fg-dim)]">
            {where.store === "login"
              ? t("manage.secrets.row.ownedLogin")
              : <Trans t={t} i18nKey={where.what === "token" ? "manage.secrets.row.ownedProtectedToken" : "manage.secrets.row.ownedProtectedKey"} components={{ 1: code }} />}
          </p>
        </> : <>
          <Eyebrow>{t("manage.secrets.row.keychainItem")}</Eyebrow>
          <pre className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12.5px] leading-relaxed">
            {`service ${secret.service}\naccount ${secret.account}`}
          </pre>
          <p className="text-[12.5px] text-[var(--color-fg-dim)]">
            <Trans t={t} i18nKey="manage.secrets.row.pinned" values={{ account: secret.account }} components={{ 1: code, 3: code }} />
          </p>
        </>}
        <Eyebrow className="mt-2">{t("manage.secrets.row.placeholder")}</Eyebrow>
        <p className="text-[12.5px] text-[var(--color-fg-dim)]">
          <Trans t={t} i18nKey="manage.secrets.row.placeholderNote" components={{ 1: code }} />
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Eyebrow>{t("manage.secrets.row.deliveredAs")}</Eyebrow>
        <div className="flex flex-wrap gap-1.5">
          {secret.recipe === "github" && <>
            <span className={chip}>{t("manage.secrets.row.deliveredGh")}</span>
            <span className={chip}>{t("manage.secrets.row.deliveredGit")}</span>
          </>}
          {secret.recipe === "api_key" && secret.api && <>
            <span className={chip} data-delivered="env">{t("manage.secrets.row.deliveredEnv", { var: secret.api.env })}</span>
            {secret.api.base_url_env && <span className={chip} data-delivered="base-url">{t("manage.secrets.row.deliveredBaseUrl", { var: secret.api.base_url_env })}</span>}
            <span className={chip} data-delivered="proxy">{t("manage.secrets.row.deliveredProxy")}</span>
          </>}
        </div>
        {secret.recipe === "api_key" && secret.api && (
          <p className="text-[12.5px] text-[var(--color-fg-dim)]">
            <Trans t={t} i18nKey="manage.secrets.row.headerSpot" values={{ header: secret.api.scheme ? `${secret.api.header}: ${secret.api.scheme} …` : `${secret.api.header}: …` }} components={{ 1: code }} />
          </p>
        )}
        <Eyebrow className="mt-2">{t("manage.secrets.row.hosts")}</Eyebrow>
        <HostChips hosts={secret.hosts} onChange={onHosts} testid="secret-hosts" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onTest} disabled={testing} data-testid="secret-test">
            {testing ? t("manage.secrets.row.testing") : t("manage.secrets.row.test")}
          </Button>
          <Button size="sm" onClick={onShowActivity} data-testid="secret-activity">{t("manage.secrets.row.showActivity")}</Button>
          {where.by === "termic" && (
            <Button size="sm" onClick={onReplace} data-testid="secret-replace">
              {where.what === "token" ? t("manage.secrets.row.replaceToken") : t("manage.secrets.row.replaceKey")}
            </Button>
          )}
          <Button size="sm" variant="danger" className="ml-auto" onClick={onRemove} data-testid="secret-remove">{t("manage.secrets.row.remove")}</Button>
        </div>
        <p className="text-[12px] text-[var(--color-fg-faint)]">{t(where.by === "termic" ? "manage.secrets.row.testNoteOwned" : where.by === "gh" ? "manage.secrets.row.testNoteGh" : "manage.secrets.row.testNote")}</p>
      </div>
    </div>
  );
}

const CREATE_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/** Where a GitHub secret's value comes from: a login gh keeps, or a token
 *  pasted into Termic. */
type GhSource = "gh" | "paste";

/** The quiet line under a pasted value: which store it lands in. Nothing
 *  while that is unknown. */
function SavedTo({ protectedOk }: { protectedOk: boolean | null }) {
  const { t } = useTranslation("secrets");
  if (protectedOk === null) return null;
  return (
    <div data-testid="add-secret-saved-to" data-protected={String(protectedOk)} className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-faint)]">
      <Lock className="h-3 w-3 shrink-0" />
      {protectedOk ? t("manage.add.savedProtected") : t("manage.add.savedLogin")}
    </div>
  );
}

function AddSecretDialog({ existing, fromVar, fromPreset, protectedOk, onClose, onAdd }: {
  existing: SecretDef[]; fromVar?: string; fromPreset?: SecretPreset; protectedOk: boolean | null;
  onClose: () => void; onAdd: (s: SecretDef) => Promise<boolean>;
}) {
  const { t } = useTranslation("secrets");
  // opened from a detected API key: start on its preset, not GitHub's
  const initKey = fromPreset && fromPreset !== "github" ? API_KEY_PRESETS[fromPreset] : null;
  const [preset, setPreset] = useState<SecretPreset>(fromPreset ?? "github");
  const [accounts, setAccounts] = useState<{ host: string; user: string; active: boolean }[] | null>(null);
  // null until gh's accounts load (or the user picks), so the body does not
  // flash one source and then swap to the other.
  const [source, setSource] = useState<GhSource | null>(null);
  const sourceTouched = useRef(false);
  const [service, setService] = useState("gh:github.com");
  const [account, setAccount] = useState("");
  const [name, setName] = useState(initKey?.name ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [hosts, setHosts] = useState<string[]>(initKey?.hosts ?? GITHUB_HOSTS);
  const [tried, setTried] = useState(false);
  // a pasted value's id is minted up front because it names the Keychain
  // item the value is written to before the secret is saved.
  const [id] = useState(() => crypto.randomUUID());
  const [value, setValue] = useState("");
  const [api, setApi] = useState<ApiKeyCfg>((initKey ?? API_KEY_PRESETS.openai).api);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isKey = preset !== "github";
  const paste = !isKey && source === "paste";
  const owned = isKey || paste;

  useEffect(() => {
    // v1 brokers github.com only (GHE needs its own recipe rows), so other
    // hosts' logins are not offered.
    secretsGhAccounts()
      .then(list => {
        const gh = list.filter(a => a.host === "github.com");
        setAccounts(gh);
        const pick = gh.find(a => a.active) ?? gh[0];
        if (pick) pickAccount(pick.host, pick.user);
        if (!sourceTouched.current) pickSource(pick ? "gh" : "paste", pick?.user);
      })
      .catch(() => {
        setAccounts([]);
        if (!sourceTouched.current) pickSource("paste");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickAccount(host: string, user: string) {
    setService(`gh:${host}`);
    setAccount(user);
    if (!nameTouched) setName(`gh-${user}`);
  }

  /** `user` is passed by the accounts load, whose `account` state has not
   *  committed yet. */
  function pickSource(src: GhSource, user = account) {
    setSource(src);
    setTried(false);
    setStoreError(null);
    if (!nameTouched) setName(src === "paste" ? "gh-token" : user ? `gh-${user}` : "");
  }

  function pickPreset(p: SecretPreset) {
    setPreset(p);
    setTried(false);
    setStoreError(null);
    if (p === "github") {
      setHosts(GITHUB_HOSTS);
      if (!nameTouched) setName(source === "paste" ? "gh-token" : account ? `gh-${account}` : "");
      return;
    }
    const d = API_KEY_PRESETS[p];
    setApi(d.api);
    setHosts(d.hosts);
    if (!nameTouched) setName(d.name);
  }

  const draft = owned
    ? { name: name.trim(), service: ownedService(id), account: OWNED_ACCOUNT, hosts }
    : { name: name.trim(), service: service.trim(), account: account.trim(), hosts };
  const problem = secretProblem(draft, existing)
    ?? (isKey ? apiKeyProblem(value, hosts, api) : paste && !value.trim() ? "token" : null);
  const setApiField = (k: keyof ApiKeyCfg) => (e: React.ChangeEvent<HTMLInputElement>) => setApi(a => ({ ...a, [k]: e.target.value.trim() }));

  async function submit() {
    setTried(true);
    if (problem || busy || (!isKey && !source)) return;
    if (!owned) {
      void onAdd({ id: crypto.randomUUID(), kind: "generic", recipe: "github", ...draft });
      return;
    }
    setBusy(true);
    setStoreError(null);
    let kind: "protected" | "generic";
    try {
      // the value goes to the Keychain first, so the save that follows (and
      // its probe) finds it there.
      kind = await secretStore(id, draft.name, value);
    } catch (e) {
      setStoreError(String(e));
      setBusy(false);
      return;
    }
    const ok = await onAdd(isKey
      ? { id, kind, recipe: "api_key", ...draft, api }
      : { id, kind, recipe: "github", ...draft });
    // a save that failed leaves an item no secret names. A protected one is
    // invisible to Keychain Access, so nobody could clean it up by hand. A
    // retry stores it again under the same id.
    if (!ok) secretForgetUnsaved(id).catch(() => {});
    setBusy(false);
  }

  const field = "h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]";
  const description = isKey ? t("manage.add.descriptionKey") : paste ? t("manage.add.descriptionPaste") : t("manage.add.description");
  const sourceBtn = (src: GhSource, label: string, sub: string) => (
    <button
      type="button"
      data-testid={`add-secret-source-${src}`}
      aria-pressed={source === src}
      onClick={() => { sourceTouched.current = true; pickSource(src); }}
      className={cn(
        "flex flex-col items-start rounded-lg border px-3 py-2 text-left",
        source === src
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
          : "border-[var(--color-border)] hover:bg-[var(--color-hover)]",
      )}
    >
      <span className="text-[13px] font-medium">{label}</span>
      <span className="text-[12px] text-[var(--color-fg-dim)]">{sub}</span>
    </button>
  );
  return (
    <AppDialog open onOpenChange={v => { if (!v) onClose(); }} title={t("manage.add.title")} description={description} className="max-w-xl">
      <div className="flex flex-col gap-4" data-testid="add-secret-dialog">
        {fromVar && (
          <div className="rounded-md border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2 text-[12.5px]">
            {t("manage.add.fromExposed", { var: fromVar })}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{t("manage.add.preset")}</span>
          <select data-testid="add-secret-preset" value={preset} onChange={e => pickPreset(e.target.value as SecretPreset)} className={field}>
            <option value="github">{t("manage.add.presetGithub")}</option>
            <option value="openai">{t("manage.add.presetOpenai")}</option>
            <option value="anthropic">{t("manage.add.presetAnthropic")}</option>
            <option value="custom">{t("manage.add.presetCustom")}</option>
          </select>
        </label>

        {!isKey && (
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">{t("manage.add.source")}</span>
            <div className="grid grid-cols-2 gap-2" data-testid="add-secret-source">
              {sourceBtn("gh", t("manage.add.sourceGh"), t("manage.add.sourceGhSub"))}
              {sourceBtn("paste", t("manage.add.sourcePaste"), t("manage.add.sourcePasteSub"))}
            </div>
          </div>
        )}

        {isKey && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">{t("manage.add.value")}</span>
              <Input data-testid="add-secret-value" type="password" autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} className="font-mono" />
              <span className="text-[12px] text-[var(--color-fg-dim)]">{t("manage.add.valueHint")}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">{t("manage.add.env")}</span>
              <Input data-testid="add-secret-env" value={api.env} placeholder="OPENAI_API_KEY" onChange={setApiField("env")} className="font-mono" />
              <span className="text-[12px] text-[var(--color-fg-dim)]">{t("manage.add.envHint")}</span>
            </label>
            <div className="flex flex-col gap-1">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[13px] font-medium">{t("manage.add.header")}</span>
                  <Input data-testid="add-secret-header" value={api.header} onChange={setApiField("header")} className="font-mono" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[13px] font-medium">{t("manage.add.scheme")}</span>
                  <Input data-testid="add-secret-scheme" value={api.scheme} onChange={setApiField("scheme")} className="font-mono" />
                </label>
              </div>
              <span className="text-[12px] text-[var(--color-fg-dim)]">{t("manage.add.headerHint")}</span>
            </div>
            <div className="flex flex-col gap-1">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[13px] font-medium">{t("manage.add.baseUrlEnv")}</span>
                  <Input data-testid="add-secret-base-url-env" value={api.base_url_env} onChange={setApiField("base_url_env")} className="font-mono" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[13px] font-medium">{t("manage.add.baseUrl")}</span>
                  <Input data-testid="add-secret-base-url" value={api.base_url} placeholder="https://api.example.com/v1" onChange={setApiField("base_url")} className="font-mono" />
                </label>
              </div>
              <span className="text-[12px] text-[var(--color-fg-dim)]">{t("manage.add.baseUrlHint")}</span>
            </div>
          </>
        )}

        {paste && (
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">{t("manage.add.token")}</span>
              <Input data-testid="add-secret-value" type="password" autoComplete="off" spellCheck={false} value={value} onChange={e => setValue(e.target.value)} className="font-mono" />
            </label>
            <span className="text-[12px] text-[var(--color-fg-dim)]">
              {t("manage.add.valueHint")}{" "}
              <button
                type="button"
                data-testid="add-secret-create-token"
                onClick={() => void openUrl(CREATE_TOKEN_URL).catch(() => {})}
                className="text-[var(--color-accent)] underline underline-offset-2 hover:brightness-110"
              >
                {t("manage.add.createToken")}
              </button>
            </span>
          </div>
        )}

        {!isKey && source === "gh" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-medium">{t("manage.add.account")}</span>
              {accounts && accounts.length > 0 ? (
                <select
                  data-testid="add-secret-account"
                  value={`${service.replace(/^gh:/, "")}\n${account}`}
                  onChange={e => { const [h, u] = e.target.value.split("\n"); pickAccount(h, u); }}
                  className={field}
                >
                  {accounts.map(a => (
                    <option key={`${a.host}/${a.user}`} value={`${a.host}\n${a.user}`}>
                      {a.active ? t("manage.add.accountActive", { user: a.user, host: a.host }) : t("manage.add.accountOther", { user: a.user, host: a.host })}
                    </option>
                  ))}
                </select>
              ) : accounts && (
                <span className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.add.noAccounts")}</span>
              )}
              {accounts && accounts.length > 0 && <span className="text-[12px] text-[var(--color-fg-dim)]">{t("manage.add.accountHint")}</span>}
            </label>

            <details data-testid="add-secret-advanced" className="group">
              <summary className="cursor-pointer select-none text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
                {t("manage.add.advanced")}
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[13px] font-medium">{t("manage.add.service")}</span>
                  <Input data-testid="add-secret-service" value={service} onChange={e => setService(e.target.value)} className="font-mono" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[13px] font-medium">{t("manage.add.accountField")}</span>
                  <Input data-testid="add-secret-keychain-account" value={account} onChange={e => { setAccount(e.target.value); if (!nameTouched) setName(e.target.value ? `gh-${e.target.value}` : ""); }} className="font-mono" />
                </label>
              </div>
            </details>
          </>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{t("manage.add.name")}</span>
          <Input data-testid="add-secret-name" value={name} placeholder={isKey ? t("manage.add.namePlaceholderKey") : t("manage.add.namePlaceholder")} onChange={e => { setName(e.target.value); setNameTouched(true); }} />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{t("manage.add.hosts")}</span>
          <HostChips hosts={hosts} onChange={setHosts} testid="add-secret-hosts" />
          <span className="text-[12px] text-[var(--color-fg-dim)]">{t("manage.add.hostsHint")}</span>
        </div>

        {owned && <SavedTo protectedOk={protectedOk} />}

        <div className="flex items-center justify-end gap-2">
          {(storeError || (tried && problem)) && (
            <span data-testid="add-secret-problem" className="mr-auto text-[12.5px] text-[var(--color-err)]">
              {storeError ? t("manage.add.storeFailed", { error: storeError }) : t(`manage.add.problem.${problem}`)}
            </span>
          )}
          <Button onClick={onClose}>{t("common:cancel")}</Button>
          <Button variant="primary" data-testid="add-secret-submit" disabled={busy} onClick={() => void submit()}>{t("manage.add.submit")}</Button>
        </div>
      </div>
    </AppDialog>
  );
}
