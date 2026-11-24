import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Coffee, CircleAlert, Check, ChevronDown, Monitor, MonitorOff, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { caffeinatePermission, caffeinateRestoreOn, setCaffeinateRestore, recoverCaffeinate, initCaffeinate, INDEFINITE, lastCaffeinateFlags, lastCaffeinateHours, localDateTime, rememberCaffeinateFlags, rememberCaffeinateHours, matchesCaffeinateSettings, requestFromDraft, setCaffeinate, useCaffeinate, type CaffeinateTab } from "@/lib/caffeinate";

const PRESETS = ["1", "2", "4", "8", "16", "24", INDEFINITE];

export function CaffeinateControl({ compact }: { compact: boolean }) {
  const { t } = useTranslation("sidebar");
  const status = useCaffeinate(s => s.status);
  const connectionError = useCaffeinate(s => s.error);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CaffeinateTab>("duration");
  const [hours, setHours] = useState(lastCaffeinateHours);
  const [until, setUntil] = useState(() => localDateTime(new Date(Date.now() + 7_200_000)));
  const [closedLid, setClosedLid] = useState(() => lastCaffeinateFlags().closedLid);
  const [display, setDisplay] = useState(() => lastCaffeinateFlags().display);
  const [restore, setRestore] = useState(caffeinateRestoreOn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void initCaffeinate(); }, []);

  const enabled = !!status && (status.mode !== "off" || status.active);
  const warning = error ?? connectionError ?? status?.error;
  const current = enabled && !status?.error && (status?.active || status?.mode === "agents")
    && matchesCaffeinateSettings(status, mode, hours, until, closedLid, display);
  const deadline = status?.deadline_ms == null ? null : new Date(status.deadline_ms).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const heading = !status ? t("caffeinate.loading") : status.active ? t("caffeinate.awake")
    : status.error && status.mode !== "off" ? t("caffeinate.notAwake")
    : status.mode === "agents" ? t("caffeinate.autoOn")
    : status.mode === "off" ? t("caffeinate.off") : t("caffeinate.notAwake");
  const detail = !status ? "" : status.mode === "off" ? t(status.active ? "caffeinate.retryRelease" : "caffeinate.normalSleep")
    : !status.active && status.error ? t("caffeinate.retry")
    : !status.active && status.mode === "agents" ? t("caffeinate.armed")
    : !status.active ? t("caffeinate.retry")
    : status.mode === "indefinite" ? t("caffeinate.untilOff")
    : status.mode !== "agents" ? t("caffeinate.ends", { time: deadline })
    : status.working > 0 ? t(status.working === 1 ? "caffeinate.working_one" : "caffeinate.working_other", { count: status.working })
    : status.unknown > 0 ? t("caffeinate.unknown")
    : status.waiting > 0 ? t("caffeinate.waiting") : t("caffeinate.finishing");
  const parsedUntil = new Date(until);
  const indefinite = mode === "duration" && hours.trim() === INDEFINITE;
  const action = mode === "agents" ? t("caffeinate.enableAuto")
    : indefinite ? t("caffeinate.keepIndefinitely")
    : mode === "duration" ? Number.isFinite(Number(hours)) && Number(hours) > 0 && Number(hours) <= 24
      ? t("caffeinate.keepFor", { duration: t("caffeinate.durationHours", { count: Number(hours) }) }) : t("caffeinate.chooseDuration")
    : Number.isFinite(parsedUntil.getTime()) && parsedUntil.getTime() > Date.now() && parsedUntil.getTime() - Date.now() <= 86_400_000 ? t("caffeinate.keepUntil", { time: parsedUntil.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) })
    : t("caffeinate.chooseEnd");

  const openChanged = (value: boolean) => {
    if (value) {
      setMode(status?.mode === "agents" || status?.mode === "until" ? status.mode : "duration");
      if (status?.mode === "duration" && status.duration_minutes != null) setHours(String(status.duration_minutes / 60));
      if (status?.mode === "indefinite") setHours(INDEFINITE);
      if (!status || status.mode === "off") setHours(lastCaffeinateHours());
      if (status?.mode === "until" && status.deadline_ms != null) setUntil(localDateTime(new Date(status.deadline_ms)));
      else if (new Date(until).getTime() <= Date.now()) setUntil(localDateTime(new Date(Date.now() + 7_200_000)));
      // A running session shows its own settings; otherwise offer the last applied ones.
      const last = lastCaffeinateFlags();
      const idle = !status || status.mode === "off";
      setClosedLid(idle ? last.closedLid && !!status?.lid_supported : status.closed_lid);
      setDisplay(idle ? last.display : status.display);
      setError(null);
      void initCaffeinate();
    }
    setOpen(value);
  };
  const act = async (work: () => Promise<void>) => {
    const focused = document.activeElement;
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(String(e)); }
    finally {
      setBusy(false);
      if (focused instanceof HTMLElement && ["caffeinate-apply", "caffeinate-stop"].includes(focused.dataset.testid ?? "")
        && (document.activeElement === focused || document.activeElement === document.body)) statusRef.current?.focus();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || current) return;
    const request = requestFromDraft(mode, hours, until, closedLid, display);
    if (typeof request === "string") { setError(t(`caffeinate.${request}`)); return; }
    if (mode === "duration") rememberCaffeinateHours(hours);
    rememberCaffeinateFlags(closedLid, display);
    void act(() => setCaffeinate(request));
  };
  const inputClass = "h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-fg)]";
  return (
    <PopoverRoot open={open} onOpenChange={openChanged}>
      <Tip content={`${t("caffeinate.title")}: ${heading}${detail ? ` · ${detail}` : ""}`}>
        <PopoverTrigger asChild>
          <Button size="icon" variant="icon" data-testid="caffeinate-trigger" data-mode={status?.mode ?? "off"}
            data-active={status?.active ?? false} aria-label={`${t("caffeinate.title")}: ${heading}`}
            className={cn("relative shrink-0", status?.active && "text-[var(--color-accent)]")}
          >
            {/* Filled while it keeps the computer awake, outlined otherwise. */}
            <Coffee className="h-[18px] w-[18px]" fill={status?.active ? "currentColor" : "none"} />
            {warning || status?.recovery_pending
              ? <CircleAlert aria-label={t("caffeinate.warning")} className="absolute bottom-0 right-0 h-2.5 w-2.5 text-[var(--color-warn)]" />
              : enabled ? <span className={cn("absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full border border-[var(--color-accent)]", status?.active && "bg-[var(--color-accent)]")} /> : null}
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent side={compact ? "right" : "top"} align="start" className="w-[360px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-32px)] overflow-y-auto p-4">
        {/* The status card is the heading: a "Caffeinate" title above it said
            the name twice ("Caffeinate" / "Caffeinate is off"). */}
        <div data-testid="caffeinate-panel" role="group" aria-label={t("caffeinate.title")} aria-busy={busy} className="space-y-4 text-[13px]">
          <section className={cn("rounded-lg border p-3", status?.active ? "border-[var(--color-accent)]/30 bg-[var(--color-accent)]/8" : "border-[var(--color-border-soft)] bg-[var(--color-bg-2)]")}>
            <div className="flex items-start justify-between gap-2">
              <div ref={statusRef} tabIndex={-1} role="status" data-testid="caffeinate-status" className="min-w-0 space-y-1 rounded focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]">
                <p className="flex items-center gap-2 font-medium text-[var(--color-fg)]">
                  <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", status?.active ? "bg-[var(--color-accent)]" : "border border-[var(--color-fg-dim)]")} />{heading}
                </p>
                <p className="text-[12px] leading-relaxed text-[var(--color-fg-dim)]">{detail}</p>
                {status?.active && <p data-testid="caffeinate-display-status" data-display={status.display} className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-dim)]">
                  {status.display ? <Monitor className="h-3.5 w-3.5 shrink-0" /> : <MonitorOff className="h-3.5 w-3.5 shrink-0" />}
                  {t(status.display ? "caffeinate.statusDisplayOn" : "caffeinate.statusDisplayOff")}
                </p>}
                {status?.closed_lid && <p data-testid="caffeinate-lid-status" data-active={status.lid_active} className="text-[12px] text-[var(--color-fg-dim)]">{status.lid_active ? t("caffeinate.lidActive") : t("caffeinate.lidArmed")}</p>}
              </div>
              {enabled && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => setCaffeinate({ mode: "off" }))} data-testid="caffeinate-stop" className="shrink-0 text-[12px]">{t("caffeinate.turnOff")}</Button>}
            </div>
          </section>
          <form noValidate onSubmit={submit} onChange={() => setError(null)} className="space-y-4">
            <fieldset className="space-y-3">
              <legend className="sr-only">{t("caffeinate.mode")}</legend>
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] p-1">
                {(["duration", "agents", "until"] as const).map(value => <label key={value} data-testid={`caffeinate-choice-${value}`} data-selected={mode === value}
                  className={cn("relative flex h-8 cursor-pointer items-center justify-center rounded-md text-[12px] font-medium focus-within:ring-2 focus-within:ring-[var(--color-accent)]", mode === value ? "bg-[var(--color-bg)] text-[var(--color-fg)] shadow-sm" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]")}>
                  <input type="radio" name={id} value={value} checked={mode === value} onChange={() => setMode(value)} data-testid={`caffeinate-mode-${value}`} className="absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0" />
                  <span className="pointer-events-none">{t(`caffeinate.${value}`)}</span>
                </label>)}
              </div>
              {mode === "duration" && <div className="space-y-3">
                <div role="group" aria-label={t("caffeinate.presets")} className="grid grid-cols-7 gap-1.5">
                  {PRESETS.map(value => ({ value, pressed: value === INDEFINITE ? hours.trim() === value : Number(hours) === Number(value) })).map(({ value, pressed }) => <Button type="button" size="sm" variant="secondary" key={value} data-testid={`caffeinate-preset-${value === INDEFINITE ? "indefinite" : value}`}
                    aria-label={value === INDEFINITE ? t("caffeinate.indefinite") : t("caffeinate.durationHours", { count: Number(value) })} aria-pressed={pressed}
                    onClick={() => { setHours(value); setError(null); }}
                    className={cn("h-9 px-0 text-[13px] transition-none", pressed && "border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-accent)]")}>{value === INDEFINITE ? value : t("caffeinate.preset", { count: Number(value) })}</Button>)}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor={`${id}-hours`} className="space-y-0.5 text-[var(--color-fg-dim)]">
                    <span className="block">{t("caffeinate.custom")}</span>
                    <span id={`${id}-limit`} className="block text-[11px]">{t("caffeinate.durationLimit")}</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input id={`${id}-hours`} type="text" inputMode="decimal" value={hours} onChange={e => setHours(e.target.value)}
                      aria-describedby={`${id}-limit`} data-testid="caffeinate-hours" className={cn(inputClass, "w-16 text-center tabular-nums")} />
                    <span className="text-[var(--color-fg-dim)]">{t("caffeinate.hoursUnit")}</span>
                  </div>
                </div>
              </div>}
              {mode === "agents" && <p className="text-[12px] leading-relaxed text-[var(--color-fg-dim)]">{t("caffeinate.autoDescription")}</p>}
              {mode === "until" && <div className="space-y-2">
                <label htmlFor={`${id}-until`} className="block text-[12px] text-[var(--color-fg-dim)]">{t("caffeinate.endTime")}</label>
                <input id={`${id}-until`} type="datetime-local" value={until} onChange={e => setUntil(e.target.value)}
                  data-testid="caffeinate-until" className={cn(inputClass, "w-full")} />
                <p className="text-[11px] text-[var(--color-fg-dim)]">{Intl.DateTimeFormat().resolvedOptions().timeZone} · {t("caffeinate.durationLimit")}</p>
              </div>}
            </fieldset>
            <div className="space-y-1 border-t border-[var(--color-border-soft)] pt-3">
              <label className="flex items-center gap-2 text-[var(--color-fg)]">
                <input type="checkbox" checked={display} onChange={e => setDisplay(e.target.checked)} aria-describedby={`${id}-display`} data-testid="caffeinate-display" className="accent-[var(--color-accent)]" />
                {t("caffeinate.displayOn")}
              </label>
              <p id={`${id}-display`} data-testid="caffeinate-display-hint" className="pl-5 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">{t(display ? "caffeinate.displayHintOn" : "caffeinate.displayHintOff")}</p>
            </div>
            <div className="space-y-1 border-t border-[var(--color-border-soft)] pt-3">
              <label className="flex items-center gap-2 text-[var(--color-fg)]">
                <input type="checkbox" checked={restore} onChange={e => { setRestore(e.target.checked); setCaffeinateRestore(e.target.checked); }} aria-describedby={`${id}-restore`} data-testid="caffeinate-restore-on-launch" className="accent-[var(--color-accent)]" />
                {t("caffeinate.restoreOnLaunch")}
              </label>
              <p id={`${id}-restore`} className="pl-5 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">{t("caffeinate.restoreOnLaunchHint")}</p>
            </div>
            <div className="space-y-2 border-t border-[var(--color-border-soft)] pt-3">
              <label className="flex items-center gap-2 text-[var(--color-fg)]">
                <input type="checkbox" checked={closedLid} disabled={!status?.lid_supported} onChange={e => setClosedLid(e.target.checked)} data-testid="caffeinate-lid" className="accent-[var(--color-accent)]" />
                {t("caffeinate.closedLid")}
              </label>
              {!status?.lid_supported && <p className="text-[12px] text-[var(--color-fg-dim)]">{t("caffeinate.lidUnavailable")}</p>}
              {(closedLid || status?.recovery_pending) && <div className="space-y-2 pl-5 text-[12px] text-[var(--color-fg-dim)]">
                <p>{IS_MAC ? t(status?.lid_permission ? "caffeinate.macLidShort" : "caffeinate.needsPermission") : t(status?.lid_permission ? "caffeinate.otherLid" : "caffeinate.accountPermission")}</p>
                {IS_MAC && <p>{t("caffeinate.macLock")}</p>}
                {IS_MAC && !status?.lid_permission && <Button size="sm" disabled={busy} onClick={() => void act(() => caffeinatePermission(true))} data-testid="caffeinate-setup">{t("caffeinate.setup")}</Button>}
              </div>}
              {IS_MAC && (status?.lid_permission || closedLid) && <details className="group pl-5 text-[12px] text-[var(--color-fg-dim)]">
                <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-[var(--color-fg)] [&::-webkit-details-marker]:hidden"><ChevronDown className="h-3 w-3 group-open:rotate-180" />{t("caffeinate.lidDetails")}</summary>
                <p className="mt-2 leading-relaxed">{t("caffeinate.macLid")}</p>
                {status?.lid_permission && <Button size="sm" variant="ghost" disabled={busy || status.lid_active || status.recovery_pending}
                  onClick={() => void act(() => caffeinatePermission(false))} data-testid="caffeinate-remove-permission" className="mt-2">{t("caffeinate.removePermission")}</Button>}
              </details>}
            </div>
            {status?.limited && (closedLid ? <p className="text-[12px] leading-relaxed text-[var(--color-fg-dim)]">{t("caffeinate.limited")}</p> : <details className="text-[12px] text-[var(--color-fg-dim)]"><summary className="cursor-pointer">{t("caffeinate.deviceLimits")}</summary><p className="mt-1 leading-relaxed">{t("caffeinate.limited")}</p></details>)}
            {status?.recovery_pending && <div className="space-y-2 rounded-lg border border-[var(--color-err)]/30 bg-[var(--color-err)]/5 p-3">
              <p role="alert" className="text-[12px] text-[var(--color-err)]">{t(IS_MAC && !status.lid_permission ? "caffeinate.recoveryNeedsApproval" : "caffeinate.recovery")}</p>
              <Button size="sm" disabled={busy} onClick={() => void act(recoverCaffeinate)} data-testid="caffeinate-restore">{t("caffeinate.restore")}</Button>
            </div>}
            {warning && <p role="alert" data-testid="caffeinate-error" className="text-[12px] text-[var(--color-err)]">{warning}</p>}
            <div className="border-t border-[var(--color-border-soft)] pt-3">
              <div className="space-y-2">
                {!current && (status?.active || status?.mode === "agents" && !status.error) && <p data-testid="caffeinate-pending" className="text-[12px] leading-relaxed text-[var(--color-fg-dim)]">{t("caffeinate.pendingChanges")}</p>}
                <Button size="lg" variant={current ? "ghost" : "primary"} type="submit" disabled={busy || !!current || !status || (closedLid && !status.lid_permission)} data-testid="caffeinate-apply" className={cn("h-9 w-full rounded-lg text-[13px]", current && "disabled:opacity-100")}>
                  {busy ? <><LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />{t("caffeinate.updating")}</>
                    : current ? <span data-testid="caffeinate-current" className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5" />{t("caffeinate.currentSettings")}</span> : action}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
