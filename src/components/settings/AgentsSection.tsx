// Settings → Agents & Terminals. Lets the user edit per-CLI launch commands,
// default args, YOLO flags, and runtime YOLO slash-commands — plus custom
// terminal entries (kind: "terminal", #27): same registry, but they spawn
// through the login shell and the card hides the agent-only fields.
//
// Built-in agents (claude/codex/agy/gemini) are editable but not removable —
// removing them would orphan existing tasks that reference them.
// Saves are debounced (500ms) so typing doesn't hammer the JSON file.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { settingsLoad, agentsSave, agentsDefaults, projectUpdate } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { agentOverrides, resolveAgent } from "@/lib/agents";
import { fitRows, fitMinHeight } from "@/lib/fitRows";
import { AgentHooksBlock } from "./AgentHooksBlock";
import type { Agent, CliInfo } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AppDialog } from "@/components/ui/Dialog";
import { Tip } from "@/components/ui/Tooltip";
import { Trash2, Plus, Check, AlertTriangle, RotateCcw, Copy } from "lucide-react";
import { AgentAccountsRow, AgentAccountsAction } from "@/components/settings/AgentAccountsRow";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { SignalInspector } from "./SignalInspector";
import { cn, slugify } from "@/lib/utils";
import { isTerminalEntry, BUILTIN_TITLE_SIGNALS, builtinBaseId, yoloArgsNote } from "@/lib/agents";
import { SubSection } from "@/components/settings/SubSection";
import { Toggle } from "@/components/settings/Controls";
import { usePrefs } from "@/store/prefs";
import { footerReports } from "@/lib/agentContext";

