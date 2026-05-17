// Edit the sandbox config of an existing workspace. Saving SIGKILLs
// any live PTYs for the workspace so the next mount picks up the new
// profile - the user has to confirm before that lands. Without the
// kill the running agent would keep its OLD profile's permissions,
// which is exactly the thing we're trying to enforce against.

import { useEffect, useState } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { workspaceSetSandbox } from "@/lib/ipc";
import { AlertTriangle, Shield } from "lucide-react";

export function WorkspaceSandboxDialog() {
  const wsId = useUI(s => s.sandboxForWsId);
  const close = useUI(s => s.closeSandbox);
  const ws = useApp(s => s.workspaces.find(w => w.id === wsId) ?? null);
  const loadAll = useApp(s => s.loadAll);

  // Local edit state, snapshotted from the workspace whenever the
  // dialog opens for a new id. Saving pushes back via IPC; cancelling
  // discards. Stored as text so blank lines while typing don't fight
  // the array split.
  const [enabled, setEnabled] = useState(false);
  const [rwText,    setRwText]    = useState("");
  const [denyText,  setDenyText]  = useState("");
  const [hostsText, setHostsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  useEffect(() => {
    if (!ws) return;
    setEnabled(!!ws.sandbox_enabled);
    setRwText((ws.sandbox_rw_paths ?? []).join("\n"));
    setDenyText((ws.sandbox_deny_paths ?? []).join("\n"));
    setHostsText((ws.sandbox_allowed_hosts ?? []).join("\n"));
    setErr(null);
    setBusy(false);
  }, [ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!wsId) return null;

  async function save() {
    if (!ws || busy) return;
    // Pre-flight confirm. We don't have a live PTY count on the
    // frontend (the Rust side will tell us when the IPC returns),
    // so the dialog text is generic. The user is explicitly asking
    // for this; soft-warning is enough.
    const ok = window.confirm(
      `Save sandbox changes for "${ws.name}"?\n\n` +
      `Any agent running in this workspace will be terminated and will ` +
      `need to be restarted (click "Restart" in the terminal overlay). ` +
      `This is by design - the running process holds the OLD sandbox ` +
      `profile until it's replaced.`,
    );
    if (!ok) return;
    setBusy(true); setErr(null);
    const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
    try {
      const killed = await workspaceSetSandbox(
        ws.id, enabled,
        lines(rwText), lines(denyText), lines(hostsText),
      );
      await loadAll();
      // Quiet success - the kill is the visible feedback (overlay
      // appears in the terminal). Only surface a toast-style message
      // when nothing died, so the user knows the save landed.
      if (killed === 0) {
        // Nothing to do; close.
      }
      close();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return (
    <AppDialog
      open={!!wsId}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title={ws ? `Sandbox · ${ws.name}` : "Sandbox"}
      description="Restrict what the agent in this workspace can read, write, and reach."
    >
      <div className="flex flex-col gap-5">
        {/* Live-on switch. Toggling this off doesn't loosen anything
            you can't already do unsandboxed - it just rips the cage. */}
        <label className="inline-flex cursor-pointer items-center gap-2 select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="text-[13.5px] font-medium">
            {enabled ? "Sandboxed (seatbelt + allowed-hosts proxy)" : "Unsandboxed"}
          </span>
        </label>

        {/* Built-in defaults summary. Helps the user understand they
            don't have to list every common thing - workspace path,
            agent dirs, github, npm, etc. are already on. */}
        <details className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/50 px-3 py-2 text-[12.5px] text-[var(--color-fg-dim)]">
          <summary className="cursor-pointer select-none font-medium text-[var(--color-fg)]">
            Built-in defaults (always on when sandboxed)
          </summary>
          <div className="mt-2 grid gap-2">
            <div>
              <span className="text-[var(--color-fg-faint)]">Writable:</span>{" "}
              workspace path · <code className="mono">~/.claude</code> · <code className="mono">~/.gemini</code> · <code className="mono">~/.codex</code> · <code className="mono">~/.npm</code> · <code className="mono">~/.cache</code> · <code className="mono">~/.cargo/registry</code> · <code className="mono">~/Library/Caches</code> · <code className="mono">/private/tmp</code> · TMPDIR
            </div>
            <div>
              <span className="text-[var(--color-fg-faint)]">Always denied:</span>{" "}
              <code className="mono">~/.ssh</code> · <code className="mono">~/.aws</code> · <code className="mono">~/.gnupg</code> · <code className="mono">~/.netrc</code> · <code className="mono">~/.docker/config.json</code> · <code className="mono">~/.kube</code> · <code className="mono">~/.config/gh/hosts.yml</code> · macOS Keychains
            </div>
            <div>
              <span className="text-[var(--color-fg-faint)]">Allowed hosts:</span>{" "}
              vendor API for {ws?.cli ?? "this CLI"} · github · npmjs · pypi · crates.io · CA OCSP
            </div>
          </div>
        </details>

        <Field label="Extra writable paths" hint="One per line. $HOME and $WORKSPACE are substituted at spawn.">
          <textarea
            value={rwText}
            onChange={e => setRwText(e.target.value)}
            rows={3}
            placeholder={"$HOME/.config/myproject\n/opt/homebrew/var/myproject"}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            disabled={!enabled}
          />
        </Field>
        <Field label="Extra denied paths" hint="On top of the built-in secret deny list.">
          <textarea
            value={denyText}
            onChange={e => setDenyText(e.target.value)}
            rows={2}
            placeholder="$HOME/private-notes"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            disabled={!enabled}
          />
        </Field>
        <Field label="Extra allowed hosts" hint="POSIX regex, one per line.">
          <textarea
            value={hostsText}
            onChange={e => setHostsText(e.target.value)}
            rows={4}
            placeholder={"^.+\\.mycompany\\.com$\n^bitbucket\\.org$"}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            disabled={!enabled}
          />
        </Field>

        {/* Restart warning. Always visible (not error-state) so the
            user has it in view BEFORE they hit save. */}
        <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-3 py-2 text-[12.5px] text-[var(--color-fg-dim)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <span>
            Saving terminates any running agent in this workspace. The terminal
            shows a "Restart" overlay; click it to relaunch under the new sandbox.
          </span>
        </div>

        {err && <p className="text-[13.5px] text-[var(--color-err)]">{err}</p>}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="button" onClick={save} disabled={busy} className="gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            {busy ? "Saving…" : "Save & restart"}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[13.5px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">{hint}</div>}
      <div className="mt-2">{children}</div>
    </div>
  );
}
