// termic CLI control plane. ON by default: the socket always binds and
// answers hello, and the verbs are live unless this is switched off.
// Enabling auto-installs the command (no prompt) into ~/.local/bin; the
// button upgrades it to a system-wide /usr/local/bin install.
//
// Graduated out of EXPERIMENTAL. Per the rule in docs/ui.md the badge marks a
// surface that is still settling and is therefore off by default, and it
// graduates by dropping the badge rather than moving page, so the badge and
// the default had to change together: keeping either one alone would have
// left the rail contradicting the setting. Being on by default does not widen
// the trust boundary, since every verb still needs the per-boot token from
// <data_dir>/cli-token (0600, never in any child's env, cli_server.rs).

import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { cliInstallSymlink, cliInstallStatus, cliAddToPath } from "@/lib/ipc";
import type { CliInstallStatus } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Block, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { cn } from "@/lib/utils";

export function CliSection() {
  const { t } = useTranslation("settings");
  const { settings, patch } = useBackendSettings();
  // "Enable CLI": backend Settings field, saved immediately on toggle.
  // Gates every authenticated verb of the `termic` control socket
  // (docs/plans/cli.md). Absent from the file = ON, since the backend fills
  // the field with its default before this ever sees it.
  //
  // Seeded false rather than true on purpose: this renders for one frame
  // before settingsLoad resolves, and showing "enabled" for a profile that
  // has the CLI switched off is the worse of the two flashes.
  const [cliEnabled, setCliEnabled] = useState(false);
  // Install state (path / command name / PATH-awareness), plus the
  // in-flight flag + last result line of an install action.
  const [cliInstall, setCliInstall] = useState<CliInstallStatus | null>(null);
  const [cliInstalling, setCliInstalling] = useState(false);
  const [cliInstallMsg, setCliInstallMsg] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setCliEnabled(settings.cli_enabled === true);
  }, [settings]);

  useEffect(() => {
    cliInstallStatus().then(setCliInstall).catch(() => {});
  }, []);

  async function saveCliEnabled(v: boolean) {
    // Ignore clicks until settings have loaded, so the toggle never flips
    // visually without persisting.
    if (!settings) return;
    setCliEnabled(v);
    if (!(await patch({ cli_enabled: v }))) {
      // Persist failed: revert rather than show a state we did not save.
      setCliEnabled(!v);
      return;
    }
    // Enabling should hand you a working command with no extra step: do a
    // no-prompt install into ~/.local/bin, then reflect whether it landed
    // on PATH. Only auto-install when not already installed so re-enabling
    // never resurrects a link the user removed on purpose.
    if (v) {
      const cur = await cliInstallStatus().catch(() => null);
      if (!cur?.path) await installCli(false);
      else setCliInstall(cur);
    }
  }

  /** Append the PATH line, then re-read the install status.
   *
   *  The status will still say "not on PATH" straight afterwards, and that is
   *  correct rather than a bug: `dir_on_login_path` asks the LOGIN shell's
   *  resolved PATH, which was probed at startup and cannot see a line added a
   *  second ago. The returned message is what tells the user to open a new
   *  terminal, so it is shown as-is. */
  async function addToPath() {
    setCliInstalling(true);
    setCliInstallMsg(null);
    try {
      setCliInstallMsg(await cliAddToPath());
      setCliInstall(await cliInstallStatus());
    } catch (e) {
      setCliInstallMsg(String(e));
    } finally {
      setCliInstalling(false);
    }
  }

  async function installCli(system: boolean) {
    setCliInstalling(true);
    setCliInstallMsg(null);
    try {
      const msg = await cliInstallSymlink(system);
      setCliInstallMsg(msg);
      setCliInstall(await cliInstallStatus());
    } catch (e) {
      setCliInstallMsg(String(e));
    } finally {
      setCliInstalling(false);
    }
  }

  const name = cliInstall?.name ?? "termic";

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title={t("cli.title")} />

      <Block first>
        <Toggle
          label={t("cli.enable.label")}
          hint={t("cli.enable.hint", { name })}
          value={cliEnabled}
          onChange={saveCliEnabled}
        />
        <div className={cn("mt-3", !cliEnabled && "pointer-events-none opacity-50 select-none")}>
          {cliInstall?.path ? (
            <p className="text-[12.5px] text-[var(--color-fg-dim)]">
              <Trans
                t={t}
                i18nKey="cli.installedAt"
                values={{ name: cliInstall.name, path: cliInstall.path }}
                components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
              />{" "}
              {cliInstall.on_path
                ? <Trans
                    t={t}
                    i18nKey="cli.runList"
                    values={{ command: `${cliInstall.name} list` }}
                    components={{ 1: <code className="font-mono" /> }}
                  />
                : <span className="text-[var(--color-warn,inherit)]">{t("cli.notOnPath")}</span>}
            </p>
          ) : (
            <p className="text-[12.5px] text-[var(--color-fg-dim)]">
              <Trans
                t={t}
                i18nKey="cli.autoInstall"
                values={{ name }}
                components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
              />
            </p>
          )}
          {/* The system-wide install is only a REQUIRED step when the
              auto-install did not land on PATH. When it did (the common
              case), keep it as a de-emphasized optional action so it does
              not read as "you still need to do this". */}
          {cliInstall?.path && cliInstall.on_path ? (
            <button
              type="button"
              disabled={cliInstalling}
              onClick={() => installCli(true)}
              className="mt-2 text-[12px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-dim)] disabled:opacity-50"
            >
              {cliInstalling ? t("cli.installing") : t("cli.installSystemWideOptional")}
            </button>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {/* Offered FIRST, and as the primary action, because it needs no
                  password: it appends one line to the user's own shell
                  startup file. The system-wide install is the same outcome
                  through an admin prompt, so it belongs second. */}
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="md" disabled={cliInstalling} onClick={addToPath}>
                  {cliInstalling ? t("cli.working") : t("cli.addToPath")}
                </Button>
                <span className="text-[12px] text-[var(--color-fg-faint)]">
                  <Trans
                    t={t}
                    i18nKey="cli.addToPathHint"
                    components={{ 1: <code className="font-mono" /> }}
                  />
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="md" disabled={cliInstalling} onClick={() => installCli(true)}>
                  {cliInstalling ? t("cli.installing") : t("cli.installSystemWide")}
                </Button>
                <span className="text-[12px] text-[var(--color-fg-faint)]">
                  <Trans
                    t={t}
                    i18nKey="cli.systemWideHint"
                    components={{ 1: <code className="font-mono" /> }}
                  />
                </span>
              </div>
            </div>
          )}
          {cliInstallMsg && (
            <p className="mt-2 text-[12px] text-[var(--color-fg-faint)]">{cliInstallMsg}</p>
          )}
        </div>
      </Block>

      <Block>
        <div className="text-[14px] font-medium">{t("cli.started.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          <Trans
            t={t}
            i18nKey="cli.started.hint"
            values={{ help: `${name} help` }}
            components={{ 1: <code className="font-mono" /> }}
          />
        </div>
        <div
          data-selectable
          className="mt-3 flex cursor-text flex-col gap-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[12.5px] text-[var(--color-fg-dim)]"
        >
          <div><span className="text-[var(--color-fg)]">{name} new fix-auth -p "fix the login redirect"</span></div>
          <div><span className="text-[var(--color-fg)]">{name} list</span></div>
          <div><span className="text-[var(--color-fg)]">{name} wait fix-auth</span></div>
        </div>
      </Block>

      {/* The "agents as users" path (docs/plans/cli.md). Every task PTY is
          handed TERMIC_CLI / TERMIC_TASK_ID / TERMIC_CLI_HELP (lib.rs), so an
          agent can discover and drive the CLI with no setup. Worth stating
          outright: it was previously only implied by the sandbox carve-out in
          the toggle's hint. */}
      <Block>
        <div className="text-[14px] font-medium">{t("cli.agents.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("cli.agents.hint")}
        </div>
        <p className="mt-2.5 text-[12px] text-[var(--color-fg-faint)]">
          <Trans
            t={t}
            i18nKey="cli.agents.foot"
            values={{ helpJson: `${name} help --json` }}
            components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
          />
        </p>
      </Block>
    </div>
  );
}
