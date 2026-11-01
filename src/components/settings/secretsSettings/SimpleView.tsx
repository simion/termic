// The role editor's Simple tab: one section per secret, checkboxes for a
// GitHub secret, a level per host for an API key, and a banner for a secret
// whose rules were edited by hand. Every change compiles straight into the
// role's rule_sets (simpleRole.ts).

import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import type { Role, SecretDef, SimpleCfg } from "@/lib/types";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils";
import { putRuleSet, ruleSetFor } from "./model";
import { CommitInput, Eyebrow, InfoTip } from "./parts";
import { CAPS, HOST_LEVELS, applySimple, kindOf, levelOf, scopeRepos, simpleState, starterCfg, type Extra } from "./simpleRole";

const note = (k: string) => i18n.t(`secrets:${k}`);
const select = "h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]";

export function SimpleView({ role, secrets, onSave, onOpenRules }: {
  role: Role; secrets: SecretDef[]; onSave: (r: Role) => void; onOpenRules: () => void;
}) {
  const { t } = useTranslation("secrets");
  const list = role.secrets.map(id => secrets.find(s => s.id === id)).filter((s): s is SecretDef => !!s);
  if (!list.length) return <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.noSecrets")}</div>;
  return (
    <div className="flex flex-col gap-4">
      {list.map(s => <SecretSection key={s.id} role={role} secret={s} onSave={onSave} onOpenRules={onOpenRules} />)}
    </div>
  );
}

