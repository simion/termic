// The cage's Activity panel: everything a task's agent and its role shells
// were blocked from, flagged for, or used, in one wide table with filters
// (keyword, show, kind, who, role, when), sortable, a click on a row opening
// its detail. The status bar chip's tail opens it, and so does a shell's
// role badge, pre-filtered to that shell. It floats
// above the task's status bar and blocks nothing, so the terminal under it
// keeps working. Polls every 1.5s while open, never otherwise. docs/ui.md
// "The cage chip".

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, Info, Pause, Play, Search, Settings2, Undo2, X } from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/Dropdown";
import { AllowSplitButton, type ScopeOption } from "@/components/ui/AllowSplitButton";
import { cn } from "@/lib/utils";
import { i18n } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import { writeClipboardText } from "@/lib/clipboard";
import { effectiveSandboxMode, keychainBlocked, type BrokerCounts, type BrokerEvents, type Role, type Rule, type SecretDef } from "@/lib/types";
import { allowRuleFor, roleColour, suspiciousKey } from "@/lib/secretsUi";
import { tasksByRole } from "@/components/settings/secretsSettings/model";
import { parseRoleShells, roleSecrets, roleShellsKey, type RoleShell } from "@/lib/shellSecrets";
import { taskLabel } from "@/lib/taskLabel";
import { agentDisplayName } from "@/lib/agents";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { useSecrets } from "@/store/secrets";

const EMPTY_EVENTS: BrokerEvents = { used: [], blocked: [], no_secret: [], suspicious: [] };
type BlockedRow = BrokerEvents["blocked"][number];
type CageScope = "agent" | "project" | "repo";

type Kind = "network" | "file" | "rule" | "nosecret" | "suspicious" | "used";
type Show = "blocked" | "suspicious" | "used";
const SHOW_OF: Record<Kind, Show> = { network: "blocked", file: "blocked", rule: "blocked", nosecret: "blocked", suspicious: "suspicious", used: "used" };
const WINDOWS = { "15m": 15 * 60_000, "1h": 60 * 60_000, all: Infinity } as const;
type Win = keyof typeof WINDOWS;

