// Settings → Agents & Terminals. Lets the user edit per-CLI launch commands,
// default args, YOLO flags, and runtime YOLO slash-commands — plus custom
// terminal entries (kind: "terminal", #27): same registry, but they spawn
// through the login shell and the card hides the agent-only fields.
//
// Built-in agents (claude/codex/agy/gemini) are editable but not removable —
// removing them would orphan existing tasks that reference them.
// Saves are debounced (500ms) so typing doesn't hammer the JSON file.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { settingsLoad, agentsSave, agentsDefaults } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import type { Agent, CliInfo } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AppDialog } from "@/components/ui/Dialog";
import { Tip } from "@/components/ui/Tooltip";
import { Trash2, Plus, Check, AlertTriangle, RotateCcw, Copy } from "lucide-react";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { cn, slugify } from "@/lib/utils";
import { isTerminalEntry, BUILTIN_TITLE_SIGNALS } from "@/lib/agents";

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
  // updated default flags (e.g. claude's new `--resume {task_slug}`)
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
      // Update any tasks referencing the old ID in the app store
      useApp.setState(s => ({
        tasks: s.tasks.map(w => w.cli === id ? { ...w, cli: slug } : w)
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

  /** Custom terminal entry (#27): kind "terminal" puts it under the +
   *  menu's "New terminal" section and gives the spawn shell semantics
   *  (login shell wrapping the command line, no agent machinery). */
  function addTerminal() {
    let n = 1;
    while (agents.some(a => a.id === `terminal-${n}`)) n++;
    const fresh: Agent = {
      id: `terminal-${n}`,
      display_name: `New terminal ${n}`,
      command: "",
      args: [],
      icon_id: "lucide:terminal",
      color: "#9aa0a6",
      builtin: false,
      kind: "terminal",
      sandbox_allowed_paths: [],
    };
    mutate([...agents, fresh]);
    setAutoFocusId(fresh.id);
  }

  /** Reorder within the entry's own group (agents or terminals): the strip
   *  renders the two groups separately, so `toGroupIndex` is an index among
   *  same-kind entries. Other-kind entries keep their array positions. */
  function reorderAgent(id: string, toGroupIndex: number) {
    const moved = agents.find(a => a.id === id);
    if (!moved) return;
    const movedTerm = isTerminalEntry(moved);
    const group = agents.filter(a => isTerminalEntry(a) === movedTerm && a.id !== id);
    const clamped = Math.max(0, Math.min(toGroupIndex, group.length));
    group.splice(clamped, 0, moved);
    let gi = 0;
    const next = agents.map(a => (isTerminalEntry(a) === movedTerm ? group[gi++] : a));
    if (next.some((a, i) => a.id !== agents[i].id)) mutate(next);
  }

  function cloneAgent(id: string) {
    const src = agents.find(a => a.id === id);
    if (!src) return;
    // Base the clone id on the source's id; increment suffix until unique.
    let n = 2;
    while (agents.some(a => a.id === `${src.id}-${n}`)) n++;
    const clone: Agent = {
      ...src,
      id: `${src.id}-${n}`,
      display_name: `${src.display_name}-copy`,
      builtin: false,
      extends: src.id,
    };
    mutate([...agents, clone]);
    setAutoFocusId(clone.id);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-[20px] font-medium">Agents & Terminals</h1>
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
          <Button variant="secondary" size="sm" onClick={addTerminal} title="Add a custom terminal: a command line (docker exec, ssh, ...) offered under New terminal in the + tab menu">
            <Plus className="h-3.5 w-3.5" /> Add terminal
          </Button>
        </div>
      </div>

      <p className="text-[13px] text-[var(--color-fg-dim)] -mt-2">
        Customize the command and flags used to launch each agent. Useful when the CLI renames a flag
        (e.g., a future <code className="font-mono">--yolo</code> rename) or you want to point at a
        wrapper script. Built-in agents can be edited but not removed. Custom terminals appear under
        "New terminal" in the + tab menu and run their command line through your login shell
        (handy for devcontainers: <code className="font-mono">docker exec</code>, ssh boxes, REPLs).
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
        cloneAgent={cloneAgent}
        reorderAgent={reorderAgent}
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
            <div className="text-[15px] font-semibold">
              Remove {isTerminalEntry(pendingDelete ?? undefined) ? "terminal" : "agent"}?
            </div>
            <p className="mt-1 text-[13px] text-[var(--color-fg-dim)]">
              <span className="font-mono text-[var(--color-fg)]">{pendingDelete?.display_name}</span>{" "}
              will be removed. Tasks that reference it will fall back to spawning the
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
  patchAgent, onCommitId, patchCaps, requestRemoveAgent, resetAgent, cloneAgent, reorderAgent, onAutoFocusConsumed,
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
  cloneAgent: (id: string) => void;
  reorderAgent: (id: string, toIndex: number) => void;
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

  // Drag-to-reorder — same pointer-based pattern as TabBar (no HTML5 DnD;
  // WKWebView's native drag is unreliable and Tauri intercepts it).
  const stripRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragTx, setDragTx] = useState(0);
  const dragRef = useRef<{
    id: string; grabOffset: number; startX: number; pointerX: number; started: boolean; appliedTx: number;
  } | null>(null);

  function computeTx(clientX: number): number {
    const strip = stripRef.current;
    const d = dragRef.current;
    if (!strip || !d) return 0;
    const pill = strip.querySelector(`[data-agent-id="${CSS.escape(d.id)}"]`) as HTMLElement | null;
    if (!pill) return 0;
    const layoutLeft = pill.getBoundingClientRect().left - d.appliedTx;
    const tx = (clientX - d.grabOffset) - layoutLeft;
    d.appliedTx = tx;
    return tx;
  }

  function maybeReorder(clientX: number) {
    const strip = stripRef.current;
    const d = dragRef.current;
    if (!strip || !d) return;
    const pill = strip.querySelector(`[data-agent-id="${CSS.escape(d.id)}"]`) as HTMLElement | null;
    if (!pill) return;
    const draggedCenter = (clientX - d.grabOffset) + pill.offsetWidth / 2;
    // Reorder within the dragged pill's own group only — agents and
    // terminals render as separate groups, so the target index counts
    // same-kind pills and `reorderAgent` maps it back into the array.
    const movedKind = pill.dataset.kind;
    const pills = Array.from(strip.querySelectorAll<HTMLElement>("[data-agent-id]"));
    let target = 0;
    for (const p of pills) {
      if (p.dataset.agentId === d.id || p.dataset.kind !== movedKind) continue;
      const r = p.getBoundingClientRect();
      if (r.left + r.width / 2 < draggedCenter) target++;
    }
    reorderAgent(d.id, target);
  }

  function onDragPointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    d.pointerX = e.clientX;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < 5) return;
      d.started = true;
      setDragId(d.id);
    }
    setDragTx(computeTx(e.clientX));
    maybeReorder(e.clientX);
  }

  function onDragPointerUp() {
    window.removeEventListener("pointermove", onDragPointerMove);
    window.removeEventListener("pointerup", onDragPointerUp);
    dragRef.current = null;
    setDragId(null);
    setDragTx(0);
  }

  function startDrag(agentId: string, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const pill = e.currentTarget as HTMLElement;
    dragRef.current = {
      id: agentId,
      grabOffset: e.clientX - pill.getBoundingClientRect().left,
      startX: e.clientX,
      pointerX: e.clientX,
      started: false,
      appliedTx: 0,
    };
    window.addEventListener("pointermove", onDragPointerMove);
    window.addEventListener("pointerup", onDragPointerUp);
  }

  useLayoutEffect(() => {
    const d = dragRef.current;
    if (d?.started) setDragTx(computeTx(d.pointerX));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  useEffect(() => () => {
    window.removeEventListener("pointermove", onDragPointerMove);
    window.removeEventListener("pointerup", onDragPointerUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = agents.find(a => a.id === activeId) ?? agents[0];
  if (!active) return null;

  // Grouped display: agents first, then custom terminals (#27). The array
  // itself may interleave the kinds; the strip derives the grouped order
  // and drag-reorder stays within a group (see maybeReorder).
  const agentEntries = agents.filter(a => !isTerminalEntry(a));
  const termEntries = agents.filter(isTerminalEntry);

  const pill = (a: Agent, first: boolean) => (
    <button
      key={a.id}
      type="button"
      data-agent-id={a.id}
      data-kind={isTerminalEntry(a) ? "terminal" : "agent"}
      onClick={() => setActiveId(a.id)}
      onPointerDown={(e) => startDrag(a.id, e)}
      className={cn(
        "relative -mb-px flex items-center gap-1.5 py-2 text-[13px] font-medium transition-colors select-none",
        first ? "pr-3" : "px-3",
        dragId === a.id ? "z-30 opacity-80" : "",
        a.id === active.id
          ? "text-[var(--color-fg)]"
          : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
      )}
      style={dragId === a.id ? { transform: `translateX(${dragTx}px)` } : undefined}
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
          first ? "left-0 right-2" : "inset-x-2",
        )} />
      )}
    </button>
  );

  return (
    <div className="flex flex-col">
      {/* Tab strip — mirrors the Repository sub-tab style: bottom
          border under inactive tabs, accent underline beneath the
          active one. Keeps the visual language consistent across
          settings pages. */}
      <div ref={stripRef} className="flex items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-[var(--color-border-soft)]">
        {agentEntries.map((a, idx) => pill(a, idx === 0))}
        {termEntries.length > 0 && (
          <span className="ml-4 mr-1 shrink-0 select-none text-[10.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
            Terminals
          </span>
        )}
        {termEntries.map(a => pill(a, false))}
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
          onClone={() => cloneAgent(active.id)}
          extendsName={active.extends ? (agents.find(a => a.id === active.extends)?.display_name ?? active.extends) : undefined}
          autoFocus={autoFocusId === active.id}
          onAutoFocusConsumed={onAutoFocusConsumed}
          modified={isModified(active)}
          onReset={defaults.find(d => d.id === active.id) ? () => resetAgent(active.id) : undefined}
        />
      </div>
    </div>
  );
}

