// General settings — repos discovery dir + desktop notifications. Loads the
// full Settings object so that saves preserve other fields (agents, etc.)
// instead of wiping them.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextareaHTMLAttributes } from "react";
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
  // Global sandbox defaults. Stored line-by-line as strings so the
  // user can edit mid-line without the array round-trip dropping
  // their cursor.
  const [sbRw, setSbRw]       = useState("");
  const [sbDeny, setSbDeny]   = useState("");
  const [sbHosts, setSbHosts] = useState("");
  const [sbOriginal, setSbOriginal] = useState({ rw: "", deny: "", hosts: "" });

  const desktopNotifications = usePrefs(s => s.desktopNotifications);
  const setDesktopNotifications = usePrefs(s => s.setDesktopNotifications);
  const globalDefaultSandbox = usePrefs(s => s.globalDefaultSandbox);
  const setGlobalDefaultSandbox = usePrefs(s => s.setGlobalDefaultSandbox);

  useEffect(() => {
    settingsLoad().then(s => {
      setSettings(s);
      setReposDir(s.repos_dir);
      setOriginalDir(s.repos_dir);
      const rw    = (s.sandbox_default_rw_paths      ?? []).join("\n");
      const deny  = (s.sandbox_default_deny_paths    ?? []).join("\n");
      const hosts = (s.sandbox_default_allowed_hosts ?? []).join("\n");
      setSbRw(rw); setSbDeny(deny); setSbHosts(hosts);
      setSbOriginal({ rw, deny, hosts });
    }).catch(() => {});
  }, []);

  const sbDirty = sbRw !== sbOriginal.rw || sbDeny !== sbOriginal.deny || sbHosts !== sbOriginal.hosts;
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
  const splitLines = (s: string) =>
    s.split("\n").map(l => l.trim()).filter(Boolean);
  async function saveSb() {
    if (!settings) return;
    setBusy(true);
    try {
      const next: Settings = {
        ...settings,
        sandbox_default_rw_paths:      splitLines(sbRw),
        sandbox_default_deny_paths:    splitLines(sbDeny),
        sandbox_default_allowed_hosts: splitLines(sbHosts),
      };
      await settingsSave(next);
      setSettings(next);
      setSbOriginal({ rw: sbRw, deny: sbDeny, hosts: sbHosts });
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

      {/* Work-done highlight pref is hidden from the UI for now —
          the detector still trips on too many false positives. Pref
          stays in the store (default false) so a future revert is
          one line. */}

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
          <SbField label="Extra denied paths" placeholder={"~/.env.shared"} value={sbDeny} onChange={setSbDeny} />
          <SbField label="Allowed hosts" placeholder={"*.example.com\nbitbucket.org"} value={sbHosts} onChange={setSbHosts} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!sbDirty || busy} onClick={saveSb}>
            {busy ? "Saving…" : "Save defaults"}
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
