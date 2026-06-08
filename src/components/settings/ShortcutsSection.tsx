// Editable keyboard-shortcut bindings. Each row records a new combo on click
// (capture-phase listener so the global handler never sees the recording
// keystroke), warns on conflicts, and can reset to its factory binding. The
// command registry + defaults live in `src/lib/shortcuts.ts`; the resolved
// bindings live in the prefs store.

import { useEffect, useMemo, useState } from "react";
import { usePrefs } from "@/store/prefs";
import { Button } from "@/components/ui/Button";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SHORTCUT_DEFS,
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
  type ShortcutId,
} from "@/lib/shortcuts";

export function ShortcutsSection() {
  const shortcuts = usePrefs(s => s.shortcuts);
  const setShortcut = usePrefs(s => s.setShortcut);
  const resetShortcut = usePrefs(s => s.resetShortcut);
  const resetAllShortcuts = usePrefs(s => s.resetAllShortcuts);

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
      // (e.g. ⇧⌘D: new-split-terminal vs the context-scoped discard-file).
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
      if (!isValidBinding(b)) {
        setRecordError(`Add ${CMD_LABEL} or ${ALT_LABEL} to the combo.`);
        return;
      }
      setShortcut(recordingId, b);
      setRecordingId(null);
      setRecordError(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recordingId, setShortcut]);

  const anyCustom = SHORTCUT_DEFS.some(d => !bindingsEqual(shortcuts[d.id], DEFAULT_BINDINGS[d.id]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] font-medium">Shortcuts</h1>
          <p className="text-[12.5px] text-[var(--color-fg-faint)]">
            Click a shortcut to rebind it. Press Esc while recording to cancel.
          </p>
        </div>
        <Button
          variant="ghost"
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[12.5px]"
          disabled={!anyCustom}
          onClick={() => { setRecordingId(null); resetAllShortcuts(); }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset all
        </Button>
      </div>

      {GROUP_ORDER.map(group => {
        const defs = SHORTCUT_DEFS.filter(d => d.group === group);
        if (defs.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-2">
            <div className="px-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
              {group}
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
                          Conflicts with another shortcut
                        </span>
                      )}
                      {isRecording && recordError && (
                        <span className="text-[11.5px] text-[var(--color-accent)]">{recordError}</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isCustom && !isRecording && (
                        <button
                          title="Reset to default"
                          onClick={() => resetShortcut(def.id)}
                          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => { setRecordError(null); setRecordingId(isRecording ? null : def.id); }}
                        className={cn(
                          "flex min-h-[28px] min-w-[72px] items-center justify-center gap-1 rounded-md border px-2 py-1",
                          isRecording
                            ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                            : isConflict
                              ? "border-[var(--color-accent)] hover:bg-[var(--color-hover)]"
                              : "border-[var(--color-border)] hover:bg-[var(--color-hover)]",
                        )}
                      >
                        {isRecording
                          ? <span className="text-[12px]">Press keys…</span>
                          : bindingGlyphs(binding).map((g, idx) => <Key key={idx} glyph={g} />)}
                      </button>
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
  // Platform-aware human name (Cmd/Ctrl, Option/Alt, Up, …); letters, digits,
  // brackets and the 1…9 range render as themselves. The mac symbols alone
  // read like hieroglyphs to anyone who hasn't memorized them.
  const name = glyphLabel(glyph);
  return (
    <kbd className="inline-flex items-center rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-[11.5px] leading-none text-[var(--color-fg)]">
      {name}
    </kbd>
  );
}