function AgentCard({ agent, detected, onPatch, onCommitId, onPatchCaps, onRemove, onClone, extendsName, autoFocus, onAutoFocusConsumed, modified, onReset }: {
  agent: Agent;
  /** PATH-detection result for this agent, once `refreshClis` has run.
   *  undefined = not probed yet → no badge. */
  detected?: CliInfo;
  onPatch: (p: Partial<Agent>) => void;
  onCommitId: (newDisplayName: string) => void;
  onPatchCaps: (p: Partial<NonNullable<Agent["capabilities"]>>) => void;
  onRemove: () => void;
  onClone: () => void;
  /** Display name of the parent agent, if this one was cloned. */
  extendsName?: string;
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
  // The args fields are string[] edited as space-separated text. ArgsInput
  // owns the local draft so spaces survive (#19); it splits + bubbles up the
  // parsed array on each change.
  const nameRef = useRef<HTMLInputElement>(null);
  // Custom terminal entries (#27) hide every agent-only field: YOLO, the
  // runtime toggle commands, resume / session args, name args, and the
  // work-done switch — none of the agent machinery runs for them.
  const isTerminal = isTerminalEntry(agent);

  useEffect(() => {
    if (!autoFocus) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
      onAutoFocusConsumed?.();
    }));
  }, [autoFocus, onAutoFocusConsumed]);

  // Does this agent have any title pattern at all? Gates the output-scan
  // switch, which has nothing to run without one (see the group below).
  const sig = agent.capabilities?.signals;
  const hasSignals = !!(sig?.busy?.length || sig?.idle?.length || sig?.attention?.length);

  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-4">
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
          {isTerminal && (
            <span
              className="rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-faint)] uppercase tracking-wider"
              title="Custom terminal: offered under New terminal in the + tab menu. Runs through your login shell; no agent features (resume, work-done, message queue)."
            >terminal</span>
          )}
          {extendsName && (
            <span
              className="rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] font-mono"
              title={`Cloned from ${extendsName}. All settings inherited at clone time; edit independently.`}
            >extends: {extendsName}</span>
          )}
          {modified && (
            <span
              className="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] uppercase tracking-wider"
              title="Some fields differ from this agent's ship defaults. Use Reset to revert."
            >modified</span>
          )}
          {/* Install status — from PATH detection (refreshClis). Skipped
              for terminals: their command is a free-form shell line that
              `which` can't probe, so the badge would cry wolf. */}
          {!isTerminal && detected && (
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
              picker (worktree popover, New Task, Review, + menu)
              but stay editable here and keep working for existing
              tasks already bound to them. */}
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
                // Track is --color-ok when on, so the knob takes the ok ink,
                // not the accent ink. Off-track is dark in every theme.
                "pointer-events-none inline-block h-4 w-4 transform rounded-full shadow ring-0 transition duration-200 ease-in-out",
                !agent.disabled ? "translate-x-4 bg-[var(--color-ok-fg)]" : "translate-x-0 bg-white"
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
          <Tip content="Clone this agent: copies all settings into a new custom agent you can override independently" side="top">
            <button
              onClick={onClone}
              className="rounded p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
            ><Copy className="h-4 w-4" /></button>
          </Tip>
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
        <Field label="Command" hint={isTerminal
          ? "Run through your login shell (quoting, pipes, and rc-file PATH all work). The shell stays interactive after the command exits. Placeholders: {task_slug}, {task_name}, {task_path}, {branch}, {port}."
          : "Single executable to spawn (PATH lookup or absolute path). No shell parsing - quoted/piped strings won't work, and shell-style `VAR=val cmd` prefixes won't either; use the Environment box below for env vars."}>
          <Input value={agent.command} onChange={e => onPatch({ command: e.target.value })} className="font-mono" placeholder={isTerminal ? "docker exec -it -w {task_path} mybox zsh" : "claude"} />
        </Field>
        <Field
          label="Default args"
          hint={isTerminal
            ? "Appended to the command line above. Space-separated. Same placeholders, including {task_path} (differs between the main repo and each worktree)."
            : "Always passed. Space-separated. Placeholders: {task_slug}, {task_name}, {task_id}, {task_path}, {branch}, {port}."}
        >
          <ArgsInput value={agent.args || []}
            onChange={args => onPatch({ args })}
            className="font-mono" placeholder="--option1 --option2"
          />
        </Field>
        {!isTerminal && <>
        <Field label="YOLO args" hint="Appended when YOLO mode (⚡) is on. Empty = no flag added.">
          <ArgsInput value={agent.capabilities?.yolo_args || []}
            onChange={yolo_args => onPatchCaps({ yolo_args })}
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
        <Field label="Resume last (worktrees)" hint="CWD-based resume. Used on every spawn after the first inside a worktree task (each worktree has its own dir, so the agent's most-recent CWD session IS this task's session). Not used in main-checkout tasks (the shared dir would lasso external sessions; the main checkout uses Session/Resume ID args instead).">
          <ArgsInput value={agent.capabilities?.resume_args || []}
            onChange={resume_args => onPatchCaps({ resume_args })}
            className="font-mono" placeholder="--continue"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Session ID args (main checkout)" hint="First spawn in a main-checkout task, mints a termic-owned uuid. Use {UUID}. Empty = no auto-resume in the main checkout for this agent.">
            <ArgsInput value={agent.capabilities?.session_id_args || []}
              onChange={session_id_args => onPatchCaps({ session_id_args })}
              className="font-mono" placeholder="--session-id {UUID}"
            />
          </Field>
          <Field label="Resume ID args (main checkout)" hint="Every spawn after the first in a main-checkout task. Resumes the termic-owned uuid (isolates us from external sessions in the same cwd). Use {UUID}.">
            <ArgsInput value={agent.capabilities?.resume_id_args || []}
              onChange={resume_id_args => onPatchCaps({ resume_id_args })}
              className="font-mono" placeholder="--resume {UUID}"
            />
          </Field>
        </div>
        <Field label="Name args" hint="Applied on every spawn. Pins a display name for the session (claude shows it in /resume and the prompt box). Placeholders supported: {WORKSPACE_SLUG}, {WORKSPACE_NAME}, {BRANCH}.">
          <ArgsInput value={agent.capabilities?.name_args || []}
            onChange={name_args => onPatchCaps({ name_args })}
            className="font-mono" placeholder="--name {WORKSPACE_SLUG}"
          />
        </Field>
        </>}
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
          hint="One path per line. $HOME and ~ expand. Joined into every task sandbox that uses this agent; tasks cannot remove them. Reset to defaults restores the shipped list."
        >
          <PathsTextarea
            value={agent.sandbox_allowed_paths ?? []}
            onChange={(sandbox_allowed_paths) => onPatch({ sandbox_allowed_paths })}
            placeholder={"$HOME/.claude\n$HOME/.config/claude\n~/work"}
          />
        </Field>
        <Field
          label="Sandbox allowed hosts"
          hint="One host per line; * is a wildcard (e.g. *.mycompany.com). Joined into every task sandbox that uses this agent. This is where 'Allow · per agent' in the activity popover saves hosts."
        >
          <PathsTextarea
            value={agent.sandbox_allowed_hosts ?? []}
            onChange={(sandbox_allowed_hosts) => onPatch({ sandbox_allowed_hosts })}
            placeholder={"*.mycompany.com\nbitbucket.org"}
          />
        </Field>
        {!isTerminal && <Field
          label="Work-done detection"
          hint="When off, the done badge, bell, and OS notification are never shown for this agent. Disable for custom CLIs that emit signals in ways that cause false positives."
        >
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              role="switch"
              aria-checked={agent.work_done !== false}
              onClick={() => onPatch({ work_done: agent.work_done === false ? true : false })}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out outline-none items-center",
                agent.work_done !== false ? "bg-[var(--color-ok)]" : "bg-[var(--color-bg-3)]"
              )}
            >
              <span
                className={cn(
                  // Ok-filled track, so the ok ink (see the toggle above).
                  "pointer-events-none inline-block h-4 w-4 transform rounded-full shadow ring-0 transition duration-200 ease-in-out",
                  agent.work_done !== false ? "translate-x-4 bg-[var(--color-ok-fg)]" : "translate-x-0 bg-white"
                )}
              />
            </button>
            <span className="text-[12.5px] text-[var(--color-fg-dim)] select-none">
              {agent.work_done !== false ? "Enabled" : "Disabled"}
            </span>
          </div>
        </Field>}
        {/* The three pattern lists and the output-scan switch are one feature:
            what a title has to look like for this agent to read as done /
            working / blocked, and where we look for it. Boxed so the switch
            reads as belonging to the patterns above it rather than as another
            loose agent setting, and so the shared explanation is stated once
            instead of on all three fields. */}
        {!isTerminal && agent.work_done !== false &&
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] p-3 space-y-3">
            <div>
              <div className="text-[13px] font-medium">Title signals</div>
              <div className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">{signalGroupHint(agent.id)}</div>
            </div>
            <RegexListField
              label="Done (title → done)"
              hint="Marks the turn finished: blue badge, bell, notification."
              value={agent.capabilities?.signals?.idle ?? []}
              onChange={idle => onPatchCaps({ signals: { ...(agent.capabilities?.signals ?? {}), idle } })}
              placeholder={signalPlaceholder(agent.id, "idle", "Ready\n✓ done\nawaiting input" /* allow-shortcut: example placeholder text, the check mark is illustrative sample content (Orel-approved) */)}
            />
            <RegexListField
              label="Busy (title → working)"
              hint="Marks the agent as working (spinner), and holds off the idle heuristics while it runs."
              value={agent.capabilities?.signals?.busy ?? []}
              onChange={busy => onPatchCaps({ signals: { ...(agent.capabilities?.signals ?? {}), busy } })}
              placeholder={signalPlaceholder(agent.id, "busy", "Working\nThinking\nRunning")}
            />
            <RegexListField
              label="Attention (title → needs you)"
              hint="The agent is blocked on you: bell + attention dot. Wins over the other two."
              value={agent.capabilities?.signals?.attention ?? []}
              onChange={attention => onPatchCaps({ signals: { ...(agent.capabilities?.signals ?? {}), attention } })}
              placeholder={signalPlaceholder(agent.id, "attention", "Action Required\nWaiting for approval")}
            />
            {/* Output matching runs the patterns typed into the fields above,
                and only those: it never falls back to the built-in heuristics,
                because "^\s*✳" describes claude's title, not a line of its
                stdout. So with all three fields empty (every agent's default,
                built-in or custom) the switch has nothing to match and is dead.
                Disabled until there is at least one pattern, rather than
                offering a switch that silently does nothing. */}
            <div className="border-t border-[var(--color-border-soft)] pt-3">
              <Field
                label="Match the patterns above against output too"
                hint={hasSignals
                  ? "The patterns are matched against the terminal title only. Turn this on for a CLI that prints its status to stdout and never sets a title, and every line of output gets tested as well. Costs a little on very chatty agents. Takes effect on the next terminal restart, not on open terminals."
                  : "Nothing to match yet. This scans output for the patterns above, so it needs at least one of them filled in. The built-in title heuristics don't apply here, they describe a title, not a line of output."}
              >
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    role="switch"
                    disabled={!hasSignals}
                    aria-checked={!!agent.capabilities?.match_output}
                    onClick={() => onPatchCaps({ match_output: !agent.capabilities?.match_output })}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out outline-none items-center", /* allow-shortcut: standard toggle switch, matches the Work-done switch above, not a decorative chip (Orel-approved) */
                      hasSignals ? "cursor-pointer" : "cursor-not-allowed opacity-50",
                      hasSignals && agent.capabilities?.match_output ? "bg-[var(--color-ok)]" : "bg-[var(--color-bg-3)]"
                    )}
                  >
                    <span
                      className={cn(
                        "pointer-events-none inline-block h-4 w-4 transform rounded-full shadow ring-0 transition duration-200 ease-in-out", /* allow-shortcut: toggle knob circle, matches the Work-done switch above (Orel-approved) */
                        hasSignals && agent.capabilities?.match_output ? "translate-x-4 bg-[var(--color-ok-fg)]" : "translate-x-0 bg-white"
                      )}
                    />
                  </button>
                  <span className="text-[12.5px] text-[var(--color-fg-dim)] select-none">
                    {!hasSignals ? "No patterns to match"
                      : agent.capabilities?.match_output ? "Title and output"
                      : "Title only"}
                  </span>
                </div>
              </Field>
            </div>
          </div>}
      </div>
    </div>
  );
}

