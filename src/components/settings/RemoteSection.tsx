// Settings > Remote (docs/remote.md): everything that reaches this computer
// or that it reaches, in order of how much it is used. Phones paired with it
// (with where to get the app), other Termic computers (PeersSection,
// docs/peers.md), then servers it runs agents on over SSH. Phones and
// computers come in on one listener, so its switch ("Share on this
// network") lives once, in Pair computers.
//
// Phones come from `peer_status` (re-read on `peer://changed`, never
// polled); servers from the remote store, which the backend keeps current.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Plus, RefreshCw, Server, Smartphone } from "lucide-react";
import { PEER_CHANGED_EVENT, peerStatus } from "@/lib/ipc";
import type { PeerStatus } from "@/lib/types";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { PhoneAppLinks } from "@/components/remote/ConnectPhoneDialog";
import { cn } from "@/lib/utils";
import { SectionTitle } from "./Controls";
import { PeersSection } from "./PeersSection";
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
  const [status, refresh] = usePhones();
  const setDialog = useRemote(s => s.setDialog);
  const machines = useRemote(s => s.machines);
  const servers = useMemo(() => machines.filter(m => m.kind === "server"), [machines]);
  const phones = status?.phones ?? [];

  return (
    <div className="flex flex-col gap-6" data-testid="remote-section">
      <div className="flex flex-col gap-1.5">
        <SectionTitle title={t("section.title")} />
        <p className="text-[13px] text-[var(--color-fg-dim)]">{t("section.lead")}</p>
      </div>

      <Card
        icon={<Smartphone className="h-4 w-4" />}
        title={t("phones.title")}
        lead={<>{t("phones.lead")}<PhoneAppLinks className="mt-2" /></>}
        action={
          <Button variant="secondary" size="sm" data-testid="remote-connect-phone" className="shrink-0" onClick={() => setDialog({ phoneDialog: true })}>
            <Plus className="h-3.5 w-3.5" />
            {phones.length === 0 ? t("phones.connect") : t("phones.connectAnother")}
          </Button>
        }
      >
        {phones.length > 0 ? (
          <div data-testid="remote-phones">{phones.map(p => <PhoneRow key={p.id} phone={p} onChanged={refresh} />)}</div>
        ) : (
          <Empty>{t("phones.empty")}</Empty>
        )}
      </Card>

      <div data-testid="settings-peers"><PeersSection /></div>

      <Card
        icon={<Server className="h-4 w-4" />}
        title={t("servers.title")}
        lead={<>
          {t("servers.lead")}
          <ol data-testid="servers-how" className="mt-2 flex flex-col gap-1.5">
            {[t("servers.how1"), t("servers.how2"), t("servers.how3")].map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-3)] text-[11px] font-semibold tabular-nums text-[var(--color-fg-dim)]">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          <span className="mt-2 block text-[var(--color-fg-faint)]">{t("servers.leadSsh")}</span>
        </>}
        action={
          <Button variant={servers.length === 0 ? "primary" : "secondary"} size="sm" data-testid="remote-add-server" className="shrink-0" onClick={() => setDialog({ serverDialog: true })}>
            <Plus className="h-3.5 w-3.5" />
            {t("servers.add")}
          </Button>
        }
      >
        {servers.length > 0 ? (
          <div data-testid="remote-servers">{servers.map(m => <ServerRow key={m.id} machine={m} />)}</div>
        ) : (
          <Empty>{t("servers.empty")}</Empty>
        )}
      </Card>

    </div>
  );
}

/** One area of the page: what it is and its action on top, its list, then
 *  an optional footer (the switch that governs it). */
function Card({ icon, title, lead, action, footer, children }: {
  icon: React.ReactNode; title: string; lead: React.ReactNode; action: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]">
      <header className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-hover)] text-[var(--color-fg-dim)]">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium leading-8">{title}</div>
          <div className="text-[12.5px] text-[var(--color-fg-dim)]">{lead}</div>
        </div>
        <div className="pt-0.5">{action}</div>
      </header>
      <div className="px-2 pb-2">{children}</div>
      {footer && <div className="border-t border-[var(--color-border-soft)] px-4 py-3">{footer}</div>}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-2 mb-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-3 text-center text-[12.5px] text-[var(--color-fg-faint)]">
      {children}
    </div>
  );
}

/** A device in a list: its icon with a status dot, a renameable name, the
 *  status line under it, and its actions on the right. */
