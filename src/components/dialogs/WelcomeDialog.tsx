// First-launch welcome wizard. Five steps:
//   0. What a project and a task ARE, and what a worktree is. First,
//      because it is the only step that is pure orientation and every step
//      after it already uses the vocabulary ("your repos folder" presumes
//      you know a project is a repo). Also because people leave a wizard
//      part way through, and this is the one thing they cannot pick up from
//      the UI afterwards: users have run whole projects in worktrees
//      believing a worktree was just a branch.
//   1. Repos directory + CLI detection (original behavior).
//   2. Agent hooks - sits here because the user has just seen which agents
//      they have, so the list this step acts on is still on screen.
//   3. Theme picker - visual previews so the user can lock in their
//      preference before they're staring at it for hours.
//   4. Project picker, which keeps the Finish button.
//
// Wizard layout: header + step body + footer with Back / Skip / Next-or-
// Finish. Step state persists across nav so backing up doesn't wipe
// their pick. `welcomed=true` only writes on Finish; closing via Escape
// is intentionally blocked so the user can't accidentally bypass setup.

import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { discoverRepos, detectClis, settingsLoad, settingsSave, agentsSave, projectAdd, agentHooksStatus, agentHooksInstall, agentHooksRemove, agentHooksAutoGet, agentHooksAutoSet, agentHooksPlan } from "@/lib/ipc";
import { usePr } from "@/store/pr";
import { Checkbox } from "@/components/ui/Checkbox";
import type { AgentHookStatus, CliInfo, DiscoveredRepo, HookPlan } from "@/lib/types";
import { useApp } from "@/store/app";
import { CliIcon, CLI_LABEL } from "@/icons/cli";
import { TermicMark } from "@/icons/TermicLogo";
import { cn } from "@/lib/utils";
import { usePrefs, applyTheme, type ThemeMode } from "@/store/prefs";
import { Sun, Moon, Monitor, Sunrise, Droplet, Binary, Code2, Flower2, GitPullRequest, ChevronDown, ChevronRight, Plus, FolderPlus, GitBranch, Link2 } from "lucide-react";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { TaskWorkBadge } from "@/components/TaskWorkBadge";
import type { DelegatedWork } from "@/lib/delegatedWork";

type Step = 0 | 1 | 2 | 3 | 4;