/** Space-separated CLI args ⇄ string[]. Same local-draft pattern as
 *  EnvTextarea / PathsTextarea: edits live in a draft string so a trailing
 *  space (to begin the next arg) survives. Binding straight to
 *  `value.join(" ")` re-joined the array on every keystroke and ate the
 *  space, so only a single arg could ever be entered (#19). Splits on
 *  whitespace and drops empties on the value that bubbles up. */
function ArgsInput({ value, onChange, className, placeholder }: {
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
  placeholder?: string;
}) {
  const serialize = (v: string[]) => v.join(" ");
  const parse = (text: string) => text.split(/\s+/).filter(Boolean);
  const [draft, setDraft] = useState(serialize(value));
  // Sync down only when the parent value changes from OUTSIDE (Reset,
  // switching agents). Compare parsed forms so our own keystrokes — including
  // a pending trailing space — don't trigger a reseed that fights the cursor.
  const externalText = serialize(value);
  useEffect(() => {
    if (parse(draft).join(" ") === externalText) return;
    setDraft(externalText);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalText]);
  return (
    <Input
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange(parse(e.target.value));
      }}
      className={className}
      placeholder={placeholder}
    />
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

/** For an agent that ships title heuristics (claude, codex), the placeholder IS
 *  those heuristics, so an empty field reads as "this is what runs today" and a
 *  user who wants to adjust one has something to copy rather than a guess. The
 *  sources are written to behave identically when pasted in (see
 *  BUILTIN_TITLE_SIGNALS). Everyone else gets illustrative examples. */
