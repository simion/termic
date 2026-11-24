// Settings > Remote control (docs/remote.md): what drives this Termic over
// the network. Phones paired with it (with where to get the app), then
// other Termic computers (PeersSection, docs/peers.md). Both come in on one
// listener, so its switch ("Share on this network") lives once, at the top.
//
// Settings > Servers (ServersSection below) is the other half of what used
// to be one page: a server is where a project's tasks RUN (an SSH box), not
// something that controls this computer, so it sits with its own section.
//
// Phones come from `peer_status` (re-read on `peer://changed`, never
// polled); servers from the remote store, which the backend keeps current.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Plus, RefreshCw, Server, Smartphone } from "lucide-react";
import { PEER_CHANGED_EVENT, peerStatus } from "@/lib/ipc";
import type { PeerStatus } from "@/lib/types";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { ANDROID_APP_URL, IOS_APP_URL } from "@/components/remote/ConnectPhoneDialog";
import { openExternalUrl } from "@/lib/ipc";
import { SectionTitle } from "./Controls";
import { PeersSection, ShareToggle } from "./PeersSection";
import { Card, DeviceRow, Empty } from "./RemoteCard";
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

async function confirmed(title: string, message: string, label: string): Promise<boolean> {
  const ok = await useUI.getState().askConfirm({ title, message, confirmLabel: label, destructive: true });
  return typeof ok === "boolean" ? ok : ok.confirmed;
}

export function RemoteSection() {
  const { t } = useTranslation("remote");
  const { t: ts } = useTranslation("settings");
  const [status, refresh] = usePhones();
  const setDialog = useRemote(s => s.setDialog);
  const phones = status?.phones ?? [];

  return (
    <div className="flex flex-col gap-6" data-testid="remote-section">
      <div className="flex flex-col gap-1.5">
        <SectionTitle title={t("section.title")} badge={ts("shared.experimental")} />
        <p className="text-[13px] text-[var(--color-fg-dim)]">{t("section.lead")}</p>
      </div>

      <ShareToggle />

      <Card
        icon={<Smartphone className="h-4 w-4" />}
        title={t("phones.title")}
        lead={<>
          {t("phones.lead")}
          <span data-testid="phone-app-links" className="mt-1 block text-[var(--color-fg-faint)]">
            <Trans
              t={t}
              i18nKey="phones.getApp"
              components={{
                ios: <StoreLink id="phone-get-ios" url={IOS_APP_URL} />,
                android: <StoreLink id="phone-get-android" url={ANDROID_APP_URL} />,
              }}
            />
          </span>
        </>}
        action={
          <Button variant={phones.length === 0 ? "primary" : "secondary"} size="sm" data-testid="remote-connect-phone" className="shrink-0" onClick={() => setDialog({ phoneDialog: true })}>
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
    </div>
  );
}

/** Settings > Servers: the SSH boxes this computer runs projects on. */
export function ServersSection() {
  const { t } = useTranslation("remote");
  const { t: ts } = useTranslation("settings");
  const setDialog = useRemote(s => s.setDialog);
  const machines = useRemote(s => s.machines);
  const servers = useMemo(() => machines.filter(m => m.kind === "server"), [machines]);
  return (
    <div className="flex flex-col gap-6" data-testid="servers-section">
      <SectionTitle title={t("servers.sectionTitle")} badge={ts("shared.experimental")} />
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

/** A store link inside a sentence (the phone card's empty state). */
function StoreLink({ id, url, children }: { id: string; url: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      data-testid={id}
      data-url={url}
      onClick={() => void openExternalUrl(url, "").catch(e => useUI.getState().pushToast(String(e), "error"))}
      className="text-[var(--color-fg-dim)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg)]"
    >
      {children}
    </button>
  );
}