type SortCol = "kind" | "what" | "count" | "last";
type Sort = { col: SortCol; desc: boolean };
const DEFAULT_SORT: Sort = { col: "last", desc: true };
const KIND_ORDER: Kind[] = ["suspicious", "rule", "nosecret", "network", "file", "used"];
const SORTS: Record<SortCol, (a: Row, b: Row) => number> = {
  kind: (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  what: (a, b) => a.what.localeCompare(b.what),
  count: (a, b) => a.count - b.count,
  last: (a, b) => a.last - b.last,
};

/** A row acted on in this panel; `allowed` null once undone. */
type Acted = { row: Row; allowed: { scope: string; value: string; undo: () => Promise<unknown> } | null };

/** One table row. `who` is "agent" or a shell's broker key. */
type Row = {
  id: string; who: string; kind: Kind; role?: string;
  what: string; why: string; count: number; last: number;
  host?: string; path?: string; proc?: string; blocked?: BlockedRow;
  /** a used row's per-method counts. */
  methods?: [string, number][];
};

/** Mounted by the task's footer while Activity is open for that task, so it
 *  sits in that task's column and hides with it. */
export function CageActivityPanel({ taskId }: { taskId: string }) {
  const who = useUI(s => (s.cageActivity?.taskId === taskId ? s.cageActivity.who : null));
  return <ActivityBody key={`${taskId}|${who ?? ""}`} taskId={taskId} initialWho={who} />;
}

function ActivityBody({ taskId, initialWho }: { taskId: string; initialWho: string | null }) {
  const { t } = useTranslation("task");
  const { t: tS } = useTranslation("secrets");
  const close = useUI(s => s.closeCageActivity);
  const task = useApp(s => s.tasks.find(x => x.id === taskId));
  const shellsKey = useApp(s => roleShellsKey(s, taskId));
  const shells = useMemo(() => parseRoleShells(taskId, shellsKey), [taskId, shellsKey]);
  const roles = useSecrets(s => s.roles);
  const secrets = useSecrets(s => s.secrets);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const cageScope = usePrefs(s => s.allowScope);
  const setCageScope = usePrefs(s => s.setAllowScope);
  const ruleScope = usePrefs(s => s.secretsAllowScope);
  const setRuleScope = usePrefs(s => s.setSecretsAllowScope);

  const mode = task ? effectiveSandboxMode(task) : "off";
  const docker = !!task?.docker_sandbox_enabled;
  const monitor = !docker && mode === "monitor";
  const fsOnly = !docker && mode === "enforce-fs";
  const caged = !docker && mode !== "off";
  const cli = task?.cli ?? "claude";
  const agent = agentDisplayName(cli);
  const kcBlocked = task ? keychainBlocked(task) : false;

  // the one poll: the agent's cage lists, then every broker key's events and
  // counts (the agent's is the task id, each shell has its own).
  const keys = useMemo(() => [taskId, ...shells.map(s => s.key)], [taskId, shells]);
  // the panel survives a task switch (its footer stays mounted, hidden).
  const active = useApp(s => s.activeTaskId === taskId);
  const none = Promise.resolve([] as never[]);
  const poll = usePoll(async () => {
    const [accHosts, accPaths, hosts, paths, ...rest] = await Promise.all([
      monitor ? ipc.sandboxRecentAccessHosts(taskId).catch(() => []) : none,
      monitor ? ipc.sandboxRecentAccessPaths(taskId).catch(() => []) : none,
      caged && !monitor && !fsOnly ? ipc.sandboxRecentDeniedHosts(taskId).catch(() => []) : none,
      caged && !monitor ? ipc.sandboxRecentDeniedPaths(taskId).catch(() => []) : none,
      ...keys.map(k => ipc.brokerEvents(k).catch(() => EMPTY_EVENTS)),
      ...keys.map(k => ipc.brokerCounts(k).catch(() => null)),
    ]);
    return {
      accHosts: accHosts as ipc.AccessHost[], accPaths: accPaths as ipc.AccessPath[],
      hosts: hosts as ipc.DenyHost[], paths: paths as ipc.DenyPath[],
      events: rest.slice(0, keys.length) as BrokerEvents[],
      counts: rest.slice(keys.length) as (BrokerCounts | null)[],
    };
  }, EMPTY_POLL, pollSig, active, [taskId, monitor, fsOnly, caged, keys.join("|")]);

  const [home, setHome] = useState("");
  useEffect(() => { ipc.homeDir().then(setHome).catch(() => {}); }, []);
  const shortenPath = (p: string) => (home && (p === home || p.startsWith(home + "/")) ? "$HOME" + p.slice(home.length) : p);

  // ── filters ──
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Set<Show>>(new Set(["blocked", "suspicious"]));
  const [kind, setKind] = useState<"all" | Kind>("all");
  const [who, setWho] = useState<string>(initialWho ?? "all");
  const [role, setRole] = useState<string>("all");
  const [win, setWin] = useState<Win>("all");
  // newest first until a header is clicked; one row open at a time.
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [expanded, setExpanded] = useState<string | null>(null);

  // rows acted on here: kept in the table even once Rust drops them (an
  // allow clears the deny), so the row can show what was done and undo it.
  const [acted, setActed] = useState<Map<string, Acted>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

  const roleName = (id: string) => roles.find(r => r.id === id)?.name ?? id;
  const secretName = (id: string) => secrets.find(x => x.id === id)?.name ?? id;
  const whoLabel = (w: string) => {
    if (w === "agent") return agent;
    const s = shells.find(x => x.key === w);
    return s ? t("activity.shellWho", { title: s.title || t("footer.terminal"), role: roleName(s.role) }) : w;
  };

  const rows = useMemo(() => {
    const out: Row[] = [];
    const { hosts, paths, events } = poll.data;
    for (const h of hosts) out.push({ id: `h|${h.host}`, who: "agent", kind: "network", what: h.host, why: t("activity.whyHost"), count: h.count, last: h.last_seen_unix_ms, host: h.host });
    for (const p of paths) out.push({ id: `p|${p.path}`, who: "agent", kind: "file", what: p.path, why: t("activity.whyPath"), count: p.count, last: p.last_seen_unix_ms, path: p.path, proc: p.last_proc ? `${p.last_proc}(${p.last_pid})` : undefined });
    keys.forEach((k, i) => {
      const w = i === 0 ? "agent" : k;
      const ev = events[i] ?? EMPTY_EVENTS;
      for (const b of ev.blocked) out.push({ id: `r|${k}|${b.role}|${b.secret}|${b.host}|${b.method}|${b.path}`, who: w, kind: "rule", role: b.role, what: `${b.method} ${b.host}${b.path}`, why: `${roleName(b.role)} · ${secretName(b.secret)}`, count: b.count, last: b.last_seen_unix_ms, blocked: b });
      for (const n of ev.no_secret) out.push({ id: `n|${k}|${n.host}`, who: w, kind: "nosecret", what: n.host, why: tS("task.noSecretNote"), count: n.count, last: n.last_seen_unix_ms });
      // a shell's wrong peer is almost always tmux, whose server runs in a session of its own.
      for (const s of ev.suspicious) out.push({ id: `s|${k}|${s.kind}|${s.host}|${s.detail}`, who: w, kind: "suspicious", what: [s.host, s.detail].filter(Boolean).join(" · "), why: w !== "agent" && s.kind === "wrong_peer" ? tS("shell.tmuxPeer") : tS(suspiciousKey(s.kind)), count: s.count, last: s.last_seen_unix_ms });
      for (const u of ev.used) out.push({ id: `u|${k}|${u.secret}|${u.host}|${u.role}`, who: w, kind: "used", role: u.role, what: `${secretName(u.secret)} → ${u.host}`, why: u.methods.map(([m, n]) => `${m} ${n}`).join(" · "), methods: u.methods, count: u.methods.reduce((a, [, n]) => a + n, 0), last: u.last_seen_unix_ms });
    });
    const ids = new Set(out.map(r => r.id));
    for (const [id, a] of acted) if (!ids.has(id)) out.push(a.row);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.data, keys, acted, roles, secrets]);

  const now = Date.now();
  const inWindow = (r: Row) => now - r.last < WINDOWS[win];
  // the chips count within the show + when filters, so a chip says what
  // picking it would leave.
  const base = rows.filter(r => show.has(SHOW_OF[r.kind]) && inWindow(r));
  const needle = q.trim().toLowerCase();
  const visible = base.filter(r =>
    (kind === "all" || r.kind === kind)
    && (who === "all" || r.who === who)
    && (role === "all" || r.role === role)
    && (!needle || `${r.what} ${r.why} ${whoLabel(r.who)}`.toLowerCase().includes(needle)));
  const sorted = [...visible].sort((a, b) => (sort.desc ? -1 : 1) * SORTS[sort.col](a, b) || b.last - a.last);
  // a header click sorts by it, a second flips it, a third goes back to newest first.
  const onSort = (col: SortCol) => setSort(s => {
    const first = col === "count" || col === "last";
    return s.col !== col ? { col, desc: first } : s.desc === first ? { col, desc: !s.desc } : DEFAULT_SORT;
  });
  const countBy = (pred: (r: Row) => boolean) => base.filter(pred).length;
  const showCount = (s: Show) => rows.filter(r => SHOW_OF[r.kind] === s && inWindow(r)).length;
  const rolesSeen = [...new Set(rows.map(r => r.role).filter(Boolean) as string[])];

  // ── allows ──
  const cageOptions: ScopeOption<CageScope>[] = [
    { id: "project", label: t("cage.scopeProject"), short: t("cage.scopeProjectShort"), hint: t("cage.scopeProjectHint") },
    { id: "agent", label: t("cage.scopeAgent", { cli }), short: cli, hint: t("cage.scopeAgentHint", { cli }) },
    { id: "repo", label: t("cage.scopeRepo"), short: ".termic.yaml", hint: t("cage.scopeRepoHint") },
  ];

  const allowedAs = (id: string) => acted.get(id)?.allowed?.scope ?? null;
  const markAllowed = (r: Row, scope: string, value: string, undo: () => Promise<unknown>) =>
    setActed(m => new Map(m).set(r.id, { row: r, allowed: { scope, value, undo } }));

  /** a host, a path, or a prefix of the path (`value`), on `scope`. Persist
   *  only: the running agent keeps its narrower profile until it restarts. */
  async function allowCage(r: Row, scope: CageScope, value: string = r.host ?? r.path!) {
    const kind = r.host ? "host" : "path";
    setBusy(r.id);
    try {
      if (kind === "host") {
        if (scope === "agent") await ipc.agentSandboxAddAllowedHost(cli, value);
        else if (scope === "repo") await ipc.repoConfigAddAllowedHost(taskId, value);
        else await ipc.taskSandboxAddAllowedHost(taskId, value);
      } else {
        if (scope === "agent") await ipc.agentSandboxAddAllowedPath(cli, value);
        else if (scope === "repo") await ipc.repoConfigAddAllowedPath(taskId, value);
        else await ipc.taskSandboxAddAllowedPath(taskId, value);
      }
      markAllowed(r, scope, value, () => ipc.sandboxRemoveAllowed(taskId, scope, kind, value));
    } catch (e) {
      useUI.getState().pushToast(kind === "host"
        ? t("denied.allowHostFailed", { host: value, error: String(e) })
        : t("denied.allowPathFailed", { path: value, error: String(e) }), "error");
    } finally { setBusy(null); }
  }

  async function undoAllow(r: Row) {
    const a = acted.get(r.id)?.allowed;
    if (!a) return;
    setBusy(r.id);
    try {
      await a.undo();
      setActed(m => new Map(m).set(r.id, { row: r, allowed: null }));
    } catch (e) {
      useUI.getState().pushToast(t("activity.undoFailed", { error: String(e) }), "error");
    } finally { setBusy(null); }
  }

  const ruleOptions = (b: BlockedRow, shell: boolean): ScopeOption<"task" | "role">[] => {
    const n = tasksByRole(useApp.getState().tasks, roles).get(b.role)?.length ?? 0;
    const all: ScopeOption<"task" | "role">[] = [
      { id: "task", label: t("cage.scopeTask"), short: t("cage.scopeTaskShort"), hint: t("cage.scopeTaskHint", { task: task ? taskLabel(task, useBranchAsTaskName) : taskId }) },
      { id: "role", label: t("cage.scopeRole", { role: roleName(b.role) }), short: roleName(b.role), hint: t(n === 1 ? "cage.scopeRoleHint_one" : "cage.scopeRoleHint_other", { count: n }) },
    ];
    // a shell has no task allows: its rule allows save to the role.
    return shell ? all.filter(o => o.id === "role") : all;
  };

  async function allowRule(r: Row, scope: "task" | "role") {
    const b = r.blocked!;
    const rule: Rule | null = allowRuleFor(b);
    if (!rule) return;
    // the broker key the row came from: a shell's own, else the agent's.
    const key = r.who !== "agent" ? r.who : taskId;
    const role = scope === "role" ? b.role : null;
    setBusy(r.id);
    try {
      // the role the spawn ran with when it was blocked, not the saved pick.
      await ipc.brokerAllow(key, scope, b.secret, b.host, rule, role);
      markAllowed(r, scope, `${b.method} ${b.path}`, () => ipc.brokerUnallow(key, scope, b.secret, b.host, rule, role));
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    } finally { setBusy(null); }
  }

  // Pause belongs to one broker: the shell picked in Who, else the agent.
  const pauseKey = who !== "all" && who !== "agent" ? who : taskId;
  const pauseCounts = poll.data.counts[keys.indexOf(pauseKey)] ?? null;
  const pause = useBrokerPause(pauseKey, pauseCounts);
  const pauseShown = !!pauseCounts && pauseCounts.live > 0;
  // a task's pause covers its shells too; a shell's covers only that shell.
  const pauseNs = pauseKey === taskId ? "task" : "shell";

  // Esc closes it, but only from inside the panel: a filter menu is portaled,
  // so its own Esc bubbles here through React and must not close the panel.
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const prev = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    // hand focus back on close (Esc, ✕, the chip): unmounting would drop it
    // on body, and the terminal it came from would stop taking keys.
    return () => { if (prev instanceof HTMLElement && prev !== document.body && prev.isConnected) prev.focus({ preventScroll: true }); };
  }, []);

  if (!task) return null;
  const monitorShown = monitor && (who === "all" || who === "agent");
  const all = t("activity.all");
  const kindOptions: FilterOption<"all" | Kind>[] = [{ id: "all", label: all },
    ...(["network", "file", "rule", "nosecret"] as Kind[]).map(k => ({ id: k, label: t(`activity.kind_${k}`), count: countBy(r => r.kind === k) }))];
  const whoOptions: FilterOption<string>[] = [{ id: "all", label: all },
    { id: "agent", tid: "agent", label: agent, count: countBy(r => r.who === "agent") },
    ...shells.map((s: RoleShell) => ({ id: s.key, tid: s.tabId, label: whoLabel(s.key), dot: roleColour(roles.find(r => r.id === s.role)?.colour), count: countBy(r => r.who === s.key) }))];
  const roleOptions: FilterOption<string>[] = [{ id: "all", label: all },
    ...rolesSeen.map(id => ({ id, label: roleName(id), dot: roleColour(roles.find(r => r.id === id)?.colour) }))];
  const winOptions: FilterOption<Win>[] = (Object.keys(WINDOWS) as Win[]).map(w => ({ id: w, label: t(`activity.win_${w}`) }));
  const td = "truncate whitespace-nowrap px-2 py-1.5";
  // Monitor's rows are allowed the same way, but hide once allowed (its
  // lists are the log, not a table of decisions).
  const allowedIds = new Set([...acted].filter(([, a]) => a.allowed).map(([id]) => id));
  const monRow = (k: "host" | "path", target: string): Row =>
    ({ id: `${k === "host" ? "h" : "p"}|${target}`, who: "agent", kind: k === "host" ? "network" : "file", what: target, why: "", count: 0, last: 0, [k]: target });
  const title = t("activity.title", { task: taskLabel(task, useBranchAsTaskName) });

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      data-testid="cage-activity"
      aria-label={title}
      onKeyDown={e => { if (e.key === "Escape" && panelRef.current?.contains(e.target as Node)) { e.stopPropagation(); close(); } }}
      onClick={e => e.stopPropagation()}
      className="absolute bottom-[calc(100%+6px)] right-2 z-30 flex h-[min(520px,60vh)] w-[min(1100px,calc(100%-1rem))] flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] text-[12.5px] text-[var(--color-fg-dim)] shadow-2xl outline-none"
    >
      {/* header: one line */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-2">
        <span className="whitespace-nowrap text-[13px] font-semibold text-[var(--color-fg)]">{title}</span>
        <span className="truncate text-[11.5px] text-[var(--color-fg-faint)]">{shells.length ? t(shells.length === 1 ? "activity.whoSummaryOne" : "activity.whoSummaryOther", { agent, count: shells.length }) : agent}</span>
        <span title={t("activity.footer")} className="shrink-0 text-[var(--color-fg-faint)]"><Info className="h-3.5 w-3.5" /></span>
        <span className="flex-1" />
        {pauseShown && (
          <button type="button" data-testid="secrets-pause" onClick={() => void pause.toggle()} title={tS(`${pauseNs}.pauseTip`)} className={HEADER_BTN}>
            {pause.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {pause.paused ? tS("task.resume") : tS("task.pause")}
          </button>
        )}
        <button type="button" onClick={() => { close(); useUI.getState().openSandbox(taskId); }} className={HEADER_BTN}>
          <Settings2 className="h-3 w-3" />{t("cage.sandboxSettings")}
        </button>
        <button type="button" data-testid="activity-close" aria-label={t("common:close")} onClick={close}
          className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"><X className="h-3.5 w-3.5" /></button>
      </div>

      {/* filters: one row, scrolls sideways before it wraps */}
      <div className="no-scrollbar flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--color-border-soft)] px-3 py-1.5">
        <label className="flex w-[220px] shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-0.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
          <input data-testid="activity-search" value={q} onChange={e => setQ(e.target.value)} placeholder={t("activity.search")}
            spellCheck={false} autoCorrect="off" autoCapitalize="off"
            className="w-full bg-transparent text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none" />
        </label>
        <span role="group" aria-label={t("activity.show")} className="flex shrink-0 overflow-hidden rounded-md border border-[var(--color-border)]">
          {(["blocked", "suspicious", "used"] as Show[]).map(sh => (
            <button key={sh} type="button" data-testid={`activity-show-${sh}`} aria-pressed={show.has(sh)}
              onClick={() => setShow(prev => { const n = new Set(prev); n.has(sh) ? n.delete(sh) : n.add(sh); return n; })}
              className={cn("flex items-center gap-1 whitespace-nowrap border-l border-[var(--color-border)] px-2 py-0.5 text-[12px] first:border-l-0",
                show.has(sh) ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]" : "text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]")}>
              {t(`activity.show_${sh}`)}<span className="text-[11px] text-[var(--color-fg-faint)]">{showCount(sh)}</span>
            </button>
          ))}
        </span>
        <FilterMenu label={t("activity.kind")} value={kind} options={kindOptions} onPick={setKind} testId="activity-kind" />
        {shells.length > 0 && <FilterMenu label={t("activity.who")} value={who} options={whoOptions} onPick={setWho} testId="activity-who" />}
        {rolesSeen.length > 0 && <FilterMenu label={t("activity.role")} value={role} options={roleOptions} onPick={setRole} testId="activity-role" />}
        <FilterMenu label={t("activity.when")} value={win} options={winOptions} onPick={setWin} testId="activity-when" />
        <DefaultAllowMenu cageOptions={cageOptions} cageScope={cageScope} setCageScope={setCageScope} ruleScope={ruleScope} setRuleScope={setRuleScope} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {pause.paused && pauseShown && (
          <div data-testid="secrets-paused-banner" className="mx-3 mt-2 rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-2.5 py-1.5">
            {tS(`${pauseNs}.pausedBanner`)}
          </div>
        )}
        {monitorShown && (
          <section className="flex flex-col gap-1 px-3 py-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">{t("activity.monitorHeading", { agent })}</h3>
            <MonitorActivity taskId={taskId} hosts={poll.data.accHosts} paths={poll.data.accPaths}
              taskDirs={[task.path, ...(task.composition ?? []).map(m => m.path)].filter(Boolean)}
              allowed={allowedIds} allowing={busy} scopeChosen={cageScope !== null}
              onAllowPath={p => { if (cageScope) void allowCage(monRow("path", p), cageScope); }}
              allowButton={(target, k) => {
                const r = monRow(k, target);
                return (
                  <AllowSplitButton allow={t("cage.allow")} heading={t("cage.allowFor")} options={cageOptions} scope={cageScope}
                    busy={busy === r.id} onAllow={sc => void allowCage(r, sc)} />
                );
              }}
              shortenPath={shortenPath} />
          </section>
        )}

        {sorted.length > 0 ? (
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[96px]" /><col className="w-[60px]" /><col className="w-[104px]" /><col /><col className="w-[196px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[var(--color-bg-1)]">
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
                <SortTh col="last" label={t("activity.colWhen")} sort={sort} onSort={onSort} />
                <SortTh col="count" label={t("activity.colTimes")} sort={sort} onSort={onSort} right />
                <SortTh col="kind" label={t("activity.colKind")} sort={sort} onSort={onSort} />
                <SortTh col="what" label={t("activity.colWhat")} sort={sort} onSort={onSort} />
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => {
                const shell = r.who !== "agent";
                const kcRow = r.kind === "file" && kcBlocked && underKeychains(shortenPath(r.what));
                const shown = r.kind === "file" ? shortenPath(r.what) : r.what;
                const isOpen = expanded === r.id;
                const toggle = () => setExpanded(isOpen ? null : r.id);
                const dot = shell ? roleColour(roles.find(x => x.id === shells.find(s => s.key === r.who)?.role)?.colour) : null;
                const was = allowedAs(r.id);
                const status: Status = was ? "allowed" : r.kind === "suspicious" ? "suspicious" : r.kind === "used" ? "used" : "blocked";
                const cageRow = r.kind === "network" || (r.kind === "file" && !kcRow);
                const ruleOpts = r.kind === "rule" && r.blocked && allowRuleFor(r.blocked) ? ruleOptions(r.blocked, shell) : null;
                // a shell's allow widens a role other tasks share, so it always
                // asks (the menu names how many tasks run that role).
                const ruleFace = ruleOpts && !shell && ruleScope && ruleOpts.some(o => o.id === ruleScope) ? ruleScope : null;
                const allowBtn = cageRow ? (
                  <AllowSplitButton allow={t("cage.allow")} heading={t("cage.allowFor")} options={cageOptions} scope={cageScope}
                    busy={busy === r.id} onAllow={sc => void allowCage(r, sc)} testId={r.kind === "network" ? "cage-allow-host" : "cage-allow-path"}
                    title={r.host ? t("denied.allowHostTip", { host: r.host }) : t("denied.allowPathTip", { path: r.what })}
                    allowed={was as CageScope | null} allowedLabel={t("activity.allowed")} undoLabel={t("activity.undo")} onUndo={() => void undoAllow(r)} />
                ) : ruleOpts ? (
                  <AllowSplitButton allow={t("cage.allow")} heading={t("cage.allowFor")} options={ruleOpts} scope={ruleFace}
                    busy={busy === r.id} onAllow={sc => void allowRule(r, sc)} testId="secrets-allow"
                    allowed={was as "task" | "role" | null} allowedLabel={t("activity.allowed")} undoLabel={t("activity.undo")} onUndo={() => void undoAllow(r)} />
                ) : null;
                return (
                  <Fragment key={r.id}>
                    <tr data-testid="activity-row" data-kind={r.kind} data-who={shell ? "shell" : "agent"} data-status={status}
                      tabIndex={0} aria-expanded={isOpen} onClick={toggle}
                      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } }}
                      className={cn("cursor-pointer border-t border-[var(--color-border-soft)] outline-none focus-visible:bg-[var(--color-hover)]",
                        isOpen ? "bg-[var(--color-bg-2)]" : status === "allowed" ? "bg-[var(--color-ok)]/[0.05] hover:bg-[var(--color-ok)]/10"
                          : status === "suspicious" ? "bg-[var(--color-err)]/[0.06] hover:bg-[var(--color-err)]/10" : "hover:bg-[var(--color-hover)]")}>
                      {/* the status stripe: amber blocked, green allowed, red suspicious, none for used. */}
                      <td className={cn(td, "text-[11.5px] text-[var(--color-fg-faint)]")} style={{ boxShadow: STATUS_STRIPE[status] }}>
                        <span className="flex items-center gap-1">
                          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", isOpen && "rotate-90")} />
                          {relTime(r.last)}
                        </span>
                      </td>
                      <td className={cn(td, "text-right tabular-nums text-[11.5px]", status === "blocked" ? "text-[var(--color-warn)]" : "text-[var(--color-fg-faint)]")}>{r.count}</td>
                      <td className={td}><KindTag kind={r.kind} /></td>
                      <td className={td} title={shown}>
                        <span className="flex min-w-0 items-center gap-1.5">
                          {dot && <span aria-hidden title={whoLabel(r.who)} className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />}
                          <span className={cn("truncate font-mono text-[12px]", status === "allowed" ? "text-[var(--color-fg-dim)]" : "text-[var(--color-fg)]")}>{shown}</span>
                        </span>
                      </td>
                      {/* the actions act on the row; they never expand it. */}
                      <td className="whitespace-nowrap px-2 py-1 text-right" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                        {allowBtn}
                        {r.kind === "nosecret" && (
                          <button type="button" title={tS("task.grantTip")} onClick={() => { close(); useApp.getState().openSettings("secrets"); }}
                            className="rounded border border-[var(--color-info)]/45 px-2 py-0.5 text-[11.5px] text-[var(--color-info)] hover:bg-[var(--color-info)]/10">{tS("task.grant")}</button>
                        )}
                        {r.kind === "used" && <Check className="ml-auto h-3.5 w-3.5 text-[var(--color-ok)]" />}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr data-testid="activity-detail" className="bg-[var(--color-bg-2)]">
                        <td colSpan={5} className="px-3 pb-3 pt-1" style={{ boxShadow: STATUS_STRIPE[status] }}>
                          <RowDetail key={`${r.id}|${was ?? ""}`} r={r} shown={shown} kcRow={kcRow} dot={dot} who={whoLabel(r.who)}
                            roles={roles} secrets={secrets} allowed={was} allowedValue={acted.get(r.id)?.allowed?.value ?? null}
                            options={cageRow ? cageOptions : ruleOpts} defScope={cageRow ? cageScope : ruleFace} busy={busy === r.id}
                            onAllow={(sc, prefix) => void (cageRow ? allowCage(r, sc as CageScope, prefix ?? undefined) : allowRule(r, sc as "task" | "role"))}
                            onUndo={() => void undoAllow(r)}
                            onGrant={() => { close(); useApp.getState().openSettings("secrets"); }}
                            onEditRole={id => { close(); useApp.getState().openSettings("secrets", undefined, `role:${id}`); }}
                            onCageSettings={() => { close(); useUI.getState().openSandbox(taskId); }}
                            onPause={pauseShown && !pause.paused ? () => void pause.toggle() : null}
                            copy={(r.kind === "network" || r.kind === "file") ? <CopyButton value={r.what} title={r.kind === "network" ? t("denied.copyHostTip") : t("denied.copyFullPathTip")} /> : null} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : !monitorShown && (
          <div data-testid="activity-empty" className="px-3 py-8 text-center text-[var(--color-fg-faint)]">
            {!poll.loaded ? t("common:loading") : rows.length === 0 ? t("activity.nothingYet") : t("activity.nothingMatches")}
          </div>
        )}
      </div>
    </section>
  );
}

const HEADER_BTN = "flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]";

function SortTh({ col, label, sort, onSort, right }: { col: SortCol; label: string; sort: Sort; onSort: (c: SortCol) => void; right?: boolean }) {
  const on = sort.col === col;
  return (
    <th aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"} className={cn("px-2 py-1.5 font-medium", right && "text-right")}>
      <button type="button" data-testid={`activity-sort-${col}`} onClick={() => onSort(col)}
        className={cn("inline-flex items-center gap-1 uppercase tracking-wider hover:text-[var(--color-fg)]", on && "text-[var(--color-fg-dim)]")}>
        {label}{on && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );
}

type Status = "blocked" | "allowed" | "suspicious" | "used";
const STATUS_STRIPE: Record<Status, string> = {
  blocked: "inset 2px 0 0 var(--color-warn)",
  allowed: "inset 2px 0 0 var(--color-ok)",
  suspicious: "inset 2px 0 0 var(--color-err)",
  used: "none",
};

/** A row's detail, under it: a header (the whole request, why, and the
 *  facts on one line) over two equal panels, the evidence on the left and
 *  the decision on the right. For a path the left panel picks WHAT to allow
 *  (the file or a folder above it) and the right picks WHERE. */
function RowDetail({ r, shown, kcRow, dot, who, roles, secrets, allowed, allowedValue, options, defScope, busy, onAllow, onUndo, onGrant, onEditRole, onCageSettings, onPause, copy }: {
  r: Row; shown: string; kcRow: boolean; dot: string | null; who: string;
  roles: Role[]; secrets: SecretDef[];
  allowed: string | null; allowedValue: string | null;
  options: ScopeOption<string>[] | null; defScope: string | null; busy: boolean;
  onAllow: (scope: string, prefix: string | null) => void; onUndo: () => void;
  onGrant: () => void; onEditRole: (id: string) => void; onCageSettings: () => void; onPause: (() => void) | null;
  copy: React.ReactNode;
}) {
  const { t } = useTranslation("task");
  const { t: tS } = useTranslation("secrets");
  const b = r.blocked;
  const roleId = r.role ?? b?.role;
  const role = roleId ? roles.find(x => x.id === roleId) : undefined;
  const cage = (r.kind === "network" || r.kind === "file") && !kcRow;
  const file = r.kind === "file";
  const absolute = shown.startsWith("/");
  const parts = file ? shown.split("/").filter(Boolean) : [];
  const prefixAt = (i: number) => (absolute ? "/" : "") + parts.slice(0, i + 1).join("/");
  const [picked, setPicked] = useState(Math.max(0, parts.length - 1));
  const [where, setWhere] = useState<string | null>(defScope ?? options?.[0]?.id ?? null);
  const effect = cage ? t("activity.cageTakesEffect") : t("activity.ruleTakesEffect");
  const head = b ? t("activity.blockedBy", { rule: b.rule }) : kcRow ? t("denied.keychainBlockedPath") : r.why;

  const panel = "flex min-w-0 flex-col gap-2 rounded-md border px-3 py-2.5";
  const title = "flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-[var(--color-fg-faint)]";
  const note = "text-[11.5px] leading-snug text-[var(--color-fg-faint)]";
  const foot = "mt-auto flex items-end justify-between gap-3 pt-1";
  const go = "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-50";
  const goOk = cn(go, "border-[var(--color-ok)]/50 bg-[var(--color-ok)]/10 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/20");
  const goWarn = cn(go, "border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 text-[var(--color-warn)] hover:bg-[var(--color-warn)]/20");
  const goPlain = cn(go, "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]");
  const listRow = "flex justify-between gap-3 text-[11.5px] text-[var(--color-fg-dim)]";

  // ── left: the evidence ──
  let evidence: React.ReactNode;
  if (b && role) {
    const set = role.rule_sets.find(rs => rs.secret === b.secret && rs.host === b.host);
    const fallbackHit = b.rule.startsWith("fallback") || b.rule.startsWith("no rules");
    evidence = (<>
      <span className={title}>
        <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: roleColour(role.colour) }} />
        {t("activity.rulesFor", { role: role.name, host: b.host })}
      </span>
      <span data-testid="activity-detail-rules" className="flex flex-col font-mono text-[11.5px]">
        {(set?.rules ?? []).filter(x => !x.disabled).map((x, i) => {
          const hit = describeRule(x) === b.rule;
          return (
            <span key={i} data-hit={hit || undefined} className={cn("flex gap-2 rounded-[3px] px-1.5 py-0.5", hit && "bg-[var(--color-err)]/12 text-[var(--color-fg)]")}
              style={hit ? undefined : { color: x.effect === "allow" ? "var(--color-ok)" : "var(--color-err)" }}>
              <b className="w-11 shrink-0 font-medium">{x.effect.toUpperCase()}</b>
              <span className="min-w-0 break-all">{x.methods.join(", ")} {x.pattern}</span>
              {hit && <span className="ml-auto font-sans text-[10.5px] text-[var(--color-err)]">{t("activity.matched")}</span>}
            </span>
          );
        })}
        <span data-hit={fallbackHit || undefined} className={cn("flex gap-2 rounded-[3px] px-1.5 py-0.5", fallbackHit ? "bg-[var(--color-err)]/12 text-[var(--color-fg)]" : "text-[var(--color-fg-faint)]")}>
          <b className="w-11 shrink-0 font-medium">{(set?.fallback ?? "deny").toUpperCase()}</b>
          <span>* {t("activity.everythingElse")}</span>
          {fallbackHit && <span className="ml-auto font-sans text-[10.5px] text-[var(--color-err)]">{t("activity.matched")}</span>}
        </span>
      </span>
      <span className={cn(note, "mt-auto")}>
        {t("activity.viaSecret", { secret: secrets.find(s => s.id === b.secret)?.name ?? b.secret })}{" · "}
        <button type="button" onClick={() => onEditRole(role.id)} className="text-[var(--color-info)] hover:underline">{t("cage.editRole", { role: role.name })}</button>
      </span>
    </>);
  } else if (r.kind === "network") {
    evidence = (<>
      <span className={title}>{t("activity.listsChecked")}</span>
      <span className="flex flex-col gap-0.5">
        {(options ?? []).map(o => <span key={o.id} className={listRow}>{o.label}<i className="not-italic text-[var(--color-fg-faint)]">{t("activity.notListed")}</i></span>)}
      </span>
      <span className={cn(note, "mt-auto")}>{t("activity.listsNote")}</span>
    </>);
  } else if (file) {
    evidence = (<>
      <span className={title}>{kcRow ? t("activity.path") : t("activity.pathPick")}</span>
      <span data-testid="activity-folder" className="flex flex-wrap items-center font-mono text-[11.5px]">
        {parts.map((seg, i) => {
          const broad = tooBroad(prefixAt(i), absolute, i);
          const on = !kcRow && i <= picked;
          return (
            <span key={i} className="flex items-center">
              {i > 0 && <span className="px-0.5 text-[var(--color-fg-faint)]">/</span>}
              <button type="button" disabled={kcRow || broad || !!allowed} onClick={() => setPicked(i)} data-picked={on || undefined}
                title={broad ? t("activity.folderTooBroad") : prefixAt(i)}
                className={cn("rounded-[3px] px-0.5", on ? "bg-[var(--color-ok)]/15 text-[var(--color-fg)]" : "text-[var(--color-fg-faint)]",
                  !(kcRow || broad || allowed) && !on && "hover:bg-[var(--color-hover)]")}>{seg}</button>
            </span>
          );
        })}
      </span>
      <span className={cn(note, "mt-auto")}>
        {kcRow ? t("activity.keychainPath") : picked >= parts.length - 1 ? t("activity.justFile") : t("activity.underFolder", { path: prefixAt(picked) })}
      </span>
    </>);
  } else if (r.kind === "nosecret" && role) {
    const held = roleSecrets(role, secrets);
    evidence = (<>
      <span className={title}>
        <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: roleColour(role.colour) }} />
        {t("activity.roleSecrets", { role: role.name })}
      </span>
      <span className="flex flex-col gap-0.5">
        {held.length ? held.map(s => <span key={s.id} className={listRow}>{s.name}<i className="not-italic font-mono text-[var(--color-fg-faint)]">{s.hosts.join(", ")}</i></span>)
          : <span className={listRow}>{t("activity.roleHoldsNone")}</span>}
      </span>
      <span className={cn(note, "mt-auto")}>{t("activity.noneBound", { host: r.what })}</span>
    </>);
  } else if (r.kind === "used" && r.methods) {
    evidence = (<>
      <span className={title}>{t("activity.requests")}</span>
      <span className="flex flex-col gap-0.5">
        {r.methods.map(([m, n]) => <span key={m} className={listRow}><span className="font-mono">{m}</span><i className="not-italic text-[var(--color-fg-faint)]">{t("activity.times", { count: n })}</i></span>)}
      </span>
    </>);
  } else {
    evidence = (<>
      <span className={title}>{t("activity.whatHappened")}</span>
      <span className="text-[var(--color-fg)]">{r.why}</span>
      <span className={cn(note, "mt-auto break-all font-mono")}>{r.what}</span>
    </>);
  }

  // ── right: the decision ──
  const target = file && !kcRow ? prefixAt(picked) : null;
  let decision: React.ReactNode;
  let tone: "blocked" | "allowed" | "suspicious" | "plain" = "blocked";
  if (allowed) {
    tone = "allowed";
    decision = (<>
      <span className={cn(title, "text-[var(--color-ok)]")}><Check className="h-3.5 w-3.5" />{t("activity.allowed")}</span>
      <span className="flex flex-col gap-0.5">
        <span className="break-all font-mono text-[var(--color-fg)]">{file ? allowedValue : shown}</span>
        <span className="text-[var(--color-fg-dim)]">{t("activity.allowedFor", { scope: options?.find(o => o.id === allowed)?.label ?? allowed })}</span>
      </span>
      <span className={foot}>
        <span className={note}>{effect}</span>
        <button type="button" data-testid="activity-detail-undo" disabled={busy} onClick={onUndo} className={goWarn}><Undo2 className="h-3.5 w-3.5" />{t("activity.undo")}</button>
      </span>
    </>);
  } else if (options) {
    decision = (<>
      <span className={title}>{file && picked < parts.length - 1 ? t("activity.allowFolderFor") : t("activity.allowFor")}</span>
      <span role="radiogroup" className="flex flex-col gap-0.5">
        {options.map(o => (
          <label key={o.id} data-scope-option={o.id} className="grid cursor-pointer grid-cols-[16px_minmax(0,1fr)] items-baseline gap-x-1.5 rounded-[5px] px-1.5 py-1 hover:bg-[var(--color-hover)]">
            <input type="radio" name={`allow-${r.id}`} checked={where === o.id} onChange={() => setWhere(o.id)} className="m-0 translate-y-[2px] accent-[var(--color-ok)]" />
            <span className="text-[var(--color-fg)]">{o.label}</span>
            <small className="col-start-2 text-[11px] leading-snug text-[var(--color-fg-faint)]">{o.hint}</small>
          </label>
        ))}
      </span>
      <span className={foot}>
        <span className={note}>{effect}</span>
        <button type="button" data-testid="activity-detail-allow" disabled={busy || !where} onClick={() => where && onAllow(where, target)} className={goOk}>
          <Check className="h-3.5 w-3.5" />{t("cage.allow")}
        </button>
      </span>
    </>);
  } else if (kcRow) {
    tone = "plain";
    decision = (<>
      <span className={title}>{t("activity.nothingToAllow")}</span>
      <span>{t("activity.keychainDecision")}</span>
      <span className={foot}>
        <span className={note}>{t("activity.keychainHint")}</span>
        <button type="button" onClick={onCageSettings} className={goPlain}>{t("cage.sandboxSettings")}</button>
      </span>
    </>);
  } else if (r.kind === "nosecret") {
    decision = (<>
      <span className={title}>{t("activity.giveSecret")}</span>
      <span>{t("activity.giveSecretBody", { host: r.what, role: role?.name ?? "" })}</span>
      <span className={foot}>
        <span className={note}>{t("activity.opensRole")}</span>
        <button type="button" onClick={onGrant} className={cn(go, "border-[var(--color-info)]/45 text-[var(--color-info)] hover:bg-[var(--color-info)]/10")}>{tS("task.grant")}</button>
      </span>
    </>);
  } else if (r.kind === "suspicious") {
    tone = "suspicious";
    decision = (<>
      <span className={cn(title, "text-[var(--color-err)]")}>{t("activity.nothingToAllow")}</span>
      <span>{t("activity.suspBody")}</span>
      <span className={foot}>
        <span className={note}>{t("activity.suspHint")}</span>
        {onPause && <button type="button" onClick={onPause} className={goWarn}><Pause className="h-3.5 w-3.5" />{tS("task.pause")}</button>}
      </span>
    </>);
  } else {
    tone = "plain";
    decision = (<>
      <span className={title}>{t("activity.brokered")}</span>
      <span>{t("activity.usedNote")}</span>
    </>);
  }

  return (
    <div className="flex flex-col gap-2.5 pl-4 text-[12px]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-start gap-1 break-all font-mono text-[12.5px] text-[var(--color-fg)]">
          {b ? `${b.method} ${b.host}${b.path}` : shown}{copy}
        </span>
        <span className="text-[var(--color-fg-dim)]">{head}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-[var(--color-fg-faint)]">
          <span className="flex items-center gap-1.5">{dot && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />}{who}</span>
          {r.proc && <span className="font-mono">{r.proc}</span>}
          <span title={new Date(r.last).toLocaleString()}>{t("activity.lastSeen", { when: relTime(r.last), count: r.count })}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 items-stretch gap-2.5">
        <section className={cn(panel, "border-[var(--color-border-soft)] bg-[var(--color-bg-1)]")}>{evidence}</section>
        <section data-testid="activity-detail-action" data-tone={tone} className={cn(panel,
          tone === "allowed" ? "border-[var(--color-ok)]/40 bg-[var(--color-ok)]/[0.06]"
            : tone === "suspicious" ? "border-[var(--color-err)]/40 bg-[var(--color-err)]/[0.06]"
            : tone === "plain" ? "border-[var(--color-border-soft)] bg-[var(--color-bg-1)]"
            : "border-[var(--color-warn)]/35 bg-[var(--color-warn)]/[0.05]")}>{decision}</section>
      </div>
    </div>
  );
}

