// Settings → Agents. Lets the user edit per-CLI launch commands, default
// args, YOLO flags, and runtime YOLO slash-commands.
//
// Built-in agents (claude/gemini/codex) are editable but not removable —
// removing them would orphan existing workspaces that reference them.
// Saves are debounced (500ms) so typing doesn't hammer the JSON file.

import { useEffect, useRef, useState } from "react";
import { settingsLoad, agentsSave, agentsDefaults } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import type { Agent } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AppDialog } from "@/components/ui/Dialog";
import { Trash2, Plus, Check, AlertTriangle, RotateCcw } from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { cn } from "@/lib/utils";

export function AgentsSection() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const savedFlashTimer = useRef<number | null>(null);
  // id of an agent that just got created — its card uses this to scroll into
  // view and focus its name input on mount. Cleared after one use.
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  // Pending-delete confirmation. null = closed.
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);
  // Ship-time defaults, fetched from Rust. Used to compute "modified"
  // indicators + drive the reset-to-defaults action so users can pick up
  // updated default flags (e.g. claude's new `--resume {workspace_slug}`)
  // without losing their other customizations.
  const [defaults, setDefaults] = useState<Agent[]>([]);

  useEffect(() => {
    settingsLoad().then(s => setAgents(s.agents || [])).catch(e => setErr(String(e)));
    agentsDefaults().then(setDefaults).catch(() => {});
  }, []);

  /** True if any field on the agent differs from its ship-time default.
   *  Used to gate the "Reset to defaults" button per agent so it's only
   *  shown when there's actually something to reset. Env is excluded
   *  from the comparison: user-set env is a personal augmentation, not
   *  a "modification" of the agent's command shape, and we never
   *  clobber it on reset. */
  function isModified(a: Agent): boolean {
    const d = defaults.find(d => d.id === a.id);
    if (!d) return false; // custom agents have no "defaults" to revert to
    const stripEnv = (x: Agent) => { const { env: _e, ...rest } = x; void _e; return rest; };
    return JSON.stringify(stripEnv(d)) !== JSON.stringify(stripEnv(a));
  }

  /** Reset one agent to its ship-time defaults (preserves display_name +
   *  ordering AND the user's per-agent env block — env is a personal
   *  setup detail, not part of the agent's command shape, so a reset
   *  shouldn't wipe `CLAUDE_CODE_NO_FLICKER=1` etc.). Custom agents
   *  (no matching default id) are no-op. */
  function resetAgent(id: string) {
    const d = defaults.find(d => d.id === id);
    if (!d) return;
    mutate(agents.map(a => a.id === id ? { ...d, env: a.env ?? {} } : a));
  }

  /** Reset every built-in to ship defaults; preserves custom agents the
   *  user added AND each agent's env block. */
  async function resetAllBuiltins() {
    const ok = await useUI.getState().askConfirm({
      title: "Reset built-in agents to defaults?",
      message: "Resets claude, gemini, codex to their ship-default commands. Custom agents and per-agent env blocks are kept.",
      confirmLabel: "Reset built-ins",
    });
    if (!ok) return;
    const next = agents.map(a => {
      const d = defaults.find(d => d.id === a.id);
      return d ? { ...d, env: a.env ?? {} } : a;
    });
    mutate(next);
  }

  function performSave(next: Agent[]) {
    setStatus("saving"); setErr(null);
    agentsSave(next)
      .then(() => {
        setStatus("saved");
        if (savedFlashTimer.current) window.clearTimeout(savedFlashTimer.current);
        savedFlashTimer.current = window.setTimeout(() => setStatus("idle"), 1500) as unknown as number;
      })
      .catch(e => { setErr(String(e)); setStatus("error"); });
  }

  function mutate(next: Agent[]) {
    setAgents(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => performSave(next), 500) as unknown as number;
  }

  function patchAgent(id: string, patch: Partial<Agent>) {
    mutate(agents.map(a => a.id === id ? { ...a, ...patch } : a));
  }
  function patchCaps(id: string, patch: Partial<NonNullable<Agent["capabilities"]>>) {
    mutate(agents.map(a => a.id === id
      ? { ...a, capabilities: { ...(a.capabilities || {}), ...patch } }
      : a));
  }
  function requestRemoveAgent(id: string) {
    const a = agents.find(x => x.id === id);
    if (!a || a.builtin) return;
    // Open the in-app confirmation dialog — native confirm() is jarring and
    // doesn't match the rest of the app's chrome.
    setPendingDelete(a);
  }
  function confirmRemoveAgent() {
    if (!pendingDelete) return;
    mutate(agents.filter(x => x.id !== pendingDelete.id));
    setPendingDelete(null);
  }
  function addAgent() {
    // Find a unique id "custom-N".
    let n = 1;
    while (agents.some(a => a.id === `custom-${n}`)) n++;
    const fresh: Agent = {
      id: `custom-${n}`,
      display_name: `New agent ${n}`,
      command: "",
      args: [],
      icon_id: "lucide:terminal",
      color: "#9aa0a6",
      builtin: false,
      capabilities: { yolo_args: [], runtime_yolo_command: "" },
    };
    mutate([...agents, fresh]);
    // Tell that card to scroll-into-view + focus on mount.
    setAutoFocusId(fresh.id);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-[20px] font-medium">Agents</h1>
        <div className="flex items-center gap-3">
          <div className="text-[12px] text-[var(--color-fg-faint)] min-h-[1em]">
            {status === "saving" && <span>Saving…</span>}
            {status === "saved"  && <span className="flex items-center gap-1 text-[var(--color-ok)]"><Check className="h-3.5 w-3.5" /> Saved</span>}
            {status === "error"  && <span className="text-[var(--color-err)]">Save failed</span>}
          </div>
          <Button variant="ghost" size="sm" onClick={resetAllBuiltins} title="Reset claude, gemini, codex to ship defaults (custom agents kept)">
            <RotateCcw className="h-3.5 w-3.5" /> Reset built-ins
          </Button>
          <Button variant="secondary" size="sm" onClick={addAgent}>
            <Plus className="h-3.5 w-3.5" /> Add agent CLI
          </Button>
        </div>
      </div>

      <p className="text-[13px] text-[var(--color-fg-dim)] -mt-2">
        Customize the command and flags used to launch each agent. Useful when the CLI renames a flag
        (e.g., a future <code className="font-mono">--yolo</code> rename) or you want to point at a
        wrapper script. Built-in agents can be edited but not removed.
      </p>

      {err && <div className="text-[13px] text-[var(--color-err)]">{err}</div>}

      <AgentsTabs
        agents={agents}
        autoFocusId={autoFocusId}
        defaults={defaults}
        isModified={isModified}
        patchAgent={patchAgent}
        patchCaps={patchCaps}
        requestRemoveAgent={requestRemoveAgent}
        resetAgent={resetAgent}
        onAutoFocusConsumed={() => setAutoFocusId(null)}
      />

      {/* Delete confirmation. In-app dialog (not browser confirm) so it
          matches the app chrome and traps focus properly. */}
      <AppDialog
        open={!!pendingDelete}
        onOpenChange={(v) => { if (!v) setPendingDelete(null); }}
      >
        <div className="flex items-start gap-3">
          <span className="shrink-0 rounded-full bg-[var(--color-err)]/15 p-2 text-[var(--color-err)]">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">Remove agent?</div>
            <p className="mt-1 text-[13px] text-[var(--color-fg-dim)]">
              <span className="font-mono text-[var(--color-fg)]">{pendingDelete?.display_name}</span>{" "}
              will be removed. Workspaces that reference it will fall back to spawning the
              literal command <span className="font-mono text-[var(--color-fg)]">{pendingDelete?.command || "(empty)"}</span>.
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPendingDelete(null)}>Cancel</Button>
          <Button variant="danger" onClick={confirmRemoveAgent}>
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </Button>
        </div>
      </AppDialog>
    </div>
  );
}

