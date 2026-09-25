// Settings → Agents & Terminals → Agent hooks.
//
// It sits with the AGENTS because it writes into an agent's own config and
// changes how that agent reports its state. It lived under Notifications
// first, on the reasoning that the four indicators there are all downstream of
// work-state detection: true, and beside the point, since Notifications is
// where you choose whether to be TOLD rather than how termic KNOWS. The tell
// was that the arrangement needed a signpost on the Agents page pointing at
// it, and a cross reference is usually evidence a thing is in the wrong place.
//
// One table above the per-agent tabs, not a field on each card: the per-agent
// statuses ("not needed", "not supported yet") only read as coverage when they
// sit next to each other, and it is a decision made once, not per agent.
//
// One row per DETECTED agent, each with its own action. Deliberately not a
// single master switch: the consent question differs per agent (a shell script
// in ~/.claude is not the same ask as a JS module running in-process inside
// opencode), and hiding that behind one toggle would be dishonest.
//
// Each row's action covers BOTH that agent's targets, host and its Docker
// config dir. Docker needs no separate consent because termic owns that
// directory, but a user who declines for an agent must never find hooks
// installed for it inside a container. See docs/agent-hooks.md.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Check, CircleAlert } from "lucide-react";
import { agentHooksInstall, agentHooksPlan, agentHooksRemove, agentHooksStatus, agentHooksAutoGet, agentHooksAutoSet, agentHooksSync, cachedHomeDir } from "@/lib/ipc";
import { Toggle } from "@/components/settings/Controls";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { tildePath } from "@/lib/pathMatch";
import { agentDisplayName } from "@/lib/agents";
import type { AgentHookStatus, HookPlan } from "@/lib/types";

/** Anchor the Agents section's link targets, so the jump lands ON the block
 *  rather than at the top of Notifications with the reader hunting for it. */
export const AGENT_HOOKS_HIGHLIGHT = "agent-hooks";