export function AgentsSection() {
  const { t } = useTranslation("settings");
  const terminalCopyOnSelect = usePrefs(s => s.terminalCopyOnSelect);
  const setTerminalCopyOnSelect = usePrefs(s => s.setTerminalCopyOnSelect);
  const [agents, setAgents] = useState<Agent[]>([]);
  // Drives whether the Docker-only environment field is offered at all.
  // Read from the same settings load the agent list comes from.
  const [dockerSandboxOn, setDockerSandboxOn] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const savedFlashTimer = useRef<number | null>(null);
  // id of an agent that just got created — its card uses this to scroll into
  // view and focus its name input on mount. Cleared after one use.
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  // Deep link: `openSettings("agents", undefined, "<agent id>")` selects that
  // agent's card. The footer's usage popover uses it, because "add a second
  // account" landing on Settings with SOME OTHER agent selected sends the user
  // hunting for the one they were just looking at.
  const settingsHighlight = useApp(s => s.view.settingsHighlight);
  const clearSettingsHighlight = useApp(s => s.clearSettingsHighlight);
  useEffect(() => {
    if (!settingsHighlight) return;
    const [agentId, intent] = settingsHighlight.split(":");
    if (!agents.some(a => a.id === agentId)) return; // wait for the list
    if (intent) {
      // `"<id>:accounts"` only SELECTS here. `autoFocusId` is the
      // freshly-created-agent signal and focuses the name input, which is how
      // this deep link ended up highlighting the agent's name instead of the
      // thing the user asked for. The card consumes the intent itself and
      // opens the add form.
      setActiveId(agentId);
    } else {
      setAutoFocusId(agentId);
      clearSettingsHighlight();
    }
  }, [settingsHighlight, clearSettingsHighlight, agents]);
  // Pending-delete confirmation. null = closed.
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);
  // Projects that name the pending-delete agent as their default CLI. They
  // get repointed on confirm, and the dialog says so first.
  const projects = useApp(s => s.projects);
  const pinnedProjects = pendingDelete
    ? projects.filter(p => p.default_cli === pendingDelete.id)
    : [];
  // Ship-time defaults, fetched from Rust. Used to compute "modified"
  // indicators + drive the reset-to-defaults action so users can pick up
  // updated default flags (e.g. claude's new `--resume {task_slug}`)
  // without losing their other customizations.
  const [defaults, setDefaults] = useState<Agent[]>([]);

  useEffect(() => {
    settingsLoad().then(s => {
      setDockerSandboxOn(!!s.docker_sandbox_enabled);
      return s;
    }).then(s => setAgents(s.agents || [])).catch(e => setErr(String(e)));
    agentsDefaults().then(setDefaults).catch(() => {});
    // Re-probe install status each time this tab opens — the chosen
    // "startup + Settings open" detection cadence.
    useApp.getState().refreshClis();
  }, []);

  /** The fields a reset must CARRY OVER, and that must not count as a
   *  modification.
   *
   *  None of them describe how the agent runs, which is what "defaults" and
   *  "modified" are about:
   *
   *  - `env` is a personal setup detail (`CLAUDE_CODE_NO_FLICKER=1`).
   *  - the ACCOUNT fields are user DATA (GH #278). They name real login
   *    stores on disk, so wiping them on a reset orphans directories the user
   *    signed into and silently drops the agent back to one login. Naming a
   *    credential set is also not a change to the agent's command shape, so
   *    it must not light up the "modified" badge or arm a Reset button that
   *    would then destroy it.
   */
  function carriedOver(a: Agent): Partial<Agent> {
    return {
      env: a.env ?? {},
      accounts: a.accounts,
      default_account: a.default_account,
      adopted_account: a.adopted_account,
      auto_switch_account: a.auto_switch_account,
    };
  }

  /** True if any field on the agent differs from its ship-time default.
   *  Used to gate the "Reset to defaults" button per agent so it's only
   *  shown when there's actually something to reset. `carriedOver` fields are
   *  excluded from the comparison, for the reasons documented there. */
  function isModified(a: Agent): boolean {
    const d = defaults.find(d => d.id === a.id);
    if (!d) return false; // custom agents have no "defaults" to revert to
    const strip = (x: Agent) => {
      const {
        env: _e, disabled: _d,
        accounts: _acc, default_account: _da, adopted_account: _aa,
        auto_switch_account: _as, ...rest
      } = x;
      void _e; void _d; void _acc; void _da; void _aa; void _as;
      return rest;
    };
    return JSON.stringify(strip(d)) !== JSON.stringify(strip(a));
  }

  /** Reset one agent to its ship-time defaults (preserves display_name +
   *  ordering AND everything `carriedOver` names). Custom agents (no matching
   *  default id) are no-op. */
  function resetAgent(id: string) {
    const d = defaults.find(d => d.id === id);
    if (!d) return;
    mutate(agents.map(a => a.id === id ? { ...d, ...carriedOver(a) } : a));
  }

  /** Reset every built-in to ship defaults; preserves custom agents the
   *  user added AND everything `carriedOver` names. */
  async function resetAllBuiltins() {
    const ok = await useUI.getState().askConfirm({
      title: t("agents.resetAllTitle"),
      message: t("agents.resetAllMessage"),
      confirmLabel: t("agents.resetBuiltins"),
    });
    if (!ok) return;
    const next = agents.map(a => {
      const d = defaults.find(d => d.id === a.id);
      return d ? { ...d, ...carriedOver(a) } : a;
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
      // ...and any PROJECT pinned to it as its default CLI. A default left
      // pointing at an id that no longer exists is not inert: new tasks fall
      // back to whatever the picker lands on, which is how a project ends up
      // silently defaulting to an agent nobody chose.
      void repointProjectDefaults(id, slug);
    }
  }

  /** Move every project whose default CLI is `from` onto `to`, persisted.
   *  Called when an agent's id changes with its name, and when one is
   *  removed (where `to` is the fallback pick). */
  async function repointProjectDefaults(from: string, to: string) {
    const affected = useApp.getState().projects.filter(p => p.default_cli === from);
    if (affected.length === 0) return;
    try {
      for (const p of affected) await projectUpdate({ ...p, default_cli: to });
      // Mirror into the store by hand rather than calling loadAll(): this
      // page's own registry edit is still sitting in the 500ms debounce, and
      // a full reload would pull the PRE-edit agents back out of settings.json
      // and undo the rename we are repointing to.
      useApp.setState(s => ({
        projects: s.projects.map(p => p.default_cli === from ? { ...p, default_cli: to } : p),
      }));
    } catch (e) { setErr(String(e)); }
  }

  /** What a project pinned to `id` should fall back to once `id` is gone:
   *  the first remaining enabled agent, or the plain shell if the registry
   *  is left with none. */
  function fallbackCli(id: string): string {
    const next = agents.find(a => a.id !== id && !a.disabled && !isTerminalEntry(a));
    return next?.id ?? "shell";
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
    const gone = pendingDelete.id;
    mutate(agents.filter(x => x.id !== gone));
    void repointProjectDefaults(gone, fallbackCli(gone));
    setPendingDelete(null);
  }
  function addAgent() {
    // Find a unique id "custom-N".
    let n = 1;
    while (agents.some(a => a.id === `custom-${n}`)) n++;
    const fresh: Agent = {
      id: `custom-${n}`,
      display_name: t("agents.newAgentName", { n }),
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
      display_name: t("agents.newTerminalName", { n }),
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

  /** Drop every override so the clone inherits its parent again, live.
   *
   *  The escape hatch for a clone made before agents inherited rather than
   *  copied: those carry a full snapshot of the parent taken at creation, and
   *  every one of those fields is now indistinguishable from a deliberate
   *  override. One button beats asking someone to clear seventeen fields by
   *  hand and guess which ones they meant.
   *
   *  Identity is kept: id, display name, what it extends, and whether it is
   *  hidden are the clone's own and are not overrides of anything.
   */
  function resetOverrides(id: string) {
    const src = agents.find(a => a.id === id);
    if (!src?.extends) return;
    const bare = {
      id: src.id,
      display_name: src.display_name,
      extends: src.extends,
      builtin: false,
      disabled: src.disabled,
      kind: src.kind,
      work_done: true,
      command: "", args: [], icon_id: "", color: "",
      // Same rule as `resetAgent`: this rebuilds the entry from scratch, and
      // the account fields are user DATA naming real login stores. Dropping
      // them here would orphan a clone's credential sets exactly as the
      // built-in reset used to.
      ...carriedOver(src),
    } as Agent;
    mutate(agents.map(a => (a.id === id ? bare : a)));
  }

  function cloneAgent(id: string) {
    const src = agents.find(a => a.id === id);
    if (!src) return;
    // Base the clone id on the source's id; increment suffix until unique.
    let n = 2;
    while (agents.some(a => a.id === `${src.id}-${n}`)) n++;
    // SPARSE, not a copy. Every field left empty resolves through `extends` at
    // read time (`resolveAgent`), so the clone tracks its parent: when a vendor
    // renames a flag the built-in entry moves with the app and the clone moves
    // with it. A copy is a snapshot that rots, and this one had already rotted
    // in the field, carrying the parent's literal `$HOME/.claude` sandbox
    // paths while its own config lived elsewhere, so the cage denied it its
    // own login.
    //
    // Only identity is the clone's own. `kind` and `disabled` are structural
    // rather than inherited values, and `work_done` stays on so a fresh clone
    // behaves like the agent it came from.
    const clone: Agent = {
      id: `${src.id}-${n}`,
      display_name: `${src.display_name}-copy`,
      command: "",
      args: [],
      icon_id: "",
      color: "",
      builtin: false,
      kind: src.kind,
      work_done: true,
      extends: src.id,
    } as Agent;
    mutate([...agents, clone]);
    setAutoFocusId(clone.id);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-[20px] font-medium">{t("rail.agents")}</h1>
        <div className="flex items-center gap-3">
          <div className="text-[12px] text-[var(--color-fg-faint)] min-h-[1em]">
            {status === "saving" && <span>{t("common:saving")}</span>}
            {status === "saved"  && <span className="flex items-center gap-1 text-[var(--color-ok)]"><Check className="h-3.5 w-3.5" /> {t("shared.saved")}</span>}
            {status === "error"  && <span className="text-[var(--color-err)]">{t("shared.saveFailed")}</span>}
          </div>
          <Button variant="ghost" size="sm" onClick={resetAllBuiltins} title={t("agents.resetBuiltinsTip")}>
            <RotateCcw className="h-3.5 w-3.5" /> {t("agents.resetBuiltins")}
          </Button>
          <Button variant="secondary" size="sm" onClick={addAgent}>
            <Plus className="h-3.5 w-3.5" /> {t("agents.addAgent")}
          </Button>
          <Button variant="secondary" size="sm" onClick={addTerminal} title={t("agents.addTerminalTip")}>
            <Plus className="h-3.5 w-3.5" /> {t("agents.addTerminal")}
          </Button>
        </div>
      </div>

      <p className="text-[13px] text-[var(--color-fg-dim)] -mt-2">
        <Trans
          t={t}
          i18nKey="agents.intro"
          components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
        />
      </p>

      {err && <div className="text-[13px] text-[var(--color-err)]">{err}</div>}

      {/* Above the per-agent tabs, because it is one decision across all of
          them rather than a field on any one card, and because it belongs on
          this page at all: it writes into the AGENT's own config and changes
          how that agent reports its state.
          It lived under Notifications first, on the reasoning that the
          indicators there are all downstream of work-state detection. True,
          and beside the point: Notifications is where you choose whether to be
          TOLD, not how termic KNOWS. The tell was that placing it there
          required a signpost on this page pointing at it, and a cross
          reference is usually evidence the thing is in the wrong place. */}
      <AgentHooksBlock />

      <AgentsTabs
        agents={agents}
        activeId={activeId}
        setActiveId={setActiveId}
        autoFocusId={autoFocusId}
        defaults={defaults}
        isModified={isModified}
        patchAgent={patchAgent}
        dockerSandboxOn={dockerSandboxOn}
        onCommitId={commitAgentId}
        patchCaps={patchCaps}
        requestRemoveAgent={requestRemoveAgent}
        resetAgent={resetAgent}
        cloneAgent={cloneAgent}
        resetOverrides={resetOverrides}
        reorderAgent={reorderAgent}
        onAutoFocusConsumed={() => setAutoFocusId(null)}
      />

      {/* Settings that apply to every terminal rather than to one registry
          entry. "Copy on select" lived in General until the settings split;
          it is terminal behavior, so it belongs on this page. */}
      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <h2 className="mb-4 text-[15px] font-medium">{t("agents.allTerminals")}</h2>
        <Toggle
          label={t("agents.copyOnSelect.label")}
          hint={t("agents.copyOnSelect.hint")}
          value={terminalCopyOnSelect}
          onChange={setTerminalCopyOnSelect}
        />
      </div>

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
              {t(isTerminalEntry(pendingDelete ?? undefined) ? "agents.removeTerminalTitle" : "agents.removeAgentTitle")}
            </div>
            <p className="mt-1 text-[13px] text-[var(--color-fg-dim)]">
              <Trans
                t={t}
                i18nKey="agents.removeBody"
                values={{ name: pendingDelete?.display_name, command: pendingDelete?.command || "(empty)" }}
                components={{
                  1: <span className="font-mono text-[var(--color-fg)]" />,
                  3: <span className="font-mono text-[var(--color-fg)]" />,
                }}
              />
            </p>
            {/* A project pinned to this agent has to land somewhere: say
                where, here, rather than letting it silently default to
                whatever the picker offers first. */}
            {pinnedProjects.length > 0 && (
              <p className="mt-1 text-[13px] text-[var(--color-fg-dim)]">
                {pinnedProjects.length === 1
                  ? <Trans
                      t={t}
                      i18nKey="agents.pinnedOne"
                      values={{
                        name: pinnedProjects[0].name,
                        fallback: pendingDelete
                          ? (agents.find(a => a.id === fallbackCli(pendingDelete.id))?.display_name ?? "Terminal")
                          : "",
                      }}
                      components={{
                        1: <span className="font-mono text-[var(--color-fg)]" />,
                        3: <span className="font-mono text-[var(--color-fg)]" />,
                      }}
                    />
                  : <Trans
                      t={t}
                      i18nKey="agents.pinnedMany"
                      count={pinnedProjects.length}
                      values={{
                        fallback: pendingDelete
                          ? (agents.find(a => a.id === fallbackCli(pendingDelete.id))?.display_name ?? "Terminal")
                          : "",
                      }}
                      components={{ 1: <span className="font-mono text-[var(--color-fg)]" /> }}
                    />}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPendingDelete(null)}>{t("common:cancel")}</Button>
          <Button variant="danger" onClick={confirmRemoveAgent}>
            <Trash2 className="h-3.5 w-3.5" /> {t("common:remove")}
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
  patchAgent, onCommitId, patchCaps, requestRemoveAgent, resetAgent, cloneAgent, resetOverrides, reorderAgent, onAutoFocusConsumed,
  dockerSandboxOn,
}: {
  /** App-wide Docker sandbox switch; gates the Docker-only env field. */
  dockerSandboxOn?: boolean;
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
  resetOverrides: (id: string) => void;
  inherited?: Agent;
  reorderAgent: (id: string, toIndex: number) => void;
  onAutoFocusConsumed: () => void;
}) {
  const { t } = useTranslation("settings");
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
  // Waits for the agent to EXIST. A deep link is applied before the async
  // agent load finishes, and the effect above then resets the selection to
  // `agents[0]` the moment the list arrives, landing the user on the wrong
  // card. Depending on `agents` re-applies it once the target is really there.
  useEffect(() => {
    if (autoFocusId && agents.some(a => a.id === autoFocusId)) setActiveId(autoFocusId);
  }, [autoFocusId, agents]);

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
  /** A clone leaves `icon_id` empty and inherits its parent's, so reading it
   *  raw showed the generic terminal glyph for what is visibly a claude agent. */
  const iconOf = (a: Agent) => a.icon_id || resolveAgent(agents, a.id)?.icon_id || "";
  /** The parent as it resolves TODAY: what every empty field on this card is
   *  actually using. Drives the banner and the placeholders. */
  const inherited = active?.extends ? resolveAgent(agents, active.extends) : undefined;
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
      {/* Resolved: a clone leaves icon_id empty and inherits its parent's, so
          reading it raw showed the generic terminal glyph for what is visibly
          a claude agent. `data-icon-id` is the DOM hook for that: it is the
          user-visible consequence of inheritance, so a spec can assert it
          without reaching into the store for the resolver. */}
      <span
        data-icon-id={resolveIconId(a.id, agents)}
        className={cn("shrink-0", CLI_BRAND_COLOR[resolveIconId(a.id, agents)] || "text-[var(--color-fg-dim)]")}
      >
        <CliIcon cli={resolveIconId(a.id, agents)} className="h-3.5 w-3.5" />
      </span>
      <span className="truncate max-w-[140px]">{a.display_name || a.id}</span>
      {isModified(a) && (
        <span title={t("agents.card.modifiedTip")} className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
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
            {t("agents.terminalsGroup")}
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
          dockerSandboxOn={dockerSandboxOn}
          onCommitId={(newDisplayName) => onCommitId(active.id, newDisplayName)}
          onPatchCaps={(p) => patchCaps(active.id, p)}
          onRemove={() => requestRemoveAgent(active.id)}
          onClone={() => cloneAgent(active.id)}
          extendsName={active.extends ? (agents.find(a => a.id === active.extends)?.display_name ?? active.extends) : undefined}
          overrideCount={agentOverrides(agents, active.id).length}
          inherited={inherited}
          yoloNote={yoloArgsNote(builtinBaseId(active.id, agents))}
          resetOverrides={resetOverrides}
          autoFocus={autoFocusId === active.id}
          onAutoFocusConsumed={onAutoFocusConsumed}
          modified={isModified(active)}
          onReset={defaults.find(d => d.id === active.id) ? () => resetAgent(active.id) : undefined}
        />
      </div>
    </div>
  );
}

function AgentCard({ agent, detected, onPatch, onCommitId, onPatchCaps, onRemove, onClone, extendsName, overrideCount, resetOverrides, inherited, autoFocus, onAutoFocusConsumed, modified, onReset, dockerSandboxOn, yoloNote }: {
  agent: Agent;
  /** Whether Docker sandboxing is enabled app-wide; gates the Docker-only
   *  environment field, which does nothing while it is off. */
  dockerSandboxOn?: boolean;
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
  /** Number of fields this clone overrides; 0 means it inherits everything. */
  overrideCount: number;
  resetOverrides: (id: string) => void;
  /** The parent as it resolves TODAY: what every empty field here uses. */
  inherited?: Agent;
  /** Agent-specific caveat appended to the YOLO args hint, when this agent's
   *  built-in base has one (`YOLO_ARGS_NOTES`). */
  yoloNote?: string;
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
  // Bumped when the header names the FIRST credential set, so the row below
  // (which fetches on mount) appears instead of staying empty until the card
  // is reopened.
  const { t } = useTranslation("settings");
  const [accountsNonce, setAccountsNonce] = useState(0);
  // The header button opens the add form, which renders in the BODY row. Held
  // here because the two are siblings: an input in the header pushed the
  // badges onto a second line and made the strip look broken.
  const [addingAccount, setAddingAccount] = useState(false);
  // Arrived from the footer's "Add another account..." row, which deep-links
  // `"<agent id>:accounts"`. Open the FORM rather than focusing the button:
  // the user already pressed a button that said this, and making them press a
  // second one that says the same thing is a step for nothing.
  const accountHighlight = useApp(s => s.view.settingsHighlight);
  const clearHighlight = useApp(s => s.clearSettingsHighlight);
  useEffect(() => {
    if (accountHighlight !== `${agent.id}:accounts`) return;
    setAddingAccount(true);
    clearHighlight();
  }, [accountHighlight, agent.id, clearHighlight]);
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
  const hasSignals = !!(sig?.busy?.length || sig?.idle?.length || sig?.attention?.length || sig?.pending?.length);

  return (
    // data-agent-card: every card renders the same control labels, so e2e (and
    // anything else reaching in) needs a way to scope to one agent.
    <div data-agent-card={agent.id} className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-4">
      {/* `flex-wrap` + `gap-y`: with several badges and a narrow window the
          strip WRAPS AS A WHOLE rather than letting each badge break its own
          text onto two lines, which is what doubled the header height and put
          "BUILT-IN" over two rows. */}
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={cn(CLI_BRAND_COLOR[agent.icon_id || inherited?.icon_id || agent.id] || "text-[var(--color-fg-dim)]")}>
            <CliIcon cli={agent.icon_id || inherited?.icon_id || agent.id} className="h-4 w-4" />
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
          <span className="shrink-0 whitespace-nowrap rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] font-mono">{agent.id}</span>
          {agent.builtin && (
            <span className="shrink-0 whitespace-nowrap rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-faint)] uppercase tracking-wider">{t("agents.card.builtInBadge")}</span>
          )}
          {isTerminal && (
            <span
              className="shrink-0 whitespace-nowrap rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-faint)] uppercase tracking-wider"
              title={t("agents.card.terminalBadgeTip")}
            >{t("agents.card.terminalBadge")}</span>
          )}
          {extendsName && (
            <span
              className="shrink-0 whitespace-nowrap rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] font-mono"
              title={overrideCount
                ? t("agents.card.inheritsSomeTip", { name: extendsName, count: overrideCount })
                : t("agents.card.inheritsAllTip", { name: extendsName })}
            >{t("agents.card.extendsBadge", { name: extendsName })}</span>
          )}
          {/* The count is the honest summary of a clone: which of its fields
              are ITS OWN, and therefore frozen against the parent. Everything
              else tracks the parent as the app updates, which is the whole
              point of inheriting rather than copying. */}
          {extendsName && overrideCount > 0 && (
            <button
              type="button"
              data-testid="reset-overrides"
              onClick={() => resetOverrides(agent.id)}
              className="shrink-0 whitespace-nowrap rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25"
              title={t("agents.card.overridesResetTip", { count: overrideCount, name: extendsName })}
            >{t("agents.card.overridesReset", { count: overrideCount })}</button>
          )}
          {modified && (
            <span
              className="shrink-0 whitespace-nowrap rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] uppercase tracking-wider"
              title={t("agents.card.modifiedBadgeTip")}
            >{t("agents.card.modifiedBadge")}</span>
          )}
          {/* Install status — from PATH detection (refreshClis). Skipped
              for terminals: their command is a free-form shell line that
              `which` can't probe, so the badge would cry wolf. */}
          {!isTerminal && detected && (
            <span
              className={cn(
                "shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wider",
                detected.found
                  ? "bg-[var(--color-ok)]/15 text-[var(--color-ok)]"
                  : "bg-[var(--color-err)]/15 text-[var(--color-err)]",
              )}
              title={detected.found
                ? t("agents.card.foundTip", { path: `${detected.path || t("agents.card.onPath")}${detected.version ? ` (${detected.version})` : ""}` })
                : t("agents.card.notFoundTip")}
            >{detected.found ? t("agents.card.installedBadge") : t("agents.card.notFoundBadge")}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Credentials (GH #278). In the HEADER while dormant rather than in
              a row of its own: almost every install has one login for ever,
              and a full row for that costs space above the fields people came
              to edit. Once a set is named the row below takes over. */}
          <AgentAccountsAction
            agentId={agent.id}
            nonce={accountsNonce}
            onStartAdd={() => setAddingAccount(true)}
          />
          {/* Force hide/show — disabled agents drop out of every CLI
              picker (worktree popover, New Task, Review, + menu)
              but stay editable here and keep working for existing
              tasks already bound to them. */}
          <span
            onClick={() => onPatch({ disabled: !agent.disabled })}
            className="text-[12.5px] text-[var(--color-fg-dim)] font-medium select-none cursor-pointer hover:text-[var(--color-fg)] transition-colors mr-0.5"
            title={agent.disabled
              ? t("agents.card.hideTip")
              : t("agents.card.showTip")}
          >
            {t("common:enable")}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={!agent.disabled}
            onClick={() => onPatch({ disabled: !agent.disabled })}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out mr-1.5 items-center",
              !agent.disabled ? "bg-[var(--color-ok)]" : "bg-[var(--color-bg-3)]"
            )}
            title={agent.disabled
              ? t("agents.card.hideTip")
              : t("agents.card.showTip")}
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
                if (confirm(t("agents.card.resetConfirm", { name: agent.display_name }))) {
                  onReset();
                }
              }}
              className="flex items-center gap-1 rounded p-1.5 text-[12px] text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
              title={t("agents.card.resetTip")}
            ><RotateCcw className="h-3.5 w-3.5" /> {t("common:reset")}</button>
          )}
          <Tip content={t("agents.card.cloneTip")} side="top">
            <button
              data-testid="clone-agent"
              onClick={onClone}
              className="rounded p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
            ><Copy className="h-4 w-4" /></button>
          </Tip>
          {!agent.builtin && (
            <button
              onClick={onRemove}
              className="rounded p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-err)]"
              title={t("agents.card.removeTip")}
            ><Trash2 className="h-4 w-4" /></button>
          )}
        </div>
      </header>

      {/* Credentials first (GH #278): "who is this signed in as" reads before
          "how does it run", and this is the only place a user with one login
          discovers a second is possible. */}
      <AgentAccountsRow
        agentId={agent.id}
        nonce={accountsNonce}
        adding={addingAccount}
        onDoneAdding={() => { setAddingAccount(false); setAccountsNonce(n => n + 1); }}
        onEmptied={() => setAccountsNonce(n => n + 1)}
      />

      {/* Said ONCE, at the top, before the reader meets a column of empty
          boxes. Without it a clone reads as unconfigured rather than
          inherited, which is the opposite of what those blanks mean. */}
      {extendsName && (
        <div className="mt-3 mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-3)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
          <Trans
            t={t}
            i18nKey="agents.card.inheritBanner"
            values={{ name: extendsName }}
            components={{ 1: <b /> }}
          />
          {overrideCount > 0 && (
            <>{t("agents.card.inheritBannerCount", { count: overrideCount })}</>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {!isTerminal && <FooterReadouts agentId={agent.id} />}
        <Field label={t("agents.card.commandLabel")} hint={isTerminal
          ? t("agents.card.commandHintTerminal")
          : t("agents.card.commandHintAgent")}>
          <Input value={agent.command} onChange={e => onPatch({ command: e.target.value })} className="font-mono" placeholder={isTerminal ? "docker exec -it -w {task_path} mybox zsh" : "claude"} />
        </Field>
        <Field
          label={t("agents.card.defaultArgsLabel")}
          hint={isTerminal
            ? t("agents.card.defaultArgsHintTerminal")
            : t("agents.card.defaultArgsHintAgent")}
        >
          <ArgsInput value={agent.args || []}
            onChange={args => onPatch({ args })}
            className="font-mono" placeholder={inheritedPlaceholder(inherited, a => a.args, "--option1 --option2")}
          />
        </Field>
        {!isTerminal && <>
        <Field label={t("agents.card.yoloLabel")} hint={t("agents.card.yoloHint") + (yoloNote ? " " + yoloNote : "")}>
          <ArgsInput value={agent.capabilities?.yolo_args || []}
            onChange={yolo_args => onPatchCaps({ yolo_args })}
            className="font-mono" placeholder={inheritedPlaceholder(inherited, a => a.capabilities?.yolo_args, "--dangerously-skip-permissions")}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("agents.card.runtimeYoloLabel")} hint={t("agents.card.runtimeYoloHint")}>
            <Input value={agent.capabilities?.runtime_yolo_command || ""}
              onChange={e => onPatchCaps({ runtime_yolo_command: e.target.value })}
              className="font-mono"
            />
          </Field>
          <Field label={t("agents.card.runtimeDefaultLabel")} hint={t("agents.card.runtimeDefaultHint")}>
            <Input value={agent.capabilities?.runtime_default_command || ""}
              onChange={e => onPatchCaps({ runtime_default_command: e.target.value })}
              className="font-mono"
            />
          </Field>
        </div>
        <Field label={t("agents.card.resumeLabel")} hint={t("agents.card.resumeHint")}>
          <ArgsInput value={agent.capabilities?.resume_args || []}
            onChange={resume_args => onPatchCaps({ resume_args })}
            className="font-mono" placeholder={inheritedPlaceholder(inherited, a => a.capabilities?.resume_args, "--continue")}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("agents.card.sessionIdLabel")} hint={t("agents.card.sessionIdHint")}>
            <ArgsInput value={agent.capabilities?.session_id_args || []}
              onChange={session_id_args => onPatchCaps({ session_id_args })}
              className="font-mono" placeholder={inheritedPlaceholder(inherited, a => a.capabilities?.session_id_args, "--session-id {UUID}")}
            />
          </Field>
          <Field label={t("agents.card.resumeIdLabel")} hint={t("agents.card.resumeIdHint")}>
            <ArgsInput value={agent.capabilities?.resume_id_args || []}
              onChange={resume_id_args => onPatchCaps({ resume_id_args })}
              className="font-mono" placeholder={inheritedPlaceholder(inherited, a => a.capabilities?.resume_id_args, "--resume {UUID}")}
            />
          </Field>
        </div>
        <Field label={t("agents.card.resumePickerLabel")} hint={t("agents.card.resumePickerHint")}>
          <ArgsInput value={agent.capabilities?.resume_picker_args || []}
            onChange={resume_picker_args => onPatchCaps({ resume_picker_args })}
            className="font-mono" placeholder={inheritedPlaceholder(inherited, a => a.capabilities?.resume_picker_args, "--resume")}
          />
        </Field>
        <Field label={t("agents.card.nameArgsLabel")} hint={t("agents.card.nameArgsHint")}>
          <ArgsInput value={agent.capabilities?.name_args || []}
            onChange={name_args => onPatchCaps({ name_args })}
            className="font-mono" placeholder={inheritedPlaceholder(inherited, a => a.capabilities?.name_args, "--name {WORKSPACE_SLUG}")}
          />
        </Field>
        </>}
        <Field
          label={t("agents.card.envLabel")}
          hint={t("agents.card.envHint")}
        >
          <EnvTextarea
            value={agent.env ?? {}}
            onChange={(env) => onPatch({ env })}
          />
        </Field>
        {/* Docker-only environment. Hidden entirely while Docker sandboxing
            is off, because it would be a box that provably does nothing:
            the field is read on the Docker spawn path and nowhere else. */}
        {dockerSandboxOn && (
          <Field
            label={t("agents.card.dockerEnvLabel")}
            hint={t("agents.card.dockerEnvHint")}
          >
            <EnvTextarea
              value={agent.docker_env ?? {}}
              onChange={(docker_env) => onPatch({ docker_env })}
            />
          </Field>
        )}
        <Field
          label={t("agents.card.sandboxPathsLabel")}
          hint={t("agents.card.sandboxPathsHint")}
        >
          <PathsTextarea
            value={agent.sandbox_allowed_paths ?? []}
            onChange={(sandbox_allowed_paths) => onPatch({ sandbox_allowed_paths })}
            placeholder={inheritedPlaceholder(inherited, a => a.sandbox_allowed_paths, "$HOME/.claude\n$HOME/.config/claude\n~/work", "\n")}
          />
        </Field>
        <Field
          label={t("agents.card.sandboxHostsLabel")}
          hint={t("agents.card.sandboxHostsHint")}
        >
          <PathsTextarea
            value={agent.sandbox_allowed_hosts ?? []}
            onChange={(sandbox_allowed_hosts) => onPatch({ sandbox_allowed_hosts })}
            placeholder={inheritedPlaceholder(inherited, a => a.sandbox_allowed_hosts, "*.mycompany.com\nbitbucket.org", "\n")}
          />
        </Field>
        {/* Work-done detection and the patterns are one feature: whether we
            read this agent's state at all, and what we read it from. The master
            switch sits on the section's legend, so the body underneath is
            visibly what it governs, and turning it off collapses that body
            rather than leaving dead fields for a machine that isn't running. */}
        {!isTerminal &&
          <SubSection
            title={t("agents.card.workDoneTitle")}
            hint={t("agents.card.workDoneHint")}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={agent.work_done !== false}
                onClick={() => onPatch({ work_done: agent.work_done === false ? true : false })}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out items-center",
                  // bg-2, not bg-3: the band itself is bg-3, so an off switch
                  // tracked in bg-3 would have no track at all.
                  agent.work_done !== false ? "bg-[var(--color-ok)]" : "bg-[var(--color-bg-2)]"
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
                {agent.work_done !== false ? t("agents.card.on") : t("agents.card.off")}
              </span>
            </div>
            {agent.work_done !== false && <>
            {/* The patterns are what the switch above turns on, so they live
                under it and vanish with it. Their shared explanation sits here
                rather than on the legend, which speaks for the whole section. */}
            <div className="border-t border-[var(--color-border-soft)] pt-3 text-[12px] text-[var(--color-fg-dim)]">
              {signalGroupHint(agent.id, t)}
            </div>
            {/* The rows below tune a GUESS, and the exact answer is now on
                this same page, above the tabs. No signpost needed. */}
            <RegexListField
              label={t("agents.card.doneLabel")}
              hint={t("agents.card.doneHint")}
              value={agent.capabilities?.signals?.idle ?? []}
              onChange={idle => onPatchCaps({ signals: { ...(agent.capabilities?.signals ?? {}), idle } })}
              placeholder={signalPlaceholder(agent.id, "idle", "Ready\n✓ done\nawaiting input" /* allow-shortcut: example placeholder text, the check mark is illustrative sample content (Orel-approved) */, inherited)}
            />
            <RegexListField
              label={t("agents.card.busyLabel")}
              hint={t("agents.card.busyHint")}
              value={agent.capabilities?.signals?.busy ?? []}
              onChange={busy => onPatchCaps({ signals: { ...(agent.capabilities?.signals ?? {}), busy } })}
              placeholder={signalPlaceholder(agent.id, "busy", "Working\nThinking\nRunning", inherited)}
            />
            <RegexListField
              label={t("agents.card.attentionLabel")}
              hint={t("agents.card.attentionHint")}
              value={agent.capabilities?.signals?.attention ?? []}
              onChange={attention => onPatchCaps({ signals: { ...(agent.capabilities?.signals ?? {}), attention } })}
              placeholder={signalPlaceholder(agent.id, "attention", "Action Required\nWaiting for approval", inherited)}
            />
            <RegexListField
              label={t("agents.card.pendingLabel")}
              hint={t("agents.card.pendingHint")}
              value={agent.capabilities?.signals?.pending ?? []}
              onChange={pending => onPatchCaps({ signals: { ...(agent.capabilities?.signals ?? {}), pending } })}
              placeholder={signalPlaceholder(agent.id, "pending", "Waiting for \\d+ jobs? to finish\n\\d+ tasks? still running", inherited)}
            />
            {/* The fields above are useless without knowing what the
                agent actually prints. This is where those strings come from. */}
            <SignalInspector
              agentId={agent.id}
              signals={agent.capabilities?.signals}
              onAddPattern={(cls, pattern) => {
                const cur = agent.capabilities?.signals ?? {};
                const list = cur[cls] ?? [];
                if (list.includes(pattern)) return; // adding twice is a no-op
                onPatchCaps({ signals: { ...cur, [cls]: [...list, pattern] } });
              }}
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
                label={t("agents.card.matchLabel")}
                hint={hasSignals
                  ? t("agents.card.matchHintOn")
                  : t("agents.card.matchHintOff")}
              >
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    role="switch"
                    disabled={!hasSignals}
                    aria-checked={!!agent.capabilities?.match_output}
                    onClick={() => onPatchCaps({ match_output: !agent.capabilities?.match_output })}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out items-center", /* allow-shortcut: standard toggle switch, matches the Work-done switch above, not a decorative chip (Orel-approved) */
                      hasSignals ? "cursor-pointer" : "cursor-not-allowed opacity-50",
                      // bg-2, not bg-3: the band itself is bg-3, so an off
                      // switch tracked in bg-3 would have no track at all.
                      hasSignals && agent.capabilities?.match_output ? "bg-[var(--color-ok)]" : "bg-[var(--color-bg-2)]"
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
                    {!hasSignals ? t("agents.card.matchNone")
                      : agent.capabilities?.match_output ? t("agents.card.matchBoth")
                      : t("agents.card.matchTitle")}
                  </span>
                </div>
              </Field>
            </div>
            </>}
          </SubSection>}
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
      rows={fitRows(draft, ENV_PLACEHOLDER)}
      style={{ minHeight: fitMinHeight(draft, ENV_PLACEHOLDER) }}
      className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12.5px] text-[var(--color-fg)] focus:border-[var(--color-accent-soft)] focus:outline-none [field-sizing:content]"
      placeholder={ENV_PLACEHOLDER}
    />
  );
}

const ENV_PLACEHOLDER =
  "CLAUDE_CODE_NO_FLICKER=1\nHTTPS_PROXY=http://localhost:8080\nANTHROPIC_API_KEY=sk-ant-...";

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
      rows={fitRows(draft, placeholder)}
      style={{ minHeight: fitMinHeight(draft, placeholder) }}
      className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12.5px] text-[var(--color-fg)] focus:border-[var(--color-accent-soft)] focus:outline-none [field-sizing:content]"
      placeholder={placeholder}
    />
  );
}

