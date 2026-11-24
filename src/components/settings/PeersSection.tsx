// Pair computers, in Settings > Remote control (LAN pairing, docs/peers.md), and
// the "Share on this network" switch above all three cards. Off by
// default: turning it on runs a second listener on the network and
// advertises this Termic over mDNS, so another Termic can ask to pair.
// Paired phones come in on the same listener, so the switch is theirs too.
//
// Everything on this page is read from `peer_status` and re-read on the
// backend's `peer://changed` event, never polled. Bursts of that event
// (discovery answers arrive in clumps) are coalesced: one fetch in flight,
// and a dirty flag that buys exactly one more when it lands.
//
// Pairing: one computer opens pairing mode (a code on its screen, here), the
// other types that code on the Nearby row (or by address). The dialog after
// a pairing is global (PeerPairingDialog), because the machine that showed
// the code may be anywhere when the other side types it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  PEER_CHANGED_EVENT, cliInstallStatus, mcpInstallClient, mcpStatus, openPath, peerPair, peerPairRequest, peerRefresh, peerRename, peerSetGrant, peerSetName, peerSetNote, peerStatus, peerUnpair, settingsLoad,
} from "@/lib/ipc";
import type { McpStatus, NearbyView, PeerGrant, PeerStatus, PeerView } from "@/lib/types";
import { PEER_ROLES } from "./PeerRoles";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Toggle, useBackendSettings } from "./Controls";
import { Card, DeviceRow, Empty, inline } from "./RemoteCard";
import { AppDialog } from "@/components/ui/Dialog";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/Popover";
import { DropdownItem, DropdownMenu, DropdownRoot, DropdownTrigger } from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/Tooltip";
import { Check, ChevronDown, Monitor, MoreHorizontal, Pencil, Plus, RefreshCw, TriangleAlert } from "lucide-react";

/** peer_status, kept fresh by the backend's change event while mounted. */
function usePeerStatus(): [PeerStatus | null, () => void] {
  const [status, setStatus] = useState<PeerStatus | null>(null);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const live = useRef(true);

  const refresh = useCallback(() => {
    if (inFlight.current) { dirty.current = true; return; }
    inFlight.current = true;
    peerStatus()
      .then(s => { if (live.current) setStatus(s); })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
        if (dirty.current && live.current) { dirty.current = false; refresh(); }
      });
  }, []);

  useEffect(() => {
    live.current = true;
    refresh();
    let un: (() => void) | undefined;
    let gone = false;
    void listen(PEER_CHANGED_EVENT, () => refresh())
      .then(f => { if (gone) f(); else un = f; })
      .catch(() => {});
    return () => { live.current = false; gone = true; un?.(); };
  }, [refresh]);

  return [status, refresh];
}

/** "Last seen 5 minutes ago", in the UI language, with no locale keys of its
 *  own: Intl already knows how to say it in both. */
function useRelative() {
  const { i18n } = useTranslation();
  return useCallback((ms: number) => {
    const fmt = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
    const s = Math.round((ms - Date.now()) / 1000);
    const abs = Math.abs(s);
    if (abs < 60) return fmt.format(s, "second");
    if (abs < 3600) return fmt.format(Math.round(s / 60), "minute");
    if (abs < 86400) return fmt.format(Math.round(s / 3600), "hour");
    return fmt.format(Math.round(s / 86400), "day");
  }, [i18n.language]);
}

const selectClass =
  "h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 text-[13px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]";

const linkClass =
  "text-[12px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-dim)]";

/** Whether this computer is shared on the network, and the one way to
 *  change it. Read from peer_status, never the settings copy: Connect a
 *  phone and Pair a computer turn sharing on from their own buttons. */
