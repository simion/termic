// Settings → Agents. Lets the user edit per-CLI launch commands, default
// args, YOLO flags, and runtime YOLO slash-commands.
//
// Built-in agents (claude/codex/agy/gemini) are editable but not removable —
// removing them would orphan existing workspaces that reference them.
// Saves are debounced (500ms) so typing doesn't hammer the JSON file.

import { useEffect, useRef, useState } from "react";
import { settingsLoad, agentsSave, agentsDefaults } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import type { Agent, CliInfo } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AppDialog } from "@/components/ui/Dialog";
import { Trash2, Plus, Check, AlertTriangle, RotateCcw } from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { cn, slugify } from "@/lib/utils";

export function AgentsSection() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
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
    // Re-probe install status each time this tab opens — the chosen
    // "startup + Settings open" detection cadence.
    useApp.getState().refreshClis();
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
    const stripEnv = (x: Agent) => { const { env: _e, disabled: _d, ...rest } = x; void _e; void _d; return rest; };
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
      message: "Resets the built-in agents (claude, codex, Antigravity, gemini) to their ship-default commands. Custom agents and per-agent env blocks are kept.",
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
    // Mirror into the app store immediately so the CLI pickers + spawn
    // logic see edits (the disabled toggle, command changes) right away,
    // without waiting for the next window-focus loadAll.
    useApp.setState({ agents: next });
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => performSave(next), 500) as unknown as number;
  }

  function patchAgent(id: string, patch: Partial<Agent>) {
    mutate(agents.map(a => a.id === id ? { ...a, ...patch } : a));
  }

  function commitAgentId(id: string, newDisplayName: string) {
    const a = agents.find(x => x.id === id);
    if (!a || a.builtin) return;
    const slug = slugify(newDisplayName);
    if (slug && slug !== id && !agents.some(other => other.id === slug)) {
      mutate(agents.map(x => x.id === id ? { ...x, id: slug } : x));
      setActiveId(slug);
      // Update any workspaces referencing the old ID in the app store
      useApp.setState(s => ({
        workspaces: s.workspaces.map(w => w.cli === id ? { ...w, cli: slug } : w)
      }));
    }
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
      sandbox_allowed_paths: [],
    };
    mutate([...agents, fresh]);
    // Tell that card to scroll-into-view + focus on mount.
    setAutoFocusId(fresh.id);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-[20px] font-medium">Agent CLIs</h1>
        <div className="flex items-center gap-3">
          <div className="text-[12px] text-[var(--color-fg-faint)] min-h-[1em]">
            {status === "saving" && <span>Saving…</span>}
            {status === "saved"  && <span className="flex items-center gap-1 text-[var(--color-ok)]"><Check className="h-3.5 w-3.5" /> Saved</span>}
            {status === "error"  && <span className="text-[var(--color-err)]">Save failed</span>}
          </div>
          <Button variant="ghost" size="sm" onClick={resetAllBuiltins} title="Reset the built-in agents to ship defaults (custom agents kept)">
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
        activeId={activeId}
        setActiveId={setActiveId}
        autoFocusId={autoFocusId}
        defaults={defaults}
        isModified={isModified}
        patchAgent={patchAgent}
        onCommitId={commitAgentId}
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
  agents, activeId, setActiveId, autoFocusId, defaults, isModified,
  patchAgent, onCommitId, patchCaps, requestRemoveAgent, resetAgent, onAutoFocusConsumed,
}: {
  agents: Agent[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  autoFocusId: string | null;
  defaults: Agent[];
  isModified: (a: Agent) => boolean;
  patchAgent: (id: string, p: Partial<Agent>) => void;
  onCommitId: (id: string, newDisplayName: string) => void;
  patchCaps: (id: string, p: Partial<NonNullable<Agent["capabilities"]>>) => void;
  requestRemoveAgent: (id: string) => void;
  resetAgent: (id: string) => void;
  onAutoFocusConsumed: () => void;
}) {
  // PATH-detection results (keyed by agent id) drive the install badge.
  const detectedClis = useApp(s => s.detectedClis);
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
      <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-[var(--color-border-soft)]">
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
          detected={detectedClis[active.id]}
          onPatch={(p) => patchAgent(active.id, p)}
          onCommitId={(newDisplayName) => onCommitId(active.id, newDisplayName)}
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

function AgentCard({ agent, detected, onPatch, onCommitId, onPatchCaps, onRemove, autoFocus, onAutoFocusConsumed, modified, onReset }: {
  agent: Agent;
  /** PATH-detection result for this agent, once `refreshClis` has run.
   *  undefined = not probed yet → no badge. */
  detected?: CliInfo;
  onPatch: (p: Partial<Agent>) => void;
  onCommitId: (newDisplayName: string) => void;
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
  const sessionIdArgsText = (agent.capabilities?.session_id_args || []).join(" ");
  const resumeIdArgsText  = (agent.capabilities?.resume_id_args  || []).join(" ");
  const nameArgsText      = (agent.capabilities?.name_args       || []).join(" ");
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
            onBlur={() => onCommitId(agent.display_name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                nameRef.current?.blur();
              }
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
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
          {/* Install status — from PATH detection (refreshClis). */}
          {detected && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wider",
                detected.found
                  ? "bg-[var(--color-ok)]/15 text-[var(--color-ok)]"
                  : "bg-[var(--color-err)]/15 text-[var(--color-err)]",
              )}
              title={detected.found
                ? `Found: ${detected.path || "on PATH"}${detected.version ? ` (${detected.version})` : ""}`
                : "Not found on PATH. Hidden from the CLI pickers until it's installed (or point Command at an absolute path)."}
            >{detected.found ? "installed" : "not found"}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Force hide/show — disabled agents drop out of every CLI
              picker (worktree popover, New Workspace, Review, + menu)
              but stay editable here and keep working for existing
              workspaces already bound to them. */}
          <span
            onClick={() => onPatch({ disabled: !agent.disabled })}
            className="text-[12.5px] text-[var(--color-fg-dim)] font-medium select-none cursor-pointer hover:text-[var(--color-fg)] transition-colors mr-0.5"
            title={agent.disabled
              ? "Hidden from the CLI pickers. Click to show."
              : "Shown in the CLI pickers. Click to hide."}
          >
            Enable
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={!agent.disabled}
            onClick={() => onPatch({ disabled: !agent.disabled })}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out outline-none mr-1.5 items-center",
              !agent.disabled ? "bg-[var(--color-ok)]" : "bg-[var(--color-bg-3)]"
            )}
            title={agent.disabled
              ? "Hidden from the CLI pickers. Click to show."
              : "Shown in the CLI pickers. Click to hide."}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                !agent.disabled ? "translate-x-4" : "translate-x-0"
              )}
            />
          </button>
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
            className="font-mono" placeholder="--option1 --option2"
          />
        </Field>
        <Field label="YOLO args" hint="Appended when YOLO mode (⚡) is on. Empty = no flag added.">
          <Input value={yoloArgsText}
            onChange={e => onPatchCaps({ yolo_args: e.target.value.split(/\s+/).filter(Boolean) })}
            className="font-mono" placeholder="--dangerously-skip-permissions"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Runtime YOLO command" hint="Slash-command sent to the live agent to switch it into YOLO. Empty = the YOLO toggle needs a respawn.">
            <Input value={agent.capabilities?.runtime_yolo_command || ""}
              onChange={e => onPatchCaps({ runtime_yolo_command: e.target.value })}
              className="font-mono"
            />
          </Field>
          <Field label="Runtime default command" hint="Slash-command sent to switch the live agent back to default (YOLO off). Empty = needs a respawn.">
            <Input value={agent.capabilities?.runtime_default_command || ""}
              onChange={e => onPatchCaps({ runtime_default_command: e.target.value })}
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Resume last (worktrees)" hint="CWD-based resume. Used on every spawn after the first inside a worktree workspace — each worktree has its own dir, so the agent's most-recent CWD session IS this workspace's session. Not used in repo-root workspaces (the shared dir would lasso external sessions; repo-root uses Session/Resume ID args instead).">
          <Input value={resumeArgsText}
            onChange={e => onPatchCaps({ resume_args: e.target.value.split(/\s+/).filter(Boolean) })}
            className="font-mono" placeholder="--continue"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Session ID args (repo-root)" hint="First spawn in a repo-root workspace, mints a termic-owned uuid. Use {UUID}. Empty = no auto-resume in repo-root for this agent.">
            <Input value={sessionIdArgsText}
              onChange={e => onPatchCaps({ session_id_args: e.target.value.split(/\s+/).filter(Boolean) })}
              className="font-mono" placeholder="--session-id {UUID}"
            />
          </Field>
          <Field label="Resume ID args (repo-root)" hint="Every spawn after the first in a repo-root workspace. Resumes the termic-owned uuid (isolates us from external sessions in the same cwd). Use {UUID}.">
            <Input value={resumeIdArgsText}
              onChange={e => onPatchCaps({ resume_id_args: e.target.value.split(/\s+/).filter(Boolean) })}
              className="font-mono" placeholder="--resume {UUID}"
            />
          </Field>
        </div>
        <Field label="Name args" hint="Applied on every spawn. Pins a display name for the session (claude shows it in /resume and the prompt box). Placeholders supported: {WORKSPACE_SLUG}, {WORKSPACE_NAME}, {BRANCH}.">
          <Input value={nameArgsText}
            onChange={e => onPatchCaps({ name_args: e.target.value.split(/\s+/).filter(Boolean) })}
            className="font-mono" placeholder="--name {WORKSPACE_SLUG}"
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
        <Field
          label="Sandbox allowed paths"
          hint="One path per line. $HOME and ~ expand. Joined into every workspace sandbox that uses this agent; workspaces cannot remove them. Reset to defaults restores the shipped list."
        >
          <PathsTextarea
            value={agent.sandbox_allowed_paths ?? []}
            onChange={(sandbox_allowed_paths) => onPatch({ sandbox_allowed_paths })}
            placeholder={"$HOME/.claude\n$HOME/.config/claude\n~/work"}
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
      placeholder={"CLAUDE_CODE_NO_FLICKER=1\nHTTPS_PROXY=http://localhost:8080\nANTHROPIC_API_KEY=sk-ant-..."}
    />
  );
}

/** One-path-per-line textarea. Same draft-state pattern as EnvTextarea so the
 *  user can leave incomplete lines while typing. Trims each line and drops
 *  blanks + `#` comments; otherwise passes through verbatim (no $HOME
 *  expansion here — that happens on the Rust side at sandbox provision). */
function PathsTextarea({ value, onChange, placeholder }: {
  value: string[]; onChange: (next: string[]) => void; placeholder?: string;
}) {
  const serialize = (v: string[]) => v.join("\n");
  const [draft, setDraft] = useState(serialize(value));
  const externalText = serialize(value);
  useEffect(() => {
    if (parsePaths(draft).join("\n") === externalText) return;
    setDraft(externalText);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalText]);
  return (
    <textarea
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parsePaths(e.target.value));
      }}
      spellCheck={false}
      rows={4}
      className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12.5px] text-[var(--color-fg)] focus:border-[var(--color-accent-soft)] focus:outline-none"
      placeholder={placeholder}
    />
  );
}

function parsePaths(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
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
