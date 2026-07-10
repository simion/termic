// Shared path context-menu items, reused everywhere a file/folder can be
// right-clicked (Git panel, file tree, diff header, editor breadcrumb). Keeps
// the wording + ordering identical across surfaces. Mirrors VS Code:
//   - "Copy path (relative)"  → path relative to the task root
//   - "Copy path (absolute)"  → full on-disk path
//   - Open / Show in <file manager> → folders open, files are revealed/selected
//
// `rel` is task-relative; `root` is the task's absolute disk path.
// Rendered inside a <ContextMenuContent>, so it emits items only (no wrapper).
// Cross-platform: the file-manager label adapts (Finder on macOS, File Manager
// elsewhere) and the open/reveal IPCs dispatch per-OS on the Rust side.

import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/ContextMenu";
import { copyToClipboard, joinPath } from "@/lib/clipboard";
import { openPath, revealPath } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { IS_MAC } from "@/lib/shortcuts";
import { Copy, CornerUpLeft, FolderOpen } from "lucide-react";

const FILE_MANAGER = IS_MAC ? "Finder" : "File Manager";

export function CopyPathItems({ rel, root, isDir = false }: { rel: string; root: string; isDir?: boolean }) {
  const abs = joinPath(root, rel);
  const revealInFileManager = () => {
    // Folders open (show their contents); files are revealed/selected in
    // their parent. Both resolve per-OS in Rust (open_command / reveal_command).
    (isDir ? openPath(abs) : revealPath(abs))
      .catch((e: unknown) => useUI.getState().pushToast(String(e), "error"));
  };
  return (
    <>
      <ContextMenuItem onSelect={() => copyToClipboard(rel, "relative path")}>
        <CornerUpLeft /> Copy path (relative)
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => copyToClipboard(abs, "path")}>
        <Copy /> Copy path (absolute)
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={revealInFileManager}>
        <FolderOpen /> {isDir ? `Open in ${FILE_MANAGER}` : `Show in ${FILE_MANAGER}`}
      </ContextMenuItem>
    </>
  );
}
