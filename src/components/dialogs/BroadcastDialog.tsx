// Broadcast: type one message, fire it into several already-open agents
// at once. Same injection path as the prompt library (agentSend): write the
// text + a carriage return straight to each PTY.
//
// Two modes, driven by the UI store:
//   - workspace  (broadcastForWsId)      → every live agent/shell tab of ONE
//                                           workspace.
//   - project    (broadcastForProjectId) → the MAIN agent (the default,
//                                           main-pane tab) of every workspace
//                                           in the project.

import { useEffect, useMemo, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { sendMessageToPty } from "@/lib/agentSend";
import { isTerminalCli } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { Check, Megaphone } from "lucide-react";
import type { Tab, TerminalTab } from "@/lib/types";

// Stable empty map so a CLOSED dialog's tabs selector keeps returning the same
// reference — otherwise it would re-render on every app-wide patchTab.
const EMPTY_TABS: Record<string, Tab[]> = {};

/** One broadcast destination: a live-PTY tab plus the workspace it belongs to
 *  (project mode spans workspaces, so the wsId can't be a single dialog-level
 *  value) and the label to show for it. */
interface BTarget { tab: TerminalTab; wsId: string; label: string }

function tabLabel(t: TerminalTab): string {
  return t.customTitle ? t.title : (t.liveTitle || t.title);
}

export function BroadcastDialog() {
  const wsId = useUI(s => s.broadcastForWsId);
  const projectId = useUI(s => s.broadcastForProjectId);
  const close = useUI(s => s.closeBroadcast);
  const pushToast = useUI(s => s.pushToast);
  const agents = useApp(s => s.agents);
  // Only subscribe to the live tab map while OPEN; closed → stable empty ref,
  // so unrelated tab churn never re-renders this dialog.
  const allTabs = useApp(s => (wsId || projectId) ? s.tabs : EMPTY_TABS);
  const workspaces = useApp(s => s.workspaces);
  const patchTab = useApp(s => s.patchTab);

  const open = !!wsId || !!projectId;

  // Targets. Workspace mode = every live terminal tab (agents + shells, but
  // never Run/Setup — text typed into a dev server's stdin is never what a
  // broadcast means). Project mode = the main agent of each workspace: the
  // default, main-pane (non-split) terminal tab with a live PTY.
  const targets = useMemo<BTarget[]>(() => {
    if (wsId) {
      return (allTabs[wsId] || [])
        .filter((t): t is TerminalTab => t.type === "terminal" && !!t.ptyId && !(t as TerminalTab).runTab)
        .map(t => ({ tab: t, wsId, label: tabLabel(t) }));
    }
    if (projectId) {
      const out: BTarget[] = [];
      for (const w of workspaces) {
        if (w.project_id !== projectId || w.archived) continue;
        const main = (allTabs[w.id] || []).find(
          (t): t is TerminalTab => t.type === "terminal" && !!(t as TerminalTab).is_default
            && !(t as TerminalTab).paneId && !(t as TerminalTab).runTab && !!t.ptyId,
        );
        if (main) out.push({ tab: main, wsId: w.id, label: w.name });
      }
      return out;
    }
    return [];
  }, [wsId, projectId, allTabs, workspaces]);

  const [msg, setMsg] = useState("");
  // Per-tab checkbox OVERRIDES of the default. A tab with no override falls
  // back to its default, so a tab whose PTY spawns *after* the dialog opened
  // still comes up at its default, and only explicit toggles deviate.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  // Default checked: project mode targets are all main agents, so all on.
  // Workspace mode keeps the old rule (agents on, raw shells / custom off).
  function defaultOn(t: TerminalTab): boolean {
    return projectId ? true : !isTerminalCli(t.cli, agents);
  }
  function isSelected(t: TerminalTab): boolean {
    return overrides[t.id] ?? defaultOn(t);
  }

  // (Re-)open: clear the message and any prior overrides.
  useEffect(() => {
    if (!open) return;
    setMsg("");
    setOverrides({});
  }, [wsId, projectId, open]);

  // Auto-grow the textarea: reset to its `rows`-based height (the 5-row
  // minimum), then expand to fit the content. max-height CSS caps it and
  // overflow-y takes over past that.
  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function toggle(t: TerminalTab) {
    setOverrides(o => ({ ...o, [t.id]: !(o[t.id] ?? defaultOn(t)) }));
  }

  function send() {
    const picked = targets.filter(x => isSelected(x.tab) && x.tab.ptyId);
    if (!picked.length || !msg.trim()) return;
    // sendMessageToPty writes the text then the Enter (CR) on its own a beat
    // later — agent TUIs (claude especially) treat a `\r` in the same burst
    // as the text as a literal newline, not a submit.
    const now = Date.now();
    for (const x of picked) sendMessageToPty(x.tab.ptyId!, msg);
    // Stamp lastInputAt so TerminalPane's submittedSinceSpawn ref is armed.
    // Broadcast bypasses term.onData (it writes directly to the PTY), so
    // without this the title-based working detector stays suppressed and
    // agents like Gemini never get a working→done transition for broadcast work.
    for (const x of picked) patchTab(x.wsId, x.tab.id, { lastInputAt: now });
    close();
    pushToast(`Broadcast to ${picked.length} agent${picked.length === 1 ? "" : "s"}`);
  }

  const selectedCount = targets.filter(x => isSelected(x.tab)).length;
  const canSend = selectedCount > 0 && msg.trim().length > 0;

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title="Broadcast message"
      description={projectId
        ? "Send one message to the main agent of every workspace in this project."
        : "Send one message to several open agents at once."}
      className="max-w-2xl"
    >
      {targets.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-[var(--color-fg-dim)]">
          {projectId
            ? "No running main agents in this project yet. Open a workspace first."
            : "No running agents in this workspace yet. Open an agent tab first."}
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-0.5">
            {targets.map(({ tab: t, label }) => {
              const on = isSelected(t);
              return (
                <button
                  key={t.id}
                  onClick={() => toggle(t)}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                    on ? "bg-[var(--color-bg-2)]" : "hover:bg-[var(--color-hover)]",
                  )}
                >
                  <span className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    on
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-deep)] text-white"
                      : "border-[var(--color-border)]",
                  )}>
                    {on && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(t.cli, agents)])}>
                    <CliIcon cli={resolveIconId(t.cli, agents)} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Plain textarea — Enter inserts a newline like any textarea.
              Sending is the explicit Send button only (no key shortcut),
              so a multi-line broadcast can't fire mid-thought. Height
              auto-grows with the content up to a cap, then scrolls. */}
          <textarea
            autoFocus
            // No native autocorrect / autocapitalize / spellcheck — this
            // is a command channel to agents, not prose; macOS text
            // substitution mangling a path or flag is never wanted.
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            value={msg}
            onChange={e => { setMsg(e.target.value); grow(e.currentTarget); }}
            rows={5}
            placeholder="Message to broadcast…"
            className="mt-3 max-h-[40vh] w-full resize-none overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
          />

          <div className="mt-3 flex items-center justify-between">
            <span className="text-[12px] text-[var(--color-fg-faint)]">
              {selectedCount} of {targets.length} selected
            </span>
            <Button variant="primary" size="sm" disabled={!canSend} onClick={send}>
              <Megaphone className="h-3.5 w-3.5" />
              Send
            </Button>
          </div>
        </>
      )}
    </AppDialog>
  );
}
