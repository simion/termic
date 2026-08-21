# E2E coverage map & checklist

**Status: reference.** Not a plan to implement and then delete: it is a
living map, updated by nearly every feature commit, which is why it sits in
`docs/` rather than `docs/plans/`.

The running map of what our WebdriverIO e2e suite covers and what it still
needs. Update this whenever you add/change a spec. Harness + authoring rules
live in [docs/e2e-tests.md](e2e-tests.md) and the **`e2e` skill**.

- **Run:** `make e2e` (build + run) · `npm run test:e2e` (iterate). ~40s serial.
- **Specs are grouped by area** into ~10 files (one app launch each; cases run sequentially and self-clean). Add a new test as an `it` in the relevant group file. `activity.e2e.ts` is the one file that earns its own launch on structure rather than area: it switches WebDriver between window handles, and leaving the wrong window current would break whatever ran next in a shared file.
- **Specs:** `e2e/specs/*.e2e.ts` · **helpers:** `e2e/helpers.ts`.
- **Legend:** ✅ covered · ⬜ todo (P0 core / P1 important / P2 nice-to-have).

## The rule

Every new feature with a UI/flow surface gets a spec; every change to an
existing feature updates its spec. A PR that adds/changes a flow is not done
until `make e2e` is green and this file reflects it.

## Covered today

