// Curated file-tree exclude presets.
//
// Each preset is a named bundle of glob patterns that the user can add to
// either their personal exclude list (Settings → General) or a project's
// committed `.termic.yaml` (Settings → Repositories). Patterns match an
// entry's bare name (so `node_modules` / `*.pyc` hide at any depth) or its
// workspace-relative path (`docs/build`). `.git` is always hidden, so it's
// deliberately omitted here.
//
// Single source of truth — both settings surfaces import this.

export interface ExcludePreset {
  id: string;
  label: string;
  /** One-line description shown under the chip. */
  hint: string;
  patterns: string[];
}

export const EXCLUDE_PRESETS: ExcludePreset[] = [
  {
    id: "python",
    label: "Python",
    hint: "caches, venvs, build metadata",
    patterns: [
      "__pycache__",
      "*.pyc",
      ".venv",
      "venv",
      ".mypy_cache",
      ".pytest_cache",
      ".ruff_cache",
      "*.egg-info",
      ".tox",
    ],
  },
  {
    id: "node",
    label: "Node / JS",
    hint: "node_modules and bundler caches",
    patterns: [
      "node_modules",
      ".next",
      ".nuxt",
      ".turbo",
      ".parcel-cache",
      ".svelte-kit",
      ".vite",
    ],
  },
  {
    id: "rust",
    label: "Rust",
    hint: "the target build directory",
    patterns: ["target"],
  },
  {
    id: "build",
    label: "Build output",
    hint: "common compiled / generated dirs",
    patterns: ["dist", "build", "out", ".cache", "coverage", "*.log"],
  },
  {
    id: "ide",
    label: "IDE / editor",
    hint: "JetBrains, VS Code, swap files",
    patterns: [".idea", ".vscode", "*.swp", "*.swo"],
  },
  {
    id: "macos",
    label: "macOS",
    hint: "Finder / system cruft",
    patterns: [".DS_Store", ".Spotlight-V100", ".Trashes", "._*"],
  },
];

/** Merge `add` into `existing`, preserving order and dropping duplicates
 *  (trimmed, case-sensitive). Used when a preset chip is clicked. */
export function mergePatterns(existing: string[], add: string[]): string[] {
  const seen = new Set(existing.map(s => s.trim()).filter(Boolean));
  const out = existing.map(s => s.trim()).filter(Boolean);
  for (const p of add) {
    const t = p.trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Remove every pattern in `remove` from `existing` (trimmed comparison).
 *  The inverse of {@link mergePatterns} — together they make a preset chip a
 *  single reversible toggle with one shared normalization. */
export function dropPatterns(existing: string[], remove: string[]): string[] {
  const drop = new Set(remove.map(s => s.trim()));
  return existing.filter(v => !drop.has(v.trim()));
}

/** True if every pattern in the preset is already present in `list`. Lets
 *  the UI show a preset as "applied" / checked. */
export function presetApplied(preset: ExcludePreset, list: string[]): boolean {
  const set = new Set(list.map(s => s.trim()));
  return preset.patterns.every(p => set.has(p.trim()));
}
