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
import { discoverRepos, detectClis, settingsSave } from "@/lib/ipc";
import type { CliInfo } from "@/lib/types";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { TermicMark } from "@/icons/TermicLogo";
import { cn } from "@/lib/utils";
import { usePrefs, applyTheme, type ThemeMode } from "@/store/prefs";
import { Sun, Moon, Monitor, Sunrise, Droplet, Binary, Shield, Network, FolderLock, Zap } from "lucide-react";

type Step = 0 | 1 | 2;

export function WelcomeDialog() {
  const open = useUI(s => s.welcomeOpen);
  const close = useUI(s => s.closeWelcome);
  const [step, setStep] = useState<Step>(0);

  // Step 1 state.
  const [dir, setDir] = useState("");
  const [summary, setSummary] = useState("");
  const [clis, setClis] = useState<CliInfo[]>([]);

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
    if (!open || !dir) { setSummary(""); return; }
    const t = window.setTimeout(async () => {
      try {
        const repos = await discoverRepos(dir);
        const unadded = repos.filter(r => !r.already_added).length;
        setSummary(repos.length === 0
          ? `No git repos found in ${dir}.`
          : `Found ${repos.length} repo${repos.length === 1 ? "" : "s"} (${unadded} not yet added).`);
      } catch { setSummary("Couldn't read that path."); }
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
      const { settingsLoad } = await import("@/lib/ipc");
      const cur = await settingsLoad();
      await settingsSave({
        ...cur,
        repos_dir: skipRepos ? "" : dir.trim(),
        welcomed: true,
      });
      close();
    } finally { setBusy(false); }
  }

  const next = () => setStep(s => (s < 2 ? ((s + 1) as Step) : s));
  const back = () => setStep(s => (s > 0 ? ((s - 1) as Step) : s));

  return (
    <AppDialog open={open} onOpenChange={() => {}}
      hideClose className="max-w-[560px]"
    >
      <div className="mb-4 flex items-center gap-3 -mt-1">
        <TermicMark size={40} />
        <div className="flex-1 min-w-0">
          <div className="text-[18px] font-semibold leading-tight">Welcome to Termic</div>
          <div className="text-[12.5px] text-[var(--color-fg-dim)]">
            {step === 0 && "Repos & CLIs."}
            {step === 1 && "Pick your theme."}
            {step === 2 && "Sandbox basics."}
          </div>
        </div>
        {/* Tiny pip indicator. Click to jump (handy for skipping back). */}
        <div className="flex gap-1.5">
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
          clis={clis} browse={browse}
        />
      )}
      {step === 1 && <StepTheme />}
      {step === 2 && <StepSandbox />}

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
              {busy ? "Saving…" : "Get started"}
            </Button>
          )}
        </div>
      </div>
    </AppDialog>
  );
}

// ── Step 1: repos + CLI detection ────────────────────────────────────
function StepRepos({ dir, setDir, summary, clis, browse }: {
  dir: string; setDir: (v: string) => void; summary: string; clis: CliInfo[];
  browse: () => void;
}) {
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
          <div key={c.name} className={cn("flex items-center gap-2 py-0.5 text-[13.5px]", !c.found && "opacity-60")}>
            <span className={c.found ? CLI_BRAND_COLOR[c.name] : "text-[var(--color-fg-faint)]"}>
              <CliIcon cli={c.name} className="h-4 w-4" />
            </span>
            <span className="min-w-[60px]">{c.name}</span>
            <span className="truncate font-mono text-[12px] text-[var(--color-fg-dim)]">
              {c.found ? (c.version || c.path) : <span className="text-[var(--color-err)]">not installed</span>}
            </span>
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

// ── Step 3: sandbox primer + global default ──────────────────────────
function StepSandbox() {
  const globalDefaultSandbox = usePrefs(s => s.globalDefaultSandbox);
  const setGlobalDefaultSandbox = usePrefs(s => s.setGlobalDefaultSandbox);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-[var(--color-fg-dim)]">
        Agents can run inside a kernel sandbox - the macOS one Apple uses to
        cage its own apps. When you enable it for a workspace:
      </p>
      <ul className="flex flex-col gap-2 text-[13px]">
        <li className="flex items-start gap-2">
          <FolderLock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span>
            <b className="text-[var(--color-fg)]">Filesystem is locked down.</b>{" "}
            The agent can read your repo, write to its worktree, touch its own
            config + caches. Secrets (<code className="mono">~/.ssh</code>,{" "}
            <code className="mono">~/.aws</code>, …) are always denied.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Network className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span>
            <b className="text-[var(--color-fg)]">Network goes through an allowlist.</b>{" "}
            Vendor APIs (anthropic / google / openai), GitHub, npm, pypi, crates.io
            are on by default. Anything else: blocked. You can add hosts per project.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span>
            <b className="text-[var(--color-fg)]">Per workspace, editable.</b>{" "}
            Each workspace owns its own sandbox config. Edit it anytime from
            the Shield icon on the workspace row - saving restarts the agent.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Zap className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-ok)]" />
          <span>
            <b className="text-[var(--color-fg)]">YOLO is auto-on inside the cage.</b>{" "}
            Sandboxed workspaces skip the agent's own permission prompts -
            the seatbelt profile is the real boundary, prompts are just
            friction once you're inside it. Outside the sandbox, the YOLO
            toolbar button turns <span className="text-[var(--color-err)] font-medium">red</span> as a warning.
          </span>
        </li>
      </ul>

      <label className="mt-2 inline-flex cursor-pointer items-start gap-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/60 p-3 select-none">
        <input
          type="checkbox"
          checked={globalDefaultSandbox}
          onChange={e => setGlobalDefaultSandbox(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span className="flex-1">
          <span className="text-[13.5px] font-medium text-[var(--color-fg)]">
            Sandbox new workspaces by default
          </span>
          <span className="mt-0.5 block text-[12px] text-[var(--color-fg-dim)]">
            You can flip this per project later. Already-existing workspaces aren't
            affected.
          </span>
        </span>
      </label>

      <p className="text-[11.5px] text-[var(--color-fg-faint)]">
        The host allowlist runs through an in-process proxy — no external
        dependency, no install step. Hit the Sandbox button on a workspace
        to tweak the per-workspace allowlist.
      </p>
    </div>
  );
}
