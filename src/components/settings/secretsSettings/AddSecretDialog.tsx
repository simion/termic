// The Add secret dialog: kind, where a GitHub token comes from or an API
// key's fields, name, hosts, and a "What happens" panel showing which broker
// deliveries the secret turns on.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Lock } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { secretForgetUnsaved, secretStore, secretsGhAccounts } from "@/lib/ipc";
import type { ApiKeyCfg, SecretDef } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { AppDialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import {
  AGENT_LOGIN_ENV, API_KEY_PRESETS, GITHUB_HOSTS, OWNED_ACCOUNT, apiKeyProblems, baseUrlHost, deliveries, ownedService, secretProblems,
} from "./model";
import type { DeliveryRoute, SecretPreset } from "./model";
import { Eyebrow, HostChips, InfoTip } from "./parts";

const CREATE_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/** Where a GitHub secret's value comes from: a login gh keeps, a token
 *  pasted into Termic, or a Keychain item that already exists. */
type GhSource = "gh" | "paste" | "item";

/** The fields a problem can sit next to. */
type Field = "name" | "hosts" | "value" | "item" | "gh" | "env" | "header" | "scheme" | "baseUrlEnv" | "baseUrl";
const API_FIELDS: Field[] = ["env", "header", "scheme", "baseUrlEnv", "baseUrl"];

const labelCls = "flex items-center gap-1.5 text-[13px] font-medium";
const hintCls = "text-[12px] text-[var(--color-fg-dim)]";

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

export function AddSecretDialog({ existing, fromVar, fromPreset, protectedOk, onClose, onAdd }: {
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
  const [ghHost, setGhHost] = useState("github.com");
  const [ghUser, setGhUser] = useState("");
  const [itemService, setItemService] = useState("");
  const [itemAccount, setItemAccount] = useState("");
  const [name, setName] = useState(initKey?.name ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [hosts, setHosts] = useState<string[]>(initKey?.hosts ?? GITHUB_HOSTS);
  // a field's problem shows once the field is edited, or after a submit try
  const [tried, setTried] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<Field>>(new Set());
  // a pasted value's id is minted up front because it names the Keychain
  // item the value is written to before the secret is saved.
  const [id] = useState(() => crypto.randomUUID());
  const [value, setValue] = useState("");
  const [api, setApi] = useState<ApiKeyCfg>((initKey ?? API_KEY_PRESETS.openai).api);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
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
        // not pickAccount: this closure's `source` is the mount's null, and
        // naming here would overwrite "gh-token" if Paste was picked meanwhile
        if (pick) { setGhHost(pick.host); setGhUser(pick.user); }
        if (!sourceTouched.current) pickSource(pick ? "gh" : "paste", pick?.user);
      })
      .catch(() => {
        setAccounts([]);
        if (!sourceTouched.current) pickSource("paste");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const touch = (f: Field) => setTouched(s => s.has(f) ? s : new Set(s).add(f));
  const defaultName = (src: GhSource | null, user: string) => src === "paste" ? "gh-token" : src === "gh" && user ? `gh-${user}` : "";

  function pickAccount(host: string, user: string) {
    setGhHost(host);
    setGhUser(user);
    if (!nameTouched) setName(`gh-${user}`);
  }

  /** `user` is passed by the accounts load, whose `ghUser` state has not
   *  committed yet. */
  function pickSource(src: GhSource, user = ghUser) {
    setSource(src);
    setTried(false);
    setTouched(new Set());
    setStoreError(null);
    if (!nameTouched) setName(defaultName(src, user));
  }

  function pickPreset(p: SecretPreset) {
    setPreset(p);
    setTried(false);
    setTouched(new Set());
    setStoreError(null);
    if (p === "github") {
      setHosts(GITHUB_HOSTS);
      if (!nameTouched) setName(defaultName(source, ghUser));
      return;
    }
    const d = API_KEY_PRESETS[p];
    setApi(d.api);
    setHosts(d.hosts);
    if (!nameTouched) setName(d.name);
  }

  const draft = owned
    ? { name: name.trim(), service: ownedService(id), account: OWNED_ACCOUNT, hosts }
    : source === "item"
      ? { name: name.trim(), service: itemService.trim(), account: itemAccount.trim(), hosts }
      : { name: name.trim(), service: `gh:${ghHost}`, account: ghUser, hosts };
  const sp = secretProblems(draft, existing);
  const ap = isKey ? apiKeyProblems(value, hosts, api) : {};
  const problems: Partial<Record<Field, string>> = {
    ...ap,
    name: sp.name,
    hosts: sp.hosts,
    value: isKey ? ap.value : paste && !value.trim() ? "token" : undefined,
    item: source === "item" ? sp.keychain : undefined,
    // no gh account to pin: the no-accounts line already says so
    gh: source === "gh" ? sp.keychain : undefined,
  };
  const blocked = Object.values(problems).some(Boolean);
  // a taken name shows at once: the preset's default name may already exist
  const shown = (f: Field) => problems[f] && (tried || touched.has(f) || problems[f] === "nameTaken") ? problems[f] : null;
  const bu = baseUrlHost(api.base_url);
  const errVars = (f: Field) => ({ var: f === "baseUrlEnv" ? api.base_url_env : api.env, header: api.header, host: bu ?? "" });
  const fieldError = (f: Field) => {
    const k = shown(f);
    return k && f !== "gh" ? (
      <span data-testid={`add-secret-error-${f}`} className="text-[12px] text-[var(--color-err)]">{t(`manage.add.problem.${k}`, errVars(f))}</span>
    ) : null;
  };
  const setApiField = (k: keyof ApiKeyCfg, f: Field) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.trim();
    setApi(a => ({ ...a, [k]: v }));
    touch(f);
  };

  async function submit() {
    setTried(true);
    if (blocked || busy || (!isKey && !source)) return;
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
  const sourceBtn = (src: GhSource, label: string, sub: string) => (
    <button
      type="button"
      data-testid={`add-secret-source-${src}`}
      aria-pressed={source === src}
      onClick={() => { sourceTouched.current = true; pickSource(src); }}
      className={cn(
        "flex min-w-0 flex-col items-start rounded-lg border px-3 py-2 text-left",
        source === src
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
          : "border-[var(--color-border)] hover:bg-[var(--color-hover)]",
      )}
    >
      <span className="text-[13px] font-medium">{label}</span>
      <span className="text-[12px] text-[var(--color-fg-dim)]">{sub}</span>
    </button>
  );
  const valueInput = (
    <Input
      data-testid="add-secret-value" type="password" autoComplete="off" spellCheck={false} value={value}
      placeholder={isKey ? undefined : "github_pat_…"} aria-invalid={!!shown("value")}
      onChange={e => { setValue(e.target.value); touch("value"); }} className="font-mono"
    />
  );
  const apiShown = API_FIELDS.some(f => shown(f));

  return (
    <AppDialog open onOpenChange={v => { if (!v) onClose(); }} title={t("manage.add.title")} className="max-w-3xl">
      <div className="flex flex-col gap-4" data-testid="add-secret-dialog">
        {fromVar && (
          <div data-testid="add-secret-from-var" className="rounded-md border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2 text-[12.5px]">
            {t("manage.add.fromExposed", { var: fromVar })}
          </div>
        )}
        <div className="flex flex-col gap-5 sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className={labelCls}>{t("manage.add.preset")}</span>
              <select data-testid="add-secret-preset" value={preset} onChange={e => pickPreset(e.target.value as SecretPreset)} className={field}>
                <option value="github">{t("manage.add.presetGithub")}</option>
                <option value="openai">{t("manage.add.presetOpenai")}</option>
                <option value="anthropic">{t("manage.add.presetAnthropic")}</option>
                <option value="custom">{t("manage.add.presetCustom")}</option>
              </select>
            </label>

            {!isKey && (
              <div className="flex flex-col gap-1">
                <span className={labelCls}>{t("manage.add.source")}</span>
                <div className="grid grid-cols-3 gap-2" data-testid="add-secret-source">
                  {sourceBtn("gh", t("manage.add.sourceGh"), t("manage.add.sourceGhSub"))}
                  {sourceBtn("paste", t("manage.add.sourcePaste"), t("manage.add.sourcePasteSub"))}
                  {sourceBtn("item", t("manage.add.sourceItem"), t("manage.add.sourceItemSub"))}
                </div>
              </div>
            )}

            {!isKey && source === "gh" && (
              <label className="flex flex-col gap-1">
                <span className={labelCls}>{t("manage.add.account")}<InfoTip text={t("manage.add.accountTip")} /></span>
                {accounts && accounts.length > 0 ? (
                  <select
                    data-testid="add-secret-account"
                    value={`${ghHost}\n${ghUser}`}
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
                  <span data-testid="add-secret-no-accounts" className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.add.noAccounts")}</span>
                )}
              </label>
            )}

            {paste && (
              <div className="flex flex-col gap-1">
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>{t("manage.add.token")}</span>
                  {valueInput}
                </label>
                {fieldError("value")}
                <span className={hintCls}>
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

            {!isKey && source === "item" && (
              <div className="flex flex-col gap-1">
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className={labelCls}>{t("manage.add.service")}</span>
                    <Input data-testid="add-secret-service" value={itemService} placeholder="acme-ci-token" aria-invalid={!!shown("item")} onChange={e => { setItemService(e.target.value); touch("item"); }} className="font-mono" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={labelCls}>{t("manage.add.accountField")}</span>
                    <Input data-testid="add-secret-keychain-account" value={itemAccount} placeholder="ci-bot" aria-invalid={!!shown("item")} onChange={e => { setItemAccount(e.target.value); touch("item"); }} className="font-mono" />
                  </label>
                </div>
                {fieldError("item")}
                <span className={hintCls}>{t("manage.add.itemHint")}</span>
              </div>
            )}

            {isKey && (
              <label className="flex flex-col gap-1">
                <span className={labelCls}>{t("manage.add.value")}</span>
                {valueInput}
                {fieldError("value")}
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className={labelCls}>{t("manage.add.name")}</span>
              <Input
                data-testid="add-secret-name" value={name} aria-invalid={!!shown("name")}
                placeholder={isKey ? t("manage.add.namePlaceholderKey") : t("manage.add.namePlaceholder")}
                onChange={e => { setName(e.target.value); setNameTouched(true); touch("name"); }}
              />
              {fieldError("name")}
            </label>

            <div className="flex flex-col gap-1">
              <span className={labelCls}>{t("manage.add.hosts")}<InfoTip text={t("manage.add.hostsTip")} /></span>
              <HostChips hosts={hosts} onChange={h => { setHosts(h); touch("hosts"); }} testid="add-secret-hosts" />
              {fieldError("hosts")}
              {!isKey && <span className={hintCls}>{t("manage.add.hostsHintGithub")}</span>}
            </div>

            {isKey && (
              <details
                data-testid="add-secret-delivery"
                open={deliveryOpen || preset === "custom" || apiShown}
                onToggle={e => setDeliveryOpen(e.currentTarget.open)}
              >
                <summary className="cursor-pointer select-none text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
                  {t("manage.add.delivery")}
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className={labelCls}>{t("manage.add.env")}</span>
                    <Input data-testid="add-secret-env" value={api.env} placeholder="ACME_API_KEY" aria-invalid={!!shown("env")} onChange={setApiField("env", "env")} className="font-mono" />
                    {fieldError("env")}
                    <span className={hintCls}>{t("manage.add.envHint")}</span>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className={labelCls}>{t("manage.add.header")}</span>
                    <Input data-testid="add-secret-header" value={api.header} aria-invalid={!!shown("header")} onChange={setApiField("header", "header")} className="font-mono" />
                    {fieldError("header")}
                    <span className={hintCls}>{t("manage.add.headerHint")}</span>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className={labelCls}>{t("manage.add.scheme")}</span>
                    <Input data-testid="add-secret-scheme" value={api.scheme} placeholder={t("manage.add.schemePlaceholder")} aria-invalid={!!shown("scheme")} onChange={setApiField("scheme", "scheme")} className="font-mono" />
                    {fieldError("scheme")}
                    <span className={hintCls}>{t("manage.add.schemeHint")}</span>
                  </label>
                  <span />
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className={labelCls}>
                      {t("manage.add.baseUrlEnv")}
                      <span className="font-normal text-[var(--color-fg-faint)]">{t("manage.add.optional")}</span>
                      <InfoTip text={t("manage.add.baseUrlEnvTip")} />
                    </span>
                    <Input data-testid="add-secret-base-url-env" value={api.base_url_env} placeholder="ACME_BASE_URL" aria-invalid={!!shown("baseUrlEnv")} onChange={setApiField("base_url_env", "baseUrlEnv")} className="font-mono" />
                    {fieldError("baseUrlEnv")}
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className={labelCls}>{t("manage.add.baseUrl")}<InfoTip text={t("manage.add.baseUrlTip")} /></span>
                    <Input data-testid="add-secret-base-url" value={api.base_url} placeholder="https://api.example.com/v1" aria-invalid={!!shown("baseUrl")} onChange={setApiField("base_url", "baseUrl")} className="font-mono" />
                    {fieldError("baseUrl")}
                  </label>
                </div>
              </details>
            )}

            {owned && <SavedTo protectedOk={protectedOk} />}
          </div>

          <WhatHappens
            isKey={isKey} hosts={hosts} api={api}
            actsAs={!isKey && source === "gh" && ghUser ? ghUser : null}
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          {storeError && (
            <span data-testid="add-secret-problem" className="mr-auto text-[12.5px] text-[var(--color-err)]">
              {t("manage.add.storeFailed", { error: storeError })}
            </span>
          )}
          <Button onClick={onClose}>{t("common:cancel")}</Button>
          <Button variant="primary" data-testid="add-secret-submit" disabled={busy} onClick={() => void submit()}>{t("manage.add.submit")}</Button>
        </div>
      </div>
    </AppDialog>
  );
}

/** What the agent sees and where Termic puts the real value: one row per
 *  broker delivery of the recipe, on or off from the draft's hosts and
 *  fields (`deliveries`, which mirrors recipe.rs). */
function WhatHappens({ isKey, hosts, api, actsAs }: { isKey: boolean; hosts: string[]; api: ApiKeyCfg; actsAs: string | null }) {
  const { t } = useTranslation("secrets");
  const routes = deliveries({ recipe: isKey ? "api_key" : "github", hosts, api });
  const bu = baseUrlHost(api.base_url);
  const apiHeader = `${api.header || "authorization"}: ${api.scheme ? `${api.scheme} ` : ""}`;
  const copy: Record<DeliveryRoute, { name: string; reach: string; off: string; tip: string; inject: string }> = {
    gh: {
      name: t("manage.add.how.gh.name"), reach: t("manage.add.how.gh.reach"), off: t("manage.add.how.gh.off"),
      tip: t("manage.add.how.gh.tip"), inject: "Authorization: token ",
    },
    git: {
      name: t("manage.add.how.git.name"), reach: t("manage.add.how.git.reach"), off: t("manage.add.how.git.off"),
      tip: t("manage.add.how.git.tip"), inject: t("manage.add.how.git.inject"),
    },
    baseUrl: {
      name: t("manage.add.how.baseUrl.name", { name: api.base_url_env ? `$${api.base_url_env}` : t("manage.add.how.baseUrl.nameDefault") }),
      reach: t("manage.add.how.baseUrl.reach"),
      // the URL is fine but its host is not one of the secret's hosts
      off: api.base_url_env && bu && !hosts.includes(bu) ? t("manage.add.how.baseUrl.offHost", { host: bu }) : t("manage.add.how.baseUrl.off"),
      tip: t("manage.add.how.baseUrl.tip"), inject: apiHeader,
    },
    envProxy: {
      name: t("manage.add.how.envProxy.name"), reach: t("manage.add.how.envProxy.reach"), off: t("manage.add.how.envProxy.off"),
      tip: t("manage.add.how.envProxy.tip"), inject: apiHeader,
    },
  };
  const takeover = isKey ? AGENT_LOGIN_ENV.find(a => a.env === api.env.toUpperCase()) : undefined;
  return (
    <div data-testid="add-secret-preview" className="flex shrink-0 flex-col gap-2 self-start rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 text-[12.5px] sm:w-72">
      <Eyebrow className="flex items-center gap-1.5">{t("manage.add.how.title")}<InfoTip text={t("manage.add.how.tip")} /></Eyebrow>
      <div>{t("manage.add.how.standIn")}</div>
      <code data-testid="add-secret-stand-in" className="block truncate rounded bg-[var(--color-bg-2)] px-2 py-1 font-mono text-[11.5px]">
        {isKey ? api.env || "…" : "GH_TOKEN"}=<span className="text-[var(--color-fg-faint)]">termic_ph_…</span>
      </code>
      <div>{t("manage.add.how.swaps")}</div>
      {routes.map(({ route, on }) => (
        <Route key={route} route={route} on={on} {...copy[route]} />
      ))}
      {!isKey && (
        <div data-testid="add-secret-acts-as" className="text-[var(--color-fg-dim)]">
          {actsAs ? t("manage.add.how.actsAs", { account: actsAs }) : t("manage.add.how.actsAsOwner")}
        </div>
      )}
      {takeover && (
        <div data-testid="add-secret-login-takeover" className="flex gap-1.5 text-[var(--color-warn)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("manage.add.how.takeover", { agent: takeover.agent })}
        </div>
      )}
    </div>
  );
}

function Route({ route, on, name, reach, off, tip, inject }: {
  route: DeliveryRoute; on: boolean; name: string; reach: string; off: string; tip: string; inject: string;
}) {
  const { t } = useTranslation("secrets");
  return (
    <div
      data-route={route}
      data-on={String(on)}
      className={cn("flex flex-col gap-0.5 rounded-md border px-2.5 py-2", on ? "border-[var(--color-border)]" : "border-dashed border-[var(--color-border-soft)]")}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn("font-mono text-[12px] font-medium", !on && "text-[var(--color-fg-dim)]")}>{name}</span>
        <span className={cn(
          "rounded px-1 text-[10.5px] font-medium uppercase tracking-wide",
          on ? "bg-[var(--color-ok)]/15 text-[var(--color-ok)]" : "bg-[var(--color-hover)] text-[var(--color-fg-faint)]",
        )}>
          {on ? t("manage.add.how.on") : t("manage.add.how.off")}
        </span>
        <span className="ml-auto"><InfoTip text={tip} side="left" /></span>
      </div>
      <div className="text-[12px] text-[var(--color-fg-dim)]">{on ? reach : off}</div>
      {on && (
        <code className="block truncate font-mono text-[11.5px]">
          {inject}<span className="text-[var(--color-accent)]">{t("manage.add.how.real")}</span>
        </code>
      )}
    </div>
  );
}
