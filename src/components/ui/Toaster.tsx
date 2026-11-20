// Bottom-right notification stack. One mount in <App/>; all transient
// success/info/warning/error feedback goes through useUI().pushToast().
//
// Collapsed, the newest card sits in front and up to two older ones peek out
// beneath it, so a pile of notices reads as a pile. Hovering the stack fans it
// out into a list and pauses every timer, so nothing vanishes while you read.
// Cards slide in from the right and slide back out on dismiss. Only transform
// and opacity animate (compositor-only, nothing repaints), and the stack keeps
// a dismissed card mounted just long enough to play its exit.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Info, CircleAlert, XCircle, MoreHorizontal, BellOff } from "lucide-react";
import { useUI, type Toast } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem } from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";

const ICONS = {
  success: CheckCircle2,
  info: Info,
  warning: CircleAlert,
  error: XCircle,
};

/** Icon tile: the kind's colour on a faint wash of itself. */
const TILE = {
  success: "bg-[var(--color-ok)]/15 text-[var(--color-ok)]",
  info:    "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  warning: "bg-[var(--color-warn)]/15 text-[var(--color-warn)]",
  error:   "bg-[var(--color-err)]/15 text-[var(--color-err)]",
};

const TONE_TILE = {
  "pr-merged": "bg-[var(--color-pr-merged)]/15 text-[var(--color-pr-merged)]",
  "pr-open":   "bg-[var(--color-pr-open)]/15 text-[var(--color-pr-open)]",
};

const DEFAULT_TTL_MS = 3200;
/** Matches the slide-out transition below. */
const EXIT_MS = 220;
const GAP_PX = 8;
/** Collapsed: how far each older card peeks out under the one in front. */
const PEEK_PX = 10;
const PEEKING = 2;
const WIDTH = "w-[min(380px,calc(100vw-2rem))]";

type Rendered = Toast & { leaving?: boolean };

