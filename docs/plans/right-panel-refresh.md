# Right-panel refresh: deferred items

Follow-ups from the 2026-07 refresh-trigger audit. The safe items already
landed (poll gating on window focus, reference-stable git status, wiring
`bumpFsRevision`/`bumpGitRevision` into discard / branch ops / editor save /
tree rename-delete / script-done / aux-terminal command heuristic, and the
rate-limited tree reload on window focus). The two below were deliberately
deferred because they need manual testing before they can ship.

## Background (how refresh works today)

Two per-task counters in the app store are the FS-watcher stand-ins:

- `fsRevision` — "files on disk may have changed". Bumped on agent settle
  (falling edge of `workState === "working"`), git working-tree mutations
  (discard, branch switch/update), setup/run script completion, and the aux
  terminal's debounced command heuristic. Consumers: FileTree (dedupes via
  `sameChildren`), EditorPane (`reloadFromDisk`, content-compare no-op),
  MarkdownPane/PreviewPane (fp-based image revalidation), RightPanel git
  status.
- `gitRevision` — "git status may have changed but no visible file/buffer
  did" (editor save, FileTree rename/delete). Only RightPanel's git status
  listens. Exists so a save doesn't force the saving editor to re-read its
  own file (that re-read can race fresh keystrokes and pop a spurious
  "changed on disk" banner).

The 4s status poll still runs as a safety net for external changes while
the window is focused; it skips ticks when the window is unfocused.

## Deferred 1: DiffPane live reload

**Problem.** DiffPane loads once per `[task.id, tab.path, tab.scope]` (plus
theme/font deps) and never again. An open diff tab goes stale while an agent
keeps editing the file, and after stage/unstage of the same file. Every
other consumer refreshes on `fsRevision`; the diff, the surface most likely
being read, does not.

**Why it was deferred.** The rebuild path is destructive: it does
`hostRef.innerHTML = ""` and recreates the MergeView/EditorView, which nukes

1. scroll position,
2. selection,
3. any in-progress review-comment editor (`commentable` /
   `dispatchFileComment`) — a naive `fsRevision` dep means an agent settle
   mid-comment silently eats the draft.

**Sketch.**

- Add `fsRevision` (and window focus, rate-limited) as a *refetch* trigger,
  not a rebuild trigger: call `taskFileDiffSides` and compare the returned
  `fp` against the current one. Unchanged fp → do nothing (covers the
  common "agent settled but not this file" case, and keeps scroll).
- Only rebuild when fp changed, and even then skip (or queue the reload
  behind a "file changed on disk" banner, mirroring EditorPane's dirty-buffer
  flow) while a comment editor is open/focused in this pane.
- Preserve scroll offset across the rebuild when the fp changed but the
  user has scrolled (best-effort `scrollTop` save/restore is enough; the
  hidden-scroll-restore helper already tracks this element).

**Manual test checklist.**

- [ ] Open a diff, scroll mid-file, let an agent edit an *unrelated* file →
      no rebuild, scroll intact.
- [ ] Same, but agent edits *this* file → diff updates; scroll restored
      best-effort.
- [ ] Start typing a review comment, trigger an agent settle that touches
      the file → draft survives (banner or deferred reload, never a wipe).
- [ ] Stage/unstage the file from the Git panel with its diff open → sides
      update (or tab closes, whichever the flow already does).
- [ ] Deleted/renamed file under an open diff → no crash, sane empty state.

## Deferred 2: stretch / retire the 4s poll

**Problem.** With every in-app mutation path now event-driven, the focused
4s poll only exists to catch *external* changes (user's own terminal.app,
another editor) while termic stays frontmost. 3 git subprocesses per repo
per tick is a lot of safety net.

**Why it was deferred.** Needs soak time first: if any event trigger above
has a coverage gap, a 15–30s poll turns that gap into a visibly stale badge,
and the failure is silent staleness (the worst kind to debug from reports).

**Sketch.**

- After the event triggers have been in a release or two with no staleness
  reports: raise the interval to ~15s when idle, keep ~4s only while some
  agent tab in the task has `workState === "working"` (live badge movement
  while the agent works is the case users notice).
- Optional pre-check to make any interval near-free: `stat()` the repo's
  gitdir `index` + `HEAD` mtimes and skip the porcelain run when unchanged.
  **Gotcha:** termic tasks are worktrees — `.git` in the task root is a
  gitdir pointer FILE; the real index lives at
  `<main-repo>/.git/worktrees/<name>/index`. Resolve via
  `git rev-parse --git-dir` once per task (cache it), never by joining
  `root/.git/index`. Also note the stat only catches *git state* changes
  (stage/commit/branch); working-tree edits don't touch the gitdir — those
  stay covered by the event triggers + focus refresh.

**Manual test checklist.**

- [ ] External `git add`/`commit` from Terminal.app while termic is
      frontmost → badge updates within the slow interval.
- [ ] Agent working → badge still ticks at the fast interval.
- [ ] Worktree task AND repo-root (main checkout) task both detect external
      commits (gitdir resolution differs between them).
- [ ] Battery/CPU: Activity Monitor shows no periodic `git` wakeups with the
      app unfocused, and reduced frequency when focused-idle.
