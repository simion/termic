// "What is this agent actually emitting?" — the missing half of editing an
// agent's work-done signals.
//
// Writing a busy/done/needs-you pattern used to be guesswork: the strings you
// have to match are OSC titles, termic consumes them, and nothing ever showed
// them to you. Two views over the same ring buffer (lib/agentSignalLog):
//
//   Observed  — frequency table of every title seen, always on. The FIXING
//               path: why did this flip to done, what is it printing.
//   Capture   — labels one turn by its boundaries (you submit → titles →
//               quiescence) and proposes patterns. The AUTHORING path.
//
// Capture ends on quiescence rather than a timer. The bootstrap that makes it
// work on an agent with no signals: "done" then comes from the fallback
// heuristics (byte-quiet, scrollback-stable), which are too coarse to drive a
// live spinner but fine for labelling an offline sample.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation, Trans } from "react-i18next";
import {
  capturePhase,
  captureSamples,
  clearCapture,
  getSignalLogVersion,
  observationsFor,
  resetSignalLog,
  startCapture,
  stopCapture,
  subscribeSignalLog,
  type TitleObservation,
} from "@/lib/agentSignalLog";
import { compileSignals } from "@/lib/agents";
import { escapeRegex, proposeSignals, type SignalClass } from "@/lib/signalProposer";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { Circle, Copy, Plus, Trash2 } from "lucide-react";

/** Re-render on buffer changes. The buffer throttles its notifications, so
 *  this settles at ~4/s however fast the spinner repaints — and it holds NO
 *  listener while this panel is unmounted, so recording stays free. */
function useSignalLogVersion(): number {
  return useSyncExternalStore(
    subscribeSignalLog,
    getSignalLogVersion,
    getSignalLogVersion,
  );
}

/** Label keys, resolved through t() at render: the words are per-locale. */
const CLASS_LABEL: Record<SignalClass, string> = {
  busy: "agents.signals.classBusy",
  idle: "agents.signals.classDone",
  attention: "agents.signals.classAttention",
};

const CLASS_TONE: Record<SignalClass, string> = {
  busy: "text-[var(--color-warn)]",
  idle: "text-[var(--color-ok-fg)]",
  attention: "text-[var(--color-err)]",
};

export interface SignalInspectorProps {
  agentId: string;
  signals: { busy?: string[]; idle?: string[]; attention?: string[] } | undefined;
  /** Append a pattern to one of the three lists (deduped by the caller). */
  onAddPattern: (cls: SignalClass, pattern: string) => void;
}

