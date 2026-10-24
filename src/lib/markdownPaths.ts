// Pure path helpers for resolving relative image/link targets in the
// markdown preview. Kept DOM- and Tauri-free so they're unit-testable.
//
// Resolution happens frontend-side because the Rust containment check
// (`safe_task_path`) rejects any literal `..` segment: `../assets/a.png`
// referenced from `docs/readme.md` must arrive at the IPC boundary already
// collapsed to `assets/a.png`.

/** Extensions TaskView routes to MarkdownPane (rendered preview) rather
 *  than the plain EditorPane. Shared so a `file.md#heading` link only ever
 *  attaches `revealHeading` to a tab that can actually consume it — a
 *  fragment aimed at a non-markdown target would otherwise sit unconsumed
 *  on an EditorPane tab forever. */
export const MARKDOWN_EXT_RE = /\.(md|markdown|mdx)$/i;

/** Directory part of a task-relative posix path ("" for root files). */
export function dirnamePosix(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Resolve a markdown href/src against the containing file's directory.
 *  A single leading `/` means "from the task root" (GitHub README
 *  convention: `![logo](/docs/logo.png)`); the backend containment checks
 *  still apply to the result. Returns a normalized task-relative path,
 *  or null when the target is not a task file: URL schemes (https:,
 *  mailto:, ...), protocol-relative `//host`, or paths whose `..` escape the
 *  task root. Strips `?query` and `#fragment`; decodes percent-encoding
 *  (markdown-it normalizes link destinations to encoded form).
 *
 *  `memberDirs` are a multi-repo task's member `dir_name`s (task
 *  paths inside a member look like `<dir_name>/rest`, matching the scheme
 *  `resolve_task_git_path` expects backend-side). When `baseDir` falls
 *  inside one of them, both the root-relative "/" and the `..` floor are
 *  scoped to THAT member's root, not the wrapper root: a member is its own
 *  repo, so `/logo.png` in a member's README means "this repo's root", and
 *  `..` can't hop out into a sibling member or the wrapper. */
export function resolveTaskHref(baseDir: string, href: string, memberDirs: readonly string[] = []): string | null {
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
  // task root outside any member), not the file's own dir. The leading
  // "/" itself is skipped as an empty segment below.
  const parts: string[] = decoded.startsWith("/")
    ? (memberDir ? [memberDir] : [])
    : (baseDir ? baseDir.split("/") : []);
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length <= floor) return null; // escapes the member/task root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length ? parts.join("/") : null;
}

/** Resolve a markdown href against a file OUTSIDE every task root (an
 *  external tab, opened from an absolute path). Returns a normalized ABSOLUTE
 *  path, or null for a URL scheme, a protocol-relative URL, or a bare
 *  fragment. A leading `/` is a filesystem-absolute path here: there is no
 *  repo root to be relative to. `..` stops at `/` rather than failing, like a
 *  shell. Strips `?query` / `#fragment` and decodes percent-encoding. */
export function resolveExternalHref(filePath: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.startsWith("//")) return null;
  const stripped = href.split(/[?#]/, 1)[0];
  if (!stripped) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    return null;
  }
  // A Windows file (`C:\notes\a.md`): resolve with either separator and
  // answer in the file's own spelling, drive first, so the tab it opens is
  // the same path the file tree and the backend use. A leading slash is the
  // drive's root.
  const drive = /^[A-Za-z]:[\\/]/.test(filePath) ? filePath.slice(0, 2) : "";
  const sep = drive ? /[\\/]/ : "/";
  const base = drive ? filePath.slice(2).replace(/\\/g, "/") : filePath;
  const rooted = drive ? /^[\\/]/.test(decoded) : decoded.startsWith("/");
  const parts: string[] = rooted ? [] : dirnamePosix(base).split("/");
  for (const seg of decoded.split(sep)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const kept = parts.filter(Boolean);
  return drive ? `${drive}\\${kept.join("\\")}` : "/" + kept.join("/");
}

/** GitHub-style heading slug for `#anchor` matching: lowercase, collapse
 *  whitespace runs to a single dash, then drop everything but Unicode
 *  letters/numbers/dash/underscore.
 *
 *  **This one KEEPS a double dash, and must.** utils.ts `slugify` collapses
 *  every run of dashes to one, because a slug there becomes a branch name;
 *  the two rules are opposite on purpose and unifying them would break every
 *  anchor of this shape. "Step 04 — x" slugs to "step-04--x" here: the
 *  em-dash sits between two independently-collapsed whitespace runs, so
 *  removing it leaves both dashes behind, and that is the anchor GitHub
 *  itself generates and that people copy out of its UI. A link that does not
 *  match is a link that does not scroll.
 *
 *  Unicode-aware so non-ASCII headings (e.g. "café") keep their letters
 *  instead of being stripped to "caf". */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "");
}

/** Slugs for a document's headings in order, with GitHub's duplicate
 *  disambiguation. Tracks the set of slugs already assigned (not a per-base
 *  occurrence counter): a literal heading "Usage 1" claims "usage-1" for
 *  itself, so a LATER duplicate "Usage" must skip past it to "usage-2"
 *  rather than colliding on "usage-1" too. Call once per heading, in
 *  document order. */
export function headingSlugger(): (text: string) => string {
  const used = new Set<string>();
  // resume each base's probe where it last stopped: every suffix below it is
  // already in `used` (which only grows), so this is the same answer as
  // probing from 1, without going quadratic on many duplicates.
  const next = new Map<string, number>();
  return (text) => {
    const base = headingSlug(text);
    let slug = base;
    if (used.has(slug)) {
      let n = next.get(base) ?? 1;
      while (used.has(slug = `${base}-${n}`)) n++;
      next.set(base, n + 1);
    }
    used.add(slug);
    return slug;
  };
}