function useSharing(status: PeerStatus | null, refresh: () => void, onSaved?: () => void) {
  const { settings, patch } = useBackendSettings();
  // Seeded false for the pre-settingsLoad frame: a wrong "on" flash is the
  // worse one for a switch that exposes the machine.
  const [enabled, setEnabled] = useState(false);
  // A value from outside remounts the switch, or WKWebView keeps drawing
  // it off (docs/gotchas.md).
  const [drawn, setDrawn] = useState(0);
  const shownEnabled = useRef(enabled);
  shownEnabled.current = enabled;
  useEffect(() => {
    if (!status || status.enabled === shownEnabled.current) return;
    setEnabled(status.enabled);
    setDrawn(n => n + 1);
  }, [status]);

  async function save(v: boolean): Promise<boolean> {
    if (!settings) return false;
    setEnabled(v);
    // Sharing turns MCP on with it: a paired computer is reached by an
    // agent through this Termic's MCP tools (peer, peer_call), so pairing
    // with MCP off would pair two machines no agent can use. Turning
    // sharing off leaves MCP alone.
    // Decided from disk, like the merge in `patch`: this section's copy
    // dates from when it mounted, and MCP turned off since (another
    // section, the CLI, a sync) read as still on, so sharing came on with
    // MCP off and a paired machine could reach no agent.
    const onDisk = await settingsLoad().catch(() => settings);
    const turnOnMcp = v && onDisk.mcp_enabled !== true;
    if (!(await patch(turnOnMcp ? { lan_sharing_enabled: v, mcp_enabled: true } : { lan_sharing_enabled: v }))) {
      setEnabled(!v);
      return false;
    }
    // settings_save binds or unbinds before it resolves.
    refresh();
    onSaved?.();
    return true;
  }
  return { enabled, drawn, save };
}

/** "Share on this network", on top of Settings > Remote control: it governs phones
 *  and computers alike, so it belongs to neither card. */
export function ShareToggle() {
  const { t } = useTranslation("settings");
  const [status, refresh] = usePeerStatus();
  const { enabled, drawn, save } = useSharing(status, refresh);
  return (
    <div data-testid="peers-toggle" data-enabled={enabled ? "true" : "false"}>
      <Toggle
        key={drawn}
        label={t("peers.enable.label")}
        hint={enabled ? t("peers.enable.hint") : t("peers.enable.hintOff")}
        value={enabled}
        onChange={v => void save(v)}
      />
    </div>
  );
}

/** Pair computers, the second card of Settings > Remote control: the paired list
 *  and nothing else on the page. Pairing (nearby computers, by address) is
 *  a dialog, opened when the person wants to pair; this computer's name
 *  and the agent setup are one quiet footer line. */
export function PeersSection() {
  const { t } = useTranslation("settings");
  const [status, refresh] = usePeerStatus();
  // Whether an agent can reach a paired computer at all: through Termic's
  // MCP server (Claude Code or Codex has it) or through the termic CLI on
  // PATH (`termic --peer`, which needs no MCP). Pairing is useless with
  // neither, so Pair stays disabled until one holds, or the person says
  // they wired another agent themselves.
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [cliOnPath, setCliOnPath] = useState(false);
  const [otherAgent, setOtherAgent] = useState(false);
  const readMcp = useCallback(() => {
    mcpStatus().then(setMcp).catch(() => setMcp(null));
    cliInstallStatus().then(s => setCliOnPath(!!s.path && s.on_path)).catch(() => setCliOnPath(false));
  }, []);
  useEffect(() => { readMcp(); }, [readMcp]);
  const agentReady = otherAgent || cliOnPath || mcp?.claude_registered === true || mcp?.codex_registered === true;
  const { enabled, save } = useSharing(status, refresh, readMcp);
  const [dialog, setDialog] = useState(false);

  async function openPair() {
    if (!enabled && !(await save(true))) return;
    setDialog(true);
  }

  const peers = status?.peers ?? [];
  return (
    <div data-testid="peers-section">
      <Card
        icon={<Monitor className="h-4 w-4" />}
        title={t("peers.title")}
        lead={<span data-testid="peers-lead">{t("peers.lead")}</span>}
        action={
          <Button variant={peers.length === 0 ? "primary" : "secondary"} size="sm" data-testid="peers-pair-open" className="shrink-0" onClick={() => void openPair()}>
            <Plus className="h-3.5 w-3.5" />
            {t("peers.pair.title")}
          </Button>
        }
        footer={enabled && status ? (
          <SelfLine status={status} mcp={mcp} ready={agentReady} viaCli={cliOnPath} onMcpChanged={readMcp} onOther={() => setOtherAgent(true)} onChanged={refresh} />
        ) : undefined}
      >
        {/* Pairs stay listed while sharing is off, so one can still be unpaired. */}
        {peers.length === 0
          ? <Empty><span data-testid="peers-paired-empty">{t("peers.paired.empty")}</span></Empty>
          : <div data-testid="peers-paired">{peers.map(p => <PeerRow key={p.id} peer={p} onChanged={refresh} />)}</div>}
      </Card>
      {dialog && status && (
        <PairComputerDialog
          status={status}
          mcp={mcp}
          ready={agentReady}
          onMcpChanged={readMcp}
          onOther={() => setOtherAgent(true)}
          onClose={() => setDialog(false)}
        />
      )}
    </div>
  );
}

