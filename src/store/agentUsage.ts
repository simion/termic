// How much of each account's subscription limits has been spent (GH #277).
//
// Keyed by AGENT ENTRY id, not by task, and that is the whole design. A cloned
// agent exists to hold a second login and relocates its whole config dir with
// the agent's own env var, so the config dir IS the account (see
// docs/ideas/usage-footer.md). Two tasks running the same clone are spending
// the same quota and must read the same number; two tasks on different clones
// must never see each other's.
//
// So the footer selects by the active task's agent id, and a reading reported
// by any task updates every task on that agent at once.

import { create } from "zustand";
import type { AgentUsage } from "@/lib/agentUsage";
import { sameUsage } from "@/lib/agentUsage";

export interface UsageEntry extends AgentUsage {
  /** When this reading landed. Shown as staleness: the claude status line only
   *  speaks while a turn runs, so a footer with no running task is showing
   *  something that was true a while ago and should say so. */
  updatedAt: number;
  /** Which side reported it, for the tooltip and for debugging a wrong number
   *  without having to guess which transport produced it. */
  source: "statusline" | "rpc";
}

interface AgentUsageState {
  byAgent: Record<string, UsageEntry>;
  report: (agentId: string, usage: AgentUsage, source: UsageEntry["source"]) => void;
  clear: (agentId: string) => void;
}

export const useAgentUsage = create<AgentUsageState>((set, get) => ({
  byAgent: {},
  report: (agentId, usage, source) => {
    const cur = get().byAgent[agentId];
    // Carry a window the new reading does NOT carry, when the last one did.
    //
    // Claude reports both windows together, and a payload can arrive with one
    // of them null: measured, a `used_percentage` of null drops that window,
    // and the likely moment is just after it resets. Replacing wholesale then
    // blanks a session percentage that was on screen a second earlier, which
    // reads as the feature breaking rather than as one absent field.
    //
    // Only ever ADDS back a window, never removes one, and only from the same
    // source, so codex's genuinely absent session window (free plan) stays
    // absent. The age shown is the entry's newest reading, so a carried
    // window is at most as old as that label already admits.
    if (cur && cur.source === source) {
      usage = {
        session: usage.session ?? cur.session,
        weekly: usage.weekly ?? cur.weekly,
      };
    }
    // The status line fires on EVERY turn, and most turns move a percentage by
    // nothing at all. An unchanged write copies the whole store and re-runs
    // every subscriber's selector (docs/performance.md bear trap 8) on the
    // hottest path there is: a streaming agent.
    //
    // `updatedAt` is deliberately NOT part of the comparison. Refreshing it on
    // an unchanged reading would defeat the bail entirely, and the staleness it
    // feeds is about the NUMBER's age, not the poll's.
    if (cur && cur.source === source && sameUsage(cur, usage)) return;
    set(s => ({
      byAgent: { ...s.byAgent, [agentId]: { ...usage, source, updatedAt: Date.now() } },
    }));
  },
  clear: (agentId) => {
    if (!(agentId in get().byAgent)) return;
    set(s => {
      const byAgent = { ...s.byAgent };
      delete byAgent[agentId];
      return { byAgent };
    });
  },
}));
