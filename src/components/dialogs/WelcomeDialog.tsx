// First-launch welcome wizard. Three steps:
//   1. Repos directory + CLI detection (original behavior).
//   2. Theme picker - visual previews so the user can lock in their
//      preference before they're staring at it for hours.
//   3. Sandbox intro - explain what it is, set the global default,
//      acknowledge that nothing is sandboxed unless they opt in.
//
// Wizard layout: header + step body + footer with Back / Skip / Next-or-
// Finish. Step state persists across nav so backing up doesn't wipe
// their pick. `welcomed=true` only writes on Finish; closing via Escape
// is intentionally blocked so the user can't accidentally bypass setup.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUI } from "@/store/ui";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { discoverRepos, detectClis, settingsLoad, settingsSave, agentsSave, projectAdd } from "@/lib/ipc";
import { Checkbox } from "@/components/ui/Checkbox";
import type { CliInfo, DiscoveredRepo } from "@/lib/types";
import { useApp } from "@/store/app";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { TermicMark } from "@/icons/TermicLogo";
import { cn } from "@/lib/utils";
import { usePrefs, applyTheme, type ThemeMode } from "@/store/prefs";
import { Sun, Moon, Monitor, Sunrise, Droplet, Binary, Code2 } from "lucide-react";

type Step = 0 | 1 | 2;

