// What a server is CALLED, and what it costs, in one place.
//
// Shared by the chip on the path bar and by CodeIntelActions, which is the
// popover both the chip and Search Everywhere open. The memory figure is the
// point of consent, so it cannot live in only one of the two surfaces that
// ask for it: a person who turned this on from the search dialog agreed to
// exactly the same thing as one who used the chip.

import { i18n } from "@/lib/i18n";

/** The server a language means when nothing has been RESOLVED yet: the one
 *  termic would download, or, for the PATH-only ones, the one it would look
 *  for. A fallback only: when the machine has something, the name comes off
 *  the resolved executable instead (see `serverFor`).
 *
 *  Every servable language needs a row. A missing one reaches the UI as its
 *  own id, so the chip reads "cpp" instead of "clangd" and the memory note,
 *  which is keyed by server name, comes back empty next to a button that
 *  starts a process. */
const WOULD_INSTALL: Record<string, string> = {
  typescript: "TypeScript 7 (tsgo)",
  python: "ty",
  rust: "rust-analyzer",
  go: "gopls",
  cpp: "clangd",
  swift: "sourcekit-lsp",
  ruby: "ruby-lsp",
  terraform: "terraform-ls",
};

/** Every language termic can serve, with the name a settings page shows.
 *
 *  ONE list, because two drifted: the per-project language checkboxes
 *  enumerated four of these, so unticking Go there wrote a list of the three
 *  remaining UI ids and silently took C++, Swift and Ruby with it. Anything
 *  offering a per-language choice reads this, and `serverNames.test.ts` pins
 *  it against `WOULD_INSTALL`, which is the real set. */
export const SERVABLE_LANGUAGES: readonly { id: string; label: string }[] = [
  { id: "typescript", label: "TypeScript / JavaScript" },
  { id: "python",     label: "Python" },
  { id: "rust",       label: "Rust" },
  { id: "go",         label: "Go" },
  { id: "cpp",        label: "C / C++ / Objective-C" },
  { id: "swift",      label: "Swift" },
  { id: "ruby",       label: "Ruby" },
  { id: "terraform",  label: "Terraform" },
];

/** The ids alone, for callers that only need membership. */
export const SERVABLE_LANGUAGE_IDS: readonly string[] =
  SERVABLE_LANGUAGES.map(l => l.id);

/** Test-only view of the set every servable language must be listed in. */
export const WOULD_INSTALL_IDS: readonly string[] = Object.keys(WOULD_INSTALL);

/** Binaries whose file name is not what a person calls them. */
const PRETTY_EXE: Record<string, string> = {
  // The versioned names Linux distributions install clangd under. Without
  // these a Debian user's chip reads "clangd-18", which is a file name.
  ...Object.fromEntries(
    ["14", "15", "16", "17", "18", "19", "20", "21"].map(v => [`clangd-${v}`, "clangd"]),
  ),
  tsgo: "TypeScript 7 (tsgo)",
  "basedpyright-langserver": "basedpyright",
  "pyright-langserver": "pyright",
  "typescript-language-server": "typescript-language-server",
};

/**
 * The name of the process that will actually run for this checkout.
 *
 * Keyed by LANGUAGE this was wrong on any machine that has more than one
 * server for it, which is the normal case for Python: resolution goes zuban →
 * ty → basedpyright, so a tooltip reading "ty" sat above a chip that was
 * about to start zuban, and the memory figure underneath it belonged to a
 * third process. The resolved path is the only thing that knows.
 */
export function serverFor(exe: string | null, language: string): string {
  const base = exe?.split("/").pop() ?? "";
  if (!base) return WOULD_INSTALL[language] ?? language;
  return PRETTY_EXE[base] ?? base;
}

/** Measured typical / worst case per checkout, keyed by the server that will
 *  run rather than by its language, for the same reason. Numbers from
 *  docs/plans/lsp.md, plus zuban measured on a real Django project (86 MB
 *  after answering a workspace symbol search and 59 diagnostics). The toggle
 *  quotes these rather than a generic warning, because a user cannot consent
 *  to a cost nobody showed them. */
