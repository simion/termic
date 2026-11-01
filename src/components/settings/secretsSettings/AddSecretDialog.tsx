// The Add secret dialog: kind, GitHub source or API key fields, name,
// hosts, and where a pasted value is saved.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { secretForgetUnsaved, secretStore, secretsGhAccounts } from "@/lib/ipc";
import type { ApiKeyCfg, SecretDef } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { AppDialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { API_KEY_PRESETS, GITHUB_HOSTS, OWNED_ACCOUNT, apiKeyProblem, ownedService, secretProblem } from "./model";
import type { SecretPreset } from "./model";
import { HostChips } from "./parts";

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
