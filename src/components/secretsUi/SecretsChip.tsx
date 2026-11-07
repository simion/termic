// Footer surfaces for Secrets: the "<Role> · N blocked" chip and its
// popover, and the notice on a task whose role cannot apply because nothing
// blocks its Keychain. FooterBar owns the 2s poll and hands counts down; the
// popover fetches the event lists only while it is open.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, Check, Eye, KeyRound, Pause, Play, ShieldCheck } from "lucide-react";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { AllowScopePicker } from "@/components/ui/AllowScopePicker";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";
import { i18n } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import { effectiveSandboxMode, type BrokerCounts, type BrokerEvents, type Role, type SandboxMode, type Task } from "@/lib/types";
import { allowRuleFor, roleColour, roleDefault, roleToStore, suspiciousKey } from "@/lib/secretsUi";
import { tasksByRole } from "@/components/settings/secretsSettings/model";
import { restartTaskAgents } from "@/lib/accountRestart";
import { taskLabel } from "@/lib/taskLabel";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { useSecrets } from "@/store/secrets";

type ChipTask = Pick<Task, "id" | "project_id" | "name" | "branch"> & Partial<Omit<Task, "id" | "project_id" | "name" | "branch">>;

const USED_WINDOW_MS = 15 * 60 * 1000;

// same buckets as TerminalPane's deny popover (task:monitor.rel*).
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

const EMPTY_EVENTS: BrokerEvents = { used: [], blocked: [], no_secret: [], suspicious: [] };

/** Save a role pick for a live task, then say what it does and does not do:
 *  deliveries are set up at spawn, so the running agent keeps its old ones. */
async function switchRole(task: ChipTask, pick: string, roles: Role[]) {
  const st = useApp.getState();
  const def = roleDefault(st.projects.find(p => p.id === task.project_id), st.agents.find(a => a.id === task.cli));
  try {
    await ipc.taskSetRole(task.id, roleToStore(pick, def));
    await st.loadAll();
    const name = pick ? roles.find(r => r.id === pick)?.name ?? pick : i18n.t("secrets:task.noSecrets");
    useUI.getState().pushToast(i18n.t("secrets:task.switchedToast", { role: name }), "success", {
      action: { label: i18n.t("dialogs:editTask.restartAgents"), onClick: () => { restartTaskAgents(task.id); } },
    });
  } catch (e) {
    useUI.getState().pushToast(String(e), "error");
  }
}