/** The card's footer: this computer's name and address (renamed in a
 *  popover), the agent setup on the right, and any network trouble under
 *  it, only when there is some. */
function SelfLine({ status, mcp, ready, viaCli, onMcpChanged, onOther, onChanged }: {
  status: PeerStatus; mcp: McpStatus | null; ready: boolean; viaCli: boolean; onMcpChanged: () => void; onOther: () => void; onChanged: () => void;
}) {
  const { t } = useTranslation("settings");
  const selfName = status.self_name;
  const defaultName = status.default_name;
  // Empty while the name is the default one, so the placeholder carries it
  // and clearing the field means "back to default".
  const [name, setName] = useState("");
  useEffect(() => { setName(selfName && selfName !== defaultName ? selfName : ""); }, [selfName, defaultName]);
  // Each address already carries its port ("192.168.1.10:23620").
  const where = status.addresses.length > 0 ? status.addresses.join(", ") : null;
  const clients = [mcp?.claude_registered && "Claude Code", mcp?.codex_registered && "Codex"].filter(Boolean).join(", ");

  async function saveName() {
    const next = name.trim();
    const current = selfName === defaultName ? "" : selfName;
    if (next === current) return;
    try {
      await peerSetName(next);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
    onChanged();
  }

  return (
    <div className="flex flex-col gap-1.5 text-[12px]">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[var(--color-fg-dim)]">
          <span className="truncate">{t("peers.self.line", { name: selfName || defaultName })}</span>
          <span className="text-[var(--color-fg-faint)]">·</span>
          <span data-testid="peers-self-address" className="truncate font-mono text-[var(--color-fg-faint)]">{where ?? t("peers.self.noAddress")}</span>
          <PopoverRoot>
            <Tip content={t("peers.self.edit")} side="top">
              <PopoverTrigger asChild>
                <button type="button" data-testid="peers-self-edit" aria-label={t("peers.self.edit")} className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]">
                  <Pencil className="h-3 w-3" />
                </button>
              </PopoverTrigger>
            </Tip>
            <PopoverContent side="top" align="start" className="w-80 p-3">
              <div className="mb-1.5 text-[12px] text-[var(--color-fg-dim)]">{t("peers.self.hint")}</div>
              <Input
                data-testid="peers-self-name"
                aria-label={t("peers.self.nameLabel")}
                value={name}
                placeholder={defaultName}
                maxLength={63}
                autoFocus
                onChange={e => setName(e.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={e => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setName(selfName && selfName !== defaultName ? selfName : "");
                }}
                className="w-full"
              />
            </PopoverContent>
          </PopoverRoot>
        </div>
        <PopoverRoot>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="peers-agent-status"
              data-ready={ready ? "true" : "false"}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--color-hover)]",
                ready ? "text-[var(--color-fg-dim)]" : "font-medium text-[var(--color-warn,var(--color-accent))]",
              )}
            >
              {ready ? <Check className="h-3.5 w-3.5 text-[var(--color-ok)]" /> : <TriangleAlert className="h-3.5 w-3.5" />}
              {!ready ? t("peers.agent.shortMissing") : clients ? t("peers.agent.short", { clients }) : viaCli ? t("peers.agent.shortCli") : t("peers.agent.shortOther")}
              <ChevronDown className="h-3 w-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" className="w-[440px] p-3">
            <AgentSetup mcp={mcp} ready={ready} onChanged={onMcpChanged} onOther={onOther} />
          </PopoverContent>
        </PopoverRoot>
      </div>
      {status.bind_error && <p data-testid="peers-bind-error" className="text-[var(--color-warn,inherit)]">{status.bind_error}</p>}
      {status.discovery_error && (
        <p data-testid="peers-discovery-error" className="text-[var(--color-warn,inherit)]">{t("peers.self.discoveryError", { error: status.discovery_error })}</p>
      )}
      {status.platform === "windows" && <p data-testid="peers-windows-hint" className="text-[var(--color-fg-faint)]">{t("peers.self.windowsHint")}</p>}
    </div>
  );
}