/** Tab strip + active-agent card. Drops the long scroll of every
 *  agent stacked vertically (the Repository settings split-by-subtab
 *  trick, scoped per-agent here). Tabs auto-pick the first agent on
 *  mount; clicking "+ Add agent" elsewhere flips the active tab to
 *  the freshly-created one via the autoFocusId signal. */
function AgentsTabs({
  agents, autoFocusId, defaults, isModified,
  patchAgent, patchCaps, requestRemoveAgent, resetAgent, onAutoFocusConsumed,
}: {
  agents: Agent[];
  autoFocusId: string | null;
  defaults: Agent[];
  isModified: (a: Agent) => boolean;
  patchAgent: (id: string, p: Partial<Agent>) => void;
  patchCaps: (id: string, p: Partial<NonNullable<Agent["capabilities"]>>) => void;
  requestRemoveAgent: (id: string) => void;
  resetAgent: (id: string) => void;
  onAutoFocusConsumed: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Default to first agent; when the list churns (delete current,
  // add new) drift to a sensible neighbor instead of going blank.
  useEffect(() => {
    if (agents.length === 0) { setActiveId(null); return; }
    if (!activeId || !agents.some(a => a.id === activeId)) {
      setActiveId(agents[0].id);
    }
  }, [agents, activeId]);
  // Auto-jump to a freshly added agent so the user lands on its editor.
  useEffect(() => { if (autoFocusId) setActiveId(autoFocusId); }, [autoFocusId]);

  const active = agents.find(a => a.id === activeId) ?? agents[0];
  if (!active) return null;

  return (
    <div className="flex flex-col">
      {/* Tab strip — mirrors the Repository sub-tab style: bottom
          border under inactive tabs, accent underline beneath the
          active one. Keeps the visual language consistent across
          settings pages. */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--color-border-soft)]">
        {agents.map((a, idx) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setActiveId(a.id)}
            className={cn(
              "relative -mb-px flex items-center gap-1.5 py-2 text-[13px] font-medium transition-colors",
              // First tab sits flush with the page edge; everything
              // else gets normal horizontal padding.
              idx === 0 ? "pr-3" : "px-3",
              a.id === active.id
                ? "text-[var(--color-fg)]"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
            )}
          >
            <span className={cn("shrink-0", CLI_BRAND_COLOR[a.icon_id] || "text-[var(--color-fg-dim)]")}>
              <CliIcon cli={a.icon_id} className="h-3.5 w-3.5" />
            </span>
            <span className="truncate max-w-[140px]">{a.display_name || a.id}</span>
            {isModified(a) && (
              <span title="Modified from ship defaults" className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
            )}
            {a.id === active.id && (
              <span className={cn(
                "absolute bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]",
                // First tab: underline hugs the left edge so it lines
                // up with the page gutter; subsequent tabs get the
                // standard inset.
                idx === 0 ? "left-0 right-2" : "inset-x-2",
              )} />
            )}
          </button>
        ))}
      </div>

      {/* Active agent card. Mount-keyed by id so internal state
          (refs, drafts) resets cleanly when the user switches tabs. */}
      <div className="mt-3">
        <AgentCard
          key={active.id}
          agent={active}
          onPatch={(p) => patchAgent(active.id, p)}
          onPatchCaps={(p) => patchCaps(active.id, p)}
          onRemove={() => requestRemoveAgent(active.id)}
          autoFocus={autoFocusId === active.id}
          onAutoFocusConsumed={onAutoFocusConsumed}
          modified={isModified(active)}
          onReset={defaults.find(d => d.id === active.id) ? () => resetAgent(active.id) : undefined}
        />
      </div>
    </div>
  );
}