/** The broker's own words for a rule (`rules::describe`), so the detail can
 *  mark which one blocked the request. */
function describeRule(x: Rule): string {
  const s = `${x.effect.toUpperCase()} ${x.methods.join(", ")} ${x.pattern}`.trimEnd();
  return x.note.trim() ? `${s} (${x.note.trim()})` : s;
}

/** `$HOME` itself, or a folder at the top of the disk: never one click away. */
function tooBroad(prefix: string, absolute: boolean, i: number): boolean {
  return prefix === "$HOME" || prefix === "~" || (absolute && i === 0);
}

/** "Allow by default": what an Allow button's face does, for host and path
 *  rows and for secret requests. Not set means every Allow asks. The caret
 *  on a row still allows somewhere else for that row only. */
function DefaultAllowMenu({ cageOptions, cageScope, setCageScope, ruleScope, setRuleScope }: {
  cageOptions: ScopeOption<CageScope>[]; cageScope: CageScope | null; setCageScope: (s: CageScope | null) => void;
  ruleScope: "task" | "role" | null; setRuleScope: (s: "task" | "role" | null) => void;
}) {
  const { t } = useTranslation("task");
  const set = cageScope ?? ruleScope;
  const cageLabel = cageOptions.find(o => o.id === cageScope)?.short ?? t("activity.defaultNotSet");
  const item = (on: boolean, label: string, onSelect: () => void, tid: string) => (
    <DropdownItem data-testid={`activity-default-${tid}`} onSelect={onSelect}>
      <span className="flex w-full items-center gap-2 text-[12.5px]">{label}<span className="flex-1" />{on && <Check className="h-3.5 w-3.5 text-[var(--color-fg-dim)]" />}</span>
    </DropdownItem>
  );
  return (
    <DropdownRoot>
      <DropdownTrigger asChild>
        <button type="button" data-testid="activity-default" data-value={cageScope ?? ""}
          className={cn("ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[12px]",
            set ? "border-[var(--color-ok)]/45 text-[var(--color-ok)]" : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]")}>
          <span className="text-[var(--color-fg-faint)]">{t("activity.defaultAllow")}</span>{cageLabel}
          <ChevronDown className="h-3 w-3 text-[var(--color-fg-faint)]" />
        </button>
      </DropdownTrigger>
      <DropdownMenu align="end">
        <div className="max-w-[300px]">
          <DropdownLabel>{t("activity.defaultCageHeading")}</DropdownLabel>
          {item(cageScope === null, t("activity.defaultNotSet"), () => setCageScope(null), "cage-none")}
          {cageOptions.map(o => item(cageScope === o.id, o.label, () => setCageScope(o.id), `cage-${o.id}`))}
          <DropdownSeparator />
          <DropdownLabel>{t("activity.defaultRuleHeading")}</DropdownLabel>
          {item(ruleScope === null, t("activity.defaultNotSet"), () => setRuleScope(null), "rule-none")}
          {item(ruleScope === "task", t("cage.scopeTask"), () => setRuleScope("task"), "rule-task")}
          {item(ruleScope === "role", t("activity.defaultRuleRole"), () => setRuleScope("role"), "rule-role")}
          <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-[var(--color-fg-faint)]">{t("activity.defaultHint")}</p>
        </div>
      </DropdownMenu>
    </DropdownRoot>
  );
}

type FilterOption<T extends string> = { id: T; label: React.ReactNode; count?: number; dot?: string; tid?: string };

/** A filter as one compact control that names its value ("Kind All ▾"), so
 *  the filters fit one row however many shells or roles there are. */
function FilterMenu<T extends string>({ label, value, options, onPick, testId }: {
  label: string; value: T; options: FilterOption<T>[]; onPick: (v: T) => void; testId: string;
}) {
  const cur = options.find(o => o.id === value);
  return (
    <DropdownRoot>
      <DropdownTrigger asChild>
        <button type="button" data-testid={testId} data-value={value}
          className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[12px]",
            value !== "all" ? "border-[var(--color-fg-faint)] bg-[var(--color-bg-2)] text-[var(--color-fg)]" : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]")}>
          <span className="text-[var(--color-fg-faint)]">{label}</span>
          {cur?.dot && <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: cur.dot }} />}
          <span className="max-w-[180px] truncate">{cur?.label}</span>
          <ChevronDown className="h-3 w-3 text-[var(--color-fg-faint)]" />
        </button>
      </DropdownTrigger>
      <DropdownMenu align="start">
        {options.map(o => (
          <DropdownItem key={o.id} data-testid={`${testId}-${o.tid ?? o.id}`} onSelect={() => onPick(o.id)}>
            <span className="flex min-w-[160px] items-center gap-2 text-[12.5px]">
              {o.dot && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: o.dot }} />}
              <span className="truncate">{o.label}</span>
              {o.count !== undefined && <span className="ml-auto text-[11px] text-[var(--color-fg-faint)]">{o.count}</span>}
              {o.id === value && <Check className={cn("h-3.5 w-3.5 text-[var(--color-fg-dim)]", o.count === undefined && "ml-auto")} />}
            </span>
          </DropdownItem>
        ))}
      </DropdownMenu>
    </DropdownRoot>
  );
}

