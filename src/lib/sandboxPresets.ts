// Opinionated starting points for the sandbox editors. Just two for
// now - the textareas are easy enough to edit by hand that a forest
// of preset buttons doesn't pay off.
//
// `applyPreset` replaces the extras (rw / hosts). The always-on
// built-ins (workspace path + agent dirs + secrets-deny + vendor API +
// github + npm + pypi + crates) live in Rust and are immutable - so
// 'Standard' is effectively a "clear the extras" button.

export type PresetId = "standard" | "permissive";

export interface SandboxPreset {
  id: PresetId;
  label: string;
  hint: string;
  rwPaths: string[];
  allowedHosts: string[];
}

export const SANDBOX_PRESETS: SandboxPreset[] = [
  {
    id: "standard",
    label: "Standard",
    hint: "Just the built-in defaults. Use this to reset the extras you've added.",
    rwPaths: [],
    allowedHosts: [],
  },
  {
    id: "permissive",
    label: "Permissive",
    hint: "Extra hosts most dev workflows hit: container registries, GCS, helm/k8s, OS package mirrors.",
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