/** For an agent that ships title heuristics (claude, codex), the placeholder IS
 *  those heuristics, so an empty field reads as "this is what runs today" and a
 *  user who wants to adjust one has something to copy rather than a guess. The
 *  sources are written to behave identically when pasted in (see
 *  BUILTIN_TITLE_SIGNALS). Everyone else gets illustrative examples. */
/** Placeholder text for a field a CLONE has left empty: the value it actually
 *  inherits, not a generic example.
 *
 *  An empty box means "inherited" now, so showing `--option1 --option2` there
 *  describes nothing the agent does. The same idea `signalPlaceholder` already
 *  used for built-in title patterns, applied to the rest of the card: greyed
 *  text is what runs today, and typing replaces it.
 *
 *  Falls back to the example for a non-clone, and for a field the parent has
 *  not set either, where an example is genuinely the most useful thing. */
function inheritedPlaceholder(
  inherited: Agent | undefined,
  pick: (a: Agent) => string | string[] | undefined,
  fallback: string,
  join = " ",
): string {
  if (!inherited) return fallback;
  const v = pick(inherited);
  const text = (Array.isArray(v) ? v.join(join) : v ?? "").trim();
  return text || fallback;
}

function signalPlaceholder(
  cli: string,
  key: "busy" | "idle" | "attention" | "pending",
  fallback: string,
  inherited?: Agent,
): string {
  // A clone's inherited patterns first: BUILTIN_TITLE_SIGNALS is keyed by
  // built-in NAME, so a clone matched nothing and showed examples for patterns
  // it really does use.
  const own = inherited?.capabilities?.signals?.[key];
  if (own?.length) return own.join("\n");
  const builtin = BUILTIN_TITLE_SIGNALS[cli]?.[key];
  return builtin?.length ? builtin.join("\n") : fallback;
}

