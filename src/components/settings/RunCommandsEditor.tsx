// Editor for a list of extra Run commands (GH #124). Each row is a
// label + command pair; an empty label falls back to the command at launch.
// Shared by the Settings "Run commands" surface and the Run Commands manager
// dialog. Persistence is the caller's job (via `onChange`) so the same editor
// backs both the personal (projects.json) and committed (.termic.yaml) lists.

import type { RunCommand } from "@/lib/types";
import { Trash2, Plus } from "lucide-react";

export function RunCommandsEditor({ value, onChange }: {
  value: RunCommand[];
  onChange: (next: RunCommand[]) => void;
}) {
  function update(i: number, patch: Partial<RunCommand>) {
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
  function remove(i: number) {
    onChange(value.filter((_, j) => j !== i));
  }
  function add() {
    onChange([...value, { label: "", command: "" }]);
  }
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-col gap-2">
          {value.map((cmd, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={cmd.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Label"
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                className="w-40 shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              />
              <input
                value={cmd.command}
                onChange={(e) => update(i, { command: e.target.value })}
                placeholder="./build.sh"
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => remove(i)}
                title="Remove"
                className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-err)]/10 hover:text-[var(--color-err)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={add}
        className="inline-flex w-fit items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
      >
        <Plus className="h-3.5 w-3.5" /> Add command
      </button>
    </div>
  );
}
