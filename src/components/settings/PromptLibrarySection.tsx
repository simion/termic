// Settings → Prompts. Manage the prompt library that backs the "Prompts"
// dropdown in the top bar: edit title/body (body in a roomy modal since prompts
// can be long), reorder by drag, clone, disable, delete, and reset a built-in
// to its shipped text. The destination (which agent, or a new one) is chosen
// per fire from the dropdown, not stored here. All local (localStorage) — see
// src/store/prompts.ts.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePromptLibrary } from "@/store/prompts";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { AppDialog } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils";
import { GripVertical, Copy, Trash2, RotateCcw, Eye, EyeOff, Plus, Pencil } from "lucide-react";

interface DragState {
  id: string;
  grabOffsetY: number;
  startY: number;
  pointerY: number;
  started: boolean;
  appliedTy: number;
}

// Dense preview: drop blank lines so the 3-line clamp shows real content, not
// the gaps between a heading and its body.
function previewText(body: string): string {
  return body.split("\n").map(l => l.trimEnd()).filter(l => l.trim() !== "").join("\n");
}

export function PromptLibrarySection() {
  const prompts = usePromptLibrary(s => s.prompts);
  const addPrompt = usePromptLibrary(s => s.addPrompt);
  const updatePrompt = usePromptLibrary(s => s.updatePrompt);
  const clonePrompt = usePromptLibrary(s => s.clonePrompt);
  const deletePrompt = usePromptLibrary(s => s.deletePrompt);
  const resetPrompt = usePromptLibrary(s => s.resetPrompt);
  const toggleEnabled = usePromptLibrary(s => s.toggleEnabled);
  const reorderPrompts = usePromptLibrary(s => s.reorderPrompts);
  const restoreBuiltins = usePromptLibrary(s => s.restoreBuiltins);
  const deletedCount = usePromptLibrary(s => s.deletedBuiltins.length);

  // Body editor modal — the inline row only shows a preview.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = prompts.find(p => p.id === editingId) ?? null;

  async function confirmReset(id: string, title: string) {
    const ok = await useUI.getState().askConfirm({
      title: `Reset "${title}" to default?`,
      message: "This discards your edits to this built-in prompt and restores the shipped text.",
      confirmLabel: "Reset",
      destructive: true,
    });
    if (ok) resetPrompt(id);
  }
  async function confirmRestore() {
    const ok = await useUI.getState().askConfirm({
      title: "Restore deleted built-in prompts?",
      message: "Brings back the built-in prompts you deleted. Your custom prompts and edits stay as they are.",
      confirmLabel: "Restore",
    });
    if (ok) restoreBuiltins();
  }

  // Pointer-based LIVE drag reorder (NOT HTML5 DnD — WKWebView's native drag is
  // unreliable and Tauri intercepts it for file drops; see useTabStripDrag).
  // The dragged row follows the cursor via a translateY transform and the list
  // reorders the moment its center crosses a neighbour, so it reshuffles live
  // instead of snapping only on release.
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragTy, setDragTy] = useState(0);
  const dragRef = useRef<DragState | null>(null);
  // Live prompts in a ref so the once-bound pointer handlers read current order.
  const promptsRef = useRef(prompts); promptsRef.current = prompts;

  // translateY that keeps the dragged row's top at (cursor − grab offset).
  // Self-correcting: reads the row's live rect minus the transform already
  // applied to recover its untranslated layout slot, so it stays glued even
  // after a live reorder moves it to a new slot.
  function computeTy(clientY: number): number {
    const d = dragRef.current;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-prompt-id="${d ? CSS.escape(d.id) : ""}"]`);
    if (!d || !row) return 0;
    const layoutTop = row.getBoundingClientRect().top - d.appliedTy;
    const ty = (clientY - d.grabOffsetY) - layoutTop;
    d.appliedTy = ty;
    return ty;
  }

  // Reorder when the dragged row's center passes a neighbour's center.
  function maybeReorder() {
    const d = dragRef.current;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-prompt-id="${d ? CSS.escape(d.id) : ""}"]`);
    if (!d || !row) return;
    const draggedCenter = (d.pointerY - d.grabOffsetY) + row.offsetHeight / 2;
    let target = 0;
    for (const r of Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-prompt-id]") ?? [])) {
      if (r.dataset.promptId === d.id) continue;
      const rect = r.getBoundingClientRect();
      if (rect.top + rect.height / 2 < draggedCenter) target++;
    }
    const cur = promptsRef.current.findIndex(p => p.id === d.id);
    if (cur >= 0 && target !== cur) reorderPrompts(cur, target);
  }

  function onPointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    d.pointerY = e.clientY;
    if (!d.started) {
      if (Math.abs(e.clientY - d.startY) < 5) return; // below the drag threshold
      d.started = true;
      setDragId(d.id);
    }
    setDragTy(computeTy(e.clientY));
    maybeReorder();
  }

  function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    dragRef.current = null;
    setDragId(null);
    setDragTy(0);
  }

  function startDrag(id: string, e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-prompt-id]");
    if (!row) return;
    dragRef.current = {
      id,
      grabOffsetY: e.clientY - row.getBoundingClientRect().top,
      startY: e.clientY,
      pointerY: e.clientY,
      started: false,
      appliedTy: 0,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  // After a live reorder re-renders the list, the dragged row sits in a new
  // slot — re-derive its transform from the new layout BEFORE paint so it
  // doesn't jump for a frame.
  useLayoutEffect(() => {
    if (dragRef.current?.started) setDragTy(computeTy(dragRef.current.pointerY));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompts]);
  // Tear down window listeners if the section unmounts mid-drag.
  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Prompts</h2>
          <p className="mt-0.5 max-w-xl text-[12.5px] text-[var(--color-fg-dim)]">
            Reusable prompts for the Prompts menu in the top bar. When you fire one, you pick
            where it goes: an existing agent (queued if it is busy) or a new agent. Drag to
            reorder. Built-ins can be edited and reset.
          </p>
        </div>
        <Button variant="primary" size="sm" className="shrink-0 gap-1.5" onClick={() => setEditingId(addPrompt())}>
          <Plus className="h-3.5 w-3.5" /> New prompt
        </Button>
      </div>

      <div ref={listRef} className="mt-5 flex flex-col gap-3">
        {prompts.length === 0 && (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-[13px] text-[var(--color-fg-faint)]">
            No prompts. Add one, or restore the built-ins below.
          </div>
        )}

        {prompts.map(p => (
          <div
            key={p.id}
            data-prompt-id={p.id}
            style={dragId === p.id ? { transform: `translateY(${dragTy}px)`, position: "relative", zIndex: 10 } : undefined}
            className={cn(
              "rounded-lg border bg-[var(--color-bg)] p-3",
              dragId === p.id ? "border-[var(--color-accent)] shadow-xl" : "border-[var(--color-border-soft)]",
              !p.enabled && dragId !== p.id && "opacity-60",
            )}
          >
            <div className="flex items-center gap-2">
              <button
                onPointerDown={(e) => startDrag(p.id, e)}
                style={{ touchAction: "none" }}
                title="Drag to reorder"
                className="shrink-0 cursor-grab rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] active:cursor-grabbing"
              >
                <GripVertical className="h-4 w-4" />
              </button>

              <input
                value={p.title}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                onChange={(e) => updatePrompt(p.id, { title: e.target.value })}
                placeholder="Prompt title"
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[13.5px] font-medium text-[var(--color-fg)] outline-none hover:border-[var(--color-border)] focus:border-[var(--color-accent)]"
              />

              {p.builtin && (
                <span className="shrink-0 rounded bg-[var(--color-bg-3)] px-1.5 py-px text-[10.5px] font-medium uppercase tracking-wide text-[var(--color-fg-faint)]">
                  Built-in
                </span>
              )}
              {p.builtin && p.modified && (
                <span className="shrink-0 rounded bg-[var(--color-accent)]/15 px-1.5 py-px text-[10.5px] font-medium uppercase tracking-wide text-[var(--color-accent)]">
                  Modified
                </span>
              )}

              {/* Row actions */}
              <IconBtn title="Edit prompt" onClick={() => setEditingId(p.id)}>
                <Pencil className="h-4 w-4" />
              </IconBtn>
              <IconBtn title={p.enabled ? "Disable (hide from menu)" : "Enable"} onClick={() => toggleEnabled(p.id)}>
                {p.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </IconBtn>
              <IconBtn title="Duplicate" onClick={() => clonePrompt(p.id)}>
                <Copy className="h-4 w-4" />
              </IconBtn>
              {p.builtin && p.modified && (
                <IconBtn title="Reset to built-in text" onClick={() => confirmReset(p.id, p.title)}>
                  <RotateCcw className="h-4 w-4" />
                </IconBtn>
              )}
              <IconBtn title="Delete" danger onClick={() => deletePrompt(p.id)}>
                <Trash2 className="h-4 w-4" />
              </IconBtn>
            </div>

            {/* Body preview — click to edit in the modal. Blank lines stripped. */}
            <button
              onClick={() => setEditingId(p.id)}
              className="mt-2 block w-full rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2.5 py-2 text-left transition-colors hover:border-[var(--color-border)]"
            >
              <span
                className={cn(
                  "line-clamp-3 whitespace-pre-wrap break-words font-mono text-[12px] leading-snug",
                  previewText(p.body) ? "text-[var(--color-fg-dim)]" : "italic text-[var(--color-fg-faint)]",
                )}
              >
                {previewText(p.body) || "Empty prompt. Click to edit."}
              </span>
            </button>
          </div>
        ))}
      </div>

      {deletedCount > 0 && (
        <div className="mt-4">
          <button
            onClick={confirmRestore}
            className="text-[12.5px] text-[var(--color-fg-dim)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline"
          >
            Restore built-in prompts ({deletedCount})
          </button>
        </div>
      )}

      {editing && (
        <AppDialog
          open
          onOpenChange={(v) => { if (!v) setEditingId(null); }}
          title="Edit prompt"
          className="max-w-5xl"
        >
          <input
            value={editing.title}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            onChange={(e) => updatePrompt(editing.id, { title: e.target.value })}
            placeholder="Prompt title"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[14px] font-medium text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          />
          <textarea
            autoFocus
            value={editing.body}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            onChange={(e) => updatePrompt(editing.id, { body: e.target.value })}
            placeholder="Prompt text sent to the agent…"
            className="h-[58vh] w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-[var(--color-fg-faint)]">Changes save automatically.</span>
            <div className="flex items-center gap-2">
              {editing.builtin && editing.modified && (
                <Button variant="secondary" size="sm" onClick={() => confirmReset(editing.id, editing.title)}>
                  Reset to built-in
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={() => setEditingId(null)}>
                Done
              </Button>
            </div>
          </div>
        </AppDialog>
      )}
    </div>
  );
}

function IconBtn({ children, title, onClick, danger }: {
  children: React.ReactNode; title: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded p-1.5 text-[var(--color-fg-faint)] transition-colors hover:bg-[var(--color-hover)]",
        danger ? "hover:text-[var(--color-err)]" : "hover:text-[var(--color-fg)]",
      )}
    >
      {children}
    </button>
  );
}
