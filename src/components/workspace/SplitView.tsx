// Split pane renderer (iTerm-style).
// SplitNodeView renders the entire extra-pane subtree as absolutely-positioned
// leaf divs. Stable key={leaf.id} means tree restructuring reconciles via a
// style update — terminals survive splits/closes without unmounting.
//
// Drag-to-rearrange: DragState, DropZone, and detectZone are exported so
// WorkspaceView owns the drag lifecycle and passes drag state as a prop.
// The red band overlay (50% of each pane) shows where the pane will land.

import { lazy, Suspense, useRef, useMemo } from "react";
import type { Workspace, TerminalTab } from "@/lib/types";
import type { SplitTree, SplitNode, PaneLeaf } from "@/lib/splitTree";
import { getAllLeaves, findSplitById, computeLeafBounds, computeSplitNodeRects } from "@/lib/splitTree";
import { useApp } from "@/store/app";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { PaneHeader } from "./PaneHeader";
import { TerminalPane } from "./TerminalPane";
import { SplitLauncher } from "./SplitLauncher";
import { cn } from "@/lib/utils";

const EditorPane     = lazy(() => import("./EditorPane").then(m => ({ default: m.EditorPane })));
const DiffPane       = lazy(() => import("./DiffPane").then(m => ({ default: m.DiffPane })));
const MarkdownPane   = lazy(() => import("./MarkdownPane").then(m => ({ default: m.MarkdownPane })));

const isMarkdownPath = (p: string) => /\.(md|markdown|mdx)$/i.test(p);

// ── drop-zone types (exported so WorkspaceView can own the drag lifecycle) ─────

export type DropZone = 'left' | 'right' | 'top' | 'bottom';

export interface DragState {
  sourcePaneId: string;
  // Current pointer position in viewport coords.
  x: number;
  y: number;
  // The drop target.
  targetPaneId: string | null;
  zone: DropZone | null;
}

// ── helpers ────────────────────────────────────────────────────────────────────

export function detectZone(rect: DOMRect, x: number, y: number): DropZone {
  const relX = (x - rect.left) / rect.width;
  const relY = (y - rect.top)  / rect.height;
  // Prefer top/bottom for narrow zones near edges.
  const EDGE = 0.25;
  if (relY < EDGE) return 'top';
  if (relY > 1 - EDGE) return 'bottom';
  if (relX < 0.5) return 'left';
  return 'right';
}

// ── leaf pane ─────────────────────────────────────────────────────────────────

interface LeafProps {
  ws: Workspace;
  leaf: PaneLeaf;
  isActive: boolean;
  xtermBg: string;
  onDragStart: (paneId: string, e: React.MouseEvent) => void;
  dragging: boolean;
  dragOver: { zone: DropZone } | null;
  dimAmount: number;
  dimActive: boolean;
}

function PaneLeafView({
  ws, leaf, isActive, xtermBg, onDragStart, dragging, dragOver, dimAmount, dimActive,
}: LeafProps) {
  const isMainPane = !!leaf.isMain;
  const tab = useApp(s => {
    const tid = isMainPane ? s.activeTab[ws.id] : leaf.tabId;
    return tid ? (s.tabs[ws.id] ?? []).find(t => t.id === tid) : undefined;
  });
  const setActivePaneId = useApp(s => s.setActivePaneId);
  const closePane = useApp(s => s.closePane);

  const title = tab
    ? ((tab as TerminalTab).liveTitle?.trim() || tab.title)
    : isMainPane ? "Main" : "New pane";

  // dim overlay opacity: 0..1
  const dimOpacity = (dimActive && !isActive) ? dimAmount / 100 : 0;

  // Red drop-zone preview band.
  const dropPreview = dragOver && dragOver.zone
    ? zoneStyle(dragOver.zone)
    : null;

  return (
    <div
      className="absolute inset-0 flex flex-col overflow-hidden"
      style={{ backgroundColor: xtermBg }}
      onMouseDown={() => {
        if (!isActive) setActivePaneId(ws.id, leaf.id);
      }}
    >
      <PaneHeader
        title={title}
        paneId={leaf.id}
        wsId={ws.id}
        onClose={() => closePane(ws.id, leaf.id)}
        onDragStart={onDragStart}
        isDragging={dragging}
        isMainPane={isMainPane}
      />

      <div className="relative min-h-0 flex-1">
        {tab ? (
          <>
            {tab.type === "terminal" && (
              <TerminalPane ws={ws} tab={tab as TerminalTab} active={isActive} />
            )}
            {tab.type === "edit" && (
              <Suspense fallback={null}>
                {isMarkdownPath(tab.path) ? <MarkdownPane ws={ws} tab={tab} /> : <EditorPane ws={ws} tab={tab} />}
              </Suspense>
            )}
            {tab.type === "diff" && (
              <Suspense fallback={null}><DiffPane ws={ws} tab={tab} /></Suspense>
            )}
          </>
        ) : !isMainPane ? (
          <SplitLauncher ws={ws} paneId={leaf.id} />
        ) : null}
      </div>

      {/* Dim overlay for inactive panes — gray tint like iTerm2, not black. */}
      {dimOpacity > 0 && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundColor: `rgba(128,128,128,${dimOpacity})`, zIndex: 10 }}
        />
      )}

      {/* Drop-zone preview: red band showing where the dragged pane will land. */}
      {dropPreview && (
        <div
          className="pointer-events-none absolute"
          style={{ zIndex: 20, backgroundColor: 'rgba(239,68,68,0.35)', ...dropPreview }}
        />
      )}
    </div>
  );
}

