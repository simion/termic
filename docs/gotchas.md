# Common gotchas

- **Window opens tiny.** `tauri-plugin-window-state` restores prior size before min-size kicks in. Reset: `rm "~/Library/Application Support/com.simion.termic/.window-state.json"`.
- **Window on wrong monitor.** `position_on_cursor_monitor()` in setup hook + `visible: false` + `show()` after positioning.
- **Terminal blank.** Wrong payload shape — see [ipc.md](ipc.md). (A terminal that was working and goes black *later* is the WebGL context-loss bullet below, not this.)
- **Terminal ribbons in TUIs.** `lineHeight` != 1.0 or WebglAddon not loaded.
- **WebGL crash (`_isDisposed`).** Dispose `webglAddon` BEFORE `term.dispose()`.
- **Theme picker flicker.** Radix DropdownMenu has cursor-transit gaps. Use HoverCard with `sideOffset=0`.
- **The app follows a macOS dark/light flip but a JS-computed palette does not.** Under `themeMode: "auto"` the stored string is `"auto"` before AND after the flip, so an effect or memo keyed on `themeMode` never re-runs. Only the CSS side moved, because the `matchMedia` listener in `prefs.ts` swaps classes on `<html>` — every var-driven surface repainted while xterm (whose palette is a JS object handed to `options.theme`) kept the old colours until the user re-picked a theme by hand, which is why "open the picker and select something" looked like it fixed it. The store now mirrors the OS in `systemScheme`, and React callers read `useResolvedThemeFull()`, which subscribes to both and returns the RESOLVED palette id. Depend on that resolved id, never on `systemScheme` raw: a flip while an explicit theme is picked must re-run nothing, or every mounted terminal repaints for a palette that did not change.
- **A colour that ignores its token and renders as plain white.** An unknown CSS custom property is not "empty", it makes the whole declaration **invalid at computed-value time**, so the property falls back to its inherited value. `color: var(--color-text-faint)` on the inline-blame annotation therefore inherited the code's own foreground and the annotation shipped looking like ordinary code. There is no `--color-text-faint`; the tokens are `--color-fg`, `--color-fg-dim`, `--color-fg-faint` (see the `@theme` block in `index.css`). Nothing warns: it is valid CSS, valid TypeScript, and the pixel is simply the wrong colour. Grep `index.css` for the token before inventing one, and treat "my colour did nothing" as a misspelled token first.
- **A directory literally named `~` appears inside a task worktree.** The agent PTY is exec'd directly, with no shell in between, so every shell-ism in a Settings value stays a literal string. A per-agent env block (Settings → Agents → Environment) reading `CLAUDE_CONFIG_DIR=~/.next-claude` therefore hands the agent an unexpanded `~`, and the agent creates that path relative to its cwd, i.e. `<worktree>/~/.next-claude/`, filling the repo with untracked junk that nothing in the app explains. Rust now expands a leading `~` in env VALUES at spawn (`expand_tilde_env`, unit-tested), matching every other path field. The general rule stands for anything else typed into these fields: no `$VAR`, no globs, no quoting, no `VAR=val cmd` prefixes.
- **Toggle knob escapes track.** Hardcode geometry, don't lean on Tailwind transform classes.
- **Footer collapses, files overflow.** Grid needs `gridTemplateRows: "minmax(0, 1fr)"`.
- **`pty_spawn` "invalid length 0".** Payload wrap forgotten — wrap SpawnArgs in `{ args: ... }`.
- **Right-click contextmenu.** `window.addEventListener("contextmenu", e => e.preventDefault())` in `main.tsx`.
- **App icon missing in dev.** Dev runs raw binary, not `.app` bundle. Icon appears after `npm run tauri:build`.
- **Picked system font ignored, Nerd Font glyphs box out.** `system:<family>` font ids (from the Rust enumeration) must go through the prefix branch in `stackFor()` (prefs.ts) — they're not in `MONO_FONT_OPTIONS`, and falling back silently uses bundled JetBrains Mono (latin subset, zero PUA glyphs). Confusingly partial symptom: Powerline U+E0A0–E0BF still render because xterm's WebGL renderer custom-draws them without a font.
- **Font picker incomplete on first open.** The macOS native `<select>` popup snapshots its options when opened — options React adds mid-open don't appear, and a value with no matching option renders blank. Hence: warm `availableMonoFontsAsync()` at prefs module load, and seed selected `system:` ids into the picker's initial list (AppearanceSection).
- **Mixed letter heights in a terminal; selecting text "fixes" them (GH #70).** The bundled JetBrains Mono is a lazy `@font-face` — it only starts loading when text first uses the family. If the PTY's first output wins that race, xterm's WebGL atlas caches those glyphs drawn with the fallback `monospace`, keyed by (char, fg, bg, style) with the font only in the atlas config — so the same char keeps its wrong-font glyph indefinitely, while chars first seen after activation render correctly. Selection changes bg → new key → fresh (correct) glyph; changing the font away-and-back resets the atlas. Fix: prefs warms the load at module start, and both panes gate the first fit + PTY spawn on `awaitTerminalFonts()` (lib/terminalRenderer.ts) so metrics and glyphs come from the real font from the start — normally a microtask, capped at 800ms so a hung load can't stall spawns. Do NOT "fix" this with a naive post-hoc `clearTextureAtlas()+fit()` instead: an async fit can fire mid-spawn (before `term.onResize` is registered → PTY cols/rows silently desync) or against a 0x0 collapsed host (PTY shrinks to minimum dims) — the helper's late path guards both. Any future pane that rasterizes text with a bundled font must go through the same gate.
- **A DETACHED canvas can't resolve user-installed fonts.** In WKWebView, a `<canvas>` not connected to the document silently falls back for families under `~/Library/Fonts` / `/Library/Fonts`: `fillText` with `"MesloLGS NF"` renders pixel-identical to a nonexistent family, *including plain ASCII*. System fonts (`/System/Library/Fonts`, e.g. Menlo) resolve either way, so the bug hides; FontFace-registered webfonts also resolve either way. It DOES affect xterm (see the next bullet), and it silently invalidates any font-probe helper — attach the canvas before measuring. Two aggravators: (1) the resolution is sticky — WebKit short-circuits `ctx.font = <identical string>`, so a stack resolved while detached stays wrong after reattaching until a *different* font string is assigned; (2) `document.fonts.check()` is no help: WebKit returns `true` for every codepoint, even glyphs the font lacks. To test coverage, rasterize and compare pixels against a known-missing font: every missing glyph draws the *same* tofu box, so identical signatures mean absent.
- **The CSS Custom Highlight API paints the wrong text in WKWebView (GH #71). Don't use it.** `CSS.highlights` + `::highlight()` looks like the perfect fit for find-in-page (style ranges without touching the DOM), and its registry behaves correctly: right ranges, right text nodes, right rects. The *painting* is what's broken. Two separate defects: (1) writing to the registry schedules no repaint at all, so nothing appears until something unrelated forces one — which reads as "I have to close and reopen the pane to see my search"; (2) when a repaint does happen, range *i* is painted over the whole of the *i*-th `<code>`/`<pre>` element in the document, wherever the range actually points. So a doc with no code shows nothing, a doc with code lights up its code spans regardless of the query, and the match counter stays correct throughout because it reads the range list, not the paint. `StaticRange` paints nothing; forcing a style recalc + reflow doesn't fix the mapping. The markdown preview now wraps matches in `<mark>` instead (`markFindMatches` in MarkdownPreview.tsx), which has neither problem: a DOM mutation invalidates paint by itself, and there is no range-to-glyph mapping left for the engine to get wrong. **Corollary for tests: asserting on `CSS.highlights` proves nothing.** The specs that did were green for the entire life of this bug. Assert on rendered DOM.
- **Terminal font swaps when text is selected (highlight shows another family, e.g. serifed).** xterm's WebGL atlas rasterizes all glyphs on ONE hidden scratch canvas shared across same-config terminals; the ASCII warm-up draws container-less and closing the hosting pane orphans it, so rasterization can run DETACHED — where WKWebView fails installed families (previous bullet) and falls down the stack. Glyph cache keys (char, fg, bg, ext) omit the font, so default-colored text keeps the wrong glyphs while selection (new bg → new key → connected draw) shows the right family. Fix: `lib/atlasCanvasGuard.ts` (full mechanics in its header), wired in `loadTerminalRenderer`; reach-ins pinned by `xtermInternals.test.ts`.
- **Every cell draws a fragment of some OTHER glyph after a long, colourful session; selecting the text fixes the selected part and it returns on deselect (GH #314).** Same tell as GH #70 above (a new bg is a new cache key, so selection rasterizes a fresh, correct glyph), but the damage is texture COORDINATES, not the font. xterm's `GlyphRenderer.render` re-uploads atlas page `i` to texture unit `i` only when `pages[i].version !== _atlasTextures[i].version` — a per-page counter starting at 0, used as a page IDENTITY. When the atlas passes `maxAtlasPages` (`min(32, MAX_TEXTURE_IMAGE_UNITS)`, **16 in WKWebView**) `TextureAtlas._createNewPage` merges four pages into one: four spliced out, a merged page pushed carrying version 1 (fresh page 0, then one `version++`), then a fresh page carrying version 0. The merge fires at exactly `maxAtlasPages` and is always -4/+2, so the merged page lands at the SAME index with the SAME version every time, and a merged page is dropped from `_activePages` so no glyph is ever drawn into it and its version never moves off 1. From the second merge on the equality test passes, the upload is skipped, and the unit keeps the previous page's bitmap while the new page's glyph coordinates index into it. Structural, not a race: measured in the live app, 62 consecutive merges each landed index 12 at version 1, leaving 1-2 units permanently stale (headless Chrome, 32 units, does the same at index 28). Roughly 1 glyph in 16 then samples the wrong bitmap, which is why the report says "doesn't always happen" — you only SEE it when the text on screen uses the stale page. Fix: `lib/atlasPageVersionGuard.ts` hands every `AtlasPage` a version from one process-wide monotonic counter (the setter ignores the written value, so `version++` still reads-current/writes-unique), wired in `loadTerminalRenderer` at attach AND on `onChangeTextureAtlas` — a swap (Cmd +/-, theme, dpr) hands the renderer a whole new atlas whose versions start at 0 again. Do NOT "fix" this with `clearTextureAtlas()`: it works in Chrome and does NOT in WKWebView (stale units survived it), besides costing a full re-rasterization. Note the atlas is SHARED by every terminal with the same font/theme/dpr (`acquireTextureAtlas`) while each has its own `_atlasTextures` version cache, so one terminal's merges go stale in another's renderer. Reach-ins pinned by `xtermInternals.test.ts`; the collision itself is reproduced by the UNGUARDED control case in `atlasPageVersionGuard.test.ts` — if that control stops failing, the fake has drifted and the rest of the file is passing vacuously. Local stand-in for an upstream fix: xtermjs/xterm.js#6038 is this bug (closed 2026-07-21) and `@xterm/addon-webgl` 0.20.0-beta.300 fixes it the same way (`static AtlasPage.nextVersion`), but npm `latest` is still 0.19.0, so the guard is load-bearing until 0.20.0 ships stable. Tracked in [tech-debt.md](tech-debt.md) entry 4. **Separately, `TextureAtlas._requestClearModel` is set true on the first merge and never reset**, so every terminal sharing that atlas takes the full-viewport `_clearModel(true)` + `_updateModel(0, rows-1)` branch on every frame for the rest of the session. Upstream bug, not ours, but it is why the model is never the suspect when glyphs are wrong.
- **A class-shaped string in a COMMENT, a regex or a DOC is compiled by Tailwind, and only the production build ever says so.** Tailwind v4 scans every file in the project it can reach, which includes `*.test.ts` and the markdown in `docs/`, and it does not care whether the match is code, a comment, or prose about the code. A doc comment that wrote out a container-query hide class with a stand-in where the pixel number goes (the letter N repeated, meaning "whatever number") was compiled into a real rule whose media query contained those letters, and lightningcss rejected the stylesheet with `Invalid media query`. A regex that spells the same class out is the same trap. **This entry was written with the offending string in it and broke the build a second time**, which is the strongest argument there is for the rule: describe the shape in words, or quote a REAL class with a real number, never a template. When a test needs to talk about a generated class, parse the number out and assert on the parts. The broader lesson is the one that cost the time: **`npm test` passing is not the build passing.** `npm test`, `tsc -b` and `npm run typecheck:e2e` were all green through both failures, because the CSS pipeline runs in neither; `npm run build` is the only thing that sees it, and `make beta` / `make release` is where you otherwise find out. Anything touching class names, `@theme` tokens or `index.css` gets a `npm run build` before it is called done, and check its EXIT CODE: piping it into `tail` makes the shell report the exit status of `tail`, which is how a failing build got reported as green here.
- **Every terminal goes black after a long session; restarting the tab is the only cure.** Not a layout bug and not the PTY — the shell is alive and the scrollback is intact, which is precisely why a respawn appears to fix it. WKWebView reclaims GPU resources for a webview it considers idle (sleep, hours in the background, memory pressure), so every WebGL context in the process is lost at once and each addon's canvas keeps compositing its last empty frame. `onContextLoss` used to just `dispose()` the addon: correct as far as it goes (a renderer on a dead context draws nothing) but it leaves xterm on its DOM fallback with no repaint scheduled, so the pane stays black indefinitely. `loadTerminalRenderer` now disposes AND re-attaches a fresh addon (new context, new atlas) on a `CONTEXT_REATTACH_DELAY_MS` beat — asking for a context in the same task as the loss event returns one that is already lost. Budgeted at `CONTEXT_LOSS_MAX` losses per `CONTEXT_LOSS_WINDOW_MS`; past that the GPU is genuinely gone and retrying just black-flashes the pane on a loop, so it stays on the DOM renderer and force-`refresh()`es (the fallback only paints rows marked dirty, and a context loss dirties none — skip the refresh and the give-up path looks identical to the bug). The budget is a SLIDING WINDOW, not a latch — losses age out, so a GPU that recovers later gets WebGL back rather than costing a days-long terminal its fast renderer forever — and every path that attaches WebGL must consult it, not just the loss handler. The wake probe below is the one that bites: it sees a null addon, cannot tell "gave up" from "attach failed", and will happily re-attach into a dead GPU once per app switch unless it checks the budget too. **The event is not guaranteed:** a suspended webview can have its context reaped with no `webglcontextlost` delivered at all, so `focus`/`visibilitychange` additionally probe `gl.isContextLost()` and re-attach on the edge where the user is about to look at the terminal. Do NOT reduce the handler back to a bare `dispose()`. Covered by `terminalRenderer.test.ts`; the `_gl` reach-in is pinned by `xtermInternals.test.ts`. **A RESTORED context is a separate bug with the same symptom, and the one the recovery above is blind to.** xterm answers `webglcontextlost` with `preventDefault()` plus a 3s timer and fires `onContextLoss` only if no `webglcontextrestored` arrives first. When one does, it repairs in place: `removeTerminalFromCache(terminal)` (which disposes the glyph atlas outright when this terminal was its only owner) then `_initializeWebGLState()`, which builds a fresh GlyphRenderer on the new context and never calls `_refreshCharAtlas()`. So `_charAtlas` still points at the evicted atlas, no texture reaches the new context, and the pane draws nothing. The only path that would rebuild it, the `!_isAttached` branch of `renderRows()`, cannot run: `_isAttached` was set true at construction (`screenElement.isConnected` — a display:none pane is still connected) and nothing clears it. From outside, `onContextLoss` never fires (its timer was cleared) and `gl.isContextLost()` is FALSE, because the context genuinely came back: **every signal the recovery is wired to reports a healthy terminal while it paints nothing.** Hence `watchCanvas` binds `webglcontextlost` AND `webglcontextrestored` on the addon's own canvas (`_renderer._canvas`, pinned by `xtermInternals.test.ts`) and rebuilds the addon either way — a fresh context with a fresh atlas is the only state worth reasoning about. Taking the raw loss event also removes the 3s of black the working path used to cost. One consequence: a single dead context is now reported up to three ways, so `recoverFromContextLoss` bails when its addon is no longer the live one, or one GPU blip spends the whole loss budget. Second consequence: `attach()` defers while the pane has no geometry (a process-wide outage hits every mounted terminal at once while at most one is visible; re-attaching them all burns a GL context each to draw nothing, and WebKit caps contexts per process and force-loses the oldest past the cap). A ResizeObserver on the 0 → non-zero edge picks the deferred attach back up, since switching tabs inside termic fires neither `focus` nor `visibilitychange`. **The fourth signal needs nothing from WebKit at all.** Reported on a laptop driven over Screen Sharing with Termic frontmost, caffeinate holding the system awake and the display left to sleep: every Claude pane blank on return, and it never reproduced on a desktop. That setup never blurs the window or hides the document, so the wake probe never ran, and the canvas events had not fired or the pane would have been rebuilt. Whatever WebKit did to the canvas, it did it without a loss, a restore, or `isContextLost()` turning true, so from the outside a blank renderer is indistinguishable from a healthy one. `src/lib/userPresence.ts` stops asking: the first key, click, wheel, focus or visibility edge after `AWAY_MS` without any is a return from absence, and every on-screen renderer rebuilds its addon on it, same task, no flash; a hidden pane is marked stale and rebuilds on its reveal edge, so the keystroke frame pays for the panes that have pixels and no others. The dropped context is released explicitly (`WEBGL_lose_context`, xterm's dispose never does) so a rebuild does not park a live context against WebKit's cap, a rebuild that cannot build an addon at all retries on `ATTACH_RETRY_MS` (1s, 5s, 30s) and then leaves it to the next edge (the field log showed getContext failing on every pane for 30s+ with no loss event first, so WebGL was unavailable for a while, not for a beat; xterm's DOM renderer carries the pane meanwhile), every attach gate lives inside `attach()` so any edge can call it, and the renderer kind is read once at load so a rebuild never applies a pref change the docs promise waits for the next spawn. Not a loss, so it spends no budget. Set `localStorage.ptyDebug = "1"` and the whole sequence lands in the per-PTY log, including a `back after Ns away` line (with isContextLost/paused/visibility/size) for each rebuild. **A FAILED attach leaks a canvas, and enough of them wedge the window permanently (field log 2026-08-23).** xterm's WebglRenderer appends its canvas to `.xterm-screen`, then runs the GL init that throws `value must not be falsy` on a born-lost context, and only after that registers the disposable that would remove the canvas — so the throw strands a canvas holding a live context that even `dispose()` cannot reach. Past WebKit's per-process context cap every later `getContext` is born lost too, retries included: one GPU outage plus eight panes retrying became dozens of leaked contexts, every fresh terminal failing its attach at spawn, and blank panes on BOTH renderers until a reload. `attach()`'s catch now diffs `.xterm-screen`'s canvases, force-releases each leaked context (`WEBGL_lose_context`) and removes the canvas, so a failed attach costs nothing. Covered by the "failed-activate canvas leak" block in `terminalRenderer.test.ts`.
- **A view "can't scroll", and its list just runs off the bottom of the window.** `flex-1` only means anything to a FLEX parent. MainArea mounts the full-screen views (History, Dashboard) inside a plain `absolute inset-0` overlay, which is a block box — so a view whose root is `flex-1 flex flex-col overflow-hidden` sizes to its CONTENT, not to the overlay, and the `flex-1 overflow-auto` scroller inside it never gets a bounded height to overflow. Nothing clips and nothing scrolls: the archive simply extended past the bottom edge and the rows down there were unreachable. Fix in the view, not in MainArea: the root takes `h-full` (definite height from the overlay's `inset-0`) and the scroller adds `min-h-0`, since a flex child's `min-height: auto` otherwise refuses to shrink below its content and re-creates the same overflow one level down. Dashboard was always fine because it uses `h-full overflow-auto` on its root. Assert it as geometry (`root.height === parent.height`, last row reachable after scrolling), never as a class name.
- **Code shows through the line-number gutter when you scroll right (GH #161).** CM6 makes `.cm-gutters` `position: sticky` with `z-index: 200` and the content a flex *sibling*, so a long line slides underneath it by design — the gutter's own opaque background is the only thing hiding it. CM6's base theme paints one for exactly this reason (`#f5f5f5` light / `#333338` dark), and `editorSurfaceTheme`'s "force every surface transparent" sweep had clobbered it, which also let the selection wash (z-index -1) and caret layer (150) bleed through. Fix: the gutter paints `var(--color-bg)`, matching what all four mount hosts paint. `!important` is load-bearing — every `@uiw` syntax theme sets `gutterBackground` at equal specificity, and CM6's `.ͼ-base.cm-dark .cm-gutters` is *higher*. Do NOT "fix" it with `background-color: inherit`: the chain up through `.cm-scroller` / `.cm-editor` is all `transparent !important`, and DiffPane's CodeMirror parent sets no background at all, so it resolves back to transparent and the bug returns silently in the diff viewer.
- **A brand-new agent tab, closed and reopened before the first prompt, comes back with "No conversation found".** termic mints the session uuid and passes it as `--session-id <uuid>`, but the CLI only writes that session to disk once there IS a conversation. Persisting the uuid at spawn time (the old `RESUME_FAILURE_MS` timer did) meant the next spawn passed `--resume <uuid>` for a session file that never existed, and the agent refused to start from it. `TerminalPane` now holds the minted uuid in `pendingSessionUuidRef` and persists it on the FIRST real submit (keyboard Enter or a broadcast stamping `lastInputAt`), which is the same moment the capture-based agents (opencode) harvest theirs. A tab closed before any prompt therefore stores no session id, which is correct: there is nothing to resume.

- **Anything termic shells out to must get `shell_env::spawn_env()`, and `sh -lc` is NOT a substitute (GH #243, GH #181).** A GUI-launched `.app` inherits launchd's bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), and `-l` only sources bash's profile chain, never `~/.zshrc` or `~/.zprofile` where Homebrew, nvm, volta and opencode's own installer put their PATH export. So `sh -lc "opencode session list"` is `command not found` from the shipped app and works from every `npm run tauri:dev` you test it in. This has now bitten three sites for the same reason: CLI detection (a freshly installed agent stayed invisible across relaunches, 8b03dbf), the find-in-files backend (#181), and `run_capture_command`, where the damage was invisible because an empty capture is indistinguishable from "the agent hasn't created a session yet" — opencode tabs silently never stored a session id and started a fresh conversation on every relaunch. Use `shell_env::spawn_env()` (PATH + the rc delta, one snapshot) for a spawn, `shell_env::resolved_path()` when you only need PATH, and pass `-c` rather than `-lc` once you have: re-sourcing the profile chain on top of an injected env only risks re-stripping it.

- **A sidebar folder stuck on "Loading…" forever (GH #159).** The tree's settle reload (`FileTree.tsx`, driven by `fsRevision`) re-read root + every expanded dir, dropped the ones whose read rejected, and then REPLACED the whole children map with what was left. `task_dir_list` rejects on a transient miss (`safe_task_path` canonicalizes, so a dir that is momentarily absent while a build or a generator rewrites it is ENOENT), which is exactly the moment the reload fires. The dir stayed in `expanded` with no listing, nothing in flight, and no retry, and the row rendered "Loading…" off `isOpen && !kids` alone, so a dropped listing looked identical to a slow read. Three separate paths could produce that state (the failed reload, a folder expanded WHILE a reload was in flight and clobbered by the replace, the same drop-on-failure shape in the mount effect), so the fix targets the state, not the trigger: reloads MERGE into the cache (`mergeReload` keeps a failed dir's old listing and anything expanded mid-flight, prunes only what was collapsed), and a reconcile effect enforces the invariant that every expanded dir has a listing, a read in flight, or a `failed` mark. A read gets one automatic retry, then the row says it failed and offers a retry rather than spinning. Logic in `lib/explorer/dirCache.ts` so it is unit-testable: there was never a repro, the argument is the state machine.
- **A terminal that starts blank because its first bytes were emitted to nobody.** `pty_spawn` starts the reader and flusher threads before it returns, and the webview can only call `listen("pty://<id>")` after the spawn round trip resolves. Tauri events have no buffering: everything emitted in that gap is dropped silently. A CLI that paints a banner plus one OSC title at startup and then blocks on stdin (every agent fixture, and real agents at their first prompt) can lose BOTH, leaving an empty terminal and a tab with no live title, permanently, because nothing ever repaints. It reproduced as an Activity-spec flake on a loaded CI runner, where the spawn round trip lost its race with `bash`. The fix is an ack: `pty_attached` flips a flag under the reader/flusher buffer mutex, and the flusher holds its first emit (`wait_for_attach`) until then, or 3s, whichever comes first. **A new `pty_spawn` call site must send the ack**, see [docs/ipc.md](ipc.md).
- **A file-tree error a user cannot report (GH #250).** The retry row above shipped saying only "Couldn't read this folder", which is exactly as diagnosable as the "Loading…" it replaced: the report that followed had a screenshot and nothing else. The tree now keeps the rejection message (`failed` is a `Map<rel, message>`, not a `Set`) and the row renders it through `lib/explorer/dirError.ts`: a headline ("Permission denied", "This folder links outside the task") plus the raw Rust error underneath and in the title. The Rust side names the path in every `safe_task_path` / `read_dir` error, so an ENOENT says WHICH path went missing, and a containment rejection says where the symlink pointed. **Anything that surfaces a `task_dir_list` rejection to the user goes through `explainDirError`** (the sidebar tree and `DirListingPane` both do), or the next report is a screenshot of a sentence again. Note the class the message makes visible: a folder that is a symlink out of the task lists as a directory but can never be read, so its retry is hopeless by construction, and it is the most likely thing behind a permanently failing folder in a real repo.
- **We linked `.claude/` into the worktree, then refused to read it (GH #250).** The self-inflicted case of the trap above, and the one the report turned out to be. `link_config_dir` symlinks `.claude/`, `.gemini/`, `.codex/` (`Settings.worktree_symlink_paths`) from the repo root into every new worktree *because they are commonly gitignored*, so `git worktree add` leaves them out and an agent spawned there would lose its project subagents and skills. `safe_task_path` then canonicalizes and rejects the very link we created, so the folder listed and never opened, in the editor as well as the tree. Reads now go through `safe_task_read_path`, which falls back to allowing a symlink **at the task root** whose target resolves inside the **project** root. Three things that bound it, all pinned by tests: it is a FALLBACK (anything that resolved strictly still does, unchanged), only a link at the task root qualifies (one buried in the repo does not widen anything), and a link leaving the project — the `\.claude -> ~/.ssh` case the check exists for — is still refused. **Read paths only**: `task_path_rename`, `task_path_delete` and every git path keep the strict check, so nothing can mutate the main checkout by writing through a link from a worktree.


- **A second window's `invoke` works, but every plugin call in it silently fails.** `capabilities/default.json` is scoped `"windows": ["main"]`, so a window created at runtime (the Activity monitor's `procmon`) is granted NOTHING from the ACL. App-defined `#[tauri::command]`s are outside the ACL and keep working, which is what makes this confusing: the feature's own IPC is fine while `data-tauri-drag-region`, `startDragging`, window close-from-JS and every other `core:*` / plugin permission are denied. Symptom is a dead drag region rather than an error. Either add the new label to the capability's `windows` array or design the window not to need one — the Activity window keeps its NATIVE title bar, so there is nothing to drag-region.
- **`pbsi_comm` is 15 characters, not 16, so `"com.apple.WebKit"` never matches anything.** `MAXCOMLEN` is 16 INCLUDING the NUL, so libproc's short-info comm for every WebKit XPC service arrives as `"com.apple.WebKi"` with the trailing `t` already gone. Comparing against the full name found zero candidates, which read as "this Mac has no webview processes" rather than as a string bug (and left the Activity monitor under-reporting Termic's own memory by ~100 MB with no error anywhere). Match a PREFIX. The truncation also means comm cannot tell WebContent from GPU from Networking — they are all the same 15 bytes — so the label has to come from `proc_pidpath`.
- **macOS makes the TERMINAL responsible for a binary you launched from a shell.** `responsibility_get_pid_responsible_for_pid` is the only supported way to attribute WKWebView's XPC sidecars (they are children of launchd, so no ppid walk can find them), and it is exactly right for a bundled app: `/Applications/Termic.app` reports itself, and its WebContent process reports the app. Run the same binary from a terminal and both report **iTerm2**. So the strict test (`responsible == our pid`) silently attributes nothing in dev, and the loose one ("same responsibility group") would attribute every WebKit app anyone launched from any terminal window to Termic. `procmon` keeps the strict test and reports `webkitUnavailable` when it finds sidecars it cannot prove are ours, so a dev build says "webview processes not attributable in this build" instead of quietly reporting a smaller number. Measured before choosing, with a ctypes probe against both a bundled and a shell-launched instance.
- **A freshly created Tauri window appears in `getWindowHandles()` before its document loads.** A single scan for the new window by `location.href` therefore finds `about:blank` and misses it, which fails as "the window never opened" while the window is plainly on screen. Poll the lookup (`waitForActivityHandle` in `e2e/specs/activity.e2e.ts`), do not scan once.

- **A `termic://` link opens the OTHER Termic and does nothing.** Only reproduces with `make beta` installed, and it is not the link. Both bundles register the scheme on purpose (one link, whichever app is open) and they are mutually exclusive, so LaunchServices sometimes launches the bundle that is NOT holding the socket. That process used to raise the owner and `std::process::exit(0)` inside `setup` — before the URL had arrived. On macOS the URL is never in `argv`; AppKit delivers it as an Apple Event that only lands once the run loop turns, and `tauri-plugin-deep-link` records it solely from `RunEvent::Opened`, so `get_current()` in `setup` is always `None` there and the link died with the process. `handoff_deep_link_then_exit` (`lib.rs`) now returns from `setup` with no window, goes `ActivationPolicy::Accessory` so the doomed process takes no dock slot and steals no focus, polls the plugin for 1.5s, forwards over the socket and exits either way. **The general trap: on macOS nothing you need from the run loop is available inside `setup`.** If a launch decision depends on it, defer the decision, do not sample it early and find it empty.
- **A second command name for the same socket is a lie, not a convenience.** `make beta` used to install `termic-beta` next to `termic`. Same binary, same data dir, same socket, same single instance — so `termic-beta` drove the SHIPPED app whenever the shipped app was the one running, while its name said otherwise, and nothing anywhere reported the mismatch. There is one release command now (`install_name`), and `reconcile_link` migrates a leftover on launch. Before adding a flavored name, check whether the flavors actually address different things; if they resolve to the same endpoint, the name is decoration over an ambiguity.

- **An upgrade gated on the new state can never perform the upgrade.** `agent_hooks_sync` skipped any agent whose `status().installed` was false, and `installed` is an ALL over the CURRENT event set, so adding `SessionStart` to claude made every existing claude install read as not-installed and therefore ineligible for the sync that would have added it. Agents whose sets had NOT changed upgraded fine, which is what makes it so quiet: the feature looks like it works. Gate an unattended upgrade on CONSENT (`ours_present`: any entry of ours, safe because `remove` deletes them all), never on conformance to the state you are trying to reach. The unit suite was green throughout, because every piece was right and only the pair was wrong.
- **A self-upgrade mechanism that nothing calls is worse than none, because the docs describe it.** `agent_hooks_sync` shipped complete: versioned schema, staleness detection, in-place replacement, a Rust doc comment arguing why the user should not have to press a button, and a TypeScript type comment promising installs are "kept up to date automatically by `agentHooksSync`". Nothing invoked it, for two schema bumps. Every existing install stayed pinned at its original version while reporting `installed: true`, so the v3 fix for hooks being DEAD inside Docker reached only new installs. Nobody noticed because every layer described the intended behaviour and the missing piece was one call. When a mechanism has a version number, grep for its call site before trusting it, and pin the wiring in a test rather than the mechanism alone.
- **Typing into an agent that has "painted and gone quiet" can KILL it, not just lose the prompt.** claude shows `Is this a project you created or one you trust?` for a repo it has never run in. Trust resolves through the REPO, not the directory, so a worktree of an already-trusted repo inherits it and never prompts (measured both ways, after the opposite was assumed): the exposure is the FIRST task in a newly added project, not every task. The picker paints and then goes quiet, which is byte-for-byte what a waiting input box looks like, so `waitForAgentReady` returned `settled`, `seedPromptWhenReady` typed the first message into the picker, and the submit 450ms later confirmed the HIGHLIGHTED option, which is `No, exit`. Measured: one injection at termic's own 3s floor, agent gone. No hook fires while the picker is up, not even `SessionStart`, so the absence of a readiness signal is itself the signal. Two defences, and both are needed because agents without hooks get no signal at all: `SessionStart` registered as `Signal::Ready`, and `deliverMessage({ verifyEcho: true })`, which withholds the submit unless the agent echoes what was typed (an input box echoes, a selection list does not). **A retry loop is not a fix here** and makes it worse: the first attempt lands before the dialog is interactive and is swallowed, the retry lands on a live picker and presses Enter. Never retry an injection without a positive signal that the agent is reading.
- **agy's trust dialog is per exact PATH, so termic pre-trusts it.** Unlike claude, agy (1.4.6) asks for every new directory, worktrees included: `trustedWorkspaces` in `antigravity-cli/settings.json` is an exact match, and a trusted parent does not cover a child (measured). No flag or env var skips it, not even `--dangerously-skip-permissions`. The dialog has no input box, so a prompt sent by another agent was withheld by the echo check and lost. `pty_spawn` now adds the canonical cwd (the container path in Docker) to the list in whichever `.gemini` that spawn reads (`trust_agy_workspace`); it only ever adds, and leaves a file it cannot parse alone. The same agent also lost every FIRST prompt (`task_new -p`, `tab -p`) for a second reason: `hooksOwnStartupReadiness` was "hooks installed, minus codex", so agy's installed hooks made the seed wait 20s for a ready event agy has no hook for, then drop it as `blocked`. It is now an allowlist of the agents whose `hooks_for` registers `Signal::Ready` (claude, devin), and a hooked wait that hears nothing by the deadline falls back to `settled` when the agent is quiet: still picker-safe, because every non-`ready` outcome is typed with `verifyEcho`.

- **An agent CLI's own policy layer can outrank the flag Termic passes, and it
  kills the spawn rather than downgrading it (GH #274).** codex 0.15x merges a
  MANAGED requirements layer on top of your config:
  `/etc/codex/requirements.toml`,
  `/etc/codex/managed_config.toml`, macOS MDM managed preferences
  (`config/src/loader/macos.rs`), and `cloud_requirements` pushed by the ChatGPT
  org a work account belongs to. If any of them forbids `danger-full-access`,
  Termic's shipped codex `yolo_args`
  (`--dangerously-bypass-approvals-and-sandbox`) makes codex exit at startup
  with ``approval_policy = "never" cannot be used because requirements do not
  allow sandbox_mode = "danger-full-access"``. It reads as "the Termic update
  broke codex" because the error names Codex config and nothing points back at
  the Settings field that passed the flag; the reporter's machine was the only
  one affected precisely because it was their WORK machine. Nothing on the
  Termic side changed: the flag has been the codex default since the initial
  commit (`73fe81c`), and no migration in `load_settings` re-seeds `yolo_args`.
  Do NOT change the shipped default to dodge this. The flag's own help text
  says it is "intended solely for running in environments that are externally
  sandboxed", which is exactly Termic's model (seatbelt or Docker is the real
  boundary, see [sandbox.md](sandbox.md)). The intent-preserving per-agent
  override is `-a never -s workspace-write`: still no approval prompts, codex's
  own workspace sandbox instead of none. Clearing `yolo_args` altogether also
  starts codex, but leaves the YOLO toggle reading as on while doing nothing.
  `YOLO_ARGS_NOTES` (`src/lib/agents.ts`) is where that caveat is surfaced in
  the Settings hint, keyed by `builtinBaseId` so clones get it too. Verified on
  codex-cli 0.153.0: the flag works with no managed layer present, and a
  repo-local `.codex/requirements.toml` is NOT one of those sources (only the
  managed paths above count), so this cannot be reproduced without root or an
  org account.

## A row button that stops only `click` still fires the row's dblclick

The Git panel's file row stages on `onDoubleClick`, so a button inside it
that calls `e.stopPropagation()` in its `onClick` is only half-guarded: the
first click is contained, and the `dblclick` event that follows the second
one bubbles to the row and mutates the index. A read-only control (Open
file, the mark-as-viewed eye) then stages or unstages the file as a side
effect of being double-clicked, which nothing in the UI suggests.

`click` and `dblclick` are separate events, so containing one says nothing
about the other. Any button living inside a row that acts on double-click
needs `onDoubleClick={e => e.stopPropagation()}` as well. The eye shipped
with this hole and it went unnoticed until the Open file button was added
beside it and a reviewer asked what a double-click there would do.

## Korean IME input can delete preceding text

For modeless Korean input in WKWebView, xterm 5.5 drops `insertText`
with `composed: true` between an IME `keydown` and DOM `keyup`.
Advancing the bridge's baseline without sending that jamo makes the next
replacement delete preceding PTY text.

`src/lib/ime.ts` forwards the missed insert and keeps `computeImeDelta`
unchanged. Native composition and its trailing commit stay with xterm to
avoid duplicates. IME confirmation Enter preserves the baseline.

Reproduction can depend on IME process state: restarting `KIM_Extension`
exposed the bug in a previously working Termic window. Compare builds after
resetting that state and type jamo; a different app ID or pasted text is not
an equivalent test.

## Two `invoke`s in a row are not two writes in a row

`ipc.ptyWrite` is ordered per PTY (`src/lib/orderedSend.ts`), and has to be.
xterm and the IME bridge both write the same PTY, each with its own
`invoke`, and back-to-back requests are not guaranteed to be handled in
call order. The Windows e2e log showed it plainly: the bridge's `DEL` +
syllable arrived after the Enter that was sent later, so the line was
submitted without it and the syllable opened the next prompt. Only seen on
WebView2 so far, and only when the calls are microseconds apart, which an
IME replacement followed by Enter is.

The wrapper sends immediately when nothing is in flight for that PTY, so an
idle terminal pays nothing per keystroke. Do not bypass it with a raw
`invoke("pty_write")`, and give any new byte path to a PTY the same
treatment.

## A dead agent can be told it is working

`term.write` does not parse in the task that calls it. The last chunk a
process printed is queued, the `pty-exit` handler runs and sets the tab
idle, and THEN xterm parses the chunk and fires `onTitleChange` with a
spinner title. That re-armed `working` on a tab whose process was gone, and
nothing can end that turn: every signal that would comes from the process.
`goWorking` (and the submit-window promotion) now refuse while
`ptyRef.current` is null. The mechanism is inferred from the code and a CI
failure of "an agent that exits mid-turn" (both badges still `working`
after the exited banner was up); it did not reproduce on demand.

## React/Zustand traps

- Don't return new objects/arrays from selectors without memo. Use frozen constants for defaults.
- Async setup in `useEffect` with cleanup — never in component bodies.
- Effect deps: stable IDs (`ws.id`, `tab.id`), never ws/tab objects (identity changes every patch).
- StrictMode is off. Audit before re-enabling.
- **Selecting a task is not a neutral pointer move, and `setActiveTask` replaces `view` rather than spreading it.** `activeTaskId` is how the app decides you have SEEN something, so `setActiveTask` also clears `unread` on every tab of the task, demotes the active tab's `done`/`working` state, resets the departing tab's activity timestamps, force-expands the parent project AND its sidebar group (a `localStorage` write each), and reorders `recentTasks` (a third) — three store writes in total, not one. On top of that it returns `view: { page }` built fresh, so `settingsOpen` / `settingsTab` / `settingsRepoId` are dropped and the Settings overlay closes as a side effect. Anything that moves through tasks WITHOUT the user having looked at them must not go through it: the ⌃⇥ walk uses `previewPlace`, which writes only the pointers that decide what is on screen, in one guarded `set()`, and runs the real setters once on landing. See [shortcuts.md](shortcuts.md).
- **`visible` is not `ownsFind`, and a pane claiming anything global needs the stricter one (GH #71).** MainArea keeps every visited task mounted, and TaskView keeps every tab's content mounted, so "is this laid out" is a per-task answer that several components say yes to at once. A window keydown listener is the usual casualty: the markdown preview's ⌘F handler is capture-phase and stops propagation, so a background task's mounted preview claiming it doesn't just open a stray bar, it swallows the key from the terminal's search overlay and CodeMirror. `TaskView` computes both flavors: `tabActive` (per task, fine for a pane that only focuses itself) and `ownsFind`, which additionally ANDs in "this task is up front" and `focusedTabId()` for the focused split pane. Store state gets you only that far, and the naming matters — a prop called `active` on the preview next to an `active` on the sibling panes is an invitation to widen it back. Two things it cannot answer, both handled in the preview's own listener: (1) the bottom split (⌘J) and the right panel are not in the split tree at all, so a focused AuxTerminal or panel input is invisible to it — check `activeElement.closest(".xterm, .cm-editor, input, textarea")` and stand down; (2) a modal leaves the tab underneath still `ownsFind`. Modals need covering twice over: `document.activeElement.closest('[role="dialog"]')` catches Radix dialogs that trap focus (hence `!trap.contains(container)`, since the Changelog dialog hosts a preview of its own), but the hand-rolled Settings overlay traps nothing and autofocuses nothing, so `activeElement` never enters it and only the store flag sees it. `role="dialog"` on that overlay is still right for screen readers, it just isn't load-bearing here.
- **A retry loop that only advances on `requestAnimationFrame` never runs on an occluded window.** WebKit freezes rAF when the window is fully covered, on another Space, or minimized — and a retry loop is exactly the code that gets there, because its first attempt is the one most likely to fail (the store update that scheduled it has a React re-render still pending, so the target is often `display:none` for that instant). `lib/tabFocus.ts` retried its focus attempts across frames and so gave up silently: expanding the bottom split left the caret in the agent above it, keystrokes went to the wrong terminal, and `agent.e2e.ts` failed with focus parked on the wrong `.xterm-helper-textarea` while every DOM check said the target was visible and focusable. Retry on a **timer** instead — a macrotask runs whether the window is on screen or not, and at ~16ms it is the same cadence when it is. Note `document.visibilityState` will NOT tell you this is happening: an occluded window still reports "visible". `CommandPalette`'s deferred `act()` and the e2e `mouseDrag` helper avoid rAF for the same reason.
- **An unmount flush must ask whether the thing it is flushing still exists (GH #244).** A scratchpad's buffer is written on a ~500ms debounce, and `EditorPane` also flushes on unmount so the last few hundred milliseconds of typing survive a tab or task switch. Closing a pad with **Discard** deletes the record and THEN unmounts that editor: an unconditional final write recreates the pad the user just threw away, and it comes back on the next launch. The flush therefore re-reads the tab from the store first and only writes while it is still `type: "scratch"` — which covers promotion too, since promoting changes the tab's type. The same shape applies to any "save on the way out" path whose subject can be destroyed by the very action that unmounts it.
- **Never set `preview: true` on a scratchpad tab (GH #244).** `openPreviewTab` recycles the first tab in the strip carrying that flag, resetting its `syntax`/`syntaxAuto` and retargeting it at a file. Do that to a pad and the buffer is silently swapped for someone's README, with no prompt, because from the recycler's point of view a preview slot is disposable. Pads are created without the flag and `patchTab` clears it on the first dirty write anyway; the rule is that nothing may set it back.
- **A shared persisted namespace may only be pruned by something that can see ALL of it (GH #248).** `store/fileViewed.ts` keys "mark as viewed" by `taskId → path`, and three call sites read it, each seeing a different slice: the Git panel lists UNCOMMITTED files, the Compare panel lists a whole branch diff, and `DiffPane`'s compare walk looks up files `git status` never returns at all. The Git panel pruned the map against its own list, which looked like obvious housekeeping and was in fact a wipe: the moment an agent COMMITTED, its uncommitted list emptied and every Compare mark for that task went with it, including files the agent never touched. It presented as "reviewing is randomly reset after an agent run" and was hard to pin down because the trigger is the commit, not the edit. The rule: an entry may expire on its OWN evidence (here, the file's `mtime:len` fingerprint moving, which is per-file and needs no list), and the whole namespace may be dropped when its OWNER dies (task archived/deleted, pruned in `app.loadAll` next to `useRace.prune`). Anything in between needs a list nobody has. Pinned by `store/fileViewed.test.ts`, including the empty-working-tree case.
- **A controlled `<select>` whose value matches no `<option>` does not render blank, it silently re-points at the first option.** React's `updateOptions` falls back to the first non-disabled option when nothing matches, so the control confidently displays a value the app was never set to, and the next pick saves that lie over the real one. Settings → Projects → More → **Default CLI** is the live case: it stores an agent id, the agent registry it names is edited on a different page (renamed, removed, disabled), and a stale id made the page claim the project defaulted to whichever agent happened to be first. Proven in the real window, not reasoned about: with `default_cli` set to a missing id the select read `claude` while `projects.json` said otherwise. Reordering the registry does NOT do this (the select re-applies its value on every commit, and the pills are keyed by id) — that part of the report did not reproduce. The fix has two halves and both are load-bearing: render an explicit option for the SAVED value whenever the list does not offer it, so display always equals storage; and keep the stored value valid at the source, so `AgentsSection` repoints every project pinned to an agent it renames or removes. Pinned by the three cases in `settings.e2e.ts` ("project default CLI vs the agent registry"). Any other `<select>` bound to a user-editable list has the same hole.
- **A hook below an early return takes down the whole page it lives on, not just its own row (GH #245).** `RepositorySection` early-returns a placeholder when no project is selected (`if (!project || !draft) return …`), ~170 lines above where its per-field helpers are defined. Adding `const globalBrowser = useApp(s => s.previewBrowser)` next to the helper that used it put a hook *after* that return, so the hook count changed between the no-project and project renders and React tore the component down. The damage is not local: the Settings overlay hosts one section at a time, so a crash there took out Repositories, the tasks-path fields and the named-ports editor as well, and the e2e run reported **seven** failures in unrelated settings specs plus two in the new one. Nothing pointed at the new field. The tell is that a cluster of specs covering *different features on one page* all start failing at once in the same commit; treat that shape as "something on this page throws during render" and look for a hook that moved below a return, not for seven separate regressions. Put every hook at the top with the others even when its only consumer is far below.

## A resolution fallback is a swallowed failure wearing a helpful face

`resolve_base_ref` answered `"HEAD"` for anything it could not resolve, so a
`termic new --base <garbage>` exited 0, printed `(from <garbage>)`, and cut
the worktree from the MAIN CHECKOUT'S HEAD. Three failures compounding: a
script cannot detect it, the reported state contradicts the actual state, and
the worktree holds code nobody asked for. Reported by someone running four PR
reviews in four worktrees, whose agent reviewed an unrelated branch and said
so confidently; they found it by running `git log` in the worktree by hand.

The fallback is not wrong everywhere, which is why it survived: a STORED base
legitimately falls back (a local-only repo pinned to `origin/main` has no
remote-tracking refs and must still open a task). It is wrong for a ref a user
just typed. `try_resolve_base_ref` returns `Option` and `resolve_base_ref`
keeps the fallback on top, so the two callers are forced to say which they are.

The second half is that the resolution was also incomplete. A BARE name that
exists only as `refs/remotes/origin/<name>` did not resolve: `git checkout
<name>` DWIMs it, `git rev-parse --verify <name>` does not. That is the common
case, not an edge one, because `gh pr view <n> --json headRefName` returns a
bare name. Note the guard that looks obviously right and is not: a branch name
routinely CONTAINS a slash (`feature/pr-1`), so gating the DWIM on "is it
unqualified" skips exactly the branches people file PRs from. Caught by the
test, not by review.

**A test here passes for the wrong reason unless the fixture base is
deliberately NOT the main checkout's HEAD.** With the bug present, a worktree
cut from HEAD equals a base that happens to be HEAD, and the assertion is
green on the broken code.

## "Fresh" caches that are fresh by age and stale by content

- **The CLI's per-tab snapshot (`resolve_tab_selector`).** The webview reports
  tab state into an agent cache the CLI server reads, and the resolver treated
  the snapshot as authoritative whenever `snap.age <= CACHE_STALE_AFTER`. Age is
  not content: a tab created a second ago is inside the freshness window and
  absent from the snapshot. So `id=$(termic tab ...); termic logs --tab "$id"`
  answered "no tab matches" for an id the CLI had printed a moment earlier, and
  the durable fallback that would have resolved it was only consulted when there
  was NO snapshot at all. An exact id now falls back to `persisted_tabs` even
  with a live snapshot present; index and title still require the live strip,
  which is honest, because they cannot be reconstructed from the record.
- **The general shape.** Any cache whose validity you express as an age answers
  "is this recent" when the question was "does this contain X". If a caller can
  learn an identity from one code path (a create that writes to disk) and then
  use it through another (a read that consults a cache), the cache needs a miss
  path to the durable source, not a longer TTL.

## Split restore invariants

Two things must hold after `ensureDefaultTab` restores a task, and neither is guaranteed by the persistence rules on their own:

**A task always owns at least one MAIN tab.** `moveTabToPane` already refuses to empty main ("main must keep at least one tab"), but that guard counts LIVE main tabs and a plain shell satisfies it. Main-panel shells are deliberately not durable (no session to resume) while split-pane shells ARE, so moving the only agent into a pane and leaving a shell in main persists nothing for main: the guard holds all session and breaks on reopen. The restore path `return`s before the seed path at the end of the function, so it seeds the default tab itself when `restoredMain` comes back empty. Seed BEFORE `active` is derived, or main gets a tab while `activeTab` stays `""` and the pane still renders blank.

**A restored split never has an empty leg.** `pruneLeafTabs` drops ids that no longer exist but leaves the leaf standing, so a pane whose tabs did not come back would restore as a blank half of a split that no user action created and only closing the pane by hand clears. `dropEmptyLeaves` collapses those (the main leaf is exempt: it holds no `tabIds` by design, its content mirrors `activeTab[taskId]`). If that leaves a single pane, restore unsplit rather than as a one-legged tree.

Related sharp edge, not currently handled: `restoredPaneTabs` is only built inside `if (task?.split_layout)`, so a durable pane tab whose layout failed to save is discarded even though its data is sitting in `persisted_tabs`.

## An agent notification does not mean the agent wants you

termic spoofs `TERM_PROGRAM=iTerm.app` to the PTY, so an agent that supports
iTerm2's notification channel picks it and sends every notification as OSC 9.
That is more than the ones that ask for the user. claude 2.1.251 has eleven
`notificationType`s and only five mean needs-you; `agent_completed` sends
`` `${label} finished` `` when a turn SUCCEEDS.

termic badged all of them, so a finished task rang the needs-you bell. It read
as an intermittent "random bell" rather than a reliable wrong badge, because
claude suppresses that notification for an interrupted or self-driving turn and
only sends it on a band change. Intermittency is a reason to go read the
agent's own code, not a reason to call it a race.

`BUILTIN_NOTIFY_ATTENTION` in `src/lib/agents.ts` is therefore an ALLOW-LIST
per agent, checked before the ignore list: for claude, a body has to say
"needs your" or "needs permission". A deny-list cannot hold, because the
failure mode is a notification type the vendor adds LATER, which is exactly how
this one arrived. With an allow-list a new type is silent until someone looks
at it; with a deny-list it rings.

The user's own `capabilities.signals.attention` still outranks both, and an
agent with no built-in allow-list stays permissive: for those, a notification
really does just mean the agent wants you.

## Custom agent work-done detection (#68)

An agent's working / done / needs-you state is classified from the fastest reliable signal available. For a CUSTOM CLI, use the highest tier it can emit:

- **Tier 1 - OSC signals (most reliable, zero config).** If the agent emits `OSC 9;4` (ConEmu progress), `OSC 133;D` (FinalTerm command-done), `OSC 9` / `OSC 777` (notifications), or `BEL` from an idle state, work-done detection already works with no setup. Prefer this if you control the agent.
- **Tier 2 - title regexes.** Settings, Agents, then the Done / Busy / Attention signal fields: one regex per line, matched against the agent's `OSC 0/2` title. When any list is set it drives classification (the built-in claude/codex heuristics are the fallback for empty). Precedence: **attention > busy > done**. Invalid patterns are flagged in the UI and ignored, never crash the terminal. The claude/codex heuristics live in `BUILTIN_TITLE_SIGNALS` as regex sources, are what the classifier actually runs, and are shown as the placeholder in those fields, so an empty field displays what runs today. Anything added there must stay correct when pasted in as user signals: user patterns are evaluated busy-before-idle, which is why claude's busy source excludes `✳` even though the old inline code (idle-first) did not have to.
- **Tier 2b - "still working" screen patterns.** The Done/Busy/Attention fields all read the TITLE, and some agents end their turn while work continues, so the title honestly says idle and no byte-stream signal disagrees. Claude does this whenever it backgrounds a subagent: measured, a done badge held for 617s while three subagents ran, with the title on `✳`, no OSC 9;4, no bell, and a notification byte-identical to the one it sends when genuinely blocked. The only dissent is the agent's own words on screen (`Waiting for 3 background agents to finish`). Settings → Agents → "Still working" holds regexes matched against the BOTTOM `PENDING_TAIL_ROWS` (8) rows of the viewport; while one matches, `fireDone` bails without spending the one-done-per-submit token and RETURNS FALSE, so the 3s interval demoters re-test and the real done lands on the first tick after the line clears. That retry is the whole design and it only works if every caller honors the `false` (see "A held done still has to land"). Not a fourth state (a match means plain busy) and not a reuse of the busy list, because patterns are input-specific: claude's busy title source `^\s*[^A-Za-z0-9\s✳]` matches nearly every line it draws. **Positional on purpose** — that status line stays in the scrollback long after it stops being true (measured on screen 120s after the agent finished), so an anywhere-in-viewport match would pin the tab to working until the 10-minute ceiling.
- **Tier 3 - output-line scan (opt-in).** The "Also scan output lines" toggle matches the same patterns against stdout LINES, for CLIs that print status but set no title. Higher cost on chatty agents; off by default, and read at spawn, so it needs a terminal restart to take effect. Lines break on CR *or* LF (a status line repainted with a bare `\r` never sends a newline), are ANSI-stripped, and are length-capped.

`work_done: false` still disables the whole machine (badge, bell, notification) for an agent. The classifier lives in `lib/agents.ts` (`classifyAgentTitle`, unit-tested); Tier 3 scanning is in `TerminalPane`'s data sink.

### Recording what an agent actually emits

Before writing a pattern (or concluding an agent signals nothing), record it. Three localStorage flags, all read at spawn, so set them in the webview console and then restart the terminal:

- `debugWorkDone = "1"` — state-machine narration to the console: every transition with its reason, plus unrecognised OSC ids.
- `ptyDebug = "1"` — per-PTY log to `OS_TEMP_DIR/termic-pty-<task>-<cli>-<ptyId>.log` (find the dir with `python3 -c 'import tempfile; print(tempfile.gettempdir())'`). Timestamped, with `data` chunks truncated at 500 B.
- `ptyDebugRaw = "1"` — implies `ptyDebug`, and makes the log lossless: chunks logged whole, plus a `raw-OSC` / `raw-DCS` / `raw-APC` / `raw-PM` / `raw-BEL` line for **every** control sequence (`lib/ctrlSniffer.ts`). Use this one for signal archaeology. The other two both lie by omission in the same direction: the 500 B cap slices the trailing escape off a full TUI repaint, and the `debugWorkDone` sniffer skips the ids we already consume (0/1/2/9/1337) and only matches sequences that land whole inside one chunk, so "the agent emitted nothing" and "one of our handlers ate it" look identical.

The log holds verbatim terminal output. It is local and opt-in, but delete it when you are done.

**Joining a recording to ground truth.** Deciding whether a `done` was *false* needs a second, independent timeline; the log alone only says what we decided, not whether we were right. The `spawn` line carries the join keys: `t0` / `t0iso` (every later `+Nms` is relative to it) plus `session` and `cwd`. Claude appends its transcript to `~/.claude/projects/<cwd-with-/-and-.-as-->/<session>.jsonl` in real time, and termic minted that uuid via `--session-id`, so the pairing is exact rather than inferred. Line up our `state→done` against the transcript's message timestamps and a premature done becomes a measured gap: fired at `T`, turn actually ran until `T+n`, and the transcript says what was running in between (a `Task` tool call, for instance). Codex and opencode have no equivalent stable pairing, so for those the transcript oracle is unavailable and the log stands alone.

### Notifications (OSC 9 / OSC 777) are attention, not done

An agent asking the terminal to notify is asking for the user, so these raise **attention** and carry their verbatim body to the OS banner via `unread.message`. Three things they are NOT:

- **Not a done.** They used to settle to `done`, on the theory that the notification is a straggler arriving after a turn we already called. It is the opposite: for claude it is the only signal emitted when it is blocked, and it lands a fixed **6.0s** after the title goes idle, i.e. always just behind byte-quiet (4s) and the settle timer (5s). Attention is therefore allowed to land on top of a done we already fired (`goAttention` deliberately does not check `doneFiredSinceSubmitRef`). Racing it by slowing the demoters would make every genuine completion feel sluggish.
- **Not always actionable.** Claude sends `Claude is waiting for your input` **60.0s** after any turn you did not reply to. `BUILTIN_NOTIFY_IGNORE` drops it; anything else an agent says is badged, since asking to notify states the intent. An agent's `attention` list acts as an allow-list override.
- **Not forwarded from the terminal.** The body reaches the banner through `unread.message` and `useAttentionNotifier`. Forwarding it directly AND marking unread fires two banners for one event, which is why the old code had to keep OSC 9 away from `markAttention` entirely, and therefore why it never produced a needs-you badge.

Suppressed when the agent is already back at work, or when the Tier 2b check says work is outstanding: a background-subagent wait emits a byte-identical notification to a real permission prompt, so the body alone cannot separate them.

### BEL means xterm's `onBell`, never a byte scan

`u8.indexOf(0x07)` cannot tell a bell from the terminator of an OSC: `ESC ] 0 ; title BEL` ends in `0x07` and claude repaints its title about once a second. That is what the old "agents emit BEL every ~1s during their spinner" comment was describing — not a bell, a title. It was also chunk-dependent: across three byte-identical OSC 9 sequences in one recording it fired on two and missed the third, so needs-you badges appeared at random. In 1300 lines of recorded claude output there was not one genuine bell. Let the VT parser decide.

### A held done still has to land

Holding a done (Tier 2b) is only safe because something retries it. Two things quietly removed that retry, and together they pinned tabs to "working" until the user clicked them, which is the opposite failure from the one the hold exists to prevent:

- **A demoter that gives up its tick on a held done.** Byte-quiet used to `return` as soon as it called `fireDone`, fired or not. An idle agent that stops painting is byte-quiet on EVERY tick, so that `return` ran every 3s and the two ceilings below it never executed — including the 10-minute absolute one, the only path that outranks a hold (`force: true`). A status line that never clears (a background shell that outlives the turn, or the words still sitting in the tail after the work landed) then held the tab forever.
- **A demoter that latches itself off on a held done.** Settled-hash and scrollback-stability set `marked` after firing and only clear it when the screen CHANGES. A hold leaves exactly the screen that never changes, so latching on a held done means that path never runs again for the rest of the turn.

So: `fireDone` returns `false` only when the hold caught it, and every caller treats that as "not done yet" — no `return`, no `marked`. The absolute ceiling is the backstop, and `localStorage.workDoneCeilingMs` shortens it so a test can actually reach it (ten minutes is not a thing a spec can wait out, which is why it stayed broken).

### A done we got wrong must not outlive the evidence

Every heuristic here can read a stage boundary in a long multi-stage turn as the end of it. `done` used to be permanently sticky (`if (cur.workState === "done" && state === "working") return s`), so a premature one could not be undone by anything the agent did: no spinner for the rest of the turn, the turn's one done token already spent so the real completion badged nothing, and the only way out was clicking the tab.

`STICKY_DONE_MS` (8s, `lib/agents.ts`) makes it a window instead. Inside it, a busy signal is claude's post-response `✳ ↔ spinner` flicker and is still ignored. Past it, the agent is working and the tab goes back to "working", the stale `done` bullet is dropped (an `attention` badge stays: the agent asked for the user in its own words), and `TerminalPane` hands the turn its done token back so the real ending can badge. Both halves read the same constant, or the spinner and the token come back at different times.

**One turn is allowed to interrupt the user ONCE, and that is not the same thing as one done per turn (GH #276).** The paragraph above is the fix that created this bug. Taking a premature done back means clearing its `unread` mark, and the turn's real ending then sets it again, so the tab's `unread` goes null → set → null → set across a long turn. That transition IS the OS notification: `useAttentionNotifier` fires on the rising edge. Every stage boundary therefore cost one banner, which a user reported as "notifications for what seems like every action". The notifier's own 8s debounce is no defence against a turn measured in minutes.

Both paths reach it and neither shared a guard with the other, so both had to be fixed at once. The heuristic path re-earns the right to notify from `goWorking`, which hands the done token back past `STICKY_DONE_MS`; the hook path never needed the token at all, because a `133;D` calls `fireDone` with `fromHook`, which bypasses it outright. (Codex is now a hooks agent too, which removes its exposure to the heuristic half entirely rather than merely bounding it: see the codex section of [agent-hooks.md](agent-hooks.md). The bound still matters for every agent without hooks, and for any agent whose hook transport dies mid-session.) Real claude with shell integration emits `CDCDCDCDCD` on an ordinary task, so this was the common case, not an exotic one: a captured `termic-workstate.log` showed `WDWDWDWDWDWD` with `watching=false` on every done.

The fix is `Tab.unread.repeat`, set by the PRODUCER, because only the producer knows where the turn began. `TerminalPane` keys a latch on `lastInputAt` (the one field every send path already stamps: keyboard Enter, the queue, a broadcast, `seedPrompt`, `runPrompt`, `sendComments`, the CLI and deep-link paths), so "the turn moved on" needs no reset hook of its own and cannot be missed by a path added later. Nothing the agent does touches it. A repeat still marks the sidebar dot and does not raise a banner.

Two things about it are load-bearing and easy to undo by accident. **The flag must not suppress the DOT**, only the banner: the dot tracks state and both stage boundaries are real. And **the notifier's edge is measured on newsworthiness, not truthiness** (`lib/attentionNotify.ts`) — a suppressed repeat leaves `unread` SET, so a plain `if (prev.unread) continue` would swallow a genuine needs-you landing on top of it, i.e. the agent asking for permission in silence. Both are pinned: `attentionNotify.test.ts`, `store/unreadRepeat.integration.test.ts`, and the `#stage` / `#hookstage` fixture drills in `agent.e2e.ts`, which assert one newsworthy edge and two dots for the same turn.

**Any tier that classifies a state must write `senderStateRef`.** The interval demoters (byte-quiet, settled-hash, scrollback) read it for two decisions: a `busy` value suppresses them entirely, and a `null` value means "this agent has never signalled anything", which downgrades their verdict from `done` to `attention`. A classifying path that skips the ref leaves a title-less agent looking mute, so byte-quiet fires at `QUIET_MS` (4s, under `SETTLE_MS`) through any silent think and rings the attention bell mid-turn, which is the bug #68 opened about.

**A notification termic ITSELF installed must not be filtered like agent chatter.** `notifyAttention` exists to sort an agent's own notifications into needs-you and noise, and two of its guards are actively wrong for termic's agent hook (`docs/agent-hooks.md`). A user's `attention` list is an ALLOW-LIST, so teaching termic what THEIR agent says when it needs them silences our hook, which says something else. And the "agent already back at work" check reads `workState`, which `goIdle` does not clear: it arms the settle and leaves the tab reading "working" for the whole `SETTLE_MS`. Claude paints its idle title about 20ms BEFORE the hook fires, so a hook notification always lands inside that window and was dropped every single time. Both are skipped when OSC 777's `title` field is `HOOK_OSC_TITLE` (`lib/agentHooks.ts`), which is how a signal termic installed is told apart from one the agent chose to send. The e2e fixture seeds an `attention` allow-list for `fakeagent` precisely so this stays caught.

**And an agent's idle state must actually classify, or the ref latches busy forever.** `senderStateRef` is only assigned when `classifyAgentTitle` returns non-null (`if (state) senderStateRef.current = state`) and is only reset on PTY spawn. So an agent whose BUSY title matches but whose IDLE title does not gets the worst of both: one spinner frame sets the ref to `busy`, nothing ever clears it, and because all three demoters are gated on `!senderBusy` the tab can never leave "working". Measured on Codex 0.142.5, which dropped the status words the built-in patterns were written for: its title is the cwd basename when idle (`proj`) and a Braille frame plus the basename when working (`⠋ proj`), so `\bReady\b` never matched and every Codex tab latched on its first turn. Fixed by giving codex a general idle pattern (a title whose first non-space character is not a spinner frame) alongside `Ready`. When adding or revising an agent's signals, check that its idle title classifies, not just its busy one.

A general idle pattern needs the same submit gate the busy branch has. Codex paints its spinner during startup, so an ungated busy→idle transition arms a settle on a tab nobody has typed into and badges a "done" for a turn that never happened. `lastTitleState` is recorded even when the busy branch is suppressed, so gating only the busy side is not enough.

Neither Claude nor Codex emits `OSC 9;4` any more (checked across ten PTY captures on Claude Code 2.1.250 and Codex 0.142.5, including a 150s run). Tier 1 above still describes the protocol correctly and the handler stays for agents that do emit it, but for these two the title is the only busy/idle source in practice.

## A broadcast `emit` is a bug once there is more than one window (GH #280)

`app.emit(topic, payload)` reaches EVERY webview. With one window that was
correct and free; with one window per profile it hands every profile's webview
every other profile's PTY bytes, setup logs and grep hits, and makes every
window answer a CLI request only one of them can serve.

Task-keyed events must go through `emit_scoped` (which parses the id out of the
topic and memoizes the owning window) or `emit_scoped_by_id`. `pty://` resolves
its label at SPAWN instead, and `grep-*://` at search start, and both emit with
`emit_to_window`: their ids are not task ids, so the memo could never find them
(see the next entry). An unresolvable id falls back to a broadcast
deliberately: that is the pre-profiles behaviour, and far better than an event
reaching no window at all.

Genuinely global topics (`docker-build://`, `termic://windowless`,
`termic://profiles-changed`) stay broadcasts. Ask "is this true of the machine
or of one profile" before adding an emit.

**`emit_to` is only half of it: the LISTENER has to be scoped too.** Tauri 2's
global `listen()` from `@tauri-apps/api/event` registers for target `Any`,
which receives events `emit_to`'d at ANY window's label, not just broadcasts.
So `cli-rpc://request` was `emit_to` the right window and still ran in every
profile's webview: one MCP/CLI `new` created the task in the right window
while the other re-checked ITS profile's task list, found no clash, ran git
against the same repo and failed on the branch the first had just made, and
that fast failure was the reply (reported from a live MCP session; reproduced
by profiles.e2e.ts "serves a CLI/MCP request in exactly one window" on the
unfixed build, green after). A listener for an event Rust targets at one
window uses `getCurrentWebviewWindow().listen(...)`: `cli-rpc://request`
(src/lib/cliRpc.ts) and `termic://close-requested` (windowlessMode.ts) do.
Per-task topics (`setup-output://<id>`) are safe with the global listen only
because a window subscribes to its own tasks' ids alone.

## A topic keyed by a non-task id turns a cached lookup into a disk scan

`emit_scoped` cannot tell a task id from any other id. It takes whatever
follows `://` in the topic and looks it up in `TASK_WINDOW`, and a miss
means `load_tasks_all()`: a read and parse of every task file in every
profile, archived ones included. `pty://<id>` carries the PTY's own uuid,
so from the day per-profile routing shipped every PTY flush missed and
scanned, and because a miss was not remembered, the next flush 8ms later
scanned again. Nothing failed. The event fell back to a broadcast and its
one listener still got the bytes, so the only symptom was battery. The
comment above the memo said the PTY path "captures its label at SPAWN";
nothing did. Measured cost: [performance.md](performance.md) bear trap 12.

Two defences now, and a new emitter needs the first one:

- A topic whose id is NOT a task id (a PTY id, a search id, anything
  minted per run) resolves its window from the task it already holds and
  emits with `emit_to_window`. `pty_spawn` and `task_grep_start` do, and
  a source-guard test fails if either calls `emit_scoped` again.
- The memo remembers misses and `save_task` seeds it, so even a wrong
  caller costs one scan per id rather than one per event, and a task
  created after a miss still resolves. It never holds its lock across the
  scan, which had queued every flusher behind whichever one was reading.

## `std::mem::take` on a shared queue swallows another window's work (GH #280)

`deep_link_take_pending` drained the whole pending-URL queue for whichever
webview asked first. With one window that was the single-reader property that
made double-handling impossible; with N windows it means one profile eats
links meant for another. The queue is now keyed by target label and each window
drains only its own.

Any "the webview drains everything" design needs re-reading with N windows in
mind. Same for "the last writer wins": `tray_set_attention` had to become a
merge across windows for exactly this reason.

## localStorage is shared by every profile window, and always will be

They are webviews on the same origin. Anything keyed by task UUID is safe
(UUIDs are disjoint); anything keyed by a name, a project id, or nothing is
silently global. `src/lib/profileScope.ts#scoped()` namespaces the keys a
profile owns. `src/lib/prefsRegistry.ts` records which keys those are, and its
test fails on a new key until it is listed there, scoped or not.

Two things about it are load-bearing. It reads the window label
SYNCHRONOUSLY, because stores read their keys at module-init and an async
`profiles_list` would be a frame too late. And the root profile's namespace is
EMPTY (its label is `main`), so an existing install reads its collapse state,
folder colors and prompt library from the keys they are already in: if that
regresses, every user's sidebar state resets on the release that ships
profiles.

Preferences (theme, fonts, terminal/editor settings, shortcut bindings) are
deliberately NOT scoped: they are machine-level, and muscle memory does not
change per identity.

## `open -a` ignores the folder unless the app declares `public.folder`

An app that does not claim folders still launches from `open -a "<App>" <dir>`
with exit 0. It just comes up at whatever it had open last and drops the path,
so the bug reads as "the picker opened the wrong project" rather than as a
failure, and nothing in the exit status can tell you.

So the criterion for adding an entry to `EXTERNAL_APPS` (`lib.rs`, the title
bar's "open with" table) is the bundle's own declaration, checked before the
entry is written:

```sh
plutil -extract CFBundleDocumentTypes json -o - \
  "/Applications/Cursor.app/Contents/Info.plist"
```

Look for `public.folder` or `public.directory` in an entry's
`LSItemContentTypes`. Verified at the time of writing: Cursor, Warp and Zed
declare `public.folder`; Terminal declares `public.directory`. All four are
role `Editor`.

Two related traps in the same area. **Launch by bundle PATH, not bundle id**
(`open -b`): two installed versions make an id ambiguous where a path never is,
and the ids are unguessable anyway (Cursor ships as
`com.todesktop.230313mzl4w4u92`, Warp as `dev.warp.Warp-Stable`), so a guessed
one fails silently too. And **no `-n`**: it forces a second instance of the
editor instead of adding the folder to the running one, which is not what
"open this in Cursor" means.

## `transition-colors` freezes a themed border-color change (WKWebView)

A selected/unselected control that swaps `border-[var(--color-a)]` for
`border-[var(--color-b)]` from React state, on an element that also carries
`transition-colors`, **never repaints the border**. The class list swaps, the
`aria-checked` attribute swaps, `getComputedStyle().borderTopColor` keeps
returning the OLD colour, and it never settles: polling for five seconds does
not help. The visible symptom is a radio group where the filled dot moves and
the highlight box does not, so two options look selected at once.

Verified both directions in `e2e/specs/profiles.e2e.ts` (delete-profile
dialog): removing `transition-colors` fixes it, putting it back reproduces it.
WKWebView is the only renderer termic ships on, so "it works in Chrome" is not
a defence.

**Use `transition-[color,background-color]`** when a themed border colour can
change. That is what `transition-colors` was wanted for anyway; it just also
covers `border-color`, which is the broken one.

**A themed background freezes too.** `ui/Checkbox` swaps
`bg-[var(--color-bg)]` for `bg-[var(--color-accent-deep)]`, and the roles
matrix (`e2e/specs/secrets-api-key.e2e.ts`) showed checked boxes still
computing the unchecked background after three seconds, under both
`transition-colors` and `transition-[color,background-color]`. Dropping the
transition fixed it; each transition put it back. So for a control whose
FILL carries the state, drop the transition: a 150ms fade on a checkbox is
not worth a box that never fills. The sandbox mode cards (`SandboxPicker`)
and role cards (`RolePicker`) froze the same way when picking a role moved
the selection programmatically: OFF and No secrets kept the selected border
1.5s later. Both dropped the transition; `secrets-task.e2e.ts` asserts the
painted border.

This is easy to miss in review because the JSX is obviously correct, and easy
to miss in tests because `aria-checked` (the thing a spec naturally asserts) is
right. It took a screenshot to notice and a computed-style assertion to prove.
Assert the painted colour, not the attribute, wherever selection is carried by
colour alone.

### `transition-opacity` froze a state-driven fade too

The project filter icon (`ProjectTaskFilter.tsx`) switches `opacity-0` to
`opacity-100` when a filter pins it, and with `transition-opacity` on it
computed opacity stayed `0`: a pinned filter's icon was invisible
(`projects.e2e.ts` "pins the bar"). Removing the transition fixed it,
restoring it broke it. The fade now applies only while unpinned (the hover
reveal). So `transition-[color,background-color]` above is not a complete
defence: when React state flips a property that carries a CSS transition,
assert the computed value in a spec.

## An overhanging hit area is clipped out of existence

`overflow: hidden` clips hit testing, not just painting. A child positioned
outside its parent's box (`-right-2` on a 1px divider, to widen the grab
target) is unreachable wherever an ancestor clips, and nothing about the
element says so: it is in the DOM, it has a size, `getBoundingClientRect`
reports the generous rect, and every spec that dispatches events AT the
element passes.

The sidebar's resize divider shipped that way. The aside clips, so the
overhang was gone, and the divider was grabbable across **one pixel** - the
line itself. Measured, not guessed: walk `document.elementFromPoint` across
the edge and ask whether the topmost element is the handle
(`e2e/specs/tabs-layout.e2e.ts`, "gives both dividers a grab strip"). The
existing resize cases all passed throughout, because `mouseDrag` dispatches a
`mousedown` straight at the handle and never asks what a pointer would hit.

Two rules. An interactive area must live inside the element's own box, inside
whatever clips it: widen the element, do not hang a child off it. And when the
element that PAINTS the affordance is not the element that RECEIVES the press,
you have built a control that lights up and then ignores you, which is how
this one was reported.

## A scratchpad is unregistered while its editor remounts

An agent's `termic scratchpad write` to an OPEN pad goes into the editor
buffer through `lib/scratchLive`'s registry. Between an old `EditorPane`
unmounting and a new one finishing its async `scratchRead`, the pad is not
registered, so a write in that gap takes the closed-pad path to disk. The new
editor shows what it read BEFORE the write, and its next flush writes that
text back over the append.

The gap is not exotic. A pad whose content sniffs as Markdown (`# Findings`)
swaps `EditorPane` for `MarkdownPane`, which is a second CodeMirror mount, and
an agent that creates a pad and writes to it at once lands right in it. That
made the `scratchpad.e2e.ts` live-write case fail about one run in six.
Verified both ways: the same case seeded with non-Markdown text passed 12 of
12, and a case that writes in the same tick as a Markdown pick failed 3 of 3
without the fix and passed 8 of 8 with it.

Every write to a pad's file goes through `trackPadDiskWrite`, and a loading
pad editor waits for writes in flight, then re-reads until no write started
during its load, with no await between that check and registering. The
tracking must start synchronously at the live-pad check and cover the
closed-pad path's READ too: the first version tracked only the final write,
and an editor registered inside the read's await, which still failed 8 of 8.

## Two components fetching one setting will disagree

The account pill and the usage popover each carry the same "switch
automatically" checkbox, and each fetched `agent_accounts` for itself. Toggling
one left the other showing the old value until something happened to remount
it. Nothing was wrong with either component; there were simply two copies of a
single fact and no path between them.

The fix is one owner: `hooks/useAgentAccounts.ts` fetches once for the whole
footer and hands both chips the same object plus a shared `refresh`. Popovers
call `refresh` when they OPEN, since nothing pushes a settings change into a
component that is already mounted.

Worth recognising in general: as soon as a second surface renders the same
stored value, either lift the fetch or accept that the two will drift. An e2e
case that toggles in one place and reads in the other is what caught this, and
it is a cheap case to write.

## A new window needs a Tauri capability, or it silently has no permissions

Capabilities (`src-tauri/capabilities/*.json`) are scoped by window LABEL. A
window whose label matches no entry does not get a reduced set of permissions,
it gets NONE, `core:event` included. The window builds and paints, and then
every `listen`/`emit` fails at runtime:

```
spawn failed: event.listen not allowed on window "profile-work", ...
allowed on: [windows: "main", URL: local]
```

Profile windows shipped like this. The root profile keeps the literal `main`
label, so the first window worked perfectly and only the second was inert,
which is exactly the case nobody hits until the feature is really used.
`capabilities/default.json` now lists `profile-*`.

Whenever you add a window LABEL, add it to a capability in the same change, and
remember `tauri.conf.json` / capabilities changes need a quit + relaunch, not a
reload.

## A window built inside a command hangs on Windows

A `#[tauri::command]` without `async` runs on the main thread. Building a
webview window there works on macOS and hangs on Windows: WebView2 creation
needs the message loop that the command is blocking (wry#583). Nothing errors;
the command just never returns and the window never appears.

`profile_open` and `procmon_open_window` shipped like that, and nothing on
macOS could show it. The first Windows e2e run did: "creating a profile did
not open its window", then every later profile case timed out.

Making them `(async)` was NOT enough, and the next run showed it: the
window builds on the worker thread and the command returns, but the window
is not usable, and the next window command hangs. What works is what the
startup window does: build it on the main thread from the event loop.
Both commands stay `(async)` and hand the window work to `on_main_thread`
(`run_on_main_thread` plus a channel), waiting on their worker thread for
the result. Never call `on_main_thread` FROM the main thread (the tray
handler, `setup`): it waits on itself. The tray row calls `profile_open`
from the blocking pool for that reason.

## `fs::rename` on Windows is not a one-step replace

std's Windows `rename` is `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which
leaves a moment where the destination name does not exist. A reader that
opens it then gets NotFound, so "write a temp file and rename it over" was
still not atomic for a settings load racing a save. `write_atomic` (and the
agent-hook writer) go through `rename_replace`, which asks for a
POSIX-semantics rename (`FileRenameInfoEx`) first and falls back to std's
rename where the filesystem refuses it (GH #195). Use it for any file
something may read while you write it.

## ConPTY gives the reader no EOF when the child exits

On unix, the PTY reader hits EOF when the last process holding the slave
exits, and the waiter fires `pty-exit` once the reader has drained. ConPTY
keeps its output pipe open until the pseudoconsole itself is closed, so on
Windows a child that exits by itself left the reader blocked forever and
`pty-exit` never fired. Nothing errors: a failed `--resume` never retried
and never opened the picker, and an agent that quit never showed its
exited banner. A killed PTY was fine, because `pty_kill` drops the slot,
which closes the pseudoconsole.

Seen in the Windows e2e debug log: `child exited code=Some(1)` for a dead
resume, then no `pty-exit` and no respawn. The waiter now does what
`pty_kill` does after a 200 ms drain. `conpty_osc_probe` measures both
halves (EOF or not with the pseudoconsole open, then once it is closed),
with macOS as the control.

## A Windows path that mixes separators opens Documents, and reports success

`explorer.exe` does not reject a path it cannot parse. It opens the user's
Documents folder instead, and exits zero, so the caller cannot tell a
malformed path from a good one and nothing anywhere logs or throws. Every
"open in File Explorer" on a folder landed in Documents, which is what made it
look like a menu wired to the wrong argument rather than a path bug.

Measured by reading `Shell.Application`'s `Windows()` back after each spawn,
with the Windows folder as the control:

    explorer "I:\repo/docs"   ->  file:///C:/Users/<u>/Documents   (mixed)
    explorer "I:\repo\docs"   ->  file:///I:/repo/docs            (native)

The mixed spelling was ours, and it is structural rather than a typo: the
app's task-relative paths are `/`-joined by convention (`FileTree` keys its
directory cache on them, `relUnder` produces them), while the root comes back
from Rust with `\`. A hand-rolled `${root}/${rel}` at each call site therefore
produced `I:\repo/src` on Windows and `I:\repo/src` never on macOS, where `/`
IS the separator, which is exactly the "mac fine, Windows broken" shape.

Build native paths through `absUnder` (`joinPath` in `lib/osPath.ts` is the
single-segment form) and never by concatenation. It normalizes the WHOLE
string, not just the character it inserts, because either half can arrive in
either spelling. `pathToFileUri` rewrites to `/` and so tolerates both, which
is why the LSP path never showed this.

## Docker is a SECOND REALM, and it does not inherit host fixes

Three separate bugs in one feature, all the same shape: a rule implemented for
the host, and silently absent in the container.

- "The adopted account relocates nothing" was checked while building the host
  env overlay. The Docker branch appended the account slug to the mount
  unconditionally, so naming your first account pointed the container at an
  empty directory and orphaned the login you were already using. It presents
  as the agent running its first-run wizard in a task that was signed in a
  minute earlier.
- `agent_hooks_sync` only ever UPGRADED an existing install, so a Docker
  install that was never made stayed missing forever, in silence: no work
  state and no plan usage in sandboxed tasks, while the same agent on the host
  reported both.
- The host shares an account's config by SYMLINK. A host symlink is dangling
  inside a container, so Docker needed the same entries as MOUNTS. Without it
  `--resume` answered "No conversation found", and a shared `settings.json`
  pointed at hook scripts that were not there.

**Whenever you write a rule about where an agent's files live, ask what the
container does with it.** `docker::build_spec` and the host env overlay are two
implementations of one idea and they drift apart quietly, because the host is
what you are looking at while you write the code.

`a_named_account_shares_the_agents_conversations_into_the_container`
(`docker.rs`) is the guard: every entry in `shared_config_entries` that exists
must be mounted, so adding one without Docker honouring it fails there rather
than in a container weeks later.

## `null` is an ANSWER; `undefined` is the absence of one

`??` collapses the two, and in the account switcher that was wrong three times
in three different places:

- the usage key: `liveAccount ?? configured`. `null` means "running on the
  agent's ordinary login", which every process spawned before the user named a
  credential set is doing. Collapsing it re-keyed a RUNNING task's chip the
  moment the first account was named, and its usage vanished mid-session.
- the pill's label: same expression, so with a switch staged and not restarted
  the chip named an account the process had never run as.
- `pillText`, again, until the view learned to report `adoptedAccount` (the
  name FOR the ordinary login).

When a value has a meaningful "none" state, spell the two apart in the type
(`string | null | undefined`) and compare with `=== undefined`. Then say in a
comment which is which, because the next reader will assume `??` is safe.

## A rendered sandbox rule can be inert

The control plane denies termic's whole data dir, and that deny is deliberately
the FINAL filesystem rule: SBPL is last-match-wins, so an allow placed anywhere
above it does nothing. A named account's config dir lives inside that data dir,
so the agent could not open its own credential (`unable to open database file`)
while the profile visibly contained an allow for it.

Two rules follow:

1. An allow for something under the data dir has to be emitted AFTER those
   denies, and kept as narrow as the thing it is for.
2. **Assert POSITION, not presence.** A `contains` check passes on a rule the
   kernel never applies. `the_login_store_allow_survives_the_control_plane_deny`
   compares byte offsets for exactly this reason.

And one trap underneath it: `canonicalize` on a path that does not exist yet
returns the path unchanged. Seatbelt evaluates canonical paths, so an allow for
a directory the spawn is about to create named `/var/...` where the kernel sees
`/private/var/...`, and matched nothing.

## A new window LABEL needs a Tauri capability

Capabilities are scoped by window label, and a window matching no entry gets
NO permissions at all rather than a reduced set. `core:event` is included, so
the window builds, paints, looks entirely normal, and then every `listen`
fails: in practice, every PTY spawn in it dies.

Profile windows shipped like this. The root profile keeps the literal `main`
label, so the FIRST window worked perfectly and only the second was inert,
which is exactly the case nobody exercises until the feature is really used.
`every_profile_window_is_covered_by_a_tauri_capability` (`profiles.rs`) derives
labels from the real builder and checks the JSON, because nothing in the type
system connects the two.

## Test infrastructure rots, and it looks like flakiness

Two bugs in test helpers cost more debugging time than any product bug in the
same session, because each failure named an innocent test and passed on rerun:

- `with_scratch_data_dir` read the variable it was replacing BEFORE taking the
  lock, so it captured another test's scratch dir and restored that on exit: a
  directory whose owner had already finished and deleted it.
- `statusline_run` keyed its temp dir on pid + timestamp. `SystemTime` is not
  nanosecond-resolution on macOS, so two parallel tests shared a directory and
  the first to finish deleted the other's file mid-read.

**A failure that names a different test each time and never reproduces alone is
a shared-state bug, not a flake.** Look at what the tests share before looking
at the test that failed.

## Waiting on a Zustand value is not a barrier for the click that follows

`ensureActiveTask` wrote `setActiveTask(id)` and then waited for
`useApp.getState().activeTaskId === id`. That wait can never fail: the setter
is synchronous, so it was already true on the line that wrote it, and the
helper returned having barred nothing.

What the next line then clicks is a button in UnifiedBar whose handler closes
over the task from its last RENDER (`onClick={() => confirmAndArchive(task)}`),
and React 19 renders concurrently. Measured on an idle Mac, 40 switches out of
40 still had the OLD task in the DOM on the same tick as the setter, with the
real render landing 5-14ms later. The click usually won that race only because
a WebDriver round-trip happens to be slower than a render; on a loaded 3-core
CI runner both stretch and the click sometimes lands first, invoking the
handler for the PREVIOUS task. That was `silent archive never landed` in
`task.e2e.ts`: it archived the wrong task, so the right one never archived.

**Wait on the DOM whenever the next step is a click.** UnifiedBar's
`data-active-task` publishes which task the chrome has actually rendered,
which is a different fact from which task the store considers active. A store
assertion is fine to check a RESULT; it is worthless as a barrier before an
interaction.

Note the shape, because it generalises past this helper: a wait whose
condition was made true synchronously by the line above it is not a wait. If
you cannot describe the state it is waiting to LEAVE, it is not barring
anything.

## A poll that lives in a component only covers what is mounted (GH #281)

The sidebar draws a PR/MR badge on every task with a PR, coloured from the
LIVE lookup in `store/pr.ts`. Every refresh of that lookup, though, hung off
`PrCard`: gain-focus, a 60s interval while mounted, a push, and an agent
spawn. `PrCard` renders inside `GitPanel`, which renders only while the right
panel is open AND on its Git tab, for a task already visited this session.
So the common case had no poller at all: the badge sat on its grey "state
unknown" glyph indefinitely and no poll ever arrived to notice the PR had
merged. It looked intermittent to the reporter because the rule was invisible
from the outside, and the badge's click-through kept working the whole time
(the URL is persisted on the task record, only the state is not).

The fix is a second layer that does not depend on any component:
`initPrStatusPoller` in `store/pr.ts`, started from `App` once `loadAll`
resolves, walking every task whose record already holds a PR identity. It is
bounded rather than cheap, because a refresh is a `gh`/`glab` subprocess: a
3-minute per-task staleness floor, at most 8 tasks per 60s pass, stalest
first, awaited one at a time.

That layer only MAINTAINS a known PR; it never discovers one, since it walks
tasks that already carry an identity. A PR the agent opened itself (`gh pr
create` in its terminal) therefore stayed badge-less until someone opened
the task's Git tab. Third layer: `initPrRefreshOnFocus` refreshes the active
task when it becomes active and when the window regains focus with it in
front, unforced, so the store's 30s per-task floor caps it however often you
switch. The first lookup that finds the PR records its identity, and layer 2
owns it from there.

The general shape: **when a fact is rendered somewhere that is always
mounted, it cannot be maintained by something that usually is not.** A
sidebar row, the tray, a window title and a desktop notification all outlive
the panel their data came from. The tell is a component-owned `setInterval`
whose output is read outside that component's subtree.

## One task's work badge is computed twice, and the two ranked it differently

The sidebar and the dashboard both draw a badge for a task, and both now go
through `taskWorkBadge()` in `src/lib/taskWorkState.ts`, which ranks
**attention > done > working**. Keep it that way: a blocked agent is more
actionable than a finished one, and both beat one still chugging.

`computeAgentStates()` in `src/lib/cliAgentState.ts` ranks the same inputs
**working > attention > done**. That is not a bug to go and fix: it feeds
`TaskSummary.work_state` over the CLI wire, which is a published additive
contract, so flipping it changes what `termic list` reports. It IS a trap,
because the two functions read identical tab state and answer differently, and
a reader who finds one will reasonably assume the other agrees.

Related: `data-testid="work-badge"` stopped being unique when the dashboard
started drawing it. The sidebar is always mounted and the dashboard is an
overlay on top of it, so a task with a live agent renders the badge twice and a
bare testid query silently returns the sidebar's. Every assertion scopes:
`dashboardBadge()` through `[data-dashboard-task-id]`, `sidebarBadge()` through
`[data-sidebar-task-row]`.

## git speaks repo-root paths; termic speaks project paths

A project does not have to be a repository root. Point termic at
`packages/app` of a monorepo and that directory is the project: the file tree,
every `task_file_read`/`write`, every diff and every "viewed" mark address
files relative to it.

git does not work that way, and it does not care which directory it ran in.
`status --porcelain`, `diff --name-status`, `diff-tree` and `show <rev>:<path>`
are all phrased against the REPOSITORY ROOT. Run them in `packages/app` and
they still say `packages/app/src/index.js`.

Where those two met, the Git panel listed a row the rest of the app could not
address, and the failure was silent and wrong rather than loud:

- the diff pane read the working-tree side at
  `packages/app/packages/app/src/index.js`, which does not exist, while
  `git show HEAD:packages/app/src/index.js` resolved fine, so it had a full
  original against a missing modified and **drew every line of the file as
  deleted**;
- staging a row passed that same path to `git add --`, where a pathspec IS
  cwd-relative, so it matched nothing and quietly staged nothing.

The conversion is `git rev-parse --show-prefix` (`repo_prefix` in `lib.rs`),
which is git's own answer and the only one worth trusting: subtracting one path
from another gets symlinked checkouts and case-insensitive filesystems wrong,
and both are ordinary on a Mac. Everything crossing the boundary goes through
it:

- **status** takes `-- .` (scope) and has the prefix stripped off each row.
- **diff-family** commands (`diff`, `diff-tree`, `--numstat`, `--name-status`)
  take `--relative`, which both rewrites the paths and drops what lies outside.
- **`<rev>:<path>`** is written `<rev>:./<path>`, which is what makes it
  cwd-relative. Bare `HEAD:x` is root-relative however deep you are.
- **pathspecs** (`add`, `checkout`, `blame`, `ls-files`) need nothing: they
  were always cwd-relative, which is precisely why they broke on paths phrased
  the other way.

All of it is a no-op when the project is the repository root, which is why this
survived so long: the 99% case has an empty prefix and every rule above reduces
to what the code did before.

The rule for anything new: **a path that came out of git is not a termic path
until it has been through the prefix.** If you add a git command that prints
paths, it needs `--relative` or a strip; if you add one that takes a path, ask
whether that argument is a pathspec (cwd-relative, fine) or part of a revision
(root-relative, needs `./`).

## "Primary tab" means first-of-its-CLI, not the task's agent

`isPrimaryTab` in `TerminalPane` is `tab.is_default || firstTabOfThisCli === tab`.
That second clause is what lets a second agent in the same task resume its own
session instead of being treated as a throwaway, and it is correct for that.
It is NOT an answer to "is this the task's agent", and reading it as one is how
a task-level setting written in ONE CLI's spelling reached another CLI.

`Task.resume_override` is that setting. Someone types `--resume {WORKSPACE_NAME}`
for a claude task, then opens codex from the + tab menu; the codex tab is the
first codex tab, so it was primary, so it got claude's flags:

```
error: unexpected argument '--resume' found
  tip: a similar argument exists: '--remote'
```

Dead before the first frame, and identical on every Restart, because nothing
about the argv depends on the failure. `decideResume` now takes `runsTaskAgent`
(`tab.cli === task.cli`) and gates the override on BOTH, which is the gate
`spawnArgsForCli` already had on `task.agent_args`.

Two rules fall out of this:

- **A per-task string that names flags belongs to exactly one agent.** The
  registry is the only place a resume/yolo/name spelling is per-CLI; anything
  the user types against a TASK is written against whatever agent that task
  shows, so it has to be gated on that agent's id, not on a tab's position.
- **Check what a boolean is named after, not what it is used for.** `isPrimary`
  gates four things in `decideResume` and was right for three of them.

## A durable tab is only restored by a WAKE, and a shell prevents one

Closing the main agent tab is documented as "end it for now": the entry stays
in `persisted_tabs` with its session id, and the task auto-resumes it. Every
word of that is true and it still leaves a hole, because "auto-resumes" means
`ensureDefaultTab`, and `ensureDefaultTab` bails on the first line:

```ts
if (mainTabs.length) return;   // already visited this session
```

That bail is for re-seeding, but it reads the whole main strip. A shell, a Run
tab or a diff left open satisfies it, so a task that keeps ANY main tab never
sleeps and is therefore never woken. Close the agent next to a shell and the
durable record sits there, complete and correct, reachable by nothing: the
`+` menu's Resume list used to exclude the main tab *precisely because* it
auto-resumes, and `+` → the agent again makes a tab with a NEW id, hence a new
session.

In a worktree nobody sees this, because the replacement tab's cwd resume
(`--continue` / `resume --last`) picks the same conversation back up. The repo
root is where it bites: cwd resume is off there by design (several tasks share
one directory, so "most recent" is somebody else's conversation), so the agent
comes back empty, with no error and nothing on screen to say a session was
lost. It reads as "auto resume in the main checkout doesn't work".

Fixed by snapshotting the main tab into `closedTabs` too, but ONLY when the
close leaves the task awake — a close that sleeps it still auto-resumes and a
second entry would just be a duplicate. The entry carries the closed tab's own
`tabId`, and `resumeClosedTab` reuses it: minting a fresh id would leave the
old durable record in place and add a second one pointing at the same session,
so the next real wake would restore two agents onto one conversation.

The general rule: **"it is persisted" is not "it is reachable".** Any code that
promises a record will come back has to name the event that brings it back, and
then check that the event can actually fire in the states the user can get the
app into. `agent.e2e.ts` drives all three states against the real window.

## An agent's title is not a vocabulary, and an unanchored pattern inherits its prose

Codex 0.154.0 started renaming the thread mid-turn and rendering the generated
name through the same `activity` item that carries its state, so the terminal
title became part state, part model-written prose:

```text
⠼ Explain Action Required | proj
```

`BUILTIN_TITLE_SIGNALS.codex.attention` was `\bAction Required\b`, matched
anywhere in the title, and `classifyAgentTitle` tests attention BEFORE busy, so
the braille spinner could not win it back. One question about approvals named the
thread, and the tab claimed to need you for the rest of the session while the
agent worked. Reported as a false attention icon; nothing in the suite caught it,
because every fixture predated the rename.

Anchored to the start of the title now. The lesson generalises past codex: a
title pattern is matched against a string the VENDOR composes, and the parts
they add later are not required to be a fixed vocabulary. Anchor on the position
the state actually occupies, and treat any span that can hold user or model text
as hostile. The same file still has unanchored word patterns in `busy`
(`\b(Working|Thinking)\b`); they are left alone deliberately, because no false
busy has been measured and a pattern rewritten from reasoning is what the last
sweep had to undo.

Bounding the regression to a build was worth more than the fix: the twelve
releases cached under `~/.codex/packages/standalone/releases` let `strings` find
`renaming...` in 0.154.0 and nowhere earlier, which named the version rather than
guessing at it. See [agent-hooks.md](agent-hooks.md).

## A form that SHIPS a field it never edits will eventually delete it

`AgentsSection` loads the agent registry once (`useEffect(…, [])`) and saves the
whole array back on a 500ms debounce after any edit. The account fields on that
same entry are written only by the `account_*` Tauri commands, so the form never
edits them, but it does send them: whatever the snapshot held at mount.

Add a second account, then change any field in that section, and the pre-add
array overwrote the post-add file. `accounts`, `default_account`,
`adopted_account` and `auto_switch_account` went together. The reporting user saw
a second Claude account that logged in, worked, and was then gone from Settings
with "+ Second account" offered again and the footer switcher missing. Re-adding
looked like it did nothing, because the next debounced save clobbered it again.

The child `AgentAccountsRow` DOES subscribe to `termic://agent-accounts-changed`
and refetch, so the row rendered correctly the whole time. Only the parent's
array was stale, and the parent is what gets saved. A component being visibly
up to date says nothing about the state its parent is about to write.

Fixed in `agents_save`, which now carries those fields across from the stored
entry by id, rather than in the form. **Put this defence at the boundary, not at
the call site**: there was a second caller with the identical problem (the
welcome dialog saves an array it built from CLI detection), and a field the
frontend cannot legitimately write is one the backend should refuse from it.
Fixing the form would have left the next caller to rediscover this.

The general shape: **a read-modify-write of a shared record is only safe if the
writer owns every field it sends.** Whenever one surface writes a record that
another surface also writes, either the sender re-reads immediately before
writing, or the receiver preserves the fields the sender does not own. Snapshot
plus wholesale save is how the fields nobody was thinking about get dropped. Same
family as the "Reset to defaults" loss that first put these fields in the TS type
(a default entry spread over fields TypeScript did not know about) and as the
clone-that-snapshots-its-parent trap in `agents.ts`. See
[agent-accounts.md](agent-accounts.md).

## A guard that parses the wrong format blocks every UPGRADE, silently

`install()` opened with "refuse rather than clobber a config we could not
parse", a JSON parse of the existing file. For opencode and pi that file is the
hook itself, a JS/TS module, so every upgrade failed the parse and was refused,
while a first install sailed through because there was no file yet. Nothing
said so: `agent_hooks_sync` logs nothing for a refused install. opencode sat on
schema v9 and pi on v11 while every other agent had synced to v12, and
opencode never got its context readout. Found by reading the manifests on
disk, not by any test, because every test installed into an empty dir.

The trap generalises: a check written for one shape, placed before a branch for
another, and exercised only on the empty case. `a_plugin_install_upgrades_over_an_old_one`
now installs, fakes an old version on disk, and upgrades; with the parse moved
back it fails with "termic.js is not valid JSON" (the control was run).

## Two senders on one signal cannot be told apart

termic's hooks said "turn started / over" with OSC `133;C` / `133;D`, and so
does every shell integration, including pi's (it marks each message block on
every repaint) and claude's. A hooked pi tab therefore went back to `working`
on each repaint. The same shape bit notifications: grok, devin and muse each
announce their own finished turn over OSC 9 a beat after termic's hook, and
the unmatched body rang the needs-you bell.

When termic adds a signal an agent might also send, give it termic's own
channel (the trusted `termic` OSC 777 body) and then decide what the agent's
copy means, rather than hoping the agent stays quiet. docs/agent-hooks.md
"Working and done are termic's own bodies" has the specifics.

## A restore looks exactly like activity

A relaunch respawns every task's agent, resumes its session, and most agents
then report something: a done from a resumed hook, pi's `agent_settled`, a
session replay. One relaunch rang "agent finished" for six agents with nothing
sent to any of them. A signal that no input since the spawn preceded is not a
turn (`fireDone`'s `done-unasked`). Input is either the Enter path's
`submittedSinceSpawnRef` or a `lastInputAt` stamped after the spawn started;
the timestamp alone missed a turn typed straight into a muse tab, so neither is
the only witness.

## A hook that blocks on a dead terminal hangs NEW agents everywhere

A hook writes its OSC to the agent's pty, and a write to a tty blocks once the
buffer is full, which is the state of a pty nobody reads any more. Measured:
three grok `done.sh` hooks sat 22 minutes in that write. A blocked tty write
holds the device's lock, so every `lstat` of that /dev node hung too, and
claude resolves its own tty name at startup by walking /dev (`ttyname_r` ->
`devname_r` -> `lstat`, read off a `sample` of the stuck process). Result: every
NEW claude session, in every termic build and profile, spawned and never drew
a byte. `ps` hung the same way. Killing the three hooks unblocked it at once.

Every generated terminal write is now bounded (`bound_emits` in
`agent_hooks.rs`: the write runs in the background with a 2s budget, then the
script exits), and the in-process plugins open the tty `O_NONBLOCK`, since a
blocking write there would freeze the agent itself.
`a_hook_never_blocks_on_a_terminal_that_will_not_read` drives each script at a
FIFO with no reader; with the bound removed it hangs (the control was run).

## Reporting nothing is reporting something, and the state machine believes it

A done hook that finds work outstanding used to end in `exit 0`, writing not a
byte. That reads on the wire as exactly what a model mid-token writes, so the
tab could not tell a turn still running from a turn that ended while a
backgrounded `sleep 900` kept its `Stop` payload populated. Measured on claude
2.1.278: the hold is per SESSION, not per turn, so a later one-word turn that
used no tools was held the same way, and every done for the rest of that
session was swallowed. See docs/agent-hooks.md "Delegated work".

Two things to carry forward when a guard decides to withhold a signal:

**Withholding is a third outcome, so say it.** `agent delegated: <count>
<label> <ids>` costs one more body on a channel that already exists, and it
turns "we heard nothing" into "the agent stopped and is waiting on two
subagents", which the UI can render and the state machine can bound.

**A hook that has read the payload must outrank the screen scan that guesses
at it.** claude's `pending` patterns (`lib/agents.ts`) include `N shells still
running`, which is on screen for as long as the leftover shell lives, so
`fireDone`'s screen-scan hold would defer the resulting done forever. The
delegated dones pass `force` for that reason. The scan is the FALLBACK for the
fact the hook just read directly, and a fallback that can veto its own
replacement is not a fallback.

## A layer that exists only during a transition gets snapped into existence

A badge in the sidebar jumped one pixel up and to the right on row hover, and
back on leave. Nothing moved in layout: the badge is `absolute inset-0` inside
a fixed-size slot, and hover only changes colours.

`transition-opacity` is what moved it. WebKit promotes the element to its own
compositing layer for the duration of the transition and pixel-snaps that
layer. The badge sits at a fractional offset (a `py-[3px]` row and a
truncating flex sibling both land on half pixels), so the snap is a visible
shift, and it reverses when the layer is thrown away.

`[transform:translate3d(0,0,0)]` on the transitioning element fixes it by
making the layer permanent, so the snapped position is the only position it
ever has. `Dialog` documents the same trick for the opposite symptom, blurry
text, and `Spinner` for a third, a rotating ring that orbits its own centre.
All three are one rule: **if an element is going to be composited, composite
it always, not just while something is animating.**

## A mode squashfuse ignores, firejail enforces

Every Termic AppImage from the first one to 1.10.0 shipped `AppRun.wrapped` as
**0770**, `rwxrwx---`. Everything inside an AppImage is owned by root, so the
person who runs it is `other`, and `other` had no execute bit. The file the
type-2 `AppRun` script `exec`s on its last line was, on paper, not executable
by anyone who would ever run it.

It never showed up, for a reason worth knowing: a plain `./Termic.AppImage`
mounts through **squashfuse**, which does not enforce the stored mode for the
user who owns the mount, so the exec succeeds anyway. The mode only bites where
something checks it: `firejail --appimage` (which is what the
[AppImage catalog's test](https://github.com/AppImage/appimage.github.io) runs,
and how this was found, in a PR that tagged the maintainer), a mount with
`default_permissions`, or `--appimage-extract` followed by a run as a different
user. Those report `AppRun: line 12: AppRun.wrapped: Permission denied` and
nothing else, which reads like a corrupt image rather than a permission.

Two lessons, not one:

- **A packaging mode is not tested by the app starting on your machine.** The
  loosest consumer of the artifact is the one you measure with, and it hid a
  defect in every release for months.
- **Read the artifact, do not reason about the build.** `unsquashfs -o <ELF
  end> -ll <file>.AppImage` lists every mode in a published AppImage, and the
  offset is `e_shoff + e_shnum * e_shentsize` from its ELF header. That took a
  minute and replaced three plausible theories about which step dropped the bit.

`release.yml` now normalizes the whole AppDir before repacking (0755 for
directories and anything owner-executable, 0644 for the rest) and FAILS the
build if any entry is left unreadable or unexecutable for `other`, because the
same class of defect arrives with any new bundled file.

## An AppImage's environment is for the app, and every child inherits it

An AppImage finds its bundled libraries through the environment. `AppRun` and
the GTK hook export `LD_LIBRARY_PATH`, `GTK_PATH`, `GIO_EXTRA_MODULES`,
`XDG_DATA_DIRS`, `PYTHONHOME` and a dozen more, all pointing into the mounted
AppDir, and every process Termic spawns inherits them: each terminal, each
script, each `git`, and the login-shell probe.

On Ubuntu 25.10+ that was fatal rather than untidy. `env`, `ls` and `cat` there
are the Rust coreutils, they link libsystemd, and with our `LD_LIBRARY_PATH`
they load the older copy we bundle:

```
/usr/bin/env: /tmp/.mount_TermicXXXXXX/usr/lib/libsystemd.so.0: version `LIBSYSTEMD_254' not found
```

So every `#!/usr/bin/env bash` script died on its first line in a Termic
terminal, and `shell_env`'s `$SHELL -ilc env` probe died the same way, which
left the app on the fallback PATH for good.

The variables cannot simply be unset at startup. The WebKit helper processes
need `LD_LIBRARY_PATH` (their RUNPATH is `$ORIGIN`, which is their own
directory, so without it `ldd` resolves them to the HOST's libwebkit), and GTK
reads the others lazily. So the app keeps them and each CHILD loses them:
`src-tauri/src/appimage_env.rs`, applied in `proc_ctl::command` and
`pty_spawn`, the two places a child is built. The rule is by value (drop any
entry inside an AppImage mount), not a list of names, so it does not go stale
when the bundler exports one more.

Three things to carry forward:

- **Spawn through `proc_ctl::command`, never a bare `Command::new`.** It was
  already the rule for Windows (no console flash); it is now also what keeps
  the AppDir out of a child's environment.
- **The first fix for this (#47) was a `/bin/sh` wrapper that unset three
  variables and exec'd the binary renamed to `termic.bin`, and the rename broke
  something unrelated.** GTK names a window after its executable, so
  `WM_CLASS` became `termic.bin`, matched no desktop entry
  (`StartupWMClass=Termic`), and GNOME's dock showed a generic cog instead of
  the icon. `release.yml` now fails if `usr/bin/termic` is not an ELF.
- **`openUrl` from `@tauri-apps/plugin-opener` is past both choke points.**
  The plugin spawns `xdg-open` itself, with our environment, and `xdg-open` is
  a shell script that calls `readlink`, `sed` and `head`: under the AppDir
  environment none of them start, so a clicked link did nothing. On Linux
  every link goes through `openWebUrl` (Rust, `spawn_os_open`) instead. Do
  not add a new `openUrl` call without the `IS_LINUX` branch.

## WebKitGTK refuses `navigator.clipboard.readText()`, gesture or not

Ctrl+Shift+V pasted nothing into a terminal on Linux. The handler was
`navigator.clipboard.readText().then(t => term.paste(t)).catch(() => {})`, and
the read rejects with `NotAllowedError` there every time, measured inside a
REAL key press (xdotool through the X server), which is as much of a user
gesture as exists. The `.catch(() => {})` made it silent. Writing from a key
handler does work, which is why copy looked fine and nobody suspected the pair.

Everything goes through `readClipboardText` / `writeClipboardText` in
`src/lib/clipboard.ts` now: the Rust clipboard plugin first, the web API as the
fallback. The plugin has no gesture requirement either, which also covers
copy-on-select, whose write runs from a timer.

Two things to carry forward:

- **Do not call `navigator.clipboard` directly.** WKWebView gates it on
  activation and focus, WebKitGTK refuses reads outright, and a failure is a
  rejected promise that every call site swallows.
- **A synthetic key cannot find this.** WebDriver builds the event in the page;
  the suite's paste test passed for as long as it existed.
  `e2e/specs/shortcuts-linux.e2e.ts` presses the real keys.

## A conditional key inside `t()` hangs the typecheck

`t(IS_MAC ? "scheduled.ceiling" : "scheduled.ceilingSystem")` type-checks
correctly and never finishes: `tsc -b` ran past five minutes on five such
calls, and returned in its usual time once each was written as
`IS_MAC ? t("a") : t("b")`. The typed-keys overloads have to resolve the
union of both literal keys against the whole resource tree. Call `t` once per
key, which is what every existing platform variant in the tree already does
(`GeneralSection`'s tray label).

## `getComputedStyle` during a transition returns the value mid-flight

An e2e probe read `getComputedStyle(tab).backgroundColor` to decide which of
two tabs was selected. It reported the WRONG tab, stably, in the full-suite run
and the RIGHT one in the single-test run. That combination reads exactly like a
real state bug that only some orderings reach, and it was written up as one.

It is neither. The tabs carry `transition-colors` (150ms). `getComputedStyle`
returns the resolved value at the instant it is called, which during a
transition is the INTERPOLATED value, not the target. The full suite arrives at
the probe a few milliseconds after the click; the single test arrives later,
after the transition has finished. Same app, same state, different sample time.

Two things to take from it:

**Assert STATE, not the paint of state.** The dialog now exposes
`data-task-mode` / `data-task-source` on its form and the spec reads those. A
colour assertion is testing the animation as much as the app, and it fails for
a reason that has nothing to do with the behaviour under test.

**A control has to reproduce the failing condition.** The control here probed
immediately and again 500ms later, got identical values, and was taken as
ruling the transition out. It ran in the single-test timing, where BOTH samples
were already settled: it never exercised the case it was built to explain.
Confirming a theory in a run that does not fail proves nothing.

The narrow exception stays valid: when the defect IS the paint (a themed
`border-color` that never repaints in WKWebView, ## A radio dot moves and the
highlight does not), the computed value is the only evidence there is. Read it
after the transition has had time to finish, never straight after the click.

## One agent event is several store writes, and a per-write subscriber sees the first

`goAttention` in TerminalPane marks a blocked agent in two writes, in this
order: `setWorkState("done")`, then `markAttention("attention")`. Anything that
subscribes to the store and DECIDES on each write sees a tab that is done and
not yet asking, for exactly one write. The schedule watcher did: it closed a
run as finished (`no_report`, agent stopped) a moment before the run asked its
question, which then reached nobody. Measured, not reasoned: the `#attn` case
in `schedules.e2e.ts` failed that way with per-write evaluation and passes with
the decision moved to a microtask (`markDirty` in `lib/schedules/watcher.ts`).

Two more transitions read wrong on a single write: a title-driven agent goes
working, then idle (title glyph), then done only after the 5s settle, so
"idle after working" is not an end; and a done the user watched is written as
idle, never done (`done-while-watching`), so it carries no done stamp at all.

The rule: record observations on every write if you need the path (the
watcher notes "saw working" synchronously), but make the decision after the
burst settles, and never treat idle as an ending on its own.

## A sidebar row click restores the previous tab after it activates the task

`TaskRow`'s `onClick` in `Sidebar.tsx` calls `setActive(task)` and then, in
the same handler, `setActiveTabId(task, <the tab it last had in front>)`.
Anything that reacts to the activation synchronously (a store subscription on
`activeTaskId`) and brings a tab to the front is overwritten one line later.
The schedule watcher opened a run's report tab that way: the tab existed, the
agent tab was in front. Deferring the open to the next task fixed it, and the
watcher test that replays the click's two calls pins it.

## A srcdoc iframe takes the PARENT's base URL and CSP

An `<iframe srcdoc>` document has no URL of its own (`about:srcdoc`), so it
resolves relative URLs against the EMBEDDING page and runs under the
embedding page's Content Security Policy. In termic that page is
`tauri://localhost/`, which surprises in three ways, all measured in
WKWebView while building the HTML preview:

- `href="#section"` points at `tauri://localhost/#section`, a navigation
  the CSP blocks, so a report's table of contents does nothing.
- `<img src="chart.png">` is fetched from the APP's bundle, not from beside
  the file.
- `script-src 'self'` applies inside, so even `sandbox="allow-scripts"`
  runs no inline script. `frame-src 'none'` does NOT apply to srcdoc.

`<base href="about:srcdoc">` as the first token fixes the first two
(fragments scroll, relative URLs fetch nothing). A CSP `<meta>` written into
the srcdoc can narrow the inherited policy but never widen it, and WebKit
ignores one that lands in `<body>`. See `lib/htmlPreview.ts` and
docs/sandbox.md, "HTML preview: the iframe is the boundary".

## A focused CodeMirror takes the window selection back

A focused editor owns the DOM selection. Whenever its viewport redraws (a
scroll is enough) CodeMirror writes its own caret back into the document, and
a selection made anywhere else in the window collapses. Nothing is wrong in
the app: a real drag starts with a mousedown, which takes focus out of the
editor first, so the editor no longer claims the selection.

A spec has no mousedown. `editor.e2e.ts`'s markdown preview comment cases
selected text in the preview with a `Range` while the split's editor still had
focus and its viewport was settling from the scroll-sync cases before them.
The Comment pill came up and was gone before the next command, six cases
failed in a full run, and the file passed alone. A retry loop that re-selected
every 500ms was there already and only narrowed the window.

Measured both ways in one session: editor focused, select in the preview,
move the editor's viewport, and the selection is empty 600ms later, every
time; blur first and it survives, every time. So a spec that builds a
selection outside the editor blurs the active element first
(`selectInParagraph`), which is the part of the gesture it was skipping.

## A closed terminal tab loses shell history unless it gets a hangup

zsh writes its history file on a normal exit and on **SIGHUP**, and not on
SIGTERM; SIGKILL of course saves nothing. `pty_kill` used to SIGKILL the
child, so every command typed in a tab closed from the UI was lost, and the
archive / quit paths (SIGTERM, grace, SIGKILL) lost it too despite being
"graceful".

Every PTY teardown goes through `graceful_then_kill`, whose third tuple field
marks an interactive shell (`owner.kind` = `shell` / `aux` / `custom`): those
get SIGHUP before the SIGTERM/grace/SIGKILL sequence. Agent CLIs keep SIGTERM,
because that is what they flush their transcript on and a hangup would bypass
the handler. `kill_task_ptys` (a sandbox change) deliberately stays SIGKILL:
the termination there is a security boundary and must not wait.

Separately, zsh's default history is per-process: it loads the file at startup
and writes it at exit, so two live tabs cannot see each other's commands and
the later exit overwrites the earlier one's entries. The Appearance setting
"Share shell history across terminals" points a spawned zsh's `ZDOTDIR` at a
generated shim (`<data dir>/shell/zsh/.zshenv`) that sources the user's real
`.zshenv`, restores `ZDOTDIR` (zsh then looks up `.zprofile` / `.zshrc` in the
real directory, verified) and enables `SHARE_HISTORY`. The shim only ever
touches interactive zsh; bash and fish are left to their own configs.

## An edge that was dropped is a queue that never drains

Messages other agents send (`termic send`, MCP `task_send`) queue while the
receiving agent is "working" and drain on its turn end, which is `fireDone`.
So any turn end that does not reach `fireDone` strands the queue, and nothing
else releases it: the kick effect fires on a NEW queue item, not on a state
change, and the stall watchdog only looks at tabs still reading "working".

Measured with codex and `approvals_reviewer = "auto_review"`: PreToolUse
(working), PermissionRequest (needs-you, which sets the tab to done and clears
`localBusy`), the reviewer approves on its own, the turn ends, Stop. There is
no working report between the needs-you and the done, because the command's
PreToolUse fired BEFORE its permission request. `goIdle` then drops the done as
"not working", and every report from the tasks the orchestrator started sat
queued for good. A real prompt the user answers can end the same way.

The fix is one line in `goIdle`: a HOOK done that finds the tab not working
still drains the queue. The rule to carry forward: **a guard that drops a
signal because the state already moved on must ask what ELSE was waiting on
that signal.** The notification half of a done is safe to drop; the queue half
is not. e2e: "a queue behind a needs-you that resolved itself" (agent.e2e.ts,
fixture `#autoapproved`).

Two traps from reproducing it, both of which cost a wrong conclusion first:

- **A fixture agent without `setHooksOwnState(cli, true)` does not test a
  hooked agent.** The title fallbacks stand down only for a hooked tab, so on
  an unhooked fixture they drained the queue and the case passed WITHOUT the
  fix. Check the spawn line's `hooksInstalled=` in termic-workstate-e2e.log.
- **The e2e data dir and its `e2e-agent-prompts.log` persist across runs.**
  "The log contains my message" passed on a line from the previous run. Count
  the lines before the action and wait for the count to grow.

## A PTY's env starts as Termic's whole env: skipping a var does not drop it

`portable_pty::CommandBuilder::new` seeds the builder with every variable of
the current process (`get_base_env`), before `pty_spawn` copies anything. So a
copy loop that `continue`s past a var leaves the inherited copy in place, and
the child gets it anyway. The other agent session's markers
(`CLAUDE_CODE_SESSION_ID`, the messaging socket and token) reached every
spawned agent this way for as long as the skip existed, and the kept-out env
list (sandbox.md "Env vars kept out of agents") did nothing until it was
caught by an e2e case reading what the spawned process received.

Drop a var with `env_remove`, which `inherit_env` (lib.rs) does for every var
its predicate names; `inherit_env_removes_what_it_drops` pins it, with the
control that the builder really does start with the var. A unit test of the
predicate alone cannot catch this: the predicate was right the whole time.
