// General settings — repos discovery dir + desktop notifications. Loads the
// full Settings object so that saves preserve other fields (agents, etc.)
// instead of wiping them.

import { useEffect, useState } from "react";
import { settingsLoad, settingsSave } from "@/lib/ipc";
import type { Settings } from "@/lib/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { usePrefs } from "@/store/prefs";
import { cn } from "@/lib/utils";

export function GeneralSection() {
  // Cache the full Settings object — saves merge into this so we don't
  // accidentally wipe `agents` (or future fields).
  const [settings, setSettings] = useState<Settings | null>(null);
  const [reposDir, setReposDir] = useState("");
  const [originalDir, setOriginalDir] = useState("");
  const [busy, setBusy] = useState(false);

  const desktopNotifications = usePrefs(s => s.desktopNotifications);
  const setDesktopNotifications = usePrefs(s => s.setDesktopNotifications);
  const settledHighlight = usePrefs(s => s.settledHighlight);
  const setSettledHighlight = usePrefs(s => s.setSettledHighlight);
  const globalDefaultSandbox = usePrefs(s => s.globalDefaultSandbox);
  const setGlobalDefaultSandbox = usePrefs(s => s.setGlobalDefaultSandbox);

  useEffect(() => {
    settingsLoad().then(s => {
      setSettings(s);
      setReposDir(s.repos_dir);
      setOriginalDir(s.repos_dir);
    }).catch(() => {});
  }, []);

  const dirty = reposDir !== originalDir;

  async function browse() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setReposDir(sel);
  }
  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      await settingsSave({ ...settings, repos_dir: reposDir.trim(), welcomed: true });
      setOriginalDir(reposDir.trim());
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
        <Toggle
          label="Desktop notifications"
          hint="OS notification when an inactive agent settles or rings the bell. Off by default — multi-agent workflows can get noisy."
          value={desktopNotifications}
          onChange={setDesktopNotifications}
        />
      </div>

      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <Toggle
          label="Work-done highlight"
          hint="Color a workspace's agent icon when its output goes idle (i.e., the agent is waiting on you). Turn off to keep the sidebar fully calm regardless of agent activity."
          value={settledHighlight}
          onChange={setSettledHighlight}
        />
      </div>

      {/* Global sandbox default. The New workspace dialog defaults its
          Sandbox toggle to this OR the project's own `default_sandbox`
          (whichever is true). One switch to start sandboxing across
          every project without per-project bookkeeping. */}
      <div className="border-t border-[var(--color-border-soft)] pt-6">
        <Toggle
          label="Sandbox new workspaces by default"
          hint="When on, the New workspace dialog pre-checks its Sandbox toggle for every project. Individual projects can still opt out (Settings → Repositories). Already-created workspaces aren't affected - their sandbox pin is captured at creation."
          value={globalDefaultSandbox}
          onChange={setGlobalDefaultSandbox}
        />
      </div>
    </div>
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
