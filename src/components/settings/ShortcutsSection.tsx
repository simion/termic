// Editable keyboard-shortcut bindings. Each row records a new combo on click
// (capture-phase listener so the global handler never sees the recording
// keystroke), warns on conflicts, and can reset to its factory binding. The
// command registry + defaults live in `src/lib/shortcuts.ts`; the resolved
// bindings live in the prefs store.
//
// Two kinds of recorder. A chord row records a `Binding` (one combination
// pressed at once). The recently-used-tabs row records a `HoldGesture` (a
// modifier to hold and a key to tap), with refusals of its own (the system's
// chords, keys the terminal or the editor needs, keys that type): the rules
// are `holdGestureError` in lib/shortcuts.ts.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefs } from "@/store/prefs";
import { Button } from "@/components/ui/Button";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SHORTCUT_DEFS,
  GESTURE_SHORTCUTS,
  DOUBLE_SHIFT_MODES,
  GROUP_ORDER,
  DEFAULT_BINDINGS,
  DEFAULT_RECENT_TABS,
  CMD_LABEL,
  ALT_LABEL,
  bindingGlyphs,
  bindingFromEvent,
  bindingsEqual,
  conflicts as findConflicts,
  glyphLabel,
  holdGestureFromEvent,
  holdGestureGlyphs,
  holdGesturesEqual,
  holdModifierChoices,
  isValidBinding,
  isReservedKey,
  CTRL_TAB_MODES,
  IS_MAC,
  type HoldError,
  type ShortcutId,
  type GestureShortcutId,
} from "@/lib/shortcuts";
import {
  ctrlTabModeLabel,
  doubleShiftModeLabel,
  gestureShortcutHint,
  gestureShortcutLabel,
  shortcutGroupLabel,
  shortcutHint,
  shortcutLabel,
} from "@/lib/shortcutCopy";
import type { CtrlTabMode, DoubleShiftMode } from "@/store/prefs";
import { IS_LINUX } from "@/lib/platform";

// Terminal copy/paste are native (⌘C / ⌘V) on macOS and only wired/rebindable
// on Linux/Windows, so hide their rows from the macOS shortcuts list.
const HIDDEN_ON_MAC: Set<ShortcutId> = IS_MAC
  ? new Set<ShortcutId>(["terminal-copy", "terminal-paste"])
  : new Set<ShortcutId>();

const SELECT_CLASS =
  "rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-1 text-[12.5px] text-[var(--color-fg)]";