/** Stated once for the whole group rather than three times, once per field.
 *  The two cases differ in what the greyed text means: live patterns for an
 *  agent that ships heuristics, examples for one that doesn't. */
function signalGroupHint(cli: string, t: (key: string) => string): string {
  return BUILTIN_TITLE_SIGNALS[cli]
    ? t("agents.card.signalHintBuiltin")
    : t("agents.card.signalHintCustom");
}

/** One-regex-per-line editor for custom work-done signals (issue #68). Reuses
 *  the paths textarea (spaces inside a pattern survive; `#` lines are
 *  comments) and flags any pattern that fails to compile, so a bad regex is
 *  visibly ignored rather than silently dropped. */
function RegexListField({ label, hint, value, onChange, placeholder }: {
  label: string; hint: string; value: string[];
  onChange: (v: string[]) => void; placeholder?: string;
}) {
  const { t } = useTranslation("settings");
  const invalid = value.filter(p => {
    try { new RegExp(p); return false; } catch { return true; }
  });
  return (
    <Field label={label} hint={hint}>
      <PathsTextarea value={value} onChange={onChange} placeholder={placeholder} />
      {invalid.length > 0 && (
        <div className="mt-1 font-mono text-[11.5px] text-[var(--color-warn)]">
          {t("agents.card.invalidRegex")} {invalid.join("   ")}
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

/** What this agent's chip in the task footer shows. Two switches, one per
 *  readout, stored in prefs as opt-outs so a new agent shows both. The hint
 *  says when the agent has no source for one, rather than hiding the switch:
 *  a missing switch reads as a missing feature, and a clone of a reporting
 *  agent inherits the source anyway. */
function FooterReadouts({ agentId }: { agentId: string }) {
  const { t } = useTranslation("settings");
  const agents = useApp(s => s.agents);
  const reports = footerReports(builtinBaseId(agentId, agents));
  const hidden = usePrefs(s => s.agentFooterHidden[agentId]);
  const setShown = usePrefs(s => s.setAgentFooterShown);
  return (
    <div data-testid={`agent-footer-${agentId}`} className="grid grid-cols-1 gap-3 rounded-md border border-[var(--color-border-soft)] px-3 py-2.5">
      <Toggle
        label={t("agents.card.footerUsage")}
        hint={reports.usage
          ? t("agents.card.footerUsageHint")
          : t("agents.card.footerUsageNone")}
        value={!hidden?.usage}
        onChange={v => setShown(agentId, "usage", v)}
      />
      <Toggle
        label={t("agents.card.footerContext")}
        hint={reports.context
          ? t("agents.card.footerContextHint")
          : t("agents.card.footerContextNone")}
        value={!hidden?.context}
        onChange={v => setShown(agentId, "context", v)}
      />
    </div>
  );
}
