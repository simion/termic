// MCP endpoint (Phase A, docs/ideas/mcp.md): a loopback HTTP listener
// serving the app's verbs as MCP tools to outside clients. Off by default,
// but no longer badged Experimental: it graduated alongside LAN pairing.
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
import { ChevronRight } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { mcpInstallClient, mcpRegenerateToken, mcpStatus, mcpToken } from "@/lib/ipc";
import type { McpStatus } from "@/lib/types";
import { copyToClipboard } from "@/lib/clipboard";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Block, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { cn } from "@/lib/utils";

/** What a read of the endpoint state answers with when it cannot be read.
 *  Never `null`: that is the "still reading" sentinel, and a rejection left
 *  there parks the panel on it forever, with no retry and no path to the
 *  could-not-bind copy. */
const UNBOUND: McpStatus = { url: null, token_path: null, codex_config: null, claude_command: null, lan_url: null, bind_error: null, claude_registered: false, claude_missing: [], codex_registered: false, claude_needs_update: false, codex_needs_update: false };

/** A copyable monospace block. One component so every snippet shares the
 *  same chrome and copy affordance. */
export function CopyRow({ text, label, className }: { text: string; label: string; className?: string }) {
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

/** An IPv4 dotted quad or an IPv6 literal. Loose on IPv6 on purpose: the
 *  backend's parser is the judge, and falls back to loopback. */
function isIpAddress(s: string): boolean {
  const v4 = s.split(".");
  if (v4.length === 4) return v4.every(o => /^\d{1,3}$/.test(o) && Number(o) <= 255);
  return s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s);
}

/** What another device runs to register this endpoint with Claude Code.
 *  Double quotes only, so it pastes the same into bash, PowerShell and cmd. */
function remoteClaudeCommand(url: string, token: string): string {
  return `claude mcp add --transport http termic ${url} --header "X-Termic-Token: ${token}" -s user`;
}

function isLoopback(s: string): boolean {
  return s.startsWith("127.") || s === "::1";
}