const RESET_CLASS =
  "flex h-6 w-6 items-center justify-center rounded text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]";

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
  const gesture = usePrefs(s => s.recentTabsGesture);
  const setGesture = usePrefs(s => s.setRecentTabsGesture);

  const [recordingId, setRecordingId] = useState<ShortcutId | GestureShortcutId | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Chord vs chord, and (while it is on) the gesture vs any chord on its key.
  // The rules are in `conflicts`, pure and tested.
  const clash = useMemo(
    () => findConflicts(shortcuts, gesture, ctrlTabMode),
    [shortcuts, gesture, ctrlTabMode],
  );

  // Capture-phase recorder: fires BEFORE the global useShortcuts handler and
  // swallows the event so recording a combo never also triggers the command.
  // The recently-used-tabs walk is a capture listener too, registered earlier,
  // and it stands down while Settings is open, which is what lets its own
  // gesture be recorded here.
  useEffect(() => {
    if (!recordingId) return;
    const holdErrorText = (err: HoldError) => {
      switch (err.kind) {
        case "holdNeedsOne": return t("shortcuts.holdNeedsOne", { mods: holdModifierChoices() });
        case "holdOsReserved": return t("shortcuts.holdOsReserved", { keys: err.keys });
        case "holdRecorderKey": return t("shortcuts.holdRecorderKey", { mod: err.mod, allowed: err.allowed });
        case "holdMovesCursor": return t("shortcuts.holdMovesCursor", { mod: err.mod, allowed: err.allowed });
        case "holdTerminalKey": return t("shortcuts.holdTerminalKey", { mod: err.mod, allowed: err.allowed });
        case "holdMetaKey": return t("shortcuts.holdMetaKey", { mod: err.mod, allowed: err.allowed });
        case "holdTypes": return t("shortcuts.holdTypes", { mod: err.mod, allowed: err.allowed });
        case "holdAppKey": return t("shortcuts.holdAppKey", { mod: err.mod, allowed: err.allowed });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setRecordingId(null); setRecordError(null); return; }
      if (recordingId === "recent-tabs") {
        const g = holdGestureFromEvent(e);
        if (!g) return; // bare modifier press: keep waiting for the key
        if ("error" in g) { setRecordError(holdErrorText(g.error)); return; }
        setGesture(g);
        setRecordingId(null);
        setRecordError(null);
        return;
      }
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
  }, [recordingId, setShortcut, setGesture, t]);

  const gestureCustom = !holdGesturesEqual(gesture, DEFAULT_RECENT_TABS);
  const anyCustom = gestureCustom
    || SHORTCUT_DEFS.some(d => !bindingsEqual(shortcuts[d.id], DEFAULT_BINDINGS[d.id]));

  const toggleRecording = (id: ShortcutId | GestureShortcutId) => {
    setRecordError(null);
    setRecordingId(recordingId === id ? null : id);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] font-medium">{t("rail.shortcuts")}</h1>
          <p className="text-[12.5px] text-[var(--color-fg-faint)]">
            {t("shortcuts.sub")}
          </p>
          {/* Linux only. Windows follows the same rule with the Windows key,
              but which Win chords the shell keeps for itself there has not
              been measured, so it is not promised on that page. */}
          {IS_LINUX && (
            <p data-testid="shortcuts-terminal-note" className="text-[12.5px] text-[var(--color-fg-dim)]">
              {t("shortcuts.terminalNote", { key: "Super" })}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[12.5px]"
          disabled={!anyCustom}
          onClick={() => { setRecordingId(null); resetAllShortcuts(); setGesture(DEFAULT_RECENT_TABS); }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("shortcuts.resetAll")}
        </Button>
      </div>

      {GROUP_ORDER.map(group => {
        const defs = SHORTCUT_DEFS.filter(d => d.group === group && !HIDDEN_ON_MAC.has(d.id));
        // Gestures that are not a chord (hold a modifier, tap a key). Their
        // own recorder, on the same list: a reader who comes looking for
        // "how do I go back to the last tab" should find it here.
        const gestures = GESTURE_SHORTCUTS.filter(f => f.group === group);
        if (defs.length === 0 && gestures.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-2">
            <div className="px-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
              {shortcutGroupLabel(group, typeChecking, t)}
            </div>
            <div className="rounded-lg border border-[var(--color-border-soft)] overflow-hidden">
              {defs.map((def, i) => {
                const binding = shortcuts[def.id];
                const isRecording = recordingId === def.id;
                const isConflict = clash.chords.has(def.id);
                const gestureWins = clash.withGesture.includes(def.id);
                const isCustom = !bindingsEqual(binding, DEFAULT_BINDINGS[def.id]);
                const hint = shortcutHint(def.id, t);
                // Search everywhere: both of its triggers off means the row
                // names a command nothing opens, so its keys go grey.
                const inert = def.gesture === "double-shift" && !binding && doubleShiftMode === "off";
                return (
                  <div
                    key={def.id}
                    data-testid="settings-shortcut-row"
                    data-row-id={def.id}
                    className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13.5px]"
                    style={{ borderTop: i === 0 ? undefined : "1px solid var(--color-border-soft)" }}
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{shortcutLabel(def.id, t)}</span>
                      {hint && (
                        <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{hint}</span>
                      )}
                      {isConflict && (
                        <span className="text-[11.5px] text-[var(--color-accent)]">
                          {t("shortcuts.conflict")}
                        </span>
                      )}
                      {gestureWins && (
                        <span data-testid="shortcut-gesture-conflict" className="text-[11.5px] text-[var(--color-accent)]">
                          {t("shortcuts.conflictGesture")}
                        </span>
                      )}
                      {isRecording && recordError && (
                        <span className="text-[11.5px] text-[var(--color-accent)]">{recordError}</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isCustom && !isRecording && (
                        <button
                          data-testid="shortcut-reset"
                          title={t("shortcuts.resetDefault")}
                          onClick={() => resetShortcut(def.id)}
                          className={RESET_CLASS}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        data-testid="shortcut-recorder"
                        onClick={() => toggleRecording(def.id)}
                        className={cn(
                          "flex min-h-[28px] min-w-[80px] items-center justify-center gap-1 rounded-md px-2 py-1 hover:bg-[var(--color-hover)]",
                          isRecording
                            ? "ring-1 ring-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                            : isConflict || gestureWins
                              ? "ring-1 ring-[var(--color-accent)]"
                              : "",
                          inert && !isRecording && "opacity-40",
                        )}
                      >
                        {isRecording
                          ? <span className="text-[12px]">{t("shortcuts.pressKeys")}</span>
                          : binding
                            ? bindingGlyphs(binding).map((g, idx) => <Key key={idx} glyph={g} />)
                            : <span className="text-[12px] text-[var(--color-fg-faint)]">{t("shortcuts.notSet")}</span>}
                      </button>
                      {/* Double-Shift has no key to record, so what it offers
                          is WHEN it applies. Independent of the chord: either
                          one opens the dialog, and either can be off. */}
                      {def.gesture === "double-shift" && (
                        <select
                          data-testid="double-shift-mode"
                          aria-label={t("shortcuts.doubleShiftAria")}
                          value={doubleShiftMode}
                          onChange={(e) => setDoubleShiftMode(e.target.value as DoubleShiftMode)}
                          className={SELECT_CLASS}
                        >
                          {DOUBLE_SHIFT_MODES.map(mode => (
                            <option key={mode} value={mode}>{doubleShiftModeLabel(mode, t)}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
              {gestures.map((f, i) => {
                const isRecording = recordingId === f.id;
                const off = ctrlTabMode === "off";
                const shadowed = clash.withGesture.map(id => shortcutLabel(id, t));
                return (
                  <div
                    key={f.id}
                    data-testid="gesture-shortcut-row"
                    className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13.5px]"
                    style={{
                      borderTop: defs.length === 0 && i === 0
                        ? undefined
                        : "1px solid var(--color-border-soft)",
                    }}
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{gestureShortcutLabel(f.id, t)}</span>
                      <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">
                        {gestureShortcutHint(f.id, gesture, t)}
                      </span>
                      {shadowed.length > 0 && (
                        <span data-testid="gesture-conflict" className="text-[11.5px] text-[var(--color-accent)]">
                          {t("shortcuts.conflictGestureSelf", { names: shadowed.join(", ") })}
                        </span>
                      )}
                      {isRecording && recordError && (
                        <span data-testid="recent-tabs-error" className="text-[11.5px] text-[var(--color-accent)]">
                          {recordError}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {gestureCustom && !isRecording && (
                        <button
                          data-testid="recent-tabs-reset"
                          title={t("shortcuts.resetDefault")}
                          onClick={() => setGesture(DEFAULT_RECENT_TABS)}
                          className={RESET_CLASS}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {/* Keys still shown while off, greyed: the row is also
                          the answer to "what was that gesture", and hiding
                          them would make turning it back on a guess. Not
                          recordable while off, so the select is the one
                          thing on the row that does something. */}
                      <button
                        data-testid="recent-tabs-recorder"
                        aria-label={t("shortcuts.recentTabsRecorderAria")}
                        disabled={off}
                        onClick={() => toggleRecording(f.id)}
                        className={cn(
                          "flex min-h-[28px] min-w-[80px] items-center justify-center gap-1 rounded-md px-2 py-1",
                          off ? "opacity-40" : "hover:bg-[var(--color-hover)]",
                          isRecording
                            ? "ring-1 ring-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                            : shadowed.length > 0
                              ? "ring-1 ring-[var(--color-accent)]"
                              : "",
                        )}
                      >
                        {isRecording
                          ? <span className="text-[12px]">{t("shortcuts.pressKeys")}</span>
                          : holdGestureGlyphs(gesture).map((g, idx) => <Key key={idx} glyph={g} />)}
                      </button>
                      <select
                        data-testid="ctrl-tab-mode"
                        aria-label={t("shortcuts.ctrlTabAria")}
                        value={ctrlTabMode}
                        onChange={(e) => {
                          if (e.target.value === "off" && isRecording) setRecordingId(null);
                          setCtrlTabMode(e.target.value as CtrlTabMode);
                        }}
                        className={SELECT_CLASS}
                      >
                        {CTRL_TAB_MODES.map(mode => (
                          <option key={mode} value={mode}>{ctrlTabModeLabel(mode, t)}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
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
