// Edit the sandbox config of an existing workspace. Saving SIGKILLs
// any live PTYs for the workspace so the next mount picks up the new
// profile - the user has to confirm before that lands. Without the
// kill the running agent would keep its OLD profile's permissions,
// which is exactly the thing we're trying to enforce against.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextareaHTMLAttributes } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { workspaceSetSandbox, workspaceRecentDenials, workspaceTestSandbox, type ProbeResult } from "@/lib/ipc";
import { AlertTriangle, Shield, Zap, RefreshCw, FlaskConical, Check, X } from "lucide-react";
import { SANDBOX_PRESETS } from "@/lib/sandboxPresets";

export function WorkspaceSandboxDialog() {
  const wsId = useUI(s => s.sandboxForWsId);
  const close = useUI(s => s.closeSandbox);
  const ws = useApp(s => s.workspaces.find(w => w.id === wsId) ?? null);
  // The project owns the "current defaults" - drives the "Reset to
  // project defaults" button. Workspace's frozen lists were seeded
  // from these at creation; if the user since updated the project,
  // this button re-syncs (one click, no auto-overwrite).
  const project = useApp(s => ws ? s.projects.find(p => p.id === ws.project_id) ?? null : null);
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
  // Recent denials panel. Loaded lazily (only when the user expands
  // the <details>) to avoid invoking `log show` on every dialog open.
  const [denies, setDenies] = useState<string[] | null>(null);
  const [denyBusy, setDenyBusy] = useState(false);
  // Self-test results: null = never run; array = last run's probes.
  // We don't auto-run; the user clicks the Test button. ~3s round-trip
  // (provision + 2 curls); the button shows a spinner while in flight.
  const [probes, setProbes] = useState<ProbeResult[] | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  useEffect(() => {
    if (!ws) return;
    setEnabled(!!ws.sandbox_enabled);
    setRwText((ws.sandbox_rw_paths ?? []).join("\n"));
    setDenyText((ws.sandbox_deny_paths ?? []).join("\n"));
    setHostsText((ws.sandbox_allowed_hosts ?? []).join("\n"));
    setErr(null);
    setBusy(false);
    setDenies(null);  // re-fetch on next expand
  }, [ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDenies = async () => {
    if (!ws) return;
    setDenyBusy(true);
    try {
      const out = await workspaceRecentDenials(ws.id, 15);
      setDenies(out);
    } catch {
      setDenies([]);
    } finally {
      setDenyBusy(false);
    }
  };

  const runTest = async () => {
    if (!ws) return;
    setTestBusy(true); setProbes(null);
    try {
      // Pass the CURRENT textarea contents - not the saved workspace -
      // so the test reflects what the user is staring at. Without
      // this the dialog tested last-saved state, making the "test
      // before commit" use case useless.
      const split = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
      const out = await workspaceTestSandbox(ws.id, {
        rwPaths:       split(rwText),
        denyPaths:     split(denyText),
        allowedHosts:  split(hostsText),
      });
      setProbes(out);
    } catch (e) {
      setProbes([{ host: "—", expected: "allow", ok: false, http_code: null, note: String(e) }]);
    } finally {
      setTestBusy(false);
    }
  };

  if (!wsId) return null;

  async function save() {
    if (!ws || busy) return;
    // Pre-flight confirm. We don't have a live PTY count on the
    // frontend (the Rust side will tell us when the IPC returns),
    // so the dialog text is generic. The user is explicitly asking
    // for this; soft-warning is enough.
    const ok = await useUI.getState().askConfirm({
      title: `Save sandbox changes for "${ws.name}"?`,
      message:
        "Any agent running in this workspace will be terminated and will need to be restarted (click \"Restart\" in the terminal overlay). " +
        "This is by design — the running process holds the OLD sandbox profile until it's replaced.",
      confirmLabel: "Save & restart",
    });
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
      // Wider than the default max-w-md so the textareas don't get
      // squeezed into a column. Cap height to the viewport so the
      // body scrolls when content overflows (sandbox dialog has more
      // sections than other dialogs - editors, denies panel, test
      // panel, restart warning all stack up).
      className="max-w-4xl max-h-[90vh] overflow-hidden text-[13px]"
    >
      {/* Outer column: body scrolls; footer is shrink-0 so it stays
          pinned at the bottom of the dialog regardless of scroll. */}
      <div className="flex max-h-[calc(90vh-7rem)] flex-col">
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto pr-1">
        {/* On/off panel. Big, color-coded, unambiguous - the prior
            "Unsandboxed" checkbox was a double-negative trap: users
            saw the box checked and assumed the cage was ON. State now
            reads from the color band (green = caged, red = open) and
            the verb on the action button ("Disable" vs "Enable"). */}
        <div
          className={
            "flex items-center justify-between gap-4 rounded-md border px-4 py-3 " +
            (enabled
              ? "border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10"
              : "border-[var(--color-err)]/40 bg-[var(--color-err)]/10")
          }
        >
          <div className="flex items-center gap-3">
            <Shield
              className={
                "h-5 w-5 " +
                (enabled ? "text-[var(--color-ok)]" : "text-[var(--color-err)]")
              }
              fill={enabled ? "currentColor" : "none"}
            />
            <div className="flex flex-col">
              <span className="text-[14.5px] font-semibold text-[var(--color-fg)]">
                Sandbox is {enabled ? "ON" : "OFF"}
              </span>
              <span className="text-[12.5px] text-[var(--color-fg-dim)]">
                {enabled
                  ? "Agent runs under seatbelt + allowed-hosts proxy."
                  : "Agent has full filesystem + network access."}
              </span>
            </div>
          </div>
          <Button
            variant={enabled ? "ghost" : "primary"}
            onClick={() => setEnabled(!enabled)}
          >
            {enabled ? "Disable" : "Enable sandbox"}
          </Button>
        </div>

        {/* YOLO trade-off note. Sandboxed agents auto-skip their own
            permission prompts because the seatbelt is the real boundary -
            users should know this is happening, not stumble onto it. */}
        {enabled && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-ok)]/25 bg-[var(--color-ok)]/10 px-3 py-2 text-[13px] text-[var(--color-fg-dim)]">
            <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
            <span>
              <b className="text-[var(--color-fg)]">YOLO auto-on inside the cage.</b>{" "}
              The agent's own permission prompts are skipped because the
              seatbelt profile is the real boundary. The global YOLO toggle
              becomes informational for this workspace.
            </span>
          </div>
        )}

        {/* Built-in defaults moved inline under each field below -
            the standalone <details> made users miss what was already
            covered, leading to redundant entries in the "Extra"
            textareas. Always-visible inline = "you don't need to
            list this; it's covered." */}

        {/* Presets - clobber the three textareas with a known-good
            starting point. User can still edit afterwards. The
            'Reset to project defaults' button is a separate action
            because the project's current defaults are user-owned
            (vs the bundled Presets which are app-owned). */}
        {enabled && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-[var(--color-fg-faint)]">Preset:</span>
            {SANDBOX_PRESETS.map(p => (
              <button
                key={p.id} type="button"
                title={p.hint}
                onClick={() => {
                  setRwText(p.rwPaths.join("\n"));
                  setDenyText(p.denyPaths.join("\n"));
                  setHostsText(p.allowedHosts.join("\n"));
                }}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
              >
                {p.label}
              </button>
            ))}
            {project && (
              <button
                type="button"
                title={`Re-sync from ${project.name}'s current sandbox defaults (Settings → Repositories).`}
                onClick={() => {
                  setRwText((project.sandbox_rw_paths ?? []).join("\n"));
                  setDenyText((project.sandbox_deny_paths ?? []).join("\n"));
                  setHostsText((project.sandbox_allowed_hosts ?? []).join("\n"));
                }}
                className="rounded-md border border-[var(--color-accent-soft)] bg-[var(--color-bg)] px-2 py-0.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]"
              >
                Reset to project defaults
              </button>
            )}
          </div>
        )}

        <Field label="Add writable paths" hint="One per line. $HOME and $WORKSPACE are substituted at spawn.">
          <BuiltInsLine>
            workspace · <Mono>~/.claude</Mono> · <Mono>~/.gemini</Mono> · <Mono>~/.codex</Mono> · <Mono>~/.npm</Mono> · <Mono>~/.cache</Mono> · <Mono>~/.cargo/registry</Mono> · <Mono>~/Library/Caches</Mono> · <Mono>/private/tmp</Mono> · TMPDIR
          </BuiltInsLine>
          <AutoGrowTextarea
            value={rwText}
            onChange={e => setRwText(e.target.value)}
            rows={2}
            placeholder={"$HOME/.config/myproject\n/opt/homebrew/var/myproject"}
            className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] [field-sizing:content]"
            disabled={!enabled}
          />
        </Field>
        <Field label="Add denied paths" hint="On top of the built-in secret deny list.">
          <BuiltInsLine>
            secrets: <Mono>~/.ssh</Mono> · <Mono>~/.aws</Mono> · <Mono>~/.gnupg</Mono> · <Mono>~/.netrc</Mono> · <Mono>~/.docker/config.json</Mono> · <Mono>~/.kube</Mono> · <Mono>~/.config/gh/hosts.yml</Mono>
            <br />
            personal data: <Mono>~/Documents</Mono> · <Mono>~/Desktop</Mono> · <Mono>~/Downloads</Mono> · <Mono>~/Movies</Mono> · <Mono>~/Pictures</Mono> · <Mono>~/Music</Mono> · Mail · Messages · Calendars · Safari · Firefox · Chrome · Brave · Arc · shell histories
          </BuiltInsLine>
          <AutoGrowTextarea
            value={denyText}
            onChange={e => setDenyText(e.target.value)}
            rows={2}
            placeholder="$HOME/private-notes"
            className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] [field-sizing:content]"
            disabled={!enabled}
          />
        </Field>
        <Field label="Add allowed hosts" hint="One per line. Use * as a wildcard. Examples: *.mycompany.com, bitbucket.org">
          <BuiltInsLine>
            vendor API for {ws?.cli ?? "this CLI"} · github · npmjs · pypi · crates.io · CA OCSP
          </BuiltInsLine>
          <AutoGrowTextarea
            value={hostsText}
            onChange={e => setHostsText(e.target.value)}
            rows={2}
            placeholder={"*.mycompany.com\nbitbucket.org"}
            className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] [field-sizing:content]"
            disabled={!enabled}
          />
        </Field>

        {/* Recent denies — debugging panel. macOS log show, scoped
            by workspace path. Lazy-loaded on expand so we don't run
            `log show` (~200ms shell-out) on every dialog open. */}
        <details
          className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/50 px-3 py-2 text-[13px] text-[var(--color-fg-dim)]"
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open && denies === null) loadDenies();
          }}
        >
          <summary className="flex cursor-pointer select-none items-center gap-2 font-medium text-[var(--color-fg)]">
            Recent denies (last 15 min)
            {denies !== null && (
              <span className="rounded-full bg-[var(--color-bg-3)] px-1.5 text-[13px] font-normal text-[var(--color-fg-dim)]">{denies.length}</span>
            )}
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); loadDenies(); }}
              className="ml-auto rounded p-0.5 hover:bg-[var(--color-hover)]"
              title="Refresh"
            >
              <RefreshCw className={denyBusy ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
            </button>
          </summary>
          {denies === null && (
            <div className="mt-2 text-[13px] text-[var(--color-fg-faint)]">
              Expand to fetch. Surfaces what the kernel sandbox blocked for this workspace; useful when npm/curl/etc silently fail.
            </div>
          )}
          {denies !== null && denies.length === 0 && (
            <div className="mt-2 text-[13px] text-[var(--color-fg-faint)]">
              No denies in the last 15 minutes. Either the sandbox isn't blocking anything, or the agent hasn't tried anything blocked.
            </div>
          )}
          {denies !== null && denies.length > 0 && (
            <pre data-selectable className="mt-2 max-h-[200px] overflow-auto rounded bg-[var(--color-bg)] p-2 font-mono text-[13px] leading-snug text-[var(--color-fg-dim)]">
              {denies.join("\n")}
            </pre>
          )}
        </details>

        {/* Sandbox self-test. Provisions a one-shot bundle of the
            CURRENT config (not saved yet - so the user can verify
            their pending edits before committing them) and runs two
            curls inside it: one allowed host, one denied. Useful for
            reassuring yourself the cage actually closes, and for
            debugging "did I configure the proxy right?" */}
        {enabled && (
          <div className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/50 px-3 py-2 text-[13px]">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-3.5 w-3.5 text-[var(--color-fg-dim)]" />
              <span className="font-medium text-[var(--color-fg)]">Test sandbox</span>
              <span className="text-[var(--color-fg-faint)]">— runs <code className="mono">curl</code> against an allowed host and a denied host inside the cage.</span>
              <button
                type="button"
                onClick={runTest}
                disabled={testBusy}
                className="ml-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[13px] text-[var(--color-fg)] hover:border-[var(--color-accent-soft)] disabled:opacity-50"
              >
                {testBusy ? "Running…" : "Run"}
              </button>
            </div>
            {probes !== null && (
              <ul className="mt-2 flex flex-col gap-1">
                {probes.map((p, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {p.ok
                      ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
                      : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-err)]" />}
                    <span className="flex-1">
                      <span className="font-mono text-[13px] text-[var(--color-fg-dim)]">{p.host}</span>
                      {" "}
                      <span className="text-[var(--color-fg-faint)]">→ {p.expected}</span>
                      <span className="ml-2 text-[13px] text-[var(--color-fg-dim)]">{p.note}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Restart warning. Always visible (not error-state) so the
            user has it in view BEFORE they hit save. */}
        <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-3 py-2 text-[13px] text-[var(--color-fg-dim)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <span>
            Saving terminates any running agent in this workspace. The terminal
            shows a "Restart" overlay; click it to relaunch under the new sandbox.
          </span>
        </div>

        {err && <p className="text-[13px] text-[var(--color-err)]">{err}</p>}
        </div>

        {/* Sticky footer — sits outside the scroll container so the
            Save button is always reachable no matter how long the form
            gets after autogrow expands the textareas. */}
        <div className="mt-3 flex shrink-0 justify-end gap-2 border-t border-[var(--color-border-soft)] pt-3">
          <Button variant="ghost" type="button" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="button" onClick={save} disabled={busy} className="gap-1.5">
            <Shield className="h-3.5 w-3.5" fill="currentColor" />
            {busy ? "Saving…" : "Save & restart terminal"}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}

// Textarea that grows with its content. The CSS-only `field-sizing:
// content` approach didn't take in this WKWebView build, so we fall
// back to the JS recipe: collapse to auto, then size to scrollHeight
// on every value change. `overflow-hidden` kills the temporary
// scrollbar that would otherwise flicker during resize.
function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      {...props}
      style={{ overflow: "hidden", ...props.style }}
    />
  );
}

// Inline reminder of what's already covered by the built-in default
// set for this field. Sits between the field's hint and its textarea
// so users see "covered" stuff before they type something redundant.
function BuiltInsLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[12px] leading-snug text-[var(--color-fg-faint)]">
      <span className="font-medium text-[var(--color-fg-dim)]">Already covered:</span>{" "}
      {children}
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[11.5px] text-[var(--color-fg-dim)]">{children}</code>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[13px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[13px] text-[var(--color-fg-dim)]">{hint}</div>}
      <div className="mt-2">{children}</div>
    </div>
  );
}
