// One rule block (the ordered allow/deny rules for a secret on a host, plus
// its fallback) and the pieces its rows are built from.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownUp, Eye, EyeOff, GripVertical, Plus, X } from "lucide-react";
import type { Rule, RuleEffect, RuleSet } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { type BlockKind, specificityOrder } from "./model";
import { CommitInput, Eyebrow } from "./parts";
import { VerbPicker } from "./VerbPicker";

// a rule drag in progress. Rows are measured once at the start: nothing
// reflows during the drag (only transforms move), so the centers stay valid.
interface RuleDrag { from: number; startY: number; dy: number; started: boolean; centers: number[]; step: number }

/** Where the dragged row would land: one slot per other row whose center it
 *  has passed. */
function dropIndex(d: RuleDrag): number {
  const c = d.centers[d.from] + d.dy;
  return d.centers.filter((y, j) => j !== d.from && y < c).length;
}

/** How far row j steps aside to open the gap at `to`. */
function shiftFor(j: number, from: number, to: number, step: number): number {
  if (from < to && j > from && j <= to) return -step;
  if (from > to && j >= to && j < from) return step;
  return 0;
}

export function RuleBlock({ title, kind, set, inherited, hit, onChange }: {
  title: string; kind: BlockKind; set: RuleSet; inherited: boolean;
  /** The request tester's deciding line: a rule index, or "fallback". */
  hit?: number | "fallback";
  onChange: (s: RuleSet) => void;
}) {
  const { t } = useTranslation("secrets");
  // a drag commits on pointerup, after the blur that saves a pending edit has
  // re-rendered this block. Reading props from the pointerdown closure would
  // save the pre-edit rules over that edit, so read the latest ones.
  const latest = useRef({ set, onChange });
  latest.current = { set, onChange };
  // rules carry no id, so rows get one here, moved with the rule. Keyed by
  // index, a field holding an uncommitted edit stayed at its index through a
  // reorder and then committed onto whichever rule landed there (possibly one
  // with the opposite effect).
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < set.rules.length) keys.current.push(nextKey.current++);
  keys.current.length = set.rules.length;
  const put = (rules: Rule[]) => latest.current.onChange({ ...latest.current.set, rules });
  const at = (i: number, p: Partial<Rule>) => put(latest.current.set.rules.map((r, j) => j === i ? { ...r, ...p } : r));
  const remove = (i: number) => {
    keys.current.splice(i, 1);
    put(latest.current.set.rules.filter((_, j) => j !== i));
  };
  const listRef = useRef<HTMLDivElement>(null);
  const move = (from: number, to: number, refocus = false) => {
    const rules = latest.current.set.rules;
    if (to === from || to < 0 || to >= rules.length) return;
    const next = [...rules];
    next.splice(to, 0, ...next.splice(from, 1));
    keys.current.splice(to, 0, ...keys.current.splice(from, 1));
    put(next);
    // keyboard moves: keep focus on the handle of the rule that moved.
    if (refocus) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-rule-index="${to}"] [data-rule-handle]`)?.focus());
  };
  const sort = () => {
    const rules = latest.current.set.rules;
    const order = specificityOrder(rules);
    if (order.every((o, i) => o === i)) return;
    keys.current = order.map(i => keys.current[i]);
    put(order.map(i => rules[i]));
  };

  // pointer drag on window listeners (not HTML5 DnD: WKWebView's is
  // unreliable and Tauri takes it for file drops). The row follows the
  // cursor, the rows it passes step aside, and the order commits on release,
  // so a drag is one save rather than one per row crossed. Each drag keeps
  // its own `d` in closure: state is only for painting, and window events
  // are not flushed one by one, so reading state back would go stale.
  const [drag, setDrag] = useState<RuleDrag | null>(null);
  const to = drag?.started ? dropIndex(drag) : null;
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  function onHandleDown(i: number, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const rects = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-rule-index]") ?? [], r => r.getBoundingClientRect());
    if (!rects[i]) return;
    e.preventDefault();
    let d: RuleDrag = {
      from: i, startY: e.clientY, dy: 0, started: false,
      centers: rects.map(r => r.top + r.height / 2),
      step: rects.length > 1 ? rects[1].top - rects[0].top : rects[i].height,
    };
    setDrag(d);
    // only the pointer that started the drag moves it: WebKit sends a
    // synthetic move at the real cursor after a re-render, which is another
    // pointer when a test drives this one, and it dropped the rule back.
    const id = e.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const dy = ev.clientY - d.startY;
      if (!d.started && Math.abs(dy) < 4) return;
      d = { ...d, dy, started: true };
      setDrag(d);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopDrag.current = null;
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      stop();
      if (d.started) move(d.from, dropIndex(d));
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    stopDrag.current = stop;
  }

  const testid = `rules-${set.host}`;
  return (
    <div ref={listRef} className="flex flex-col gap-1.5" data-testid={testid} data-rule-kind={kind}>
      <Eyebrow>{title}</Eyebrow>
      {set.rules.length === 0 && set.fallback === "allow" && (
        <div className="text-[12.5px] text-[var(--color-fg-faint)]">{t("manage.editor.noRules")}</div>
      )}
      {inherited && set.fallback === "deny" && (
        <div data-testid={`${testid}-inherited-deny`} className="text-[12.5px] text-[var(--color-fg-faint)]">{t("manage.editor.noRulesDeny")}</div>
      )}
      {set.rules.map((r, i) => {
        const dragging = drag?.started && drag.from === i;
        const ty = !drag || to === null ? 0 : dragging ? drag.dy : shiftFor(i, drag.from, to, drag.step);
        return (
        <div
          key={keys.current[i]}
          data-rule-index={i}
          data-rule-disabled={r.disabled || undefined}
          data-rule-hit={hit === i || undefined}
          style={to !== null ? { transform: `translateY(${ty}px)`, position: "relative", zIndex: dragging ? 10 : undefined } : undefined}
          className={cn(
            "flex items-center gap-2 rounded-md border bg-[var(--color-bg)] px-2 py-1.5",
            dragging ? "border-[var(--color-accent)] shadow-xl" : hit === i ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : "border-[var(--color-border-soft)]",
            to !== null && !dragging && "transition-transform duration-150",
            r.disabled && !dragging && "opacity-50",
          )}
        >
          <button
            type="button"
            data-rule-handle
            aria-label={t("manage.editor.dragRule")}
            title={t("manage.editor.dragRule")}
            onPointerDown={e => onHandleDown(i, e)}
            onKeyDown={e => {
              const d = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
              if (d) { e.preventDefault(); move(i, i + d, true); }
            }}
            style={{ touchAction: "none" }}
            className="-ml-1 shrink-0 cursor-grab rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <EffectPill effect={r.effect} onClick={() => at(i, { effect: r.effect === "allow" ? "deny" : "allow" })} />
          <VerbPicker kind={kind} methods={r.methods} onChange={m => at(i, { methods: m })} />
          <CommitInput
            aria-label={t("manage.editor.pattern")}
            data-field="pattern"
            value={r.pattern}
            placeholder={t(kind === "git" ? "manage.editor.patternPlaceholderGit" : "manage.editor.patternPlaceholderApi")}
            onCommit={v => {
              // an empty pattern matches EVERY path while the field shows its
              // placeholder; only QUERY (no name to match) may go without.
              const p = v.trim();
              if (!p && !r.methods.every(m => m.toUpperCase() === "QUERY")) return false;
              at(i, { pattern: p });
            }}
            className="h-8 min-w-0 flex-1 font-mono text-[12.5px]"
          />
          <CommitInput
            aria-label={t("manage.editor.note")}
            data-field="note"
            value={r.note}
            placeholder={t("manage.editor.notePlaceholder")}
            onCommit={v => at(i, { note: v })}
            className="h-8 w-56 shrink-0 text-[12.5px] text-[var(--color-fg-dim)]"
          />
          <IconBtn label={t(r.disabled ? "manage.editor.enableRule" : "manage.editor.disableRule")} onClick={() => at(i, { disabled: !r.disabled })}>
            {r.disabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </IconBtn>
          <IconBtn label={t("manage.editor.removeRule")} onClick={() => remove(i)}><X className="h-3.5 w-3.5" /></IconBtn>
        </div>
        );
      })}
      {/* The fallback: what happens when no rule above matched. Dashed, like
          the mock, because it is not a rule you can move or delete. */}
      <div
        data-rule-fallback
        data-rule-hit={hit === "fallback" || undefined}
        className={cn(
          "flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5",
          hit === "fallback" ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : "border-[var(--color-border)]",
        )}
      >
        <span aria-hidden className="-ml-1 w-5 shrink-0" />
        <EffectPill effect={set.fallback} onClick={() => onChange({ ...set, fallback: set.fallback === "allow" ? "deny" : "allow" })} />
        <span className="w-40 shrink-0 px-3 font-mono text-[12.5px]">*</span>
        <span className="flex-1 font-mono text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.fallbackAll")}</span>
      </div>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          data-testid={`${testid}-add`}
          onClick={() => put([...set.rules, { effect: "allow", methods: kind === "git" ? ["fetch"] : ["GET"], pattern: kind === "git" ? "*" : "/**", note: "" }])}
        >
          <Plus className="h-3.5 w-3.5" /> {t("manage.editor.addRule")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid={`${testid}-sort`}
          disabled={set.rules.filter(r => !r.disabled).length < 2}
          title={t("manage.editor.sortTip")}
          onClick={sort}
        >
          <ArrowDownUp className="h-3.5 w-3.5" /> {t("manage.editor.sort")}
        </Button>
      </div>
    </div>
  );
}

function EffectPill({ effect, onClick }: { effect: RuleEffect; onClick: () => void }) {
  const { t } = useTranslation("secrets");
  return (
    <button
      type="button"
      data-effect={effect}
      title={t("manage.editor.toggleEffect")}
      onClick={onClick}
      className={cn(
        "w-16 shrink-0 rounded py-1 text-center text-[11px] font-semibold uppercase tracking-wider",
        effect === "allow"
          ? "bg-[var(--color-ok)]/15 text-[var(--color-ok)]"
          : "bg-[var(--color-err)]/15 text-[var(--color-err)]",
      )}
    >
      {effect === "allow" ? t("manage.editor.allow") : t("manage.editor.deny")}
    </button>
  );
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}
