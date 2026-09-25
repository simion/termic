// MCP endpoint (Phase A, docs/ideas/mcp.md): a loopback HTTP listener
// serving the app's verbs as MCP tools to outside clients. Off by default
// and EXPERIMENTAL per the docs/ui.md rule (a surface still settling ships
// off + badged).
//
// Unlike the CLI socket the listener only exists while the toggle is on
// (bind-on-enable, live both ways), so the URL and credential shown here
// are re-read after every flip. The token is minted fresh on every bind
// and never adopted from the file, because a credential that outlives
// the port it was issued for can be collected by whoever binds that
// port while the app is down. The address is kept stable instead, so a
// setup that reads the token file at connect time (both blocks below)
// keeps working without change.
//
// The endpoint serves MCP revision 2026-07-28 only. Both shipping
// clients speak it: claude needs nothing, codex needs one feature line,
// so the page leads with codex because it is the one with setup to do.
//
// Both clients run the SAME helper command, which reads the 0600 file
// when they connect, so nothing durable holds a second copy and a
// rotation is picked up on the next connect. Only the config syntax
// differs: http_headers_helper in codex's TOML, headersHelper through
// claude's own `mcp add-json`. The token value never renders here: the
// copy affordance fetches it on click and hands it to the clipboard.

import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { mcpInstallClient, mcpStatus, mcpToken } from "@/lib/ipc";
import type { McpStatus } from "@/lib/types";
import { copyToClipboard } from "@/lib/clipboard";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { Block, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { cn } from "@/lib/utils";

/** What a read of the endpoint state answers with when it cannot be read.
 *  Never `null`: that is the "still reading" sentinel, and a rejection left
 *  there parks the panel on it forever, with no retry and no path to the
 *  could-not-bind copy. */
const UNBOUND: McpStatus = { url: null, token_path: null, codex_config: null, claude_command: null };

/** A copyable monospace block. One component so every snippet shares the
 *  same chrome and copy affordance. */
function CopyRow({ text, label, className }: { text: string; label: string; className?: string }) {
  const { t } = useTranslation("settings");
  return (
    <div
      data-selectable
      className={cn(
        "flex cursor-text items-start justify-between gap-3 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[12px] text-[var(--color-fg)]",
        className,
      )}
    >
      <span className="whitespace-pre-wrap break-all">{text}</span>
      <button
        type="button"
        onClick={() => copyToClipboard(text, label)}
        className="shrink-0 text-[12px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-dim)]"
      >
        {t("common:copy")}
      </button>
    </div>
  );
}

/** A client's heading with its own install action on the right. */
function ClientHeader({ title, action, busy, disabled, onInstall }: {
  title: string; action: string; busy: boolean; disabled: boolean; onInstall: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="mt-5 flex items-center justify-between gap-4">
      <div className="text-[13px] font-medium">{title}</div>
      <Button variant="secondary" size="md" disabled={disabled} onClick={onInstall}>
        {busy ? t("mcp.adding") : action}
      </Button>
    </div>
  );
}

export function McpSection() {
  const { t } = useTranslation("settings");
  const { settings, patch } = useBackendSettings();
  // Seeded false for the pre-settingsLoad frame, same reasoning as
  // CliSection: a wrong "enabled" flash is the worse flash.
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  // Kept per client, so a result line appears under the section whose
  // button produced it rather than floating above both.
  const [installed, setInstalled] = useState<{ client: string; message: string } | null>(null);

  useEffect(() => {
    if (settings) setMcpEnabled(settings.mcp_enabled === true);
  }, [settings]);

  useEffect(() => {
    mcpStatus().then(setStatus).catch(() => setStatus(UNBOUND));
  }, []);

  async function saveMcpEnabled(v: boolean) {
    if (!settings) return;
    setMcpEnabled(v);
    if (!(await patch({ mcp_enabled: v }))) {
      setMcpEnabled(!v);
      return;
    }
    // settings_save applies the bind/unbind before it resolves, so the
    // status re-read reflects the new listener (or its absence).
    setStatus(await mcpStatus().catch(() => UNBOUND));
  }

  /** Register with a client through its own config, so the common case
   *  is a button rather than a pasted block. The result line is shown
   *  rather than swallowed: this writes a file the user owns. */
  async function install(client: "claude" | "codex") {
    setInstalling(client);
    setInstalled(null);
    try {
      setInstalled({ client, message: await mcpInstallClient(client) });
    } catch (e) {
      setInstalled({ client, message: String(e) });
    } finally {
      setInstalling(null);
    }
  }

  /** Fetch the credential and hand it to the clipboard. Deliberately not
   *  held in state: it must never reach the rendered tree. */
  async function copyToken() {
    const value = await mcpToken().catch(() => null);
    if (!value) {
      useUI.getState().pushToast(t("mcp.noToken"), "error");
      return;
    }
    await copyToClipboard(value, t("mcp.copyTokenLabel"));
  }

  const url = status?.url ?? null;
  const tokenPath = status?.token_path ?? null;


  // Both blocks come from the backend, which also writes them when the
  // buttons run. Building them here as well is what let the pasted
  // codex block be invalid TOML for a path containing an apostrophe
  // while the button's version was fine.
  const codexConfig = status?.codex_config ?? null;
  const claudeCommand = status?.claude_command ?? null;

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title={t("mcp.title")} badge={t("shared.experimental")} />

      <Block first>
        <Toggle
          label={t("mcp.enable.label")}
          hint={t("mcp.enable.hint")}
          value={mcpEnabled}
          onChange={saveMcpEnabled}
        />
      </Block>

      {mcpEnabled && (
        <Block>
          <div className="text-[14px] font-medium">{t("mcp.connect")}</div>
          {status === null ? (
            // mcpStatus() races settingsLoad(), so the enabled branch can
            // render before the URL arrives. Saying "could not bind" in
            // that window would call the healthy path broken.
            <p className="mt-0.5 text-[12.5px] text-[var(--color-fg-faint)]">
              {t("mcp.reading")}
            </p>
          ) : url && tokenPath ? (
            <>
              <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                <Trans
                  t={t}
                  i18nKey="mcp.listening"
                  values={{ path: tokenPath }}
                  components={{ 1: <code className="font-mono" /> }}
                />
              </div>
              <CopyRow text={url} label={t("mcp.copyUrlLabel")} className="mt-3 items-center text-[12.5px]" />
              <button
                type="button"
                onClick={copyToken}
                className="mt-2 text-[12px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-dim)]"
              >
                {t("mcp.copyToken")}
              </button>
              <p className="mt-1 text-[12px] text-[var(--color-fg-faint)]">
                {t("mcp.tokenNote")}
              </p>

              {/* Each client's button sits in its own header: the action
                  and the config it writes are the same subject, and a
                  shared row made the reader match two buttons to two
                  blocks by position. */}
              <ClientHeader
                title="Codex"
                action={t("mcp.addToCodex")}
                busy={installing === "codex"}
                disabled={installing !== null}
                onInstall={() => install("codex")}
              />
              <p className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                <Trans
                  t={t}
                  i18nKey="mcp.codexHint"
                  components={{ 1: <code className="font-mono" /> }}
                />
              </p>
              {installed?.client === "codex" && (
                <p className="mt-1.5 text-[12px] text-[var(--color-fg-dim)]">{installed.message}</p>
              )}
              {codexConfig && <CopyRow text={codexConfig} label={t("mcp.copyCodexLabel")} className="mt-1.5" />}

              <ClientHeader
                title="Claude Code"
                action={t("mcp.addToClaude")}
                busy={installing === "claude"}
                disabled={installing !== null}
                onInstall={() => install("claude")}
              />
              <p className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                {t("mcp.claudeHint")}
              </p>
              {installed?.client === "claude" && (
                <p className="mt-1.5 text-[12px] text-[var(--color-fg-dim)]">{installed.message}</p>
              )}
              {claudeCommand && <CopyRow text={claudeCommand} label={t("mcp.copyClaudeLabel")} className="mt-1.5" />}
            </>
          ) : (
            <p className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              {t("mcp.bindFailed")}
            </p>
          )}
        </Block>
      )}
    </div>
  );
}
