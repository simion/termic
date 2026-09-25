// Editable keyboard-shortcut bindings. Each row records a new combo on click
// (capture-phase listener so the global handler never sees the recording
// keystroke), warns on conflicts, and can reset to its factory binding. The
// command registry + defaults live in `src/lib/shortcuts.ts`; the resolved
// bindings live in the prefs store.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefs } from "@/store/prefs";
import { Button } from "@/components/ui/Button";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SHORTCUT_DEFS,
  FIXED_SHORTCUTS,
  DOUBLE_SHIFT_MODES,
  GROUP_ORDER,
  NON_CONFLICTING_GROUPS,
  DEFAULT_BINDINGS,
  CMD_LABEL,
  ALT_LABEL,
  bindingGlyphs,
  bindingFromEvent,
  bindingSignature,
  bindingsEqual,
  glyphLabel,
  isValidBinding,
  isReservedKey,
  CTRL_TAB_MODES,
  IS_MAC,
  type ShortcutId,
} from "@/lib/shortcuts";
import { groupLabel } from "@/components/dialogs/ShortcutsHelpDialog";
import type { CtrlTabMode, DoubleShiftMode } from "@/store/prefs";

// Terminal copy/paste are native (⌘C / ⌘V) on macOS and only wired/rebindable
// on Linux/Windows, so hide their rows from the macOS shortcuts list.
const HIDDEN_ON_MAC: Set<ShortcutId> = IS_MAC
  ? new Set<ShortcutId>(["terminal-copy", "terminal-paste"])
  : new Set<ShortcutId>();