function AgentCard({ agent, onPatch, onPatchCaps, onRemove, autoFocus, onAutoFocusConsumed, modified, onReset }: {
  agent: Agent;
  onPatch: (p: Partial<Agent>) => void;
  onPatchCaps: (p: Partial<NonNullable<Agent["capabilities"]>>) => void;
  onRemove: () => void;
  /** True for a freshly-created card — scrolls into view + focuses the name
   *  input on mount. */
  autoFocus?: boolean;
  onAutoFocusConsumed?: () => void;
  /** True if any field on this agent differs from its ship default.
   *  Drives the "Modified" badge in the header. */
  modified?: boolean;
  /** Reset this agent to ship defaults. Only provided for built-ins
   *  (custom agents have no defaults to revert to). */
  onReset?: () => void;
}) {
  // The args + yolo_args fields are arrays — edited as space-separated text
  // for ergonomics. We split on whitespace and drop empties on commit.
  const argsText       = (agent.args || []).join(" ");
  const yoloArgsText   = (agent.capabilities?.yolo_args   || []).join(" ");
  const resumeArgsText = (agent.capabilities?.resume_args || []).join(" ");
  const cardRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    // Two RAFs so layout settles before scrolling — otherwise the card might
    // not have its final position yet and the scroll target is stale.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      nameRef.current?.focus();
      nameRef.current?.select();
      onAutoFocusConsumed?.();
    }));
  }, [autoFocus, onAutoFocusConsumed]);

  return (
    <div ref={cardRef} className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-4">
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={cn(CLI_BRAND_COLOR[agent.icon_id] || "text-[var(--color-fg-dim)]")}>
            <CliIcon cli={agent.icon_id} className="h-4 w-4" />
          </span>
          <input
            ref={nameRef}
            value={agent.display_name}
            onChange={(e) => onPatch({ display_name: e.target.value })}
            className="bg-transparent text-[14px] font-semibold outline-none border-b border-transparent focus:border-[var(--color-accent)]"
          />
          <span className="rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] font-mono">{agent.id}</span>
          {agent.builtin && (
            <span className="rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-faint)] uppercase tracking-wider">built-in</span>
          )}
          {modified && (
            <span
              className="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] uppercase tracking-wider"
              title="Some fields differ from this agent's ship defaults. Use Reset to revert."
            >modified</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {modified && onReset && (
            <button
              onClick={() => {
                if (confirm(`Reset ${agent.display_name} to ship defaults?\n\nThis overwrites Command, Default args, YOLO args, Runtime YOLO command, and Resume args.`)) {
                  onReset();
                }
              }}
              className="flex items-center gap-1 rounded p-1.5 text-[12px] text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
              title="Reset this agent to ship defaults"
            ><RotateCcw className="h-3.5 w-3.5" /> Reset</button>
          )}
          {!agent.builtin && (
            <button
              onClick={onRemove}
              className="rounded p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-err)]"
              title="Remove agent"
            ><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3">
        <Field label="Command" hint="Single executable to spawn (PATH lookup or absolute path). No shell parsing - quoted/piped strings won't work, and shell-style `VAR=val cmd` prefixes won't either; use the Environment box below for env vars.">
          <Input value={agent.command} onChange={e => onPatch({ command: e.target.value })} className="font-mono" placeholder="claude" />
        </Field>
        <Field
          label="Default args"
          hint="Always passed. Space-separated. Placeholders: {workspace_slug}, {workspace_name}, {workspace_id}, {branch}, {port}."
        >
          <Input value={argsText}
            onChange={e => onPatch({ args: e.target.value.split(/\s+/).filter(Boolean) })}
            className="font-mono" placeholder="--name {workspace_slug}"
          />
        </Field>
        <Field label="YOLO args" hint="Appended when YOLO mode (⚡) is on. Empty = no flag added.">
          <Input value={yoloArgsText}
            onChange={e => onPatchCaps({ yolo_args: e.target.value.split(/\s+/).filter(Boolean) })}
            className="font-mono" placeholder="--dangerously-skip-permissions"
          />
        </Field>
        <Field label="Runtime YOLO command" hint='Slash-command sent to live PTY when YOLO is toggled. Use {mode} for "yolo" or "default". Empty = no runtime toggle.'>
          <Input value={agent.capabilities?.runtime_yolo_command || ""}
            onChange={e => onPatchCaps({ runtime_yolo_command: e.target.value })}
            className="font-mono" placeholder="/approval-mode {mode}"
          />
        </Field>
        <Field label="Resume args" hint="Appended after the worktree's first spawn so the CLI resumes its own session for that directory. Empty = no auto-resume.">
          <Input value={resumeArgsText}
            onChange={e => onPatchCaps({ resume_args: e.target.value.split(/\s+/).filter(Boolean) })}
            className="font-mono" placeholder="--continue"
          />
        </Field>
        <Field
          label="Environment"
          hint="One KEY=VALUE per line. Merged into the spawn env on top of inherited parent env. Lines starting with # are ignored. Preserved across Reset."
        >
          <EnvTextarea
            value={agent.env ?? {}}
            onChange={(env) => onPatch({ env })}
          />
        </Field>
      </div>
    </div>
  );
}

/** KEY=VAL lines ⇄ Record<string,string>. Edits live in a local draft string
 *  so the user can type incomplete lines without us clobbering or dropping
 *  characters; we only re-parse and bubble up on change. Comments (#) and
 *  blank lines are stripped. Keys without `=` get an empty string value so a
 *  user line like `DEBUG` still parses (rather than disappearing). */
function EnvTextarea({ value, onChange }: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const serialize = (v: Record<string, string>) =>
    Object.entries(v).map(([k, val]) => `${k}=${val}`).join("\n");
  const [draft, setDraft] = useState(serialize(value));
  // Sync down when the parent value changes from outside (reset, tab switch).
  // We compare serialized forms so re-typing the same content doesn't fight
  // the user's cursor position.
  const externalText = serialize(value);
  useEffect(() => {
    if (parseEnv(draft) === externalText) return;
    setDraft(externalText);
  // We intentionally depend on externalText (a string snapshot), NOT on the
  // value object — its identity changes on every patch from the parent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalText]);
  return (
    <textarea
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        onChange(parseEnvToMap(next));
      }}
      spellCheck={false}
      rows={4}
      className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12.5px] text-[var(--color-fg)] focus:border-[var(--color-accent-soft)] focus:outline-none"
      placeholder={"CLAUDE_CODE_NO_FLICKER=1\nHTTPS_PROXY=http://localhost:8080"}
    />
  );
}

/** Parse `KEY=VALUE` lines into a stable map. Order is preserved by insertion
 *  order in the Map → object; duplicate keys: last wins. */
function parseEnvToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) { out[line] = ""; continue; }
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1);
    if (k) out[k] = v;
  }
  return out;
}

/** Serialize for the round-trip equality check above. Sorted-key match
 *  isn't right here because users may care about line order, but the only
 *  caller compares the *serialized form*, so iteration order of the parsed
 *  map vs the externally-sourced map matters. We canonicalize by sorting
 *  keys for the equality check; the textarea itself preserves whatever the
 *  user typed. */
function parseEnv(text: string): string {
  const m = parseEnvToMap(text);
  return Object.keys(m).sort().map(k => `${k}=${m[k]}`).join("\n");
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[13px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 mb-1.5 text-[12px] text-[var(--color-fg-dim)]">{hint}</div>}
      {children}
    </label>
  );
}
