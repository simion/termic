// Add Project dialog with discovered-repos shortcut.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { projectAdd, discoverRepos, settingsLoad } from "@/lib/ipc";
import type { DiscoveredRepo } from "@/lib/types";
import { Folder, FolderPlus } from "lucide-react";

export function NewProjectDialog() {
  const open = useUI(s => s.newProjectOpen);
  const close = useUI(s => s.closeNewProject);
  const loadAll = useApp(s => s.loadAll);
  const [path, setPath] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredRepo[]>([]);
  const [reposDir, setReposDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPath(""); setErr(null);
    (async () => {
      try {
        const s = await settingsLoad();
        setReposDir(s.repos_dir || "");
        if (s.repos_dir) {
          const repos = await discoverRepos(s.repos_dir);
          setDiscovered(repos.filter(r => !r.already_added));
        } else { setDiscovered([]); }
      } catch { setDiscovered([]); }
    })();
  }, [open]);

  async function add(p: string) {
    setBusy(true); setErr(null);
    try {
      await projectAdd(p);
      await loadAll();
      // Refresh discovery in case the same repos_dir has more candidates.
      if (reposDir) {
        const repos = await discoverRepos(reposDir).catch(() => []);
        setDiscovered(repos.filter(r => !r.already_added));
      }
      if (p === path) close();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  async function browse() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setPath(sel);
  }

  return (
    <AppDialog open={open} onOpenChange={(v) => (v ? null : close())} title="Add project">
      {discovered.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 flex items-baseline justify-between text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
            <span>Discovered repos</span>
            <span className="font-mono normal-case text-[11.5px] text-[var(--color-fg-faint)]">{discovered.length} in {reposDir}</span>
          </div>
          <div className="max-h-[220px] overflow-auto rounded-md border border-[var(--color-border-soft)]">
            {discovered.map(r => (
              <button key={r.path} onClick={() => add(r.path)} disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] hover:bg-[var(--color-hover)] disabled:opacity-50"
                title={r.path}
              >
                <Folder className="h-4 w-4 text-[var(--color-fg-faint)]" />
                <span className="flex-1 truncate">{r.name}</span>
                <span className="text-[11.5px] uppercase tracking-wider text-[var(--color-accent)] opacity-70">Add</span>
              </button>
            ))}
          </div>
          <div className="relative my-3 text-center">
            <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border-soft)]" />
            <span className="relative bg-[var(--color-bg-1)] px-2 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">or add manually</span>
          </div>
        </div>
      )}

      <label className="block text-[13.5px]">
        Repository root
        <div className="mt-1.5 flex gap-2">
          <Input value={path} onChange={e => setPath(e.target.value)} placeholder="/path/to/repo" />
          <Button variant="secondary" size="lg" onClick={browse}>Browse…</Button>
        </div>
      </label>

      {err && <p className="text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!path || busy} onClick={() => add(path)}>
          <FolderPlus className="h-4 w-4" /> Add
        </Button>
      </div>
    </AppDialog>
  );
}
