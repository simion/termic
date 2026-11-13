// General settings: the app-level things that are not about tasks, agents,
// notifications, or the sandbox. Everything else that used to pile up here
// moved to its own rail item (Tasks / Notifications / Sandbox / CLI); this
// page is deliberately short.
//
// Loads the full Settings object so that saves preserve other fields
// (agents, etc.) instead of wiping them.

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { settingsSave, desktopIntegrationStatus, desktopIntegrationAdd, desktopIntegrationRemove } from "@/lib/ipc";
import type { Settings, DesktopIntegration } from "@/lib/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { useGuide } from "@/store/guide";
import { ExcludeEditor } from "./ExcludeEditor";
import { BrowserCommandField } from "./BrowserCommandField";
import { LINK_CLICK_MODIFIER as CLICK_MOD } from "@/lib/previewBrowser";
import { Block, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { cn, cleanLines } from "@/lib/utils";
import { usePr } from "@/store/pr";
import { activePause, clockAt, useForgeRate } from "@/store/forgeRate";
import type { ForgeBucketStatus } from "@/lib/types";
import { azurePatLoginCmd, forgeInstallCmd, forgeLoginCmd, forgeName } from "@/lib/forge";
import { CircleCheck, CircleX, RefreshCw } from "lucide-react";
import { IS_MAC } from "@/lib/shortcuts";
import { Tip } from "@/components/ui/Tooltip";
import type { LanguagePref } from "@/lib/i18n";

export function GeneralSection() {
  const { t } = useTranslation("settings");
  const { settings, store, patch } = useBackendSettings();
  const language = usePrefs(s => s.language);
  const setLanguage = usePrefs(s => s.setLanguage);
  // What the window's close button does. A backend Settings field Rust
  // re-reads on every close, so a change here applies without a restart.
  // Three-way rather than a toggle because "ask me" has to remain reachable:
  // ticking "Don't ask again" in the close prompt is otherwise a one-way door.
  const [closeAction, setCloseAction] = useState<"ask" | "menubar" | "quit">("ask");
  // Whether the menu-bar item (Show/Quit Termic, the attention dropdown) is
  // shown at all. Also a backend field Rust re-reads live, on every save.
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [reposDir, setReposDir] = useState("");
  const [originalDir, setOriginalDir] = useState("");
  const [busy, setBusy] = useState(false);
  // Personal (global) file-tree exclude globs. Kept as an array so the
  // ExcludeEditor's preset chips can add/remove cleanly; joined for the
  // dirty check.
  const [previewBrowser, setPreviewBrowser] = useState("");
  const [previewBrowserSaved, setPreviewBrowserSaved] = useState("");
  const [fileExclude, setFileExclude] = useState<string[]>([]);
  const [fileExcludeOriginal, setFileExcludeOriginal] = useState("");

  useEffect(() => {
    if (!settings) return;
    setCloseAction(settings.close_action ?? "ask");
    setTrayEnabled(settings.tray_enabled ?? true);
  }, [settings]);

  async function saveCloseAction(v: "ask" | "menubar" | "quit") {
    if (!settings) return;
    const prev = closeAction;
    setCloseAction(v);
    if (!(await patch({ close_action: v }))) {
      setCloseAction(prev);   // persist failed: don't show unsaved state
    }
  }

  async function saveTrayEnabled(v: boolean) {
    if (!settings) return;
    const prev = trayEnabled;
    setTrayEnabled(v);
    if (!(await patch({ tray_enabled: v }))) {
      setTrayEnabled(prev);
    }
  }

  const loadRemoteImages = usePrefs(s => s.loadRemoteImages);
  const setLoadRemoteImages = usePrefs(s => s.setLoadRemoteImages);
  const offerTouchIdForSudo = usePrefs(s => s.offerTouchIdForSudo);
  const setOfferTouchIdForSudo = usePrefs(s => s.setOfferTouchIdForSudo);

  // Hydrate the local edit buffers once, when the backend Settings land. The
  // ref gate matters: a later save re-publishes `settings`, and re-running
  // this would stomp whatever the user has typed since.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!settings || hydrated.current) return;
    hydrated.current = true;
    setReposDir(settings.repos_dir);
    setOriginalDir(settings.repos_dir);
    setPreviewBrowser(settings.preview_browser ?? "");
    setPreviewBrowserSaved(settings.preview_browser ?? "");
    const ex = settings.file_tree_exclude ?? [];
    setFileExclude(ex);
    setFileExcludeOriginal(ex.join("\n"));
  }, [settings]);

  // Scroll-to-and-flash a specific row (e.g. the remote-images banner's
  // "Settings" link) once, on mount — see view.settingsHighlight. Consumed
  // immediately so a later manual visit to General doesn't re-trigger it,
  // and cleared after a beat regardless (a fresh Settings mount from a
  // stale link a minute later shouldn't re-flash something the user is
  // already looking at).
  const settingsHighlight = useApp(s => s.view.settingsHighlight);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!settingsHighlight) return;
    const id = settingsHighlight;
    useApp.getState().clearSettingsHighlight();
    document.getElementById(`setting-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(id);
    const t = window.setTimeout(() => setFlashId(f => (f === id ? null : f)), 1600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsHighlight]);

  const excludeDirty = fileExclude.join("\n") !== fileExcludeOriginal;
  const dirty = reposDir !== originalDir;

  async function browse() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setReposDir(sel);
  }
  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      const next: Settings = { ...settings, repos_dir: reposDir.trim(), welcomed: true };
      await settingsSave(next);
      store(next);
      setOriginalDir(reposDir.trim());
    } finally { setBusy(false); }
  }
  async function savePreviewBrowser() {
    if (!settings) return;
    setBusy(true);
    try {
      const next: Settings = { ...settings, preview_browser: previewBrowser };
      await settingsSave(next);
      store(next);
      setPreviewBrowserSaved(previewBrowser);
      // Terminal link clicks read this from the app store (they cannot afford
      // an async settings read per click), so write it through or an open tab
      // keeps opening the previous browser until the next app start.
      useApp.setState({ previewBrowser });
    } finally { setBusy(false); }
  }

  async function saveExclude() {
    if (!settings) return;
    setBusy(true);
    try {
      const cleaned = cleanLines(fileExclude);
      const next: Settings = { ...settings, file_tree_exclude: cleaned };
      await settingsSave(next);
      store(next);
      setFileExclude(cleaned);
      setFileExcludeOriginal(cleaned.join("\n"));
      // The file tree is hidden behind this Settings overlay; force it to
      // re-read so the new excludes apply the moment the user looks back.
      useUI.getState().reloadFileTree();
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title={t("rail.general")} />

      {/* UI language. Applies live through i18next: every mounted
          useTranslation subscriber re-renders on the switch. */}
      <Block first id="setting-language">
        <div className="text-[14px] font-medium">{t("general.language.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("general.language.hint")}
        </div>
        <div className="mt-2 max-w-sm">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as LanguagePref)}
            className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 text-[13px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]"
            data-testid="language-select"
          >
            <option value="system">{t("general.language.system")}</option>
            <option value="en">{t("general.language.en")}</option>
            <option value="zh-CN">{t("general.language.zhCN")}</option>
          </select>
        </div>
      </Block>

      <Block>
        <div className="text-[14px] font-medium">{t("general.reposDir.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("general.reposDir.hint")}
        </div>
        <div className="mt-2 flex gap-2">
          <Input value={reposDir} onChange={(e) => setReposDir(e.target.value)} placeholder="~/Projects" className="font-mono" />
          <Button variant="secondary" onClick={browse}>{t("common:browse")}</Button>
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!dirty || busy} onClick={save}>
            {busy ? t("common:saving") : t("common:save")}
          </Button>
        </div>
      </Block>

      {/* Forge CLI status: PR/MR features ride on the official CLIs, so
          surface install + auth state HERE (the PR card shows the same
          hints contextually). Re-probed on every Settings visit. */}
      <Block>
        <ForgeStatusBlock />
      </Block>

      {/* What GitHub says is left on the gh token, and what termic itself
          spent this hour. The token is shared with agents and the user's
          terminal, so the two are shown side by side. */}
      <Block
        id="setting-forge-rate"
        className={cn(
          "rounded-md transition-colors duration-700",
          flashId === "forge-rate" && "bg-[var(--color-accent-deep)]/15",
        )}
      >
        <ForgeRateBlock />
      </Block>

      <Block>
        <TipsBlock />
      </Block>

      {/* Linux AppImage only, and the row is ABSENT elsewhere rather than
          disabled: on macOS and Windows the bundle and the installer register
          everything this writes. */}
      <DesktopEntryBlock />

      {/* Personal file-tree excludes. Hide noise (caches, venvs, build
          output) from the "All files" tree across every project on this
          machine. Per-project, team-shared excludes live in each repo's
          .termic.yaml (Settings → Projects). */}
      <Block>
        <div className="text-[14px] font-medium">{t("general.hidden.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          <Trans
            t={t}
            i18nKey="general.hidden.hint"
            components={{ 1: <code className="font-mono" /> }}
          />
        </div>
        <div className="mt-3">
          <ExcludeEditor value={fileExclude} onChange={setFileExclude} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!excludeDirty || busy} onClick={saveExclude}>
            {busy ? t("common:saving") : t("general.hidden.save")}
          </Button>
        </div>
      </Block>

      {/* GH #245. A command, not an app name, because that is the only way to
          express a specific browser PROFILE, which is what the issue asks
          for. Empty keeps the OS default and the exact pre-#245 code path. */}
      <Block id="setting-preview-browser">
        <div className="text-[14px] font-medium">{t("general.browser.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("general.browser.hint1", { mod: CLICK_MOD })}
        </div>
        <div className="mt-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("general.browser.hint2")}
        </div>
        <div className="mt-3 max-w-xl">
          <BrowserCommandField
            value={previewBrowser}
            onChange={(v) => setPreviewBrowser(v ?? "")}
            testId="general-browser"
          />
        </div>
        <div className="mt-3">
          <Button
            variant="primary"
            disabled={previewBrowser === previewBrowserSaved || busy}
            onClick={savePreviewBrowser}
            data-testid="general-browser-save"
          >
            {busy ? t("common:saving") : t("general.browser.save")}
          </Button>
        </div>
      </Block>

      {/* macOS only: the CloseRequested handler that reads close_action is
          #[cfg(target_os = "macos")], because Windows and most Linux desktops
          expect close to quit (docs/ideas/windows.md). Rendering the control
          elsewhere would save a setting nothing reads. */}
      {IS_MAC && <Block id="setting-close-action">
        <div className="flex flex-col gap-1">
          <div className="text-[13.5px] text-[var(--color-fg)]">{t("general.closeAction.label")}</div>
          <p className="text-[12.5px] text-[var(--color-fg-dim)] leading-relaxed max-w-2xl">
            {t("general.closeAction.hint")}
          </p>
          <div className="mt-2 max-w-sm">
            <select
              value={closeAction}
              onChange={(e) => saveCloseAction(e.target.value as "ask" | "menubar" | "quit")}
              className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 text-[13px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]"
              data-testid="close-action-select"
            >
              <option value="ask">{t("general.closeAction.ask")}</option>
              <option value="menubar">{t("general.closeAction.menubar")}</option>
              <option value="quit">{t("general.closeAction.quit")}</option>
            </select>
          </div>
        </div>
      </Block>}

      <Block id="setting-tray-enabled">
        <Toggle
          label={IS_MAC ? t("general.tray.label") : t("general.tray.labelSystem")}
          hint={t("general.tray.hint") + (IS_MAC ? t("general.tray.hintMac") : "")}
          value={trayEnabled}
          onChange={saveTrayEnabled}
        />
      </Block>

      {/* "Don't ask again" on the terminal's offer writes this, so it needs
          a visible way back. */}
      {IS_MAC && <Block id="setting-offer-touchid-sudo">
        <Toggle
          label={t("general.touchId.label")}
          hint={t("general.touchId.hint")}
          value={offerTouchIdForSudo}
          onChange={setOfferTouchIdForSudo}
        />
      </Block>}

      <Block
        id="setting-load-remote-images"
        className={cn(
          "rounded-md transition-colors duration-700",
          flashId === "load-remote-images" && "bg-[var(--color-accent-deep)]/15",
        )}
      >
        <Toggle
          label={t("general.remoteImages.label")}
          hint={t("general.remoteImages.hint")}
          value={loadRemoteImages}
          onChange={setLoadRemoteImages}
        />
      </Block>
    </div>
  );
}


/** Install + auth status for the forge CLIs (gh / glab / az). PR features
 *  are CLI-backed by design (no tokens stored in termic), so this block is
 *  where users learn what to install and how to sign in. */
/** The Linux AppImage's launcher entry, icon and `termic://` handler.
 *
 *  Reads its state from the FILESYSTEM every time it opens rather than from a
 *  pref: the user can delete the entry, and AppImageLauncher or Gear Lever can
 *  write one, so a remembered boolean would be a claim the system disagrees
 *  with. That is also why the button is never "on/off" but "create"/"remove".
 */
/** Tips (docs/guide.md): the switch for the ones that introduce a feature,
 *  and a way back into the getting-started tour for someone who skipped it. */
function TipsBlock() {
  const { t } = useTranslation("settings");
  const tipsEnabled = useGuide(s => s.tipsEnabled);
  const setTipsEnabled = useGuide(s => s.setTipsEnabled);
  const replay = () => {
    // The welcome guide's own steps only. A tip the user has seen stays
    // seen: replaying the tour is not asking to be told everything again.
    useGuide.getState().startGuide("welcome");
    // The tour points at the app, which the settings overlay covers.
    useApp.getState().closeSettings();
  };
  const [done, setDone] = useState(false);
  const reset = () => {
    useGuide.getState().resetAll();
    setDone(true);
    window.setTimeout(() => setDone(false), 1600);
  };
  return (
    <>
      <Toggle
        label={t("general.tips.label")}
        hint={t("general.tips.hint")}
        value={tipsEnabled}
        onChange={setTipsEnabled}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" data-testid="replay-tour" onClick={replay}>
          {t("general.tips.replay")}
        </Button>
        {/* The one place "seen" is ever cleared, and only because someone
            asked: everything the app has already shown may be shown once
            more. It does not start the tour; the button beside it does. */}
        <Button variant="ghost" data-testid="reset-tips" onClick={reset}>
          {done ? t("general.tips.resetDone") : t("general.tips.reset")}
        </Button>
      </div>
      <div className="mt-1.5 text-[12.5px] text-[var(--color-fg-dim)]">{t("general.tips.resetHint")}</div>
    </>
  );
}

function DesktopEntryBlock() {
  const { t } = useTranslation("settings");
  const [st, setSt] = useState<DesktopIntegration | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { desktopIntegrationStatus().then(setSt).catch(() => setSt(null)); }, []);

  // Not an AppImage (or not Linux): the whole block is absent.
  if (!st?.available) return null;

  const run = async (fn: () => Promise<DesktopIntegration>) => {
    setBusy(true); setErr("");
    try { setSt(await fn()); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Block id="setting-desktop-entry">
      <div className="text-[14px] font-medium">{t("general.desktop.title")}</div>
      <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
        {st.integrated
          ? <Trans t={t} i18nKey="general.desktop.doneHint" components={{ 1: <code className="font-mono" /> }} />
          : <Trans
              t={t}
              i18nKey="general.desktop.hint"
              values={{ path: st.desktop_path }}
              components={{ 1: <code className="font-mono" /> }}
            />}
      </div>
      {st.integrated && (
        // The path it points AT, because an AppImage that has been moved since
        // is the one way this silently stops working, and the fix is to press
        // the button again.
        <div className="mt-1 text-[12px] text-[var(--color-fg-faint)]">
          {t("general.desktop.movedHint", { path: st.appimage_path })}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant={st.integrated ? "ghost" : "primary"}
          disabled={busy}
          data-testid="desktop-entry-toggle"
          onClick={() => run(st.integrated ? desktopIntegrationRemove : desktopIntegrationAdd)}
        >
          {busy
            ? t("general.desktop.busy")
            : st.integrated ? t("general.desktop.remove") : t("general.desktop.add")}
        </Button>
        {st.integrated && !busy && (
          <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-ok)]">
            <CircleCheck className="h-3.5 w-3.5" /> {t("general.desktop.done")}
          </span>
        )}
      </div>
      {err && (
        <div className="mt-2 text-[12.5px] text-[var(--color-err)]">
          {t("general.desktop.failed", { error: err })}
        </div>
      )}
    </Block>
  );
}

function ForgeStatusBlock() {
  const { t } = useTranslation("settings");
  const forges = usePr(s => s.forges);
  const refreshForges = usePr(s => s.refreshForges);
  const [probing, setProbing] = useState(false);
  useEffect(() => { void refreshForges(); }, [refreshForges]);
  const reprobe = () => {
    setProbing(true);
    refreshForges().finally(() => setTimeout(() => setProbing(false), 400));
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="text-[14px] font-medium">{t("general.forge.title")}</div>
        <Tip content={t("general.forge.reprobe")}>
          <button
            onClick={reprobe}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", probing && "animate-spin")} />
          </button>
        </Tip>
      </div>
      <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
        {t("general.forge.hint")}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {(forges ?? []).map(f => (
          <div key={f.id} className="flex items-center gap-2.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-2">
            <span className="w-24 shrink-0 text-[13px] font-medium text-[var(--color-fg)]">
              {forgeName(f.provider)}
              <span className="ml-1.5 font-mono text-[11px] text-[var(--color-fg-faint)]">{f.id}</span>
            </span>
            {!f.found ? (
              <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
                <CircleX className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
                {t("general.forge.notInstalled")}
                <code className="rounded bg-[var(--color-bg-3)] px-1 py-px font-mono text-[11px]">{forgeInstallCmd(f.provider)}</code>
              </span>
            ) : !f.authed ? (
              <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-warn)]">
                <CircleX className="h-3.5 w-3.5" />
                {t("general.forge.notSignedIn")}
                <code className="rounded bg-[var(--color-bg-3)] px-1 py-px font-mono text-[11px] text-[var(--color-fg)]">{forgeLoginCmd(f.provider)}</code>
                {f.provider === "azure" && (
                  <Trans ns="common" i18nKey="forgePatHint" values={{ cmd: azurePatLoginCmd }}
                    components={{ code: <code className="rounded bg-[var(--color-bg-3)] px-1 py-px font-mono text-[11px] text-[var(--color-fg)]" /> }} />
                )}
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
                <CircleCheck className="h-3.5 w-3.5 shrink-0" style={{ color: "#3fb950" }} />
                <span className="truncate">
                  {f.account ? (
                    <Trans
                      t={t}
                      i18nKey="general.forge.signedInAs"
                      values={{ account: f.account }}
                      components={{ 1: <span className="text-[var(--color-fg)]" /> }}
                    />
                  ) : t("general.forge.signedIn")}
                  {/* Hosts matter: this is how a self-hosted user confirms
                      termic will recognise their instance's remotes. */}
                  {f.hosts?.length ? (
                    <span className="text-[var(--color-fg-faint)]"> · {f.hosts.join(", ")}</span>
                  ) : null}
                  {f.version ? <span className="text-[var(--color-fg-faint)]"> · {f.version}</span> : null}
                </span>
              </span>
            )}
          </div>
        ))}
        {forges === null && (
          <div className="text-[12.5px] text-[var(--color-fg-faint)]">{t("general.forge.probing")}</div>
        )}
      </div>
    </div>
  );
}