| Area | What's asserted | Spec |
|---|---|---|
| ✅ App shell | Renders; `__termic` exposes real store state | `app.e2e.ts` |
| ✅ Navigation | Dashboard ↔ History via real clicks | `app.e2e.ts` |
| ✅ History scrolling | The archive pane fills its overlay instead of sizing to its content, so an archive taller than the window overflows INSIDE the scroller: the last row starts out of view and scrolling brings it in. Filtering down and back keeps the pane full-height | `app.e2e.ts` |
| ✅ Create (wizard) | NewTaskDialog: name + shell CLI + Main-checkout → Create → task exists | `task.e2e.ts` |
| ✅ Non-blocking archive (GH #246) | Confirming an archive never raises the `busy-overlay` click-blocker (sampled the whole time the archive runs, not once at the end) and the row leaves the sidebar on its own; a task with an archive in flight renders as the inert `ArchivingTaskRow` (spinner badge, clicking it selects nothing) and returns to a normal row if the flag clears | `task.e2e.ts` |
| ✅ Non-blocking worktree create (GH #242) | Worktree-mode Create closes the dialog synchronously, before the worktree is ready (not once it's done); while a task is pending, the sidebar shows a spinner-badged `PendingTaskRow` and the main pane shows `CreatingTaskPane`'s live log, with no `[role="dialog"]` blocking the rest of the app; a failed create leaves a dismissible error state instead of an error dialog | `task.e2e.ts` |
| ✅ Task spawn | Task created; agent PTY comes alive; PTY write round-trips; agent OSC title reaches the app | `task.e2e.ts` |
| ✅ Deep links (GH #192) | A `termic://new?…` URL pre-fills the New Task dialog (name, prompt, task type) and **creates nothing** until the user presses Create; the prompt stays editable; a prompt at the cap is accepted and one past it is refused with a reason; an unregistered project, a missing project, an unknown action, an unknown task and a foreign scheme are each refused with a toast and no dialog; a confirmed link creates the task it described. `termic://open?…` selects an existing task by name or id with **no dialog** (navigation changes nothing to confirm) and closes a stale New Task dialog on its way through. Enters at `handleDeepLink` with the raw URL Rust queues, because WebDriver cannot ask macOS to open a URL scheme | `deep-link.e2e.ts` |
| ✅ Agent working | After a real submit, the agent enters the working state | `agent.e2e.ts` |
| ✅ Agent attention | An agent you are not viewing flags completion (unread/done) when it finishes | `agent.e2e.ts` |
| ✅ CLI tabs (unit) | `termic tab` on an UNMOUNTED task keeps every persisted agent and its session id, does not steal the default-target role, and a shell tab does not strand the task agentless | `store/cliTab.integration.test.ts` |
| ✅ CLI tab ids end to end | Over the real control socket: `tab` returns a stable id; `logs --tab` resolves it to THAT tab's own PTY (the `PtyRole.tab_id` thread); `send --tab` delivers to the targeted tab only; `tab -p` confirms delivery into the new tab; `status` lists the strip with the same ids and 1-based indices; a missed selector is a typed not_found and a duplicate title refuses as ambiguous | `cli.e2e.ts` |
| ✅ CLI rename end to end | Over the real control socket (GH #153): `rename` retitles by explicit name, the reply carries the persisted NEW name and old_name, the store reflects it live; a same-project duplicate refuses with a typed conflict | `cli.e2e.ts` |
| ✅ CLI send --tab (unit) | Targeted send delivers/queues on the TARGET tab's own state, refuses vanished (unknown_tab), non-agent (not_sendable), dead (tab_not_live) targets, spawn-pending waits for the racing PTY, --resume/--fresh conflict, incapable --wait refused | `store/cliSend.integration.test.ts` |
| ✅ CLI tab close end to end (GH #185) | Over the real socket: `tab close --tab` drops a secondary tab from the strip AND stops its PTY (its id stops resolving) while the task and its other tabs keep running; a SHELL tab is refused by `logs` (write-only) yet still closes, reporting `tab_kind` and the webview-observed `killed_pty`; the default tab refuses without `--yes` and nothing is killed on the way to the refusal; a missed selector is a typed not_found; a closed secondary leaves a `closedTabs` Resume entry; `--yes` closes the default tab, which stays durable in `persisted_tabs` | `cli.e2e.ts` |
| ✅ CLI tab close, store side (unit) | The webview half: a secondary tab leaves the durable set but keeps its session id in `closedTabs`, a shell tab closes with `killedPty` reported from the store (the only side that knows, since it carries no PtyRole) and leaves no Resume entry, the default tab closes yet stays durable with no entry, and an UNMOUNTED task is refused without touching `persisted_tabs` (running `syncDurableTabs` there would forget every secondary agent's session id on disk); unknown-tab, split-pane and missing-id refusals carry their sentinels | `store/cliTabClose.integration.test.ts` |
| ✅ CLI adopt worktree (GH #169) | Over the real socket: `new --from` adopts an externally-created worktree (project resolved from its repo, name derived from its branch), re-adopting the same path and a plain non-worktree dir refuse cleanly, and `--resume` on both `new` and `tab` refuses an agent without id-resume support; `--resume` SEEDING (task agent_session_ids, tab sessionId, `--resume <id>` arg composition keeping `--name`) is pinned by `cli_server.rs` tests + `agents.test.ts` + `store/cliTab.integration.test.ts` | `cli.e2e.ts` |
| ✅ CLI prompt library (Phase 4) | Over the real socket: `prompts` lists the shipped library (ids + flags, no bodies); `prompts show` resolves ids and case-insensitive live titles, including disabled prompts, and a miss is a typed not_found; `send -P` composes body + blank line + `-p` text into the real agent; a bad `-P` on `new` fails fast with no task created. Selector precedence/ambiguity, composition, empty-body refusal and fail-fast ordering are pinned by `cli_server.rs` tests; the live-store contract by `store/cliPrompts.integration.test.ts` | `cli.e2e.ts` |
| ✅ Windowless completion | An agent finishing while Termic is windowless still flags unread/done, even for the task that was active | `app.e2e.ts` |
| ✅ Pending work defers done | An agent that backgrounds work and returns to its idle title holds the done badge back past byte-quiet (4s) and the settle timer (5s); done fires once its status line clears | `agent.e2e.ts` |
| ✅ A hold that never clears ends | A status line that never clears cannot pin a tab to "working": the absolute ceiling force-clears it (shortened for the test via `localStorage.workDoneCeilingMs`) | `agent.e2e.ts` |
| ✅ A premature done is taken back | A done fired at a stage boundary is undone when the agent goes back to work (spinner returns, stale bullet drops), and the turn's real completion still fires | `agent.e2e.ts` |
| ✅ Split restore | A pane whose tabs are all gone collapses instead of restoring a blank leg; a task whose main tabs were all non-durable still restores with a main tab and a real activeTab | `tabs-layout.e2e.ts` |
| ✅ Agent notifications | OSC 9 raises attention carrying the agent's verbatim body; the "waiting for your input" idle nag raises nothing | `agent.e2e.ts` |
| ✅ Run tabs | A custom run command opens a run tab whose PTY executes it | `run.e2e.ts` |
| ✅ Task archive | Archived task leaves the active board | `task.e2e.ts` |
| ✅ Task restore | Archived task shows in History; restore returns it to active | `task.e2e.ts` |
| ✅ Tab close confirm (unit) | The close prompt carries the same "Show this every time" opt-out (not the branch checkbox slot), stores it only when the close went through, and only a PANE tab close (no `closedTabs` entry, so no Resume) is dressed as destructive | `lib/closeTab.test.ts` |
| ✅ Archive confirmation | "Show this every time" unticked then cancelled stores nothing; confirmed, it stores the opt-out AND the delete-branch answer; the next archive then runs with no dialog, deletes the branch and toasts the way back to History. Settings › Tasks keeps both toggles visible either way, flips the branch one, and turning the confirmation back on neither hides it nor rewrites its value. The branch toggle seeds the dialog's checkbox (singular and plural forms), which can still be overridden for one archive without changing the stored default | `task.e2e.ts`, `settings.e2e.ts` |
| ✅ Multi-task | Two tasks, independent/distinct PTYs, survive going inactive, switching works | `task.e2e.ts` |
| ✅ Editor open | Click a file → editor tab opens → CodeMirror loads the real contents | `editor.e2e.ts` |
| ✅ Editor save | Edit in CodeMirror → dirty dot → Cmd+S → written to disk | `editor.e2e.ts` |
| ✅ Scratchpads (GH #244) | The "+" menu opens an untitled, permanently-dirty pad; the title is folded from as many buffer lines as fit (blank lines and heading/bullet marks stripped) and the syntax button names what the CONTENT sniffer picked, with a manual pick from the palette overriding it, persisting into the scratch index, and (for Markdown) earning the pad the same source/preview/split shell a `.md` file gets, rendering from the live buffer since there is no file yet; the close prompt's Cancel keeps both the tab and the pad; ⌘S opens the promote picker and turns the SAME tab into a clean `edit` tab on the chosen path, with the file really on disk and visible to `git status`; Discard closes the tab and drops the record so a relaunch cannot bring it back; a bulk close ("Close others") asks about every pad separately, and a Cancel there spares that one while the rest of the set still closes | `scratchpad.e2e.ts` |
| ✅ Git clean | Clean working-tree status for the fixture repo | `git.e2e.ts` |
| ✅ Git dirty | Modify a file → Commit panel leaves clean state, git status reports it | `git.e2e.ts` |
| ✅ Git history / graph | The Git tab's History sub-tab lists real commits (made outside the app) newest first with lane gutters + ref chips; a commit expands into its files; a file opens a diff of THAT revision (asserted against a deliberately dirtied working tree) with no review affordances; the ref picker scopes to Auto, All and a named branch, unticking the last ref returns to Auto, First parent only collapses merged branches without emptying the graph, and the message search narrows the graph across the whole branch (a literal no-match query empties it, clearing restores); subjects indent to their own lane (GH #199, GH #208) | `git.e2e.ts` |
| ✅ Git branch compare | The Compare sub-tab lists committed, uncommitted and untracked work against the base in ONE list (the committed file being the case the Commit view structurally cannot show); the summary strip carries a file count + diffstat; the shared Filter box narrows the list and restores it; a file opens a `base:<sha>` diff whose left side is the base and right side the live worktree (fingerprint non-empty), review affordances still ON unlike a graph diff; picking another base re-runs the comparison; folders render as a tree, not flat paths (GH #208) | `git.e2e.ts` |
| ✅ Settings | Toggling a preference lands in the prefs store + control reflects it | `settings.e2e.ts` |
| ✅ Terminal renderer picker | Appearance → Terminal exposes the three-way webgl/canvas/dom picker on macOS (GH #140); the option list is asserted to be exactly those three, and driving the real segmented control through canvas and dom lands in prefs and keeps the legacy `terminalGpuEnabled` in sync | `settings.e2e.ts` |
| ✅ Experimental badging | The MCP section carries the Experimental badge (off by default) while the graduated Termic CLI page and rail item carry none (0.26.0); docs/ui.md ties the badge to being off by default, so a badge next to a shipped-enabled setting is a contradiction in one direction and a missing badge on a settling surface is one in the other | `settings.e2e.ts` |
| ✅ MCP endpoint boundary | The listener advertises itself only through the data-dir files; missing, wrong, and CLI tokens all get one indistinguishable bare 401; any `Origin` header is 403 even with a valid token; a CORS preflight is never answered | `mcp.e2e.ts` |
| ✅ MCP protocol conformance | `server/discover` returns the one served revision with `resultType` as a result field and serverInfo under the namespaced `_meta` key; a handshake `initialize` (the exact opening request `claude` 2.1.228 sends) is refused with -32022 carrying machine-readable `data.supported`; notifications are swallowed at 202 without header ceremony; missing or mismatched standard headers are -32020 while a missing required `_meta` field is -32602; an unimplemented method is -32601 at HTTP 404 | `mcp.e2e.ts` |
| ✅ MCP tool surface | `tools/list` is deterministic and full-scope; `task_new` spawns the fake agent, `task_send` + `task_log` round-trip, `task_wait` settles with a typed outcome, and verb refusals come back as typed tool errors rather than protocol errors | `mcp.e2e.ts` |
| ✅ MCP tabs and discovery | `task_tab` opens a tab and returns the id `task_send` / `task_log` then address, `task_tab_close` resolves that same id, and `task_agents` lists the ids `task_new` accepts; the tab's pty is awaited first because `task_tab` returns before its agent spawns | `mcp.e2e.ts` |
| ✅ MCP lifecycle | Toggling the setting off unbinds the listener and removes both data-dir files; toggling on rebinds on the preferred port and mints a fresh credential, as every bind does | `mcp.e2e.ts` |
| ✅ Editor theme per app mode | Appearance → Editor offers a dark AND a light syntax theme select, each writing only its own pref; on the rendered side the app mode selects the matching pref, the light pref repaints while the app stays light, and a write to the dark pref changes nothing until the app goes dark | `settings.e2e.ts`, `editor.e2e.ts` |
| ✅ Select chrome | Every settings `<select>` computes `appearance: none` with the repainted chevron and reserves room for it, so WKWebView's native bevel cannot come back (one bare-element rule, all selects at once) | `settings.e2e.ts` |
| ✅ Default tasks path | The global setting ships a real value (not an empty box); a new project's `tasks_path` starts empty so that setting applies; an absolute default lands worktrees at `<default>/<project>/<task>` and a relative one at `<repo>/<default>/<task>`, both verified on disk; a project's own tasks path overrides it; the project field shows the global-derived path as its placeholder while staying empty; the Settings → Tasks preview flips between the two halves of the rule as it is typed, and emptying the required field blocks the save | `settings.e2e.ts` |
| ✅ Tabs | Add a terminal tab via the "+" menu; switch active tab | `tabs-layout.e2e.ts` |
| ✅ Sidebar New submenu | The task row's menu offers the same entries as the tab strip's "+" (GH #197); picking one spawns into that row's task, wakes it, and keeps its seeded agent tab | `tabs-layout.e2e.ts` |
| ✅ Tab rename | Double-click inline edit commits the new name | `tabs-layout.e2e.ts` |
| ✅ Tab context menu | Right-click a pill: Pin moves the tab to the head of the strip and a second pin appends to the end of that block; Unpin drops back to the first slot after it; Close to the right and Close others spare every pinned tab and the clicked one; both go disabled when they have nothing to close (GH #183) | `tabs-layout.e2e.ts` |
| ✅ Pinned pill has no close X | A pinned pill offers "Unpin tab" where an unpinned one offers "Close tab", so one stray click cannot kill a live PTY; that control unpins (the tab survives) and the X comes back with it (GH #183) | `tabs-layout.e2e.ts` |
| ✅ Pinned tabs stay in view | A pinned tab lives outside the strip's scroller: with the strip flooded past overflow and scrolled to its end, the pinned pill has not moved a pixel and is still fully inside the bar (GH #183) | `tabs-layout.e2e.ts` |
| ✅ Theme | Picker switches theme; palette class applied to `<html>` | `tabs-layout.e2e.ts` |
| ✅ Editor persist | Single-click = preview tab; double-click persists it | `editor.e2e.ts` |
| ✅ Split panes | Unsplit start; split-right → 2 leaves; split-below → 3 | `tabs-layout.e2e.ts` |
| ✅ Message queue | Message held while working, drains on idle | `agent.e2e.ts` |
| ✅ Command palette | Opens/lists; filters; command activation closes it; Escape closes; the top-bar button toggles it open and shut and names the live binding in its label; top-bar tooltips (palette, Prompts, right-panel toggle) print their live glyphs | `app.e2e.ts` |
| ✅ File finder | ⌘P lists the repo's files; selecting one opens an editor tab | `files.e2e.ts` |
| ✅ Git stage/unstage/commit | Stage → unstage → re-stage + commit → clean | `git.e2e.ts` |
| ✅ Task rename/delete | Rename updates store+sidebar; duplicate name refused (IPC) + toast (inline flow, GH #153); delete removes the task entirely | `task.e2e.ts` |
| ✅ Git diff | Open a diff tab for a changed file | `git.e2e.ts` |
| ✅ Inline review comments | Select a diff line → tooltip → compose → save, three times; line numbers stay level with the code throughout (GH #157) | `git.e2e.ts` |
| ✅ Find in files | ⇧⌘F opens; the status line names the backend that actually ran (ripgrep or the `git grep` fallback) and the install hint shows only on the fallback (GH #181); a repo-present query returns a result row with the match highlighted; a pattern matches nothing as a literal and matches once the `.*` toggle turns regexp mode on; a differently-cased query matches until the `Aa` toggle turns match-case on (both toggles persist to prefs). Run the spec a second time with `TERMIC_FIND_BACKEND=git-grep` to exercise the fallback on a machine that has rg | `files.e2e.ts` |
| ✅ Markdown preview | Preview view renders the README markdown (h1) | `editor.e2e.ts` |
| ✅ Directory links | A folder link recycles the preview tab into a listing and expands the tree; the folder README renders under it; folder rows, `..` and links inside the README navigate in place; a file row or README file link pins the listing and opens alongside it; a hidden listing's README does not claim ⌘F; ⌘[ / ⌘] walk the folder trail, are declined when focus is in the bottom drawer or right panel, and fall through to task switching once the trail runs out | `editor.e2e.ts` |
| ✅ Find in preview | ⌘F marks exactly the query text and nothing else (asserted on the `<mark>`s and their *computed background*, never a highlight registry), including the code spans a doc contains but the query doesn't touch; Enter/⇧Enter step with the counter and wrap both ways; a second query replaces the first instead of stacking; a query inside a code span still matches; a phrase the markdown source hard-wrapped still matches; a regex metacharacter stays literal; no match clears; Escape restores the document; a theme flip that rebuilds the DOM re-marks against the fresh one | `editor.e2e.ts` |
| ✅ ⌘F ownership | Only the tab the reader is in opens a find bar: not a background task's mounted preview, not the visible preview while a split pane holds focus, not while a modal holds the focus trap, and not under the Settings overlay (which traps nothing, so only the store flag sees it). The tab takes the key back on close, and a tab recycled onto another file drops its marks. In split view the editor keeps ⌘F while the caret is in it and the preview claims it once clicked into | `editor.e2e.ts` |
| ✅ File tree | Create a folder → expand reveals its child → collapse hides it; re-expanding re-reads that dir from disk (a file added while collapsed shows up, the original stays); a `chmod 000` folder keeps its cached contents through a settle reload and, when it cannot be read at all, offers a retry row that loads it once the permissions come back (GH #159); that row names the actual error (errno + path) and a folder symlinked out of the task says so instead of offering a pointless retry (GH #250) | `files.e2e.ts` |
| ✅ Drag a file to a terminal | Row dragged onto a terminal sends the relative path to the PTY (no editor tab); released elsewhere types nothing; a plain click still opens the file | `files.e2e.ts` |
| ✅ Tab drags | Reorder within the main strip; drop on a pane edge to split there; drag out of a pane back to main | `tabs-layout.e2e.ts` |
| ✅ Resize drags | Sidebar edge widens + clamps at its minimum (persisted); split divider moves the ratio inside its clamp | `tabs-layout.e2e.ts` |
| ✅ Sidebar project drags | Reorder two projects; drop one into a group folder; move a whole folder as one block | `projects.e2e.ts` |
| ✅ Sidebar task drags | Reorder tasks inside a project (siblings keep their relative order); the new order persists to the task files, so a cold load reads it back; a task dragged at another project's row clamps to its own list instead of moving | `task.e2e.ts` |
| ✅ Settings reorder drags | Prompt rows reorder by their grip (and a click without movement does not); agent pills reorder within their kind | `settings.e2e.ts` |
| ✅ Resume submenu | The project `+` menu keeps archived sessions behind one Resume row; the submenu lists them and restores the picked one. The tab strip's `+` menu nests its closed tabs the same way: the top level shows one Resume row and no sessions, hovering it lists them | `projects.e2e.ts`, `tabs-layout.e2e.ts` |
| ✅ Empty archive | History's Empty archive: cancelling keeps every task, confirming deletes them all for good | `task.e2e.ts` |
| ✅ Signal inspector layout | Observed titles render whole (no clipped column) and each row offers a copy button | `settings.e2e.ts` |
| ✅ Dialogs/palettes | Shortcuts help, prompt palette, broadcast open (and close) | `app.e2e.ts` |
| ✅ More dialogs | Changelog, welcome, race dialog open | `app.e2e.ts` |
| ✅ Windowless mode | Close backgrounds without killing the task; panes collapse to zero geometry; agent output keeps flowing; `raise` restores window + panes | `app.e2e.ts` |
| ✅ Agent race | Fire one prompt at 2 agents: cohort recorded, both spawn a PTY + receive the prompt (lastInputAt) + drive a fakeagent OSC title; runs on a no-remote repo; RaceDialog gates Start then steppers+prompt launch it; a name collision surfaces an error and records no new race | `task.e2e.ts` |
| ✅ Preferences | Sandbox default, editor font, terminal font setters | `settings.e2e.ts` |
| ✅ Agent extras | YOLO toggle; aux (bottom) terminal | `agent.e2e.ts` |
| ✅ Worktree task | Create a task on its own worktree branch (not repo-root); on a no-remote repo the default-base create falls back to local main | `task.e2e.ts` |
| ✅ Project rename | Rename a project (add covered too) | `projects.e2e.ts` |
| ✅ Editor split | Split view shows source + rendered preview together | `editor.e2e.ts` |
| ✅ Repo config | Save a `.termic.yaml` field and read it back | `projects.e2e.ts` |
| ✅ Setup script | Configure + launch a Setup tab that spawns | `run.e2e.ts` |
| ✅ Sidebar layout | Sidebar width setter persists | `tabs-layout.e2e.ts` |
| ✅ Code editor | Open a .py file → CodeMirror renders with highlight tokens | `editor.e2e.ts` |
| ✅ Git status chip contrast | The one-letter status chip on a changed file keeps ≥5.5:1 between its ink and its fill in BOTH themes, measured from computed style (the light theme's "modified" chip shipped at 4.96:1, so a WCAG-4.5 floor would not have caught it) | `git.e2e.ts` |
| ✅ Set syntax (GH #244) | TypeScript, JavaScript and TSX highlight (the extensions this repo is mostly made of, and the ones a main-chunk bundling mistake broke once), a language nobody registered here highlights straight from CodeMirror's registry (PHP: no import, no entry, no case in a switch), a Makefile highlights at all (hand-written grammar, no upstream one exists), the breadcrumb's language button names what the extension picked, an extension-less file gets its language from its CONTENT, and a manual pick from the syntax palette overrides both: label switches, a buffer that had zero token spans gains them, the text survives the switch (a view rebuild would also produce tokens, while losing undo/cursor), and the palette closes | `editor.e2e.ts` |
| ✅ Editor h-scroll gutter | A long line scrolled fully right keeps the sticky gutter painting the host's surface, so code never shows through it (GH #161) | `editor.e2e.ts` |
| ✅ Commit & push | Commit with push to a bare remote; remote receives it | `git.e2e.ts` |
| ✅ Inline git blame | Cursor line gets ONE annotation naming the real commit (real `git blame`, asserted on the fixture's own author + subject), nothing before the cursor leaves position 0, never more than one (no column, and no annotation on the phantom line a trailing newline creates), an edited line drops to "Not committed yet", the pref removes it and restores it on a parked cursor, and the palette's `toggle-inline-blame` row flips it. Mutates no fixture state on purpose: one extra commit in the shared history breaks `git.e2e.ts`'s first-parent case. Card: resting on the annotation opens it with the real commit; the header's Open diff opens a `commit:` diff tab; Show in History expands that commit in the Graph; a click on the annotation does nothing | `editor.e2e.ts` |
| ✅ Editor selection → agent | A selection raises ONE gutter icon (never the diff's pill or hover button) and retracts with the selection; the composer offers Send + Add to pending; Send ships that one comment WITH the code and skips the queue; Add to pending queues it (card in place, editor keeps the stage, nothing sent); ⇧⌘L stacks a second one and no-ops with no selection; queued comments follow their code when lines are inserted above; the batch sends as one message carrying both bodies + both SHIFTED line attributions (asserted from the agent's PTY ring) and drains the queue | `editor.e2e.ts` |
| ✅ Multi-repo Git panel | Two member repos: the panel opens on a CHANGED repo (never the clean host) with its files listed and no click; a second dirty repo adds its pill without stealing the selection; picking a pill swaps the list and stages into that repo only | `git.e2e.ts` |
| ✅ Discover repos | Scan a folder → returns its git repos | `projects.e2e.ts` |
| ✅ Import worktree | Lists importable (unopened) worktrees for a project | `projects.e2e.ts` |
| ✅ Project reorder | Reorder projects | `projects.e2e.ts` |
| ✅ Resume closed tab | resumeClosedTab reopens a tab and consumes the entry | `task.e2e.ts` |
| ✅ Run stop | Kill a running run tab's PTY → it stops | `run.e2e.ts` |
| ✅ Project group | Assign a project to a group | `projects.e2e.ts` |
| ✅ Task sandbox | Enable enforce mode then turn it off (per task) | `settings.e2e.ts` |
| ✅ Extra named ports (GH #196) | The Repo Settings field autosaves typed names to the personal list and warns inline on invalid/reserved names; a task created after the config freezes consecutive name→port pairs from its own block, a second live task's block never overlaps, clearing the config leaves new tasks extras-free, and a name configured AFTER a task exists tops up into its buffer on the next spawn (task_ensure_extra_ports) | `settings.e2e.ts`, `task.e2e.ts` |
| ✅ Project add/remove | Add a git repo as a project; remove drops it | `projects.e2e.ts` |
| ✅ Dashboard empty state | The "No projects yet" card is a focusable button that opens the Add project dialog, and it disappears once a project exists | `projects.e2e.ts` |
| ✅ Agent settings | Disable/re-enable an agent CLI via agentsSave | `agent.e2e.ts` |
| ✅ Run config modal | The #124 run-commands manager opens for a project | `run.e2e.ts` |
| ✅ SVG source/preview toggle | An `.svg` opens on the rendered picture (the default stays "preview", so a file-tree click still shows the image), the same source / preview / split toolbar markdown uses switches to the editable source and to both at once, an UNSAVED edit re-renders the picture (the preview is fed by the editor buffer, not disk, so a disk-backed one could not move), and toggling writes the `svgDefaultView` pref for the next file (GH #247) | `editor.e2e.ts` |
| ✅ PDF preview | A hidden PDF tab keeps its `display` (main tab and split pane) while a hidden terminal still goes to display:none; the embed URL is fingerprint-keyed, so only a real rewrite reloads it | `editor.e2e.ts` |
| ✅ Git branch bar layout | A long branch name shares its row instead of taking it: on Commit the filter keeps >=30% of the row and the chip stays inside it (measured geometry, since happy-dom has no layout), and on Compare the bar wraps to a second row so neither the base picker nor the target branch ends in an ellipsis | `git.e2e.ts` |
| ✅ Activity monitor | The sidebar footer button opens a SECOND window (its own `activity.html` entry, found by polling the WebDriver handles: a new webview is listed before its document loads); a live agent appears under its project and task; Termic's own processes get their own group and do NOT double-count the agents' subtrees (every PTY is our child, so the app row's stop-set is the invariant); a row reports a real CPU percentage even though the harness window is permanently `document.hidden`, which is the occluded-window back-off working; Pause halts sampling and resume restarts it; re-opening focuses the existing window instead of spawning a second; closing the window drops the sampling session and a fresh one is grantable; every column header sorts (default CPU desc, a new column starts biggest-first except Name which starts A-to-Z, the previous column lets go) and the PID column renders real pids. Grouping / sorting / formatting are unit-tested in `src/lib/activityGroups.test.ts`, the sampler math + FFI in `procmon.rs` tests | `activity.e2e.ts` |

## CLI control plane (Phase 1/2)

The socket verbs are covered by Rust integration tests against a real
unix socket with a stub host (`src-tauri/src/cli_server.rs` tests: auth,
every verb, streaming framing, full bidirectional attach sessions,
watch/queue semantics), plus vitest for the store-level pieces
(`cliPromptReports`, `stopTask` queue fail-fast, the unattended-restore
mark). What that rig cannot see is the webview HANDLER side running in
the real app; e2e specs to add:

- ⬜ P1 `send` end to end: real socket request → send_prompt handler →
  fake-agent PTY receives the text; busy path queues and drains.
- ⬜ P1 `send --resume` respawnKick: exited fake-agent tab respawns and
  receives the injection (covers the TerminalPane kick effect).
- ⬜ P2 `send --fresh` adds a secondary tab without forgetting the
  persisted set (assert `persisted_tabs` after).
- ⬜ P2 `logs`/`result` against a fake-agent transcript fixture.

## Deferred (with rationale)

Lower-value or high-setup items left for later; the patterns to do them are all in place.

- **Second live agent in one task / quick-create** — heavy fixture setup (agent-tab construction) for low marginal coverage. Resume (`resume-tab`) covers the reopen path. Multi-member projects came off this list: `git.e2e.ts` builds one (a non-git wrapper host + two throwaway repos in a tmp dir) for the multi-repo Git panel, so the fixture pattern exists to copy.
- **Run-at-repo-root (spotlight)** — needs spotlight state; the run-tab mechanism is covered (`run`, `run-scripts` via proxy).
- **Configured `.termic.yaml` run scripts via the Run button** — covered by proxy: `setup-script` (configured-script launch) + `run` (run-tab mechanism) + `repo-config` (config persistence). The live Run-button path has a config-cache nuance not worth the flake.
- **File create/rename/delete via context menu, file-tree reveal** — need Radix context-menu driving (flaky, no clean IPC). Binary previews are no longer on this list: image preview is covered by `files.e2e.ts`, PDF preview by `editor.e2e.ts` (which builds a tiny valid PDF inline rather than committing a fixture).
- **Prompts management, keybindings editor** — config-file editing, low value.

## Environment-limited (not robustly testable here)

These are intentionally NOT covered by written specs — asserting them would be flaky or impossible in the occluded-window / embedded-WebDriver setup. Left as manual checks.

- **OS desktop notification delivery + completion sound** on agent done — no in-webview signal to assert; the store-side attention/unread IS covered (`agent.e2e.ts`).
- **Keyboard shortcuts into CodeMirror** (e.g. its own ⌘F search panel) don't route reliably across window-focus states — manual check. Button-driven editor actions (Preview) ARE covered. This is specific to CodeMirror's keymap: the markdown preview's ⌘F is a plain window listener, so it dispatches fine as a synthetic keydown and IS covered (find-in-preview, `editor.e2e.ts`).
- **Real keystrokes into xterm / CodeMirror** (contenteditable + WebGL canvas) — WebDriver key events don't route there reliably. Covered by proxy: PTY round-trips via `ipc.ptyWrite` (`task-spawn`, `message-queue`) and editor edits via the CodeMirror view API (`editor-save`).
- **Commit-and-push / setup script / resume-closed-tab** — need mock-remote / `.termic.yaml` / multi-agent-tab infra with careful fixture cleanup; deferred, tracked above.
- **Cmd+click path/URL resolution in a terminal** (GH #117, #240) — needs a coordinate-precise click on a specific CELL of the WebGL canvas, which means knowing which row the PTY text landed on (the xterm buffer is not exposed) over a `.xterm-screen` rect that is degenerate on an occluded window (`clickContext` bails on zero geometry by design). The read-only out-of-task tab it can open (GH #240) is reachable only through that click, so it inherits the same gap; its backing read is covered by the `external_read_*` Rust tests. The RESOLUTION logic is pure and unit-tested instead: `src/lib/pathMatch.test.ts` (relative suffix matching, absolute → task-relative mapping, the out-of-task verdict) and `src/lib/termLinkOpener.test.ts` (tokenising, URL/scp exclusion, `:line:col`).
- **The page a PDF is scrolled to** — it lives in WKWebView's native PDF view, which exposes nothing to the DOM. The spec asserts the two mechanisms that keep that view (and its page) alive; the page itself is a manual check.

## Known harness gotchas (read before writing a spec)

- **Terminal content is not in the DOM** (WebGL canvas) — assert `lastOutputAt`/`liveTitle`/store, never innerText, for PTY output.
- **`workState === "working"`** won't flip from a raw `ipc.ptyWrite`; termic gates it on a real submit through the input path.
- **Radix menus open on pointerdown** — dispatch `pointerdown`/`pointerup`, not just `.click()` (see `tabs-layout.e2e.ts`).
- **Hover-gated controls** (theme picker, History "Restore →") need a dispatched `mouseover`/`mouseenter` first, or drive the underlying store/IPC.
- **rAF-deferred effects are frozen when the window is occluded** (e.g. the command palette's `act()` → `requestAnimationFrame`). Assert the synchronous part, or drive the underlying store, rather than the deferred side effect.
- **Run/Setup tab PTY spawn is rAF-gated** in TerminalPane, so a newly-added run tab's PTY lags on an occluded/offscreen window (CI). Assert the tab is *created* (launch wiring); PTY spawn/execution is covered by task-spawn's agent PTY.
- **Don't use WebdriverIO's native visibility** (`$().waitForDisplayed()`/`isDisplayed()`): offscreen, it triggers Tauri window-state calls that time out 5s each (a trivial check took 47s). Use `waitVisible()`/`clickWhenVisible()` — a FAST client-side visibility check via `browser.execute`. The config polls every 100ms so waits fire on-condition, not on a timeout.
- **No fixed sleeps, ever** — `waitUntil`/`waitFor*`/auto-retrying `expect` only.
- **Screenshots are for humans**, never assertions (the xterm canvas even reads black in captures).
- **Scope dialog queries to the SPECIFIC dialog, never a bare `[role="dialog"]`.** Dialogs stack, and on an occluded window a closing dialog's rAF-driven unmount lags so a stale node lingers in the DOM — a bare selector then grabs the wrong dialog (a test can pass solo but fail as the last spec). Find the dialog by its title/content: `[...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent.includes("Start an agent race"))`. See the RaceDialog cases in `task.e2e.ts`.
- **The fixture repo has an `origin` remote** (a sibling bare repo, `.e2e/fixture-repo-origin.git`), so `origin/main` resolves like a real cloned checkout. The project default base is `origin/main`, and worktree spawns (New Task, every Agent Race racer) branch from it — a local-only fixture would die with `git branch … origin/main → not a valid object name`. If a spec repoints `origin` (e.g. `git.e2e.ts` commit-push), it MUST restore the seeded origin in teardown, or later specs lose their base. `resolve_base_ref` (lib.rs) makes a genuinely remote-less repo fall back to local `main` — covered by the no-remote race + New Task cases in `task.e2e.ts`.
- **Isolation:** each spec creates its own task via `openTask()` and archives it in `after`; never assume the app launched on a particular view (self-establish it).