function DeviceRow({ testId, dataState, icon, dot, name, onRename, renameLabel, status, detail, actions }: {
  testId: string; dataState: Record<string, string>; icon: React.ReactNode; dot: string; name: string;
  onRename: (next: string) => Promise<void>; renameLabel: string; status: React.ReactNode; detail?: React.ReactNode; actions: React.ReactNode;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => { setDraft(name); }, [name]);
  async function save() {
    const next = draft.trim();
    if (!next || next === name) { setDraft(name); return; }
    await onRename(next);
  }
  return (
    <div data-testid={testId} {...dataState} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] text-[var(--color-fg-dim)]">
        {icon}
        <span aria-hidden className={cn("absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-bg-1)]", dot)} />
      </span>
      <div className="min-w-0 flex-1">
        <input
          aria-label={renameLabel}
          value={draft}
          maxLength={60}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={e => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { e.stopPropagation(); setDraft(name); }
          }}
          className={cn(inline, "w-full text-[14px] font-medium text-[var(--color-fg)]")}
        />
        <div className="truncate px-1.5 text-[12px] text-[var(--color-fg-faint)]">{status}</div>
        {detail}
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  );
}

function PhoneRow({ phone, onChanged }: { phone: PhoneView; onChanged: () => void }) {
  const { t } = useTranslation("remote");
  const relative = useRelative();

  async function unpair() {
    if (!(await confirmed(t("phones.unpairTitle", { name: phone.name }), t("phones.unpairMessage"), t("phones.unpair")))) return;
    await phoneUnpair(phone.id).catch(e => useUI.getState().pushToast(String(e), "error"));
    onChanged();
  }

  const seen = phone.connected
    ? t("phones.connectedNow")
    : phone.last_seen_ms ? t("phones.lastSeen", { when: relative(phone.last_seen_ms) }) : t("phones.neverSeen");

  return (
    <DeviceRow
      testId={`phone-row-${phone.id}`}
      dataState={{ "data-connected": phone.connected ? "true" : "false" }}
      icon={<Smartphone className="h-4 w-4" />}
      dot={phone.connected ? "bg-[var(--color-ok)]" : "bg-[var(--color-fg-faint)]"}
      name={phone.name}
      renameLabel={t("phones.renameLabel")}
      onRename={async next => { await phoneRename(phone.id, next).catch(e => useUI.getState().pushToast(String(e), "error")); onChanged(); }}
      status={seen}
      actions={
        <Button variant="ghost" size="sm" data-testid={`phone-unpair-${phone.id}`} className="text-[var(--color-fg-dim)] hover:text-[var(--color-err)]" onClick={() => void unpair()}>
          {t("phones.unpair")}
        </Button>
      }
    />
  );
}

function ServerRow({ machine }: { machine: MachineView }) {
  const { t } = useTranslation("remote");

  async function remove() {
    if (!(await confirmed(t("servers.removeTitle", { name: machine.name }), t("servers.removeMessage", { name: machine.name }), t("servers.remove")))) return;
    await serverRemove(machine.id).catch(e => useUI.getState().pushToast(String(e), "error"));
  }

  const n = machine.tasks.length;
  const state = machine.state === "online"
    ? [t("servers.connected"), n === 1 ? t("servers.tasks_one", { count: n }) : t("servers.tasks_other", { count: n }), machine.version && t("servers.version", { version: machine.version })].filter(Boolean).join(" · ")
    : machine.state === "connecting" ? t("servers.connecting") : t("servers.offline");

  return (
    <DeviceRow
      testId={`server-row-${machine.id}`}
      dataState={{ "data-state": machine.state }}
      icon={<Server className="h-4 w-4" />}
      dot={machine.state === "online" ? "bg-[var(--color-ok)]" : machine.state === "connecting" ? "bg-[var(--color-warn)]" : "bg-[var(--color-fg-faint)]"}
      name={machine.name}
      renameLabel={t("servers.renameLabel")}
      onRename={async next => { await serverRename(machine.id, next).catch(e => useUI.getState().pushToast(String(e), "error")); }}
      status={<><span className="font-mono">{machine.ssh}</span> · {state}</>}
      detail={machine.state !== "online" && machine.error
        ? <div data-testid={`server-error-${machine.id}`} className="px-1.5 text-[12px] text-[var(--color-warn)]">{machine.error}</div>
        : undefined}
      actions={<>
        {machine.state !== "online" && (
          <Button variant="ghost" size="sm" onClick={() => void remoteReconnect()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("servers.reconnect")}
          </Button>
        )}
        <Button variant="ghost" size="sm" data-testid={`server-remove-${machine.id}`} className="text-[var(--color-fg-dim)] hover:text-[var(--color-err)]" onClick={() => void remove()}>
          {t("servers.remove")}
        </Button>
      </>}
    />
  );
}
