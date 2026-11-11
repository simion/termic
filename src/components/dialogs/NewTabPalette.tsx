// Quick new-tab palette (⌘T / + tab) — fuzzy-filter agents, custom terminals,
// scratchpads, and recent closed tabs. Allows typing any arbitrary command to
// run directly in a new terminal tab.
// Modelled on PromptPalette.tsx: same non-modal Dialog pattern, same fuzzy
// scoring, positional accelerators (1-9) when query is empty.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search, NotepadText, History, Settings, CornerDownLeft, Play, Terminal, KeyRound, ChevronLeft } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp, type ClosedTabEntry } from "@/store/app";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { useTranslation } from "react-i18next";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { visibleCliIds, agentDisplayName, isTerminalEntry } from "@/lib/agents";
import { newScratchTab } from "@/lib/scratchTabs";
import { focusTerminalTab } from "@/lib/tabFocus";
import { cn } from "@/lib/utils";
import { isGhLogin, roleSecrets, useShellRoles } from "@/lib/shellSecrets";
import { useSecrets } from "@/store/secrets";
import { roleColour } from "@/lib/secretsUi";

const NO_CLOSED_TABS: ClosedTabEntry[] = [];

function relativeTime(iso: string, now: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return now;
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type NewTabPaletteItem = {
  id: string;
  kind: "shell" | "shell_role" | "custom_terminal" | "agent" | "scratchpad" | "resume" | "custom_command";
  title: string;
  subtitle?: string;
  /** A wrapped plain-text line under the subtitle (a shell role's caveat). */
  note?: string;
  /** Icon colour for a shell role row (the role's colour). */
  colour?: string;
  /** A shell role row's own name, its title inside the "with secrets" list. */
  roleName?: string;
  category: "terminals" | "agents" | "scratchpads" | "resume" | "custom_command";
  iconId?: string;
  badge?: string;
  run: () => void;
};

export function getScratchScopes(
  t: (key: string) => string,
  hasProject: boolean,
): Array<{ scope: "task" | "project" | "profile" | "global"; title: string }> {
  return [
    { scope: "task", title: t("newTab.scratchpad") },
    ...(hasProject ? [{ scope: "project" as const, title: t("newTab.scratchpadProject") }] : []),
    { scope: "profile", title: t("newTab.scratchpadProfile") },
    { scope: "global", title: t("newTab.scratchpadGlobal") },
  ];
}

export function NewTabPalette() {
  const { t } = useTranslation("task");
  const paletteState = useUI(s => s.newTabPalette);
  const close = useUI(s => s.closeNewTabPalette);
  const openSettings = useApp(s => s.openSettings);

  const open = !!paletteState;
  const taskId = paletteState?.taskId ?? "";
  const paneId = paletteState?.paneId ?? null;

  const registry = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const task = useApp(s => s.tasks.find(w => w.id === taskId));
  const closedTabs = useApp(s => (taskId ? (s.closedTabs[taskId] ?? NO_CLOSED_TABS) : NO_CLOSED_TABS));
  const addTab = useApp(s => s.addTab);
  const addPaneTab = useApp(s => s.addPaneTab);
  const resumeClosedTab = useApp(s => s.resumeClosedTab);
  // empty off macOS and when no role exists, which hides the role rows.
  const shellRoles = useShellRoles();
  const allSecrets = useSecrets(s => s.secrets);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  // → on Terminal swaps the list for the roles; the main list never carries
  // them, so agents keep their 1-9 (docs/sandbox.md "Shells").
  const [roleMode, setRoleMode] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setRoleMode(false);
    }
  }, [open]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, roleMode]);

  const enterRoles = () => { setQuery(""); setRoleMode(true); };
  const leaveRoles = () => { setQuery(""); setRoleMode(false); };

  // Construct all base launchable items
  const baseItems = useMemo(() => {
    if (!taskId) return [];
    const items: NewTabPaletteItem[] = [];

    // 1. Shell terminal
    items.push({
      id: "shell",
      kind: "shell",
      title: t("newTab.terminal"),
      category: "terminals",
      iconId: "shell",
      run: () => {
        if (paneId) {
          addPaneTab(taskId, paneId, "shell");
        } else {
          const id = crypto.randomUUID();
          addTab(taskId, { id, type: "terminal", title: t("newTab.terminal"), cli: "shell" });
          focusTerminalTab(id);
        }
      },
    });

    // 2. Custom terminals (kind: "terminal")
    const customTerminals = registry.filter(a => isTerminalEntry(a) && !a.disabled);
    for (const ct of customTerminals) {
      items.push({
        id: `ct-${ct.id}`,
        kind: "custom_terminal",
        title: ct.display_name || ct.id,
        subtitle: ct.command || undefined,
        category: "terminals",
        iconId: resolveIconId(ct.id, registry),
        badge: t("newTabPalette.groupTerminals"),
        run: () => {
          if (paneId) {
            addPaneTab(taskId, paneId, ct.id);
          } else {
            const id = crypto.randomUUID();
            addTab(taskId, {
              id,
              type: "terminal",
              title: ct.display_name || ct.id,
              cli: ct.id,
              command: ct.command,
            });
            focusTerminalTab(id);
          }
        },
      });
    }

    // 3. AI Agents
    const visibleClis = visibleCliIds(registry.map(a => a.id), registry, detectedClis);
    const agentEntries = registry.filter(a => !isTerminalEntry(a) && visibleClis.has(a.id));
    for (const ag of agentEntries) {
      items.push({
        id: `ag-${ag.id}`,
        kind: "agent",
        title: ag.display_name || ag.id,
        category: "agents",
        iconId: resolveIconId(ag.id, registry),
        badge: t("newTabPalette.groupAgents"),
        run: () => {
          if (paneId) {
            addPaneTab(taskId, paneId, ag.id);
          } else {
            const id = crypto.randomUUID();
            addTab(taskId, {
              id,
              type: "terminal",
              title: ag.display_name || ag.id,
              cli: ag.id,
            });
            focusTerminalTab(id);
          }
        },
      });
    }

    // 4. Scratchpads
    const hasProject = !!task?.project_id;
    const scratchScopes = getScratchScopes(t, hasProject);
    for (const sc of scratchScopes) {
      items.push({
        id: `scratch-${sc.scope}`,
        kind: "scratchpad",
        title: sc.title,
        category: "scratchpads",
        badge: t("newTabPalette.groupScratchpads"),
        run: () => {
          void newScratchTab(taskId, {
            scope: sc.scope,
            projectId: sc.scope === "project" ? task?.project_id : undefined,
            paneId,
          });
        },
      });
    }

    // 5. Recent closed tabs
    for (const entry of closedTabs.slice(0, 5)) {
      items.push({
        id: `resume-${entry.id}`,
        kind: "resume",
        title: entry.title,
        subtitle: relativeTime(entry.closedAt, t("newTab.now")),
        category: "resume",
        iconId: entry.cli,
        badge: t("newTabPalette.groupResume"),
        run: () => {
          resumeClosedTab(taskId, entry.id, { paneId });
        },
      });
    }

    return items;
  }, [taskId, paneId, registry, detectedClis, closedTabs, task?.project_id, t, addTab, addPaneTab, resumeClosedTab]);

  // a shell running a Secrets role (docs/sandbox.md "Shells"), one row per
  // role. Reached by → on Terminal, or by typing; never in the default list.
  const roleItems = useMemo(() => {
    if (!taskId) return [];
    return shellRoles.map((role): NewTabPaletteItem => {
      const bound = roleSecrets(role, allSecrets);
      const hosts = [...new Set(bound.flatMap(s => s.hosts))];
      return {
        id: `shell-role-${role.id}`,
        kind: "shell_role",
        title: t("newTab.terminalAs", { role: role.name }),
        roleName: role.name,
        subtitle: [hosts.join(", "), t(bound.length === 1 ? "newTab.secretCount_one" : "newTab.secretCount_other", { count: bound.length })].filter(Boolean).join(" · "),
        note: bound.some(isGhLogin) ? t("newTab.ghLoginNote") : undefined,
        colour: roleColour(role.colour),
        category: "terminals",
        run: () => {
          const title = t("newTab.terminal");
          if (paneId) {
            addPaneTab(taskId, paneId, "shell", { secretsRole: role.id });
          } else {
            const id = crypto.randomUUID();
            addTab(taskId, { id, type: "terminal", title, cli: "shell", secretsRole: role.id });
            focusTerminalTab(id);
          }
        },
      };
    });
  }, [taskId, paneId, shellRoles, allSecrets, t, addTab, addPaneTab]);

  // Fuzzy filter + custom command option
  const rows = useMemo(() => {
    type Scored = { item: NewTabPaletteItem; matches: number[]; score: number };
    const trimmed = query.trim();

    if (roleMode) {
      const named = roleItems.map(item => ({ ...item, title: item.roleName ?? item.title }));
      if (!trimmed) return named.map(item => ({ item, matches: [], score: 0 }));
      return named
        .map(item => ({ item, m: fuzzyMatch(item.title, trimmed) }))
        .filter(x => x.m)
        .map(x => ({ item: x.item, matches: x.m!.matches, score: x.m!.score }))
        .sort((a, b) => b.score - a.score);
    }

    if (!trimmed) {
      return baseItems.map(item => ({ item, matches: [], score: 0 }));
    }

    const scored: Scored[] = [];
    for (const item of [...baseItems, ...roleItems]) {
      const mTitle = fuzzyMatch(item.title, trimmed);
      const mSub = item.subtitle ? fuzzyMatch(item.subtitle, trimmed) : null;
      if (mTitle) {
        scored.push({ item, matches: mTitle.matches, score: mTitle.score + 10 });
      } else if (mSub) {
        scored.push({ item, matches: [], score: mSub.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);

    // If query was typed, offer to run it as a custom shell command
    const exactMatch = baseItems.some(it => it.title.toLowerCase() === trimmed.toLowerCase());
    if (!exactMatch) {
      const customCmdItem: NewTabPaletteItem = {
        id: "custom-command-runner",
        kind: "custom_command",
        title: t("newTabPalette.runCommand", { cmd: trimmed }),
        subtitle: t("newTabPalette.runCommandTip"),
        category: "custom_command",
        iconId: "shell",
        run: () => {
          if (paneId) {
            addPaneTab(taskId, paneId, "shell", {
              title: trimmed,
              command: trimmed,
              initialInput: `${trimmed}\r`,
            });
          } else {
            const id = crypto.randomUUID();
            addTab(taskId, {
              id,
              type: "terminal",
              title: trimmed,
              cli: "shell",
              command: trimmed,
              initialInput: `${trimmed}\r`,
            });
            focusTerminalTab(id);
          }
        },
      };
      scored.push({ item: customCmdItem, matches: [], score: -1 });
    }

    return scored;
  }, [baseItems, roleItems, roleMode, query, paneId, taskId, addPaneTab, addTab, t]);

  useEffect(() => {
    if (activeIdx > rows.length - 1) setActiveIdx(Math.max(0, rows.length - 1));
  }, [rows.length, activeIdx]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // a timer, not rAF, for CommandPalette's reason: rAF is frozen while the
  // window is occluded, so the launch would sit queued and fire whenever the
  // window next shows.
  function executeItem(item: NewTabPaletteItem) {
    close();
    setTimeout(() => item.run(), 0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!query && /^[1-9]$/.test(e.key)) {
      const row = rows[Number(e.key) - 1];
      if (row) {
        e.preventDefault();
        executeItem(row.item);
        return;
      }
    }
    if (e.key === "ArrowRight" && !roleMode && !query && rows[activeIdx]?.item.kind === "shell" && roleItems.length > 0) {
      e.preventDefault();
      enterRoles();
    } else if (roleMode && !query && (e.key === "ArrowLeft" || e.key === "Backspace")) {
      e.preventDefault();
      leaveRoles();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[activeIdx];
      if (row) executeItem(row.item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (roleMode) leaveRoles();
      else close();
    }
  }

  if (!open) return null;

  return (
    <Dialog.Root open={open} onOpenChange={v => (v ? null : close())} modal={false}>
      <Dialog.Portal>
        <div
          aria-hidden
          data-state={open ? "open" : "closed"}
          className="termic-backdrop pointer-events-none fixed inset-0 z-40 bg-black/30"
        />
        <Dialog.Content
          onOpenAutoFocus={() => {
            returnFocusRef.current = (document.activeElement as HTMLElement) ?? null;
          }}
          onCloseAutoFocus={e => {
            e.preventDefault();
            const el = returnFocusRef.current;
            requestAnimationFrame(() => {
              const ae = document.activeElement;
              if ((!ae || ae === document.body) && el && document.contains(el)) el.focus();
            });
          }}
          // Radix dismisses on Esc before onKeyDown runs; in the roles list
          // Esc means back, which onKeyDown does.
          onEscapeKeyDown={e => { if (roleMode) e.preventDefault(); }}
          data-testid="new-tab-palette"
          style={{ background: "color-mix(in srgb, var(--color-bg-1) 88%, transparent)" }}
          className="termic-pop fixed left-1/2 top-[14vh] z-50 w-[min(520px,94vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl outline-none backdrop-blur-lg"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">{t("newTabPalette.srTitle")}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("newTabPalette.srDesc")}</Dialog.Description>

          <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-3.5 py-3">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder={t("newTabPalette.placeholder")}
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-[12px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]"
              >
                {t("common:clear")}
              </button>
            )}
          </div>

          {roleMode && (
            <button
              type="button"
              data-testid="new-tab-roles-back"
              onClick={leaveRoles}
              className="flex w-full items-center gap-2 border-b border-[var(--color-border)] px-3.5 py-2 text-left text-[12px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span className="font-medium">{t("newTabPalette.withSecretsHeader")}</span>
              <span className="ml-auto text-[11.5px] text-[var(--color-fg-faint)]">{t("newTabPalette.withSecretsScope")}</span>
            </button>
          )}
          <div ref={listRef} data-role-mode={roleMode || undefined} className="no-scrollbar max-h-[min(52vh,380px)] overflow-y-auto py-1">
            {rows.length === 0 && (
              <div className="px-3.5 py-4 text-center text-[13px] text-[var(--color-fg-faint)]">
                {t("newTabPalette.noMatching")}
              </div>
            )}
            {rows.map(({ item, matches }, i) => {
              const isSelected = i === activeIdx;
              return (
                <button
                  key={item.id}
                  data-row={i}
                  data-kind={item.kind}
                  data-testid={item.id === "scratch-task" ? "new-scratchpad" : undefined}
                  onClick={() => executeItem(item)}
                  onMouseMove={() => setActiveIdx(i)}
                  style={isSelected ? { background: "color-mix(in srgb, var(--color-fg) 11%, transparent)" } : undefined}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors select-none"
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center",
                      item.iconId ? CLI_BRAND_COLOR[item.iconId] : "text-[var(--color-fg-dim)]",
                    )}
                  >
                    {item.kind === "scratchpad" ? (
                      <NotepadText className="h-4 w-4 text-emerald-500" />
                    ) : item.kind === "shell_role" ? (
                      <KeyRound className="h-4 w-4" style={{ color: item.colour }} />
                    ) : item.kind === "custom_command" ? (
                      <Play className="h-3.5 w-3.5 text-[var(--color-accent)]" />
                    ) : item.iconId ? (
                      <CliIcon cli={item.iconId} className="h-4 w-4" />
                    ) : (
                      <Terminal className="h-4 w-4 text-[var(--color-fg-dim)]" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-[var(--color-fg)]">
                        {matches.length > 0 ? <Highlighted text={item.title} matches={matches} /> : item.title}
                      </span>
                      {item.badge && (
                        <span className="rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">
                          {item.badge}
                        </span>
                      )}
                    </div>
                    {item.subtitle && (
                      <div className="truncate text-[11.5px] font-mono text-[var(--color-fg-faint)]">
                        {item.subtitle}
                      </div>
                    )}
                    {item.note && (
                      <div className="text-[11.5px] text-[var(--color-fg-faint)]">{item.note}</div>
                    )}
                  </div>

                  {item.kind === "shell" && !query && roleItems.length > 0 && (
                    // a span, not a button: it sits inside the row's button.
                    // The keyboard path is →.
                    <span
                      data-testid="new-tab-with-secrets"
                      onClick={e => { e.stopPropagation(); enterRoles(); }}
                      className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-[11.5px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]"
                    >
                      {t("newTab.withSecrets")}
                      <kbd className="rounded border border-[var(--color-border-soft)] px-1 font-mono text-[10.5px] leading-[16px]">→</kbd>
                    </span>
                  )}
                  {!query && i < 9 && (
                    <kbd className="shrink-0 rounded border border-[var(--color-border-soft)] px-1.5 font-mono text-[10.5px] leading-[16px] text-[var(--color-fg-faint)]">
                      {i + 1}
                    </kbd>
                  )}
                  {isSelected && (
                    <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-[var(--color-border)] px-3.5 py-2 text-[11.5px] text-[var(--color-fg-faint)]">
            <button
              onClick={() => {
                close();
                requestAnimationFrame(() => openSettings("agents"));
              }}
              className="flex items-center gap-1.5 hover:text-[var(--color-fg-dim)]"
            >
              <Settings className="h-3.5 w-3.5" />
              <span>{t("newTabPalette.manage")}</span>
            </button>
            <div className="flex items-center gap-2 select-none">
              <span>↑↓ {t("newTabPalette.hintNav")}</span>
              <span>·</span>
              <span>↵ {t("newTabPalette.hintRun")}</span>
              <span>·</span>
              <span>esc {t("newTabPalette.hintDismiss")}</span>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
