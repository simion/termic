// Once-per-session banner that surfaces "tinyproxy not installed" only
// when the user has sandboxing in play. Without tinyproxy, sandboxed
// workspaces silently downgrade to full network deny (the SBPL profile
// blocks all outbound except a proxy on a port that never comes up);
// the silent downgrade is exactly the kind of confusing failure that
// makes the feature feel broken.
//
// Dismissal lives in sessionStorage so it reappears next launch if
// they still haven't installed - intentional: install once, dismissed
// forever; ignore the warning, see it again every session until you
// either install or stop sandboxing.

import { useEffect, useState } from "react";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { sandboxTinyproxyAvailable } from "@/lib/ipc";
import { AlertTriangle, X } from "lucide-react";

const DISMISS_KEY = "tinyproxyBannerDismissed";

export function TinyproxyBanner() {
  const projects = useApp(s => s.projects);
  const workspaces = useApp(s => s.workspaces);
  const globalDefaultSandbox = usePrefs(s => s.globalDefaultSandbox);
  const [missing, setMissing] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  // Probe once. Cheap shell-out; no point re-running unless the user
  // explicitly retries (which they can do by closing + reopening the
  // window - the probe runs again on mount).
  useEffect(() => {
    sandboxTinyproxyAvailable().then(ok => setMissing(!ok)).catch(() => {});
  }, []);

  // Only relevant when sandboxing is somewhere in scope. Don't pester
  // users who haven't touched the feature.
  const sandboxInPlay =
    globalDefaultSandbox
    || projects.some(p => p.default_sandbox)
    || workspaces.some(w => w.sandbox_enabled);

  if (!missing || dismissed || !sandboxInPlay) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[55] flex items-center gap-3 border-b border-[var(--color-warn)]/40 bg-[var(--color-warn)]/15 px-4 py-2 text-[12.5px] text-[var(--color-fg)]">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warn)]" />
      <span className="flex-1">
        <b>tinyproxy is not installed.</b> Sandboxed workspaces will run
        with full network <i>deny</i> (no allowlist). Install with{" "}
        <code className="font-mono text-[11.5px]">brew install tinyproxy</code>{" "}
        then restart Termic for HTTPS allowlisting to work.
      </span>
      <button
        type="button"
        onClick={() => {
          try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch {}
          setDismissed(true);
        }}
        className="rounded p-1 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        title="Dismiss for this session"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