export function ShortcutsSection() {
  const { t } = useTranslation("settings");
  const shortcuts = usePrefs(s => s.shortcuts);
  // The code-navigation group is named after the feature, which is named
  // after what it is currently doing (lib/lsp/featureName.ts).
  const typeChecking = usePrefs(s => s.codeIntelDiagnostics);
  const setShortcut = usePrefs(s => s.setShortcut);
  const resetShortcut = usePrefs(s => s.resetShortcut);
  const resetAllShortcuts = usePrefs(s => s.resetAllShortcuts);
  const doubleShiftMode = usePrefs(s => s.doubleShiftMode);
  const setDoubleShiftMode = usePrefs(s => s.setDoubleShiftMode);
  const ctrlTabMode = usePrefs(s => s.ctrlTabMode);
  const setCtrlTabMode = usePrefs(s => s.setCtrlTabMode);

  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Map each binding signature → the ids using it, so we can flag clashes.
  const conflicts = useMemo(() => {
    const bySig = new Map<string, ShortcutId[]>();
    for (const def of SHORTCUT_DEFS) {
      const sig = bindingSignature(shortcuts[def.id]);
      const list = bySig.get(sig) ?? [];
      list.push(def.id);
      bySig.set(sig, list);
    }
    const clashing = new Set<ShortcutId>();
    for (const list of bySig.values()) {
      if (list.length <= 1) continue;
      // Skip groups that are co-bound on purpose and can't fire together
      // by context (currently empty: see NON_CONFLICTING_GROUPS).
      const exempt = NON_CONFLICTING_GROUPS.some(g => list.every(id => g.includes(id)));
      if (exempt) continue;
      list.forEach(id => clashing.add(id));
    }
    return clashing;
  }, [shortcuts]);

  // Capture-phase recorder: fires BEFORE the global useShortcuts handler and
  // swallows the event so recording a combo never also triggers the command.
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setRecordingId(null); setRecordError(null); return; }
      const digitMode = recordingId === "jump-to-tab";
      const b = bindingFromEvent(e, digitMode);
      if (!b) return; // bare modifier press — keep waiting for the real key
      // Named before the generic check, which would otherwise tell someone who
      // pressed ⌃⇥ to add Ctrl to a combo that already has it.
      if (isReservedKey(b.key)) {
        setRecordError(t("shortcuts.reservedTab"));
        return;
      }
      if (!isValidBinding(b)) {
        setRecordError(t("shortcuts.needsMod", { cmd: CMD_LABEL, alt: ALT_LABEL }));
        return;
      }
      setShortcut(recordingId, b);
      setRecordingId(null);
      setRecordError(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recordingId, setShortcut, t]);

  const anyCustom = SHORTCUT_DEFS.some(d => !bindingsEqual(shortcuts[d.id], DEFAULT_BINDINGS[d.id]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] font-medium">{t("rail.shortcuts")}</h1>
          <p className="text-[12.5px] text-[var(--color-fg-faint)]">
            {t("shortcuts.sub")}
          </p>
        </div>
        <Button
          variant="ghost"
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[12.5px]"
          disabled={!anyCustom}
          onClick={() => { setRecordingId(null); resetAllShortcuts(); }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("shortcuts.resetAll")}
        </Button>
      </div>

      {GROUP_ORDER.map(group => {
        const defs = SHORTCUT_DEFS.filter(d => d.group === group && !HIDDEN_ON_MAC.has(d.id));
        // Gestures that cannot be expressed as a chord (double-Shift). Shown
        // here read-only rather than hidden: a reader who comes looking for
        // "how do I open Search everywhere" should find it in the same list,
        // and finding it absent reads as "this app does not have it".
        const fixed = FIXED_SHORTCUTS.filter(f => f.group === group);
        if (defs.length === 0 && fixed.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-2">
            <div className="px-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
              {groupLabel(group, typeChecking)}
            </div>
            <div className="rounded-lg border border-[var(--color-border-soft)] overflow-hidden">
              {defs.map((def, i) => {
                const binding = shortcuts[def.id];
                const isRecording = recordingId === def.id;
                const isConflict = conflicts.has(def.id);
                const isCustom = !bindingsEqual(binding, DEFAULT_BINDINGS[def.id]);
                return (
                  <div
                    key={def.id}
                    className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13.5px]"
                    style={{ borderTop: i === 0 ? undefined : "1px solid var(--color-border-soft)" }}
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{def.label}</span>
                      {def.hint && (
                        <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{def.hint}</span>
                      )}
                      {isConflict && (
                        <span className="text-[11.5px] text-[var(--color-accent)]">
                          {t("shortcuts.conflict")}
                        </span>
                      )}
                      {isRecording && recordError && (
                        <span className="text-[11.5px] text-[var(--color-accent)]">{recordError}</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isCustom && !isRecording && (
                        <button
                          title={t("shortcuts.resetDefault")}
                          onClick={() => resetShortcut(def.id)}
                          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => { setRecordError(null); setRecordingId(isRecording ? null : def.id); }}
                        className={cn(
                          "flex min-h-[28px] min-w-[80px] items-center justify-center gap-1 rounded-md px-2 py-1 hover:bg-[var(--color-hover)]",
                          isRecording
                            ? "ring-1 ring-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                            : isConflict
                              ? "ring-1 ring-[var(--color-accent)]"
                              : "",
                        )}
                      >
                        {isRecording
                          ? <span className="text-[12px]">{t("shortcuts.pressKeys")}</span>
                          : bindingGlyphs(binding).map((g, idx) => <Key key={idx} glyph={g} />)}
                      </button>
                    </div>
                  </div>
                );
              })}
              {fixed.map((f, i) => (
                <div
                  key={f.id}
                  data-testid="fixed-shortcut-row"
                  className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13.5px]"
                  style={{
                    borderTop: defs.length === 0 && i === 0
                      ? undefined
                      : "1px solid var(--color-border-soft)",
                  }}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{f.label}</span>
                    <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{f.hint}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* No recorder, and a word saying why. An empty slot where
                        every other row has a button reads as a bug. Suppressed
                        for the row that carries a select: that select names
                        the gesture in full, and printing "Double tap" beside
                        "Double left Shift" said the same thing twice, in two
                        different vocabularies. */}
                    {!f.control && (
                      <span className="text-[11.5px] text-[var(--color-fg-faint)]">{f.fixedReason}</span>
                    )}
                    <div className={cn(
                      "flex min-h-[28px] min-w-[80px] items-center justify-center gap-1 px-2 py-1",
                      // Keys still shown while off, greyed: the row is also
                      // the answer to "what was that gesture", and hiding them
                      // would make turning it back on a guess.
                      f.control === "double-shift" && doubleShiftMode === "off" && "opacity-40",
                      f.control === "ctrl-tab" && ctrlTabMode === "off" && "opacity-40",
                    )}>
                      {f.glyphs.map((g, idx) => <Key key={idx} glyph={g} />)}
                    </div>
                    {/* A gesture with no chord cannot be rebound, so the choice
                        is about the gesture itself rather than which key it
                        sits on. It sits where the recorder does on every other
                        row, and a select rather than a switch because "off" is
                        only one of the four answers people want. */}
                    {f.control === "double-shift" && (
                      <select
                        data-testid="double-shift-mode"
                        aria-label={t("shortcuts.doubleShiftAria")}
                        value={doubleShiftMode}
                        onChange={(e) => setDoubleShiftMode(e.target.value as DoubleShiftMode)}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-1 text-[12.5px] text-[var(--color-fg)]"
                      >
                        {DOUBLE_SHIFT_MODES.map(o => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    )}
                    {/* On/off, where double-Shift needs four: the awkward
                        question that one answers ("should it fire while I am
                        typing?") has no equivalent here, since Tab with Ctrl
                        held types nothing. Still a select rather than a
                        switch, so the row reads the same as its neighbour and
                        the option can name the whole gesture. */}
                    {f.control === "ctrl-tab" && (
                      <select
                        data-testid="ctrl-tab-mode"
                        aria-label={t("shortcuts.ctrlTabAria")}
                        value={ctrlTabMode}
                        onChange={(e) => setCtrlTabMode(e.target.value as CtrlTabMode)}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-1 text-[12.5px] text-[var(--color-fg)]"
                      >
                        {CTRL_TAB_MODES.map(o => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Key({ glyph }: { glyph: string }) {
  const name = glyphLabel(glyph);
  return (
    <kbd
      style={{
        background: "color-mix(in srgb, var(--color-fg) 9%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-fg) 18%, transparent)",
      }}
      className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[12.5px] leading-none text-[var(--color-fg)]"
    >
      {name}
    </kbd>
  );
}
