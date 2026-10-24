// Roles tab (mock M2): the roles x secrets matrix and the selected role's
// editor (name, colour, description, rule blocks per secret and host).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, Copy, Eye, EyeOff, GripVertical, Plus, Trash2, X } from "lucide-react";
import type { Role, Rule, RuleEffect, RuleSet, SecretDef } from "@/lib/types";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { DropdownItem, DropdownMenu, DropdownRoot, DropdownTrigger } from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";
import {
  ROLE_COLOURS, defaultsFor, duplicateRole, hostConflicts, loginTakeovers, putRuleSet, roleColourVar, roleFromTemplate, ruleBlocksFor, ruleSetFor,
  tasksByRole, toggleSecret, type RoleTemplate,
} from "./model";
import { CommitInput, Eyebrow, RoleDot } from "./parts";
import type { SecretsModel } from "./SecretsSection";

export function RolesTab({ model, initialRole }: { model: SecretsModel; initialRole?: string | null }) {
  const { t } = useTranslation("secrets");
  const { secrets, roles } = model;
  const [selected, setSelected] = useState<string | null>(initialRole ?? roles[0]?.id ?? null);
  // A deleted role (or a first load) leaves nothing picked; fall to the first.
  useEffect(() => {
    if (!selected || !roles.some(r => r.id === selected)) setSelected(roles[0]?.id ?? null);
  }, [roles, selected]);

  const tasks = useApp(s => s.tasks);
  const projects = useApp(s => s.projects);
  const agents = useApp(s => s.agents);
  const byRole = useMemo(() => tasksByRole(tasks, projects, agents, roles), [tasks, projects, agents, roles]);

  const saveRole = (next: Role) => model.save({ roles: roles.map(r => r.id === next.id ? next : r) });

  function toggle(role: Role, secretId: string, on: boolean) {
    const next = toggleSecret(role, secretId, on);
    const dup = hostConflicts(next.secrets, secrets);
    if (dup.length) {
      useUI.getState().pushToast(t("manage.roles.conflict", { role: role.name, hosts: dup.join(", ") }), "error");
      return;
    }
    void saveRole(next);
  }

  async function create(tpl: RoleTemplate) {
    // i18n.t, not the hook's t: the template's names and notes are stored
    // data, minted once in the current language.
    // the templates' rules are GitHub's; an API key secret that happens to
    // be listed first must not be bound to a role the user did not aim at it.
    const gh = secrets.find(s => s.recipe === "github");
    const role = roleFromTemplate(tpl, crypto.randomUUID(), gh, roles.map(r => r.colour), k => i18n.t(`secrets:${k}`));
    if (await model.save({ roles: [...roles, role] })) setSelected(role.id);
  }

  async function duplicate(role: Role) {
    const copy = duplicateRole(role, crypto.randomUUID(), roles,
      (name, n) => i18n.t(n === 1 ? "secrets:manage.editor.copyName" : "secrets:manage.editor.copyNameN", { name, n }));
    if (await model.save({ roles: [...roles, copy] })) setSelected(copy.id);
  }

  async function remove(role: Role) {
    const ok = await useUI.getState().askConfirm({
      title: t("manage.editor.deleteTitle", { name: role.name }),
      message: t("manage.editor.deleteMessage"),
      confirmLabel: t("manage.editor.delete"),
      destructive: true,
    });
    if (ok) await model.save({ roles: roles.filter(r => r.id !== role.id) });
  }

  const running = (n: number) => n === 1 ? t("manage.roles.running_one", { count: n }) : t("manage.roles.running_other", { count: n });
  const sel = roles.find(r => r.id === selected) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-[13px] text-[var(--color-fg-dim)]">{t("manage.roles.intro")}</p>

      <div className="flex items-center justify-between">
        <Eyebrow>{t("manage.roles.heading", { count: roles.length })}</Eyebrow>
        <DropdownRoot>
          <DropdownTrigger asChild>
            <Button variant="primary" data-testid="roles-new"><Plus className="h-4 w-4" /> {t("manage.roles.new")} <ChevronDown className="h-3.5 w-3.5" /></Button>
          </DropdownTrigger>
          <DropdownMenu>
            <DropdownItem data-role-template="empty" onSelect={() => void create("empty")}>{t("manage.tpl.menuEmpty")}</DropdownItem>
            <DropdownItem data-role-template="reviewer" onSelect={() => void create("reviewer")}>{t("manage.tpl.menuReviewer")}</DropdownItem>
            <DropdownItem data-role-template="maintainer" onSelect={() => void create("maintainer")}>{t("manage.tpl.menuMaintainer")}</DropdownItem>
          </DropdownMenu>
        </DropdownRoot>
      </div>

      {secrets.length === 0 && (
        <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.roles.noSecretsYet")}</div>
      )}

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-left text-[13px]" data-testid="roles-matrix">
          <thead className="bg-[var(--color-bg-1)] text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
            <tr>
              <th className="px-3 py-2.5 font-medium">{t("manage.roles.colRole")}</th>
              {secrets.map(s => (
                <th key={s.id} className="px-3 py-2.5 text-center font-mono font-medium normal-case tracking-normal">{s.name}</th>
              ))}
              <th className="px-3 py-2.5 font-medium">{t("manage.roles.colDefaultFor")}</th>
              <th className="px-3 py-2.5 font-medium">{t("manage.roles.colRunning")}</th>
            </tr>
          </thead>
          <tbody>
            {roles.map(r => {
              const d = defaultsFor(r.id, projects, agents);
              const def = [
                ...d.agents.map(name => t("manage.roles.defaultAgent", { name })),
                ...d.projects.map(name => t("manage.roles.defaultProject", { name })),
              ].join(", ");
              return (
                <tr
                  key={r.id}
                  data-role-row={r.name}
                  data-selected={r.id === selected || undefined}
                  onClick={() => setSelected(r.id)}
                  className={cn(
                    "cursor-pointer border-t border-[var(--color-border-soft)] hover:bg-[var(--color-hover)]",
                    r.id === selected && "bg-[var(--color-bg-2)]",
                  )}
                >
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2 font-medium"><RoleDot colour={r.colour} />{r.name}</span>
                  </td>
                  {secrets.map(s => (
                    <td key={s.id} className="px-3 py-2.5">
                      <div className="flex justify-center">
                        <Checkbox
                          data-role-secret={`${r.name}/${s.name}`}
                          aria-label={`${r.name}: ${s.name}`}
                          checked={r.secrets.includes(s.id)}
                          onChange={on => toggle(r, s.id, on)}
                        />
                      </div>
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-[var(--color-fg-dim)]">{def}</td>
                  <td className="px-3 py-2.5">{running(byRole.get(r.id)?.length ?? 0)}</td>
                </tr>
              );
            })}
            <tr className="border-t border-[var(--color-border-soft)] text-[var(--color-fg-dim)]">
              <td className="px-3 py-2.5">
                <span className="flex items-center gap-2">
                  <RoleDot colour={null} />{t("manage.roles.noSecrets")}
                  <span className="text-[10.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">{t("manage.roles.builtIn")}</span>
                </span>
              </td>
              {secrets.map(s => <td key={s.id} className="px-3 py-2.5 text-center text-[var(--color-fg-faint)]">·</td>)}
              <td className="px-3 py-2.5">{t("manage.roles.everythingElse")}</td>
              <td className="px-3 py-2.5">{running(byRole.get("")?.length ?? 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {sel
        ? <RoleEditor key={sel.id} role={sel} secrets={secrets} runningTasks={byRole.get(sel.id)?.map(x => x.name) ?? []} onSave={saveRole} onDuplicate={() => void duplicate(sel)} onDelete={() => void remove(sel)} />
        : roles.length > 0 && <div className="text-[12.5px] text-[var(--color-fg-faint)]">{t("manage.roles.selectHint")}</div>}
    </div>
  );
}

function RoleEditor({ role, secrets, runningTasks, onSave, onDuplicate, onDelete }: {
  role: Role; secrets: SecretDef[]; runningTasks: string[];
  onSave: (r: Role) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation("secrets");
  const blocks = ruleBlocksFor(role, secrets);
  return (
    <div className="flex flex-col gap-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-1)] p-5" data-testid="role-editor">
      <div className="flex flex-wrap items-start gap-6">
        <label className="flex w-64 flex-col gap-1">
          <span className="text-[13px] font-medium">{t("manage.editor.name")}</span>
          <CommitInput data-testid="role-name" value={role.name} onCommit={v => { if (v.trim()) onSave({ ...role, name: v.trim() }); }} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{t("manage.editor.colour")}</span>
          <div className="flex h-9 items-center gap-2" role="radiogroup">
            {ROLE_COLOURS.map(c => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={role.colour === c}
                aria-label={t(`manage.editor.colourName.${c}`)}
                title={t(`manage.editor.colourName.${c}`)}
                data-role-colour={c}
                onClick={() => onSave({ ...role, colour: c })}
                className={cn("h-5 w-5 rounded-full ring-offset-2 ring-offset-[var(--color-bg-1)]", role.colour === c && "ring-2 ring-[var(--color-fg)]")}
                style={{ background: roleColourVar(c) }}
              />
            ))}
          </div>
        </div>
        <div className="ml-auto flex min-w-0 flex-col items-end gap-1.5">
          <span className="text-[12.5px] text-[var(--color-fg-dim)]">
            {runningTasks.length ? t("manage.editor.runningAs", { role: role.name }) : t("manage.editor.noneRunning", { role: role.name })}
          </span>
          <div className="flex flex-wrap justify-end gap-1.5">
            {runningTasks.map((n, i) => (
              <span key={`${n}-${i}`} className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-[12px]">{n}</span>
            ))}
          </div>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">{t("manage.editor.description")}</span>
        <CommitInput data-testid="role-description" value={role.description} placeholder={t("manage.editor.descriptionPlaceholder")} onCommit={v => onSave({ ...role, description: v })} />
      </label>

      {loginTakeovers(role, secrets).map(w => (
        <div key={`${w.agent}/${w.secret}`} data-testid="role-login-takeover" className="flex gap-2.5 rounded-md border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 px-3 py-2.5 text-[12.5px]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <span>{t("manage.editor.loginTakeover", { agent: w.agent, env: w.env, secret: w.secret })}</span>
        </div>
      ))}

      {blocks.length === 0 && (
        <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.noSecrets")}</div>
      )}
      {blocks.map(b => (
        <RuleBlock
          key={`${b.secret.id}@${b.host}`}
          title={t(b.kind === "git" ? "manage.editor.rulesGit" : "manage.editor.rulesApi", { secret: b.secret.name, host: b.host })}
          kind={b.kind}
          set={ruleSetFor(role, b.secret.id, b.host)}
          inherited={!role.rule_sets.some(r => r.secret === b.secret.id && r.host === b.host)}
          onChange={set => onSave(putRuleSet(role, set))}
        />
      ))}
      {blocks.length > 0 && <p className="text-[12px] text-[var(--color-fg-faint)]">{t("manage.editor.methodsHelp")}</p>}

      <p className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.footer")}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={onDuplicate} data-testid="role-duplicate"><Copy className="h-3.5 w-3.5" /> {t("manage.editor.duplicate")}</Button>
        <Button size="sm" variant="danger" onClick={onDelete} data-testid="role-delete"><Trash2 className="h-3.5 w-3.5" /> {t("manage.editor.delete")}</Button>
      </div>
    </div>
  );
}

const splitMethods = (v: string) => v.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

// a rule drag in progress. Rows are measured once at the start: nothing
// reflows during the drag (only transforms move), so the centers stay valid.
interface RuleDrag { from: number; startY: number; dy: number; started: boolean; centers: number[]; step: number }

/** Where the dragged row would land: one slot per other row whose center it
 *  has passed. */
function dropIndex(d: RuleDrag): number {
  const c = d.centers[d.from] + d.dy;
  return d.centers.filter((y, j) => j !== d.from && y < c).length;
}

/** How far row j steps aside to open the gap at `to`. */
function shiftFor(j: number, from: number, to: number, step: number): number {
  if (from < to && j > from && j <= to) return -step;
  if (from > to && j >= to && j < from) return step;
  return 0;
}

function RuleBlock({ title, kind, set, inherited, onChange }: {
  title: string; kind: "http" | "git"; set: RuleSet; inherited: boolean; onChange: (s: RuleSet) => void;
}) {
  const { t } = useTranslation("secrets");
  // a drag commits on pointerup, after the blur that saves a pending edit has
  // re-rendered this block. Reading props from the pointerdown closure would
  // save the pre-edit rules over that edit, so read the latest ones.
  const latest = useRef({ set, onChange });
  latest.current = { set, onChange };
  // rules carry no id, so rows get one here, moved with the rule. Keyed by
  // index, a field holding an uncommitted edit stayed at its index through a
  // reorder and then committed onto whichever rule landed there (possibly one
  // with the opposite effect).
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < set.rules.length) keys.current.push(nextKey.current++);
  keys.current.length = set.rules.length;
  const put = (rules: Rule[]) => latest.current.onChange({ ...latest.current.set, rules });
  const at = (i: number, p: Partial<Rule>) => put(latest.current.set.rules.map((r, j) => j === i ? { ...r, ...p } : r));
  const remove = (i: number) => {
    keys.current.splice(i, 1);
    put(latest.current.set.rules.filter((_, j) => j !== i));
  };
  const listRef = useRef<HTMLDivElement>(null);
  const move = (from: number, to: number, refocus = false) => {
    const rules = latest.current.set.rules;
    if (to === from || to < 0 || to >= rules.length) return;
    const next = [...rules];
    next.splice(to, 0, ...next.splice(from, 1));
    keys.current.splice(to, 0, ...keys.current.splice(from, 1));
    put(next);
    // keyboard moves: keep focus on the handle of the rule that moved.
    if (refocus) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-rule-index="${to}"] [data-rule-handle]`)?.focus());
  };

  // pointer drag on window listeners (not HTML5 DnD: WKWebView's is
  // unreliable and Tauri takes it for file drops). The row follows the
  // cursor, the rows it passes step aside, and the order commits on release,
  // so a drag is one save rather than one per row crossed. Each drag keeps
  // its own `d` in closure: state is only for painting, and window events
  // are not flushed one by one, so reading state back would go stale.
  const [drag, setDrag] = useState<RuleDrag | null>(null);
  const to = drag?.started ? dropIndex(drag) : null;
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  function onHandleDown(i: number, e: React.PointerEvent) {
    if (e.button !== 0) return;
    const rects = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-rule-index]") ?? [], r => r.getBoundingClientRect());
    if (!rects[i]) return;
    e.preventDefault();
    let d: RuleDrag = {
      from: i, startY: e.clientY, dy: 0, started: false,
      centers: rects.map(r => r.top + r.height / 2),
      step: rects.length > 1 ? rects[1].top - rects[0].top : rects[i].height,
    };
    setDrag(d);
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - d.startY;
      if (!d.started && Math.abs(dy) < 4) return;
      d = { ...d, dy, started: true };
      setDrag(d);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopDrag.current = null;
    };
    const onUp = () => {
      stop();
      if (d.started) move(d.from, dropIndex(d));
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    stopDrag.current = stop;
  }

  const testid = `rules-${set.host}`;
  return (
    <div ref={listRef} className="flex flex-col gap-1.5" data-testid={testid} data-rule-kind={kind}>
      <Eyebrow>{title}</Eyebrow>
      {set.rules.length === 0 && set.fallback === "allow" && (
        <div className="text-[12.5px] text-[var(--color-fg-faint)]">{t("manage.editor.noRules")}</div>
      )}
      {inherited && set.fallback === "deny" && (
        <div data-testid={`${testid}-inherited-deny`} className="text-[12.5px] text-[var(--color-fg-faint)]">{t("manage.editor.noRulesDeny")}</div>
      )}
      {set.rules.map((r, i) => {
        const dragging = drag?.started && drag.from === i;
        const ty = !drag || to === null ? 0 : dragging ? drag.dy : shiftFor(i, drag.from, to, drag.step);
        return (
        <div
          key={keys.current[i]}
          data-rule-index={i}
          data-rule-disabled={r.disabled || undefined}
          style={to !== null ? { transform: `translateY(${ty}px)`, position: "relative", zIndex: dragging ? 10 : undefined } : undefined}
          className={cn(
            "flex items-center gap-2 rounded-md border bg-[var(--color-bg)] px-2 py-1.5",
            dragging ? "border-[var(--color-accent)] shadow-xl" : "border-[var(--color-border-soft)]",
            to !== null && !dragging && "transition-transform duration-150",
            r.disabled && !dragging && "opacity-50",
          )}
        >
          <button
            type="button"
            data-rule-handle
            aria-label={t("manage.editor.dragRule")}
            title={t("manage.editor.dragRule")}
            onPointerDown={e => onHandleDown(i, e)}
            onKeyDown={e => {
              const d = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
              if (d) { e.preventDefault(); move(i, i + d, true); }
            }}
            style={{ touchAction: "none" }}
            className="-ml-1 shrink-0 cursor-grab rounded p-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] active:cursor-grabbing"
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <EffectPill effect={r.effect} onClick={() => at(i, { effect: r.effect === "allow" ? "deny" : "allow" })} />
          <CommitInput
            aria-label={t("manage.editor.methods")}
            data-field="methods"
            value={r.methods.join(", ")}
            placeholder={t(kind === "git" ? "manage.editor.methodsPlaceholderGit" : "manage.editor.methodsPlaceholderApi")}
            onCommit={v => {
              // a rule with no method matches nothing, and secrets.rs refuses it.
              const m = splitMethods(v);
              if (!m.length) return false;
              at(i, { methods: m });
            }}
            className="h-8 w-40 shrink-0 font-mono text-[12.5px]"
          />
          <CommitInput
            aria-label={t("manage.editor.pattern")}
            data-field="pattern"
            value={r.pattern}
            placeholder={t(kind === "git" ? "manage.editor.patternPlaceholderGit" : "manage.editor.patternPlaceholderApi")}
            onCommit={v => {
              // an empty pattern matches EVERY path while the field shows its
              // placeholder; only QUERY (no name to match) may go without.
              const p = v.trim();
              if (!p && !r.methods.every(m => m.toUpperCase() === "QUERY")) return false;
              at(i, { pattern: p });
            }}
            className="h-8 min-w-0 flex-1 font-mono text-[12.5px]"
          />
          <CommitInput
            aria-label={t("manage.editor.note")}
            data-field="note"
            value={r.note}
            placeholder={t("manage.editor.notePlaceholder")}
            onCommit={v => at(i, { note: v })}
            className="h-8 w-56 shrink-0 text-[12.5px] text-[var(--color-fg-dim)]"
          />
          <IconBtn label={t(r.disabled ? "manage.editor.enableRule" : "manage.editor.disableRule")} onClick={() => at(i, { disabled: !r.disabled })}>
            {r.disabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </IconBtn>
          <IconBtn label={t("manage.editor.removeRule")} onClick={() => remove(i)}><X className="h-3.5 w-3.5" /></IconBtn>
        </div>
        );
      })}
      {/* The fallback: what happens when no rule above matched. Dashed, like
          the mock, because it is not a rule you can move or delete. */}
      <div data-rule-fallback className="flex items-center gap-2 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5">
        <span aria-hidden className="-ml-1 w-5 shrink-0" />
        <EffectPill effect={set.fallback} onClick={() => onChange({ ...set, fallback: set.fallback === "allow" ? "deny" : "allow" })} />
        <span className="w-40 shrink-0 px-3 font-mono text-[12.5px]">*</span>
        <span className="flex-1 font-mono text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.editor.fallbackAll")}</span>
      </div>
      <div>
        <Button
          size="sm"
          variant="ghost"
          data-testid={`${testid}-add`}
          onClick={() => put([...set.rules, { effect: "allow", methods: kind === "git" ? ["fetch"] : ["GET"], pattern: kind === "git" ? "*" : "/**", note: "" }])}
        >
          <Plus className="h-3.5 w-3.5" /> {t("manage.editor.addRule")}
        </Button>
      </div>
    </div>
  );
}

function EffectPill({ effect, onClick }: { effect: RuleEffect; onClick: () => void }) {
  const { t } = useTranslation("secrets");
  return (
    <button
      type="button"
      data-effect={effect}
      title={t("manage.editor.toggleEffect")}
      onClick={onClick}
      className={cn(
        "w-16 shrink-0 rounded py-1 text-center text-[11px] font-semibold uppercase tracking-wider",
        effect === "allow"
          ? "bg-[var(--color-ok)]/15 text-[var(--color-ok)]"
          : "bg-[var(--color-err)]/15 text-[var(--color-err)]",
      )}
    >
      {effect === "allow" ? t("manage.editor.allow") : t("manage.editor.deny")}
    </button>
  );
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}
