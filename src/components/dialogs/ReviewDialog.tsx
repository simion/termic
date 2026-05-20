// AI Code Review: pick a CLI, spawn a new terminal tab in the active workspace,
// auto-type the review prompt (guidelines + diff) into the agent.

import { useEffect, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { CliIcon, CLI_BRAND_COLOR, CLI_LABEL } from "@/icons/cli";
import { ptyWrite } from "@/lib/ipc";
import { REVIEW_PROMPT } from "@/lib/review";
import { visibleCliIds } from "@/lib/agents";
import { cn } from "@/lib/utils";

const CLIS = ["claude", "gemini", "codex", "agy"] as const;

export function ReviewDialog() {
  const wsId = useUI(s => s.reviewForWsId);
  const close = useUI(s => s.closeReview);
  const ws = useApp(s => wsId ? s.workspaces.find(w => w.id === wsId) : null);
  const addTab = useApp(s => s.addTab);
  // Hide disabled / not-installed agents from the review picker.
  const registry = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const visibleClis = visibleCliIds(CLIS, registry, detectedClis);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset transient state whenever the dialog (re-)opens. Without this,
  // a successful first click leaves `busy=true` forever — agent buttons
  // stay disabled on the next Review click.
  useEffect(() => {
    if (wsId) { setBusy(false); setErr(null); }
  }, [wsId]);

  async function start(cli: string) {
    if (!ws) return;
    setBusy(true); setErr(null);
    try {
      // Spawn a fresh terminal tab so the review runs in isolation. The prompt
      // is sent verbatim — Termic's prompt has a baked-in git-diff fallback
      // so the agent fetches the diff itself; we don't pre-inject it.
      const newTabId = crypto.randomUUID();
      addTab(ws.id, { id: newTabId, type: "terminal", title: `${cli} · review`, cli });
      close();

      // Wait for the TerminalPane effect to spawn the PTY, then type the prompt.
      const deadline = Date.now() + 8000;
      const tick = () => {
        const t = (useApp.getState().tabs[ws.id] || []).find(t => t.id === newTabId);
        if (t && t.type === "terminal" && t.ptyId) {
          const bytes = new TextEncoder().encode(REVIEW_PROMPT + "\r");
          ptyWrite(t.ptyId, Array.from(bytes)).catch(() => {});
          return;
        }
        if (Date.now() < deadline) setTimeout(tick, 150);
      };
      setTimeout(tick, 500);
    } catch (e) { setErr(String(e)); setBusy(false); }
  }

  return (
    <AppDialog open={!!wsId} onOpenChange={(v) => (v ? null : close())}
      title="AI code review" description="Pick an agent — we'll feed it your diff + review guidelines.">
      <div className="mt-2 grid grid-cols-3 gap-2">
        {CLIS.filter(c => visibleClis.has(c)).map(c => (
          <button
            key={c}
            disabled={busy}
            onClick={() => start(c)}
            className={cn(
              "group flex flex-col items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 transition-colors",
              "hover:border-[var(--color-accent-soft)] disabled:opacity-50",
            )}
          >
            <span className={cn("text-[24px]", CLI_BRAND_COLOR[c])}>
              <CliIcon cli={c} className="h-7 w-7" />
            </span>
            <span className="text-[13px]">{CLI_LABEL[c] ?? c}</span>
          </button>
        ))}
      </div>
      {err && <p className="mt-3 text-[13.5px] text-[var(--color-err)]">{err}</p>}
      <p className="mt-3 text-[12px] text-[var(--color-fg-faint)]">
        Spawns a new terminal tab. Press Enter is sent for you — the agent will start streaming the review.
      </p>
    </AppDialog>
  );
}