export function zoneStyle(zone: DropZone): React.CSSProperties {
  const BAND = "50%";
  switch (zone) {
    case 'left':   return { top: 0, bottom: 0, left: 0,     width:  BAND };
    case 'right':  return { top: 0, bottom: 0, right: 0,    width:  BAND };
    case 'top':    return { left: 0, right: 0, top: 0,      height: BAND };
    case 'bottom': return { left: 0, right: 0, bottom: 0,   height: BAND };
  }
}

// ── flat absolute renderer ────────────────────────────────────────────────────

export interface SplitViewProps {
  ws: Workspace;
  node: SplitTree;
  activePaneId: string;
  xtermBg: string;
  drag: DragState | null;
  onDragStart: (paneId: string, e: React.MouseEvent) => void;
  dimAmount: number;
  dimActive: boolean;
}

/**
 * Renders all leaves as absolutely-positioned divs keyed by leaf ID.
 * When the tree is restructured (a leaf becomes a split node), leaf IDs are
 * stable so React reconciles via a style update instead of unmount+remount.
 * Terminals and agents survive splits without restarting.
 *
 * Exported so WorkspaceView can render just the extra-pane subtree.
 */
export function SplitNodeView({ ws, node, activePaneId, xtermBg, drag, onDragStart, dimAmount, dimActive }: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setSplitRatio = useApp(s => s.setSplitRatio);

  const leaves = useMemo(() => getAllLeaves(node), [node]);
  const leafBounds = useMemo(() => computeLeafBounds(node), [node]);
  const splitRects = useMemo(() => computeSplitNodeRects(node), [node]);
  const splitNodes = useMemo<SplitNode[]>(() => {
    const arr: SplitNode[] = [];
    function collect(n: SplitTree) {
      if (n.type === 'pane') return;
      arr.push(n as SplitNode);
      collect(n.a);
      collect(n.b);
    }
    collect(node);
    return arr;
  }, [node]);

  return (
    <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* Leaves: stable key={leaf.id} so tree restructuring never unmounts a terminal. */}
      {leaves.map(leaf => {
        const rect = leafBounds.get(leaf.id);
        if (!rect) return null;
        const isActive = leaf.id === activePaneId;
        const dragOver =
          drag?.targetPaneId === leaf.id && drag?.sourcePaneId !== leaf.id && drag?.zone
            ? { zone: drag.zone }
            : null;
        return (
          <div
            key={leaf.id}
            data-split-leaf=""
            data-pane-id={leaf.id}
            className="absolute overflow-hidden"
            style={{
              left:   `${rect.x * 100}%`,
              top:    `${rect.y * 100}%`,
              width:  `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
          >
            <PaneLeafView
              ws={ws}
              leaf={leaf}
              isActive={isActive}
              xtermBg={xtermBg}
              onDragStart={onDragStart}
              dragging={!!(drag?.sourcePaneId === leaf.id)}
              dragOver={dragOver}
              dimAmount={dimAmount}
              dimActive={dimActive}
            />
          </div>
        );
      })}

      {/* Resize handles: one overlay per split node, positioned at each boundary. */}
      {splitNodes.map(sn => {
        const rect = splitRects.get(sn.id);
        if (!rect) return null;
        const isVert = sn.dir === 'v';
        // Wrapper is zero-size and sits exactly on the boundary line.
        // ResizeHandle's own top-0/bottom-0 (or left-0/right-0) fills the wrapper extent.
        return (
          <div
            key={sn.id}
            className="absolute"
            style={isVert
              ? { left: `${(rect.x + rect.w * sn.ratio) * 100}%`, top: `${rect.y * 100}%`, height: `${rect.h * 100}%`, width: 0 }
              : { top: `${(rect.y + rect.h * sn.ratio) * 100}%`, left: `${rect.x * 100}%`, width: `${rect.w * 100}%`, height: 0 }
            }
          >
            <ResizeHandle
              direction={isVert ? 'x' : 'y'}
              alwaysVisible
              onDrag={(delta) => {
                const container = containerRef.current;
                if (!container) return;
                const totalPx = isVert ? container.clientWidth : container.clientHeight;
                // rect.w/h is the fraction of the total container this split node occupies.
                const nodeSize = (isVert ? rect.w : rect.h) * totalPx;
                if (!nodeSize) return;
                const st = useApp.getState();
                const tabKey = st.activeTab[ws.id];
                const liveFullTree = tabKey ? st.splitTree[tabKey] : null;
                if (!liveFullTree) return;
                const liveSplit = findSplitById(liveFullTree, sn.id);
                if (!liveSplit) return;
                const newRatio = Math.max(0.05, Math.min(0.95, liveSplit.ratio + delta / nodeSize));
                setSplitRatio(ws.id, sn.id, newRatio);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

