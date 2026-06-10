// Shared editor for file-tree exclude patterns: a row of one-click preset
// chips + a free-form textarea (one glob per line). Presentation only — the
// parent owns persistence (personal Settings vs a project's .termic.yaml).

import { Check, Plus } from "lucide-react";
import { EXCLUDE_PRESETS, mergePatterns, dropPatterns, presetApplied, type ExcludePreset } from "@/lib/excludePresets";
import { Tip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";

export function ExcludeEditor({ value, onChange, placeholder, className }: {
  /** Current patterns. Raw lines (may contain blanks while typing); the
   *  parent trims/filters on save. */
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  // Clicking a preset toggles it: add all its patterns if any are missing,
  // else strip them. Keeps the chip a single, reversible action.
  function togglePreset(p: ExcludePreset) {
    if (presetApplied(p, value)) {
      onChange(dropPatterns(value, p.patterns));
    } else {
      onChange(mergePatterns(value, p.patterns));
    }
  }

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <div className="flex flex-wrap gap-1.5">
        {EXCLUDE_PRESETS.map(p => {
          const applied = presetApplied(p, value);
          return (
            <Tip key={p.id} content={`${p.patterns.join(", ")}`} side="top">
              <button
                type="button"
                onClick={() => togglePreset(p)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                  applied
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-fg)]"
                    : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                )}
              >
                {applied ? <Check className="h-3 w-3 text-[var(--color-accent)]" /> : <Plus className="h-3 w-3" />}
                <span>{p.label}</span>
              </button>
            </Tip>
          );
        })}
      </div>
      <textarea
        value={value.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n"))}
        rows={6}
        placeholder={placeholder ?? "node_modules\n__pycache__\n*.log\ndocs/build"}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
      />
      <p className="text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
        One glob per line. Matches a file/folder name at any depth (<code className="font-mono">node_modules</code>, <code className="font-mono">*.pyc</code>) or a path (<code className="font-mono">docs/build</code>). <code className="font-mono">.git</code> is always hidden.
      </p>
    </div>
  );
}