export function WelcomeDialog() {
  const { t } = useTranslation("dialogs");
  const open = useUI(s => s.welcomeOpen);
  const close = useUI(s => s.closeWelcome);
  const [step, setStep] = useState<Step>(0);

  // Step 1 (repos) state.
  const [dir, setDir] = useState("");
  const [summary, setSummary] = useState("");
  const [clis, setClis] = useState<CliInfo[]>([]);
  // Discovered repos (populated by the step-0 effect below). Lifted to
  // the parent so step 3's project-picker has the data ready without
  // re-fetching when the user reaches it.
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  // Selected paths for step 4. Defaults to all-unadded checked when
  // the discovery result first lands.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);

  // Reset every time the wizard opens so re-running it (rare) starts
  // clean. Doesn't touch already-saved prefs - only the local flow.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setClis([]); setSummary(""); setDir("");
    detectClis().then(setClis).catch(() => setClis([]));
  }, [open]);

  useEffect(() => {
    if (!open || !dir) { setSummary(""); setRepos([]); setSelectedPaths(new Set()); return; }
    // `t` is deliberately NOT a dep: re-running would re-fire the repo
    // discovery IPC on a language switch. The stored summary localizes the
    // next time the dir changes.
    const timer = window.setTimeout(async () => {
      try {
        const found = await discoverRepos(dir);
        setRepos(found);
        // Don't pre-check anything. Auto-adding every repo in a dev
        // directory is wildly invasive on first launch — let the user
        // tick what they actually want.
        setSelectedPaths(new Set());
        const unadded = found.filter(r => !r.already_added).length;
        setSummary(found.length === 0
          ? t("welcome.summaryNone", { dir })
          : t(found.length === 1 ? "welcome.summaryFoundOne" : "welcome.summaryFoundMany", { count: found.length, unadded }));
      } catch { setSummary(t("welcome.summaryError")); setRepos([]); setSelectedPaths(new Set()); }
    }, 200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, open]);

  async function browse() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setDir(sel);
  }

  async function finish(skipRepos: boolean) {
    setBusy(true);
    try {
      const cur = await settingsLoad();
      await settingsSave({
        ...cur,
        repos_dir: skipRepos ? "" : dir.trim(),
        welcomed: true,
      });
      // Create projects for every path the user ticked in step 4.
      // Best-effort: log failures but don't block wizard close (the
      // user can re-add via the dashboard's Add project button).
      const toAdd = repos.filter(r => selectedPaths.has(r.path) && !r.already_added);
      if (toAdd.length > 0) {
        const created = await Promise.all(toAdd.map(r =>
          projectAdd(r.path).catch(err => { console.error("project add failed:", r.path, err); return null; })
        ));
        // Expand all newly-added projects so their "Get started" CTA
        // is visible without a manual click (Sidebar otherwise
        // defaults empty projects to collapsed).
        const setCollapsed = useApp.getState().setProjectCollapsed;
        for (const p of created) {
          if (p) setCollapsed(p.id, false);
        }
        // Refresh app store so the dashboard immediately shows what we added.
        try { await useApp.getState().loadAll(); } catch {}
        const okCount = created.filter(p => p !== null).length;
        if (okCount > 0) {
          useUI.getState().pushToast(
            t(okCount === 1 ? "welcome.toastAddedOne" : "welcome.toastAddedMany", { count: okCount }),
            "success",
          );
        }
      }
      close();
    } finally { setBusy(false); }
  }

  // The project picker only exists when it has something to pick. With no
  // repos directory it was a screen that said "nothing to suggest" and
  // offered one button, which is a step that exists to be dismissed.
  //
  // `dir` set but no summary yet means discovery is still running, and that
  // counts as useful: dropping the step for the 200ms before the answer
  // arrives would move Get started onto the theme step and then take it
  // away again.
  const discovering = !!dir.trim() && !summary;
  const lastStep: Step = repos.some(r => !r.already_added) || discovering ? 4 : 3;

  const next = () => setStep(s => (s < lastStep ? ((s + 1) as Step) : s));
  const back = () => setStep(s => (s > 0 ? ((s - 1) as Step) : s));

  return (
    <AppDialog open={open} onOpenChange={() => {}}
      hideClose className="max-w-[560px]"
    >
      {/* Whole header bar is a drag region so users can move the
          window by grabbing the title strip - same affordance as
          macOS app title bars. The pip buttons opt out via
          data-tauri-drag-region="false" so they stay clickable. */}
      <div
        data-tauri-drag-region
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        className="mb-4 flex items-center gap-3 -mt-1 cursor-grab active:cursor-grabbing select-none"
      >
        <TermicMark size={40} />
        <div className="flex-1 min-w-0">
          {/* The step's question, and the only line in the header. A
              subtitle under it restated the title in every case worth
              writing, so each step carries its explanation in the body
              instead, where there is room to be specific. */}
          {/* ONE LINE: about 33 characters at 18px in the strip left over
              beside the logo and the pips. `truncate` makes going over show
              as an ellipsis rather than quietly growing the header. */}
          <div className="truncate text-[18px] font-semibold leading-tight">
            {step === 0 && t("welcome.step0Title")}
            {step === 1 && t("welcome.step1Title")}
            {step === 2 && t("welcome.step2Title")}
            {step === 3 && t("welcome.step3Title")}
            {step === 4 && t("welcome.step4Title")}
          </div>
        </div>
        {/* Tiny pip indicator. Click to jump (handy for skipping back). */}
        <div
          className="flex gap-1.5"
          data-tauri-drag-region="false"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {Array.from({ length: lastStep + 1 }, (_, i) => i).map(i => (
            <button key={i} onClick={() => setStep(i as Step)}
              aria-label={t("welcome.stepAria", { n: i + 1 })}
              className={cn(
                "h-1.5 w-6 rounded-full transition-colors",
                i === step ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)] hover:bg-[var(--color-border-soft)]",
              )} />
          ))}
        </div>
      </div>

      {step === 0 && <StepConcepts />}
      {step === 1 && (
        <StepRepos
          dir={dir} setDir={setDir} summary={summary}
          clis={clis} setClis={setClis} browse={browse}
        />
      )}
      {step === 2 && <StepHooks clis={clis} />}
      {step === 3 && <StepTheme />}
      {step === 4 && (
        <StepProjects
          dir={dir}
          repos={repos}
          selected={selectedPaths}
          setSelected={setSelectedPaths}
        />
      )}

      {/* Skip alone on the far left, away from the pair you use to move
          through the wizard: it is the one button here that abandons the
          step rather than advancing it, and it sat next to Next. Back and
          Next are together on the right so stepping either way is one short
          move. */}
      <div className="mt-5 flex items-center justify-between gap-2">
        <div>
          {step < lastStep && (
            <Button variant="ghost" type="button" onClick={next} disabled={busy}>
              {t("common:skip")}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" type="button" onClick={back} disabled={step === 0 || busy}>
            {t("common:back")}
          </Button>
          {step < lastStep && (
            <Button variant="primary" type="button" onClick={next} disabled={busy}>
              {t("common:next")}
            </Button>
          )}
          {/* `>=`, not `===`: discovery can come back empty while the user is
              already standing on the picker, and a step with neither Next nor
              Finish is a dialog with no way out. */}
          {step >= lastStep && (
            <Button variant="primary" type="button" onClick={() => finish(!dir.trim())} disabled={busy}>
              {busy
                ? t("welcome.adding")
                : selectedPaths.size > 0
                  ? t(selectedPaths.size === 1 ? "welcome.addProjectsOne" : "welcome.addProjectsMany", { count: selectedPaths.size })
                  : t("welcome.getStarted")}
            </Button>
          )}
        </div>
      </div>
    </AppDialog>
  );
}