function signalPlaceholder(cli: string, key: "busy" | "idle" | "attention", fallback: string): string {
  const builtin = BUILTIN_TITLE_SIGNALS[cli]?.[key];
  return builtin?.length ? builtin.join("\n") : fallback;
}

/** Stated once for the whole group rather than three times, once per field.
 *  The two cases differ in what the greyed text means: live patterns for an
 *  agent that ships heuristics, examples for one that doesn't. */
function signalGroupHint(cli: string): string {
  return BUILTIN_TITLE_SIGNALS[cli]
    ? "How termic reads this agent's state from its terminal title. One regex per line. The greyed patterns are what it uses today; type into ANY of the three fields and they replace all three. When several match, attention wins over busy, and busy over done."
    : "How termic reads this agent's state from its terminal title. One regex per line. The greyed patterns are examples (this agent ships no title heuristics of its own). When several match, attention wins over busy, and busy over done.";
}

/** One-regex-per-line editor for custom work-done signals (issue #68). Reuses
 *  the paths textarea (spaces inside a pattern survive; `#` lines are
 *  comments) and flags any pattern that fails to compile, so a bad regex is
 *  visibly ignored rather than silently dropped. */
function RegexListField({ label, hint, value, onChange, placeholder }: {
  label: string; hint: string; value: string[];
  onChange: (v: string[]) => void; placeholder?: string;
}) {
  const invalid = value.filter(p => {
    try { new RegExp(p); return false; } catch { return true; }
  });
  return (
    <Field label={label} hint={hint}>
      <PathsTextarea value={value} onChange={onChange} placeholder={placeholder} />
      {invalid.length > 0 && (
        <div className="mt-1 font-mono text-[11.5px] text-[var(--color-warn)]">
          Ignored (invalid regex): {invalid.join("   ")}
        </div>
      )}
    </Field>
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