/** The clients the Connect block offers, one shown at a time. */
const CLIENTS = ["claude", "codex", "other"] as const;
const linkClass = "text-[12px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-dim)]";

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
  const [client, setClient] = useState<(typeof CLIENTS)[number]>("claude");
  const [showBlock, setShowBlock] = useState(false);

  // Drafts, saved on blur: a half-typed address must not rebind the
  // listener on every keystroke.
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("");
  const [bindError, setBindError] = useState<string | null>(null);
  const [remoteCommand, setRemoteCommand] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setMcpEnabled(settings.mcp_enabled === true);
    setAddress(settings.mcp_bind_address ?? "");
    setPort(settings.mcp_port ? String(settings.mcp_port) : "");
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

  /** Save the address and port. The backend treats an address it cannot
   *  parse as loopback, so a typo is refused here, where it can be said.
   *  A change rebinds the listener, which mints a new token, so the status
   *  is re-read like an enable. */
  async function saveBind() {
    if (!settings) return;
    const a = address.trim();
    const p = port.trim() === "" ? 0 : Number(port.trim());
    if (a !== "" && !isIpAddress(a)) return setBindError(t("mcp.bind.badAddress"));
    if (!Number.isInteger(p) || p < 0 || p > 65535) return setBindError(t("mcp.bind.badPort"));
    setBindError(null);
    if (a === (settings.mcp_bind_address ?? "") && p === (settings.mcp_port ?? 0)) return;
    if (!(await patch({ mcp_bind_address: a, mcp_port: p }))) return;
    setStatus(await mcpStatus().catch(() => UNBOUND));
  }

  // The SAVED address, not the draft: the warning describes what is bound.
  const saved = settings?.mcp_bind_address ?? "";
  const exposed = saved !== "" && !isLoopback(saved);
  // null: follow `exposed` (folded on loopback); a click pins it.
  const [advanced, setAdvanced] = useState<boolean | null>(null);
  const advancedOpen = advanced ?? exposed;

  // The one place the token IS rendered, and only once the endpoint is
  // bound off loopback: another device cannot read the token file, so
  // the command it runs has to carry the value, and a command you cannot
  // select is not one you can move to that device. `status` is re-read
  // after a rebind and after Regenerate token, the one thing that changes
  // the value.
  const remoteUrl = exposed ? (status?.lan_url ?? status?.url ?? null) : null;
  useEffect(() => {
    let live = true;
    if (!remoteUrl) return setRemoteCommand(null);
    mcpToken()
      .then(tok => {
        if (live) setRemoteCommand(tok ? remoteClaudeCommand(remoteUrl, tok) : null);
      })
      .catch(() => live && setRemoteCommand(null));
    return () => { live = false; };
  }, [remoteUrl, status]);

  /** Register with a client through its own config, so the common case
   *  is a button rather than a pasted block. The result line is shown
   *  rather than swallowed: this writes a file the user owns. */
  async function install(client: "claude" | "codex") {
    setInstalling(client);
    setInstalled(null);
    try {
      setInstalled({ client, message: await mcpInstallClient(client) });
      setStatus(await mcpStatus().catch(() => UNBOUND));
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

  /** The only thing that changes the token. The listener restarts with
   *  it, so the status (and the remote command built from it) is re-read. */
  async function regenerateToken() {
    try {
      await mcpRegenerateToken();
      useUI.getState().pushToast(t("mcp.regenerated"), "success");
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
    setStatus(await mcpStatus().catch(() => UNBOUND));
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
      <SectionTitle title={t("mcp.title")} />

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
              {/* One client at a time: the three stacked (two config
                  blocks and the raw URL and token) were a wall of monospace
                  nobody needs more than one of. The button is the path; the
                  block it writes stays behind a disclosure for checking. */}
              <div className="mt-3 flex gap-1" role="tablist" data-testid="mcp-clients">
                {CLIENTS.map(c => (
                  <button
                    key={c}
                    type="button"
                    role="tab"
                    aria-selected={client === c}
                    data-testid={`mcp-client-${c}`}
                    onClick={() => { setClient(c); setShowBlock(false); }}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[12.5px] font-medium",
                      client === c
                        ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
                        : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                    )}
                  >
                    {c === "claude" ? "Claude Code" : c === "codex" ? "Codex" : t("mcp.otherClient")}
                  </button>
                ))}
              </div>
              <div className="mt-3 rounded-md border border-[var(--color-border-soft)] p-3.5">
                {client !== "other" ? (
                  <>
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-[12.5px] text-[var(--color-fg-dim)]">
                        {client === "claude"
                          ? t("mcp.claudeHint")
                          : <Trans t={t} i18nKey="mcp.codexHint" components={{ 1: <code className="font-mono" /> }} />}
                      </p>
                      <Button variant="secondary" size="md" disabled={installing !== null} onClick={() => install(client)}>
                        {installing === client ? t("mcp.adding") : client === "claude" ? t("mcp.addToClaude") : t("mcp.addToCodex")}
                      </Button>
                    </div>
                    {(client === "claude" ? status.claude_needs_update : status.codex_needs_update) && (
                      <p data-testid={`mcp-needs-update-${client}`} className="mt-2 text-[12px] text-[var(--color-warn,inherit)]">
                        {t("mcp.needsTabUpdate")}
                      </p>
                    )}
                    {installed?.client === client && (
                      <p className="mt-2 text-[12px] text-[var(--color-fg-dim)]">{installed.message}</p>
                    )}
                    <button
                      type="button"
                      data-testid="mcp-show-block"
                      aria-expanded={showBlock}
                      onClick={() => setShowBlock(v => !v)}
                      className="mt-2 flex items-center gap-1 text-[12px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]"
                    >
                      <ChevronRight className={cn("h-3 w-3 transition-transform", showBlock && "rotate-90")} />
                      {client === "claude" ? t("mcp.showCommand") : t("mcp.showConfig")}
                    </button>
                    {showBlock && client === "claude" && claudeCommand && (
                      <CopyRow text={claudeCommand} label={t("mcp.copyClaudeLabel")} className="mt-2" />
                    )}
                    {showBlock && client === "codex" && codexConfig && (
                      <CopyRow text={codexConfig} label={t("mcp.copyCodexLabel")} className="mt-2" />
                    )}
                  </>
                ) : (
                  <>
                    <CopyRow text={url} label={t("mcp.copyUrlLabel")} className="items-center text-[12.5px]" />
                    <div className="mt-2 text-[12.5px] text-[var(--color-fg-dim)]">
                      <Trans
                        t={t}
                        i18nKey="mcp.listening"
                        values={{ path: tokenPath }}
                        components={{ 1: <code className="font-mono" /> }}
                      />
                    </div>
                    <div className="mt-2 flex gap-4">
                      <button type="button" onClick={copyToken} className={linkClass}>{t("mcp.copyToken")}</button>
                      <button type="button" data-testid="mcp-regenerate-token" onClick={regenerateToken} className={linkClass}>
                        {t("mcp.regenerateToken")}
                      </button>
                    </div>
                    <p className="mt-1 text-[12px] text-[var(--color-fg-faint)]">{t("mcp.tokenNote")}</p>
                  </>
                )}
              </div>
            </>
          ) : (
            <p data-testid="mcp-bind-failed" className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              {status.bind_error ?? t("mcp.bindFailed")}
            </p>
          )}
        </Block>
      )}
      {/* The network address is for a client that is not Termic (or a
          private network like Tailscale). Linking two Termics is pairing,
          below, so this sits folded: it used to read as THE way to reach
          another machine, with one all-powerful token sent in the clear.
          Open by default only when it is already off loopback. */}
      {mcpEnabled && (
        <Block>
          <button
            type="button"
            data-testid="mcp-advanced"
            aria-expanded={advancedOpen}
            onClick={() => setAdvanced(v => !(v ?? exposed))}
            className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", advancedOpen && "rotate-90")} />
            {t("mcp.bind.advanced")}
          </button>
          {advancedOpen && (
            <div className="mt-3">
              <p className="mb-3 text-[12.5px] text-[var(--color-fg-dim)]">{t("mcp.bind.pairInstead")}</p>
              <div className="text-[14px] font-medium">{t("mcp.bind.title")}</div>
              <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{t("mcp.bind.hint")}</div>
              <div className="mt-3 flex items-center gap-2">
                <Input
                  data-testid="mcp-bind-address"
                  aria-label={t("mcp.bind.address")}
                  value={address}
                  placeholder="127.0.0.1"
                  onChange={e => setAddress(e.target.value)}
                  onBlur={saveBind}
                  onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  className="w-56 font-mono"
                />
                <span className="text-[var(--color-fg-faint)]">:</span>
                <Input
                  data-testid="mcp-bind-port"
                  aria-label={t("mcp.bind.port")}
                  value={port}
                  placeholder={t("mcp.bind.portAuto")}
                  inputMode="numeric"
                  onChange={e => setPort(e.target.value)}
                  onBlur={saveBind}
                  onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  className="w-28 font-mono"
                />
              </div>
              {bindError && (
                <p className="mt-2 text-[12px] text-[var(--color-warn,inherit)]">{bindError}</p>
              )}
              {exposed && (
                <p data-testid="mcp-bind-warning" className="mt-2 text-[12px] text-[var(--color-warn,inherit)]">
                  {t("mcp.bind.exposed")}
                </p>
              )}
              {remoteCommand && (
                <>
                  <div className="mt-4 text-[13px] font-medium">{t("mcp.bind.remoteTitle")}</div>
                  <p className="mt-0.5 text-[12px] text-[var(--color-fg-faint)]">{t("mcp.bind.remoteHint")}</p>
                  <CopyRow text={remoteCommand} label={t("mcp.bind.remoteLabel")} className="mt-2" />
                </>
              )}
            </div>
          )}
        </Block>
      )}
    </div>
  );
}
