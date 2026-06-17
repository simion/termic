// General settings — repos discovery dir + desktop notifications. Loads the
// full Settings object so that saves preserve other fields (agents, etc.)
// instead of wiping them.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextareaHTMLAttributes } from "react";
import { settingsLoad, settingsSave, ensureNotifyPermission, previewCompletionSound } from "@/lib/ipc";
import type { Settings } from "@/lib/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Tip } from "@/components/ui/Tooltip";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { ExcludeEditor } from "./ExcludeEditor";
import { cn, cleanLines } from "@/lib/utils";
import { COMPLETION_SOUND_OPTIONS, COMPLETION_SOUND_SUPPORTED } from "@/lib/notificationSounds";

export function GeneralSection() {
  // Cache the full Settings object — saves merge into this so we don't
  // accidentally wipe `agents` (or future fields).
  const [settings, setSettings] = useState<Settings | null>(null);
  const [reposDir, setReposDir] = useState("");
  const [originalDir, setOriginalDir] = useState("");
  const [busy, setBusy] = useState(false);
  // Global sandbox defaults. Stored line-by-line as strings so the
  // user can edit mid-line without the array round-trip dropping
  // their cursor.
  const [sbRw, setSbRw]       = useState("");
  const [sbHosts, setSbHosts] = useState("");
  const [sbOriginal, setSbOriginal] = useState({ rw: "", hosts: "" });
  // Personal (global) file-tree exclude globs. Kept as an array so the
  // ExcludeEditor's preset chips can add/remove cleanly; joined for the
  // dirty check.
  const [fileExclude, setFileExclude] = useState<string[]>([]);
  const [fileExcludeOriginal, setFileExcludeOriginal] = useState("");

  const desktopNotifications = usePrefs(s => s.desktopNotifications);
  const setDesktopNotifications = usePrefs(s => s.setDesktopNotifications);
  const completionSound = usePrefs(s => s.completionSound);
  const setCompletionSound = usePrefs(s => s.setCompletionSound);
  const completionSoundId = usePrefs(s => s.completionSoundId);
  const setCompletionSoundId = usePrefs(s => s.setCompletionSoundId);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const setSettledHighlight = usePrefs(s => s.setSettledHighlight);
  const workingIndicator = usePrefs(s => s.workingIndicator);
  const setWorkingIndicator = usePrefs(s => s.setWorkingIndicator);
  const globalDefaultSandbox = usePrefs(s => s.globalDefaultSandbox);
  const setGlobalDefaultSandbox = usePrefs(s => s.setGlobalDefaultSandbox);
  const sandboxBypassPermissions = usePrefs(s => s.sandboxBypassPermissions);
  const setSandboxBypassPermissions = usePrefs(s => s.setSandboxBypassPermissions);
  const workspaceExpandMode = usePrefs(s => s.workspaceExpandMode);
  const setWorkspaceExpandMode = usePrefs(s => s.setWorkspaceExpandMode);
  const branchPrefix = usePrefs(s => s.branchPrefix);
  const setBranchPrefix = usePrefs(s => s.setBranchPrefix);
  const queueMinIntervalMs = usePrefs(s => s.queueMinIntervalMs);
  const setQueueMinIntervalMs = usePrefs(s => s.setQueueMinIntervalMs);
  const terminalCopyOnSelect = usePrefs(s => s.terminalCopyOnSelect);
  const setTerminalCopyOnSelect = usePrefs(s => s.setTerminalCopyOnSelect);

  useEffect(() => {
    settingsLoad().then(s => {
      setSettings(s);
      setReposDir(s.repos_dir);
      setOriginalDir(s.repos_dir);
      const rw    = (s.sandbox_default_rw_paths      ?? []).join("\n");
      const hosts = (s.sandbox_default_allowed_hosts ?? []).join("\n");
      setSbRw(rw); setSbHosts(hosts);
      setSbOriginal({ rw, hosts });
      const ex = s.file_tree_exclude ?? [];
      setFileExclude(ex);
      setFileExcludeOriginal(ex.join("\n"));
    }).catch(() => {});
  }, []);

  const sbDirty = sbRw !== sbOriginal.rw || sbHosts !== sbOriginal.hosts;
  const excludeDirty = fileExclude.join("\n") !== fileExcludeOriginal;
  const dirty = reposDir !== originalDir;

  async function browse() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setReposDir(sel);
  }
  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      // Keep the cached `settings` in sync — otherwise a later saveSb /
      // saveExclude spreads a stale object and reverts the repos_dir we
      // just wrote.
      const next: Settings = { ...settings, repos_dir: reposDir.trim(), welcomed: true };
      await settingsSave(next);
      setSettings(next);
      setOriginalDir(reposDir.trim());
    } finally { setBusy(false); }
  }
  async function saveSb() {
    if (!settings) return;
    setBusy(true);
    try {
      const next: Settings = {
        ...settings,
        sandbox_default_rw_paths:      cleanLines(sbRw),
        sandbox_default_allowed_hosts: cleanLines(sbHosts),
      };
      await settingsSave(next);
      setSettings(next);
      setSbOriginal({ rw: sbRw, hosts: sbHosts });
    } finally { setBusy(false); }
  }
  async function saveExclude() {
    if (!settings) return;
    setBusy(true);
    try {
      const cleaned = cleanLines(fileExclude);
      const next: Settings = { ...settings, file_tree_exclude: cleaned };
      await settingsSave(next);
      setSettings(next);
      setFileExclude(cleaned);
      setFileExcludeOriginal(cleaned.join("\n"));
      // The file tree is hidden behind this Settings overlay; force it to
      // re-read so the new excludes apply the moment the user looks back.
      useUI.getState().reloadFileTree();
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-7">
      <h1 className="text-[20px] font-medium">General</h1>

      <div>
        <div className="text-[14px] font-medium">Repos directory</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Where Termic scans for unadded git repos when you click "Add project".
        </div>
        <div className="mt-2 flex gap-2">
          <Input value={reposDir} onChange={(e) => setReposDir(e.target.value)} placeholder="~/Projects" className="font-mono" />
          <Button variant="secondary" onClick={browse}>Browse…</Button>
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!dirty || busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <div className="text-[14px] font-medium">Branch prefix</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Prepended to auto-generated branch names for new workspaces (<code className="font-mono">{(() => { const p = branchPrefix.trim().replace(/^\/+|\/+$/g, ""); return p ? `${p}/my-task` : "my-task"; })()}</code>). Leave empty for no prefix. You can still edit the branch per workspace.
        </div>
        <div className="mt-2 max-w-xs">
          <Input value={branchPrefix} onChange={(e) => setBranchPrefix(e.target.value)} placeholder="feature" className="font-mono" />
        </div>
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <div className="text-[14px] font-medium">Queue send interval</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Minimum delay between consecutive queued messages sent to an agent (the "ralph loop"). Even if the agent finishes faster, or a false "done" fires, the next message waits this long. Set to 0 to disable. "Send now" ignores this and sends immediately.
        </div>
        <div className="mt-2 flex max-w-xs items-center gap-2">
          <Input
            type="number"
            min={0}
            max={120}
            value={Math.round(queueMinIntervalMs / 1000)}
            onChange={(e) => setQueueMinIntervalMs((Number(e.target.value) || 0) * 1000)}
            className="w-24 font-mono"
          />
          <span className="text-[12.5px] text-[var(--color-fg-dim)]">seconds</span>
        </div>
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">Workspace expand behavior</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              How a workspace's agent list reveals itself in the sidebar.
            </div>
          </div>
          <div className="inline-flex items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
            {([
              ["chevron", "Chevron only", "Row click only activates. Use the chevron to expand."],
              ["click",   "Click name",   "Click the active row's name to toggle; auto-expand at 2+ agents."],
              ["always",  "Auto open",    "Start expanded. The chevron still collapses, and that sticks."],
            ] as const).map(([id, label, hint]) => (
              <Tip key={id} content={hint} side="top">
                <button
                  type="button"
                  onClick={() => setWorkspaceExpandMode(id)}
                  className={cn(
                    "h-7 rounded-[5px] px-2.5 text-[12px] transition-colors",
                    workspaceExpandMode === id
                      ? "bg-[var(--color-accent-deep)] text-white"
                      : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                  )}
                >{label}</button>
              </Tip>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <Toggle
          label="Work-done indicator"
          hint="Color a workspace's agent icon when its agent finishes a turn and is waiting on you."
          value={settledHighlight}
          onChange={setSettledHighlight}
        />
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <Toggle
          label="Work-in-progress indicator"
          hint="Show a spinner on an agent's tab and sidebar icon while it's working. Experimental: it relies on work detection, which can occasionally misfire. A stuck spinner auto-clears after a few minutes."
          value={workingIndicator}
          onChange={setWorkingIndicator}
        />
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <Toggle
          label="Copy on select"
          hint="iTerm-style: selecting text with the mouse in any terminal copies it to the clipboard automatically. Applies to every terminal (agents and scratch shells)."
          value={terminalCopyOnSelect}
          onChange={setTerminalCopyOnSelect}
        />
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <Toggle
          label="Desktop notifications"
          hint="Notify when an inactive agent finishes or rings the bell. Clicking back in jumps to that tab."
          value={desktopNotifications}
          onChange={(v) => {
            setDesktopNotifications(v);
            // Trigger the macOS permission prompt the moment the user opts
            // in, so the dialog appears in context instead of mid-task.
            if (v) ensureNotifyPermission();
          }}
        />
      </div>

      {/* macOS-only: the sound catalog is macOS system-sound names (plus a
          .caf installed into ~/Library/Sounds) — none resolve elsewhere. */}
      {COMPLETION_SOUND_SUPPORTED && (
      <div className="border-t border-[var(--color-border-soft)] pt-6">
        {/* The sound plays INSIDE the desktop notification — with
            notifications off it can never fire, so lock the controls
            instead of letting Preview suggest otherwise. */}
        <div className={cn(!desktopNotifications && "pointer-events-none opacity-50 select-none")}>
        <Toggle
          label="Completion sound"
          hint="Pick which sound plays inside desktop notifications when an inactive agent finishes a turn. Default: Funk."
          value={completionSound}
          onChange={setCompletionSound}
        />
        <div className="mt-3 max-w-sm">
          <div className="flex items-center gap-2">
            <select
              value={completionSoundId}
              onChange={(e) => setCompletionSoundId(e.target.value as typeof completionSoundId)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[13px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]"
            >
              {COMPLETION_SOUND_OPTIONS.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="md"
              className="h-9 shrink-0"
              onClick={() => {
                // Preview with a real project · workspace title so the
                // banner looks exactly like an agent-finished notification.
                const st = useApp.getState();
                const ws =
                  st.workspaces.find(w => w.id === st.activeWorkspaceId && !w.archived) ??
                  st.workspaces.find(w => !w.archived);
                const proj = ws && st.projects.find(p => p.id === ws.project_id);
                const title = ws && proj?.name
                  ? `${proj.name} · ${ws.name || "workspace"}`
                  : (ws?.name || "project · workspace");
                previewCompletionSound(completionSoundId, { title, body: "agent finished" });
              }}
              title="Play a preview of the selected completion sound"
            >
              Preview
            </Button>
          </div>
        </div>
        </div>
        {!desktopNotifications && (
          <p className="mt-2 text-[12px] text-[var(--color-fg-faint)]">
            Turn on Desktop notifications above to enable completion sounds.
          </p>
        )}
      </div>
      )}

      {/* Global sandbox default. The New workspace dialog defaults its
          Sandbox toggle to this OR the project's own `default_sandbox`
          (whichever is true). One switch to start sandboxing across
          every project without per-project bookkeeping. */}
      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <Toggle
          label="Sandbox new workspaces by default"
          hint="When on, the New workspace dialog pre-checks its Sandbox toggle for every project. Individual projects can still opt out (Settings → Projects). Already-created workspaces aren't affected - their sandbox pin is captured at creation."
          value={globalDefaultSandbox}
          onChange={setGlobalDefaultSandbox}
        />
      </div>

      {/* Global sandbox lists. Joined with each project's per-repo
          lists when a workspace gets created with sandbox enabled,
          and pre-filled into the Edit Sandbox dialog when the user
          enables the cage from scratch. Editing these only affects
          NEW workspaces — existing ones froze a copy at creation. */}
      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <div className="text-[14px] font-medium">Global sandbox defaults</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          One per line. Wildcards (<code>*.example.com</code>) for hosts; <code>$HOME</code> + <code>~</code> expand for paths.
          Merged with each project's own lists when a workspace is created.
        </div>
        <div className="mt-3 flex flex-col gap-4">
          <SbField label="Allowed paths" placeholder={"~/Documents/notes\n~/scratch"} value={sbRw} onChange={setSbRw} />
          <SbField label="Allowed hosts" placeholder={"*.example.com\nbitbucket.org"} value={sbHosts} onChange={setSbHosts} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!sbDirty || busy} onClick={saveSb}>
            {busy ? "Saving…" : "Save defaults"}
          </Button>
        </div>
      </div>

      {/* Bypass-permissions default for sandboxed agents. When on, a
          sandboxed agent spawns with its "auto-approve everything" flag
          regardless of the YOLO toggle — the seatbelt is the real
          boundary, the agent's own prompts are just friction. Affects
          new PTY spawns; respawn (⌘R / new tab) to pick up a change. */}
      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <Toggle
          label="Bypass permissions in sandboxed workspaces"
          hint="When on, agents in a sandboxed workspace skip their own permission prompts. The macOS seatbelt is the real boundary. Turn off to make sandboxed agents still ask. Applies to newly spawned terminals."
          value={sandboxBypassPermissions}
          onChange={setSandboxBypassPermissions}
        />
      </div>

      {/* Personal file-tree excludes. Hide noise (caches, venvs, build
          output) from the "All files" tree across every project on this
          machine. Per-project, team-shared excludes live in each repo's
          .termic.yaml (Settings → Repositories). */}
      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <div className="text-[14px] font-medium">Hidden files (personal)</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          Patterns hidden from the "All files" tree across every project on this machine. Pick a preset or add your own. For team-shared, per-repo excludes, use a project's <code className="font-mono">.termic.yaml</code> (Settings → Repositories).
        </div>
        <div className="mt-3">
          <ExcludeEditor value={fileExclude} onChange={setFileExclude} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!excludeDirty || busy} onClick={saveExclude}>
            {busy ? "Saving…" : "Save hidden files"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SbField({ label, placeholder, value, onChange }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--color-fg-dim)]">{label}</span>
      <AutoGrowTextarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

// Textarea that grows with its content. Same recipe as the sandbox
// dialog's: collapse to auto, size to scrollHeight on every value
// change. `overflow-hidden` kills the flicker scrollbar during resize.
function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [props.value]);
  return (
    <textarea
      ref={ref}
      {...props}
      style={{ overflow: "hidden", ...props.style }}
    />
  );
}

function Toggle({ label, hint, value, onChange }: {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      </div>
      <button
        role="switch" aria-checked={value} onClick={() => onChange(!value)}
        style={{
          position: "relative",
          width: 36, height: 20, flexShrink: 0,
          borderRadius: 999, padding: 0, border: 0,
          background: value ? "var(--color-accent)" : "var(--color-bg-3)",
          transition: "background-color 150ms",
          cursor: "pointer",
          display: "inline-block",
          verticalAlign: "middle",
        }}
        className={cn()}
      >
        <span
          style={{
            position: "absolute", top: 2, left: value ? 18 : 2,
            width: 16, height: 16, borderRadius: 999,
            background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 150ms",
          }}
        />
      </button>
    </div>
  );
}
