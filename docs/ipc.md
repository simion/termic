# IPC

## Tauri commands

- **Tasks**: `task_create` (async, streams setup via `setup-output://<ws_id>` + `setup-done://<ws_id>`), `task_archive`/`task_delete` (async, spawn_blocking), `task_open_repo`, `task_run_script_stream` + `task_stop_script` (PIDs in `RUNNING_SCRIPTS`, child has `process_group(0)` for clean SIGTERM tree-kill).
- **PTYs**: `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill`. Emits `pty://<id>` (`PtyChunk { data: Vec<u8> }`) and `pty-exit://<id>` (`PtyExit { code: Option<i32> }`). `SpawnArgs.role` (`{ task_id, kind: "agent"|"aux", is_default }`) is the CLI attach/logs identity and allocates the 256 KiB output ring; it is deliberately separate from `task_id`, which doubles as the sandbox trigger (the aux shell carries a role but never a task_id).
- **Scripts**: emit `script-output://<wsId>:<kind>` (`{ line }`) + `script-done://<wsId>:<kind>` (`{ code, success }`). `kind` in `setup`/`run`.
- **Settings/discovery**: `settings_load`/`settings_save`/`agents_save`/`discover_repos`/`detect_clis`/`list_monospace_fonts`/`list_font_families` (async + spawn_blocking + OnceLock cache — font-kit is 7s synchronous). `list_font_families` is the unfiltered family list (installed-ness checks); `list_monospace_fonts` is the `is_monospace()` subset (picker extras) — the latter trusts the post-table isFixedPitch bit, so it misses real monospace fonts with sloppy metadata.
- **Files**: `workspace_file_read` (text, 2 MB cap) / `workspace_file_write`, `workspace_file_read_base64` (async + spawn_blocking; images only by extension whitelist, 10 MB cap, takes `known_fp` and returns `{ unchanged, mime?, data?, fp }` for the markdown preview's data: URLs — `unchanged: true` skips the read+encode when `known_fp` still matches, the fast path for agent-settle revalidation storms), `workspace_path_stat` (`{ exists, is_dir }`, tolerates a missing leaf so link-existence checks don't error — also accepts a path that's exactly a composition member's own root, via `resolve_workspace_git_path_ex`). `task_file_fp` is the same resolution with no read at all: it returns just the `mtime:len` fingerprint, so the PDF pane can tell a real rewrite from an agent-settle tick without pulling a 20 MB file through the IPC it doesn't need (the bytes go over the `taskpdf:` scheme). All of them are member-aware (`resolve_workspace_git_path`) and worktree-contained (`safe_workspace_path` for an existing target, `check_workspace_path_existence` when the target may legitimately be missing); both file reads run through `read_capped_file` (TOCTOU-safe: fstat on the open handle, not a separate path stat).
- **Git history** (issue #199, the Graph section of the right panel's Git tab): `task_git_log` (`{ id, dirName, skip, limit, allBranches, refs }` → `GitLogPage { commits, has_more, branch, upstream }`) is one `git log --topo-order` per page; it asks git for `limit + 1` rows and drops the extra, which is how `has_more` is known without a second walk. Commit fields are US (0x1f) separated and RS (0x1e) terminated — a subject can hold anything but a newline, so newline-delimited parsing loses records. `task_git_commit_files` (`{ id, dirName, sha }` → `GitFile[]`) runs `diff-tree -m --first-parent --root` so merges and the initial commit report files instead of nothing. `task_file_diff_sides` takes `scope: "commit:<sha>"` for a historical diff (`sha^` vs `sha`, no working-tree side). Every revision argument goes through `is_commit_ish` (hex only): the graph never passes a user-typed ref, so anything else is a bug or an injection attempt.

  Scope: `allBranches` is `--all` and wins over everything; otherwise `refs` names what to walk (the picker's multi-select) and an empty list means HEAD alone. `refs` is an ALLOWLIST check, not a syntax check: `allowed_refs` keeps only names `git_refs` actually enumerated, so a caller-supplied string can never reach argv as a flag (`--upload-pack=…`) however it is spelled. A scope whose refs have all been deleted returns an empty page rather than falling back to HEAD, which would answer a different question under the old scope's label. `task_git_refs` (`{ id, dirName }` → `GitRef[] { name, sha, kind }`) is what the picker lists and what that allowlist is built from; `origin/HEAD` is dropped because it is an alias for another entry.

- **Push**: `task_git_push` (`{ id, dirName }`) pushes the repo's current branch without committing, for the Push button beside Commit. It shares `git_push` with `task_commit`'s push flag, so the set-upstream fallback (`push -u <remote> <branch>` when a plain push fails on a fresh worktree branch) cannot differ between the two. `GitRepo.ahead` (`rev-list --count @{upstream}..HEAD`, 0 with no upstream) is the button's badge.
- **Branch compare** (issue #208, the Compare mode of the right panel's Git tab): `task_git_compare` (`{ id, dirName, base, mergeBase }` → `GitCompare`) is everything differing between a ref and the WORKING TREE, in one list: `git diff --name-status -M -z` for the glyphs, `--numstat -M -z` for the churn, and `ls-files --others` for untracked paths git's diff cannot see. Both diffs are `-z` because a path may contain any byte but NUL, and a rename's record carries two paths (the destination is the one kept, being the one `git show <sha>:path` resolves). `mergeBase: true` (the default) diffs from `merge-base(base, HEAD)` rather than the ref's tip, so commits the base gained after the branch point do not render inverted as deletions. Unlike the graph, a user-typed refname DOES reach git here, so `base` goes through `resolve_rev` → `is_safe_rev` (no leading dash, no rev syntax, no glob) plus `--end-of-options`, and is resolved to a sha ONCE: everything downstream, `task_file_diff_sides`' `scope: "base:<sha>"` in particular, stays hex-only under `is_commit_ish`. That scope reads the base commit against the live file, which is why Compare keeps the review affordances a historical diff has to drop. The base picker lists `task_git_refs` (above), which already includes remote-tracking refs and tags.
- **Misc**: `notify`, `open_path` (handles URLs via macOS `open`), `home_dir`, `path_exists`, `log_line`.

## `termic://` deep links (GH #192)

A public integration surface: an external system (ticket tracker, internal dashboard, shell alias) drives Termic from a link. Two actions:

```
termic://new?project=web&worktree=1&name=fix-login&p=Fix%20the%20login%20bug
termic://open?project=web&task=fix-login
```

`new` (pre-fills the New Task dialog):

| param | meaning |
| --- | --- |
| `project` | **required.** Registered project, by id or by name (case-insensitive). |
| `name` | task name (max 200 chars) |
| `prompt` / `p` | first message, pre-filled into the dialog (max 8000 chars) |
| `agent` / `cli` | agent id to pre-select; ignored if this install doesn't offer it |
| `mode` | `worktree` or `main`. `worktree=1` is the shorthand. |
| `base` | "Branch from" ref |

`open` (selects an existing task):

| param | meaning |
| --- | --- |
| `task` | **required.** Live task, by id or by name (case-insensitive). Archived tasks don't match. |
| `project` | optional scope. A bare name matching in two projects is *ambiguous*, not a coin flip. |

The rule that separates them, and that any future action must pick a side of:

> **Navigation is immediate, state change is a modal, destruction is not a link.**

`open` only selects something that already exists, so it just happens. **`new` never creates anything** — it fills the form and a human presses Create. That is the whole security model for accepting a `prompt`: links are authored in the ticket tracker, so whoever can file or edit an issue (in many orgs that includes external reporters) controls the text. It is also why an unregistered `project` is a hard error rather than a fallback to "the first project" or a silent project add. Do not add an auto-create or skip-confirmation option.

**Templating gotcha.** A tracker that expands `{{issue.summary}}` without a URL-encode filter truncates silently at the first `&` or `#` — both common in ticket titles — turning `Fix login & signup` into `Fix login `. Raw `+` becomes a space and raw newlines vanish. The confirm step is what catches this: the user sees the mangled text in the textarea instead of an agent acting on half a sentence. Template authors should apply the tracker's encode filter (Jira automation's `.urlEncode()`, and equivalents elsewhere).

Explicit non-goals: no `project/add` (a link must never register a repo — that routes around the gate above), and nothing destructive (`archive`, `quit`), where no amount of confirmation justifies exposure to a channel any web page can trigger.

Where the pieces live:

- **Scheme registration**: `tauri.conf.json` → `plugins.deep-link.desktop.schemes`. The bundler turns this into `CFBundleURLTypes`; it merges with the hand-written `src-tauri/Info.plist` rather than replacing it. **Deep links only work from a bundled `.app`** — not under `npm run tauri:dev`, so test with `make beta` or `tauri build`.
- **Rust** (`lib.rs`) is a pipe, not a parser: every arriving URL lands in `PENDING_DEEP_LINKS` and the webview gets a payload-free nudge (`termic://deep-link`). The queue exists because macOS delivers the launch URL while the webview is still booting; the webview always reads through `deep_link_take_pending`, which drains atomically, so a link is never handled twice.
- **Parsing + validation** is entirely in `src/lib/deepLink.ts`, because the checks that matter (a *registered* project, an *existing* task) need the webview store. `initDeepLinks()` is chained off `loadAll()` in `App.tsx` for the same reason.
- **Raising**: `queue_deep_link` calls `leave_windowless` when a window already exists. macOS activates the app for a link it routes, but that does not un-hide a window windowless mode put away, and a dialog behind a hidden window is indistinguishable from a link that did nothing. Gated on the window existing so cold-start `setup` doesn't flip `SHOWN_ONCE` ahead of normal startup ordering.
- **Second instance**: on Windows/Linux a link spawns a fresh process, which the single-instance preflight kills. It hands the URL over first via the control socket's unauthenticated `open_url` verb (proto v11), which raises and queues in one request. macOS never gets here (LaunchServices routes to the running app).

## Critical shapes (fail silently)

- `pty_spawn` payload is `{ args: SpawnArgs }`, NOT `SpawnArgs` at top level. Wrong shape → "invalid length 0, expected struct SpawnArgs".
- Listener payload is `ev.payload.data` / `ev.payload.line` — Rust emits structs, not bare arrays. Wrong unpack → blank terminals, no error.
- `task_run_script` takes `{ id, which }`. Forgetting `which` → silent no-op.

## Long-running IPC discipline

**Any IPC doing heavy IO MUST be `async fn` + `tauri::async_runtime::spawn_blocking`.** Synchronous commands run on the IPC handler thread = same thread driving WKWebView event loop in dev. `fs::remove_dir_all` on a 50k-inode `.venv` froze the entire Mac. Already applied to `task_archive`, `task_delete`, `list_monospace_fonts`. Pair with `useUI.setBusy("…")` overlay so the user knows a multi-second op is in flight.
