// Split pane renderer (Sublime-style: per-pane tab strips).
// SplitNodeView renders the extra-pane subtree's CHROME as absolutely-
// positioned leaf divs: pane header, empty-pane launcher, dim overlay,
// resize handles. Tab CONTENT is NOT rendered here — it lives in
// TaskView's flat content layer (one stable parent for every tab,
// keyed by tab id) so moving a tab between panes never reparents/remounts
// it: terminals keep their PTY/xterm, editors keep their buffer.
//
// Tabs move between panes by dragging a tab pill onto another pane's header
// (see PaneHeader / useTabStripDrag). There is no drag-to-rearrange for whole
// panes: that was the old iTerm-style red-band flow and it fought the tab
// drag for pointer events.

import { useRef, useMemo } from "react";
import type { Task } from "@/lib/types";
import type { SplitTree, SplitNode, PaneLeaf } from "@/lib/splitTree";
import { getAllLeaves, findSplitById, computeLeafBounds, computeSplitNodeRects } from "@/lib/splitTree";
import { useApp } from "@/store/app";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { PaneHeader } from "./PaneHeader";
import { SplitLauncher } from "./SplitLauncher";

// ── leaf pane chrome ──────────────────────────────────────────────────────────

interface LeafProps {
  task: Task;
  leaf: PaneLeaf;
  isActive: boolean;
  xtermBg: string;
  dimAmount: number;
  dimActive: boolean;
}

function PaneLeafView({
  task, leaf, isActive, xtermBg, dimAmount, dimActive,
}: LeafProps) {
  const setActivePaneId = useApp(s => s.setActivePaneId);
  const closePane = useApp(s => s.closePane);

  // dim overlay opacity: 0..1
  const dimOpacity = (dimActive && !isActive) ? dimAmount / 100 : 0;

  return (
    <div
      className="absolute inset-0 flex flex-col overflow-hidden"
      style={{ backgroundColor: xtermBg }}
      onMouseDown={() => {
        if (!isActive) setActivePaneId(task.id, leaf.id);
      }}
    >
      <PaneHeader
        leaf={leaf}
        task={task}
        onClose={() => closePane(task.id, leaf.id)}
      />

      {/* Content area: the actual tab content paints here from the flat
          layer above; only the empty-pane launcher renders locally. */}
      <div className="relative min-h-0 flex-1">
        {(leaf.tabIds?.length ?? 0) === 0 && <SplitLauncher task={task} paneId={leaf.id} />}
      </div>

      {/* Dim overlay for inactive panes — gray tint like iTerm2, not black.
          z 10 also beats the flat content layer's z ≤ 1 (neither this wrapper
          nor the leaf wrapper creates a stacking context). */}
      {dimOpacity > 0 && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundColor: `rgba(128,128,128,${dimOpacity})`, zIndex: 10 }}
        />
      )}
    </div>
  );
}

// ── flat absolute renderer ────────────────────────────────────────────────────

export interface SplitViewProps {
  task: Task;
  node: SplitTree;
  activePaneId: string;
  xtermBg: string;
  dimAmount: number;
  dimActive: boolean;
}

/**
 * Renders all leaves as absolutely-positioned divs keyed by leaf ID.
 * When the tree is restructured (a leaf becomes a split node), leaf IDs are
 * stable so React reconciles via a style update instead of unmount+remount.
 * Terminals and agents survive splits without restarting.
 *
 * Receives the FULL tree (main included, for correct geometry + handles at
 * every seam) but skips the main leaf's chrome — TaskView renders that.
 */
export function SplitNodeView({ task, node, activePaneId, xtermBg, dimAmount, dimActive }: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setSplitRatio = useApp(s => s.setSplitRatio);

  const leaves = useMemo(() => getAllLeaves(node).filter(l => !l.isMain), [node]);
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
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {/* Leaves: stable key={leaf.id} so tree restructuring never unmounts a terminal. */}
      {leaves.map(leaf => {
        const rect = leafBounds.get(leaf.id);
        if (!rect) return null;
        const isActive = leaf.id === activePaneId;
        return (
          <div
            key={leaf.id}
            data-split-leaf=""
            data-pane-id={leaf.id}
            className="pointer-events-auto absolute overflow-hidden"
            style={{
              left:   `${rect.x * 100}%`,
              top:    `${rect.y * 100}%`,
              width:  `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
          >
            <PaneLeafView
              task={task}
              leaf={leaf}
              isActive={isActive}
              xtermBg={xtermBg}
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
            // z-20: the flat content layer in TaskView renders LATER in
            // the DOM with z 1, so without an explicit z-index the handles
            // would paint underneath it. pointer-events-auto: the container
            // is pointer-events-none (main chrome sits below it).
            className="pointer-events-auto absolute z-20"
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
                const liveFullTree = st.splitTree[task.id];
                if (!liveFullTree) return;
                const liveSplit = findSplitById(liveFullTree, sn.id);
                if (!liveSplit) return;
                const newRatio = Math.max(0.05, Math.min(0.95, liveSplit.ratio + delta / nodeSize));
                setSplitRatio(task.id, sn.id, newRatio);
              }}
              onEnd={() => useApp.getState().saveSplitLayout(task.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
