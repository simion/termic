// Env vars agent tabs do not inherit from Termic's own environment
// (env_guard.rs): the card on the Secrets tab, and the per-agent list on an
// agent's card. Names only: no value, or any part of one, ever reaches here.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Shield, X } from "lucide-react";
import { agentSetPassEnv, envGuardList, envGuardSave } from "@/lib/ipc";
import type { Agent, EnvGuardRule, KeptOutVar } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@/components/ui/Popover";
import { cn } from "@/lib/utils";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The rules that reproduce `rows`: every added name, and every scope
 *  widened to all agents. A caged-only built-in or detected var needs none. */
const rulesOf = (rows: KeptOutVar[]): EnvGuardRule[] =>
  rows.filter(r => r.reason === "added" || r.all).map(r => ({ name: r.name, all: r.all }));

const agentName = (agents: Agent[], id: string) => agents.find(a => a.id === id)?.display_name || id;

export function KeptOutCard({ onAddSecret }: { onAddSecret: (name: string, preset: NonNullable<KeptOutVar["preset"]>) => void }) {
  const { t } = useTranslation("secrets");
  const [rows, setRows] = useState<KeptOutVar[] | null>(null);
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);
  const [popFor, setPopFor] = useState<string | null>(null);
  const agents = useApp(s => s.agents);
  // ponytail: terminal-kind entries are left out of pass-through; a caged
  // custom terminal that needs a var is rare enough to wait for.
  const passable = agents.filter(a => !a.disabled && a.kind !== "terminal");
  useEffect(() => { envGuardList().then(setRows).catch(() => setRows([])); }, []);

  async function save(next: EnvGuardRule[]): Promise<boolean> {
    try {
      setRows(await envGuardSave(next));
      return true;
    } catch (e) {
      useUI.getState().pushToast(t("manage.keptOut.saveFailed", { why: String(e) }), "error");
      return false;
    }
  }

  async function add() {
    const name = draft.trim();
    if (!rows || !name) return;
    if (!ENV_NAME.test(name)) { setBad(true); return; }
    if (rows.some(r => r.name === name)) { setDraft(""); return; }
    // a name added by hand defaults to every agent: adding it was the point
    if (await save([...rulesOf(rows), { name, all: true }])) setDraft("");
  }

  function togglePass(agentId: string, name: string, on: boolean) {
    const all = useApp.getState().agents;
    const a = all.find(x => x.id === agentId);
    if (!a) return;
    const next = (a.pass_env ?? []).filter(n => n !== name).concat(on ? [name] : []);
    useApp.setState({ agents: all.map(x => x.id === agentId ? { ...x, pass_env: next } : x) });
    agentSetPassEnv(agentId, next).catch(e =>
      useUI.getState().pushToast(t("manage.keptOut.saveFailed", { why: String(e) }), "error"));
  }

  if (!rows) return null;
  return (
    <section data-testid="secrets-kept-out" className="flex gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] px-4 py-3.5">
      <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{t("manage.keptOut.title", { n: rows.length })}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.keptOut.body")}</div>
        <div className="mt-3 flex flex-col">
          {rows.map(r => {
            const passedTo = passable.filter(a => a.pass_env?.includes(r.name));
            const status = [
              !r.set && t("manage.keptOut.notSet"),
              t(r.all ? "manage.keptOut.scopeAll" : "manage.keptOut.scopeCaged"),
              passedTo.length > 0 && t("manage.keptOut.passedTo", { agents: passedTo.map(a => a.display_name || a.id).join(", ") }),
              r.own_login_of.length > 0 && t("manage.keptOut.ownLogin", { agents: r.own_login_of.map(id => agentName(agents, id)).join(", ") }),
            ].filter(Boolean).join(" · ");
            return (
              <div key={r.name} data-testid={`kept-out-row-${r.name}`} className="flex min-h-[52px] items-center gap-3 border-t border-[var(--color-border-soft)] py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-[12px] text-[var(--color-fg)]">{r.name}</code>
                    <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-px text-[11px] text-[var(--color-fg-dim)]">
                      {t(`manage.keptOut.reason.${r.reason}`)}
                    </span>
                  </div>
                  <div data-testid={`kept-out-status-${r.name}`} className={cn("mt-0.5 text-[12px]", passedTo.length > 0 ? "text-[var(--color-warn)]" : "text-[var(--color-fg-dim)]")}>
                    {status}
                  </div>
                </div>
                <div role="group" aria-label={t("manage.keptOut.scopeLabel")} data-testid={`kept-out-scope-${r.name}`} className="inline-flex shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
                  {([false, true] as const).map(all => (
                    <button
                      key={String(all)}
                      type="button"
                      aria-pressed={r.all === all}
                      data-value={all ? "all" : "caged"}
                      onClick={() => { if (r.all !== all) void save(rulesOf(rows.map(x => x.name === r.name ? { ...x, all } : x))); }}
                      className={cn(
                        "h-6 rounded-[5px] px-2.5 text-[12px]",
                        r.all === all ? "bg-[var(--color-accent-deep)] text-white" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                      )}
                    >
                      {t(all ? "manage.keptOut.allAgents" : "manage.keptOut.caged")}
                    </button>
                  ))}
                </div>
                <div className="flex w-[118px] shrink-0 justify-end">
                  {r.preset && (
                    <Button variant="primary" size="sm" className="text-[12px]" data-testid={`kept-out-add-secret-${r.name}`} onClick={() => onAddSecret(r.name, r.preset!)}>
                      {t("manage.keptOut.addSecret")}
                    </Button>
                  )}
                </div>
                <PopoverRoot open={popFor === r.name} onOpenChange={o => setPopFor(o ? r.name : null)}>
                  <PopoverTrigger asChild>
                    <Button size="sm" className="shrink-0 text-[12px]" data-testid={`kept-out-pass-${r.name}`}>
                      {t("manage.keptOut.passThrough")}<ChevronDown className="h-3 w-3" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent side="bottom" align="end" className="flex w-[290px] flex-col gap-2">
                    <div className="text-[13px] font-medium">{t("manage.keptOut.passTitle", { name: r.name })}</div>
                    <div className="-mr-2 flex max-h-64 flex-col overflow-y-auto pr-2" data-testid={`kept-out-pass-list-${r.name}`}>
                      {passable.map(a => {
                        const on = !!a.pass_env?.includes(r.name);
                        return (
                          <label key={a.id} className="flex min-h-8 cursor-pointer items-center gap-2.5 text-[13px]">
                            <Checkbox checked={on} onChange={v => togglePass(a.id, r.name, v)} data-testid={`kept-out-pass-${r.name}-${a.id}`} />
                            {a.display_name || a.id}
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-[12px] text-[var(--color-fg-dim)]">{t("manage.keptOut.passNote")}</p>
                    <div className="flex justify-end">
                      <Button size="sm" className="text-[12px]" onClick={() => setPopFor(null)}>{t("manage.keptOut.done")}</Button>
                    </div>
                  </PopoverContent>
                </PopoverRoot>
                <div className="w-7 shrink-0">
                  {r.reason === "added" && (
                    <Button variant="icon" size="icon" aria-label={t("manage.keptOut.remove", { name: r.name })} data-testid={`kept-out-remove-${r.name}`}
                      onClick={() => void save(rulesOf(rows.filter(x => x.name !== r.name)))}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          <form className="flex items-center gap-2 border-t border-[var(--color-border-soft)] pt-3" onSubmit={e => { e.preventDefault(); void add(); }}>
            <Input
              value={draft}
              onChange={e => { setDraft(e.target.value); setBad(false); }}
              placeholder={t("manage.keptOut.addPlaceholder")}
              aria-label={t("manage.keptOut.addLabel")}
              aria-invalid={bad}
              data-testid="kept-out-add-input"
              className="h-8 font-mono text-[12px]"
            />
            <Button type="submit" size="sm" className="text-[12px]" data-testid="kept-out-add">{t("manage.keptOut.add")}</Button>
          </form>
          {bad && <div className="mt-1 text-[12px] text-[var(--color-err)]">{t("manage.keptOut.badName")}</div>}
        </div>
      </div>
    </section>
  );
}

/** One agent's view, for its card in Settings > Agents: the kept-out vars
 *  Termic actually has, and whether this agent gets each. Hidden when there
 *  are none, which is every Dock launch. */
export function InheritedEnv({ agent, onPassEnv }: { agent: Agent; onPassEnv: (names: string[]) => void }) {
  const { t } = useTranslation("settings");
  const [rows, setRows] = useState<KeptOutVar[]>([]);
  useEffect(() => { envGuardList().then(rs => setRows(rs.filter(r => r.set))).catch(() => {}); }, []);
  if (rows.length === 0) return null;
  const pass = agent.pass_env ?? [];
  return (
    <div className="flex flex-col gap-2" data-testid={`agent-inherited-env-${agent.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-medium">{t("agents.card.inheritedLabel")}</div>
        <button type="button" className="text-[12px] text-[var(--color-accent)] hover:underline" onClick={() => useApp.getState().openSettings("secrets")}>
          {t("agents.card.inheritedEdit")}
        </button>
      </div>
      <div className="rounded-md border border-[var(--color-border-soft)]">
        {rows.map((r, i) => {
          const own = r.own_login_of.includes(agent.id);
          const passed = pass.includes(r.name);
          const status = own
            ? t("agents.card.inheritedOwn", { agent: agent.display_name || agent.id })
            : passed ? t("agents.card.inheritedPassed")
            : t(r.all ? "agents.card.inheritedKeptAll" : "agents.card.inheritedKeptCaged");
          return (
            <div key={r.name} data-testid={`agent-inherited-${agent.id}-${r.name}`} className={cn("flex min-h-11 items-center gap-3 px-3", i > 0 && "border-t border-[var(--color-border-soft)]")}>
              <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.name}</code>
              <span className={cn("shrink-0 text-[12.5px]", passed && !own ? "text-[var(--color-warn)]" : "text-[var(--color-fg-dim)]")}>{status}</span>
              {!own && (
                <Button size="sm" className="min-w-[104px] shrink-0 text-[12px]" data-testid={`agent-inherited-toggle-${agent.id}-${r.name}`}
                  onClick={() => onPassEnv(passed ? pass.filter(n => n !== r.name) : [...pass, r.name])}>
                  {t(passed ? "agents.card.inheritedKeepOut" : "agents.card.inheritedPass")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-[12px] text-[var(--color-fg-dim)]">{t("agents.card.inheritedHint")}</div>
    </div>
  );
}
