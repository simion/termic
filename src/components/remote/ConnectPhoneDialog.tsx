// Connect a phone (docs/remote.md, "Pairing a phone"): a QR code carrying
// this computer's addresses and a fresh one-time key. The phone scans it,
// connects, and is paired; the dialog then turns into "Connected to <name>"
// with a name field. Opening it turns network sharing on if it was off (a
// phone has to reach this computer), and closing it without a phone
// withdraws the key.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, ChevronRight, RefreshCw, Wifi, Globe, Network, ShieldAlert } from "lucide-react";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { openExternalUrl, settingsLoad, settingsSave } from "@/lib/ipc";
import { writeClipboardText } from "@/lib/clipboard";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";
import {
  PHONE_PAIRED_EVENT, addressKind, countdown, phonePairCancel, phonePairStart, phoneRename, useRemote, type PhonePairingView,
} from "@/lib/remote";

type Paired = { id: string; name: string };

// Where the phone app is: TestFlight is open to anyone, so iPhone users
// need no invite.
export const IOS_APP_URL = "https://testflight.apple.com/join/SqxhPr6a";
export const ANDROID_APP_URL = "https://play.google.com/store/apps/details?id=dev.termic.remote";

/** "Get the app: iPhone (TestFlight) · Android", opened in the browser. */
// Simple Icons (CC0), the same glyphs as termic.dev.
const APPLE = "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";
const ANDROID = "M17.523 15.341c-.551 0-.999-.448-.999-1s.448-.999.999-.999c.551 0 .999.448.999.999 0 .552-.448 1-.999 1m-11.046 0c-.551 0-.999-.448-.999-1s.448-.999.999-.999c.551 0 .999.448.999.999 0 .552-.448 1-.999 1m11.405-6.02l1.997-3.459a.416.416 0 0 0-.152-.568.416.416 0 0 0-.568.152l-2.022 3.503C15.59 8.244 13.853 7.851 12 7.851s-3.59.393-5.137 1.099L4.841 5.447a.416.416 0 0 0-.568-.152.416.416 0 0 0-.152.568l1.997 3.459C2.689 11.187.343 14.659 0 18.761h24c-.344-4.102-2.689-7.574-6.118-9.44";

/** The store buttons for Termic Remote, one per platform. */
export function PhoneAppLinks({ className }: { className?: string }) {
  const { t } = useTranslation("remote");
  const link = (url: string, label: string, id: string, d: string) => (
    <Button
      variant="secondary"
      size="sm"
      data-testid={id}
      data-url={url}
      onClick={() => void openExternalUrl(url, "").catch(e => useUI.getState().pushToast(String(e), "error"))}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true"><path d={d} /></svg>
      {label}
    </Button>
  );
  return (
    <span data-testid="phone-app-links" className={cn("flex flex-wrap items-center gap-2", className)}>
      {link(IOS_APP_URL, t("phones.ios"), "phone-app-ios", APPLE)}
      {link(ANDROID_APP_URL, t("phones.android"), "phone-app-android", ANDROID)}
    </span>
  );
}

export function ConnectPhoneDialog() {
  const open = useRemote(s => s.phoneDialog);
  const setDialog = useRemote(s => s.setDialog);
  // Mounted only while open, so its timers and listeners live with it.
  return open ? <ConnectPhoneBody onClose={() => setDialog({ phoneDialog: false })} /> : null;
}

function ConnectPhoneBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("remote");
  const [view, setView] = useState<PhonePairingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<Paired | null>(null);
  const [name, setName] = useState("");
  const [now, setNow] = useState(Date.now());
  const [help, setHelp] = useState(false);
  const pairedRef = useRef(false);

  const start = useCallback(async () => {
    setError(null);
    setView(null);
    try {
      // A phone reaches this computer through the peer listener: turn
      // sharing on if it is off. MCP is not needed for a phone.
      const s = await settingsLoad();
      if (!s.lan_sharing_enabled) await settingsSave({ ...s, lan_sharing_enabled: true });
      setView(await phonePairStart());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { void start(); }, [start]);

  // The phone's hello on the new key: this dialog becomes the success state.
  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    void listen<Paired>(PHONE_PAIRED_EVENT, e => {
      pairedRef.current = true;
      setPaired(e.payload);
      setName(e.payload.name);
    }).then(f => { if (gone) f(); else un = f; }).catch(() => {});
    return () => { gone = true; un?.(); };
  }, []);

  // One tick a second while a code is showing, for the countdown.
  useEffect(() => {
    if (!view || paired) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [view, paired]);

  // Closing without a phone withdraws the key: a code nobody is looking at
  // should not stay valid.
  useEffect(() => () => { if (!pairedRef.current) void phonePairCancel().catch(() => {}); }, []);

  async function finish() {
    if (paired && name.trim() && name.trim() !== paired.name) {
      await phoneRename(paired.id, name.trim()).catch(e => useUI.getState().pushToast(String(e), "error"));
    }
    onClose();
  }

  const left = view ? view.expires_at_ms - now : 0;
  const expired = !!view && left <= 0;
  const kinds = (view?.addresses ?? []).map(a => ({ addr: a, kind: addressKind(a) }));
  const hasVpn = kinds.some(k => k.kind === "tailscale");

  return (
    <AppDialog
      open
      onOpenChange={v => { if (!v) void finish(); }}
      title={t("qr.title")}
      className="max-w-[560px]"
    >
      {paired ? (
        <div data-testid="phone-paired" className="flex flex-col gap-4 py-2">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-ok)]/15 text-[var(--color-ok)]">
              <Check className="h-5 w-5" strokeWidth={2.5} />
            </span>
            <div className="text-[15px] font-medium">{t("qr.connectedTo", { name: paired.name })}</div>
          </div>
          <label className="flex flex-col gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("qr.nameLabel")}
            <Input
              data-testid="phone-paired-name"
              value={name}
              autoFocus
              maxLength={60}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") void finish(); }}
            />
          </label>
          <div className="flex justify-end">
            <Button variant="primary" data-testid="phone-paired-done" onClick={() => void finish()}>{t("qr.done")}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex gap-5">
            <div className="relative flex h-[232px] w-[232px] shrink-0 items-center justify-center rounded-lg bg-white">
              {view ? (
                <div
                  data-testid="phone-qr"
                  data-link={import.meta.env.VITE_E2E ? view.link : undefined}
                  className={cn("h-[220px] w-[220px] [&>svg]:h-full [&>svg]:w-full", expired && "opacity-15 blur-[2px]")}
                  // Our own SVG, built by the qrcode crate in peers.rs.
                  dangerouslySetInnerHTML={{ __html: view.svg.replace(/<\?xml[^>]*\?>/, "") }}
                />
              ) : error ? null : (
                <span className="text-[12px] text-neutral-500">{t("qr.starting")}</span>
              )}
              {expired && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <span className="text-[12.5px] font-medium text-neutral-700">{t("qr.expired")}</span>
                  <Button variant="primary" size="sm" onClick={() => void start()}>{t("qr.newCode")}</Button>
                </div>
              )}
            </div>
            <ol className="flex min-w-0 flex-col gap-3 pt-1 text-[13.5px] text-[var(--color-fg)]">
              {[t("qr.step1"), t("qr.step2"), t("qr.step3")].map((s, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-3)] text-[11.5px] font-semibold tabular-nums text-[var(--color-fg-dim)]">{i + 1}</span>
                  <span>{s}{i === 0 && <PhoneAppLinks className="mt-1.5" />}</span>
                </li>
              ))}
              {view && !expired && (
                <li data-testid="phone-qr-countdown" className="mt-auto text-[12.5px] tabular-nums text-[var(--color-fg-faint)]">
                  {t("qr.expiresIn", { time: countdown(left) })}
                </li>
              )}
            </ol>
          </div>

          {error && (
            <p data-testid="phone-qr-error" className="text-[12.5px] text-[var(--color-err)]">{error}</p>
          )}

          {view && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("qr.reachTitle")}</div>
              {kinds.map(k => (
                <div key={k.addr} className="flex items-center gap-2 text-[12.5px]">
                  {k.kind === "lan" ? <Wifi className="h-3.5 w-3.5 text-[var(--color-ok)]" />
                    : k.kind === "tailscale" ? <Globe className="h-3.5 w-3.5 text-[var(--color-ok)]" />
                    : <Network className="h-3.5 w-3.5 text-[var(--color-fg-dim)]" />}
                  <span className="w-28 text-[var(--color-fg)]">
                    {k.kind === "lan" ? t("qr.kindLan") : k.kind === "tailscale" ? t("qr.kindTailscale") : t("qr.kindOther")}
                  </span>
                  <span className="font-mono text-[var(--color-fg-faint)]">{k.addr}</span>
                </div>
              ))}
              {!hasVpn && (
                <p className="flex gap-2 text-[12px] text-[var(--color-fg-faint)]">
                  <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t("qr.noVpn")}</span>
                </p>
              )}
            </div>
          )}

          <p className="flex gap-2 rounded-md bg-[var(--color-bg-2)] px-3 py-2 text-[12.5px] text-[var(--color-fg-dim)]">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
            <span>{t("qr.warning")}</span>
          </p>

          <div>
            <button
              type="button"
              onClick={() => setHelp(h => !h)}
              className="flex items-center gap-1 text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            >
              {help ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {t("qr.helpToggle")}
            </button>
            {help && (
              <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-6 text-[12.5px] text-[var(--color-fg-dim)]">
                <li>{t("qr.help1")}</li>
                <li>{t("qr.help2")}</li>
                <li>{t("qr.help3")}</li>
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              data-testid="phone-qr-copy"
              disabled={!view || expired}
              onClick={() => {
                if (!view) return;
                void writeClipboardText(view.link).then(() => useUI.getState().pushToast(t("qr.copied"), "success")).catch(() => {});
              }}
              className="text-[12px] text-[var(--color-fg-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg-dim)] disabled:opacity-40"
            >
              {t("qr.copyLink")}
            </button>
            <Button variant="secondary" size="sm" data-testid="phone-qr-new" onClick={() => void start()}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("qr.newCode")}
            </Button>
          </div>
        </div>
      )}
    </AppDialog>
  );
}