function SecretSection({ role, secret: s, onSave, onOpenRules }: {
  role: Role; secret: SecretDef; onSave: (r: Role) => void; onOpenRules: () => void;
}) {
  const { t } = useTranslation("secrets");
  const st = simpleState(role, s);
  const gh = s.recipe === "github";
  const set = (cfg: SimpleCfg) => onSave(applySimple(role, s, cfg, note));

  async function reset() {
    // nothing to lose when the secret has no rules yet: skip the question.
    const hand = role.rule_sets.some(r => r.secret === s.id && r.rules.length > 0);
    if (hand && !await useUI.getState().askConfirm({
      title: t("manage.simple.resetTitle", { secret: s.name }),
      message: t("manage.simple.resetMessage"),
      confirmLabel: t("manage.simple.reset"),
    })) return;
    set(st.cfg ?? starterCfg("readonly", s));
  }

  const head = (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="font-mono text-[13.5px] font-medium">{s.name}</span>
      <span className="text-[12px] text-[var(--color-fg-dim)]">
        {gh ? t("manage.simple.github") : t("manage.simple.apiKey")} · {s.hosts.length === 1 ? t("manage.simple.hosts_one", { count: 1 }) : t("manage.simple.hosts_other", { count: s.hosts.length })}
      </span>
      <span className="flex-1" />
      <span className={cn("rounded-full border px-2 py-0.5 text-[11.5px]", st.custom ? "border-[var(--color-warn)]/50 text-[var(--color-warn)]" : "border-[var(--color-border)] text-[var(--color-fg-dim)]")}>
        {st.custom ? t("manage.simple.modeCustom") : t("manage.simple.modeSimple")}
      </span>
    </div>
  );

  const shell = (body: React.ReactNode) => (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-4" data-simple-secret={s.name} data-custom={st.custom || undefined}>
      {head}
      {body}
    </div>
  );

  if (st.custom || !st.cfg) {
    return shell(
      <div data-testid="simple-custom" className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2.5 text-[12.5px]">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
        <span className="min-w-0 flex-1">{t("manage.simple.custom")}</span>
        <Button size="sm" onClick={() => void reset()} data-testid="simple-reset">{t("manage.simple.reset")}</Button>
        <Button size="sm" variant="ghost" onClick={onOpenRules} data-testid="simple-open-rules">{t("manage.simple.openRules")}</Button>
      </div>,
    );
  }

  const cfg = st.cfg;
  const levelHosts = s.hosts.filter(h => ["key", "other"].includes(kindOf(s, h)));
  const levels = levelHosts.length > 0 && (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[13px] font-medium">
        {gh ? t("manage.simple.otherHosts") : t("manage.simple.hostsLabel")}
        {gh && <InfoTip text={t("manage.simple.otherHostsTip")} />}
      </span>
      {levelHosts.map(h => (
        <label key={h} className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{h}</span>
          <select className={select} data-simple-level={h} value={levelOf(s, h, cfg)}
            onChange={e => set({ ...cfg, other: { ...cfg.other, [h]: e.target.value as SimpleCfg["other"][string] } })}>
            {HOST_LEVELS.map(l => <option key={l} value={l}>{t(`manage.simple.level.${l}`)}</option>)}
          </select>
        </label>
      ))}
    </div>
  );

  const removeExtra = (x: Extra) => {
    const saved = ruleSetFor(role, s.id, x.host);
    onSave(putRuleSet(role, { ...saved, rules: saved.rules.filter((_, i) => i !== x.index) }));
  };
  const extras = st.extras.length > 0 && (
    <div className="flex flex-col gap-1.5" data-testid="simple-extras">
      <span className="flex items-center gap-1.5 text-[13px] font-medium">
        {t("manage.simple.extras", { count: st.extras.length })}
        <InfoTip text={t("manage.simple.extrasTip")} />
      </span>
      {st.extras.map(x => (
        <div key={`${x.host}#${x.index}`} data-simple-extra={`${x.host} ${x.rule.methods.join(",")} ${x.rule.pattern}`}
          className="flex items-center gap-2 rounded-md border border-[var(--color-border-soft)] px-2.5 py-1.5 text-[12.5px]">
          <span className="min-w-0 flex-1 break-all">
            <span className="font-mono">{x.rule.methods.join(" ")} {x.rule.pattern}</span>
            <span className="text-[var(--color-fg-dim)]"> {t("manage.simple.extraOn", { host: x.host })}{x.rule.note ? ` · ${x.rule.note}` : ""}</span>
          </span>
          <button type="button" aria-label={t("manage.simple.removeExtra")} title={t("manage.simple.removeExtra")} onClick={() => removeExtra(x)}
            className="rounded p-0.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );

  if (!gh) {
    return shell(
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,260px)]">
        <div className="flex min-w-0 flex-col gap-3">{levels}{extras}</div>
        <Summary>
          {s.hosts.map(h => <div key={h}>{t(`manage.simple.keyPlain.${levelOf(s, h, cfg)}`, { host: h })}</div>)}
          <div className="text-[var(--color-fg-dim)]">{t("manage.simple.keyMore")}</div>
        </Summary>
      </div>,
    );
  }

  const has = (id: string) => cfg.caps.includes(id);
  const toggleCap = (id: string, on: boolean) => set({ ...cfg, caps: on ? [...cfg.caps, id] : cfg.caps.filter(c => c !== id) });
  const scoped = cfg.scope.trim() !== "";
  const yes = CAPS.filter(c => has(c.id)), no = CAPS.filter(c => !has(c.id));
  const n = st.extras.length;
  return shell(
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,260px)]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <label className="flex min-w-[200px] flex-1 flex-col gap-1">
            <span className="text-[13px] font-medium">{t("manage.simple.scope")}</span>
            <CommitInput data-testid="simple-scope" className="font-mono" value={cfg.scope} placeholder={t("manage.simple.scopePlaceholder")}
              onCommit={v => set({ ...cfg, scope: v.trim() })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">{t("manage.simple.fallback")}</span>
            <select className={select} data-testid="simple-fallback" value={cfg.fallback} onChange={e => set({ ...cfg, fallback: e.target.value as SimpleCfg["fallback"] })}>
              <option value="deny">{t("manage.simple.refuse")}</option>
              <option value="allow">{t("manage.simple.allow")}</option>
            </select>
          </label>
        </div>
        <div className="flex flex-col divide-y divide-[var(--color-border-soft)] rounded-md border border-[var(--color-border-soft)]">
          <CapRow checked={cfg.guard} onChange={v => set({ ...cfg, guard: v })} label={t("manage.simple.guard")} how={t("manage.simple.guardHow")}
            tag={t("manage.simple.guardTag")} attr="guard" />
          {CAPS.map(c => (
            <CapRow key={c.id} checked={has(c.id)} onChange={v => toggleCap(c.id, v)} attr={c.id}
              label={t(`manage.simple.cap.${c.id}.label`)} how={t(`manage.simple.cap.${c.id}.how`)} tag={c.risk ? t("manage.simple.careful") : undefined} risk />
          ))}
        </div>
        {levels}
        {extras}
      </div>
      <Summary>
        <div>{scoped
          ? t("manage.simple.plainWhoScoped", { secret: s.name, repos: scopeRepos(cfg.scope), role: role.name })
          : t("manage.simple.plainWho", { secret: s.name, role: role.name })}</div>
        {(yes.length > 0 || n > 0) && (
          <>
            <div>{t("manage.simple.can")}</div>
            <ul className="list-disc pl-5 text-[var(--color-ok)]">
              {yes.map(c => <li key={c.id}>{t(`manage.simple.cap.${c.id}.label`)}</li>)}
              {n > 0 && <li>{n === 1 ? t("manage.simple.plainExtras_one", { count: n }) : t("manage.simple.plainExtras_other", { count: n })}</li>}
            </ul>
          </>
        )}
        <div>{cfg.fallback === "deny" ? t("manage.simple.cant") : t("manage.simple.canAlso")}</div>
        <ul className="list-disc pl-5 text-[var(--color-err)]">
          {cfg.fallback === "deny" && no.map(c => <li key={c.id}>{t(`manage.simple.cap.${c.id}.label`)}</li>)}
          {cfg.guard && <li>{t("manage.simple.plainGuard")}</li>}
          {cfg.fallback === "deny" && <li>{t("manage.simple.plainElse")}</li>}
        </ul>
        {scoped && ["comment", "prs", "issues", "merge"].some(has) && (
          <Warn testid="simple-warn-graphql">{t("manage.simple.warnGraphql")}</Warn>
        )}
        {cfg.fallback === "allow" && <Warn testid="simple-warn-denylist">{t("manage.simple.warnDenylist")}</Warn>}
      </Summary>
    </div>,
  );
}

function CapRow({ checked, onChange, label, how, tag, attr, risk }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; how: string; tag?: string; attr: string; risk?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <Checkbox checked={checked} onChange={onChange} aria-label={label} data-simple-cap={attr} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        <div className="font-mono text-[11.5px] text-[var(--color-fg-dim)]">{how}</div>
      </div>
      {tag && (
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", risk ? "border-[var(--color-warn)]/50 text-[var(--color-warn)]" : "border-[var(--color-ok)]/50 text-[var(--color-ok)]")}>{tag}</span>
      )}
    </div>
  );
}

function Summary({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("secrets");
  return (
    <div data-testid="simple-summary" className="flex min-w-0 flex-col gap-1.5 self-start rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-3 text-[12.5px]">
      <Eyebrow>{t("manage.simple.plain")}</Eyebrow>
      {children}
    </div>
  );
}

function Warn({ children, testid }: { children: React.ReactNode; testid: string }) {
  return <div data-testid={testid} className="mt-1 rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-2 py-1.5 text-[12px]">{children}</div>;
}
