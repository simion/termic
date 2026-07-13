// Prompt library — a user-managed registry of reusable prompts fired from the
// Prompts dropdown. A prompt is just title + body; the DESTINATION (which agent,
// or a new one) is chosen at fire-time, not stored here. See lib/runPrompt.ts.
//
// Storage model (like the agents registry): built-ins are NOT frozen into
// storage. We persist only the DELTA from the shipped defaults:
//   - customs:        user-created prompts (full content)
//   - overrides:      edited built-ins (id -> {title, body}); presence == MODIFIED
//   - deletedBuiltins built-ins the user removed
//   - disabled:       prompts hidden from the menu
//   - order:          display order of ids
// An UNEDITED built-in therefore always renders the current app default, so a
// better default shipped in a future version reaches users who never touched it.

import { create } from "zustand";
import { REVIEW_PROMPT } from "@/lib/review";
import {
  WRITE_TESTS_PROMPT, SECURITY_REVIEW_PROMPT, EXPLAIN_CHANGES_PROMPT, COMMIT_PROMPT,
} from "@/lib/builtinPrompts";

export interface Prompt {
  id: string;
  title: string;
  body: string;
  builtin: boolean;
  /** Hidden from the dropdown when false, without deleting it. */
  enabled: boolean;
  /** Built-in only: true once the user edited it away from the shipped text. */
  modified: boolean;
  /** Manually assigned trigger-key (single char), or undefined to auto-assign
   *  from the default 1-9, a-z sequence. See `effectiveTriggerKeys`. */
  triggerKeyOverride?: string;
}

// Default trigger-key sequence for ⌘R quick-fire / the palette badges:
// digits first (they read fastest), then letters.
const TRIGGER_KEY_SEQUENCE = "123456789abcdefghijklmnopqrstuvwxyz".split("");

/** Resolve each prompt's EFFECTIVE trigger key: its manual override if set
 *  and not already claimed by an earlier prompt, else the next free slot in
 *  the default sequence. Walks the full list (not just enabled) so a
 *  prompt's number doesn't shift when a sibling is toggled on/off - only
 *  enabled prompts are actually reachable via the key, but everyone still
 *  holds their place in line. */
export function effectiveTriggerKeys(prompts: readonly Prompt[]): Map<string, string> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const p of prompts) {
    const ov = p.triggerKeyOverride;
    if (ov && !used.has(ov)) { result.set(p.id, ov); used.add(ov); }
  }
  let seqIdx = 0;
  for (const p of prompts) {
    if (result.has(p.id)) continue;
    while (seqIdx < TRIGGER_KEY_SEQUENCE.length && used.has(TRIGGER_KEY_SEQUENCE[seqIdx])) seqIdx++;
    if (seqIdx >= TRIGGER_KEY_SEQUENCE.length) continue;
    const key = TRIGGER_KEY_SEQUENCE[seqIdx];
    result.set(p.id, key);
    used.add(key);
    seqIdx++;
  }
  return result;
}

interface BuiltinDef { id: string; title: string; body: string }

// Starter library: the "ship a change" lifecycle, every one diff-aware so it
// leverages the worktree. Users edit, reorder, disable, delete, or add their own.
export const DEFAULT_PROMPTS: readonly BuiltinDef[] = [
  { id: "builtin:review",          title: "Review",              body: REVIEW_PROMPT },
  { id: "builtin:write-tests",     title: "Write tests",         body: WRITE_TESTS_PROMPT },
  { id: "builtin:security-review", title: "Security review",     body: SECURITY_REVIEW_PROMPT },
  { id: "builtin:explain-changes", title: "Explain the changes", body: EXPLAIN_CHANGES_PROMPT },
  { id: "builtin:commit",          title: "Commit",              body: COMMIT_PROMPT },
];

const LS_KEY = "promptLibrary";

interface StoredCustom { id: string; title: string; body: string }