export const MEMORY_NOTE: Record<string, string> = {
  "TypeScript 7 (tsgo)": "TypeScript pays at load: about 300 MB for a repo this size, and queries after that are free.",
  "typescript-language-server": "TypeScript pays at load: about 300 MB for a repo this size, and queries after that are free.",
  zuban: "zuban holds about 85 MB on a project this size, and keeps it for as long as it runs.",
  ty: "ty holds about 50 MB idle, and around 250 MB once it has answered a find-usages. It never gives that back.",
  basedpyright: "basedpyright holds a few hundred MB once it has read the project, and keeps it while it runs.",
  "rust-analyzer": "rust-analyzer indexes the whole crate graph: about 3 GB on a repo the size of this one, held for as long as it runs.",
  gopls: "gopls holds about 1 GB after opening a file, and up to 7 GB on a large repo. It never gives that back.",
  // The disk half is disclosed for the same reason the memory half is: it
  // appears inside the checkout, where a `git add -A` can find it.
  clangd: "clangd holds a few hundred MB for a project this size, and writes its index to .cache/clangd inside the checkout (worth a line in .gitignore).",
  "sourcekit-lsp": "sourcekit-lsp holds a few hundred MB, and answers best about a package that has been built at least once.",
  "ruby-lsp": "ruby-lsp holds around 200 MB, and writes a .ruby-lsp directory inside the checkout for its own bundle.",
  "terraform-ls": "terraform-ls used about 30 MB on a small Terraform fixture. Memory depends on the project and its provider schemas.",
};


/** The same figure, short enough to sit on a line of a list row.
 *
 *  A surface that shows this does not also need the modal: the modal exists to
 *  put the number in front of somebody before they agree to it, and a number
 *  they can already read is not made more honest by a dialog repeating it.
 *  Same measurements as `MEMORY_NOTE`, same keys, deliberately worst-case. */
export const MEMORY_SHORT: Record<string, string> = {
  "TypeScript 7 (tsgo)": "about 300 MB",
  "typescript-language-server": "about 300 MB",
  zuban: "about 85 MB",
  ty: "50 MB idle, about 250 MB after a find-usages",
  basedpyright: "a few hundred MB",
  "rust-analyzer": "about 3 GB on a repo this size",
  gopls: "about 1 GB, more on a large repo",
  clangd: "a few hundred MB, plus an index in .cache/clangd",
  "sourcekit-lsp": "a few hundred MB",
  "ruby-lsp": "about 200 MB",
  "terraform-ls": "about 30 MB on a small project",
};

// Localized views of the two tables above. The English records stay as the
// fallback for a server the locales do not know (a PATH binary whose name
// nobody measured); a known name resolves through backend:lsp so a language
// switch applies to the next tooltip/dialog without a reload.

const MEMORY_KEYS: Record<string, string> = {
  "TypeScript 7 (tsgo)": "memoryTsgo",
  "typescript-language-server": "memoryTypescript",
  zuban: "memoryZuban",
  ty: "memoryTy",
  basedpyright: "memoryBasedpyright",
  "rust-analyzer": "memoryRustAnalyzer",
  gopls: "memoryGopls",
  clangd: "memoryClangd",
  "sourcekit-lsp": "memorySourcekit",
  "ruby-lsp": "memoryRubyLsp",
  "terraform-ls": "memoryTerraformLs",
};

const MEMORY_SHORT_KEYS: Record<string, string> = {
  "TypeScript 7 (tsgo)": "memoryShortTsgo",
  "typescript-language-server": "memoryShortTypescript",
  zuban: "memoryShortZuban",
  ty: "memoryShortTy",
  basedpyright: "memoryShortBasedpyright",
  "rust-analyzer": "memoryShortRustAnalyzer",
  gopls: "memoryShortGopls",
  clangd: "memoryShortClangd",
  "sourcekit-lsp": "memoryShortSourcekit",
  "ruby-lsp": "memoryShortRubyLsp",
  "terraform-ls": "memoryShortTerraformLs",
};

/** The memory note for `server`, localized. Empty for an unknown server. */
export function memoryNote(server: string): string {
  const key = MEMORY_KEYS[server];
  return (key ? i18n.t(`backend:lsp.${key}`) : MEMORY_NOTE[server]) ?? "";
}

/** The one-line figure for `server`, localized. Empty for an unknown server. */
export function memoryShort(server: string): string {
  const key = MEMORY_SHORT_KEYS[server];
  return (key ? i18n.t(`backend:lsp.${key}`) : MEMORY_SHORT[server]) ?? "";
}