/** Ledger refresh while the block is on screen. IPC only, no network: the
 *  event already carries changes, this catches the ones its throttle drops
 *  and the spend that ages out of the hour. */
const RATE_REFRESH_MS = 15_000;

function ForgeRateBlock() {
  const { t, i18n } = useTranslation("settings");
  const hosts = useForgeRate(s => s.hosts);
  const refresh = useForgeRate(s => s.refresh);
  useEffect(() => {
    void refresh(true);
    const id = window.setInterval(() => { void refresh(); }, RATE_REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);
  // The UI language, not the system locale.
  const fmt = (n: number) => n.toLocaleString(i18n.resolvedLanguage);
  const bucketRow = (b: ForgeBucketStatus) => (
    <div key={b.bucket} className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-[var(--color-fg-dim)]">
      <span className="w-16 shrink-0 text-[var(--color-fg)]">{t(`general.forgeRate.bucket.${b.bucket}`)}</span>
      <span data-testid={`forge-rate-left-${b.bucket}`}>
        {b.window
          ? t("general.forgeRate.left", { remaining: fmt(b.window.remaining), limit: fmt(b.window.limit), time: clockAt(b.window.reset_at) })
          : t("general.forgeRate.unknown")}
      </span>
      <span className="text-[var(--color-fg-faint)]">
        · {t("general.forgeRate.spent", { spent: fmt(b.spent), cap: fmt(b.cap) })}
        {b.estimated > 0 && <> {t("general.forgeRate.estimated", { n: fmt(b.estimated) })}</>}
      </span>
      {b.by_feature.length > 0 && (
        <span className="basis-full pl-[4.5rem] text-[12px] text-[var(--color-fg-faint)]">
          {b.by_feature.map(f => `${t(`general.forgeRate.feature.${f.feature}`, { defaultValue: f.feature })} ${fmt(f.cost)}`).join(" · ")}
        </span>
      )}
    </div>
  );
  return (
    <div data-testid="forge-rate-block">
      <div className="text-[14px] font-medium">{t("general.forgeRate.title")}</div>
      <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{t("general.forgeRate.hint")}</div>
      <div className="mt-3 flex flex-col gap-2">
        {hosts.length === 0 && (
          <div className="text-[12.5px] text-[var(--color-fg-faint)]">{t("general.forgeRate.none")}</div>
        )}
        {hosts.map(h => {
          const pause = activePause([h]);
          return (
            <div key={h.host} className="flex flex-col gap-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-2">
              <div className="font-mono text-[12px] text-[var(--color-fg)]">{h.host}</div>
              {h.buckets.map(bucketRow)}
              {pause && (
                <div data-testid="forge-rate-paused" className="text-[12.5px] text-[var(--color-warn)]">
                  {t("general.forgeRate.paused", { time: clockAt(pause.until), reason: t(`chrome:forgeRatePill.kind.${pause.kind}`) })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