/** Pair a computer: computers in sight, each with Pair, and by address for
 *  one discovery cannot see. Like Bluetooth: click Pair on a computer, it
 *  shows a code on its own screen (PeerCodeDialog there), type it here.
 *  Closes on a successful pair; the global after-pairing dialog takes over. */
function PairComputerDialog({ status, mcp, ready, onMcpChanged, onOther, onClose }: {
  status: PeerStatus; mcp: McpStatus | null; ready: boolean; onMcpChanged: () => void; onOther: () => void; onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const [address, setAddress] = useState("");
  const [addressOpen, setAddressOpen] = useState(false);
  /** The name of the machine at the typed address once it was asked. */
  const [addressAsked, setAddressAsked] = useState<string | null>(null);
  const [addressCode, setAddressCode] = useState("");
  const [pairing, setPairing] = useState<string | null>(null);

  async function pair(target: string, code: string): Promise<boolean> {
    if (pairing) return false;
    setPairing(target);
    try {
      // On success both machines raise the "what is it for" dialog
      // (peer://pairing); the list refreshes from peer://changed.
      await peerPair(target, code);
      onClose();
      return true;
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      return false;
    } finally {
      setPairing(null);
    }
  }

  // Click Pair: the other machine shows a code (`/pair/request`), and the
  // name it answers with is who the code box asks about.
  async function request(target: string): Promise<string | null> {
    try {
      return await peerPairRequest(target);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      return null;
    }
  }

  async function requestByAddress() {
    const a = address.trim();
    if (!a || pairing || !ready) return;
    setPairing(a);
    const name = await request(a);
    setPairing(null);
    if (name) setAddressAsked(name);
  }

  async function pairByAddress(code: string) {
    const a = address.trim();
    if (!a || code.length !== 4) return;
    if (!(await pair(a, code))) setAddressCode("");
  }

  // Machines ready to pair first: that is who the person came here for.
  const nearby = [...status.nearby].sort((x, y) => Number(y.pairing) - Number(x.pairing));

  return (
    <AppDialog
      open
      onOpenChange={v => { if (!v) onClose(); }}
      title={t("peers.pair.title")}
      className="max-w-[520px]"
      // The first focusable is the refresh button, whose tooltip would open
      // on focus and swallow the first Escape meant for the dialog.
      onOpenAutoFocus={e => e.preventDefault()}
    >
      <div data-testid="peers-pair-dialog" className="flex flex-col gap-4">
        <p className="text-[13px] text-[var(--color-fg-dim)]">{t("peers.pair.how")}</p>
        {!ready && <AgentSetup mcp={mcp} ready={ready} onChanged={onMcpChanged} onOther={onOther} />}

        {/* The one failure that looked like an empty network: the OS
            refusing every discovery send. Said plainly, with the way out. */}
        {status.network_blocked && (
          <div data-testid="peers-network-blocked" className="flex items-center justify-between gap-4 rounded-md border border-[var(--color-warn,var(--color-border))] px-3 py-2 text-[12.5px]">
            <span>{t(status.platform === "macos" ? "peers.blocked.macos" : "peers.blocked.other")}</span>
            {status.platform === "macos" && (
              <Button
                variant="secondary"
                size="sm"
                data-testid="peers-network-blocked-open"
                onClick={() => { void openPath("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork").catch(() => {}); }}
              >
                {t("peers.blocked.open")}
              </Button>
            )}
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">{t("peers.nearby.title")}</span>
            <Tip content={t("peers.nearby.refresh")} side="top">
              <button
                type="button"
                aria-label={t("peers.nearby.refresh")}
                data-testid="peers-refresh"
                onClick={() => { void peerRefresh().catch(() => {}); }}
                className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
          {nearby.length === 0 ? (
            <p data-testid="peers-nearby-empty" className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-3 text-center text-[12.5px] text-[var(--color-fg-faint)]">
              {t("peers.nearby.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {nearby.map(n => (
                <NearbyRow
                  key={n.id}
                  n={n}
                  busy={pairing === n.id}
                  disabled={!ready || (pairing !== null && pairing !== n.id)}
                  onRequest={() => request(n.id)}
                  onPair={code => pair(n.id, code)}
                />
              ))}
            </div>
          )}
        </div>

        {/* By address: folded, since discovery is the normal way in. The
            same two steps: ask, then type the code it shows. */}
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {!addressOpen ? (
            <>
              <span className="text-[var(--color-fg-faint)]">{t("peers.address.notListed")}</span>
              <button type="button" data-testid="peers-address-toggle" onClick={() => setAddressOpen(true)} className={linkClass}>
                {t("peers.address.title")}
              </button>
            </>
          ) : (
            <>
              <Input
                data-testid="peers-address-input"
                aria-label={t("peers.address.label")}
                value={address}
                placeholder="192.168.1.20"
                autoFocus
                disabled={addressAsked !== null}
                onChange={e => setAddress(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void requestByAddress(); }}
                className="w-48 font-mono"
              />
              {addressAsked === null ? (
                <Button
                  variant="secondary"
                  size="md"
                  data-testid="peers-address-request"
                  disabled={!ready || pairing !== null || address.trim() === ""}
                  onClick={() => void requestByAddress()}
                >
                  {t("peers.nearby.pair")}
                </Button>
              ) : (
                <>
                  <span className="text-[var(--color-fg-dim)]">{t("peers.nearby.codeFor", { name: addressAsked })}</span>
                  <Input
                    data-testid="peers-address-code"
                    aria-label={t("peers.address.code")}
                    value={addressCode}
                    placeholder={t("peers.nearby.codePlaceholder")}
                    inputMode="numeric"
                    maxLength={4}
                    autoFocus
                    disabled={pairing !== null}
                    onChange={e => {
                      const c = e.target.value.replace(/\D/g, "");
                      setAddressCode(c);
                      if (c.length === 4) void pairByAddress(c);
                    }}
                    onKeyDown={e => { if (e.key === "Enter") void pairByAddress(addressCode); }}
                    className="w-28 text-center font-mono tracking-[0.2em] placeholder:tracking-normal"
                  />
                  <button type="button" className={linkClass} onClick={() => { setAddressAsked(null); setAddressCode(""); }}>
                    {t("peers.nearby.cancel")}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </AppDialog>
  );
}

/** The step pairing cannot skip: Termic's MCP server in the coding agent.
 *  Loud until done, one quiet line after. */
function AgentSetup({ mcp, ready, onChanged, onOther }: {
  mcp: McpStatus | null; ready: boolean; onChanged: () => void; onOther: () => void;
}) {
  const { t } = useTranslation("settings");
  const [installing, setInstalling] = useState<"claude" | "codex" | null>(null);

  async function install(client: "claude" | "codex") {
    setInstalling(client);
    try {
      useUI.getState().pushToast(await mcpInstallClient(client), "success");
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    } finally {
      setInstalling(null);
      onChanged();
    }
  }

  const clients = [mcp?.claude_registered && "Claude Code", mcp?.codex_registered && "Codex"].filter(Boolean).join(", ");
  const buttons = (variant: "primary" | "secondary") => (
    <div className="flex shrink-0 gap-2">
      {(["claude", "codex"] as const).map(c => (
        <Button
          key={c}
          variant={variant}
          size="sm"
          data-testid={`peers-agent-add-${c}`}
          disabled={installing !== null}
          onClick={() => void install(c)}
        >
          {installing === c ? t("mcp.adding") : c === "claude" ? t("mcp.addToClaude") : t("mcp.addToCodex")}
        </Button>
      ))}
    </div>
  );

  if (ready) {
    return (
      <div data-testid="peers-agent-setup" data-ready="true" className="flex items-center justify-between gap-4 text-[12.5px] text-[var(--color-fg-dim)]">
        <span className="flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
          {clients ? t("peers.agent.ready", { clients }) : t("peers.agent.other")}
        </span>
        {clients && buttons("secondary")}
      </div>
    );
  }
  return (
    <div data-testid="peers-agent-setup" data-ready="false" className="rounded-md border border-[var(--color-warn,var(--color-accent))] px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[14px] font-semibold">
        <TriangleAlert className="h-4 w-4 shrink-0 text-[var(--color-warn,var(--color-accent))]" />
        {t("peers.agent.title")}
      </div>
      <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">
        {mcp && mcp.claude_missing.length > 0
          ? t("peers.agent.missing", { accounts: mcp.claude_missing.join(", ") })
          : t("peers.agent.why")}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {buttons("primary")}
        <button type="button" data-testid="peers-agent-other" className={linkClass} onClick={onOther}>
          {t("peers.agent.other")}
        </button>
      </div>
    </div>
  );
}

/** One machine in sight. Pair asks for the code its screen shows, right
 *  here on the row, and submits once four digits are in. */
function NearbyRow({ n, busy, disabled, onRequest, onPair }: {
  n: NearbyView; busy: boolean; disabled: boolean;
  onRequest: () => Promise<string | null>;
  onPair: (code: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("settings");
  // idle: a Pair button. asked: the other screen shows a code; type it.
  const [asked, setAsked] = useState(false);
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState("");

  async function ask() {
    setAsking(true);
    const name = await onRequest();
    setAsking(false);
    if (name) setAsked(true);
  }

  async function submit(c: string) {
    if (c.length !== 4) return;
    if (await onPair(c)) setAsked(false);
    setCode("");
  }

  return (
    <div
      data-testid={`nearby-row-${n.id}`}
      data-proto-ok={n.proto_ok ? "true" : "false"}
      data-asked={asked ? "true" : "false"}
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border px-3 py-2",
        asked ? "border-[var(--color-accent)]" : "border-[var(--color-border-soft)]",
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium">{n.name}</div>
        <div className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
          {asked
            ? <span className="text-[var(--color-accent)]">{t("peers.nearby.codeFor", { name: n.name })}</span>
            // The version beside the address: the release and a Beta on one
            // Mac are two entries, and this is what tells them apart.
            : !n.proto_ok ? t("peers.versionMismatch") : [n.version && `Termic ${n.version}`, n.address].filter(Boolean).join(" · ")}
        </div>
      </div>
      {!asked ? (
        <Button
          variant="primary"
          size="sm"
          data-testid={`nearby-pair-${n.id}`}
          disabled={disabled || asking || !n.proto_ok}
          onClick={() => void ask()}
        >
          {asking ? t("peers.nearby.asking") : t("peers.nearby.pair")}
        </Button>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          {busy && <span className="text-[12px] text-[var(--color-fg-faint)]">{t("peers.nearby.pairing")}</span>}
          <Input
            autoFocus
            data-testid={`nearby-code-${n.id}`}
            aria-label={t("peers.nearby.codeFor", { name: n.name })}
            value={code}
            placeholder={t("peers.nearby.codePlaceholder")}
            inputMode="numeric"
            maxLength={4}
            disabled={busy}
            onChange={e => {
              const c = e.target.value.replace(/\D/g, "");
              setCode(c);
              if (c.length === 4) void submit(c);
            }}
            onKeyDown={e => {
              if (e.key === "Enter") void submit(code);
              if (e.key === "Escape") { e.stopPropagation(); setAsked(false); setCode(""); }
            }}
            className="w-28 text-center font-mono tracking-[0.2em] placeholder:tracking-normal"
          />
          <button type="button" className={linkClass} onClick={() => { setAsked(false); setCode(""); }}>
            {t("peers.nearby.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

/** One paired computer, as compact as a phone or server row: who and how
 *  it is doing, its role and what it may do here, a menu, and the rest
 *  (what it calls itself, what it lets you do, the note) behind the
 *  chevron. A hand-written note opens it, so it is never hidden. */
function PeerRow({ peer, onChanged }: { peer: PeerView; onChanged: () => void }) {
  const { t } = useTranslation("settings");
  const relative = useRelative();
  const [note, setNote] = useState(peer.note);
  useEffect(() => { setNote(peer.note); }, [peer.note]);
  const role = PEER_ROLES.find(r => t(`peers.roles.${r}.note`) === note.trim()) ?? (note.trim() === "" ? "none" : "custom");
  const [open, setOpen] = useState(role === "custom");
  const noteRef = useRef<HTMLInputElement>(null);

  async function writeNote(text: string) {
    if (text.trim() === peer.note) return;
    try {
      await peerSetNote(peer.id, text);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
      setNote(peer.note);
    }
    onChanged();
  }

  async function setGrant(g: PeerGrant) {
    try {
      await peerSetGrant(peer.id, g);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
    onChanged();
  }

  async function unpair() {
    const ok = await useUI.getState().askConfirm({
      title: t("peers.paired.unpairTitle", { name: peer.name }),
      message: t("peers.paired.unpairMessage", { name: peer.name }),
      confirmLabel: t("peers.paired.unpair"),
      destructive: true,
    });
    const confirmed = typeof ok === "boolean" ? ok : ok.confirmed;
    if (!confirmed) return;
    try {
      await peerUnpair(peer.id);
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    }
    onChanged();
  }

  const seen = peer.online
    ? t("peers.paired.online")
    : peer.last_seen_ms ? t("peers.paired.lastSeen", { when: relative(peer.last_seen_ms) }) : t("peers.paired.neverSeen");
  const theirs = peer.their_grant === "drive"
    ? t("peers.grant.drive")
    : peer.their_grant === "reply" ? t("peers.grant.reply") : t("peers.paired.theirGrantUnknown");
  const warn = peer.revoked_by_peer
    ? <span data-testid={`peer-revoked-${peer.id}`} title={t("peers.paired.revoked")} className="text-[var(--color-warn,inherit)]">{t("peers.paired.revokedShort")}</span>
    : !peer.proto_ok ? <span title={t("peers.versionMismatch")} className="text-[var(--color-warn,inherit)]">{t("peers.paired.tooOldShort")}</span> : null;
  const compact = cn(selectClass, "h-7 rounded-md pl-2 pr-7 text-[12px]");

  return (
    <DeviceRow
      testId={`peer-row-${peer.id}`}
      dataState={{
        "data-online": peer.online ? "true" : "false",
        "data-grant": peer.grant,
        "data-revoked": peer.revoked_by_peer ? "true" : "false",
      }}
      icon={<Monitor className="h-4 w-4" />}
      dot={peer.online ? "bg-[var(--color-ok)]" : "bg-[var(--color-fg-faint)]"}
      name={peer.name}
      placeholder={peer.advertised_name}
      renameLabel={t("peers.paired.renameLabel")}
      renameTestId={`peer-rename-${peer.id}`}
      onRename={async next => {
        // Typing the machine's own name back means "no alias".
        const alias = next === peer.advertised_name ? "" : next;
        await peerRename(peer.id, alias).catch(e => useUI.getState().pushToast(String(e), "error"));
        onChanged();
      }}
      status={<>{seen}{peer.address && <> · <span className="font-mono">{peer.address}</span></>}{warn && <> · {warn}</>}</>}
      detail={open ? (
        <div data-testid={`peer-details-${peer.id}`} className="mt-1 flex flex-col gap-1 px-1.5 text-[12px] text-[var(--color-fg-faint)]">
          <div>
            {peer.alias && peer.alias !== peer.advertised_name && <>{t("peers.paired.callsItself", { name: peer.advertised_name })} · </>}
            <span data-testid={`peer-their-grant-${peer.id}`} data-their-grant={peer.their_grant ?? "unknown"}>{t("peers.paired.letsYou", { grant: theirs })}</span>
          </div>
          <input
            ref={noteRef}
            data-testid={`peer-note-${peer.id}`}
            aria-label={t("peers.paired.noteLabel")}
            title={t("peers.paired.noteHint")}
            value={note}
            placeholder={t("peers.paired.notePlaceholder")}
            maxLength={200}
            onChange={e => setNote(e.target.value)}
            onBlur={() => void writeNote(note)}
            onKeyDown={e => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") { e.stopPropagation(); setNote(peer.note); }
            }}
            className={cn(inline, "-ml-1.5 text-[12.5px] text-[var(--color-fg-dim)] placeholder:text-[var(--color-fg-faint)]")}
          />
        </div>
      ) : undefined}
      actions={<>
        <Tip content={<span className="block max-w-[320px] whitespace-normal">{role === "none" || role === "custom" ? t("peers.roles.hint") : t(`peers.roles.${role}.note`)}</span>} side="top">
          <select
            data-testid={`peer-role-${peer.id}`}
            aria-label={t("peers.paired.roleLabel")}
            value={role}
            onChange={e => {
              const r = e.target.value;
              const text = r === "none" ? "" : t(`peers.roles.${r}.note`);
              setNote(text);
              void writeNote(text);
            }}
            className={cn(compact, "w-32")}
          >
            <option value="none">{t("peers.roles.none")}</option>
            {PEER_ROLES.map(r => <option key={r} value={r}>{t(`peers.roles.${r}.label`)}</option>)}
            {role === "custom" && <option value="custom" disabled>{t("peers.paired.roleCustom")}</option>}
          </select>
        </Tip>
        <Tip content={<span className="block max-w-[320px] whitespace-normal">{t("peers.paired.mayDo")}: {peer.grant === "drive" ? t("peers.grant.driveHint") : t("peers.grant.replyHint")}</span>} side="top">
          <select
            data-testid={`peer-grant-${peer.id}`}
            aria-label={t("peers.paired.mayDo")}
            value={peer.grant}
            onChange={e => void setGrant(e.target.value as PeerGrant)}
            className={cn(compact, "w-32")}
          >
            <option value="reply">{t("peers.grant.reply")}</option>
            <option value="drive">{t("peers.grant.drive")}</option>
          </select>
        </Tip>
        <DropdownRoot>
          <DropdownTrigger asChild>
            <button type="button" data-testid={`peer-menu-${peer.id}`} aria-label={t("peers.paired.more")} className={iconBtn}>
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownTrigger>
          <DropdownMenu>
            <DropdownItem onSelect={() => { setOpen(true); requestAnimationFrame(() => noteRef.current?.focus()); }}>{t("peers.paired.editNote")}</DropdownItem>
            <DropdownItem data-testid={`peer-unpair-${peer.id}`} className="text-[var(--color-err)]" onSelect={() => void unpair()}>{t("peers.paired.unpair")}</DropdownItem>
          </DropdownMenu>
        </DropdownRoot>
        <button
          type="button"
          data-testid={`peer-expand-${peer.id}`}
          aria-expanded={open}
          aria-label={t("peers.paired.details")}
          onClick={() => setOpen(o => !o)}
          className={iconBtn}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
        </button>
      </>}
    />
  );
}

const iconBtn = "rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]";
