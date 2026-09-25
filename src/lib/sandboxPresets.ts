import { i18n } from "@/lib/i18n";

// Opinionated starting points for the sandbox editors. Just two for
// now - the textareas are easy enough to edit by hand that a forest
// of preset buttons doesn't pay off.
//
// `applyPreset` replaces the extras (rw / hosts). The always-on
// built-ins (task path + agent dirs + secrets-deny + vendor API +
// github + npm + pypi + crates) live in Rust and are immutable - so
// 'Standard' is effectively a "clear the extras" button.

export type PresetId = "standard" | "permissive";

export interface SandboxPreset {
  id: PresetId;
  label: string;
  hint: string;
  /** backend:sandboxPreset key suffixes for the localized label/hint,
   *  resolved at render (see presetLabel/presetHint). The English text above
   *  is the fallback. */
  labelKey: string;
  hintKey: string;
  rwPaths: string[];
  allowedHosts: string[];
}

export const SANDBOX_PRESETS: SandboxPreset[] = [
  {
    id: "standard",
    label: "Standard",
    hint: "Just the built-in defaults. Use this to reset the extras you've added.",
    labelKey: "standardLabel",
    hintKey: "standardHint",
    rwPaths: [],
    allowedHosts: [],
  },
  {
    id: "permissive",
    label: "Permissive",
    hint: "Extra hosts most dev workflows hit: container registries, GCS, helm/k8s, OS package mirrors.",
    labelKey: "permissiveLabel",
    hintKey: "permissiveHint",
    rwPaths: [],
    // Wildcard syntax (matches the textarea's user-facing format).
    // The proxy translates these to anchored regex internally. Power
    // users can still mix raw regex by prefixing with `^`.
    allowedHosts: [
      "*.docker.com",
      "*.docker.io",
      "cloudflare.docker.com",
      "quay.io",
      "*.quay.io",
      "gcr.io",
      "*.gcr.io",
      "*.helm.sh",
      "*.k8s.io",
      "storage.googleapis.com",
      "*.debian.org",
      "*.ubuntu.com",
    ],
  },
];

/** Localized view of a preset, resolved at render so a language switch
 *  applies without a reload. Falls back to the preset's own English text. */
export function presetLabel(p: SandboxPreset): string {
  return p.labelKey ? i18n.t(`backend:sandboxPreset.${p.labelKey}`) : p.label;
}

/** Localized hint for a preset, resolved at render. Falls back to English. */
export function presetHint(p: SandboxPreset): string {
  return p.hintKey ? i18n.t(`backend:sandboxPreset.${p.hintKey}`) : p.hint;
}