// ── Step 1: repos + CLI detection ────────────────────────────────────
function StepRepos({ dir, setDir, summary, clis, setClis, browse }: {
  dir: string; setDir: (v: string) => void; summary: string; clis: CliInfo[];
  setClis: (v: CliInfo[]) => void;
  browse: () => void;
}) {
  const { t } = useTranslation("dialogs");
  // Manually point Termic at an agent CLI binary when PATH detection
  // missed it. Common reasons: the user's `claude` is a shell function
  // (only visible to interactive zsh), or termic was launched from
  // Finder where the GUI process gets a stripped PATH that doesn't
  // include /opt/homebrew/bin. Saves the absolute path to the agent
  // registry so the spawn uses it regardless of PATH at launch time.
  async function pickBinary(name: string) {
    const displayName = CLI_LABEL[name] ?? name;
    const picked = await openDialog({
      title: t("welcome.pickBinaryTitle", { name: displayName }),
      multiple: false,
      directory: false,
    });
    if (!picked || typeof picked !== "string") return;
    // Load current settings + update the agent for this CLI in place.
    // We do NOT touch other agents (custom ones the user added stay
    // intact); we DO recreate the entry from defaults if missing.
    try {
      const settings = await settingsLoad();
      const agents = Array.isArray(settings.agents) ? [...settings.agents] : [];
      const idx = agents.findIndex(a => a.id === name);
      if (idx < 0) {
        // Built-in CLI entries are always present (defaults seed on
        // first settings load). If somehow missing, bail rather than
        // synthesize an incomplete Agent — the user can re-trigger
        // the welcome wizard which will re-seed.
        console.error(`agent ${name} not in registry; skipping path save`);
        return;
      }
      agents[idx] = { ...agents[idx], command: picked };
      await agentsSave(agents);
      // Reflect in the local list so the UI updates immediately.
      setClis(clis.map(c => c.name === name ? { ...c, found: true, path: picked, version: "" } : c));
    } catch (e) { console.error("set binary path failed:", e); }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-[var(--color-fg-dim)]">
        {t("welcome.reposScanned")}
      </p>
      <label className="block text-[13.5px]">
        <div className="flex gap-2">
          <Input value={dir} onChange={e => setDir(e.target.value)} placeholder="~/Projects" />
          <Button variant="secondary" type="button" onClick={browse}>{t("common:browse")}</Button>
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-fg-faint)]">{summary}</div>
      </label>

      <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3">
        <div className="mb-2 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
          {t("welcome.agentClisTitle")}
        </div>
        {clis.length === 0 && (
          <div className="text-[13.5px] text-[var(--color-fg-faint)]">{t("welcome.checking")}</div>
        )}
        {clis.map(c => (
          <div key={c.name} className={cn("flex items-center gap-2 py-1 text-[13.5px]", !c.found && "opacity-70")}>
            {/* Most users will have one or two of these CLIs installed,
                not all four. Painting the absent ones red made every
                wizard look like a wall of failures. Now: found = green
                (status badge), missing = gray (neutral, "not relevant
                here"). The "Set path..." button is still available for
                anything you do want to wire up. */}
            <span className={c.found ? "text-[var(--color-ok)]" : "text-[var(--color-fg-faint)]"}>
              <CliIcon cli={c.name} className="h-4 w-4" />
            </span>
            <span className={cn("min-w-[60px]", !c.found && "text-[var(--color-fg-dim)]")}>{CLI_LABEL[c.name] ?? c.name}</span>
            {c.found ? (
              <span className="truncate font-mono text-[12px] text-[var(--color-fg-dim)]" title={c.path}>
                {c.version || c.path}
              </span>
            ) : (
              <>
                <span className="text-[var(--color-fg-faint)] text-[12px]">{t("welcome.notInstalled")}</span>
                <button
                  type="button"
                  onClick={() => pickBinary(c.name)}
                  className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
                  title={t("welcome.setPathTitle", { name: CLI_LABEL[c.name] ?? c.name })}
                >
                  {t("welcome.setPath")}
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <ForgeRows />
    </div>
  );
}

/** Issue #21: say up front whether the forge CLIs are there, and name
 *  exactly what stops working without them. PR features are CLI-backed by
 *  design (termic stores no tokens), so a missing `gh` is not a bug the
 *  user can debug from inside the app unless we tell them here. Same
 *  found-green / missing-gray language as the agent rows above: most
 *  people have one forge, not both, and a wall of red reads as failure. */
function ForgeRows() {
  const { t } = useTranslation("dialogs");
  const forges = usePr(s => s.forges);
  const refreshForges = usePr(s => s.refreshForges);
  useEffect(() => { void refreshForges(); }, [refreshForges]);
  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
        <GitPullRequest className="h-3.5 w-3.5" />
        {t("welcome.prSectionTitle")}
      </div>
      {forges === null && (
        <div className="text-[13.5px] text-[var(--color-fg-faint)]">{t("welcome.checking")}</div>
      )}
      {(forges ?? []).map(f => (
        <div key={f.id} className={cn("flex items-center gap-2 py-1 text-[13.5px]", !f.authed && "opacity-70")}>
          <span className={f.authed ? "text-[var(--color-ok)]" : "text-[var(--color-fg-faint)]"}>
            <GitPullRequest className="h-4 w-4" />
          </span>
          <span className={cn("min-w-[60px]", !f.authed && "text-[var(--color-fg-dim)]")}>
            {f.provider === "gitlab" ? "GitLab" : "GitHub"}
          </span>
          {!f.found ? (
            <span className="text-[12px] text-[var(--color-fg-faint)]">
              <span className="font-mono">{f.id}</span> {t("welcome.notInstalled")} ·{" "}
              <span className="font-mono">brew install {f.id}</span>
            </span>
          ) : !f.authed ? (
            <span className="text-[12px] text-[var(--color-fg-faint)]">
              {t("welcome.signedOut")} · <span className="font-mono">{f.id} auth login</span>
            </span>
          ) : (
            <span className="truncate font-mono text-[12px] text-[var(--color-fg-dim)]" title={f.path}>
              {f.account ? `${f.id} · ${f.account}` : f.version || f.path}
            </span>
          )}
        </div>
      ))}
      <div className="mt-1.5 text-[12px] text-[var(--color-fg-faint)]">
        {t("welcome.forgeNote")}
      </div>
    </div>
  );
}

// ── Step 2: agent hooks ──────────────────────────────────────────────
// Recommended-on: supported agents are wired the moment the user lands here,
// and the row says so with a Remove next to it. That is deliberate, and it is
// the one place termic writes into a file the USER owns, so the step names the
// file rather than burying it. Agents we cannot wire say why instead of
// quietly missing from the list, which is the mistake the competing
// implementation makes in the other direction.
// ── Step 0: what a project and a task are ───────────────────────────
//
// A REPLICA of the sidebar, not an illustration of one: the same class
// strings, the same `--task-row-h`, the same `TaskLocationIcon` and
// `TaskWorkBadge` the real rows use. A loose approximation is worse than
// nothing here, because the whole job of this step is that the user
// recognises the thing when they see it a minute later.
//
// Captions sit OUTSIDE the panel, one per row. Putting them inside would
// have meant a sidebar that looks like no sidebar they will ever see.
//
// Two things are being taught. What the marks mean, which is otherwise only
// discoverable by hovering a badge that the close button covers. And what a
// worktree is, which users get wrong in a specific and expensive way: they
// read it as a way of making a branch, work for a week, and wonder why their
// editor never showed any of it. So the toggle from the New Task dialog is
// reproduced here, with the consequence spelled out under each side.
type ConceptRow = {
  name: string;
  /** Draw the location icon. Only the two rows that TEACH it do, so the mark
   *  being explained is the only thing changing on every row below them. The
   *  real sidebar shows it on every row; here it would be noise competing
   *  with the lesson. */
  loc?: boolean;
  main?: boolean;
  open?: boolean;
  badge?: React.ReactNode;
  caption: React.ReactNode;
};

const HELD = (over: Partial<DelegatedWork> = {}): DelegatedWork =>
  ({ label: "subagent", count: 2, ids: [], ...over });

/** A function of `t`, not a module constant: every caption is a lesson the
 *  user is reading in their own language, and the factory re-runs on a
 *  language switch (StepConcepts re-renders through its own `t`). */
const conceptRowsOf = (t: (key: string, opts?: Record<string, unknown>) => string): ConceptRow[] => [
  // The two locations FIRST, adjacent and otherwise identical, so the only
  // thing that differs between them is the icon. Main checkout leads because
  // it is what a new task gets. Everything below teaches a mark instead, so
  // the two lessons never overlap in one row.
  // These two name the icon, because the icon IS the lesson: the rows are
  // otherwise identical and the caption is the only place the word appears.
  { name: "hotfix-typo", main: true, loc: true, caption: (
    <><Term icon={Link2}>{t("welcome.conceptMainCheckout")}</Term> {t("welcome.conceptMainEdits")}</>) },
  { name: "fix-login", loc: true, caption: (
    <><Term icon={GitBranch}>{t("welcome.conceptWorktree")}</Term> {t("welcome.conceptWorktreeDesc")}</>) },
  { name: "refactor-auth", open: true, badge: <TaskWorkBadge reason="working" />,
    caption: t("welcome.conceptWorking") },
  { name: "nightly-sweep", open: true,
    badge: <TaskWorkBadge reason="delegated" delegated={HELD()} />,
    caption: t("welcome.conceptDelegated") },
  { name: "flaky-test", open: true,
    badge: <TaskWorkBadge reason="working" delegated={HELD({ count: 1, partial: true })} />,
    caption: t("welcome.conceptPartial") },
  { name: "release-notes", open: true, badge: <TaskWorkBadge reason="done" />,
    caption: t("welcome.conceptDone") },
  { name: "deps-bump", open: true, badge: <TaskWorkBadge reason="attention" />,
    caption: t("welcome.conceptAttention") },
];

/** The word a caption is teaching, brighter than the rest of the line, with
 *  the glyph beside it. The icon appears twice on purpose: once in the row
 *  and once next to its name, which is the only place the two are actually
 *  joined up. */
function Term({ icon: Icon, children }: { icon: typeof Link2; children: React.ReactNode }) {
  return (
    <strong className="mr-1 inline-flex items-center gap-1 align-[-2px] font-medium text-[var(--color-fg-dim)]">
      <Icon className="h-3 w-3" />{children}:
    </strong>
  );
}

/** The two rows above the task list, rendered twice: once in the replica and
 *  once invisibly beside it, which is what keeps the captions aligned. */
function SidebarReplicaHeaders() {
  const { t } = useTranslation("dialogs");
  return (
    <>
      <div className="flex items-center justify-between px-2 py-1 text-[12px] uppercase tracking-wider text-[var(--color-fg-dim)]">
        <span>{t("welcome.replicaProjects")}</span>
        <FolderPlus className="h-3.5 w-3.5" />
      </div>
      <div className="flex items-center justify-between rounded-md py-1.5 pl-2 pr-0 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg)]">
        <span className="flex items-center gap-1">
          <ChevronDown className="h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
          acme-api
        </span>
        <Plus className="mr-1 h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
      </div>
    </>
  );
}

function StepConcepts() {
  const { t } = useTranslation("dialogs");
  const conceptRows = conceptRowsOf(t);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-[var(--color-fg-dim)]">
        <Trans t={t} i18nKey="welcome.conceptIntro"
          components={{ b: <strong className="font-medium text-[var(--color-fg)]" /> }} />
      </p>

      <div className="flex gap-3">
        {/* The replica. Widths and paddings are the sidebar's own. */}
        <div className="w-[176px] shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] px-2 py-2">
          <SidebarReplicaHeaders />
          {conceptRows.map(r => (
            <div
              key={r.name}
              className="mb-px ml-3 flex h-[var(--task-row-h)] items-center gap-1 rounded-md px-1 text-[13px] text-[var(--color-fg-dim)]"
            >
              {r.open
                ? <ChevronRight className="mx-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                : <Moon className="mx-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)] opacity-40" />}
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="min-w-0 truncate font-medium">{r.name}</span>
                {r.loc && <TaskLocationIcon isMainCheckout={!!r.main} />}
              </div>
              <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                {r.badge}
              </span>
            </div>
          ))}
        </div>

        {/* One caption per row, on the same row height, so the eye pairs them
            without a leader line. */}
        {/* Same BOX as the panel beside it, transparent: a 1px border and
            `py-2`. Without them every caption sits ~9px high, which is the
            panel's padding and border, and the pairing reads as broken even
            though the rows themselves are identical. Repeating the box is
            what keeps the two columns in step; matching numbers by hand did
            not survive the first look. */}
        <div className="flex min-w-0 flex-1 flex-col border border-transparent py-2">
          {/* The headers again, invisible, so the captions line up with the
              rows whatever those headers measure. */}
          <div aria-hidden className="invisible"><SidebarReplicaHeaders /></div>
          {conceptRows.map(r => (
            <div
              key={r.name}
              className="mb-px flex h-[var(--task-row-h)] items-center truncate whitespace-nowrap text-[11.5px] text-[var(--color-fg-faint)]"
            >
              {r.caption}
            </div>
          ))}
        </div>
      </div>

      {/* The New Task toggle, reproduced. Same icons, same labels, same
          shape, so the choice is already familiar when it is live. */}
      <div className="rounded-md border border-[var(--color-border)] p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-[var(--color-fg)]">{t("welcome.conceptTaskType")}</span>
          <div className="inline-flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
            {/* Main checkout lit, because that is what the dialog actually
                seeds for a single repo (`readLastMode() ?? "repo_root"` in
                NewTaskDialog). Drawing the other one selected taught the
                wrong default, which is worse than teaching nothing. */}
            <span className="flex h-7 items-center gap-1.5 rounded-[5px] bg-[var(--color-accent-deep)] px-2.5 text-[12.5px] text-white">
              <Link2 className="h-3.5 w-3.5" /> {t("welcome.conceptMainCheckout")}
            </span>
            <span className="flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] text-[var(--color-fg-dim)]">
              <GitBranch className="h-3.5 w-3.5" /> {t("welcome.conceptWorktree")}
            </span>
          </div>
        </div>
        <p className="text-[12px] leading-snug text-[var(--color-fg-faint)]">
          <Link2 className="mr-1 inline h-3 w-3 align-[-2px]" />
          <Trans t={t} i18nKey="welcome.conceptMainBody"
            components={{ b: <strong className="font-medium text-[var(--color-fg-dim)]" /> }} />
        </p>
        <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-fg-faint)]">
          <GitBranch className="mr-1 inline h-3 w-3 align-[-2px]" />
          <Trans t={t} i18nKey="welcome.conceptWorktreeBody"
            components={{ b: <strong className="font-medium text-[var(--color-fg-dim)]" />, code: <code className="mx-1" /> }} />
        </p>
      </div>
    </div>
  );
}

