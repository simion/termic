// Settings > Phones and servers (docs/remote.md): the phones paired with
// this computer, and the servers this computer runs agents on over SSH.
// Paired Termic computers stay in Agent access: pairing them is about
// agents working together, which is where people look for it.
//
// Phones come from `peer_status` (re-read on `peer://changed`, never
// polled); servers from the remote store, which the backend keeps current.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Plus, RefreshCw, Server, Smartphone } from "lucide-react";
import { PEER_CHANGED_EVENT, peerStatus } from "@/lib/ipc";
import type { PeerStatus } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { Block, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import {
  phoneRename, phoneUnpair, remoteReconnect, serverRemove, serverRename, useRemote,
  type MachineView, type PhoneView,
} from "@/lib/remote";

type Status = PeerStatus & { phones?: PhoneView[] };

function usePhones(): [Status | null, () => void] {
  const [status, setStatus] = useState<Status | null>(null);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const live = useRef(true);
  const refresh = useCallback(() => {
    if (inFlight.current) { dirty.current = true; return; }
    inFlight.current = true;
    peerStatus()
      .then(s => { if (live.current) setStatus(s as Status); })
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
    void listen(PEER_CHANGED_EVENT, () => refresh()).then(f => { if (gone) f(); else un = f; }).catch(() => {});
    return () => { live.current = false; gone = true; un?.(); };
  }, [refresh]);
  return [status, refresh];
}

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

const inline = "h-8 rounded-md border border-transparent bg-transparent px-1.5 outline-none hover:border-[var(--color-border-soft)] focus:border-[var(--color-accent)]/50 focus:bg-[var(--color-bg)]";

async function confirmed(title: string, message: string, label: string): Promise<boolean> {
  const ok = await useUI.getState().askConfirm({ title, message, confirmLabel: label, destructive: true });
  return typeof ok === "boolean" ? ok : ok.confirmed;
}

export function RemoteSection() {
  const { t } = useTranslation("remote");
  const { t: ts } = useTranslation("settings");
  const { patch } = useBackendSettings();
  const [status, refresh] = usePhones();
  const setDialog = useRemote(s => s.setDialog);
  const machines = useRemote(s => s.machines);
  const servers = useMemo(() => machines.filter(m => m.kind === "server"), [machines]);
  const openSettings = useApp(s => s.openSettings);
  // The live answer, not the settings cache: Connect a phone turns sharing
  // on from its own dialog, and peer://changed refreshes `status`.
  const [sharing, setSharing] = useState(false);
  // Bumped when the value arrives from outside (the Connect a phone dialog
  // turns sharing on): the switch then kept drawing off, WKWebView never ran
  // its transition (docs/gotchas.md). A remount draws it at once; a click on
  // the switch itself does not remount, so it keeps focus.
  const [drawn, setDrawn] = useState(0);
  const shown = useRef(sharing);
  shown.current = sharing;
  useEffect(() => {
    if (!status || status.enabled === shown.current) return;
    setSharing(status.enabled);
    setDrawn(n => n + 1);
  }, [status]);
  const phones = status?.phones ?? [];

  async function saveSharing(v: boolean) {
    setSharing(v);
    if (!(await patch({ lan_sharing_enabled: v }))) setSharing(!v);
    refresh();
  }

  return (
    <div className="flex flex-col gap-7" data-testid="remote-section">
      <SectionTitle title={t("section.title")} badge={ts("shared.experimental")} />
      <p className="-mt-4 text-[13px] text-[var(--color-fg-dim)]">{t("section.lead")}</p>

      {/* Phones */}
      <Block first>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[14px] font-medium">
              <Smartphone className="h-4 w-4 text-[var(--color-fg-dim)]" />
              {t("phones.title")}
            </div>
            <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">{t("phones.lead")}</p>
          </div>
          <Button
            variant={phones.length === 0 ? "primary" : "secondary"}
            size="sm"
            data-testid="remote-connect-phone"
            className="shrink-0"
            onClick={() => setDialog({ phoneDialog: true })}
          >
            <Plus className="h-3.5 w-3.5" />
            {phones.length === 0 ? t("phones.connect") : t("phones.connectAnother")}
          </Button>
        </div>
        {phones.length > 0 && (
          <div className="mt-3 flex flex-col gap-2" data-testid="remote-phones">
            {phones.map(p => <PhoneRow key={p.id} phone={p} onChanged={refresh} />)}
          </div>
        )}
        <div className="mt-4" data-testid="remote-sharing" data-enabled={sharing ? "true" : "false"}>
          <Toggle key={drawn} label={t("phones.allow")} hint={t("phones.allowHint")} value={sharing} onChange={v => void saveSharing(v)} />
        </div>
      </Block>

      {/* Servers */}
      <Block>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[14px] font-medium">
              <Server className="h-4 w-4 text-[var(--color-fg-dim)]" />
              {t("servers.title")}
            </div>
            <p className="mt-1 text-[12.5px] text-[var(--color-fg-dim)]">{t("servers.lead")}</p>
            <p className="mt-1 text-[12px] text-[var(--color-fg-faint)]">{t("servers.leadSsh")}</p>
          </div>
          <Button
            variant={servers.length === 0 ? "primary" : "secondary"}
            size="sm"
            data-testid="remote-add-server"
            className="shrink-0"
            onClick={() => setDialog({ serverDialog: true })}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("servers.add")}
          </Button>
        </div>
        {servers.length > 0 && (
          <div className="mt-3 flex flex-col gap-2" data-testid="remote-servers">
            {servers.map(m => <ServerRow key={m.id} machine={m} />)}
          </div>
        )}
      </Block>

      <Block>
        <p className="text-[12.5px] text-[var(--color-fg-faint)]">
          {t("section.computersPointer")}{" "}
          <button type="button" onClick={() => openSettings("mcp")} className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-dim)]">
            {t("section.openAgentAccess")}
          </button>
        </p>
      </Block>
    </div>
  );
}

