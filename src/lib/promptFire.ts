// Shared "fire a library prompt" logic for the ⌥⌘P prompt palette
// (PromptPalette.tsx). The Prompts dropdown in UnifiedBar always opens the
// destination picker instead (its whole point is letting you tweak the body /
// pick a target every time) — this fast path skips straight to the focused
// agent when there is one, and falls back to the same picker otherwise.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { findLeaf } from "@/lib/splitTree";
import { runPrompt } from "@/lib/runPrompt";
import type { TerminalTab } from "@/lib/types";
import type { Prompt } from "@/store/prompts";

/** The tab id showing in the currently-focused pane (main or split) of a
 *  workspace. Mirrors the main pane's focus-jump lookup in useShortcuts.ts
 *  (`focus-terminal` case) / UnifiedBar's `focusedAgentId`. */
export function getFocusedTabId(wsId: string): string | undefined {
  const s = useApp.getState();
  const tree = s.splitTree[wsId];
  if (tree) {
    const leaf = findLeaf(tree, s.activePaneId[wsId] ?? "");
    if (leaf?.activeTabId) return leaf.activeTabId;
  }
  return s.activeTab[wsId];
}

/** Live agent-terminal tabs in a workspace — prompt fire destinations. Run
 *  tabs are terminals with a live PTY too, but a dev server isn't a prompt
 *  destination, so they're excluded (matches UnifiedBar's `liveAgents`). */
export function getLiveAgentTabs(wsId: string): TerminalTab[] {
  const tabs = useApp.getState().tabs[wsId] ?? [];
  return tabs.filter(
    (t): t is TerminalTab => t.type === "terminal" && !!t.ptyId && !(t as TerminalTab).runTab,
  );
}

/** Fire `prompt` straight at the focused tab when it's a live agent;
 *  otherwise open the destination picker so the user chooses (no eligible
 *  agent to guess at — e.g. focus is on an editor tab, or nothing's running). */
export function fireOrPickDestination(wsId: string, prompt: Prompt): void {
  const focusedId = getFocusedTabId(wsId);
  const liveAgents = getLiveAgentTabs(wsId);
  if (focusedId && liveAgents.some(a => a.id === focusedId)) {
    runPrompt(wsId, prompt, { kind: "agent", tabId: focusedId });
    return;
  }
  useUI.getState().openPromptFire(prompt);
}
