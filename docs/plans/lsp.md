# Language servers (design + findings)

Status: proposed, not started. Opt-in, off by default.

Code navigation via LSP: go-to-definition, find usages, hover types, completion,
rename. Written up so the decisions (and the traps) survive the investigation
that produced them. Every number below was measured on a real repo, not quoted.

Goal: enough navigation to replace PyCharm.

Non-goal: becoming an IDE. Off by default, one process per language per task
at most, nothing bundled in the `.app`, nothing running until the user opts in.

## Why this is cheaper than it looks

Three pieces already exist:

- **`lintGutter()` is already mounted** (`EditorPane.tsx:240`) with no diagnostic
  source feeding it. It renders an empty gutter today. LSP diagnostics drop in.
- **Go-to-definition's landing half is already built.** `openPreviewTab(taskId,
  { type: "edit", path, revealAt: { line, col } })` (`store/app.ts:1794`) opens a
  file, jumps, centers, focuses. Find-in-Files drives it (`FindInFilesDialog.tsx:249`).
  An LSP definition response is the same call with different coordinates.
- **Compartments are the idiom** (`langCompRef`, `themeCompRef`). An `lspCompRef`
  toggles the feature live without rebuilding the `EditorView` (a rebuild re-reads
  disk and destroys undo history).

On the Rust side, `task_run_script_stream` (`lib.rs:6469`) already spawns a child
with piped stdio in its own process group and streams output to the webview. An
LSP host changes three things: keep `child.stdin` in managed state, swap
`BufReader::lines()` for a `Content-Length` framer, emit per-message.

## Measured data

Everything below was measured, not quoted. Blog-post figures for these servers
(300 MB to 4 GB) were wrong for our case by a wide margin.

### Python shootout

Repo: a real Django app. 982 MB total, of which a **938 MB `.venv`**; 58k lines
first-party; Django 5.0.9; Python 3.13. Symbol under test: a model class used
**309 times across 60 files** (three independent servers agree on that count).

| Server | Init | RSS idle | RSS after find-refs | Refs found | def → site-packages |
|---|---|---|---|---|---|
| **zuban 0.9.0** | 13 ms | 55 MB | **150 MB** | **309 / 60** ✓ | yes |
| **ty 0.0.59** | 10 ms | 51 MB | 246 MB | 251 / 59 ✗ | yes |
| basedpyright 1.39.9 | 172 ms | 415 MB | 451 MB | 310 / 60 ✓ | yes |
| pyrefly 1.1.1 | 25 ms | 472 MB | 477 MB | 309 / 60 ✓ | yes |
| pylsp 1.14.0 | 106 ms | 35 MB | 95 MB | 97 / 24 ✗✗ | **MISS** |
| jedi-ls 0.47.0 | 233 ms | 55 MB | 118 MB | 121 / 24 ✗✗ | **MISS** |

- `ruff server` adds **22 MB** and has **no navigation at all** (lint, format and
  code actions only; its hover only explains `noqa` codes). It is a second server,
  never the primary. This is widely misunderstood.
- **pylsp and jedi are disqualified**: neither resolves into `site-packages`.
- **ty missed a whole file** that contains a direct `from products.models import
  Product`. Its find-references is incomplete (251 vs the 309 consensus).

### Cost model

The important shape: **memory is driven by find-references, not by having a
server open.**

| Phase | RSS (ty) |
|---|---|
| Boot + open a file | 49 MB |
| After first find-references | 250 MB |
| After a 20-keystroke burst | 250 MB (typing is free) |
| After 20 s idle | 250 MB (**never released**) |

Browsing with hover and ⌘-click costs ~50 MB per task. The 250 MB is the
workspace index, built on demand the first time the user asks for usages, and
never given back. Two full-featured tasks (repo root + one worktree) measured
**508 MB combined**.

Since idle never reclaims, **killing the process is the only way to get the
memory back**. That is what makes the lifecycle policy below load-bearing rather
than decorative.

### TypeScript 7 (verified end to end)

TS 7.0 GA'd 2026-07-08 as a **native Go binary**. `tsserver.js` is gone from the
package. Verified on this machine: 9.27 MB download, SHA-256 matching GitHub's
release-API `digest`, `Mach-O 64-bit executable arm64`, **no
`com.apple.quarantine`**, runs as `Version 7.0.2`. Driven against termic's own
source: 13 ms init, 296 MB settled, correct semantic find-references.

Full TS/TSX navigation with **zero Node runtime**. This alone probably justifies
the subsystem.

## Architecture

```
CodeMirror  ──  @codemirror/lsp-client  ──  Transport  ──  Tauri Channel
                                                                │
                                                        Rust LSP host
                                                    (framing, lifecycle,
                                                     server→client replies)
                                                                │
                                                       child process (stdio)