export function SecretsChip({ task, role: saved, counts }: { task: ChipTask; role: Role; counts: BrokerCounts | null }) {
  const { t } = useTranslation("secrets");
  const roles = useSecrets(s => s.roles);
  const secrets = useSecrets(s => s.secrets);
  const secretName = (id: string) => secrets.find(x => x.id === id)?.name ?? id;
  // what the broker is ENFORCING, which is not the saved pick after a switch
  // (a role applies at spawn), nor the primary agent's default for a second
  // agent. Saved resolution only stands in while nothing is live.
  const live = counts?.roles ?? [];
  const role = (live.length ? roles.find(r => r.id === live[0]) : undefined) ?? saved;
  const switched = live.length > 0 && !live.includes(saved.id);
  // the same role, edited since the agent started: secret bindings are set
  // up at spawn, so a swapped or added secret only lands on restart.
  const pending = switched || !!counts?.stale;
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<BrokerEvents>(EMPTY_EVENTS);
  const [scope, setScope] = useState<"task" | "role">("role");
  const [busy, setBusy] = useState<string | null>(null);
  // optimistic until the next poll agrees.
  const [pausedLocal, setPausedLocal] = useState<boolean | null>(null);
  const paused = pausedLocal ?? !!counts?.paused;
  useEffect(() => { if (counts && pausedLocal === counts.paused) setPausedLocal(null); }, [counts, pausedLocal]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // an open popover polls every 1.5s; keep the old object when nothing
    // moved so the lists do not re-render on every tick.
    const tick = () => ipc.brokerEvents(task.id)
      .then(e => { if (!cancelled) setEvents(prev => (JSON.stringify(prev) === JSON.stringify(e) ? prev : e)); })
      .catch(() => {});
    void tick();
    const id = window.setInterval(tick, 1500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, task.id]);

  const colour = roleColour(role.colour);
  const suspicious = counts?.suspicious ?? 0;
  const blocked = counts?.blocked ?? 0;
  // computed when the popover renders, not subscribed: a count in a popover
  // does not need to follow every task write.
  const roleTasks = open ? (() => {
    const st = useApp.getState();
    return tasksByRole(st.tasks, st.projects, st.agents, roles).get(role.id)?.length ?? 0;
  })() : 0;
  const scopeLabel = scope === "task" ? t("task.scopeTask") : t("task.scopeRole", { role: role.name });

  async function allow(b: BrokerEvents["blocked"][number]) {
    const rule = allowRuleFor(b);
    if (!rule) return;
    const key = `${b.role}|${b.secret}|${b.host}|${b.method}|${b.path}`;
    setBusy(key);
    try {
      // Rust refuses a pattern with a glob in it too; its error lands in the
      // toast below and the row stays.
      // the role the spawn ran with when it was blocked, not the saved pick:
      // after a switch they differ, and only the running one can use it now.
      await ipc.brokerAllow(task.id, scope, b.secret, b.host, rule, scope === "role" ? b.role : null);
      setEvents(e => ({ ...e, blocked: e.blocked.filter(x => x !== b) }));
      useUI.getState().pushToast(t("task.allowedToast", { what: `${b.method} ${b.path}`, scope: scopeLabel }), "success");
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    } finally { setBusy(null); }
  }

  async function togglePause() {
    const next = !paused;
    setPausedLocal(next);
    try { await ipc.brokerSetPaused(task.id, next); }
    catch (e) { setPausedLocal(null); useUI.getState().pushToast(String(e), "error"); }
  }

  const used = events.used.filter(u => Date.now() - u.last_seen_unix_ms < USED_WINDOW_MS);
  const nothing = events.used.length + events.blocked.length + events.no_secret.length + events.suspicious.length === 0;

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="secrets-chip"
          data-role={role.id}
          data-saved-role={saved.id}
          data-suspicious={suspicious > 0 || undefined}
          onClick={e => e.stopPropagation()}
          title={t("task.chipTip", { role: role.name })}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--color-bg-2)]",
            suspicious > 0 && "bg-[var(--color-err)]/10",
          )}
        >
          <KeyRound className="h-3.5 w-3.5" style={{ color: suspicious > 0 ? "var(--color-err)" : colour }} />
          <span className="text-[var(--color-fg-dim)] @max-[560px]:hidden">{role.name}</span>
          {suspicious > 0 ? (
            <span className="text-[var(--color-err)]">· {t("task.chipSuspicious", { count: suspicious })}</span>
          ) : paused ? (
            <span className="text-[var(--color-warn)]">· {t("task.chipPaused")}</span>
          ) : blocked > 0 ? (
            <span className="text-[var(--color-warn)]">· {t("task.chipBlocked", { count: blocked })}</span>
          ) : null}
          {pending && <span data-testid="secrets-chip-pending" className="text-[var(--color-fg-faint)] @max-[560px]:hidden">· {t("task.pendingRestart")}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[460px] max-w-[calc(100vw-2rem)] max-h-[560px] overflow-auto p-3 text-[12px]">
        <div data-testid="secrets-popover" className="flex flex-col gap-2.5">
          <div className="flex items-center gap-1.5">
            <KeyRound className="h-4 w-4" style={{ color: suspicious > 0 ? "var(--color-err)" : colour }} />
            <span className="text-[13px] font-semibold text-[var(--color-fg)]">{t("task.popoverTitle")}</span>
            <span className="text-[var(--color-fg-faint)]">{t("task.popoverRole")}</span>
            <button
              type="button"
              data-testid="secrets-role-link"
              onClick={() => { setOpen(false); useApp.getState().openSettings("secrets", undefined, `role:${role.id}`); }}
              title={t("task.editRoleTip")}
              className="text-[13px] hover:underline"
              style={{ color: colour }}
            >{role.name}</button>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                data-testid="secrets-pause"
                onClick={togglePause}
                title={t("task.pauseTip")}
                className="flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
              >
                {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                {paused ? t("task.resume") : t("task.pause")}
              </button>
              <DropdownRoot>
                <DropdownTrigger asChild>
                  <button type="button" data-testid="secrets-switch-role" className="flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
                    {t("task.switchRole")}<ChevronDown className="h-3 w-3" />
                  </button>
                </DropdownTrigger>
                <DropdownMenu align="end">
                  {[{ id: "", name: t("task.noSecrets"), colour: null as string | null }, ...roles.map(r => ({ id: r.id, name: r.name, colour: roleColour(r.colour) }))].map(r => (
                    <DropdownItem key={r.id || "none"} data-role-option={r.id || "none"} onSelect={() => { if (r.id !== saved.id) void switchRole(task, r.id, roles); }}>
                      <span className="flex items-center gap-2 text-[13px]">
                        <span className="h-2 w-2 rounded-full" style={{ background: r.colour ?? "transparent", border: r.colour ? undefined : "1px dashed var(--color-fg-faint)" }} />
                        {r.name}
                        {r.id === saved.id && <Check className="h-3.5 w-3.5 text-[var(--color-fg-dim)]" />}
                      </span>
                    </DropdownItem>
                  ))}
                  <DropdownSeparator />
                  <div className="max-w-[240px] px-2 py-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">{t("task.switchNeedsRestart")}</div>
                </DropdownMenu>
              </DropdownRoot>
            </div>
          </div>

          {suspicious > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-2.5 py-2 text-[var(--color-fg-dim)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-err)]" />
              <span>{t("task.suspiciousBanner")}</span>
            </div>
          ) : paused ? (
            <div data-testid="secrets-paused-banner" className="flex items-start gap-2 rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-2.5 py-2 text-[var(--color-fg-dim)]">
              <Pause className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
              <span>{t("task.pausedBanner")}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-[var(--color-ok)]/30 bg-[var(--color-ok)]/10 px-2.5 py-2 text-[var(--color-fg-dim)]">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
              <span>{t("task.popoverBrokered")}</span>
            </div>
          )}
          {counts && counts.live === 0 && (
            <div className="text-[11.5px] text-[var(--color-fg-faint)]">{t("task.notLiveYet")}</div>
          )}
          {pending && (
            <div data-testid="secrets-pending-banner" className="flex items-center gap-2 text-[11.5px] text-[var(--color-fg-dim)]">
              <span className="flex-1">{switched ? t("task.pendingBanner", { saved: saved.name, running: role.name }) : t("task.staleBanner", { role: role.name })}</span>
              <button
                type="button"
                onClick={() => { setOpen(false); restartTaskAgents(task.id); }}
                className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] hover:text-[var(--color-fg)]"
              >{i18n.t("dialogs:editTask.restartAgents")}</button>
            </div>
          )}

          <AllowScopePicker
            testId="secrets-scope"
            options={[
              { id: "task" as const, label: t("task.scopeTask"), hint: t("task.scopeTaskHint") },
              { id: "role" as const, label: t("task.scopeRole", { role: role.name }), hint: roleTasks === 1 ? t("task.scopeRoleHint_one", { count: roleTasks }) : t("task.scopeRoleHint_other", { count: roleTasks }) },
            ]}
            value={scope}
            onChange={setScope}
            heading={t("task.saveTo")}
            savingTo={t("task.savingTo")}
            change={t("task.change")}
            changeTip={t("task.changeScopeTip")}
          />

          {events.suspicious.length > 0 && (
            <Section title={t("task.sectionSuspicious")} count={events.suspicious.length} tone="err">
              {events.suspicious.map(s => (
                <Row key={`${s.kind}|${s.host}|${s.detail}`} meta={`${s.count}× · ${relTime(s.last_seen_unix_ms)}`}>
                  <div className="font-medium text-[var(--color-fg)]">{t(suspiciousKey(s.kind))}</div>
                  <div className="break-all font-mono text-[11.5px] text-[var(--color-fg-dim)]">{[s.host, s.detail].filter(Boolean).join(" · ")}</div>
                  {s.kind === "placeholder_unbound_host" && (
                    <div className="text-[11.5px] text-[var(--color-fg-faint)]">{t("task.suspPlaceholderNote")}</div>
                  )}
                </Row>
              ))}
            </Section>
          )}

          {events.blocked.length > 0 && (
            <Section title={t("task.sectionBlocked")} count={events.blocked.length} tone="warn">
              {events.blocked.map(b => {
                const key = `${b.role}|${b.secret}|${b.host}|${b.method}|${b.path}`;
                return (
                  <Row
                    key={key}
                    meta={`${b.count}× · ${relTime(b.last_seen_unix_ms)}`}
                    action={allowRuleFor(b) && (
                      <button
                        type="button"
                        data-testid="secrets-allow"
                        disabled={busy === key}
                        onClick={() => void allow(b)}
                        title={t("task.allowTip", { scope: scopeLabel })}
                        className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)] disabled:opacity-50"
                      >{busy === key ? "…" : t("task.allow")}</button>
                    )}
                  >
                    <div className="break-all font-mono text-[var(--color-fg)]">{b.method} {b.path}</div>
                    <div className="text-[11.5px] text-[var(--color-fg-faint)]">{b.host} · {secretName(b.secret)}</div>
                  </Row>
                );
              })}
            </Section>
          )}

          {events.no_secret.length > 0 && (
            <Section title={t("task.sectionNoSecret")} count={events.no_secret.length} tone="info">
              {events.no_secret.map(n => (
                <Row
                  key={n.host}
                  meta={`${n.count}× · ${relTime(n.last_seen_unix_ms)}`}
                  action={(
                    <button
                      type="button"
                      onClick={() => { setOpen(false); useApp.getState().openSettings("secrets"); }}
                      title={t("task.grantTip")}
                      className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
                    >{t("task.grant")}</button>
                  )}
                >
                  <div className="break-all font-mono text-[var(--color-fg)]">{n.host}</div>
                  <div className="text-[11.5px] text-[var(--color-fg-faint)]">{t("task.noSecretNote")}</div>
                </Row>
              ))}
            </Section>
          )}

          {used.length > 0 && (
            <Section title={t("task.sectionUsed")} tone="faint">
              {used.map(u => (
                <Row
                  key={`${u.secret}|${u.host}|${u.role}`}
                  meta={u.methods.map(([m, n]) => `${m} ${n}`).join(" · ")}
                  action={<Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />}
                >
                  <div className="font-mono text-[var(--color-fg)]">{secretName(u.secret)} → {u.host}</div>
                </Row>
              ))}
            </Section>
          )}

          {nothing && <div className="px-0.5 text-[var(--color-fg-faint)]">{t("task.nothingYet")}</div>}

          <div className="border-t border-[var(--color-border-soft)] pt-2 text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
            {t("task.popoverFooter")}
          </div>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

