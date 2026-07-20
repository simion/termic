// Per-pane tab strip for split panes.
// Matches the main TabBar exactly (h-9, same TabPill components, same + dropdown)
// so every pane looks like a first-class pane, not a secondary chrome strip.
//
// Tab pills can be dragged onto another pane's header (move tab to that pane)
// or onto the main tab strip (move tab back to the main pane). Whole-pane
// drag-to-rearrange was removed: it hijacked pointer events from the pills.

import { useState, useMemo, useRef, useEffect } from "react";
import type { Task, Tab } from "@/lib/types";
import type { PaneLeaf } from "@/lib/splitTree";
import { useApp } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import { TabPill } from "./TabBar";
import { Button } from "@/components/ui/Button";
import {
  DropdownRoot, DropdownTrigger, DropdownMenu,
  DropdownItem, DropdownLabel, DropdownSeparator,
} from "@/components/ui/Dropdown";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { visibleCliIds, isTerminalEntry } from "@/lib/agents";
import { focusPaneTab } from "@/lib/tabFocus";
import { requestClosePaneTab } from "@/lib/closeTab";
import { showDragGhost, moveDragGhost, hideDragGhost } from "@/lib/dragGhost";
import { detectDropZone, setDropHighlight, clearDropHighlight, type DropZone } from "@/lib/dropZones";

interface PaneHeaderProps {
  leaf: PaneLeaf;
  task: Task;
  onClose: () => void;
}

