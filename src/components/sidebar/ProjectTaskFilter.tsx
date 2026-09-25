// Project-row filter controls (GH #324). The header's hover bar carries ONE
// filter icon, left of the settings cog, lit while any filter is on. It opens
// a bar on its own line under the header: the text input, with the
// notifications bell to its right. Its own line so a long project name keeps
// its room. The matching itself is in lib/taskFilter.ts; these only edit the
// per-project filter in the ui store. Whether the bar is open is the
// sidebar's local state, since the icon and the bar both read it.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Bell, ListFilter, Search, X } from "lucide-react";
import { Tip } from "@/components/ui/Tooltip";
import { useUI } from "@/store/ui";
import { cn } from "@/lib/utils";

const iconBtn = "rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]";
const litBtn = "bg-[var(--color-bg-3)] text-[var(--color-accent)] hover:text-[var(--color-accent)]";

/** The header's filter icon. Lit while a filter is active (bell or text),
 *  which is what tells the user rows are hidden. */
export function ProjectFilterToggle({ projectId, active, revealed, onToggle }: {
  projectId: string;
  active: boolean;
  /** Keep the header's controls visible without hover. */
  revealed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("sidebar");
  return (
    <Tip content={active ? t("taskFilter.tipActive") : t("taskFilter.tip")}>
      <button
        aria-label={t("taskFilter.tip")}
        aria-pressed={active}
        data-testid={`project-filter-toggle-${projectId}`}
        // Whether the controls are held open without hover. Specs read this
        // rather than computed opacity, which also depends on where the real
        // pointer happens to be.
        data-pinned={revealed}
        className={cn(
          iconBtn, "transition-opacity",
          revealed ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          active && litBtn,
        )}
        // Keep focus in an open input: its blur would fold the bar away
        // before this click could decide what to do with it.
        onMouseDown={e => e.preventDefault()}
        onClick={e => { e.stopPropagation(); onToggle(); }}
      ><ListFilter className="h-4 w-4" /></button>
    </Tip>
  );
}

/** The filter bar under the project header: text input, then the bell.
 *  `focusKey` bumps on every open, so the caret lands in the input. */
export function ProjectFilterBar({ projectId, notifCount, focusKey, onClose, onActivate }: {
  projectId: string;
  /** Tasks in this project with a notification (the tray's classification). */
  notifCount: number;
  focusKey: number;
  onClose: () => void;
  /** A filter just went from off to on (the sidebar expands the project). */
  onActivate: () => void;
}) {
  const { t } = useTranslation("sidebar");
  const text = useUI(s => s.taskFilters[projectId]?.text ?? "");
  const bell = useUI(s => s.taskFilters[projectId]?.bell ?? false);
  const setText = useUI(s => s.setTaskFilterText);
  const toggleBell = useUI(s => s.toggleTaskFilterBell);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, [focusKey]);

  // Emptying the text closes the bar unless the bell still filters: an
  // active filter always keeps its bar on screen.
  const clearText = () => {
    setText(projectId, "");
    if (!bell) onClose();
    inputRef.current?.blur();
  };

  return (
    <div className="ml-3 mr-1 mb-px flex items-center gap-1" data-no-drag>
      <div className="relative flex min-w-0 flex-1 items-center">
        <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--color-fg-faint)]" />
        <input
          ref={inputRef}
          value={text}
          placeholder={t("taskFilter.inputPlaceholder")}
          data-testid={`project-filter-input-${projectId}`}
          onChange={e => {
            if (text.trim() === "" && e.target.value.trim() !== "" && !bell) onActivate();
            setText(projectId, e.target.value);
          }}
          // An abandoned bar with nothing in it folds away.
          onBlur={() => { if (text === "" && !bell) onClose(); }}
          onKeyDown={e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); clearText(); }
          }}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className={cn(
            "h-7 w-full rounded-md border bg-[var(--color-bg)] pl-7 pr-6 text-[12.5px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)]",
            text !== "" ? "border-[var(--color-accent)]" : "border-[var(--color-border-soft)] focus:border-[var(--color-accent)]",
          )}
        />
        {text !== "" && (
          <button
            aria-label={t("taskFilter.clear")}
            data-testid={`project-filter-clear-${projectId}`}
            onMouseDown={e => e.preventDefault()}
            onClick={e => { e.stopPropagation(); clearText(); }}
            className="absolute right-1 rounded p-0.5 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
          ><X className="h-3.5 w-3.5" /></button>
        )}
      </div>
      <Tip content={bell ? t("taskFilter.bellTipActive") : t("taskFilter.bellTip")}>
        <button
          aria-label={t("taskFilter.bellTip")}
          aria-pressed={bell}
          data-testid={`project-filter-bell-${projectId}`}
          className={cn(iconBtn, "flex h-7 shrink-0 items-center gap-0.5 px-1.5", bell && litBtn)}
          // Same as the toggle: a click here must not blur the input and
          // fold the bar away under the pointer.
          onMouseDown={e => e.preventDefault()}
          onClick={e => {
            e.stopPropagation();
            // Turning the bell off with no text leaves nothing filtering.
            if (bell && text === "") onClose();
            if (!bell && text.trim() === "") onActivate();
            toggleBell(projectId);
          }}
        >
          <Bell className="h-4 w-4" />
          {notifCount > 0 && (
            <span
              data-testid={`project-filter-bell-count-${projectId}`}
              className="text-[10.5px] font-medium leading-none tabular-nums"
            >{notifCount}</span>
          )}
        </button>
      </Tip>
    </div>
  );
}