```

**Frontend:** `@codemirror/lsp-client` (official, MIT, 6.2.5). Its transport is
three methods over raw JSON strings:

```ts
type Transport = {
  send(message: string): void
  subscribe(handler: (value: string) => void): void
  unsubscribe(handler: (value: string) => void): void
}
```

Docs: *"Messages should contain only the JSON messages, no LSP headers."* So
framing is Rust's problem and the adapter is ~30 lines. It is also the only CM6
client that implements `textDocument/references`; the community forks (Furqan,
marimo) do not, and find-usages is the whole point.

**Bridge:** a Tauri **`Channel`**, not `emit`/`listen`. Tauri's docs state event
listeners "may process events out of order if a listener is async". Out-of-order
delivery corrupts JSON-RPC.

**Backend:** `tokio::process` + hand-rolled `Content-Length` framing, ~200 lines,
which is what Helix, Lapce and Zed all do. Types from `gen-lsp-types` (0.10);
`lsp-types` has not shipped since June 2024 and rust-analyzer migrated off it in
June 2026. `tower-lsp` is for *writing* servers; not applicable.

No WebSocket, no localhost port, no daemon, **no CSP change** (all three are
forbidden by CLAUDE.md, and none is needed).

## Three hard requirements

Each of these silently breaks the feature. All three were found by measurement,
not by reading docs.

### 1. The Rust host must answer server→client requests

It cannot be a dumb pipe. It must intercept and answer `workspace/configuration`
(reply `[null]`, one per requested item), `window/workDoneProgress/create` and
`client/registerCapability`.

**`@codemirror/lsp-client` replies `-32601 MethodNotFound` to every
server-initiated request.** ty defers *every* incoming request until its
workspaces initialize; it recovers from a `null` config response but an *error*
response wedges it permanently, with no timeout and no fallback (verified in
`session.rs` in astral-sh/ruff). Observed failure: **every request times out and
the server sits idle doing nothing.**

The same client bug degraded pyrefly differently and more dangerously: it
returned **9 references instead of 309**, instantly and confidently. Silently
wrong is worse than broken.

Alternative fix: do not advertise `workspace.configuration` at all, and ty falls
back to `initializationOptions`.

### 2. Declare pull-diagnostics capability

TypeScript 7 implements **`textDocument/diagnostic`** (pull) only. Push
(`publishDiagnostics`) fires for config-file errors and nothing else; the PR to
add per-file push is still unmerged. A client that declares only push capability
gets **zero squiggles**.

### 3. Always set an explicit workspace root

Open a loose file with no root and ty indexes `$HOME` (upstream bug ty#2769).

Also handle `-32801 ContentModified` and retry: ty can drop an in-flight
references response if a `didOpen` races it (ty#3061).

## Server registry: declarative manifests

Helix's format, not Zed's WASM.

A Zed language-server extension compiles a WASM module whose entire job is to
implement one function returning `{command, args, env}`. Measured cost of hosting
wasmtime: **+12.6 MB per architecture**, +171 crates, ~2x cold build. termic ships
a **15 MB universal .dmg** and links twice. That roughly doubles the app to run a
function that returns a command string.

It is also moot: our CSP is `script-src 'self'`. WASM in the webview needs
`wasm-unsafe-eval`; loading a third-party `@codemirror/lang-*` needs a wider
`script-src`. CLAUDE.md forbids widening the CSP. **So a webview-side extension
system is off the table by policy**, syntax highlighting stays compiled in, and
the only thing an extension can usefully carry is LSP wiring, which lives in Rust,
where a manifest is sufficient.

Sketch, compiled in, extensible via `~/.config/termic/languages/*.toml` (mirroring
the existing `~/.config/termic/themes/*.json` convention, so no new concepts):

```toml
id         = "python"
file-types = ["py", "pyi"]
roots      = ["pyproject.toml", "setup.py", ".git"]

[server]
command = "ty"
args    = ["server"]

[server.install]              # omit => PATH-only (Helix behaviour)
source = "github:astral-sh/ty"
version = "0.0.59"            # pinned
asset   = { darwin_arm64 = { file = "ty-aarch64-apple-darwin.tar.gz", sha256 = "..." } }
```

Adding rust-analyzer or gopls later is a data change, not a code change. Swapping
ty for zuban is one line.

### Resolution order

1. User override in Settings.
2. **Worktree-local** bins (`.venv/bin`, `node_modules/.bin`). Per-worktree, so a
   project's own toolchain wins. This is the step that makes it "just work" for
   users who already have one.
3. `PATH` (via `shell_env::resolved_path()` — a GUI-launched `.app` gets a bare
   PATH from launchd, so a server on `PATH` is invisible without it; see the
   comment at `lib.rs:1399`).
4. termic's own server dir (`~/Library/Application Support/termic/servers/<id>/`).
5. Otherwise prompt once: *"Python smart features need ty (18 MB). Download."*

Never install onto the user's `PATH`. Everything lands in a termic-owned directory
that can be deleted wholesale.

**Pin the version and the SHA-256 in the compiled-in manifest.** We are downloading
a binary and executing it against the user's source. Pinning turns "trust GitHub at
runtime" into "trust the termic release you already installed". Cheap now, expensive
to retrofit. Note most projects publish no `SHA256SUMS`; GitHub's release-API
per-asset `digest` field is the reliable source. Do not resolve `latest` at runtime.

## Lifecycle

Servers are **per (task, language)**. They cannot be shared across tasks: each task
is a git worktree, so the files are at different paths *with different content*.
A shared server would send go-to-definition into the wrong worktree's copy. That is
a correctness bug, not a tuning knob.

LSP's `workspaceFolders` (one server, many roots) saves only the process baseline,
not the index, and couples task lifetimes and crashes. Not worth it.

Memory is therefore controlled by lifecycle:

- **Lazy spawn.** Only when an editor tab of that language is open in that task.
  This fits termic unusually well: most of the time a task is open, the user is
  watching an agent in a terminal, not editing. The agent does not need the server.
  Six open tasks with no editor tabs cost zero.
- **Idle reap.** When the last editor tab of that language closes, shut down after
  a few minutes' grace. Tab bounces do not pay the restart; walking away frees the
  memory.
- **LRU cap.** Ceiling of ~3 live servers, evict least-recently-used. Reopening
  costs a re-index (seconds).
- **Register in `cleanup_children`** (`lib.rs:8373`, wired to `RunEvent::Exit`).
  Forget this and rust-analyzer survives app quit and eats a core.

Steady state is 1-2 servers, because a human edits in one task at a time. Worst
case under the cap is ~800 MB.

## Document model (prerequisite work)

There is **no document registry today**. Every editor tab creates a fresh
`EditorView` from a fresh disk read. Nothing tracks "what is open", no version
counter, nothing for `didOpen`/`didChange`/`didClose` to sync against.

The trap: **`openPreviewTab` recycles a preview tab in place** (`store/app.ts:1889`),
mutating the tab's `path` **without ever firing a close**. A naive tab-diff leaks
`didOpen`s and desyncs the server model, which produces wrong results rather than
errors.

Needed before any LSP code:

- A `(taskId, path) -> { version, languageId }` registry, driven by
  `openPreviewTab` / `closeTab` / the mount effect.
- Forward the `ExternalReload` path too (`EditorPane.tsx:299`): a disk-change
  reload is a full-document `didChange`.
- Debounce `didChange`. It fires per keystroke.
- Extract `revealLine` (`EditorPane.tsx:112`, currently module-private) into a
  shared `gotoLocation()` so LSP jumps and Find-in-Files use one path.

## External files (the PyCharm-defining gap)

Today **every tab path is task-relative**, and `safe_task_path` (`lib.rs:5006`)
*rejects anything that escapes the worktree*, by design.

But ⌘-clicking `requests.get` must land in `site-packages/requests/api.py`. There
is currently **no tab type that can hold that file**.

Needs a read-only external-file tab: absolute path, no save, no dirty dot, not in
the file tree, plus an explicit read-only bypass of the containment check.

Phases 1-2 give nice navigation. **This phase is what makes it a PyCharm
replacement.** It is not optional for the stated goal.

## Security

- **Sanitize hover/completion HTML.** Servers return Markdown that gets rendered to
  HTML in the webview: an XSS channel from a process that reads the repo (including
  docstrings an agent just wrote). `@codemirror/lsp-client` exposes a `sanitizeHTML`
  hook; it must be set. `dompurify` is already a direct dep and `MarkdownPreview.tsx`
  already gates untrusted markdown. Same threat model as the remote-image gate (#69).
- **Do not sandbox the servers.** Consistent with the existing model: only the agent
  CLI PTY is in the threat model (see [sandbox.md](../sandbox.md)). A language server is
  the user's own toolchain, not the agent's. Deliberate, and worth stating.
- **Content-Length is bytes, not characters.** The classic hand-rolled-framer bug;
  it bites on the first non-ASCII docstring.

## Recommended default set

| Language | Server | Download | Runtime |
|---|---|---|---|
| TypeScript / TSX | TypeScript 7 native | 9.3 MB | none |
| Python | ty (nav) + ruff (lint) | ~50 MB | none |
| Rust | rust-analyzer | 13.9 MB | none |
| Go | gopls | `go install` | Go (already present) |

~73 MB of optional on-demand downloads, every one a single static binary, covering
the languages termic users actually write. Nothing ships in the `.app`.

**Skip:** JSON, Markdown, HTML/CSS (CodeMirror already wins in-process, no
subprocess), bash, and clangd (93 MB universal binary that also needs
`compile_commands.json`).

### Python server choice, honestly

- **ty** is the default: single MIT binary, lightest of the full-featured servers,
  workspace-wide find-references correct **by default** (pyright and basedpyright
  default to `diagnosticMode: openFilesOnly`; pyrefly has an undocumented 2000-file
  index cap). But it is **0.0.x**, it missed a real reference in our measurement,
  and it scores 71.6% on the typing-conformance suite with reports of ~80% false
  positives on real code. **Use ty for navigation and ruff for diagnostics. Do not
  surface ty's type errors.** Note also Astral is being acquired by OpenAI (ty stays
  MIT).
- **zuban** is the one to watch: **150 MB** (a third of the alternatives), all 309
  refs, best completions, **99.3% conformance (highest of anything tested)**, by the
  author of Jedi. It is AGPL-3.0-only, which is a **non-issue**: termic is
  AGPL-3.0-or-later, and spawning a binary over a stdio pipe is mere aggregation
  regardless. The blocker is maturity (rename has broken stdlib code in third-party
  testing), not law.
- **pyrefly** is not the default despite Meta backing and PyCharm shipping it: in
  PyCharm it is **opt-in and type-only, and JetBrains kept their own engine for
  find-usages, goto-def and rename.** It was also the heaviest thing measured.
- **basedpyright** is the safe fallback (MIT, mature, correct) but drags a Node
  runtime and 451 MB.

## Phasing

| Phase | Work | Ships |
|---|---|---|
| 0 | Document registry; extract `gotoLocation()` | nothing visible; unblocks all |
| 1 | Rust LSP host + Channel transport + one server, default-OFF pref | hover, diagnostics, goto-def |
| 2 | Find-references panel, completion, signature help, rename | the PyCharm core |
| 3 | Read-only external-file tabs | ⌘-click into site-packages |
| 4 | Declarative manifests + Settings section | rust-analyzer, gopls, TS7 for free |
| 5 | `[server.install]` download with pinned checksums | works without a toolchain |

Value is concentrated in 0-2. Phase 3 is the difference between "nicer editor" and
"PyCharm replacement".

## Opt-in

A per-**project** toggle (not per-task; re-enabling per task is a paper cut). With
it off, nothing spawns, nothing is imported, and the editor is byte-for-byte what
it is today. Default OFF, following the existing `loadRemoteImages` pattern
(`prefs.ts`).

Discovery should not depend on browsing Settings: prompt contextually in the editor
the first time it would help.

## Open questions

- ty vs zuban as the Python default. Both are single Rust binaries speaking the same
  protocol, so the manifest makes it a one-line swap. Decide by running both against
  real repos, not on paper.
- Whether a Tauri/`reqwest` download path stamps `com.apple.quarantine` (a `curl`
  download does not; verified). If it does, strip it after hash verification, as
  Homebrew and pnpm do. **Check empirically before designing around it.**
- Whether to bundle any server. Current answer: no. Bundling ~4 servers universal is
  roughly +100 MB on a 15 MB app, and walks into Tauri's macOS sidecar signing bug
  (tauri#11992).
