// Pure path helpers for resolving relative image/link targets in the
// markdown preview. Kept DOM- and Tauri-free so they're unit-testable.
//
// Resolution happens frontend-side because the Rust containment check
// (`safe_workspace_path`) rejects any literal `..` segment: `../assets/a.png`
// referenced from `docs/readme.md` must arrive at the IPC boundary already
// collapsed to `assets/a.png`.

/** Extensions WorkspaceView routes to MarkdownPane (rendered preview) rather
 *  than the plain EditorPane. Shared so a `file.md#heading` link only ever
 *  attaches `revealHeading` to a tab that can actually consume it — a
 *  fragment aimed at a non-markdown target would otherwise sit unconsumed
 *  on an EditorPane tab forever. */
export const MARKDOWN_EXT_RE = /\.(md|markdown|mdx)$/i;

/** Directory part of a workspace-relative posix path ("" for root files). */
export function dirnamePosix(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Resolve a markdown href/src against the containing file's directory.
 *  A single leading `/` means "from the workspace root" (GitHub README
 *  convention: `![logo](/docs/logo.png)`); the backend containment checks
 *  still apply to the result. Returns a normalized workspace-relative path,
 *  or null when the target is not a workspace file: URL schemes (https:,
 *  mailto:, ...), protocol-relative `//host`, or paths whose `..` escape the
 *  workspace root. Strips `?query` and `#fragment`; decodes percent-encoding
 *  (markdown-it normalizes link destinations to encoded form).
 *
 *  `memberDirs` are a multi-repo workspace's member `dir_name`s (workspace
 *  paths inside a member look like `<dir_name>/rest`, matching the scheme
 *  `resolve_workspace_git_path` expects backend-side). When `baseDir` falls
 *  inside one of them, both the root-relative "/" and the `..` floor are
 *  scoped to THAT member's root, not the wrapper root: a member is its own
 *  repo, so `/logo.png` in a member's README means "this repo's root", and
 *  `..` can't hop out into a sibling member or the wrapper. */
export function resolveWorkspaceHref(baseDir: string, href: string, memberDirs: readonly string[] = []): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // any scheme (https:, mailto:, file:, ...)
  if (href.startsWith("//")) return null; // protocol-relative URL
  const stripped = href.split(/[?#]/, 1)[0];
  if (!stripped) return null; // pure #fragment / ?query
  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    return null; // malformed percent-encoding
  }
  const memberDir = memberDirs.find(d => baseDir === d || baseDir.startsWith(`${d}/`));
  const floor = memberDir ? 1 : 0; // can't pop the member's own root segment away
  // Root-relative resolves from the containing member's root (or the
  // workspace root outside any member), not the file's own dir. The leading
  // "/" itself is skipped as an empty segment below.
  const parts: string[] = decoded.startsWith("/")
    ? (memberDir ? [memberDir] : [])
    : (baseDir ? baseDir.split("/") : []);
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length <= floor) return null; // escapes the member/workspace root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length ? parts.join("/") : null;
}

/** GitHub-style heading slug for `#anchor` matching: lowercase, collapse
 *  whitespace runs to a single dash, then drop everything but Unicode
 *  letters/numbers/dash/underscore. Deliberately NOT the same as utils.ts
 *  `slugify` (which also collapses punctuation runs to a single dash):
 *  anchors copied from GitHub keep the double dash a removed punctuation
 *  char leaves behind, e.g. "Step 04 — x" slugs to "step-04--x" (the
 *  em-dash sits between two independently-collapsed whitespace runs, so it
 *  disappears without merging them). Unicode-aware so non-ASCII headings
 *  (e.g. "café") keep their letters instead of being stripped to "caf". */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "");
}