function Section({ title, count, tone, children }: { title: string; count?: number; tone: "err" | "warn" | "info" | "faint"; children: React.ReactNode }) {
  const colour = tone === "err" ? "var(--color-err)" : tone === "warn" ? "var(--color-warn)" : tone === "info" ? "var(--color-info)" : "var(--color-fg-faint)";
  return (
    <div className="flex flex-col">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: colour }}>
        {title}{count !== undefined && ` · ${count}`}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

function Row({ meta, action, children }: { meta: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 border-b border-[var(--color-border-soft)] py-1.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      <span className="shrink-0 pt-0.5 text-[11px] text-[var(--color-fg-faint)]">{meta}</span>
      {action}
    </li>
  );
}

/** M6: the task has a role (its own or a default) but nothing blocks its
 *  Keychain, so the broker never runs and the agent could read the real
 *  item itself. One click turns on the cage AND the block. */
export function NoKeychainChip({ task, role }: { task: ChipTask; role: Role }) {
  const { t } = useTranslation("secrets");
  const { t: tTask } = useTranslation("task");
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const [busy, setBusy] = useState(false);
  const mode: SandboxMode = effectiveSandboxMode(task);
  const enforced = mode === "enforce" || mode === "enforce-fs";
  const sandboxText =
    (mode === "off" ? tTask("footer.sandboxOff")
      : mode === "monitor" ? tTask("footer.sandboxMonitor")
      : mode === "enforce-fs" ? tTask("footer.sandboxEnforceFs")
      : tTask("footer.sandboxEnforce"))
    + (enforced ? t("task.keychainOpenSuffix") : "");

  async function fix() {
    if (busy) return;
    const name = taskLabel(task as Task, useBranchAsTaskName);
    const ok = await useUI.getState().askConfirm({
      title: t("task.fixConfirmTitle", { name }),
      message: t("task.fixConfirmBody", {
        agent: useApp.getState().agents.find(a => a.id === task.cli)?.display_name || (task.cli ?? ""),
      }),
      confirmLabel: t("task.fixConfirm"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      // keep Enforce (network cage) when the task already has it; anything
      // weaker goes to Enforce FS, the mode M6 names.
      const next: SandboxMode = mode === "enforce" ? "enforce" : "enforce-fs";
      let rw = task.sandbox_rw_paths ?? [];
      let hosts = task.sandbox_allowed_hosts ?? [];
      // same seeding as TaskSandboxDialog.chooseMode: a cage turned on from
      // scratch starts from the global + project defaults, not empty.
      if (!rw.length && !hosts.length) {
        const s = await ipc.settingsLoad().catch(() => null);
        const p = useApp.getState().projects.find(x => x.id === task.project_id);
        const merge = (...ls: (string[] | undefined)[]) => [...new Set(ls.flatMap(l => l ?? []).filter(Boolean))];
        rw = merge(s?.sandbox_default_rw_paths, p?.sandbox_rw_paths);
        hosts = merge(s?.sandbox_default_allowed_hosts, p?.sandbox_allowed_hosts);
      }
      useUI.getState().markPendingPtyRestart(task.id);
      await ipc.taskSetSandbox(task.id, next, rw, hosts, true, true);
      await useApp.getState().loadAll();
    } catch (e) {
      useUI.getState().pushToast(String(e), "error");
    } finally { setBusy(false); }
  }

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="secrets-uncaged-chip"
          onClick={e => e.stopPropagation()}
          title={t("task.uncagedTitle")}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)]"
        >
          <KeyRound className="h-3.5 w-3.5" />
          <span className="@max-[560px]:hidden">{t("task.noSecrets")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] max-w-[calc(100vw-2rem)] border-[var(--color-warn)]/50 p-3 text-[12.5px]">
        <div data-testid="secrets-uncaged-popover" className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--color-warn)]">
            <Eye className="h-3.5 w-3.5" />
            {t("task.uncagedTitle")}
          </div>
          <p className="leading-snug text-[var(--color-fg-dim)]">
            {t("task.uncagedBody", { name: taskLabel(task as Task, useBranchAsTaskName), sandbox: sandboxText, role: role.name })}
          </p>
          <button
            type="button"
            data-testid="secrets-uncaged-fix"
            disabled={busy}
            onClick={() => void fix()}
            className="self-start rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[12.5px] font-medium text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-50"
          >
            {mode === "enforce" ? t("task.fixBlockOnly") : t("task.fixEnforceFs")}
          </button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