interface Persisted {
  customs: StoredCustom[];
  overrides: Record<string, { title: string; body: string }>;
  deletedBuiltins: string[];
  disabled: string[];
  order: string[];
  /** Manual trigger-key overrides for ⌘R quick-fire / the palette, id -> single char. */
  triggerKeys: Record<string, string>;
}

const EMPTY: Persisted = {
  customs: [], overrides: {}, deletedBuiltins: [], disabled: [], order: [], triggerKeys: {},
};

function isCustom(c: unknown): c is StoredCustom {
  return !!c && typeof c === "object"
    && typeof (c as StoredCustom).id === "string"
    && typeof (c as StoredCustom).title === "string"
    && typeof (c as StoredCustom).body === "string";
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...EMPTY };
    const s = JSON.parse(raw) as Partial<Persisted>;
    return {
      customs: Array.isArray(s.customs) ? s.customs.filter(isCustom) : [],
      overrides: s.overrides && typeof s.overrides === "object" ? s.overrides : {},
      deletedBuiltins: Array.isArray(s.deletedBuiltins) ? s.deletedBuiltins : [],
      disabled: Array.isArray(s.disabled) ? s.disabled : [],
      order: Array.isArray(s.order) ? s.order : [],
      triggerKeys: s.triggerKeys && typeof s.triggerKeys === "object" ? s.triggerKeys : {},
    };
  } catch {
    return { ...EMPTY };
  }
}

function save(p: Persisted) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch {}
}

/** Resolve the persisted delta into the ordered list the UI / dropdown use. */
function computePrompts(p: Persisted): Prompt[] {
  const items: Prompt[] = [];
  for (const d of DEFAULT_PROMPTS) {
    if (p.deletedBuiltins.includes(d.id)) continue;
    const ov = p.overrides[d.id];
    items.push({
      id: d.id,
      title: ov?.title ?? d.title,
      body: ov?.body ?? d.body,
      builtin: true,
      enabled: !p.disabled.includes(d.id),
      modified: !!ov,
      triggerKeyOverride: p.triggerKeys[d.id],
    });
  }
  for (const c of p.customs) {
    items.push({
      id: c.id, title: c.title, body: c.body, builtin: false,
      enabled: !p.disabled.includes(c.id), modified: false,
      triggerKeyOverride: p.triggerKeys[c.id],
    });
  }
  // Apply explicit order; anything not listed (new built-in / freshly added)
  // keeps its natural position at the end.
  const ordered: Prompt[] = [];
  for (const id of p.order) {
    const it = items.find(x => x.id === id);
    if (it && !ordered.includes(it)) ordered.push(it);
  }
  for (const it of items) if (!ordered.includes(it)) ordered.push(it);
  return ordered;
}

interface PromptStore {
  prompts: Prompt[];
  /** Exposed so the UI can show "Restore built-in prompts" only when relevant. */
  deletedBuiltins: string[];
  addPrompt: (init?: Partial<Prompt>) => string;
  updatePrompt: (id: string, patch: Partial<Pick<Prompt, "title" | "body" | "enabled">>) => void;
  clonePrompt: (id: string) => string | null;
  deletePrompt: (id: string) => void;
  /** Built-in only: drop the override so it renders the shipped default again. */
  resetPrompt: (id: string) => void;
  toggleEnabled: (id: string) => void;
  reorderPrompts: (from: number, to: number) => void;
  /** Re-add any built-ins the user deleted. */
  restoreBuiltins: () => void;
  /** Manually pin a prompt's ⌘R quick-fire / palette trigger key. `key` must
   *  be a single lowercase alphanumeric char; pass null to clear back to auto. */
  setTriggerKey: (id: string, key: string | null) => void;
}

