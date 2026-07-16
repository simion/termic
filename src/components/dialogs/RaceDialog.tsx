// Agent Race launcher: pick which agent CLIs should race and how many of each
// (per-CLI quantity steppers), type ONE shared prompt, and fire. Each racer
// spawns in its own fresh worktree and receives the same prompt (see
// lib/agentRace). Diff / compare of the results is a later slice; this dialog
// only launches.

import { useEffect, useMemo, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { visibleCliIds } from "@/lib/agents";
import { startRace, suggestRaceName, type Racer } from "@/lib/agentRace";
import { cn, slugify } from "@/lib/utils";
import { Flag, Minus, Plus } from "lucide-react";

// Cap per CLI so a fat-fingered stepper can't spawn a dozen worktrees.
const MAX_PER_CLI = 4;

export function RaceDialog() {
  const projectId = useUI(s => s.raceProjectId);
  const close = useUI(s => s.closeRace);
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const open = !!projectId;

  const choices = useMemo(() => {
    const visible = visibleCliIds(agents.map(a => a.id), agents, detectedClis);
    return agents.filter(a => visible.has(a.id));
  }, [agents, detectedClis]);

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCounts({}); setPrompt(""); setName(""); setNameEdited(false);
    setErr(null); setBusy(false);
  }, [projectId, open]);

  // The name auto-fills from the prompt, but ONLY until the user touches the
  // field — after that it's theirs (same never-clobber rule as the New Task
  // branch field). Cleared = unnamed: branches fall back to the race id.
  const suggested = useMemo(() => suggestRaceName(prompt), [prompt]);
  useEffect(() => { if (!nameEdited) setName(suggested); }, [suggested, nameEdited]);
  const slug = slugify(name.trim());

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const canStart = total >= 2 && prompt.trim().length > 0 && !busy;

  function bump(cli: string, delta: number) {
    setCounts(c => ({ ...c, [cli]: Math.max(0, Math.min(MAX_PER_CLI, (c[cli] ?? 0) + delta)) }));
  }

  async function start() {
    if (!projectId || !canStart) return;
    const racers: Racer[] = [];
    for (const [cli, n] of Object.entries(counts)) {
      for (let i = 1; i <= n; i++) racers.push({ cli, n: i });
    }
    setBusy(true); setErr(null);
    try {
      await startRace({ projectId, racers, prompt: prompt.trim(), name: name.trim() || undefined });
      close();
    } catch (e) {
      setErr(String(e)); setBusy(false);
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title="Start an agent race"
      description="Fire one prompt at several agents at once. Each races in its own worktree; compare and pick a winner when they finish."
      className="max-w-2xl"
    >
      <div className="mt-2 flex flex-col gap-1">
        {choices.length === 0 ? (
          <p className="text-[13.5px] text-[var(--color-fg-dim)]">No agents available. Install an agent CLI first.</p>
        ) : choices.map(a => {
          const n = counts[a.id] ?? 0;
          const iconId = resolveIconId(a.id, agents);
          return (
            <div key={a.id} className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
              n > 0 && "bg-[var(--color-bg-2)]",
            )}>
              <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId])}>
                <CliIcon cli={iconId} className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">{a.display_name}</span>
              <div className="inline-flex items-center gap-1.5">
                <button
                  type="button" onClick={() => bump(a.id, -1)} disabled={n === 0}
                  className="flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-30"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <span className="w-4 text-center tabular-nums text-[var(--color-fg)]">{n}</span>
                <button
                  type="button" onClick={() => bump(a.id, 1)} disabled={n >= MAX_PER_CLI}
                  className="flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-30"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Plain textarea. Enter inserts a newline; starting is the explicit
          button only, so a multi-line prompt can't fire mid-thought. No native
          autocorrect: this is a command channel to agents, not prose. */}
      <textarea
        autoFocus
        autoCorrect="off" autoCapitalize="off" autoComplete="off" spellCheck={false}
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        rows={5}
        placeholder="The prompt every agent runs…"
        className="mt-3 max-h-[40vh] w-full resize-none overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
      />

      <div className="mt-3 flex items-center gap-2.5">
        <label
          htmlFor="race-name"
          title="Names the race: branches become race/<name>/agent-n and tasks become <name>: Agent #n. Leave empty for an auto-generated id."
          className="shrink-0 text-[12.5px] text-[var(--color-fg-dim)]"
        >
          Name
        </label>
        <input
          id="race-name"
          autoCorrect="off" autoCapitalize="off" autoComplete="off" spellCheck={false}
          value={name}
          onChange={e => { setName(e.target.value); setNameEdited(true); }}
          placeholder="optional"
          className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
        />
        {slug && (
          <span className="shrink-0 font-mono text-[11.5px] text-[var(--color-fg-faint)]">
            race/{slug}/…
          </span>
        )}
      </div>

      {err && <p className="mt-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12px] text-[var(--color-fg-faint)]">
          {total < 2 ? "Pick at least 2 agents" : `${total} agents racing`}
        </span>
        <Button variant="primary" size="sm" disabled={!canStart} onClick={start}>
          <Flag className="h-3.5 w-3.5" />
          Start race
        </Button>
      </div>
    </AppDialog>
  );
}