/** `busy` holds an agent id while one row works; this stands in for "all of
 *  them", so the bulk button can show its own progress without a second
 *  piece of state. No agent can be called this. */
const ALL = "\u0000all";

function StepHooks({ clis }: { clis: CliInfo[] }) {
  const { t } = useTranslation("dialogs");
  const [rows, setRows] = useState<Record<string, AgentHookStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // `auto_install_hooks` in settings.json, read once on arrival so the box
  // reflects a user who already turned it on in a previous run.
  const [auto, setAutoState] = useState(false);
  // What each install actually writes, straight from `agent_hooks_plan`,
  // which builds it from the hook definitions. A hand-written line per agent
  // would be wrong the first time an event is added and nobody would notice,
  // because it is a sentence rather than a test.
  const [plans, setPlans] = useState<Record<string, HookPlan>>({});
  useEffect(() => {
    agentHooksAutoGet().then(setAutoState).catch(() => {});
  }, []);
  const setAuto = async (on: boolean) => {
    setAutoState(on);
    try {
      await agentHooksAutoSet(on);
      // Switching it on installs for everything wirable, so the rows below
      // have to be re-read or they keep showing "off" for agents that are
      // now on.
      const out: Record<string, AgentHookStatus> = {};
      for (const id of detected) {
        try { out[id] = await agentHooksStatus(id); } catch { /* leave it out */ }
      }
      setRows(r => ({ ...r, ...out }));
      await useApp.getState().refreshAgentHooks();
    } catch { setAutoState(!on); }
  };
  const detected = clis.filter(c => c.found && c.name !== "shell").map(c => c.name);

  // Auto-install once on arrival for everything we can wire. `ran` guards a
  // re-entry (the pips let the user jump back) so Remove is not undone.
  const [ran, setRan] = useState(false);
  useEffect(() => {
    if (ran || !detected.length) return;
    setRan(true);
    void (async () => {
      const plansOut: Record<string, HookPlan> = {};
      await Promise.all(detected.map(async id => {
        try { plansOut[id] = await agentHooksPlan(id); } catch { /* row works without it */ }
      }));
      setPlans(plansOut);
      const out: Record<string, AgentHookStatus> = {};
      for (const id of detected) {
        try {
          const st = await agentHooksStatus(id);
          out[id] = st.supported && !st.host.installed && !st.host.disabled_all
            ? await agentHooksInstall(id).catch(() => st)
            : st;
        } catch { /* a row we cannot read is a row we do not show a button for */ }
      }
      setRows(out);
    })();
  }, [ran, detected]);

  // Every agent this step could wire and has not. The arrival pass already
  // installs what it can, so this is only ever non-empty after a Remove or a
  // failure, which is exactly when a per-row hunt is the wrong shape.
  const offAgents = detected.filter(id => {
    const st = rows[id];
    return st?.supported && !st.host.disabled_all && !st.host.installed;
  });
  const offCount = offAgents.length;

  const installAll = async () => {
    setBusy(ALL);
    try {
      for (const id of offAgents) {
        try {
          const next = await agentHooksInstall(id);
          setRows(r => ({ ...r, [id]: next }));
        } catch { /* leave that row as it was; Settings surfaces the error */ }
      }
    } finally { setBusy(null); }
  };

  const toggle = async (id: string, install: boolean) => {
    setBusy(id);
    try {
      const next = install ? await agentHooksInstall(id) : await agentHooksRemove(id);
      setRows(r => ({ ...r, [id]: next }));
    } catch { /* leave the row as it was; Settings surfaces the error */ }
    finally { setBusy(null); }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* What a hook IS, in the first sentence. This used to open with the
          problem and call the fix "a small hook", which names it without
          saying what it is: a file? a daemon? something phoning home? */}
      <p className="text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        {t("welcome.hooksIntro")}
      </p>
      <p className="text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        {t("welcome.hooksWithout")}
      </p>
      {/* The same switch as Settings -> Agents & Terminals
          (`agent_hooks_auto_set`), not a second one that means something
          similar: this is the decision most people want, and it is the only
          one here that also covers agents installed LATER. Without it a
          wizard run wires what happens to be on PATH today and quietly
          leaves the next agent guessing.

          Recommended and pre-armed rather than sold: the label says what it
          does and the hint says what it saves, which is the honest version
          of an incentive. */}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/[0.07] px-3 py-2.5">
        <input
          type="checkbox"
          data-testid="welcome-hooks-auto"
          className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
          checked={auto}
          disabled={busy === ALL}
          onChange={e => void setAuto(e.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-[var(--color-fg)]">
            {t("welcome.hooksAutoLabel")}
            <span className="ml-1.5 rounded bg-[var(--color-accent)]/15 px-1.5 py-px text-[10.5px] uppercase tracking-wider text-[var(--color-accent)]">
              {t("welcome.recommended")}
            </span>
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-[var(--color-fg-dim)]">
            {t("welcome.hooksAutoHint")}
          </span>
        </span>
      </label>

      {offCount > 1 && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2">
          <span className="text-[12.5px] text-[var(--color-fg-dim)]">
            {t(offCount === 1 ? "welcome.hooksOffOne" : "welcome.hooksOffMany", { count: offCount })}
          </span>
          <Button variant="secondary" type="button" disabled={!!busy} onClick={installAll}>
            {busy === ALL ? t("welcome.installingAll") : t("welcome.installForAll")}
          </Button>
        </div>
      )}
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-faint)]">
        {t("welcome.agentsFound")}
      </div>
      {/* Capped at about four rows. Nine agents at two lines each ran the
          dialog past the bottom of a laptop screen, which put Next off
          screen: the list is the long part and the only part that can
          scroll on its own. `pr-1` keeps the scrollbar off the Remove
          buttons. */}
      <div className="-mt-1.5 flex max-h-[248px] flex-col gap-1.5 overflow-y-auto pr-1">
        {detected.length === 0 && (
          <p className="text-[12.5px] text-[var(--color-fg-dim)]">
            {t("welcome.hooksNone")}
          </p>
        )}
        {detected.map(id => {
          const st = rows[id];
          return (
            <div key={id}
              className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <CliIcon cli={id} className="h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[13px]">{CLI_LABEL[id] ?? id}</div>
                  {plans[id]?.entries.length ? (
                    <div
                      className="truncate text-[11px] text-[var(--color-fg-faint)]"
                      title={`${plans[id].entries.map(e => `${e.event} reports ${e.reports}`).join("\n")}\n\n${t("welcome.hookPlanIn", { file: plans[id].config_path })}`}
                    >
                      {plans[id].entries.map(e => e.event).join(", ")}
                      {" "}
                      {t("welcome.hookPlanIn", { file: plans[id].config_path.replace(/^.*\//, "") })}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* codex used to be special-cased here to "not needed", on the
                    grounds that its title already reports a permission prompt.
                    It does, and that was never the state that broke: an agent
                    with no hooks can never stand the heuristics down, so every
                    turn it runs ends in a guess (GH #276). It is wired now, so
                    the special case is gone and every unsupported agent reads
                    the same. */}
                <span className="text-[11.5px] text-[var(--color-fg-dim)]">
                  {!st ? t("welcome.hookChecking")
                    : !st.supported ? t("welcome.hookUnsupported")
                    : st.host.disabled_all ? t("welcome.hookDisabled")
                    : st.host.installed ? t("welcome.hookOn") : t("welcome.hookOff")}
                </span>
                {st?.supported && !st.host.disabled_all && (
                  <Button variant="ghost" type="button" disabled={busy === id}
                    onClick={() => toggle(id, !st.host.installed)}>
                    {busy === id ? "…" : st.host.installed ? t("common:remove") : t("welcome.install")}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* Name the file. This is the user's own config, not ours. */}
      {Object.values(rows).some(r => r.supported && r.host.installed) && (
        <p className="text-[11.5px] text-[var(--color-fg-dim)]">
          {t("welcome.hooksNote")}
        </p>
      )}
    </div>
  );
}

// ── Step 2: theme picker with visual previews ────────────────────────
// Live-applies on click so the user sees the change immediately - the
// rest of the app rerenders into the new palette behind the dialog,
// dialog itself stays anchored.
const THEME_ITEMS: { id: ThemeMode; label: string; icon: typeof Sun; swatch: [string, string, string] }[] = [
  { id: "auto",      label: "System",         icon: Monitor, swatch: ["#0a0a0a", "#fdf6e3", "#d97757"] },
  { id: "light",     label: "Light",          icon: Sun,     swatch: ["#faf9f6", "#1c1b1a", "#c25e3d"] },
  { id: "claude",    label: "Claude",         icon: Moon,    swatch: ["#1f1e1d", "#f5f4ee", "#d97757"] },
  { id: "dark",      label: "Dark+",          icon: Code2,   swatch: ["#0c0c0c", "#e8e6e2", "#d97757"] },
  { id: "solarized", label: "Solarized Dark", icon: Sunrise, swatch: ["#002b36", "#93a1a1", "#cb4b16"] },
  { id: "cobalt",    label: "Cobalt",         icon: Droplet, swatch: ["#193549", "#e1efff", "#66c4ff"] },
  { id: "matrix",    label: "Matrix",         icon: Binary,  swatch: ["#000800", "#00ff41", "#00ff41"] },
  { id: "rosepine",  label: "Rosé Pine",      icon: Flower2, swatch: ["#191724", "#e0def4", "#ebbcba"] },
];
function StepTheme() {
  const { t } = useTranslation("dialogs");
  const themeMode = usePrefs(s => s.themeMode);
  const setThemeMode = usePrefs(s => s.setThemeMode);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-[var(--color-fg-dim)]">
        {t("welcome.themeIntro")}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {THEME_ITEMS.map(item => {
          const active = item.id === themeMode;
          const Ic = item.icon;
          const [bg, fg, accent] = item.swatch;
          return (
            <button
              key={item.id} type="button"
              onClick={() => { setThemeMode(item.id); applyTheme(item.id); }}
              className={cn(
                "flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-bg-1)]"
                  : "border-[var(--color-border-soft)] hover:border-[var(--color-border)] bg-[var(--color-bg)]",
              )}
            >
              {/* Swatch preview - bg surface, fg text on top of it, accent stripe. */}
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md ring-1 ring-black/20"
                style={{ background: bg }}
              >
                <span className="text-[11px] font-bold" style={{ color: fg }}>Aa</span>
                <span className="absolute -mb-7 ml-7 h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg)]">
                  <Ic className="h-3.5 w-3.5 text-[var(--color-fg-dim)]" />
                  {item.label}
                </span>
                <span className="text-[11.5px] text-[var(--color-fg-faint)]">
                  {item.id === "auto" && t("welcome.themeSubAuto")}
                  {item.id === "light" && t("welcome.themeSubLight")}
                  {item.id === "claude" && t("welcome.themeSubClaude")}
                  {item.id === "dark" && t("welcome.themeSubDark")}
                  {item.id === "solarized" && t("welcome.themeSubSolarized")}
                  {item.id === "cobalt" && t("welcome.themeSubCobalt")}
                  {item.id === "matrix" && t("welcome.themeSubMatrix")}
                  {item.id === "rosepine" && t("welcome.themeSubRosepine")}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 3: pick discovered projects to add ──────────────────────────
// Reuses the repo list discovered in step 1 (no second IPC trip).
// User ticks the repos they want, "Add N projects" creates them; the
// wizard closes onto a populated dashboard instead of a sandbox lecture.
// Sandbox itself is discoverable via the shield icon on task
// rows + the dialog behind it - users don't need a tour on day 1.
function StepProjects({ dir, repos, selected, setSelected }: {
  dir: string;
  repos: DiscoveredRepo[];
  selected: Set<string>;
  setSelected: (v: Set<string>) => void;
}) {
  const { t } = useTranslation("dialogs");
  const unadded = repos.filter(r => !r.already_added);
  const added = repos.filter(r => r.already_added);

  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const visibleUnadded = q
    ? unadded.filter(r =>
        r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)
      )
    : unadded;

  const toggle = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path); else next.add(path);
    setSelected(next);
  };
  // "all" respects the active filter — selects what's visible only,
  // merged with prior selections so a partial filter doesn't drop them.
  const checkAll = () => {
    const next = new Set(selected);
    for (const r of visibleUnadded) next.add(r.path);
    setSelected(next);
  };
  const checkNone = () => setSelected(new Set());

  if (!dir.trim()) {
    return (
      <div className="flex flex-col gap-3 text-[13px] text-[var(--color-fg-dim)]">
        <p>{t("welcome.skippedDir")}</p>
        <p className="text-[12px] text-[var(--color-fg-faint)]">
          {t("welcome.skippedDirHint")}
        </p>
      </div>
    );
  }
  if (repos.length === 0) {
    return (
      <div className="flex flex-col gap-3 text-[13px] text-[var(--color-fg-dim)]">
        <p>
          <Trans
            t={t}
            i18nKey="welcome.noReposInDir"
            values={{ dir }}
            components={{ code: <code className="mono" /> }}
          />
        </p>
        <p className="text-[12px] text-[var(--color-fg-faint)]">
          {t("welcome.noReposHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-[12.5px] text-[var(--color-fg-dim)]">
        <span>
          {unadded.length === 0
            ? t(repos.length === 1 ? "welcome.allAddedOne" : "welcome.allAddedMany", { count: repos.length })
            : t(unadded.length === 1 ? "welcome.unaddedInfoOne" : "welcome.unaddedInfoMany", { count: unadded.length, dir })}
        </span>
        {unadded.length > 0 && (
          <div className="flex gap-2">
            <button type="button" onClick={checkAll} className="text-[var(--color-accent)] hover:underline">{t("welcome.all")}</button>
            <button type="button" onClick={checkNone} className="text-[var(--color-fg-faint)] hover:text-[var(--color-fg)] hover:underline">{t("welcome.none")}</button>
          </div>
        )}
      </div>

      {unadded.length > 5 && (
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("welcome.filterPlaceholder")}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
        />
      )}

      {unadded.length > 0 && visibleUnadded.length === 0 && (
        <div className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-4 text-center text-[12px] text-[var(--color-fg-faint)]">
          {t("welcome.noReposMatch", { filter })}
        </div>
      )}

      {visibleUnadded.length > 0 && (
        <div className="max-h-[280px] overflow-y-auto rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)]">
          {visibleUnadded.map(r => {
            const isOn = selected.has(r.path);
            return (
              <div
                key={r.path}
                onClick={() => toggle(r.path)}
                className="flex cursor-pointer items-center gap-3 border-b border-[var(--color-border-soft)] px-3 py-2 last:border-b-0 hover:bg-[var(--color-hover)]"
              >
                <Checkbox checked={isOn} onChange={() => toggle(r.path)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{r.name}</div>
                  <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{r.path}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {added.length > 0 && (
        <details className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/50 px-3 py-2 text-[12px] text-[var(--color-fg-dim)]">
          <summary className="cursor-pointer select-none">
            {t(added.length === 1 ? "welcome.alreadyAddedOne" : "welcome.alreadyAddedMany", { count: added.length })}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-0.5 pl-1">
            {added.map(r => (
              <li key={r.path} className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{r.name}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-[11.5px] text-[var(--color-fg-faint)]">
        {t("welcome.projectsFooter")}
      </p>
    </div>
  );
}