export const usePromptLibrary = create<PromptStore>((set) => {
  let p = load();

  const commit = (next: Persisted) => {
    p = next;
    save(next);
    set({ prompts: computePrompts(next), deletedBuiltins: next.deletedBuiltins });
  };

  const builtinDef = (id: string) => DEFAULT_PROMPTS.find(d => d.id === id);
  const effective = (id: string): { title: string; body: string } | null => {
    const d = builtinDef(id);
    if (d) return p.overrides[id] ?? { title: d.title, body: d.body };
    const c = p.customs.find(x => x.id === id);
    return c ? { title: c.title, body: c.body } : null;
  };

  return {
    prompts: computePrompts(p),
    deletedBuiltins: p.deletedBuiltins,

    addPrompt: (init) => {
      const id = crypto.randomUUID();
      const custom: StoredCustom = { id, title: init?.title ?? "", body: init?.body ?? "" };
      commit({ ...p, customs: [...p.customs, custom], order: [...p.order, id] });
      return id;
    },

    updatePrompt: (id, patch) => {
      let next = p;
      if (patch.enabled !== undefined) {
        const disabled = new Set(next.disabled);
        if (patch.enabled) disabled.delete(id); else disabled.add(id);
        next = { ...next, disabled: [...disabled] };
      }
      if (patch.title !== undefined || patch.body !== undefined) {
        const eff = effective(id) ?? { title: "", body: "" };
        const title = patch.title ?? eff.title;
        const body = patch.body ?? eff.body;
        const d = builtinDef(id);
        if (d) {
          const overrides = { ...next.overrides };
          // Editing a built-in back to exactly the default clears MODIFIED.
          if (title === d.title && body === d.body) delete overrides[id];
          else overrides[id] = { title, body };
          next = { ...next, overrides };
        } else {
          next = { ...next, customs: next.customs.map(c => c.id === id ? { ...c, title, body } : c) };
        }
      }
      commit(next);
    },

    clonePrompt: (id) => {
      const eff = effective(id);
      if (!eff) return null;
      const newId = crypto.randomUUID();
      // Insert right after the source in the EFFECTIVE order. p.order may be
      // empty/partial (built-ins/customs that were never reordered aren't in
      // it), so derive the full current order and splice into that — otherwise
      // a clone of a never-reordered prompt lands at the very end.
      const order = computePrompts(p).map(x => x.id);
      const at = order.indexOf(id);
      if (at >= 0) order.splice(at + 1, 0, newId); else order.push(newId);
      commit({ ...p, customs: [...p.customs, { id: newId, title: `${eff.title} (copy)`, body: eff.body }], order });
      return newId;
    },

    deletePrompt: (id) => {
      const order = p.order.filter(x => x !== id);
      const disabled = p.disabled.filter(x => x !== id);
      const triggerKeys = { ...p.triggerKeys }; delete triggerKeys[id];
      if (builtinDef(id)) {
        const overrides = { ...p.overrides }; delete overrides[id];
        commit({ ...p, deletedBuiltins: Array.from(new Set([...p.deletedBuiltins, id])), overrides, order, disabled, triggerKeys });
      } else {
        commit({ ...p, customs: p.customs.filter(c => c.id !== id), order, disabled, triggerKeys });
      }
    },

    resetPrompt: (id) => {
      if (!builtinDef(id)) return;
      const overrides = { ...p.overrides }; delete overrides[id];
      commit({ ...p, overrides });
    },

    toggleEnabled: (id) => {
      const disabled = new Set(p.disabled);
      if (disabled.has(id)) disabled.delete(id); else disabled.add(id);
      commit({ ...p, disabled: [...disabled] });
    },

    reorderPrompts: (from, to) => {
      const ids = computePrompts(p).map(x => x.id);
      if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return;
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      commit({ ...p, order: ids });
    },

    restoreBuiltins: () => {
      commit({ ...p, deletedBuiltins: [] });
    },

    setTriggerKey: (id, key) => {
      const triggerKeys = { ...p.triggerKeys };
      if (key) triggerKeys[id] = key; else delete triggerKeys[id];
      commit({ ...p, triggerKeys });
    },
  };
});