export function AgentHooksBlock() {
  const { t } = useTranslation("settings");
  const detectedClis = useApp(s => s.detectedClis);
  const agents = useApp(s => s.agents);
  const [status, setStatus] = useState<Record<string, AgentHookStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Record<string, string>>({});
  // Disclosure, per agent. These users read shell for a living, so the honest
  // move is to show the actual scripts rather than describe them.
  const [plan, setPlan] = useState<Record<string, HookPlan>>({});
  const [open, setOpen] = useState<string | null>(null);
  /** Which FILE of the open plan is showing, keyed by agent. An install
   *  touches the agent's config plus one script per signal, and dumping all
   *  of them end to end made a disclosure you had to scroll past rather than
   *  read: codex alone is a 60-line JSON fragment followed by four scripts. */
  const [planFile, setPlanFile] = useState<Record<string, number>>({});
  const [home, setHome] = useState("");
  useEffect(() => { void cachedHomeDir().then(setHome); }, []);
  // COLLAPSED by default. Expanded, this pushed the per-agent tabs (the reason
  // anyone opens this page) below the fold behind two paragraphs of protocol
  // detail. That detail is right for someone deciding to let termic write into
  // their agent config and wrong as the first thing on the page, so it lives
  // behind the toggle and the collapsed row carries only what it is and how
  // many agents are wired.
  const [expanded, setExpanded] = useState(false);
  /** "Install all hooks", or null until read. */
  const [auto, setAuto] = useState<boolean | null>(null);
  // Read by the mount/detection effect without being one of its deps: the
  // switch installs through its own call, and re-running that effect on the
  // flip started a SECOND sync racing the first over the same config files.
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const autoLoaded = auto !== null;
  useEffect(() => {
    void agentHooksAutoGet().then(setAuto).catch(() => setAuto(false));
  }, []);
  // Arriving from the Agents section's link: scroll to this block and flash it
  // once. Same one-shot contract as GeneralSection's, so a later manual visit
  // to Notifications does not re-flash something the reader is already on.
  const settingsHighlight = useApp(s => s.view.settingsHighlight);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (settingsHighlight !== AGENT_HOOKS_HIGHLIGHT) return;
    useApp.getState().clearSettingsHighlight();
    // Expanded as well: whoever sent the reader here (the usage chip's
    // "Install hooks", the Notifications link) sent them to act on a row, and
    // the rows are behind the toggle. Scrolled on the NEXT frame so the jump
    // measures the block at its expanded height, and to its top, because
    // centred the expanded block starts above the fold.
    setExpanded(true);
    const raf = window.requestAnimationFrame(() =>
      document.getElementById(`setting-${AGENT_HOOKS_HIGHLIGHT}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" }));
    setFlash(true);
    const th = window.setTimeout(() => setFlash(false), 1600);
    return () => { window.clearTimeout(th); window.cancelAnimationFrame(raf); };
  }, [settingsHighlight]);

  const toggleDetails = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    if (!plan[id]) {
      try {
        const next = await agentHooksPlan(id);
        setPlan(p => ({ ...p, [id]: next }));
      } catch { /* the row still works without the disclosure */ }
    }
  };

  // Only agents actually on PATH. Offering to wire an agent the user does not
  // have is noise, and the row would have nothing true to say.
  const present = agents
    .filter(a => a.id !== "shell" && detectedClis[a.id]?.found)
    .map(a => a.id);

  // ...and of those, only the ones this can actually wire. A row reading
  // "not supported yet" or "not needed, its terminal already reports this" is
  // a row you can do nothing with, and there were more of those than real ones,
  // which made the list read as mostly unavailable. The unsupported agents are
  // still described in docs/agent-hooks.md, where the reasoning belongs.
  const wirable = present.filter(id => status[id]?.supported);
  const installedCount = wirable.filter(id => status[id]?.host.installed).length;
  /** Some wired, some not. A gap the user can close, which is what earns the
   *  warning colour. An agent blocked by `disableAllHooks` counts as a gap on
   *  purpose: its hooks genuinely are not reporting, and the fix (removing
   *  that setting) is theirs to make, so hiding it would be the dishonest
   *  half of "5 of 5". */
  const partial = installedCount > 0 && installedCount < wirable.length;

  const refresh = useCallback(async (ids: string[]) => {
    const rows = await Promise.all(
      ids.map(id => agentHooksStatus(id).then(s => [id, s] as const).catch(() => null)),
    );
    setStatus(Object.fromEntries(rows.filter(Boolean) as (readonly [string, AgentHookStatus])[]));
  }, []);

  // With "install all hooks" on, an agent that appeared since the last sync
  // (newly on PATH, or just added here) is wired before its row is read, so
  // the list never shows a gap the setting promised to close.
  useEffect(() => {
    if (!present.length || !autoLoaded) return;
    void (async () => {
      if (autoRef.current) {
        const wired = await agentHooksSync().catch(() => [] as string[]);
        if (wired.length) await useApp.getState().refreshAgentHooks();
      }
      await refresh(present);
    })();
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [present.join(","), refresh, autoLoaded]);

  const setAutoInstall = async (on: boolean) => {
    setAuto(on);
    setBusy("*");
    try {
      await agentHooksAutoSet(on);
      await useApp.getState().refreshAgentHooks();
      await refresh(present);
    } catch (e) {
      setFailure(f => ({ ...f, "*": String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, install: boolean) => {
    setBusy(id);
    setFailure(f => ({ ...f, [id]: "" }));
    try {
      const next = install ? await agentHooksInstall(id) : await agentHooksRemove(id);
      setStatus(s => ({ ...s, [id]: next }));
      // Live tabs read this to decide whether the title may still end a turn,
      // so it has to change with the install rather than at the next restart.
      await useApp.getState().refreshAgentHooks();
    } catch (e) {
      setFailure(f => ({ ...f, [id]: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  // Text sizes here are explicit px, matching Controls.tsx (label 14, hint
  // 12.5, dense 12). Tailwind's `text-sm` / `text-xs` is a SECOND scale that
  // resolves against the root font size, so using it rendered this whole block
  // a notch below its neighbours and drew a "why did you introduce a new text
  // size" straight away. Match the surrounding settings, do not invent.
  // Nothing to offer, so nothing to show. Also covers the moment before
  // status resolves, where every row would say "checking...".
  if (!wirable.length) return null;

  return (
    <div
      id={`setting-${AGENT_HOOKS_HIGHLIGHT}`}
      className={cn(
        "rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-4 py-3",
        flash && "ring-2 ring-[var(--color-accent)]",
      )}
    >
      {/* The whole thing collapsed is ONE row: what it is, how many agents are
          wired, and a way in. Everything else is behind the toggle. */}
      <button
        type="button"
        data-testid="agent-hooks-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-[var(--color-fg-faint)] transition-transform", expanded && "rotate-90")} />
        <span className="text-[14px] font-semibold text-[var(--color-fg)]">{t("agents.hooks.title")}</span>
        {/* Collapsed, this line is the only thing reporting coverage, and the
            count alone made "5 of 5" and "3 of 5" look identical at a glance:
            both are dim grey text ending in "installed", and the digit doing
            all the work is the easiest character on the row to skim past.
            State reads faster as colour and shape than as arithmetic.

            Three states, not two. Nothing installed is the untouched default
            and gets the invitation, NOT a warning: a fresh install has done
            nothing wrong, and amber on first sight is a nag. The warning is
            for a coverage GAP, which only exists once some agents are wired
            and others are not. */}
        <span
          data-testid="agent-hooks-summary"
          data-state={installedCount === 0 ? "none" : partial ? "partial" : "complete"}
          title={partial
            ? t("agents.hooks.partialTip")
            : undefined}
          className={cn(
            "ml-auto flex items-center gap-1.5 text-[12.5px]",
            // Amber carries the gap; the complete and empty cases stay in the
            // section's ordinary dim, so the row only pulls the eye when
            // there is something to act on.
            partial ? "text-[var(--color-warn)]" : "text-[var(--color-fg-dim)]",
          )}
        >
          {installedCount > 0 && (
            partial
              // Not AlertTriangle: this is "incomplete", not "something broke",
              // and the triangle is the shape this app uses for real trouble.
              ? <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
              // The tick is the whole signal for the good case, which is why
              // the text beside it stays dim rather than turning green too.
              : <Check className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" aria-hidden />
          )}
          {installedCount > 0
            ? t("agents.hooks.summaryCount", { installed: installedCount, total: wirable.length })
            : t("agents.hooks.summaryNone")}
        </span>
      </button>

      {/* Outside the collapsed part on purpose: the one decision most people
          make here is "all of them", and it should not take an expand. */}
      <div data-testid="agent-hooks-auto" data-on={auto ? "1" : "0"} className="mt-3">
        <Toggle
          label={t("agents.hooks.autoLabel")}
          hint={t("agents.hooks.autoHint")}
          value={!!auto}
          onChange={v => { if (busy !== "*") void setAutoInstall(v); }}
        />
        {failure["*"] && (
          <div className="mt-1 text-[12px] text-[var(--color-err)]">{failure["*"]}</div>
        )}
      </div>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
            {t("agents.hooks.desc")}
          </p>
          <div className="flex flex-col gap-2">
            {wirable.map(id => {
              // `wirable` already filtered to supported agents, so `st` exists.
              const st = status[id]!;
              const err = failure[id] || st.host.error || "";
              // `disableAllHooks` in the user's own config means an install would
              // never fire. Saying "installed" there would be a lie.
              const blocked = st.host.disabled_all;
              return (
                <div key={id} className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[14px] font-medium">{agentDisplayName(id, agents)}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] text-[var(--color-fg-dim)]">
                        {blocked ? t("agents.hooks.blocked")
                          : st.host.installed ? t("agents.hooks.installed")
                          : t("agents.hooks.notInstalled")}
                      </span>
                      {!blocked && (
                        <Button
                          variant={st.host.installed ? "ghost" : "primary"}
                          disabled={busy === id}
                          onClick={() => act(id, !st.host.installed)}
                        >
                          {busy === id ? "..." : st.host.installed ? t("common:remove") : t("agents.hooks.install")}
                        </Button>
                      )}
                    </div>
                  </div>
                  {/* Name the files BEFORE writing, not after, and offer the
                      whole thing rather than a summary of it. */}
                  {!blocked && (
                    <button
                      type="button"
                      onClick={() => void toggleDetails(id)}
                      className="self-start text-[12.5px] text-[var(--color-fg-dim)] underline decoration-dotted hover:text-[var(--color-fg)]"
                    >
                      {open === id ? t("agents.hooks.hideInstalls") : t("agents.hooks.showInstalls")}
                    </button>
                  )}
                  {open === id && plan[id] && (() => {
                    // One tab per FILE. Several events share a script (a
                    // working hook fires on both UserPromptSubmit and
                    // PreToolUse), so the scripts are grouped by path and the
                    // events that use them are listed on the tab's own page.
                    const p = plan[id];
                    const scripts: { path: string; body: string; events: string[] }[] = [];
                    for (const en of p.entries) {
                      const hit = scripts.find(f => f.path === en.script_path);
                      if (hit) hit.events.push(`${en.event} (${en.reports})`);
                      else scripts.push({
                        path: en.script_path,
                        body: en.script_body,
                        events: [`${en.event} (${en.reports})`],
                      });
                    }
                    const files = [
                      { path: p.config_path, body: p.config_fragment, events: [], config: true },
                      ...scripts.map(f => ({ ...f, config: false })),
                    ];
                    const active = Math.min(planFile[id] ?? 0, files.length - 1);
                    const file = files[active];
                    return (
                      <div className="flex flex-col gap-2 rounded bg-[var(--color-bg-subtle)] p-2 text-[12px]">
                        <div className="flex flex-wrap gap-1">
                          {files.map((f, i) => (
                            <button
                              key={f.path}
                              type="button"
                              title={tildePath(f.path, home)}
                              onClick={() => setPlanFile(m => ({ ...m, [id]: i }))}
                              className={cn(
                                "rounded px-2 py-1 text-[11.5px] transition-colors",
                                i === active
                                  ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                                  : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]",
                              )}
                            >
                              {f.path.replace(/^.*\//, "")}
                            </button>
                          ))}
                        </div>
                        <div className="break-all text-[var(--color-fg-subtle)]">
                          <code>{tildePath(file.path, home)}</code>
                          {file.config && p.config_is_shared && ` (${t("agents.hooks.yoursMerges")})`}
                        </div>
                        {file.events.length > 0 && (
                          <div className="text-[var(--color-fg-subtle)]">
                            {t("agents.hooks.runsOn", { events: file.events.join(", ") })}
                          </div>
                        )}
                        <pre className="max-h-[320px] overflow-auto whitespace-pre">{file.body}</pre>
                        {file.config && p.notes.map((n, i) => (
                          <p key={i} className="text-[var(--color-fg-subtle)]">{n}</p>
                        ))}
                      </div>
                    );
                  })()}
                  {err && <p className="text-[12.5px] text-[var(--color-danger)]">{err}</p>}
                </div>
                  );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
