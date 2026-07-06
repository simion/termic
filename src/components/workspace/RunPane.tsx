// Special Run tab (GH #54): a real PTY terminal running the project/member
// run (or setup) script. The controls (restart / stop) live IN the tab pill
// (see TabPill's runTab slot) — no extra chrome over the terminal.
//
// Restored tabs (runTab.idle) come back in their pane WITHOUT auto-firing
// the script: a placeholder with a play button waits for the user. Restart
// works by remounting TerminalPane (key={gen}): the unmount cleanup kills
// the old PTY, the fresh mount respawns the command. Scrollback loss on an
// explicit restart is expected. The pill's play/restart button and the
// UnifiedBar Run button both trigger it via `termic-run-tab-restart`.
// (Spotlight cwd is decided at spawn time inside TerminalPane, so each
// restart automatically picks worktree vs repo root.)

import { useEffect, useState } from "react";
import type { Workspace, TerminalTab } from "@/lib/types";
import { TerminalPane } from "./TerminalPane";
import { Play } from "lucide-react";

export function RunPane({ ws, tab, active }: {
  ws: Workspace;
  tab: TerminalTab;
  active?: boolean;
}) {
  const [gen, setGen] = useState(0);
  const [started, setStarted] = useState(!tab.runTab?.idle);

  useEffect(() => {
    const onRestart = (e: Event) => {
      if ((e as CustomEvent<{ tabId?: string }>).detail?.tabId !== tab.id) return;
      setStarted(prev => {
        // Idle → first start: just mounting TerminalPane spawns the script;
        // bumping gen too would double-spawn.
        if (!prev) return true;
        setGen(g => g + 1);
        return prev;
      });
    };
    window.addEventListener("termic-run-tab-restart", onRestart);
    return () => window.removeEventListener("termic-run-tab-restart", onRestart);
  }, [tab.id]);

  if (!started) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--color-bg)]">
        <button
          onClick={() => setStarted(true)}
          title={`Run ${tab.title}`}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--color-border)] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]"
        >
          <Play className="ml-0.5 h-5 w-5" />
        </button>
        <span className="text-[13px] text-[var(--color-fg-dim)]">
          {tab.title} is not running. Press play to start it.
        </span>
      </div>
    );
  }

  // key={gen}: restart = teardown (kills PTY) + fresh spawn.
  return <TerminalPane key={gen} ws={ws} tab={tab} active={!!active} />;
}
