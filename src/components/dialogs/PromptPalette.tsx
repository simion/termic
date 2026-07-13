// ⇧⌘R prompt search palette — fuzzy-filter the enabled prompt library by
// TITLE ONLY (not body), Enter runs the highlighted prompt straight at the
// focused agent (or opens the destination picker when there's none, via
// `fireOrPickDestination` — same fallback the ⌘R quick-fire leader key
// uses). Modelled on CommandPalette.tsx: same non-modal Dialog pattern (an
// action here can open the destination picker, which would get dismissed
// by a modal palette's closing animation), no solid backdrop.

import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search, BookText } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePromptLibrary, effectiveTriggerKeys, type Prompt } from "@/store/prompts";
import { fireOrPickDestination } from "@/lib/promptFire";
import { fuzzyMatch, Highlighted } from "@/lib/fuzzy";

export function PromptPalette() {
  const open = useUI(s => s.promptPaletteOpen);
  const close = useUI(s => s.closePromptPalette);
  const taskId = useApp(s => s.activeTaskId);
  const openSettings = useApp(s => s.openSettings);
  const allPrompts = usePromptLibrary(s => s.prompts);
  const enabledPrompts = useMemo(() => allPrompts.filter(p => p.enabled), [allPrompts]);
  const triggerKeys = useMemo(() => effectiveTriggerKeys(allPrompts), [allPrompts]);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) { setQuery(""); setActiveIdx(0); }
  }, [open]);
  useEffect(() => { setActiveIdx(0); }, [query]);

  const rows = useMemo(() => {
    type Scored = { prompt: Prompt; matches: number[] };
    if (!query) return enabledPrompts.map<Scored>(p => ({ prompt: p, matches: [] }));
    const out: Array<Scored & { score: number }> = [];
    for (const p of enabledPrompts) {
      const m = fuzzyMatch(p.title, query);
      if (!m) continue;
      out.push({ prompt: p, matches: m.matches, score: m.score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }, [enabledPrompts, query]);

  useEffect(() => {
    if (activeIdx > rows.length - 1) setActiveIdx(Math.max(0, rows.length - 1));
  }, [rows.length, activeIdx]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function run(prompt: Prompt) {
    if (!taskId) return;
    close();
    fireOrPickDestination(taskId, prompt);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = rows[activeIdx]?.prompt;
      if (p) run(p);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? null : close())} modal={false}>
      <Dialog.Portal>
        <div
          aria-hidden
          data-state={open ? "open" : "closed"}
          className="termic-backdrop pointer-events-none fixed inset-0 z-40 bg-black/30"
        />
        <Dialog.Content
          onOpenAutoFocus={() => { returnFocusRef.current = (document.activeElement as HTMLElement) ?? null; }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const el = returnFocusRef.current;
            requestAnimationFrame(() => {
              const ae = document.activeElement;
              if ((!ae || ae === document.body) && el && document.contains(el)) el.focus();
            });
          }}
          style={{ background: "color-mix(in srgb, var(--color-bg-1) 86%, transparent)" }}
          className="termic-pop fixed left-1/2 top-[14vh] z-50 w-[min(480px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl outline-none backdrop-blur-lg"
          onKeyDown={onKeyDown}
        >
          <Dialog.Title className="sr-only">Prompt search</Dialog.Title>
          <Dialog.Description className="sr-only">Search library prompts by title and run one.</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)]" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder="Search prompts by title…"
              className="w-full bg-transparent pl-1 text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
            />
          </div>
          <div ref={listRef} className="no-scrollbar max-h-[min(50vh,360px)] overflow-y-auto py-1">
            {rows.length === 0 && (
              <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">
                {enabledPrompts.length === 0 ? "No prompts yet." : "No matching prompts"}
              </div>
            )}
            {rows.map(({ prompt, matches }, i) => (
              <button
                key={prompt.id}
                data-row={i}
                onClick={() => run(prompt)}
                onMouseMove={() => setActiveIdx(i)}
                style={i === activeIdx ? { background: "color-mix(in srgb, var(--color-fg) 13%, transparent)" } : undefined}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-fg)]">
                  {query ? <Highlighted text={prompt.title} matches={matches} /> : prompt.title}
                </span>
                {triggerKeys.get(prompt.id) && (
                  <kbd className="shrink-0 rounded border border-[var(--color-border-soft)] px-1 font-mono text-[10.5px] uppercase leading-[16px] text-[var(--color-fg-faint)]">
                    {triggerKeys.get(prompt.id)}
                  </kbd>
                )}
              </button>
            ))}
          </div>
          <div className="border-t border-[var(--color-border)]">
            <button
              onClick={() => { close(); requestAnimationFrame(() => openSettings("prompts")); }}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[12.5px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]"
            >
              <BookText className="h-3.5 w-3.5" />
              Manage prompts…
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
