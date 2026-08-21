// Shared controls for the settings sections. These used to live as private
// copies inside GeneralSection; splitting General into General / Tasks /
// Notifications / Sandbox / CLI gave them four call sites, so they moved here
// rather than being duplicated per file.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextareaHTMLAttributes } from "react";
import { settingsLoad, settingsSave, tasksPathConflicts } from "@/lib/ipc";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Tail of the in-flight patch chain: every patch awaits it before
 *  reading, and becomes it. Module scope on purpose, so sections that
 *  share a page serialize against each other and not just internally. */
let patchChain: Promise<unknown> = Promise.resolve();

/** Loads the backend Settings object once per mount and hands back a `patch`
 *  that merges into it, so a section saving one field can never wipe another
 *  section's (the whole object round-trips through settingsSave).
 *
 *  `patch` is a read-modify-write against the BACKEND, not against this
 *  hook's cache. Two reasons. Within one section, a second save (toggle,
 *  then a text field) would otherwise spread the object captured by the
 *  first render and revert the first save. Across sections, a page may now
 *  render more than one section using this hook (Settings -> CLI & MCP holds
 *  two), and each has its own snapshot: without re-reading, whichever saves
 *  last spreads its mount-time copy over the whole file and silently reverts
 *  the other's change on disk while both keep rendering their own local
 *  state. settings_save writes the whole struct, so the merge has to start
 *  from what is actually stored.
 *
 *  Patches are also SERIALIZED across every section, through a module
 *  level chain. The backend re-read introduced an await between reading
 *  the base and writing it back, so two toggles clicked in quick
 *  succession could both read the same on-disk state and the second
 *  would drop the first. Chaining means the second read happens after
 *  the first write, which is the property the old synchronous merge had
 *  within one section and never had across two. */

export function useBackendSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const ref = useRef<Settings | null>(null);

  useEffect(() => {
    settingsLoad().then(s => { ref.current = s; setSettings(s); }).catch(() => {});
  }, []);

  const store = useCallback((s: Settings) => { ref.current = s; setSettings(s); }, []);

  /** Merge `fields` into the cached Settings and persist. Returns false when
   *  the write failed (or settings had not loaded yet) so a caller can revert
   *  its optimistic UI instead of showing state it did not save. */
  const patch = useCallback(async (fields: Partial<Settings>): Promise<boolean> => {
    const cur = ref.current;
    if (!cur) return false;
    const run = patchChain.then(() => applyPatch(fields, cur, store));
    // Keep the chain alive even when this patch rejects, or one failure
    // would wedge every later save.
    patchChain = run.catch(() => {});
    return run;
  }, [store]);

  return { settings, store, patch };
}

/** One read-modify-write against the backend. Split out so the queue
 *  above reads as a queue. */
async function applyPatch(
  fields: Partial<Settings>,
  cur: Settings,
  store: (s: Settings) => void,
): Promise<boolean> {
  // Re-read so the merge starts from what is on disk, picking up any
  // field another section saved since this one mounted. A failed read
  // falls back to the cached copy: worst case is the old behaviour,
  // never a refusal to save.
  const base = await settingsLoad().catch(() => cur);
  const next: Settings = { ...base, ...fields };
  store(next);
  try {
    await settingsSave(next);
    return true;
  } catch {
    // Revert to what disk held a moment ago, NOT this section's
    // pre-patch snapshot: that snapshot may predate another section's
    // save, which is the staleness the re-read above exists to remove.
    store(base);
    return false;
  }
}

/** Names of the projects `path` would break, debounced and race-safe.
 *  Shared because the rule has two editors: the global default (Settings →
 *  Tasks) and a project's own override (Settings → Repositories → More), and
 *  two copies of the timing + cancellation would drift.
 *
 *  Pass an empty `path` to disable the check — callers use that to skip a
 *  value the user has not touched, and to stay quiet while the field is not
 *  even rendered. Omit `projectId` to validate as the global default. */
export function useTasksPathConflicts(path: string, projectId?: string): {
  names: string[]; checking: boolean;
} {
  // `null` = not judged yet, which is NOT the same as "no conflicts". Callers
  // gate their save on `checking` so the debounce window can't hand them a
  // stale all-clear for a value the backend has not seen: type a good path,
  // then a bad one, and for ~300ms the previous verdict would otherwise still
  // be on screen and the Save button still live.
  const [names, setNames] = useState<string[] | null>([]);
  useEffect(() => {
    if (!path) { setNames([]); return; }
    let cancelled = false;
    setNames(null);            // drop the previous value's verdict immediately
    const t = window.setTimeout(() => {
      tasksPathConflicts(path, projectId)
        .then(n => { if (!cancelled) setNames(n); })
        .catch(() => { if (!cancelled) setNames([]); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [path, projectId]);
  return { names: names ?? [], checking: names === null };
}

export function Toggle({ label, hint, value, onChange }: {
  label: string; hint?: React.ReactNode; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      </div>
      <button
        role="switch" aria-checked={value} onClick={() => onChange(!value)}
        style={{
          position: "relative",
          width: 36, height: 20, flexShrink: 0,
          borderRadius: 999, padding: 0, border: 0,
          background: value ? "var(--color-accent)" : "var(--color-bg-3)",
          transition: "background-color 150ms",
          cursor: "pointer",
          display: "inline-block",
          verticalAlign: "middle",
        }}
        className={cn()}
      >
        <span
          style={{
            position: "absolute", top: 2, left: value ? 18 : 2,
            width: 16, height: 16, borderRadius: 999,
            /* Knob picks up the on-accent ink when the track is filled —
               themes with a light accent (rosepine rose) need a dark knob
               there or knob and track melt together. */
            background: value ? "var(--color-accent-fg)" : "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            /* Color cross-fades with the slide so the knob doesn't snap
               between its on/off inks mid-travel. */
            transition: "left 150ms, background-color 150ms",
          }}
        />
      </button>
    </div>
  );
}

/** Multi-line list field (one entry per line) used by the sandbox allow lists
 *  and the worktree symlink paths. */
export function ListField({ label, placeholder, value, onChange }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--color-fg-dim)]">{label}</span>
      <AutoGrowTextarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

// Textarea that grows with its content. Same recipe as the sandbox
// dialog's: collapse to auto, size to scrollHeight on every value
// change. `overflow-hidden` kills the flicker scrollbar during resize.
export function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      {...props}
      style={{ overflow: "hidden", ...props.style }}
    />
  );
}

/** Page heading. `badge` marks a section as experimental: off by default
 *  because we are not yet confident in it, with a stated way out (see the
 *  promotion rule in docs/ui.md). It is NOT for settings that are merely
 *  off by default for safety or taste. */
export function SectionTitle({ title, badge, action }: {
  title: string; badge?: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5">
        <h1 className="text-[20px] font-medium">{title}</h1>
        {badge && (
          <span className="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] uppercase tracking-wider text-[var(--color-accent)]">
            {badge}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

/** A block in a settings page: hairline above, consistent top padding. The
 *  first block on a page passes `first` so the page does not open with a
 *  rule directly under its title. */
export function Block({ first, id, className, children }: {
  first?: boolean; id?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(!first && "border-t border-[var(--color-border-soft)] pt-6", className)}
    >
      {children}
    </div>
  );
}
