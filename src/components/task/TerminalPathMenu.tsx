import { useRef } from "react";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem } from "@/components/ui/Dropdown";
import { fileIconUrl } from "@/lib/explorer/iconResolver";

export function TerminalPathMenu({ x, y, candidates, onPick, onClose, onCloseAutoFocus }: {
  x: number;
  y: number;
  candidates: string[];
  onPick: (path: string) => void;
  onClose: () => void;
  // `picked` distinguishes a candidate selection from a dismiss (Escape /
  // click-away), so the caller can route focus accordingly.
  onCloseAutoFocus?: (e: Event, picked: boolean) => void;
}) {
  const picked = useRef(false);
  return (
    <DropdownRoot open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DropdownTrigger asChild>
        {/* invisible anchor at the click point; Radix positions the menu off it */}
        <div style={{ position: "fixed", left: x, top: y, width: 1, height: 1, pointerEvents: "none" }} />
      </DropdownTrigger>
      <DropdownMenu align="start" side="bottom" sideOffset={4}
        onCloseAutoFocus={onCloseAutoFocus && ((e) => onCloseAutoFocus(e, picked.current))}>
        {candidates.length === 0 ? (
          <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">
            No matches
          </div>
        ) : candidates.map(path => {
          const name = path.split("/").pop() || path;
          const dir = path.slice(0, path.length - name.length);
          return (
            <DropdownItem key={path} onSelect={() => { picked.current = true; onPick(path); }}>
              <img src={fileIconUrl(name)} alt="" className="h-4 w-4 shrink-0 file-icon" />
              <span className="truncate">{name}</span>
              {dir && (
                <span className="ml-2 min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-faint)]">
                  {dir.replace(/\/$/, "")}
                </span>
              )}
            </DropdownItem>
          );
        })}
      </DropdownMenu>
    </DropdownRoot>
  );
}