const EMPTY_POLL = {
  accHosts: [] as ipc.AccessHost[], accPaths: [] as ipc.AccessPath[],
  hosts: [] as ipc.DenyHost[], paths: [] as ipc.DenyPath[],
  events: [] as BrokerEvents[], counts: [] as (BrokerCounts | null)[],
};

/** A cheap fingerprint of the poll: the cage lists by length, newest and
 *  total count (Monitor's paths alone run to 20,000 entries, too many to
 *  stringify every tick), the broker side in full (capped per key). */
function pollSig(d: typeof EMPTY_POLL): string {
  const list = (l: { count: number; last_seen_unix_ms: number }[]) =>
    `${l.length}:${l.reduce((m, x) => Math.max(m, x.last_seen_unix_ms), 0)}:${l.reduce((n, x) => n + x.count, 0)}`;
  return [list(d.accHosts), list(d.accPaths), list(d.hosts), list(d.paths), JSON.stringify(d.events), JSON.stringify(d.counts)].join("|");
}

/** The dialog's one poll, every 1.5s while it is mounted, its task is the
 *  active one and the window is visible. A tick whose `sig` matches the last
 *  one keeps the old object, so nothing re-renders. */
function usePoll<T>(fetch: () => Promise<T>, empty: T, sig: (d: T) => string, active: boolean, deps: unknown[]) {
  const [data, setData] = useState<T>(empty);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let last = "";
    const tick = () => {
      if (document.hidden) return;
      fetch().then(next => {
        if (cancelled) return;
        const s = sig(next);
        if (s !== last) { last = s; setData(next); }
        setLoaded(true);
      }).catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => { cancelled = true; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
  return { data, setData, loaded };
}

/** Pause for one broker key, optimistic until the next counts agree. */
function useBrokerPause(key: string, counts: BrokerCounts | null) {
  const [local, setLocal] = useState<boolean | null>(null);
  const paused = local ?? !!counts?.paused;
  useEffect(() => { if (counts && local === counts.paused) setLocal(null); }, [counts, local]);
  const toggle = async () => {
    const next = !paused;
    setLocal(next);
    try { await ipc.brokerSetPaused(key, next); }
    catch (e) { setLocal(null); useUI.getState().pushToast(String(e), "error"); }
  };
  return { paused, toggle };
}

function KindTag({ kind }: { kind: Kind }) {
  const { t } = useTranslation("task");
  const secretsKind = kind === "rule" || kind === "nosecret" || kind === "used";
  return (
    <span className={cn(
      "whitespace-nowrap rounded-[3px] border px-1.5 text-[10.5px] leading-4",
      kind === "suspicious" ? "border-[var(--color-err)]/50 text-[var(--color-err)]"
        : secretsKind ? "border-[var(--color-info)]/45 text-[var(--color-info)]"
        : "border-[var(--color-border)] text-[var(--color-fg-dim)]",
      kind === "nosecret" && "border-dashed",
    )}>{t(`activity.kind_${kind}`)}</span>
  );
}

// ── MONITORING activity ─────────────────────────────────────────────
// Aggregate (network hosts + filesystem grouped by folder) and Detailed (the
// raw log). Click any path segment to allow that prefix.
type MonOp = ipc.AccessPath;
type MonHost = ipc.AccessHost;

function opTone(op: string): string {
  if (op.includes("write") || op.includes("create") || op.includes("unlink")) return "var(--color-warn)";
  if (op.includes("ioctl") || op.includes("exec")) return "var(--color-accent)";
  return "var(--color-fg-faint)";
}
function OpBadge({ op }: { op: string }) {
  return (
    <span className="shrink-0 rounded px-1 py-[1px] font-mono text-[10px] text-[var(--color-fg-dim)]"
      style={{ borderLeft: `2px solid ${opTone(op)}`, background: "var(--color-bg-2)" }} title={op}>
      {op.replace(/^file-/, "")}
    </span>
  );
}
function WouldBlockTag({ on }: { on: boolean }) {
  const { t } = useTranslation("task");
  if (on) return (
    <span className="shrink-0 rounded px-1 py-[1px] text-[10px] text-[var(--color-warn)]"
      style={{ background: "color-mix(in srgb, var(--color-warn) 15%, transparent)" }}
      title={t("monitor.wouldBlockTip")}>{t("monitor.wouldBlock")}</span>
  );
  return (
    <span className="shrink-0 rounded px-1 py-[1px] text-[10px] text-[var(--color-ok)]"
      style={{ background: "color-mix(in srgb, var(--color-ok) 12%, transparent)" }}
      title={t("monitor.okTip")}>{t("monitor.ok")}</span>
  );
}

function MonitorActivity({ taskId, hosts, paths, taskDirs, allowed, allowing, scopeChosen, onAllowPath, allowButton, shortenPath }: {
  taskId: string;
  hosts: MonHost[];
  paths: MonOp[];
  taskDirs: string[];
  allowed: Set<string>;
  allowing: string | null;
  scopeChosen: boolean;
  onAllowPath: (p: string) => void;
  allowButton: (target: string, kind: "host" | "path") => React.ReactNode;
  shortenPath: (p: string) => string;
}) {
  const { t } = useTranslation("task");
  const [tab, setTab] = useState<"aggregate" | "detailed">("aggregate");
  // Monitor's recording filters, pushed to the backend so they gate what is
  // stored, not just what shows.
  const [excludeTask, setExcludeTask] = useState(true);
  const [wbOnly, setWbOnly] = useState(true);
  useEffect(() => { ipc.sandboxSetMonitorFilters(taskId, excludeTask, wbOnly).catch(() => {}); }, [taskId, excludeTask, wbOnly]);
  const inTask = (p: string) => taskDirs.some(d => p === d || p.startsWith(d + "/"));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (f: string) => setExpanded(prev => { const n = new Set(prev); n.has(f) ? n.delete(f) : n.add(f); return n; });

  // "would block" rows are the actionable ones, so they sort to the top.
  const byBlockPath = (a: MonOp, b: MonOp) => Number(b.would_block) - Number(a.would_block) || b.last_seen_unix_ms - a.last_seen_unix_ms;
  const byBlockHost = (a: MonHost, b: MonHost) => Number(b.would_block) - Number(a.would_block) || b.last_seen_unix_ms - a.last_seen_unix_ms;
  const vHosts = hosts.filter(h => !allowed.has(`h|${h.host}`) && (!wbOnly || h.would_block)).sort(byBlockHost);
  const vPaths = paths.filter(p => !allowed.has(`p|${p.path}`) && !(excludeTask && inTask(p.path)) && (!wbOnly || p.would_block));
  const hiddenTask = excludeTask ? paths.filter(p => inTask(p.path)).length : 0;
  const total = vPaths.reduce((s, p) => s + p.count, 0) + vHosts.reduce((s, h) => s + h.count, 0);
  const wb = vPaths.filter(p => p.would_block).length + vHosts.filter(h => h.would_block).length;

  type Folder = { folder: string; entries: MonOp[]; count: number; wouldBlock: number; lastSeen: number; ops: Set<string> };
  const folders: Folder[] = (() => {
    const map = new Map<string, Folder>();
    for (const p of vPaths) {
      const idx = p.path.lastIndexOf("/");
      const folder = idx > 0 ? p.path.slice(0, idx) : "/";
      let g = map.get(folder);
      if (!g) { g = { folder, entries: [], count: 0, wouldBlock: 0, lastSeen: 0, ops: new Set() }; map.set(folder, g); }
      g.entries.push(p);
      g.count += p.count;
      if (p.would_block) g.wouldBlock += 1;
      g.lastSeen = Math.max(g.lastSeen, p.last_seen_unix_ms);
      g.ops.add(p.op.replace(/^file-/, ""));
    }
    return [...map.values()].sort((a, b) => Number(b.wouldBlock > 0) - Number(a.wouldBlock > 0) || b.lastSeen - a.lastSeen);
  })();
  const fileName = (p: string) => { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; };

  return (
    <div data-testid="cage-monitor" className="flex flex-col">
      <div className="mb-2 flex items-center gap-1">
        {(["aggregate", "detailed"] as const).map(tb => (
          <button key={tb} type="button" onClick={() => setTab(tb)}
            className={cn("rounded px-2 py-0.5 text-[11.5px] font-medium capitalize",
              tab === tb ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]" : "text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]")}>
            {t(`monitor.${tb}`)}
          </button>
        ))}
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-[var(--color-fg-faint)]" title={t("monitor.onlyWouldBlockTip")}>
          <input type="checkbox" checked={wbOnly} onChange={e => setWbOnly(e.target.checked)} className="h-3 w-3 accent-[var(--color-warn)]" />
          <span>{t("monitor.onlyWouldBlock")}</span>
        </label>
        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-[var(--color-fg-faint)]" title={t("monitor.excludeTaskTip")}>
          <input type="checkbox" checked={excludeTask} onChange={e => setExcludeTask(e.target.checked)} className="h-3 w-3 accent-[var(--color-accent)]" />
          <span>{hiddenTask > 0 ? t("monitor.excludeTaskCounted", { count: hiddenTask }) : t("monitor.excludeTask")}</span>
        </label>
        <span className="text-[11px] text-[var(--color-fg-faint)]">
          {t(total === 1 ? "monitor.accessCountOne" : "monitor.accessCountOther", { count: total })}
          {wb > 0 && <span className="ml-1 text-[var(--color-warn)]">{t("monitor.wouldBlockCount", { count: wb })}</span>}
        </span>
      </div>

      {vHosts.length === 0 && vPaths.length === 0 && <div className="px-1 py-2 text-[var(--color-fg-faint)]">{t("monitor.waiting")}</div>}

      {vHosts.length > 0 && (<>
        <div className="mb-1 mt-0.5 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">
          <span>{t("monitor.network")}</span><span>{t(vHosts.length === 1 ? "monitor.hostCountOne" : "monitor.hostCountOther", { count: vHosts.length })}</span>
        </div>
        <ul className="mb-2 flex flex-col">
          {vHosts.map(h => (
            <li key={h.host} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-hover)]">
              <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[var(--color-fg)]" title={`${h.host}:${h.port}`}>{h.host}<span className="text-[var(--color-fg-faint)]">:{h.port}</span></span>
              <WouldBlockTag on={h.would_block} />
              <CopyButton value={h.host} title={t("denied.copyHostTip")} />
              <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{h.count}× · {relTime(h.last_seen_unix_ms)}</span>
              {allowButton(h.host, "host")}
            </li>
          ))}
        </ul>
      </>)}

      {vPaths.length > 0 && (
        <div className="mb-1 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">
          <span>{t("monitor.filesystem")}</span>
          <span>{tab === "aggregate"
            ? t(folders.length === 1 ? "monitor.folderCountOne" : "monitor.folderCountOther", { count: folders.length })
            : t(vPaths.length === 1 ? "monitor.entryCountOne" : "monitor.entryCountOther", { count: vPaths.length })}</span>
        </div>
      )}

      {tab === "aggregate" && folders.map(g => {
        const isOpen = expanded.has(g.folder);
        return (
          <div key={g.folder} className="rounded">
            <div className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-[var(--color-hover)]">
              <button type="button" onClick={() => toggle(g.folder)} className="shrink-0 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]" title={isOpen ? t("monitor.collapseTip") : t("monitor.expandTip")}>
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <span className="min-w-0 flex-1"><PathSegments display={shortenPath(g.folder)} pending={allowing === g.folder || !scopeChosen} onAllow={onAllowPath} /></span>
              {g.wouldBlock > 0 && <WouldBlockTag on />}
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-fg-faint)]" title={t("monitor.opsTip")}>{[...g.ops].join(" ")}</span>
              <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{t(g.entries.length === 1 ? "monitor.folderFilesOne" : "monitor.folderFilesOther", { count: g.entries.length, times: g.count })}</span>
            </div>
            {isOpen && (
              <ul className="ml-5 flex flex-col border-l border-[var(--color-border-soft)] pl-2">
                {[...g.entries].sort(byBlockPath).map(p => (
                  <li key={p.path + p.op} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-[var(--color-hover)]">
                    <OpBadge op={p.op} />
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[12px] text-[var(--color-fg)]" title={p.path}>{fileName(p.path)}</span>
                    {p.would_block && <WouldBlockTag on />}
                    <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{p.count}×</span>
                    {allowButton(p.path, "path")}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {tab === "detailed" && (() => {
        const CAP = 400;
        const all = [...vPaths].sort(byBlockPath);
        return (<>
          <ul className="flex flex-col">
            {all.slice(0, CAP).map(p => (
              <li key={p.path + p.op} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-hover)]">
                <OpBadge op={p.op} />
                <span className="min-w-0 flex-1"><PathSegments display={shortenPath(p.path)} pending={allowing === p.path || !scopeChosen} onAllow={onAllowPath} /></span>
                {p.would_block && <WouldBlockTag on />}
                <CopyButton value={p.path} title={t("denied.copyFullPathTip")} />
                <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">
                  {p.last_proc && <span className="mr-2 font-mono text-[var(--color-fg-dim)]">{p.last_proc}({p.last_pid})</span>}
                  {p.count}× · {relTime(p.last_seen_unix_ms)}
                </span>
              </li>
            ))}
          </ul>
          {all.length > CAP && <div className="px-1 py-1 text-[11px] text-[var(--color-fg-faint)]">{t("monitor.shownCap", { cap: CAP, total: all.length })}</div>}
        </>);
      })()}

      <div className="mt-2 px-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">
        <Trans t={t} i18nKey="monitor.footerNote" components={{ warn: <span className="text-[var(--color-warn)]" /> }} />
      </div>
    </div>
  );
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const { t } = useTranslation("task");
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" title={copied ? t("common:copied") : title}
      onClick={e => {
        e.stopPropagation();
        writeClipboardText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
      }}
      className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]">
      {copied ? <Check size={12} className="text-[var(--color-ok)]" /> : <Copy size={12} />}
    </button>
  );
}

/** `$HOME/Library/Keychains` or anything under it, in shortenPath's form: a
 *  deny there in a blocked task is the block working, so it has no Allow. */
function underKeychains(display: string): boolean {
  return display === "$HOME/Library/Keychains" || display.startsWith("$HOME/Library/Keychains/");
}

/** Clickable path segments: a click allows the prefix up to and including
 *  that segment, so a parent dir is one click instead of a retype. */
function PathSegments({ display, onAllow, pending }: { display: string; onAllow: (prefix: string) => void; pending: boolean }) {
  const { t } = useTranslation("task");
  const [hovered, setHovered] = useState<number | null>(null);
  const absolute = display.startsWith("/");
  const parts = display.split("/").filter(Boolean);
  const prefixAt = (i: number) => (absolute ? "/" : "") + parts.slice(0, i + 1).join("/");
  return (
    <span className="flex min-w-0 flex-nowrap items-center gap-0 overflow-hidden whitespace-nowrap font-mono text-[12px] text-[var(--color-fg)]" onMouseLeave={() => setHovered(null)}>
      {parts.map((seg, i) => {
        const isPrefix = hovered !== null && i <= hovered;
        const isSuffix = hovered !== null && i > hovered;
        return (
          <span key={i} className="flex items-center">
            {i > 0 && <span className={cn("select-none px-0.5 text-[var(--color-fg-faint)]", isSuffix && "opacity-40")}>/</span>}
            <button type="button" onMouseEnter={() => setHovered(i)} onClick={() => onAllow(prefixAt(i))} disabled={pending || tooBroad(prefixAt(i), absolute, i)}
              title={tooBroad(prefixAt(i), absolute, i) ? t("activity.folderTooBroad") : t("denied.allowPrefixTip", { prefix: prefixAt(i) })}
              className={cn("rounded px-1 transition-colors disabled:opacity-50",
                isPrefix && "bg-[var(--color-ok)]/15 text-[var(--color-fg)]",
                isSuffix && "text-[var(--color-fg-faint)] opacity-40",
                hovered === null && "hover:bg-[var(--color-hover)]")}>{seg}</button>
          </span>
        );
      })}
    </span>
  );
}

// coarse on purpose, so rows do not flicker on every 1.5s poll.
function relTime(unixMs: number): string {
  const s = Math.floor(Math.max(0, Date.now() - unixMs) / 1000);
  if (s < 30) return i18n.t("task:monitor.relJustNow");
  const m = Math.floor(s / 60);
  if (m < 5) return i18n.t("task:monitor.relUnder5m");
  if (m < 60) return i18n.t("task:monitor.relMinutes", { minutes: Math.round(m / 5) * 5 });
  const h = Math.floor(m / 60);
  if (h < 24) return i18n.t("task:monitor.relHours", { hours: h });
  const d = Math.floor(h / 24);
  return d === 1 ? i18n.t("task:monitor.relYesterday") : i18n.t("task:monitor.relDays", { days: d });
}
