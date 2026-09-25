// Shared path context-menu items, reused everywhere a file/folder can be
// right-clicked (Git panel, file tree, diff header, editor breadcrumb). Keeps
// the wording + ordering identical across surfaces:
//   - "Open in default app"    → hand the FILE to the OS (GH #147)
//   - Reveal / Open in <file manager> → folders open, files are selected
//   - "Copy path (relative)"   → path relative to the task root
//   - "Copy path (absolute)"   → full on-disk path
//
// The two OS actions lead because they act on the file itself; copying a path
// is the secondary, clipboard-only pair. Mirrors what VS Code, Sublime and
// JetBrains all put at the top of a file-tree context menu.
//
// `rel` is task-relative; `root` is the task's absolute disk path.
// Rendered inside a <ContextMenuContent>, so it emits items only (no wrapper).
// Cross-platform: the file-manager label adapts (Finder on macOS, File Manager
// elsewhere) and the open/reveal IPCs dispatch per-OS on the Rust side.

import { useTranslation } from "react-i18next";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/ContextMenu";
import { copyToClipboard, joinPath } from "@/lib/clipboard";
import { openPath, revealPath } from "@/lib/ipc";
import { FILE_MANAGER, openInDefaultApp } from "@/lib/openExternal";
import { useUI } from "@/store/ui";
import { Copy, CornerUpLeft, ExternalLink, FolderOpen } from "lucide-react";

export function CopyPathItems({ rel, root, isDir = false }: { rel: string; root: string; isDir?: boolean }) {
  const { t } = useTranslation("task");
  const abs = joinPath(root, rel);
  const name = rel.split("/").pop() || rel;
  const revealInFileManager = () => {
    // Folders open (show their contents); files are revealed/selected in
    // their parent. Both resolve per-OS in Rust (open_command / reveal_command).
    (isDir ? openPath(abs) : revealPath(abs))
      .catch((e: unknown) => useUI.getState().pushToast(String(e), "error"));
  };
  return (
    <>
      {/* Files only: `openPath` on a DIRECTORY already means "open it in the
          file manager", so for a folder this would duplicate the entry below. */}
      {!isDir && (
        <ContextMenuItem onSelect={() => void openInDefaultApp(abs, name)}>
          <ExternalLink /> {t("copyPath.openInDefaultApp")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={revealInFileManager}>
        <FolderOpen /> {isDir ? t("copyPath.openInManager", { manager: FILE_MANAGER }) : t("copyPath.revealInManager", { manager: FILE_MANAGER })}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => copyToClipboard(rel, "relative path")}>
        <CornerUpLeft /> {t("copyPath.copyRelative")}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => copyToClipboard(abs, "path")}>
        <Copy /> {t("copyPath.copyAbsolute")}
      </ContextMenuItem>
    </>
  );
}
