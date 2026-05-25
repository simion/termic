// Edit the sandbox config of an existing workspace. Saving SIGKILLs
// any live PTYs for the workspace so the next mount picks up the new
// profile - the user has to confirm before that lands. Without the
// kill the running agent would keep its OLD profile's permissions,
// which is exactly the thing we're trying to enforce against.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextareaHTMLAttributes } from "react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { settingsLoad, workspaceSetSandbox, workspaceTestSandbox, sandboxAvailable, type ProbeResult } from "@/lib/ipc";
import { AlertTriangle, Shield, Zap, FlaskConical, Check, X, Save, RotateCw } from "lucide-react";
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
  const agent   = useApp(s => ws ? s.agents.find(a => a.id === ws.cli) ?? null : null);
  const loadAll = useApp(s => s.loadAll);
  const sandboxBypassPermissions = usePrefs(s => s.sandboxBypassPermissions);

  // Local edit state, snapshotted from the workspace whenever the
  // dialog opens for a new id. Saving pushes back via IPC; cancelling
  // discards. Stored as text so blank lines while typing don't fight
  // the array split.
  const [enabled, setEnabled] = useState(false);
  const [rwText,    setRwText]    = useState("");
  const [hostsText, setHostsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);
  // Self-test results: null = never run; array = last run's probes.
  // We don't auto-run; the user clicks the Test button. ~3s round-trip
  // (provision + 2 curls); the button shows a spinner while in flight.
  const [probes, setProbes] = useState<ProbeResult[] | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  // OS sandbox support gate. macOS → true. Linux/Windows → false,
  // and we disable the enable button + show "unavailable" banner.
  // Probed once on mount; cheap (one Path::exists() check) but cached.
  const [osSandboxOk, setOsSandboxOk] = useState<boolean | null>(null);
  useEffect(() => {
    sandboxAvailable().then(setOsSandboxOk).catch(() => setOsSandboxOk(false));
  }, []);

  useEffect(() => {
    if (!ws) return;
    setEnabled(!!ws.sandbox_enabled);
    setRwText((ws.sandbox_rw_paths ?? []).join("\n"));
    setHostsText((ws.sandbox_allowed_hosts ?? []).join("\n"));
    setErr(null);
    setBusy(false);
  }, [ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const _unused_loadDenies = async () => {
    // Recent-denies panel removed in favor of the live footer chip.
    // Stub kept so accidental imports don't break the build.
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
        allowedHosts:  split(hostsText),
      });
      setProbes(out);
    } catch (e) {
      setProbes([{ host: "?", expected: "allow", ok: false, http_code: null, note: String(e) }]);
    } finally {
      setTestBusy(false);
    }
  };

  if (!wsId) return null;

  // Has the form drifted from the saved workspace? Compare textareas
  // by their normalized line-array form (trim, drop blanks) so that
  // whitespace-only edits (an extra newline at the end) don't count
  // as dirty. The Save button stays disabled until something actually
  // changed — including the enable/disable toggle.
  const splitLines = (s: string) =>
    s.split("\n").map(l => l.trim()).filter(Boolean);
  const arrEq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const dirty = ws ? (
    enabled !== !!ws.sandbox_enabled ||
    !arrEq(splitLines(rwText),    ws.sandbox_rw_paths      ?? []) ||
    !arrEq(splitLines(hostsText), ws.sandbox_allowed_hosts ?? [])
  ) : false;

  async function save(restart: boolean) {
    if (!ws || busy) return;
    // Pre-flight confirm. We don't have a live PTY count on the
    // frontend (the Rust side will tell us when the IPC returns),
    // so the dialog text is generic. The user is explicitly asking
    // for this; soft-warning is enough.
    const ok = await useUI.getState().askConfirm({
      title: `Save sandbox changes for "${ws.name}"?`,
      message: restart
        ? "Any agent running in this workspace will be terminated and AUTO-restarted under the new sandbox profile. " +
          "This is by design: the running process holds the OLD profile until it's replaced."
        : "Saving without restart. Any agent currently running in this workspace keeps its OLD sandbox profile until it next respawns. " +
          "New tabs use the saved profile immediately.",
      confirmLabel: restart ? "Save & restart" : "Save without restart",
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    const lines = (s: string) => s.split("\n").map(l => l.trim()).filter(Boolean);
    try {
      // Mark BEFORE the IPC fires so TerminalPane sees the flag when
      // the pty-exit handler runs (the SIGKILL is fast - sometimes
      // exits land before this function's await even unblocks).
      if (restart) useUI.getState().markPendingSandboxRestart(ws.id);
      const killed = await workspaceSetSandbox(
        ws.id, enabled,
        lines(rwText), lines(hostsText),
        restart,
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
            // "Disable" gets warn-yellow chrome so it reads as an
            // intentional action (the previous ghost-styled link was
            // basically invisible against the green panel). "Enable
            // sandbox" stays the standard accent-deep primary.
            variant={enabled ? "secondary" : "primary"}
            onClick={async () => {
              const next = !enabled;
              setEnabled(next);
              // First-time enable: if all three lists are empty, seed
              // them from the union of project + global defaults so
              // the user starts with a sensible baseline instead of a
              // blank cage. Only fires when there's nothing to lose.
              if (next && !rwText.trim() && !hostsText.trim()) {
                try {
                  const s = await settingsLoad();
                  const merge = (g: string[] = [], pr: string[] = []) => {
                    const seen = new Set<string>(); const out: string[] = [];
                    for (const v of [...g, ...pr]) {
                      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
                    }
                    return out.join("\n");
                  };
                  setRwText   (merge(s.sandbox_default_rw_paths,      project?.sandbox_rw_paths));
                  setHostsText(merge(s.sandbox_default_allowed_hosts, project?.sandbox_allowed_hosts));
                } catch {}
              }
            }}
            disabled={osSandboxOk === false && !enabled}
            title={osSandboxOk === false ? "Sandbox is macOS-only (requires sandbox-exec). Not available on this platform." : undefined}
            className={enabled
              ? "border-[var(--color-warn)]/50 bg-[var(--color-warn)]/15 text-[var(--color-warn)] hover:bg-[var(--color-warn)]/25 hover:border-[var(--color-warn)]"
              : undefined}
          >
            {enabled ? "Disable" : "Enable sandbox"}
          </Button>
        </div>
        {osSandboxOk === false && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-3 py-2 text-[13px] text-[var(--color-fg-dim)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
            <span>
              <b className="text-[var(--color-fg)]">Sandbox unavailable on this OS.</b>{" "}
              Termic's cage uses macOS Seatbelt (<code className="mono">sandbox-exec</code>); Linux + Windows
              equivalents aren't wired up yet. The network proxy and the
              CLI agent still work, just without the filesystem cage.
            </span>
          </div>
        )}

        {/* YOLO trade-off note. Sandboxed agents auto-skip their own
            permission prompts because the seatbelt is the real boundary -
            users should know this is happening, not stumble onto it.
            Honors the Settings → General "Bypass permissions in sandboxed
            workspaces" toggle. */}
        {enabled && sandboxBypassPermissions && (
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
                title={`Re-sync from ${project.name}'s current sandbox defaults (Settings → Projects).`}
                onClick={() => {
                  setRwText((project.sandbox_rw_paths ?? []).join("\n"));
                  setHostsText((project.sandbox_allowed_hosts ?? []).join("\n"));
                }}
                className="rounded-md border border-[var(--color-accent-soft)] bg-[var(--color-bg)] px-2 py-0.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]"
              >
                Reset to project defaults
              </button>
            )}
          </div>
        )}

        <Field
          label="Allowed paths"
          hint="Extra dirs the agent can read AND write, on top of the workspace + agent + runtime defaults shown on the right. One per line. ~, $HOME, and $WORKSPACE expand at spawn time."
        >
          {/* Two columns, locked to the same height. box-border on
              both so the explicit h-[] applies to the OUTER box
              (border + padding included) instead of the content
              area — otherwise the textarea (content-box default)
              renders ~2px taller than the panel and they don't line
              up. scrollbar-gutter:stable so the right panel reserves
              space for its scrollbar and the chips don't reflow when
              scrolling kicks in. */}
          <div className="grid grid-cols-2 items-stretch gap-3">
            <AutoGrowTextarea
              value={rwText}
              onChange={e => setRwText(e.target.value)}
              rows={4}
              placeholder={"$HOME/Work/other-project\n$HOME/Notes"}
              className="box-border h-[180px] w-full resize-none overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              disabled={!enabled}
            />
            <DefaultsPanel className="box-border h-[180px] overflow-y-auto [scrollbar-gutter:stable]">
              <ChipGroup tone="allow" label="Always allowed, read + write (workspace + runtime)">
                <Chip tone="allow">workspace</Chip>
                <Chip tone="allow">~/.npm</Chip>
                <Chip tone="allow">~/.cache</Chip>
                <Chip tone="allow">~/.cargo</Chip>
                <Chip tone="allow">~/.bun</Chip>
                <Chip tone="allow">~/Library/Caches</Chip>
                <Chip tone="allow">/private/tmp</Chip>
                <Chip tone="allow">TMPDIR</Chip>
              </ChipGroup>
              <ChipGroup tone="allow" label="Always allowed, read only (system bins + linker)">
                <Chip tone="allow">/usr</Chip>
                <Chip tone="allow">/opt</Chip>
                <Chip tone="allow">/bin</Chip>
                <Chip tone="allow">/sbin</Chip>
                <Chip tone="allow">/dev</Chip>
                <Chip tone="allow">/etc</Chip>
                <Chip tone="allow" muted>dyld / ld.so cache</Chip>
                <Chip tone="allow" muted>/lib /lib64 (linux)</Chip>
                <Chip tone="allow" muted>/proc /sys /run (linux)</Chip>
              </ChipGroup>
              {agent && (agent.sandbox_allowed_paths?.length ?? 0) > 0 && (
                <ChipGroup tone="allow" label={`Always allowed for ${agent.display_name || agent.id}`}>
                  {(agent.sandbox_allowed_paths ?? []).map(p => (
                    <Chip key={p} tone="allow">{p.replace(/^\$HOME/, "~")}</Chip>
                  ))}
                </ChipGroup>
              )}
              <p className="mt-2 text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
                Everything outside the allow-list is denied. Secrets
                (<span className="font-mono">~/.ssh</span>,{" "}
                <span className="font-mono">~/.aws</span>,{" "}
                <span className="font-mono">~/.gnupg</span>, Keychains,
                browser data) stay denied even if you allow a parent.
                Add the <i>exact</i> path on the left to override.
              </p>
            </DefaultsPanel>
          </div>
        </Field>
        <Field label="Add allowed hosts" hint="One per line. Use * as a wildcard. Examples: *.mycompany.com, bitbucket.org">
          <div className="grid grid-cols-2 items-stretch gap-3">
            <AutoGrowTextarea
              value={hostsText}
              onChange={e => setHostsText(e.target.value)}
              rows={3}
              placeholder={"*.mycompany.com\nbitbucket.org"}
              className="h-full min-h-[100px] w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] [field-sizing:content]"
              disabled={!enabled}
            />
            <DefaultsPanel className="h-full">
              <ChipGroup tone="allow" label="Always reachable">
                <Chip tone="allow">vendor API for {ws?.cli ?? "this CLI"}</Chip>
                <Chip tone="allow">github.com</Chip>
                <Chip tone="allow">npmjs.org</Chip>
                <Chip tone="allow">pypi.org</Chip>
                <Chip tone="allow">crates.io</Chip>
                <Chip tone="allow" muted>CA OCSP</Chip>
              </ChipGroup>
            </DefaultsPanel>
          </div>
        </Field>

        {/* "Recent denies" panel removed — the TerminalPane footer
            now shows a live deny counter chip per workspace, which
            is the discoverable surface. Detailed log lookups belong
            in the debug.log path, not buried in the dialog. */}

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
              <span className="text-[var(--color-fg-faint)]">runs <code className="mono">curl</code> against an allowed host and a denied host inside the cage.</span>
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
          <Button
            variant="secondary" type="button" onClick={() => save(false)}
            disabled={busy || !dirty}
            title={!dirty
              ? "No changes to save"
              : "Persist the profile but leave the running agent alone. It keeps the OLD profile until it next respawns."}
            className="gap-1.5"
          >
            <Save className="h-3.5 w-3.5" />
            Save without restart
          </Button>
          <Button
            variant="primary" type="button" onClick={() => save(true)}
            disabled={busy || !dirty}
            title={!dirty ? "No changes to save" : undefined}
            className="gap-1.5"
          >
            <RotateCw className="h-3.5 w-3.5" />
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

// Replaces the old prose-with-middots BuiltInsLine for the two fields
// where the default set is more than a handful of paths. A bordered
// container holds one or more ChipGroups - each group has a tone
// (allow / deny) and a row of Chip pills. Reads top-to-bottom in
// O(scan) instead of forcing the user to parse a comma-soup.
function DefaultsPanel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(
      "rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-2.5",
      className,
    )}>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-fg-faint)]">
        Already covered
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function ChipGroup({
  label,
  tone,
  children,
}: {
  label: string;
  tone: "allow" | "deny";
  children: React.ReactNode;
}) {
  // Tone drives the leading dot color + group label color. Keeping
  // each line as a flex-wrap row lets chips reflow naturally as the
  // dialog width changes.
  const dotColor = tone === "allow" ? "var(--color-ok)" : "var(--color-err)";
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: dotColor }}
          aria-hidden
        />
        <span className="text-[11.5px] font-medium text-[var(--color-fg-dim)]">{label}</span>
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Chip({
  tone,
  muted = false,
  children,
}: {
  tone: "allow" | "deny";
  // `muted` for category-summary chips like "+ XDG variants" or
  // "system dirs" - same shape, no colored border. Keeps the visual
  // weight of the literal paths higher than the umbrella terms.
  muted?: boolean;
  children: React.ReactNode;
}) {
  const borderVar = muted
    ? "var(--color-border)"
    : tone === "allow"
      ? "color-mix(in srgb, var(--color-ok) 35%, var(--color-border))"
      : "color-mix(in srgb, var(--color-err) 35%, var(--color-border))";
  const bgVar = muted
    ? "transparent"
    : tone === "allow"
      ? "color-mix(in srgb, var(--color-ok) 8%, transparent)"
      : "color-mix(in srgb, var(--color-err) 8%, transparent)";
  return (
    <code
      className="inline-flex items-center rounded border px-1.5 py-[1px] font-mono text-[11px] text-[var(--color-fg-dim)]"
      style={{ borderColor: borderVar, background: bgVar }}
    >
      {children}
    </code>
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