function PhoneRow({ phone, onChanged }: { phone: PhoneView; onChanged: () => void }) {
  const { t } = useTranslation("remote");
  const relative = useRelative();
  const [draft, setDraft] = useState(phone.name);
  useEffect(() => { setDraft(phone.name); }, [phone.name]);

  async function save() {
    const next = draft.trim();
    if (!next || next === phone.name) { setDraft(phone.name); return; }
    await phoneRename(phone.id, next).catch(e => useUI.getState().pushToast(String(e), "error"));
    onChanged();
  }

  async function unpair() {
    if (!(await confirmed(t("phones.unpairTitle", { name: phone.name }), t("phones.unpairMessage"), t("phones.unpair")))) return;
    await phoneUnpair(phone.id).catch(e => useUI.getState().pushToast(String(e), "error"));
    onChanged();
  }

  const seen = phone.connected
    ? t("phones.connectedNow")
    : phone.last_seen_ms ? t("phones.lastSeen", { when: relative(phone.last_seen_ms) }) : t("phones.neverSeen");

  return (
    <div
      data-testid={`phone-row-${phone.id}`}
      data-connected={phone.connected ? "true" : "false"}
      className="flex items-center gap-2 rounded-lg border border-[var(--color-border-soft)] px-3 py-2"
    >
      <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", phone.connected ? "bg-[var(--color-ok)]" : "bg-[var(--color-fg-faint)]")} />
      <input
        aria-label={t("phones.renameLabel")}
        value={draft}
        maxLength={60}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={e => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { e.stopPropagation(); setDraft(phone.name); }
        }}
        className={cn(inline, "min-w-0 flex-1 text-[14px] font-medium text-[var(--color-fg)]")}
      />
      <span className="shrink-0 text-[12px] text-[var(--color-fg-faint)]">{seen}</span>
      <Button variant="ghost" size="sm" data-testid={`phone-unpair-${phone.id}`} onClick={() => void unpair()}>
        {t("phones.unpair")}
      </Button>
    </div>
  );
}

function ServerRow({ machine }: { machine: MachineView }) {
  const { t } = useTranslation("remote");
  const [draft, setDraft] = useState(machine.name);
  useEffect(() => { setDraft(machine.name); }, [machine.name]);

  async function save() {
    const next = draft.trim();
    if (!next || next === machine.name) { setDraft(machine.name); return; }
    await serverRename(machine.id, next).catch(e => useUI.getState().pushToast(String(e), "error"));
  }

  async function remove() {
    if (!(await confirmed(t("servers.removeTitle", { name: machine.name }), t("servers.removeMessage", { name: machine.name }), t("servers.remove")))) return;
    await serverRemove(machine.id).catch(e => useUI.getState().pushToast(String(e), "error"));
  }

  const n = machine.tasks.length;
  const line = machine.state === "online"
    ? [t("servers.connected"), n === 1 ? t("servers.tasks_one", { count: n }) : t("servers.tasks_other", { count: n }), machine.version && t("servers.version", { version: machine.version })].filter(Boolean).join(" · ")
    : machine.state === "connecting" ? t("servers.connecting") : t("servers.offline");

  return (
    <div
      data-testid={`server-row-${machine.id}`}
      data-state={machine.state}
      className="flex flex-col gap-1 rounded-lg border border-[var(--color-border-soft)] px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "inline-block h-2 w-2 shrink-0 rounded-full",
            machine.state === "online" ? "bg-[var(--color-ok)]" : machine.state === "connecting" ? "bg-[var(--color-warn)]" : "bg-[var(--color-fg-faint)]",
          )}
        />
        <input
          aria-label={t("servers.renameLabel")}
          value={draft}
          maxLength={60}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={e => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { e.stopPropagation(); setDraft(machine.name); }
          }}
          className={cn(inline, "min-w-0 flex-1 text-[14px] font-medium text-[var(--color-fg)]")}
        />
        <span className="shrink-0 font-mono text-[12px] text-[var(--color-fg-faint)]">{machine.ssh}</span>
        {machine.state !== "online" && (
          <Button variant="ghost" size="sm" onClick={() => void remoteReconnect()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("servers.reconnect")}
          </Button>
        )}
        <Button variant="ghost" size="sm" data-testid={`server-remove-${machine.id}`} onClick={() => void remove()}>
          {t("servers.remove")}
        </Button>
      </div>
      <div className="pl-[16px] text-[12px] text-[var(--color-fg-faint)]">{line}</div>
      {machine.state !== "online" && machine.error && (
        <div data-testid={`server-error-${machine.id}`} className="pl-[16px] text-[12px] text-[var(--color-warn)]">{machine.error}</div>
      )}
    </div>
  );
}