export function WelcomeDialog() {
  const open = useUI(s => s.welcomeOpen);
  const close = useUI(s => s.closeWelcome);
  const [step, setStep] = useState<Step>(0);

  // Step 1 state.
  const [dir, setDir] = useState("");
  const [summary, setSummary] = useState("");
  const [clis, setClis] = useState<CliInfo[]>([]);
  // Discovered repos (populated by the step-0 effect below). Lifted to
  // the parent so step 3's project-picker has the data ready without
  // re-fetching when the user reaches it.
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  // Selected paths for step 3. Defaults to all-unadded checked when
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
    const t = window.setTimeout(async () => {
      try {
        const found = await discoverRepos(dir);
        setRepos(found);
        // Don't pre-check anything. Auto-adding every repo in a dev
        // directory is wildly invasive on first launch — let the user
        // tick what they actually want.
        setSelectedPaths(new Set());
        const unadded = found.filter(r => !r.already_added).length;
        setSummary(found.length === 0
          ? `No git repos found in ${dir}.`
          : `Found ${found.length} repo${found.length === 1 ? "" : "s"} (${unadded} not yet added).`);
      } catch { setSummary("Couldn't read that path."); setRepos([]); setSelectedPaths(new Set()); }
    }, 200);
    return () => window.clearTimeout(t);
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
      // Create projects for every path the user ticked in step 3.
      // Best-effort: log failures but don't block wizard close (the
      // user can re-add via the dashboard's Add project button).
      const toAdd = repos.filter(r => selectedPaths.has(r.path) && !r.already_added);
      if (toAdd.length > 0) {
        await Promise.all(toAdd.map(r =>
          projectAdd(r.path).catch(err => console.error("project add failed:", r.path, err))
        ));
        // Refresh app store so the dashboard immediately shows what we added.
        try { await useApp.getState().loadAll(); } catch {}
      }
      close();
    } finally { setBusy(false); }
  }

  const next = () => setStep(s => (s < 2 ? ((s + 1) as Step) : s));
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
          <div className="text-[18px] font-semibold leading-tight">Welcome to Termic</div>
          <div className="text-[12.5px] text-[var(--color-fg-dim)]">
            {step === 0 && "Repos & CLIs."}
            {step === 1 && "Pick your theme."}
            {step === 2 && "Pick projects to add."}
          </div>
        </div>
        {/* Tiny pip indicator. Click to jump (handy for skipping back). */}
        <div
          className="flex gap-1.5"
          data-tauri-drag-region="false"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {[0, 1, 2].map(i => (
            <button key={i} onClick={() => setStep(i as Step)}
              aria-label={`Step ${i + 1}`}
              className={cn(
                "h-1.5 w-6 rounded-full transition-colors",
                i === step ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)] hover:bg-[var(--color-border-soft)]",
              )} />
          ))}
        </div>
      </div>

      {step === 0 && (
        <StepRepos
          dir={dir} setDir={setDir} summary={summary}
          clis={clis} setClis={setClis} browse={browse}
        />
      )}
      {step === 1 && <StepTheme />}
      {step === 2 && (
        <StepProjects
          dir={dir}
          repos={repos}
          selected={selectedPaths}
          setSelected={setSelectedPaths}
        />
      )}

      <div className="mt-5 flex items-center justify-between gap-2">
        <Button variant="ghost" type="button" onClick={back} disabled={step === 0 || busy}>
          Back
        </Button>
        <div className="flex gap-2">
          {step < 2 && (
            <Button variant="ghost" type="button" onClick={next} disabled={busy}>
              Skip
            </Button>
          )}
          {step < 2 && (
            <Button variant="primary" type="button" onClick={next} disabled={busy}>
              Next
            </Button>
          )}
          {step === 2 && (
            <Button variant="primary" type="button" onClick={() => finish(!dir.trim())} disabled={busy}>
              {busy
                ? "Adding…"
                : selectedPaths.size > 0
                  ? `Add ${selectedPaths.size} project${selectedPaths.size === 1 ? "" : "s"}`
                  : "Get started"}
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
  // Manually point Termic at an agent CLI binary when PATH detection
  // missed it. Common reasons: the user's `claude` is a shell function
  // (only visible to interactive zsh), or termic was launched from
  // Finder where the GUI process gets a stripped PATH that doesn't
  // include /opt/homebrew/bin. Saves the absolute path to the agent
  // registry so the spawn uses it regardless of PATH at launch time.
  async function pickBinary(name: string) {
    const picked = await openDialog({
      title: `Pick the ${name} binary`,
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
      <label className="block text-[13.5px]">
        Where do you keep your repos?{" "}
        <span className="text-[var(--color-fg-faint)] font-normal">
          (we'll suggest unadded ones)
        </span>
        <div className="mt-1.5 flex gap-2">
          <Input value={dir} onChange={e => setDir(e.target.value)} placeholder="~/Projects" />
          <Button variant="secondary" type="button" onClick={browse}>Browse…</Button>
        </div>
        <div className="mt-1 text-[12px] text-[var(--color-fg-faint)]">{summary}</div>
      </label>

      <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3">
        <div className="mb-2 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
          Agent CLIs on your PATH
        </div>
        {clis.length === 0 && (
          <div className="text-[13.5px] text-[var(--color-fg-faint)]">Checking…</div>
        )}
        {clis.map(c => (
          <div key={c.name} className={cn("flex items-center gap-2 py-1 text-[13.5px]", !c.found && "opacity-80")}>
            <span className={c.found ? CLI_BRAND_COLOR[c.name] : "text-[var(--color-fg-faint)]"}>
              <CliIcon cli={c.name} className="h-4 w-4" />
            </span>
            <span className="min-w-[60px]">{c.name}</span>
            {c.found ? (
              <span className="truncate font-mono text-[12px] text-[var(--color-fg-dim)]" title={c.path}>
                {c.version || c.path}
              </span>
            ) : (
              <>
                <span className="text-[var(--color-err)] text-[12px]">not installed</span>
                <button
                  type="button"
                  onClick={() => pickBinary(c.name)}
                  className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
                  title={`Locate the ${c.name} binary manually`}
                >
                  Set path…
                </button>
              </>
            )}
          </div>
        ))}
      </div>
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
  { id: "dark",      label: "Dark",           icon: Moon,    swatch: ["#0a0a0a", "#f0efed", "#d97757"] },
  { id: "vscode",    label: "VS Code Dark",   icon: Code2,   swatch: ["#1e1e1e", "#d4d4d4", "#d97757"] },
  { id: "solarized", label: "Solarized Dark", icon: Sunrise, swatch: ["#002b36", "#93a1a1", "#cb4b16"] },
  { id: "cobalt",    label: "Cobalt",         icon: Droplet, swatch: ["#193549", "#e1efff", "#66c4ff"] },
  { id: "matrix",    label: "Matrix",         icon: Binary,  swatch: ["#000800", "#00ff41", "#00ff41"] },
];
function StepTheme() {
  const themeMode = usePrefs(s => s.themeMode);
  const setThemeMode = usePrefs(s => s.setThemeMode);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-[var(--color-fg-dim)]">
        Live-applies as you click. Change anytime from the top toolbar.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {THEME_ITEMS.map(t => {
          const active = t.id === themeMode;
          const Ic = t.icon;
          const [bg, fg, accent] = t.swatch;
          return (
            <button
              key={t.id} type="button"
              onClick={() => { setThemeMode(t.id); applyTheme(t.id); }}
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
                  {t.label}
                </span>
                <span className="text-[11.5px] text-[var(--color-fg-faint)]">
                  {t.id === "auto" && "follows macOS"}
                  {t.id === "light" && "cream + terracotta"}
                  {t.id === "dark" && "warm near-black"}
                  {t.id === "solarized" && "Schoonover palette"}
                  {t.id === "cobalt" && "deep navy + sky blue"}
                  {t.id === "matrix" && "phosphor green CRT"}
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
// Sandbox itself is discoverable via the shield icon on workspace
// rows + the dialog behind it - users don't need a tour on day 1.
function StepProjects({ dir, repos, selected, setSelected }: {
  dir: string;
  repos: DiscoveredRepo[];
  selected: Set<string>;
  setSelected: (v: Set<string>) => void;
}) {
  const unadded = repos.filter(r => !r.already_added);
  const added = repos.filter(r => r.already_added);

  const toggle = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path); else next.add(path);
    setSelected(next);
  };
  const checkAll = () => setSelected(new Set(unadded.map(r => r.path)));
  const checkNone = () => setSelected(new Set());

  if (!dir.trim()) {
    return (
      <div className="flex flex-col gap-3 text-[13px] text-[var(--color-fg-dim)]">
        <p>You skipped the repos directory in step 1. No projects to suggest.</p>
        <p className="text-[12px] text-[var(--color-fg-faint)]">
          You can add projects any time from the dashboard's "Add project" card,
          or pick a repos dir in Settings → General to enable discovery.
        </p>
      </div>
    );
  }
  if (repos.length === 0) {
    return (
      <div className="flex flex-col gap-3 text-[13px] text-[var(--color-fg-dim)]">
        <p>No git repos found in <code className="mono">{dir}</code>.</p>
        <p className="text-[12px] text-[var(--color-fg-faint)]">
          Either the path is empty or you went back and changed it — give the
          scanner a moment, or pick a different dir in step 1.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-[12.5px] text-[var(--color-fg-dim)]">
        <span>
          {unadded.length === 0
            ? `All ${repos.length} repo${repos.length === 1 ? "" : "s"} already added — nothing new to pick.`
            : `${unadded.length} unadded repo${unadded.length === 1 ? "" : "s"} in ${dir}. Tick what you want.`}
        </span>
        {unadded.length > 0 && (
          <div className="flex gap-2">
            <button type="button" onClick={checkAll} className="text-[var(--color-accent)] hover:underline">all</button>
            <button type="button" onClick={checkNone} className="text-[var(--color-fg-faint)] hover:text-[var(--color-fg)] hover:underline">none</button>
          </div>
        )}
      </div>

      {unadded.length > 0 && (
        <div className="max-h-[280px] overflow-y-auto rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)]">
          {unadded.map(r => {
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
            {added.length} repo{added.length === 1 ? "" : "s"} already added (won't duplicate)
          </summary>
          <ul className="mt-1.5 flex flex-col gap-0.5 pl-1">
            {added.map(r => (
              <li key={r.path} className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{r.name}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-[11.5px] text-[var(--color-fg-faint)]">
        Each project lets you spawn workspaces (git worktrees) per agent. You
        can also add projects later from the dashboard.
      </p>
    </div>
  );
}