export function PaneHeader({ leaf, task, onClose }: PaneHeaderProps) {
  const paneId = leaf.id;

  // Backward compat: HMR keeps old in-memory state with `tabId` (not `tabIds`/`activeTabId`).
  const activeTabId: string | null = leaf.activeTabId ?? (leaf as any).tabId ?? null;

  const paneTabs = useApp(useShallow(s => {
    const ids: string[] = leaf.tabIds ?? ((leaf as any).tabId ? [(leaf as any).tabId] : []);
    return ids.map(id => (s.tabs[task.id] ?? []).find(t => t.id === id)).filter(Boolean) as Tab[];
  }));

  const setPaneActiveTab = useApp(s => s.setPaneActiveTab);
  const addPaneTab       = useApp(s => s.addPaneTab);
  const moveTabToPane    = useApp(s => s.moveTabToPane);
  const moveTabToMain    = useApp(s => s.moveTabToMain);
  const moveTabToSplit   = useApp(s => s.moveTabToSplit);

  // Cross-pane drag: lets tabs be dragged to other panes' headers or back to
  // the main tab strip.
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const prevDropTargetRef = useRef<HTMLElement | null>(null);
  // Teardown for an in-flight drag — invoked on pointerup, pointercancel
  // (WKWebView gesture interruption) and unmount, so a cancelled drag can't
  // leave window listeners attached or the pill stuck in dragging styling.
  const dragTeardownRef = useRef<(() => void) | null>(null);

  function clearDropTarget() {
    if (prevDropTargetRef.current) {
      clearDropHighlight(prevDropTargetRef.current);
      prevDropTargetRef.current = null;
    }
  }

  // Drop target under the pointer — a tab can be dropped ANYWHERE in a pane
  // or in the main pane, not just on tab strips. `el` is the highlight host
  // (the whole pane / main wrapper, so the overlay covers it); toPaneId null
  // = the main pane. `zone` center = move into the pane; an edge zone (outer
  // 20%) = split the pane in half there. Tab strips are always "center"
  // (move). The dragged pill is pointer-events:none while dragging, so
  // elementFromPoint sees underneath.
  function hitTestDropTarget(clientX: number, clientY: number): { el: HTMLElement | null; toPaneId: string | null; zone: DropZone } | null {
    const raw = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const mainHighlight = () =>
      document.querySelector("[data-main-content][data-split-leaf]") as HTMLElement | null;
    const paneHighlight = (id: string) =>
      document.querySelector(`[data-split-leaf][data-pane-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    const zoneOf = (el: HTMLElement | null): DropZone =>
      el ? detectDropZone(el.getBoundingClientRect(), clientX, clientY) : "center";

    const header = raw?.closest("[data-pane-header]") as HTMLElement | null;
    if (header) {
      const id = header.getAttribute("data-pane-id");
      return id && id !== paneId ? { el: paneHighlight(id), toPaneId: id, zone: "center" } : null;
    }
    if (raw?.closest("[data-main-strip]")) return { el: mainHighlight(), toPaneId: null, zone: "center" };
    // Pane content lives in the flat layer, whose divs carry data-split-leaf
    // + data-pane-id; MAIN content divs carry data-main-content instead (the
    // main chrome wrapper is a sibling, not an ancestor — closest() never
    // reaches it from the main surface). Check both markers.
    const leaf = raw?.closest("[data-split-leaf]") as HTMLElement | null;
    if (leaf && !leaf.hasAttribute("data-main-content")) {
      const id = leaf.getAttribute("data-pane-id");
      if (id) {
        const el = paneHighlight(id);
        const zone = zoneOf(el);
        // Same-pane center drops are no-ops, but same-pane EDGE drops are
        // meaningful only when another tab remains behind. A single-tab pane
        // would just create an empty launcher half, which is not useful.
        if (id === paneId) return zone === "center" || paneTabs.length <= 1 ? null : { el, toPaneId: id, zone };
        return { el, toPaneId: id, zone };
      }
      return null;
    }
    if (raw?.closest("[data-main-content]")) {
      const el = mainHighlight();
      return { el, toPaneId: null, zone: zoneOf(el) };
    }
    return null;
  }

  function startTabDrag(tabId: string, e: React.PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
    // Prevent the native text selection from anchoring here — dragging the
    // pill over the pane's terminal would otherwise sweep a full-pane
    // selection (same fix as useTabStripDrag).
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    // 5px threshold before the pill enters drag mode — otherwise a plain click
    // flips the pill to pointer-events:none mid-click and the click is lost.
    let started = false;

    function onMove(ev: PointerEvent) {
      if (!started) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        started = true;
        setDragTabId(tabId);
        // Drop any selection that sneaked in before the drag threshold.
        window.getSelection()?.removeAllRanges();
        // Cursor-following ghost — the pill itself doesn't move on a
        // cross-pane drag, so this is the "you are dragging" signal.
        const t = paneTabs.find(tt => tt.id === tabId);
        showDragGhost(t ? (((t as any).liveTitle as string) || t.title) : "Tab", ev.clientX, ev.clientY);
      }
      moveDragGhost(ev.clientX, ev.clientY);
      clearDropTarget();
      const target = hitTestDropTarget(ev.clientX, ev.clientY);
      if (target?.el) {
        setDropHighlight(target.el, target.zone);
        prevDropTargetRef.current = target.el;
      }
    }
    function teardown() {
      hideDragGhost();
      clearDropTarget();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      dragTeardownRef.current = null;
      setDragTabId(null);
    }
    function onUp(ev: PointerEvent) {
      const target = started ? hitTestDropTarget(ev.clientX, ev.clientY) : null;
      teardown();
      if (target) {
        if (target.zone !== "center") moveTabToSplit(task.id, tabId, target.toPaneId, target.zone);
        else if (target.toPaneId) moveTabToPane(task.id, tabId, target.toPaneId);
        else moveTabToMain(task.id, tabId);
      }
    }
    function onCancel() { teardown(); }
    dragTeardownRef.current = teardown;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  useEffect(() => () => { dragTeardownRef.current?.(); clearDropTarget(); }, []);

  // ⌘T from inside this pane opens this pane's "+" dropdown.
  useEffect(() => {
    function onNewTabMenu(e: Event) {
      const { taskId: eTaskId, paneId: ePaneId } = (e as CustomEvent).detail ?? {};
      if (eTaskId === task.id && ePaneId === paneId) setOpen(true);
    }
    window.addEventListener("termic-pane-new-tab-menu", onNewTabMenu);
    return () => window.removeEventListener("termic-pane-new-tab-menu", onNewTabMenu);
  }, [task.id, paneId]);

  const activeTaskPaneId = useApp(s => s.activePaneId[task.id] ?? "");
  const isPaneFocused = activeTaskPaneId === paneId;

  const registry        = useApp(s => s.agents);
  const detectedClis    = useApp(s => s.detectedClis);
  const visibleClis     = useMemo(
    () => visibleCliIds(registry.map(a => a.id), registry, detectedClis),
    [registry, detectedClis],
  );
  const customTerminals = useMemo(
    () => registry.filter(a => isTerminalEntry(a) && !a.disabled),
    [registry],
  );
  const agentEntries = useMemo(
    () => registry.filter(a => visibleClis.has(a.id)),
    [registry, visibleClis],
  );

  const [open, setOpen]               = useState(false);
  const suppressDropdownReturn        = useRef(false);

  function spawnPaneTab(cli: string) {
    suppressDropdownReturn.current = true;
    addPaneTab(task.id, paneId, cli);
    setOpen(false);
  }

  return (
    <div
      data-pane-header=""
      data-pane-id={paneId}
      className="termic-tabstrip flex h-9 shrink-0 items-stretch border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] select-none"
    >
      {/* Scrollable tab pills — same geometry as main TabBar. */}
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto no-scrollbar pl-2">
        {paneTabs.length === 0 ? (
          <span className="flex items-center px-2 text-[12.5px] italic text-[var(--color-fg-faint)]">
            New pane
          </span>
        ) : (
          paneTabs.map(tab => (
            <TabPill
              key={tab.id}
              task={task}
              tab={tab}
              active={tab.id === activeTabId}
              paneFocused={isPaneFocused}
              compact
              // focusPaneTab: keyboard focus must follow the click so ⌘W (which
              // derives the pane from DOM focus) targets THIS pane afterwards.
              onSelect={() => { setPaneActiveTab(task.id, paneId, tab.id); focusPaneTab(tab.id); }}
              // Closing the pane's last tab collapses the pane, matching ⌘W
              // (useShortcuts). Without this the X leaves an empty "New pane"
              // behind while ⌘W removes it. Capture wasLastTab before the
              // async confirm, and only collapse if the close actually went
              // through (onClose === closePane for this leaf).
              onClose={() => {
                const wasLastTab = (leaf.tabIds?.length ?? 1) <= 1;
                void requestClosePaneTab(task.id, paneId, tab.id).then(closed => {
                  if (closed && wasLastTab) onClose();
                });
              }}
              renaming={null}
              onStartRename={() => {}}
              onChangeRename={() => {}}
              onCommitRename={() => {}}
              onCancelRename={() => {}}
              dragging={dragTabId === tab.id}
              dragTx={0}
              onStartDrag={(e) => startTabDrag(tab.id, e)}
            />
          ))
        )}
      </div>

      {/* + dropdown: same agent/shell menu as the main TabBar. */}
      <DropdownRoot open={open} onOpenChange={setOpen}>
        <DropdownTrigger asChild>
          <Button size="icon" variant="icon" className="h-8 w-8 shrink-0 self-center">
            <Plus className="h-4 w-4" />
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          align="end"
          onCloseAutoFocus={(e) => {
            if (suppressDropdownReturn.current) {
              suppressDropdownReturn.current = false;
              e.preventDefault();
            }
          }}
        >
          <DropdownLabel>New terminal</DropdownLabel>
          <DropdownItem onSelect={() => spawnPaneTab('shell')}>
            <span className="shrink-0 text-[var(--color-fg-dim)]">
              <CliIcon cli="shell" className="h-4 w-4" />
            </span>
            Terminal
          </DropdownItem>
          {customTerminals.map(a => (
            <DropdownItem key={a.id} onSelect={() => spawnPaneTab(a.id)}>
              <span className={cn("shrink-0", CLI_BRAND_COLOR[a.icon_id] || "text-[var(--color-fg-dim)]")}>
                <CliIcon cli={a.icon_id} className="h-4 w-4" />
              </span>
              {a.display_name}
            </DropdownItem>
          ))}
          {agentEntries.length > 0 && (
            <>
              <DropdownSeparator />
              <DropdownLabel>New agent</DropdownLabel>
              {agentEntries.map(a => (
                <DropdownItem key={a.id} onSelect={() => spawnPaneTab(a.id)}>
                  <span className={cn("shrink-0", CLI_BRAND_COLOR[a.icon_id] || "text-[var(--color-fg-dim)]")}>
                    <CliIcon cli={a.icon_id} className="h-4 w-4" />
                  </span>
                  {a.display_name}
                </DropdownItem>
              ))}
            </>
          )}
        </DropdownMenu>
      </DropdownRoot>

      {/* Close pane. */}
      <button
        data-pane-close=""
        title="Close pane"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="shrink-0 self-center rounded p-1 mr-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