export function SignalInspector({ agentId, signals, onAddPattern }: SignalInspectorProps) {
  const { t } = useTranslation("settings");
  const version = useSignalLogVersion();
  const [open, setOpen] = useState(false);
  const observations = open ? observationsFor(agentId) : [];
  const phase = capturePhase(agentId);

  // Drop a stale capture when the panel closes, so reopening never shows a
  // half-finished session from ten minutes ago.
  useEffect(() => {
    if (!open && phase !== "off") clearCapture();
  }, [open, phase]);

  // Which of the agent's CURRENT patterns match each observed title. Answers
  // "does my regex work" without relaunching anything.
  const matchers = useMemo(() => ({
    attention: compileSignals(signals?.attention ?? []),
    busy: compileSignals(signals?.busy ?? []),
    idle: compileSignals(signals?.idle ?? []),
  }), [signals]);

  const liveClass = (title: string): SignalClass | null => {
    // Same precedence the classifier uses, so the preview can't disagree with
    // what will actually happen at runtime.
    if (matchers.attention.some(re => re.test(title))) return "attention";
    if (matchers.busy.some(re => re.test(title))) return "busy";
    if (matchers.idle.some(re => re.test(title))) return "idle";
    return null;
  };

  const proposals = useMemo(
    () => (phase === "done" ? proposeSignals(captureSamples(agentId)) : null),
    [phase, agentId, version],
  );

  if (!open) {
    return (
      <div className="border-t border-[var(--color-border-soft)] pt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[12.5px] text-[var(--color-accent)] hover:underline"
        >
          {t("agents.signals.show")}
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--color-border-soft)] pt-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[12.5px] font-medium text-[var(--color-fg)]">
          {t("agents.signals.observed")}
        </div>
        <div className="flex items-center gap-2">
          {phase === "off" && (
            <Button variant="ghost" onClick={() => startCapture(agentId)}>
              {t("agents.signals.capture")}
            </Button>
          )}
          {(phase === "waiting-for-submit" || phase === "recording") && (
            <Button variant="ghost" onClick={() => stopCapture()}>{t("shared.stop")}</Button>
          )}
          {phase === "done" && (
            <Button variant="ghost" onClick={() => startCapture(agentId)}>
              {t("agents.signals.captureAgain")}
            </Button>
          )}
          <Button variant="ghost" onClick={() => resetSignalLog(agentId)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-[12px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            {t("common:hide")}
          </button>
        </div>
      </div>

      {phase === "waiting-for-submit" && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 px-2.5 py-2 text-[12px] text-[var(--color-fg-dim)]">
          <Circle className="h-2.5 w-2.5 shrink-0 animate-pulse fill-current text-[var(--color-accent)]" />
          {t("agents.signals.waiting")}
        </div>
      )}
      {phase === "recording" && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 px-2.5 py-2 text-[12px] text-[var(--color-fg-dim)]">
          <Circle className="h-2.5 w-2.5 shrink-0 animate-pulse fill-current text-[var(--color-warn)]" />
          {t("agents.signals.recording")}
        </div>
      )}

      {proposals && (
        <ProposalPanel proposals={proposals} onAddPattern={onAddPattern} />
      )}

      {observations.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-[12px] text-[var(--color-fg-dim)]">
          {t("agents.signals.empty")}
        </div>
      ) : (
        <div className="max-h-[260px] overflow-y-auto rounded-md border border-[var(--color-border-soft)]">
          <table className="w-full text-[12px]">
            <tbody>
              {observations.map(o => (
                <ObservationRow
                  key={o.title}
                  o={o}
                  live={liveClass(o.title)}
                  onAddPattern={onAddPattern}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-1.5 text-[11.5px] text-[var(--color-fg-faint)]">
        {t("agents.signals.footnote")}
      </div>
    </div>
  );
}

function ObservationRow({ o, live, onAddPattern }: {
  o: TitleObservation;
  live: SignalClass | null;
  onAddPattern: (cls: SignalClass, pattern: string) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <tr className="border-b border-[var(--color-border-soft)] last:border-0">
      {/* The whole point of this table is reading what the agent ACTUALLY
          emitted, so the title is never truncated: it takes the leftover width
          (w-full shrinks the nowrap columns to their content) and wraps rather
          than ending in an ellipsis. `pre-wrap` keeps leading/trailing spaces
          visible too, which is exactly the detail that decides whether a
          pattern like `^\s*✳` matches. Selectable so it can be copied by hand;
          the button in the last cell copies it exactly. */}
      <td className="w-full px-2.5 py-1.5">
        <div className="select-text whitespace-pre-wrap break-all font-mono text-[var(--color-fg)]">
          {o.title || <span className="text-[var(--color-fg-faint)]">{t("agents.signals.emptyTitle")}</span>}
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right align-top tabular-nums text-[var(--color-fg-faint)]">
        {o.seen}
      </td>
      {/* data-live-class: the "+ Busy" / "+ Done" buttons in the next cell
          carry the SAME words, so text alone can't tell a real classification
          from a button label. Assertions need something unambiguous. */}
      <td className="whitespace-nowrap px-2 py-1.5 align-top" data-live-class={live ?? "none"}>
        {live ? (
          <span className={cn("text-[11.5px]", CLASS_TONE[live])}>{t(CLASS_LABEL[live])}</span>
        ) : (
          <span className="text-[11.5px] text-[var(--color-fg-faint)]">{t("agents.signals.unmatched")}</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right align-top">
        <button
          type="button"
          title={t("agents.signals.copyTitle")}
          onClick={() => copyToClipboard(o.title, "title")}
          className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <Copy className="h-3 w-3" />
        </button>
        {(["busy", "idle", "attention"] as SignalClass[]).map(cls => (
          <button
            key={cls}
            type="button"
            title={t("agents.signals.addAs", { class: t(CLASS_LABEL[cls]) })}
            // Escape: these fields are regex sources, and a title like
            // "Working (2/3)" would otherwise become a pattern that matches
            // something else entirely (or fails to compile).
            onClick={() => onAddPattern(cls, escapeRegex(o.title))}
            className="ml-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
          >
            <Plus className="mr-0.5 inline h-3 w-3" />
            {t(CLASS_LABEL[cls])}
          </button>
        ))}
      </td>
    </tr>
  );
}

function ProposalPanel({ proposals, onAddPattern }: {
  proposals: ReturnType<typeof proposeSignals>;
  onAddPattern: (cls: SignalClass, pattern: string) => void;
}) {
  const { t } = useTranslation("settings");
  const groups: { cls: SignalClass; items: typeof proposals.busy }[] = [
    { cls: "busy", items: proposals.busy },
    { cls: "idle", items: proposals.idle },
  ];
  const any = groups.some(g => g.items.length > 0);

  return (
    <div className="mb-2 rounded-md border border-[var(--color-ok-fg)]/40 bg-[var(--color-ok-fg)]/5 p-2.5">
      <div className="mb-1.5 text-[12px] font-medium text-[var(--color-fg)]">
        {t("agents.signals.proposals")}
      </div>
      {!any && (
        <div className="text-[11.5px] text-[var(--color-fg-dim)]">
          {t("agents.signals.nothingUsable")}
        </div>
      )}
      {groups.map(({ cls, items }) => items.length > 0 && (
        <div key={cls} className="mb-1.5 last:mb-0">
          <div className={cn("text-[11px] uppercase tracking-wide", CLASS_TONE[cls])}>
            {t(CLASS_LABEL[cls])}
          </div>
          {items.map(p => (
            <div key={p.pattern} className="flex items-center gap-2 py-0.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-fg)]">
                {p.pattern}
              </code>
              {/* Show the evidence: a proposer that writes regexes without
                  saying what it saw gets distrusted the first time it's wrong. */}
              <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]" title={p.evidence.join("\n")}>
                {p.kind === "glyph-class" ? t("agents.signals.kindGlyph")
                  : p.kind === "common-text" ? t("agents.signals.kindText")
                  : t("agents.signals.kindExact")}
              </span>
              <Button variant="ghost" onClick={() => onAddPattern(cls, p.pattern)}>
                {t("agents.signals.use")}
              </Button>
            </div>
          ))}
        </div>
      ))}
      {proposals.rejected.length > 0 && (
        // Explain the absence. The obvious generalization is often the broken
        // one (claude's busy titles share the task name with its idle title),
        // and a silently missing suggestion looks like a bug.
        <div className="mt-1.5 border-t border-[var(--color-border-soft)] pt-1.5 text-[11px] text-[var(--color-fg-faint)]">
          <Trans
            t={t}
            i18nKey="agents.signals.skipped"
            count={proposals.rejected.length}
            values={{
              pattern: proposals.rejected[0].pattern,
              conflict: proposals.rejected[0].conflictsWith,
            }}
            components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
          />
        </div>
      )}
    </div>
  );
}
