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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/ContextMenu";
import { copyToClipboard } from "@/lib/clipboard";
import { editorSelectionLines } from "@/lib/editorSelection";
import { fileWebLinks, openPath, revealPath, type FileWebLinks } from "@/lib/ipc";
import { absUnder } from "@/lib/osPath";
import { FILE_MANAGER, openInDefaultApp } from "@/lib/openExternal";
import { useUI } from "@/store/ui";
import { Copy, CornerUpLeft, ExternalLink, FolderOpen, Globe, Link } from "lucide-react";

/** The file on its forge (GH #467): open or copy its link on the current
 *  branch and on the default branch, and with `lines` a permalink pinned to
 *  the commit. Asked for when the menu opens (local git reads, no network);
 *  nothing shows outside a GitHub, GitLab or Azure DevOps repository. Where
 *  the branch or commit is not on the remote yet, the default branch stands
 *  in, and the label says so. */
export function ForgeLinkItems({ abs, selectionTab }: { abs: string; selectionTab?: string }) {
  const { t } = useTranslation("task");
  const [links, setLinks] = useState<FileWebLinks | null>(null);
  // Mounted when the menu opens, so this is the selection as it is NOW.
  useEffect(() => {
    let live = true;
    fileWebLinks(abs, editorSelectionLines(selectionTab)).then(l => { if (live) setLinks(l); }, () => {});
    return () => { live = false; };
  }, [abs, selectionTab]);
  if (!links || !links.defaultUrl) return null;
  const forge = links.forge;
  const dflt = links.defaultBranch ?? "";
  const open = (url: string) => void openUrl(url).catch((e: unknown) => useUI.getState().pushToast(String(e), "error"));
  const branchUrl = links.branchUrl ?? links.defaultUrl;
  const branchLabel = links.branchUrl ? null : links.branch ? t("forgeLinks.notPushed") : null;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="forge-links">
          <Globe /> {forge}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem data-testid="forge-open-branch" onSelect={() => open(branchUrl)}>
            <ExternalLink /> {branchLabel ? t("forgeLinks.openOnBranchFallback", { branch: dflt, why: branchLabel }) : t("forgeLinks.openOn", { forge })}
          </ContextMenuItem>
          <ContextMenuItem data-testid="forge-copy-branch" onSelect={() => copyToClipboard(branchUrl, "link")}>
            <Link /> {branchLabel ? t("forgeLinks.copyBranchFallback", { branch: dflt, why: branchLabel }) : t("forgeLinks.copyLink", { forge })}
          </ContextMenuItem>
          {links.branchUrl && links.branch !== links.defaultBranch && (
            <>
              <ContextMenuItem data-testid="forge-open-default" onSelect={() => open(links.defaultUrl!)}>
                <ExternalLink /> {t("forgeLinks.openOnBranch", { branch: dflt })}
              </ContextMenuItem>
              <ContextMenuItem data-testid="forge-copy-default" onSelect={() => copyToClipboard(links.defaultUrl!, "link")}>
                <Link /> {t("forgeLinks.copyBranchLink", { branch: dflt })}
              </ContextMenuItem>
            </>
          )}
          {links.permalinkUrl && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem data-testid="forge-open-permalink" onSelect={() => open(links.permalinkUrl!)}>
                <ExternalLink /> {links.commitPushed ? t("forgeLinks.openPermalink") : t("forgeLinks.openOnBranchFallback", { branch: dflt, why: t("forgeLinks.commitNotPushed") })}
              </ContextMenuItem>
              <ContextMenuItem data-testid="forge-copy-permalink" onSelect={() => copyToClipboard(links.permalinkUrl!, "link")}>
                <Link /> {links.commitPushed ? t("forgeLinks.copyPermalink") : t("forgeLinks.copyBranchFallback", { branch: dflt, why: t("forgeLinks.commitNotPushed") })}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/** `selectionTab`: the editor tab whose selected lines a permalink takes. */
export function CopyPathItems({ rel, root, isDir = false, selectionTab }: { rel: string; root: string; isDir?: boolean; selectionTab?: string }) {
  const { t } = useTranslation("task");
  const abs = absUnder(root, rel);
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
      {!isDir && <ForgeLinkItems abs={abs} selectionTab={selectionTab} />}
    </>
  );
}