export function Toaster() {
  const toasts = useUI(s => s.toasts);
  const dismiss = useUI(s => s.dismissToast);
  const { t: tr } = useTranslation();
  // The store drops a toast the moment it is dismissed; keep it here a beat
  // longer, flagged, so it can slide out instead of blinking away.
  const [rendered, setRendered] = useState<Rendered[]>(toasts);
  useEffect(() => {
    const live = new Set(toasts.map(t => t.id));
    setRendered(prev => {
      const kept = prev.filter(t => !live.has(t.id)).map(t => (t.leaving ? t : { ...t, leaving: true }));
      // Store order is oldest first; leaving cards keep their old slot.
      const merged: Rendered[] = [...toasts];
      for (const k of kept) {
        const at = prev.findIndex(p => p.id === k.id);
        merged.splice(Math.min(at, merged.length), 0, k);
      }
      return merged;
    });
    const h = setTimeout(() => setRendered(prev => prev.filter(t => !t.leaving || live.has(t.id))), EXIT_MS);
    return () => clearTimeout(h);
  }, [toasts]);

  const [pointerIn, setHovered] = useState(false);
  // A card's options menu renders outside the stack, so moving onto it is a
  // mouseleave: keep the stack open (and every timer paused) while it is up.
  const [menuOpen, setMenuOpen] = useState(false);
  const hovered = pointerIn || menuOpen;
  useEffect(() => { if (toasts.length === 0) { setHovered(false); setMenuOpen(false); } }, [toasts.length]);
  const heights = useRef(new Map<string, number>());
  const [, bump] = useState(0);
  const measured = useCallback((id: string, h: number) => {
    if (heights.current.get(id) === h) return;
    heights.current.set(id, h);
    bump(n => n + 1);
  }, []);

  // Newest first: index 0 is the front card, nearest the corner.
  const order = [...rendered].reverse();
  const visible = order.filter(t => !t.leaving);
  const frontHeight = heights.current.get(visible[0]?.id ?? order[0]?.id ?? "") ?? 0;
  let lifted = 0;
  let depth = 0;
  const layout = order.map(t => {
    const h = heights.current.get(t.id) ?? 0;
    const slot = { lift: lifted, depth };
    if (!t.leaving) { lifted += h + GAP_PX; depth++; }
    return slot;
  });
  // Collapsed, the older cards peek out BELOW the front one, into the margin.
  const stackHeight = hovered ? Math.max(0, lifted - GAP_PX) : frontHeight;
  const clearAll = hovered && visible.length > 1;

  if (order.length === 0) return null;
  return (
    <div
      className={cn("pointer-events-none fixed bottom-8 right-5 z-[10000]", WIDTH)}
      style={{ height: stackHeight }}
      data-testid="toast-stack"
      data-expanded={hovered || undefined}
    >
      <div
        className="pointer-events-auto absolute inset-x-0 bottom-0"
        style={{ height: stackHeight + (clearAll ? 32 : 0) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {clearAll && (
          <button
            type="button"
            onClick={() => visible.forEach(t => dismiss(t.id))}
            className="absolute right-0 top-0 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-1)] px-2.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] shadow-md hover:text-[var(--color-fg)]"
          >
            {tr("toast.clearAll")}
          </button>
        )}
        {order.map((t, i) => (
          <ToastCard
            key={t.id}
            t={t}
            index={layout[i].depth}
            lift={layout[i].lift}
            expanded={hovered}
            frontHeight={frontHeight}
            paused={hovered || menuOpen}
            onMeasure={measured}
            onMenuOpenChange={setMenuOpen}
          />
        ))}
      </div>
    </div>
  );
}

function ToastCard({ t, index, lift, expanded, frontHeight, paused, onMeasure, onMenuOpenChange }: {
  t: Rendered;
  index: number;
  lift: number;
  expanded: boolean;
  frontHeight: number;
  paused: boolean;
  onMeasure: (id: string, h: number) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const dismiss = useUI(s => s.dismissToast);
  const onDismiss = useCallback(() => dismiss(t.id), [dismiss, t.id]);
  // The CONTENT is measured, not the card: a tucked card is clamped to the
  // front card's height, and measuring that would fan it out at the wrong size.
  const ref = useRef<HTMLDivElement>(null);
  // Mount off to the right, then slide in on the next frame.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // +2: the card's 1px border, top and bottom.
    onMeasure(t.id, el.offsetHeight + 2);
    const ro = new ResizeObserver(() => onMeasure(t.id, el.offsetHeight + 2));
    ro.observe(el);
    return () => ro.disconnect();
  }, [t.id, onMeasure]);

  // The timer stops while the stack is hovered and resumes with what was
  // left, so a card read slowly is not pulled out from under the pointer.
  const remaining = useRef(t.ttlMs ?? DEFAULT_TTL_MS);
  useEffect(() => {
    if (t.sticky || t.leaving || paused) return;
    const started = Date.now();
    const h = setTimeout(onDismiss, remaining.current);
    return () => { clearTimeout(h); remaining.current -= Date.now() - started; };
  }, [t.sticky, t.leaving, paused, onDismiss]);

  const front = index === 0;
  const hidden = !expanded && index > PEEKING;
  // Collapsed, a card behind the front one takes the front one's height and
  // hides its content, so only its bottom edge shows below the front card.
  const tucked = !expanded && !front && !t.leaving;
  const scale = expanded || t.leaving ? 1 : 1 - Math.min(index, PEEKING + 1) * 0.05;
  // Scaled from the top, a card behind the front one would end short of the
  // front's bottom edge; push it down by that shortfall plus its peek.
  const y = t.leaving || !entered
    ? 0
    : expanded ? -lift : frontHeight * (1 - scale) + Math.min(index, PEEKING) * PEEK_PX;
  const x = !entered || t.leaving ? "calc(100% + 24px)" : "0px";

  return (
    <div
      role="status"
      data-testid="toast"
      data-kind={t.kind}
      className={cn(
        "absolute inset-x-0 bottom-0 origin-top",
        "transition-[transform,opacity] duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
      )}
      style={{
        transform: `translate(${x}, ${y}px) scale(${scale})`,
        opacity: hidden || !entered || t.leaving ? 0 : tucked ? 1 - (index - 1) * 0.3 : 1,
        zIndex: 100 - index,
        pointerEvents: t.leaving || hidden ? "none" : undefined,
      }}
    >
      <ToastFrame
        t={t}
        measureRef={ref}
        tucked={tucked}
        height={tucked && frontHeight ? frontHeight : undefined}
        countdown={t.sticky || t.leaving ? undefined : { ms: t.ttlMs ?? DEFAULT_TTL_MS, paused }}
        onDismiss={onDismiss}
        onMenuOpenChange={onMenuOpenChange}
      />
    </div>
  );
}

type FrameToast = Pick<Toast, "kind" | "title" | "msg" | "icon" | "tone" | "notice" | "actions" | "createdAt">;

/** The card itself, with no position or timer: the stack wraps it, and
 *  Settings > Notifications draws one per notice as a live sample (`preview`,
 *  whose buttons do nothing). Icon and text on the left; the buttons in a
 *  column on the right edge, one under the other, as on macOS. */
export function ToastFrame({ t, measureRef, tucked, height, preview, countdown, onDismiss, onMenuOpenChange }: {
  t: FrameToast;
  measureRef?: React.Ref<HTMLDivElement>;
  tucked?: boolean;
  height?: number;
  preview?: boolean;
  /** A self-dismissing toast's lifetime: drawn as a fill draining from the
   *  Dismiss button, frozen while `paused` (the stack's timers are too). */
  countdown?: { ms: number; paused: boolean };
  onDismiss?: () => void;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const { t: tr } = useTranslation(); // defaultNS "common"
  const mute = usePrefs(s => s.setNoticeMuted);
  const [menuOpen, setMenuOpen] = useState(false);
  const Ic = t.icon ?? ICONS[t.kind];
  const dismiss = () => { if (!preview) onDismiss?.(); };
  const cell = "flex min-h-[34px] flex-1 items-center justify-center gap-1.5 px-3 text-[12.5px] font-medium outline-none hover:bg-[var(--color-hover)] focus-visible:bg-[var(--color-hover)]";
  return (
    <div
      className={cn(
        "group relative rounded-xl border border-[var(--color-border)] shadow-[0_10px_30px_-8px_rgba(0,0,0,0.55)]",
        // A tucked card is one shade lighter, so its edge reads as a layer.
        tucked ? "overflow-hidden bg-[var(--color-bg-3)]" : "bg-[var(--color-bg-1)]",
      )}
      style={{ height }}
    >
      <div ref={measureRef} className={cn("flex items-stretch", tucked && "invisible")}>
        <div className="flex min-w-0 flex-1 items-center gap-3 p-3">
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", t.tone ? TONE_TILE[t.tone] : TILE[t.kind])}>
            <Ic className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <div className={cn(
                "min-w-0 flex-1 break-words text-[13px] leading-snug text-[var(--color-fg)]",
                t.title ? "font-semibold" : "line-clamp-4",
              )}>
                {t.title ?? t.msg}
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-faint)]">
                {new Date(t.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            {t.title && (
              <div className="mt-0.5 line-clamp-4 break-words text-[12.5px] leading-snug text-[var(--color-fg-dim)]">{t.msg}</div>
            )}
          </div>
        </div>
        <div className="flex w-[104px] shrink-0 flex-col divide-y divide-[var(--color-border-soft)] overflow-hidden rounded-r-xl border-l border-[var(--color-border-soft)]">
          <button type="button" onClick={dismiss} data-testid="toast-dismiss" className={cn(cell, "relative text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]")}>
            {countdown && (
              <span
                aria-hidden
                data-testid="toast-countdown"
                className="pointer-events-none absolute inset-0 origin-right bg-[var(--color-fg)]/[0.07] motion-reduce:hidden"
                style={{
                  animation: `termic-toast-countdown ${countdown.ms}ms linear forwards`,
                  animationPlayState: countdown.paused ? "paused" : "running",
                }}
              />
            )}
            <span className="relative">{tr("dismiss")}</span>
          </button>
          {t.actions.map((a, i) => (
            <button
              key={a.label}
              type="button"
              onClick={() => { if (preview) return; a.onClick(); onDismiss?.(); }}
              className={cn(cell, i === 0 ? "text-[var(--color-accent)]" : "text-[var(--color-fg)]")}
            >
              {a.icon && <a.icon className="h-3.5 w-3.5" />}
              {a.label}
            </button>
          ))}
        </div>
      </div>
      {/* The notice's options: a round "..." on the top-right corner, on
          hover, and held while its menu is open. */}
      {t.notice && !tucked && (
        <DropdownRoot modal={false} onOpenChange={open => { setMenuOpen(open); onMenuOpenChange?.(open); }}>
          <DropdownTrigger asChild disabled={preview}>
            <button
              type="button"
              aria-label={tr("toast.options")}
              data-testid="toast-options"
              className={cn(
                "absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-2)] text-[var(--color-fg-dim)] shadow-md hover:text-[var(--color-fg)]",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                preview && "hidden",
              )}
            >
              <MoreHorizontal className="h-3 w-3" />
            </button>
          </DropdownTrigger>
          <DropdownMenu className="z-[10001]" side="top" align="end">
            <DropdownItem
              data-testid="toast-mute"
              onSelect={() => { mute(t.notice!, true); onDismiss?.(); }}
            >
              <BellOff className="h-3.5 w-3.5" />
              {tr("toast.mute")}
            </DropdownItem>
          </DropdownMenu>
        </DropdownRoot>
      )}
    </div>
  );
}
