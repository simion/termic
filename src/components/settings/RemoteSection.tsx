// Settings > Servers (docs/remote.md): the servers this computer runs
// agents on over SSH. Servers come from the remote store, which the
// backend keeps current (never polled).

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RefreshCw } from "lucide-react";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { Block, SectionTitle } from "./Controls";
import { remoteReconnect, serverRemove, serverRename, useRemote, type MachineView } from "@/lib/remote";

const inline = "h-8 rounded-md border border-transparent bg-transparent px-1.5 outline-none hover:border-[var(--color-border-soft)] focus:border-[var(--color-accent)]/50 focus:bg-[var(--color-bg)]";

async function confirmed(title: string, message: string, label: string): Promise<boolean> {
  const ok = await useUI.getState().askConfirm({ title, message, confirmLabel: label, destructive: true });
  return typeof ok === "boolean" ? ok : ok.confirmed;
}

export function RemoteSection() {
  const { t } = useTranslation("remote");
  const { t: ts } = useTranslation("settings");
  const setDialog = useRemote(s => s.setDialog);
  const machines = useRemote(s => s.machines);
  const servers = useMemo(() => machines.filter(m => m.kind === "server"), [machines]);

  return (
    <div className="flex flex-col gap-7" data-testid="remote-section">
      <SectionTitle title={t("section.title")} badge={ts("shared.experimental")} />

      <Block first>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13px] text-[var(--color-fg-dim)]">{t("servers.lead")}</p>
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
