// Broadcast: type one message, fire it into several already-open agents
// in a workspace at once. Same injection path as ReviewDialog — write the
// text + a carriage return straight to each target's PTY.

import { useEffect, useMemo, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { sendMessageToPty } from "@/lib/agentSend";
import { cn } from "@/lib/utils";
import { Check, Megaphone } from "lucide-react";
import type { TerminalTab } from "@/lib/types";

function tabLabel(t: TerminalTab): string {
  return t.customTitle ? t.title : (t.liveTitle || t.title);
}

export function BroadcastDialog() {
  const wsId = useUI(s => s.broadcastForWsId);
  const close = useUI(s => s.closeBroadcast);
  const pushToast = useUI(s => s.pushToast);
  const tabsForWs = useApp(s => (wsId ? s.tabs[wsId] : undefined));
  const patchTab = useApp(s => s.patchTab);

  // Targets = live terminal tabs (have a spawned PTY). Plain shells are
  // offered too but default to unchecked — broadcasts are usually for
  // agents.
  const targets = useMemo<TerminalTab[]>(
    () => (tabsForWs || []).filter(
      (t): t is TerminalTab => t.type === "terminal" && !!t.ptyId,
    ),
    [tabsForWs],
  );

  const [msg, setMsg] = useState("");
  // Per-tab checkbox OVERRIDES of the default. A tab with no override
  // falls back to its default (agents on, shells off) — so an agent
  // whose PTY spawns *after* the dialog opened still comes up checked,
  // and only the tabs the user explicitly toggled deviate.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  function isSelected(t: TerminalTab): boolean {
    return overrides[t.id] ?? (t.cli !== "shell");
  }

  // (Re-)open: clear the message and any prior overrides.
  useEffect(() => {
    if (!wsId) return;
    setMsg("");
    setOverrides({});
  }, [wsId]);

  // Auto-grow the textarea: reset to its `rows`-based height (the 5-row
  // minimum), then expand to fit the content. max-height CSS caps it and
  // overflow-y takes over past that.
  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function toggle(t: TerminalTab) {
    setOverrides(o => {
      const cur = o[t.id] ?? (t.cli !== "shell");
      return { ...o, [t.id]: !cur };
    });
  }

  function send() {
    const picked = targets.filter(t => isSelected(t) && t.ptyId);
    if (!picked.length || !msg.trim()) return;
    // sendMessageToPty writes the text then the Enter (CR) on its own a beat
    // later — agent TUIs (claude especially) treat a `\r` in the same burst
    // as the text as a literal newline, not a submit.
    const now = Date.now();
    for (const t of picked) sendMessageToPty(t.ptyId!, msg);
    // Stamp lastInputAt so TerminalPane's submittedSinceSpawn ref is armed.
    // Broadcast bypasses term.onData (it writes directly to the PTY), so
    // without this the title-based working detector stays suppressed and
    // agents like Gemini never get a working→done transition for broadcast work.
    if (wsId) for (const t of picked) patchTab(wsId, t.id, { lastInputAt: now });
    close();
    pushToast(`Broadcast to ${picked.length} agent${picked.length === 1 ? "" : "s"}`);
  }

  const selectedCount = targets.filter(isSelected).length;
  const canSend = selectedCount > 0 && msg.trim().length > 0;

  return (
    <AppDialog
      open={!!wsId}
      onOpenChange={(v) => (v ? null : close())}
      title="Broadcast message"
      description="Send one message to several open agents at once."
      className="max-w-lg"
    >
      {targets.length === 0 ? (
        <p className="mt-2 text-[13.5px] text-[var(--color-fg-dim)]">
          No running agents in this workspace yet. Open an agent tab first.
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-0.5">
            {targets.map(t => {
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
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[t.cli])}>
                    <CliIcon cli={t.cli} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">
                    {tabLabel(t)}
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
