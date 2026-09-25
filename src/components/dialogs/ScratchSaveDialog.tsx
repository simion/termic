// "Save to project" — the picker ⌘S opens on a scratchpad (GH #244).
//
// This is the flow the whole feature turns on. ⌘S does NOT write to the
// scratch store: it PROMOTES the pad to a real file inside the task, after
// which the tab is an ordinary `edit` tab and the pad record is gone. Getting
// that backwards would be the one way to ruin the feature, since the user's
// muscle-memory save would report success and file the note somewhere they
// will never look again.
//
// Deliberately NOT the native save panel. The requirement is *inside the
// project*, and a native panel can write anywhere. Folder completion is fuzzy
// over the task's own directories rather than a click-through tree: the
// keyboard path is the fast one, and the containment rule is enforced in Rust
// (`scratch_promote`) either way, so the picker is an affordance and not a
// security boundary.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Folder } from "lucide-react";
import * as ipc from "@/lib/ipc";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";
import { scratchFilenameSlug } from "@/lib/scratchTitle";
import type { ScratchTab } from "@/lib/types";
import { cn } from "@/lib/utils";

const MAX_FOLDERS = 30;

/** Every directory the task's file list implies, plus the root. Derived from
 *  the finder's list (already gitignore-aware) rather than a separate walk:
 *  one IPC, and the folders offered are the ones the user would actually save
 *  into. */
function foldersFromFiles(files: string[]): string[] {
  const dirs = new Set<string>([""]);
  for (const f of files) {
    const parts = f.split("/");
    parts.pop();
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      dirs.add(acc);
    }
  }
  return [...dirs].sort();
}

/** Split a typed path into (folder, filename). "" folder is the task root. */
function splitPath(v: string): { dir: string; name: string } {
  const i = v.lastIndexOf("/");
  return i < 0 ? { dir: "", name: v } : { dir: v.slice(0, i), name: v.slice(i + 1) };
}

export function ScratchSaveDialog() {
  const { t } = useTranslation("dialogs");
  const req = useUI(s => s.scratchSave);
  const resolve = useUI(s => s.resolveScratchSave);
  const taskId = req?.taskId ?? null;
  const tab = useApp(s => {
    if (!req) return null;
    const t = (s.tabs[req.taskId] ?? []).find(x => x.id === req.tabId);
    return t?.type === "scratch" ? t as ScratchTab : null;
  });

  const [path, setPath] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Seed the filename from the derived title, and select just the stem so
  // typing replaces the name but keeps the extension the user can see.
  useEffect(() => {
    if (!req || !tab) return;
    const seed = `${scratchFilenameSlug(tab.title)}.md`;
    setPath(seed);
    setErr(null);
    setActiveIdx(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, seed.lastIndexOf("."));
    });
    // Only re-seed when the dialog OPENS for a (possibly different) pad —
    // not on every title tick, which would fight the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.taskId, req?.tabId]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    ipc.taskListFilesForFinder(taskId)
      .then(list => { if (!cancelled) setFiles(list); })
      // A failed listing costs completion, not the save: the user can still
      // type a path and promote into it.
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [taskId]);

  const folders = useMemo(() => foldersFromFiles(files), [files]);
  const { dir, name } = splitPath(path);

  const matches = useMemo(() => {
    if (!dir) return folders.slice(0, MAX_FOLDERS).map(f => ({ f, m: [] as number[] }));
    const out: { f: string; m: number[]; score: number }[] = [];
    for (const f of folders) {
      if (!f) continue;
      const hit = fuzzyMatch(f, dir);
      if (hit) out.push({ f, m: hit.matches, score: hit.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, MAX_FOLDERS);
  }, [folders, dir]);

  useEffect(() => { setActiveIdx(0); }, [dir]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  /** Swap in a folder, keeping whatever filename is typed. */
  function useFolder(folder: string) {
    setPath(folder ? `${folder}/${name}` : name);
    inputRef.current?.focus();
  }

  async function save() {
    if (!taskId || !tab || busy) return;
    const rel = path.trim().replace(/^\/+/, "");
    const leaf = splitPath(rel).name;
    if (!leaf) { setErr(t("scratchSave.errNoName")); return; }
    setBusy(true);
    setErr(null);
    try {
      // Ask before clobbering. `scratch_promote` refuses an existing target
      // without `overwrite`, so this only decides whether to show the prompt.
      let overwrite = false;
      if (await ipc.scratchPromoteTargetExists(taskId, rel)) {
        const ok = await useUI.getState().askConfirm({
          title: t("scratchSave.overwriteTitle"),
          message: t("scratchSave.overwriteMessage", { path: rel }),
          confirmLabel: t("scratchSave.overwrite"),
          destructive: true,
        });
        if (ok !== true) { setBusy(false); return; }
        overwrite = true;
      }
      await ipc.scratchPromote(taskId, tab.scratchId, rel, overwrite);
      // The pad is now a file, so the tab becomes an ordinary edit tab on it:
      // same tab id, same slot in the strip, and no longer dirty.
      useApp.getState().promoteScratchTab(taskId, tab.id, rel);
      // The file tree and the Git panel have a new file to notice.
      useApp.getState().bumpFsRevision(taskId);
      useApp.getState().bumpGitRevision(taskId);
      useUI.getState().pushToast(t("scratchSave.toastSaved", { name: leaf }), "success");
      resolve(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Tab") {
      // Tab completes the highlighted folder; Enter always saves. Keeping
      // those on separate keys means Enter never does something other than
      // what the input line reads.
      const hit = matches[activeIdx];
      if (hit) { e.preventDefault(); useFolder(hit.f); }
    } else if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  }

  if (!req) return null;

  return (
    <AppDialog
      open
      onOpenChange={(v) => { if (!v) resolve(false); }}
      title={t("scratchSave.title")}
      description={t("scratchSave.description")}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-3 pt-1" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          data-testid="scratch-save-path"
          value={path}
          onChange={e => setPath(e.target.value)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          placeholder="docs/notes.md"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-2 font-mono text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)] focus:outline-none"
        />
        <div className="text-[12px] text-[var(--color-fg-faint)]">
          {t("scratchSave.hint")}
        </div>
        <div ref={listRef} className="max-h-[38vh] min-h-[120px] overflow-y-auto rounded-md border border-[var(--color-border-soft)] py-1">
          {matches.length === 0 && (
            <div className="px-3 py-2 text-[13px] text-[var(--color-fg-faint)]">{t("scratchSave.noFolder")}</div>
          )}
          {matches.map((r, i) => (
            <button
              key={r.f}
              data-row={i}
              type="button"
              onClick={() => useFolder(r.f)}
              onMouseMove={() => setActiveIdx(i)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12.5px]",
                i === activeIdx ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]",
              )}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
              <span className="truncate">
                {r.f ? <Highlighted text={r.f} matches={r.m} /> : <span className="italic">{t("scratchSave.taskRoot")}</span>}
              </span>
            </button>
          ))}
        </div>
        {err && <div className="text-[13px] text-[var(--color-err)]">{err}</div>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" type="button" onClick={() => resolve(false)}>{t("common:cancel")}</Button>
        <Button variant="primary" type="button" onClick={() => void save()} disabled={busy} data-testid="scratch-save-confirm">
          {busy ? t("common:saving") : t("common:save")}
        </Button>
      </div>
    </AppDialog>
  );
}
