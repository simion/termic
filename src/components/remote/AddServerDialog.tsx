// Add a server (docs/remote.md, "Servers"): a checklist, not a form.
// Each step says what happened in one sentence and offers the one fix:
// trust a first-seen host key (showing its fingerprint), install
// termic-server over the same ssh, then connect and load the tasks. The
// server is saved only after the checks pass, and removed again if the
// person gives up before it connected.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleDashed, Loader2, X } from "lucide-react";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { useUI } from "@/store/ui";
import { CopyRow } from "@/components/settings/McpSection";
import { serverAdd, serverInstall, serverProbe, serverRemove, serverTrust, useMachine, useRemote, type ServerProbe } from "@/lib/remote";

/** The same install, from a shell on the server (termic.dev public/install-server.sh). */
const INSTALL_CURL = "curl -fsSL https://termic.dev/install-server.sh | sh";

type Mark = "todo" | "busy" | "ok" | "fail";

function Step({ mark, label, children, testid }: { mark: Mark; label: string; children?: React.ReactNode; testid?: string }) {
  return (
    <div data-testid={testid} data-mark={mark} className="flex gap-2.5">
      <span className="mt-0.5 shrink-0">
        {mark === "ok" ? <Check className="h-4 w-4 text-[var(--color-ok)]" strokeWidth={2.5} />
          : mark === "fail" ? <X className="h-4 w-4 text-[var(--color-err)]" strokeWidth={2.5} />
          : mark === "busy" ? <Loader2 className="h-4 w-4 animate-spin text-[var(--color-fg-dim)]" />
          : <CircleDashed className="h-4 w-4 text-[var(--color-fg-faint)]" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[13px]", mark === "todo" ? "text-[var(--color-fg-faint)]" : "text-[var(--color-fg)]")}>{label}</div>
        {children}
      </div>
    </div>
  );
}

export function AddServerDialog() {
  const open = useRemote(s => s.serverDialog);
  const setDialog = useRemote(s => s.setDialog);
  return open ? <AddServerBody onClose={() => setDialog({ serverDialog: false })} /> : null;
}

function AddServerBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("remote");
  const setDialog = useRemote(s => s.setDialog);
  const [ssh, setSsh] = useState("");
  const [name, setName] = useState("");
  const [probe, setProbe] = useState<ServerProbe | null>(null);
  const [busy, setBusy] = useState<"probe" | "trust" | "install" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const machine = useMachine(savedId ?? undefined);
  const host = ssh.trim();

  async function check() {
    if (!host) return;
    setBusy("probe");
    setError(null);
    try {
      const p = await serverProbe(host);
      setProbe(p);
      if (p.reached && p.installed) await add();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(b => (b === "probe" ? null : b));
    }
  }

  async function trust() {
    setBusy("trust");
    try {
      const p = await serverTrust(host, probe?.fingerprint);
      setProbe(p);
      if (p.reached && p.installed) await add();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function install() {
    setBusy("install");
    setError(null);
    try {
      await serverInstall(host);
      const p = await serverProbe(host);
      setProbe(p);
      if (p.reached && p.installed) await add();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (savedId) return;
    setBusy("add");
    try {
      const rec = await serverAdd(host, name.trim());
      setSavedId(rec.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Gave up before it ever connected: leave nothing behind.
  function cancel() {
    if (savedId && machine?.state !== "online") void serverRemove(savedId).catch(() => {});
    onClose();
  }

  const online = machine?.state === "online";
  const reach: Mark = !probe ? (busy === "probe" ? "busy" : "todo") : probe.reached ? "ok" : busy === "trust" ? "busy" : "fail";
  const system: Mark = probe?.reached ? "ok" : "todo";
  const installed: Mark = !probe?.reached ? "todo" : probe.installed ? "ok" : busy === "install" ? "busy" : "fail";
  const connect: Mark = !savedId ? (busy === "add" ? "busy" : "todo") : online ? "ok" : machine?.state === "offline" && machine.error ? "fail" : "busy";

  return (
    <AppDialog open onOpenChange={v => { if (!v) cancel(); }} title={t("addServer.title")} className="max-w-[560px]">
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-[var(--color-fg-dim)]">{t("addServer.intro")}</p>
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <label className="flex flex-col gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("addServer.sshLabel")}
            <Input
              data-testid="server-ssh"
              autoFocus
              value={ssh}
              disabled={!!savedId}
              placeholder={t("addServer.sshPlaceholder")}
              onChange={e => { setSsh(e.target.value); setProbe(null); }}
              onKeyDown={e => { if (e.key === "Enter") void check(); }}
              className="font-mono"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("addServer.nameLabel")}
            <Input
              data-testid="server-name"
              value={name}
              disabled={!!savedId}
              placeholder={host.split("@").pop() || t("addServer.nameHint")}
              onChange={e => setName(e.target.value)}
            />
          </label>
        </div>
        <p className="-mt-2 text-[12px] text-[var(--color-fg-faint)]">{t("addServer.sshHint")}</p>

        {(probe || busy) && (
          <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border-soft)] p-3" data-testid="server-checklist">
            <Step mark={reach} label={t("addServer.stepReach", { host })} testid="server-step-reach">
              {probe && !probe.reached && probe.host_key === "unknown" && (
                <div className="mt-1.5 flex flex-col gap-2">
                  <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("addServer.hostKeyNew", { host })}</p>
                  <code className="w-fit rounded bg-[var(--color-bg-2)] px-2 py-1 font-mono text-[12px]">{probe.fingerprint ?? "?"}</code>
                  <div><Button variant="primary" size="sm" data-testid="server-trust" disabled={busy !== null} onClick={() => void trust()}>{t("addServer.trust")}</Button></div>
                </div>
              )}
              {probe && !probe.reached && probe.host_key !== "unknown" && probe.error && (
                <p data-testid="server-reach-error" className="mt-1 text-[12.5px] text-[var(--color-err)]">{probe.error}</p>
              )}
              {probe?.reached && <span className="text-[12px] text-[var(--color-fg-faint)]">{(probe.millis / 1000).toFixed(1)} s</span>}
            </Step>
            <Step mark={system} label={probe?.system ? `${t("addServer.stepSystem")}: ${probe.system}` : t("addServer.stepSystem")} />
            <Step
              mark={installed}
              label={probe?.installed ? `${t("addServer.stepInstalled")} (${probe.installed})` : probe?.reached ? t("addServer.stepNotInstalled") : t("addServer.stepInstalled")}
              testid="server-step-installed"
            >
              {probe?.reached && !probe.installed && (
                <div className="mt-1.5 flex flex-col gap-2">
                  <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("addServer.installWhy", { host })}</p>
                  <div>
                    <Button variant="primary" size="sm" data-testid="server-install" disabled={busy !== null} onClick={() => void install()}>
                      {busy === "install" ? t("addServer.installing") : t("addServer.install")}
                    </Button>
                  </div>
                  <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("addServer.installCurl")}</p>
                  <CopyRow text={INSTALL_CURL} label={t("addServer.installCurlLabel")} />
                </div>
              )}
            </Step>
            <Step mark={connect} label={t("addServer.stepConnect")} testid="server-step-connect">
              {connect === "fail" && machine?.error && <p className="mt-1 text-[12.5px] text-[var(--color-err)]">{machine.error}</p>}
              {online && (
                <span className="text-[12px] text-[var(--color-fg-faint)]">
                  {machine.tasks.length === 1 ? t("servers.tasks_one", { count: 1 }) : t("servers.tasks_other", { count: machine.tasks.length })}
                </span>
              )}
            </Step>
            {probe?.details && !probe.reached && (
              <div>
                <button type="button" className="text-[12px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2" onClick={() => setDetails(d => !d)}>
                  {details ? t("addServer.hideDetails") : t("addServer.showDetails")}
                </button>
                {details && <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-bg)] p-2 font-mono text-[11.5px] text-[var(--color-fg-dim)]">{probe.details}</pre>}
              </div>
            )}
          </div>
        )}

        {error && <p data-testid="server-error" className="text-[12.5px] text-[var(--color-err)]">{error}</p>}

        {online ? (
          <div className="flex flex-col gap-3">
            <p data-testid="server-done" className="text-[13px] text-[var(--color-fg)]">{t("addServer.connectedDone", { name: machine.name })}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { onClose(); useUI.getState().openNewProject(machine.id); }}>
                {t("addServer.addProject", { name: machine.name })}
              </Button>
              <Button variant="primary" size="sm" data-testid="server-done-button" onClick={onClose}>{t("addServer.done")}</Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" data-testid="server-connect" disabled={!host || busy !== null || !!savedId} onClick={() => void check()}>
              {busy === "probe" ? t("addServer.checking") : probe ? t("addServer.retry") : t("addServer.check")}
            </Button>
          </div>
        )}
      </div>
    </AppDialog>
  );
}
