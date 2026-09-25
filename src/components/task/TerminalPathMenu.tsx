import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, ExternalLink, Copy } from "lucide-react";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem } from "@/components/ui/Dropdown";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { copyToClipboard } from "@/lib/clipboard";
import { revealPath, openFileExternal } from "@/lib/ipc";
import { useUI } from "@/store/ui";

/** An absolute path the click resolved to something OUTSIDE the task (GH
 *  #240). It has no task-relative form, so there is nothing to hand the
 *  editor: the menu offers the OS-level actions instead. */
export interface ExternalTarget { abs: string }

export function TerminalPathMenu({ x, y, candidates, external, onPick, onClose, onCloseAutoFocus }: {
  x: number;
  y: number;
  candidates: string[];
  /** Present ⇒ render the out-of-task actions instead of candidates. */
  external?: ExternalTarget;
  onPick: (path: string) => void;
  onClose: () => void;
  // `picked` distinguishes a candidate selection from a dismiss (Escape /
  // click-away), so the caller can route focus accordingly.
  onCloseAutoFocus?: (e: Event, picked: boolean) => void;
}) {
  const { t } = useTranslation("task");
  const picked = useRef(false);
  return (
    <DropdownRoot open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DropdownTrigger asChild>
        {/* invisible anchor at the click point; Radix positions the menu off it */}
        <div style={{ position: "fixed", left: x, top: y, width: 1, height: 1, pointerEvents: "none" }} />
      </DropdownTrigger>
      <DropdownMenu align="start" side="bottom" sideOffset={4}
        onCloseAutoFocus={onCloseAutoFocus && ((e) => onCloseAutoFocus(e, picked.current))}>
        {external ? (
          <>
            {/* The resolved path, shown BEFORE any action can be taken. This is
                the whole mitigation for handing an agent-printed string to the
                OS launcher: a lookalike path is only catchable if the user can
                read where it actually goes. Do not collapse this to a
                basename. */}
            <div className="max-w-[420px] break-all px-3 pb-2 pt-1 text-[12px] text-[var(--color-fg-faint)]">
              {external.abs}
            </div>
            {/* Reveal first, and so under initial focus: it dispatches to no
                handler (`open -R`), where "Open in default app" runs whatever
                is registered for the extension. The inert option is the one a
                stray Return key should hit. */}
            <DropdownItem onSelect={() => {
              picked.current = true;
              revealPath(external.abs).catch(() => useUI.getState().pushToast(t("pathMenu.revealFailed"), "error"));
            }}>
              <FolderOpen className="h-4 w-4 shrink-0" />
              <span>{t("pathMenu.revealInFinder")}</span>
            </DropdownItem>
            <DropdownItem onSelect={() => {
              picked.current = true;
              openFileExternal(external.abs)
                .then(r => { if (r === "revealed") useUI.getState().pushToast(t("pathMenu.noAppRevealed"), "info"); })
                .catch(() => useUI.getState().pushToast(t("pathMenu.openFailed"), "error"));
            }}>
              <ExternalLink className="h-4 w-4 shrink-0" />
              <span>{t("pathMenu.openInDefaultApp")}</span>
            </DropdownItem>
            <DropdownItem onSelect={() => {
              picked.current = true;
              void copyToClipboard(external.abs, "path");
            }}>
              <Copy className="h-4 w-4 shrink-0" />
              <span>{t("pathMenu.copyPath")}</span>
            </DropdownItem>
          </>
        ) : candidates.length === 0 ? (
          <div className="px-3 py-3 text-[13px] text-[var(--color-fg-faint)]">
            {t("pathMenu.noMatches")}
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
