// Top-bar "N agents waiting" pill (issue #56). Renders ONLY when at least
// one agent is waiting on the user (finished a turn or blocked on input) —
// a dead button would be worse than none. Clicking jumps to the next waiting
// agent, cycling the whole queue on repeated presses (same as ⇧⌘A). Both
// the count and the jump come from `@/lib/waitingAgents` so they can't drift
// from the keyboard shortcut.

import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { Bell } from "lucide-react";
import { bindingGlyphs } from "@/lib/shortcuts";
import { waitingCount, jumpToNextWaiting } from "@/lib/waitingAgents";

export function WaitingAgentsPill() {
  // Subscribe to the pref so toggling the work-done UI updates the pill live;
  // waitingCount also honors it, but the subscription is what re-renders us.
  const settled = usePrefs(s => s.settledHighlight);
  // Selector returns a number, so the pill only re-renders when the COUNT
  // changes, not on every unrelated app-store write.
  const count = useApp(waitingCount);
  const binding = usePrefs(s => s.shortcuts["jump-next-waiting"]);

  if (!settled || count < 1) return null;

  const glyphs = bindingGlyphs(binding).join("");
  const label = `Jump to next waiting agent${glyphs ? ` (${glyphs})` : ""}`;

  return (
    <Tip content={label} side="bottom">
      <button
        type="button"
        data-no-drag
        onClick={() => { jumpToNextWaiting(); }}
        aria-label={label}
        className="flex select-none items-center gap-1 rounded-full border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/15 px-2 py-0.5 text-[12px] font-medium text-[var(--color-warn)] hover:bg-[var(--color-warn)]/25"
      >
        <Bell className="h-3 w-3" />
        <span className="tabular-nums leading-none">{count}</span>
      </button>
    </Tip>
  );
}
