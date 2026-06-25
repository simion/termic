# Changelog

All notable changes to Termic, newest first. This file is the human-authored
source of truth: the in-app Update card and the /changelog page on termic.dev
are generated from it. See the `release` skill for how entries are added.

## [0.15.9] - 2026-06-25

New filesystem-only sandbox mode, and copyable terminal output when an agent exits.

### Features
- New "Enforcing (filesystem only)" sandbox mode: the full filesystem cage with the network sandbox off (no proxy, no host allow-list), for when your egress is controlled elsewhere or you need direct, non-HTTP traffic.

### Improvements
- When an agent or shell exits, the terminal stays interactive so you can select and copy its final output (an error message, say). A restart banner now appears under the tab bar instead of a blocking overlay.
- Mark-as-viewed is now an eye icon (Git panel rows and the diff header) so it's no longer mistaken for staging. Marking a file viewed from the diff header advances to the next unviewed file in the same order the sidebar shows, and the sidebar selection follows along. (#42)

### Bug fixes
- Sandboxed agents on the Apple Command Line Tools toolchain can run git, clang, make, and swift again (the CLT library path is now readable). (#49)
- Archiving a multi-repo "open repo" (repo-root) workspace no longer strips the member repos out of other live workspaces that share the same checkout. Archive now leaves a member link in place when another open workspace still uses it. As a safety net, missing member links are also restored automatically on workspace launch or a manual refresh.

## [0.15.5] - 2026-06-24

Mark files as viewed while reviewing, and pick what a split launches.

### Features
- Mark changed files as viewed from the Git panel rows or the diff header, with a per-section viewed count. The mark clears itself the moment an agent edits the file again. (#42)
- Files with inline review comments now show a comment count badge in the Git panel. (#42)
- Opening a right split (⌘D) now shows a picker to choose what to launch (an agent or a terminal) instead of immediately starting a shell. Use the arrow keys and Enter.

## [0.15.4] - 2026-06-23

Cleaner editor reloads, steadier Git repo pills, and New Workspace remembers how you work.

### Improvements
- New Workspace now remembers your last workspace type (worktree or repo root) and sandbox mode, so you do not re-pick them every time.

### Bug fixes
- Files opened in preview (temporary) mode now refresh quietly when an agent changes them on disk, instead of showing a false "modified" dot. A file you opened to edit asks before reloading, only when you focus its tab.
- After committing in a multi-repo workspace, the repo's pill stays put instead of jumping to another repo while the commit or push is still finishing.
- The vertical split divider no longer sits on top of the next pane's scrollbar, so you can grab and drag the scrollbar again.
- Diff view: changed comments stay legible. Their dim syntax color no longer drops below readable contrast against the green and red line wash. (#40)

## [0.15.3] - 2026-06-22

Linux AppImage fixes for python3 and Wayland, plus sandbox defaults and a sharper ⌘J.

### Improvements
- ⌘J is now three-state: from the agent it focuses the bottom terminal without hiding it, and only hides on a second press, so you stop closing it by accident.
- Sandbox allows the hosts and self-update endpoints that Copilot, Grok, and Antigravity need out of the box, and no longer flags common shell startup files (oh-my-zsh, prezto, fish), so sandboxed agents need less manual allow-listing.

### Bug fixes
- Linux (AppImage): python3 and perl work in Termic terminals again. The bundle exported PYTHONHOME, PYTHONPATH, and PERLLIB pointing at directories it does not ship, which broke anything that shells out to python3. (#47)
- Linux (AppImage): the GTK backend is overridable again. It still defaults to x11, but you can run `GDK_BACKEND=wayland termic` to use native Wayland, which avoids XWayland frame-stall freezes on some AMD/mutter setups. (#48)

## [0.15.2] - 2026-06-21

Keyboard shortcuts for the bottom terminal panel and jumping back to the agent.

### Features
- ⌘J toggles the bottom terminal panel: opens and focuses a scratch shell, or hides it and returns focus to where you were.
- ⇧⌘D also toggles the bottom terminal, as a fixed shortcut that keeps working even if you rebind ⌘J.

### Improvements
- ⌘L now jumps focus to the main agent (its terminal, or the open editor) from any pane, including from inside another terminal.

## [0.15.1] - 2026-06-19

Release notes now show what changed, and markdown previews show list bullets again.

### Improvements
- Release notes (in the app and on GitHub) now lead with what changed in each version, instead of install instructions.
- The in-app Changelog dialog renders formatted markdown.

### Bug fixes
- Markdown previews now show bullet and numbered list markers.

## [0.15.0] - 2026-06-19

Right-click menus everywhere, file rename/remove, self-contained multi-repo members, clearer diffs.

### Features
- Right-click context menus across the file surfaces: copy path (relative or absolute) and show in Finder from the All Files tree, the Git panel, the diff header, and the editor breadcrumb.
- File tree: rename and remove files or folders straight from the right-click menu.
- Right-click a workspace in the sidebar to open its actions menu.
- Multi-repo projects: members are self-contained, so adding one no longer leaves a separate project in the sidebar. Pick from your existing projects or add any folder from disk.
- Add a plain (non-git) folder as a project or multi-repo member: we confirm after you pick it, with no checkbox to set.

### Improvements
- Diff view contrast: softer change highlights and even add/remove line tints so syntax-colored code stays readable.
- New Auto editor theme matches the app palette, so a light theme no longer shows light code on a light background.

### Bug fixes
- Diff view: the unchanged lines bar no longer renders as a solid black bar on light themes.
- Right-clicking to dismiss a menu no longer leaves the UI unclickable.
- The updater re-checks for a newer release before installing and refreshes a stale changelog.

## [0.14.4] - 2026-06-18

Command palette (Cmd+K), quick project picker, worktree or repo-root toggle, right-click menus.

### Features
- Message queue: a Send now button fires the next queued message immediately, skipping the wait for the agent to finish.
- Message queue: a configurable minimum send interval (Settings, General; default 10 seconds) throttles the loop so messages can't fire too fast.
- Command palette (Cmd+K): search and run any action (new workspace, file picker, find in files, rename, archive, YOLO, sandbox, theme, sidebars, settings) from one place, with each action's shortcut shown inline.
- Quick project picker (Cmd+N): fuzzy-search any project and start a new workspace without scrolling the sidebar.
- New Workspace dialog has a worktree vs repo root toggle, so you can launch an agent directly in the repo's live checkout (no worktree).
- Right-click context menus across the app.
- Toggle the left and right sidebars with Cmd+B and Option+Cmd+B.
- Run tab picks up run scripts from a .termic.yaml in the workspace.
- File tree, open editors, and the Git panel auto-refresh when an agent finishes a turn.

### Improvements
- Clear focused terminal moved from Cmd+K to Shift+Cmd+K (Cmd+K now opens the command palette).
- The command palette and the Cmd+P, Shift+Cmd+F, and Cmd+N finders now read with more contrast, on a soft dim that fades in and out instead of snapping.

### Bug fixes
- OSC 52 clipboard: fixed garbled copies from agents that double-encode UTF-8 (for example em dashes landing as mojibake).
- Bottom terminal: closing its last shell now stays closed across restarts instead of reopening on its own.
- Dashboard: the projects list now scrolls when it overflows, and projects with active workspaces sort to the top.
- macOS Dictation no longer types every word twice in the terminal.
- Creating a worktree from the sidebar menu now autofocuses the name input.

## [0.13.4] - 2026-06-16

Remember markdown view mode, customizable branch prefix, copy on select, focus fix.

### Features
- Markdown files remember your last view (editor, preview, or split) and open new docs that way.
- Copy on select: selecting text with the mouse in any terminal copies it to the clipboard automatically. On by default, toggle in Settings, General.
- Customizable branch prefix for new workspaces in Settings, General (default "feature"). Leave it empty for no prefix.

### Bug fixes
- The bottom scratch terminal now grabs focus the first time you open it with Shift+Cmd+D, instead of needing a second press.

## [0.13.3] - 2026-06-15

Prompt library, an editor breadcrumb that reveals files in the tree, and multi-repo Git fixes.

### Features
- Prompt library: a Prompts menu in the top bar with built-in prompts (Review, Write tests, Security review, Explain the changes, Commit) plus your own. When you fire one, pick where it runs: any running agent (queued if it is busy) or a new agent with the CLI of your choice, and tweak the prompt before sending. Manage, reorder, disable, and reset prompts in Settings, Prompts.
- Editor breadcrumb under the tab bar: click any path segment to reveal and expand it in the file tree, plus copy-path and open-in-file-manager buttons.
- Hide inactive projects: an option in the project list menu folds projects with no agents into an Inactive Projects section (with a count) at the bottom of the sidebar, so the list stays focused on what you are working in.

### Improvements
- Multi-repo Git tab shows a pill only for repos that have changes (even when just one does), so the row stays focused on what you are actually editing.
- Smooth drag-to-reorder for projects in the sidebar.
- The file finder (Cmd+P) now matches the find-in-files width.
- Sidebar menus (agent picker, project options, workspace actions) open to the side and scroll within tall menus instead of overflowing the window in a short window.

### Bug fixes
- Pressing Tab in the code editor now indents (Shift+Tab dedents) instead of jumping focus to a toolbar button.
- Git tab: staging, unstaging, or discarding a file now moves focus to the next file in the list, and closes the preview diff once none are left.
- Git tab: Cmd+Enter from the commit subject or description now commits, and the preview diff closes after you commit.
- The Git tab no longer flashes empty when the window regains focus; it refreshes in place and only reloads when you switch projects.
- GitHub Copilot CLI: queued messages and fired prompts now submit reliably instead of sitting unsent in Copilot's input.
- Creating a new workspace under a collapsed project now expands the project first, so its name prompt is actually visible.
- Diff view: the Open button now opens the file in the editor (the external open option is gone).
- The project list menu tooltip no longer stays stuck open after you pick an item.

## [0.12.4] - 2026-06-14

Fix sluggish UI on Linux by keeping GPU rendering on for non-NVIDIA GPUs.

### Bug fixes
- Linux performance: the whole UI (not just the terminal) could feel laggy because termic switched off WebKitGTK's GPU accelerated renderer on every X11 session. It now stays on for AMD, Intel, and nouveau, and is only adjusted for the proprietary NVIDIA driver (DMA-BUF on X11, explicit-sync on Wayland).

## [0.12.3] - 2026-06-14

Completion sound now plays, and bun run works in sandboxed workspaces.

### Bug fixes
- Completion sound (#34): play it directly so it is audible on modern macOS, where the notification banner had stopped carrying the sound.
- Sandbox (#35, #36): bun run and bunx, and any tool that canonicalizes its working directory, now work in enforcing workspaces instead of failing at startup with a CouldntReadCurrentDirectory error.
- Terminals are no longer sandboxed (#32): a plain shell or a custom terminal entry (docker, ssh, repl) you open yourself is never caged, so git, ssh, and shell history work in a sandboxed workspace. Agents and custom-command workspaces stay sandboxed (they run automated tools against your repo).

## [0.12.0] - 2026-06-13

Leave PR-style review comments on diffs and send them to an agent.

### Features
- Inline review comments (#28): hover a line in a diff for a one-click comment button, or select a range, and leave GitHub-style feedback. Comments are batched per workspace.
- Send the whole batch to a running agent as one message. Each comment carries its quoted source, so the agent can still find the spot after line numbers shift, and sending focuses that agent's terminal.
- A pulsing footer pill shows how many comments are pending so they are not left unsent. The composer sends on Enter (Shift+Enter for a newline).

## [0.11.8] - 2026-06-13

Linux fixes: terminal copy/paste shortcuts and faster typing on NVIDIA/software WebGL.

### Bug fixes
- Linux: terminal typing no longer lags on NVIDIA or Wayland setups where WebKitGTK fell back to a slow software renderer (the DMA-BUF GPU path is now disabled in those cases).
- New GPU (WebGL) terminal renderer toggle in Settings, Appearance (Linux and Windows): turn it off if typing feels slow and the plain renderer is faster on your machine.
- Linux/Windows: terminal copy/paste now reach the system clipboard. Select text and press Ctrl+Shift+C to copy, Ctrl+Shift+V to paste (rebindable in Settings, Shortcuts). Plain Ctrl+C stays SIGINT for the shell.

## [0.11.6] - 2026-06-12

Custom terminals in the new tab menu, plus notification completion sounds.

### Features
- Custom terminals (#27): add your own terminal entries (docker exec, ssh boxes, REPLs) in Settings, Agents & Terminals. They appear under New terminal in the + tab menu and run through your login shell.
- Completion sounds (macOS): pick which sound desktop notifications play when an agent finishes a turn (Settings, General).
- New {workspace_path} placeholder for agent args and terminal command lines, expands per worktree.

### Improvements
- Diff view: side by side now disables itself only for genuinely new or deleted files, not files emptied in the worktree.

## [0.11.5] - 2026-06-12

Korean and CJK terminal input fixed, plus Linux AppImage rendering and install fixes.

### Bug fixes
- Fixed: typing Korean (and other IME-composed CJK input) into a terminal no longer drops characters. Composed syllables now reach the shell intact, so the agent and bottom split shells handle CJK input correctly (#29).
- Fixed: blank gray window on Linux X11 systems (NVIDIA and virtual machines included).
- Fixed: blank white window on Linux systems with newer Mesa drivers. The AppImage no longer bundles libwayland, which broke the host's EGL setup.
- Fixed: AppImage installs failed with 'Symlink target not found' in Gear Lever and AppImageLauncher.
- Fixed: the app icon now shows in Linux launchers and docks after integrating the AppImage.
- The Linux AppImage now builds on Ubuntu 22.04, so it runs on distributions with older glibc (Debian 12, Ubuntu 22.04 and newer).

## [0.11.4] - 2026-06-12

Split a workspace into two side-by-side panes. DontPayFull.com joins as our first company sponsor.

### Features
- Split a workspace into two side-by-side panes (#25). Each pane has its own tab strip and can run agents, terminals, or shells, and you can drag a tab between panes to move it.
- Each pane tracks focus on its own: only the active pane's tab is highlighted, and opening a file or queueing a message targets the focused pane.
- The message queue button follows the focused pane, so you can queue work for either agent independently.

### Sponsors
- [DontPayFull.com](https://www.dontpayfull.com) is Termic's first company sponsor. If your company builds on AI developer tools and wants to support open source, consider joining them on [GitHub Sponsors](https://github.com/simion/termic#sponsors).

## [0.10.11] - 2026-06-11

Quality-of-life improvements across the app.

### Features
- Editor tabs now reload from disk when the app regains window focus, so files an agent just edited are always current. Tabs with unsaved changes are never touched.
- Markdown preview tabs also refresh on focus.
- Changelog entries are now organized into sections (Features, Bug fixes, Sponsors) in both the in-app dialog and on the website.

### Bug fixes
- Right panel All files and Git tabs now stretch full width with a clear active indicator, matching the agent tab style.
- Bottom terminal strip: a visible border now separates the tab strip from the status bar when collapsed.

## [0.10.10] - 2026-06-11

All agent tabs now persist and auto-resume after restarting the app.

### Features
- Secondary agent tabs (the + button) are now durable: every agent tab is restored on relaunch and resumes its own session independently, so claude and codex can run side by side in one workspace across restarts (#23).
- Closing a secondary agent tab removes it for good; closing the main agent tab just stops it, and it resumes when the workspace reopens.
- Existing workspaces migrate automatically and keep resuming their current conversations.

### Bug fixes
- Ctrl+C on make dev / make run now reliably tears down the whole dev stack.

## [0.10.9] - 2026-06-10

Sidebar refreshes immediately after archiving a workspace; terminal links open via the system opener.

### Features
- Terminal links (Cmd or Ctrl click) now open through the system opener for more reliable cross-platform behavior.

### Bug fixes
- Archiving a workspace now updates the sidebar right away instead of staying stale until the next app reload.

## [0.10.8] - 2026-06-10

Fix missing app icon on Linux.

### Bug fixes
- The app icon now appears in the taskbar and launcher on Linux. The 512x512 PNG was present in the repo but not included in the AppImage bundle.

## [0.10.7] - 2026-06-10

GitHub Copilot support, clone any agent, drag-to-reorder agents, and sponsors section.

### Features
- GitHub Copilot CLI is now a built-in agent with the classic Copilot icon, live /yolo on/off toggle, session-id based resume, and sandbox paths pre-configured.
- Clone any agent from the Settings tab: the Clone button copies all settings into a new custom agent you can override independently. Cloned agents show an 'extends: parent' badge.
- Drag agent tabs left or right in Settings to reorder them. The order is saved immediately and reflected everywhere: dropdowns, sidebar, title bar.
- Added a Sponsors section to the website and README.

### Bug fixes
- Cloned and custom agents now show the correct brand icon everywhere (sidebar, top tabs, title bar, dropdowns, dialogs). Previously only the Settings page used the right icon.

## [0.10.6] - 2026-06-10

Redesigned message queue, an optional work-in-progress spinner, and hidden-file patterns for the file tree.

### Features
- The message queue is now a low-friction popover: add messages and they auto-send each time the agent finishes a turn, with no Start or Stop. Open it from the bottom bar, pick which agent, and see a live count per agent.
- New optional Work-in-progress indicator (Settings, General): show a spinner on an agent's tab and in the sidebar while it is working. It is off by default, and a stuck spinner clears itself after a few minutes.
- Hide clutter from the All files tree with glob patterns: a personal list across every project (Settings, General) and a per-repo list committed to .termic.yaml (Settings, Repositories), with one-click presets like Python, Node, and Build output. The Cmd-P file finder respects them too.
- Report a bug now opens a prefilled GitHub issue instead of an email.
- Markdown preview now uses the full pane width instead of a narrow centered column.
- The bottom status bar is tidier: shorter sandbox labels (Sandbox: enforcing, monitoring, or off) and consistent heights and text sizes across every bottom bar.

### Bug fixes
- The archive confirmation wraps long workspace and branch names instead of clipping them.
- Switching bottom terminal tabs with the keyboard now focuses the new tab so you can type right away.
- Resume args override now applies only to the main agent tab. Tabs added with the + button always start a fresh session.
- Multi-repo member directories no longer disappear from the file tree when hidden-file patterns are configured.

## [0.10.4] - 2026-06-09

Preview Markdown files with rendered text and Mermaid diagrams, plus git and editor fixes.

### Features
- Open a Markdown file (.md, .markdown, .mdx) and switch between Editor, Preview, and Split with the toggle in the toolbar.
- Mermaid code blocks render as diagrams in the preview, with a clear error box if a diagram has a syntax error.

### Bug fixes
- The Git changes panel now lists files inside a brand-new folder individually, instead of collapsing the whole folder into one entry with an empty diff.
- Opening a binary file (like .DS_Store) no longer leaves its error stuck on the next file you open, and now shows a plain message that the file is not text.

## [0.10.3] - 2026-06-08

Terminals use your real shell and environment, clickable links, and Settings fixes.

### Features
- New terminals now launch your real login shell (zsh, bash, or fish) instead of always zsh, and pick up a changed default shell right away.
- Agents and your setup and run scripts now inherit your login shell environment, so tools like bun and your $EDITOR (Ctrl+G in Claude) work the same as in a normal terminal.
- URLs printed in a terminal are clickable: hover to underline, Cmd or Ctrl click to open in your browser. Works in agent and scratch terminals, on macOS and Linux.
- New Workspace: paste a full branch name like username/my-feature and it is used as-is, with no prefix to fight. The sandbox control is now clearly labelled.
- Sandboxed agents no longer receive secrets exported from your shell config, and an activated Python or Conda environment is no longer pinned onto every workspace.

### Bug fixes
- Settings: the spacebar now works in agent argument fields, so you can enter multiple arguments.

## [0.10.2] - 2026-06-08

Resume agents from a custom session name, per workspace.

### Features
- New per-workspace Resume args override (workspace menu). Set custom resume arguments like --resume {WORKSPACE_NAME} so the agent resumes a named session instead of the auto-managed one. Placeholders {WORKSPACE_NAME}, {WORKSPACE_SLUG}, and {BRANCH} expand at launch. Save applies on the next launch, or Save and restart relaunches the running agent right away.
- The workspace row menu now uses a clearer three-dots icon instead of a settings cog, so it no longer looks like the project Settings button.

## [0.10.1] - 2026-06-08

Terminal editors keep their Ctrl keys, plus an optional Option as Meta key.

### Features
- New Appearance setting: Use Option as Meta key. Turn it on so Option+key acts as Meta/Alt in terminal editors, matching Terminal.app's option. It is off by default, so Option keeps typing accented characters until you opt in.

### Bug fixes
- Terminal-based editors (vim, emacs, nano) now receive Ctrl key combos again. On macOS, keys like Ctrl+P, Ctrl+W, Ctrl+K and Ctrl+S go to the focused terminal instead of being captured for app shortcuts. The app's own shortcuts still work with Cmd.
- Clicking Changelog on the What's new card now dismisses the card.

## [0.10.0] - 2026-06-07

New Monitoring sandbox mode that logs every access so you can build an allow-list.

### Features
- New: a third sandbox mode, Monitoring. It sits between Off and Enforcing: the agent runs with full access, but Termic records every file and host it touches and flags the ones an Enforcing sandbox would have blocked. Watch a real session, then build a precise allow-list before you switch the workspace to Enforcing, so the agent runs with low friction from the start. Pick the mode (Off, Monitoring, or Enforcing) when you create or edit a workspace.
- The blocked-requests popover doubles as a live activity log in Monitoring mode, with an Aggregate view grouped by folder and a Detailed view. Would-block accesses sort to the top for both paths and hosts, so the things you actually need to allow are right there. Click any row to add it to the allow-list, exactly like in Enforcing mode.
- Two toggles keep monitoring light and focused: Only would-block (on by default) records just the accesses an Enforcing sandbox would deny, and Exclude workspace dir (on by default) ignores the agent's own working tree. Both gate recording itself, not only the display, so long sessions stay fast and memory stays bounded.
- Hosts you allow per agent now persist in Settings, Agents, under Sandbox allowed hosts, and apply to every workspace that uses that agent, so you set them once.
- The Enforcing sandbox is now a pure allow-list: nothing is reachable unless you have allowed it, rather than a deny-list of known-sensitive paths. File and folder names stay enumerable, but their contents stay protected.
- New: per-workspace YOLO. Toggle auto-approve for every agent in a workspace from its menu in the sidebar; it is saved per workspace and shown as a red flash badge. Enforcing sandboxes turn it on automatically, since the cage is the real boundary. The old global toggle is gone.
- Multi-repo workspaces: Cmd+P (file finder) and Cmd+Shift+F (search) now look across every member repository, serially, with each result prefixed by the repo it came from. Both work even while a terminal is focused.
- Multi-repo workspaces: clicking a changed file in a repo-root member now opens its diff, and adding a member repo whose folder does not exist yet creates it on submit (git init plus a seed CLAUDE.md).
- Spotlight now appears only for worktree workspaces, where it makes sense, and is hidden for repo-root, multi-repo, and non-git workspaces.
- Git panel: switching between repository pills clears the current selection and closes the open diff, and the first repository with changes is selected automatically when you open the Changes tab.

## [0.9.0] - 2026-06-06

A Fork-style Git panel: stage, unstage, and commit without leaving Termic.

### Features
- New: the right panel's Changes tab is now a full Git staging area. It splits into resizable Unstaged and Staged panes so you can stage exactly what you want and commit it, without dropping to a terminal or a separate Git client.
- Stage or unstage a file by clicking the arrow on its row, double-clicking it, or using Stage all / Unstage all in each pane's header. In tree view, hovering a folder stages or unstages everything under it at once. After staging a single file it stays selected in its new pane, so you keep your place.
- Three ways to view the file lists: a collapsible Tree (the default), a Combined list grouped by directory, and a flat List of full paths. There's a filter box and a Hide untracked files toggle.
- Click a file to select it: the row stays highlighted and its diff against HEAD opens in the main area, so selecting and reviewing are one gesture.
- Commit form at the bottom: a subject, an optional description, and a split button that does Commit or Commit and Push (it remembers your choice). The first push of a new worktree branch sets its upstream for you.
- Discard a file's changes with Shift+Cmd+D (it asks first): tracked files are restored to HEAD, untracked files are removed.
- Multi-repo workspaces get a row of wrapping sub-tab pills, one per repository with changes, each badged with its own file count. Selecting a pill switches the whole staging area, including the commit form, to that repo.
- New shortcuts, both rebindable in Settings, Shortcuts: Cmd+S stages or unstages the selected file, Shift+Cmd+D discards it. A header refresh button reloads the file tree and Git status on demand.
- The diff viewer now opens in unified layout by default; side-by-side is still one click away and your choice sticks.

## [0.8.2] - 2026-06-05

Non-git projects, import existing worktrees, drag to reorder tabs, and a shortcuts cheat sheet.

### Features
- New: non-git projects. Add a plain folder that is not a git repo (for example a parent directory holding several repos) and run agents at the folder root so one agent can see every repo under it. Works for multi-repo projects too: the shared knowledge host can now be a plain folder while each member repo still gets its own worktree.
- New: import an existing worktree. The New workspace dialog now offers to adopt a git worktree that already exists on disk (created outside Termic, or whose entry was lost) instead of always branching a fresh one. It only appears when there is actually a worktree to import.
- New: drag to reorder tabs. Grab a tab in the top strip and drag it; the tab follows your cursor and the others rearrange live.
- New: a searchable keyboard shortcuts cheat sheet. Press Cmd+/ to open a read-only list of every shortcut, with an Edit button that jumps to Settings to rebind them.
- Closing an agent tab now asks for confirmation first, so an accidental Cmd+W no longer ends a running session instantly. Plain terminal tabs still close immediately.
- Desktop notifications now show the project and workspace name instead of the terminal name.

## [0.8.1] - 2026-06-04

Spotlight: run any workspace from your repo root, safely. Plus big terminal upgrades.

### Features
- New: Spotlight. Sync one workspace's changes into your repository root so you can run and test your whole dev stack against it, instead of from the isolated worktree. Enable it per project in Settings, Repository, under "Scripts & run" (off by default). Start or stop it from a workspace's menu in the sidebar, or from the new Spotlight tab in the right panel.
- Spotlight syncs three layers automatically: committed changes on the branch, uncommitted edits in the working tree, and untracked files (honoring .gitignore). A background watcher re-syncs within a couple of seconds whenever files change in the spotlighted workspace, so the repo root always mirrors what the agent is doing.
- How Spotlight differs from Conductor's, and why it is safer: Termic never writes a commit onto your branch. It checks out the workspace's commit at the repo root as a detached HEAD, so your branch ref never moves.
- The Spotlight tab shows a live sync log that names exactly which files moved on every pass (committed, uncommitted, and untracked). You always know the precise state of your repo root.
- Run while spotlighted is a first-class feature, executed at the repo root in its own tab as a real Run button (not a raw shell). When you switch Spotlight to a different workspace, Termic stops the old run and automatically restarts it against the new target.
- Spotlight guardrails: only one workspace per project can be spotlighted at a time, the repo root must be on a clean branch to start, and stopping fully restores the repo root (re-attaches your branch and removes copied untracked files).
- New: drag and drop a file onto a terminal to insert its path at the prompt, matching macOS Terminal and iTerm2.
- Drag and drop is sandbox-aware: when you drop a file onto a sandboxed agent, Termic asks how to share it. Choose to copy it into a temp folder the sandbox already allows, or add its folder or the exact file to the workspace's allow-list.
- Terminals now support the OSC 52 clipboard sequence, so copy and paste work inside Docker containers and over SSH sessions.
- Inline image rendering in terminals: both the iTerm2 inline image protocol and Sixel.
- Unicode 11 wide-character support, so CJK text and emoji take the correct width and no longer smear the cursor.
- Find in terminal with Cmd+F: live highlighting as you type, with Enter and Shift+Enter to cycle forward and backward through matches.
- Text selection contrast bumped significantly across every theme, so highlighted text is legible everywhere.
- Claude always shows the workspace name in its prompt header, including after a session resume.
- Configurable terminal scrollback in Appearance settings (default 5000 lines; the scratch shell keeps half to stay light).
- New: configurable keyboard shortcuts. Rebind any shortcut in Settings, Shortcuts, and reset everything back to the defaults in one click.
- New: queue messages for an agent. When work-done detection is on, each time the agent finishes a turn the next queued message is sent automatically. Set a repeat count to send the same message several turns in a row.
- Queues are per-agent and run independently, so agents in a split can each work through their own list at the same time.
- Custom-command workspaces: edit the launch command after creation from the workspace's menu, and write it as a multiline shell script.

## [0.7.11] - 2026-06-01

Reliable work-done badges, working desktop notifications, and a macOS Tahoe alignment fix.

### Features
- Work-done badges are now reliable across Claude, Gemini, and Codex. The blue dot appears when an agent finishes, and the tab you are actively watching never shows a false badge.
- Desktop notifications finally work. The old approach was silently dropped by macOS. Turn them on in Settings, General. They fire only for agents in workspaces you are not currently viewing.
- New per-agent Work-done detection toggle in Settings, Agents, for custom CLIs whose output causes false positives.
- Agents that emit no status signals (custom CLIs) show an attention bell instead of a done dot, since finished and waiting for input cannot be told apart.

### Bug fixes
- macOS Tahoe: the window traffic lights now line up with the toolbar in installed builds, not just in local dev builds.

## [0.7.7] - 2026-05-29

Launch workspaces with a custom command, plus sidebar polish.

### Features
- New "Custom command" option in the project menu: open the repo's current branch and launch your own command (ssh, a dev server, a REPL) in a terminal instead of an agent. The command runs in a login shell and drops back to a usable shell when it exits.
- Sidebar: a workspace now stays highlighted as active while an open file or git diff is showing, not just when a terminal tab is focused.
- Multi-repo: member tabs in the footer collapse into a "+N" menu when they don't all fit, so the Run and Open buttons are never clipped.

## [0.7.6] - 2026-05-29

Fix white corners on macOS Tahoe.

### Bug fixes
- macOS Tahoe: fixed white corners appearing at the window edges. The content-view clip now sets the window background to transparent so clipped corner pixels show the desktop instead of a white notch.

## [0.7.5] - 2026-05-28

macOS Tahoe window corners and traffic lights, maximized state restores, steadier agent resume.

### Features
- The window restores its maximized state on relaunch if you quit while maximized.
- Repo-root agent tabs resume reliably after a workspace sleeps and wakes, instead of occasionally starting a fresh session.

### Bug fixes
- macOS Tahoe (26): window corners now match the system's larger rounded frame, so the dark background no longer pokes out as black notches. The clip re-applies after fullscreen and zoom transitions.
- macOS Tahoe (26): the traffic-light buttons sit lower so they line up with the toolbar icons again.
- ⇧⌘[ and ⇧⌘] cycle the bottom-split shell's tabs when it has focus, and no longer skip the last tab.

## [0.7.4] - 2026-05-28

Repo-root workspaces auto-resume claude / gemini sessions, multiple per project. Editor search panel re-skinned, terminal links match iTerm.

### Features
- Repo-root workspaces now auto-resume claude and gemini sessions. Termic mints a session UUID on first spawn and resumes it on every spawn after, so the shared repo dir does not pull in sessions you ran outside termic.
- Create multiple repo-root workspaces per project. The sidebar prompts inline for a name (defaults to claude-1, gemini-1, etc.) so each one has its own session. Terminal rows skip the prompt because shells have no session to resume.
- Worktree auto-resume is unchanged. Every CLI's directory-based resume keeps working because each worktree has its own dir.
- Multi-repo member picker has a new Add repo from disk option that opens a folder picker, registers the path as a standalone project, and adds it as a member in one click. Available in both New Project and the project's Repository edit panel.
- Editor Find / Replace panel re-skinned: flat controls in termic's palette, no bevelled WebKit gradient buttons or bright green focus rings.
- Terminal links match iTerm and Ghostty. Underline and pointer appear only while Cmd or Ctrl is held; Cmd-click opens in the system browser.

### Bug fixes
- Workspace rename input is properly focused on open (was racing the dropdown close).

## [0.7.3] - 2026-05-27

Find in files is responsive on huge repos; Run focuses its own tab.

### Features
- Find in files: results from git grep are batched in Rust before they cross IPC, so a hot search on a giant repo no longer floods the WebView main thread and freezes Cancel / Esc.
- Find in files: visible Cancel (X) button while a search is running, and stale Tauri listeners from superseded searches are now released.
- Find in files: 350ms debounce and a 3-character minimum so slow typing on a big repo does not fire git grep mid-word.

### Bug fixes
- Run footer: clicking Run focuses the Run tab even when Setup was active (was asymmetric).
- Setup / Run scripts: PYTHONUNBUFFERED so Python output streams line by line instead of pausing in 4-64 KB blocks.

## [0.7.2] - 2026-05-27

Sidebar expand modes, no autocorrect in editor search, Run toolbar refresh.

### Features
- Sidebar: pick how workspaces reveal their agents (chevron only, click name, or auto open) from a new menu in the PROJECTS header. The same menu has Expand all / Collapse all and remembers your default.
- Auto open mode resets a manual chevron-collapse on wake, so a sleeping agent always comes back expanded.
- Run footer: persistent Setup tab is gone. The toolbar now has Setup / Run / Open plus a one-click Copy URL; Setup output appears in a transient tab only after you invoke it. Setup button hides entirely on projects with no setup script configured.
- ⌥⌘↑ / ⌥⌘↓ and ⌘[ / ⌘] now cycle workspaces in sidebar order (grouped by project), not the random JSON load order.
- Editor: Find / Replace inputs no longer get spellcheck or autocorrect squiggles.

## [0.7.1] - 2026-05-26

Signed Linux AppImage with in-app self-update.

### Features
- Linux x86_64 AppImage now ships with every release, signed by the same ed25519 key as the macOS build, so the in-app Update pill lights up on Linux exactly like it does on macOS.
- Download the AppImage from the Releases page, chmod +x, run. Keep it somewhere writable (~/Applications works) so the updater can replace it in place.
- Sandbox is still macOS-only on Linux; everything else (worktrees, parallel tabs, find-in-files, themes, in-app diff) works the same.

## [0.7.0] - 2026-05-26

Sender-driven work-done indicator, Grok support, worktree polish.

### Features
- Work-done indicator: per-CLI title + OSC 9;4 classifier (Claude / Gemini / Codex) with byte-quiet, scrollback, and content-hash gates so a static '✦ Working' title doesn't false-fire done. Blue bullet on the tab when a turn finishes, sticky until you focus the tab or type.
- OS notifications wired through Claude's OSC 9 / OSC 777, with focus-edge routing that drops you on the right workspace and tab when you click in.
- Tab pills now show the raw agent title (spinner glyphs and ✳ / ◇ included) so the brand-emitted status surfaces as real signal instead of getting stripped.
- New agent: xAI Grok auto-detected. --always-approve as YOLO, --continue as resume, sandbox paths under ~/.grok.
- Welcome wizard CLI rows recolored: installed agents are green, missing ones neutral gray. The old red 'not installed' read as a wall of failures when most users have one or two CLIs.
- Sandbox shield button moves to the UnifiedBar next to Review. Sidebar rows for sandboxed workspaces show an always-on green shield that swaps to the cog on hover.
- Workspace cog menu: new 'Copy branch name' and 'Duplicate worktree' entries. Duplicate seeds the new-workspace dialog with the source workspace's branch tip as the base.
- Worktrees create branches via two-step 'git branch --no-track' + 'git worktree add', so deleting a workspace's branch no longer prompts to drop the remote ref it was branched off.
- git-crypt repos now work in worktrees: --no-checkout, symlink the key dir into the per-worktree gitdir, then hard reset so the smudge filter can decrypt.
- Project Settings: Default CLI always includes Terminal (plain shell) as a fallback, picked automatically when no agents are installed.
- Save-sandbox-changes confirm now has a warning-tinted backdrop and yellow ring so it visually separates from the parent dialog you're saving from.

## [0.6.0] - 2026-05-25

File finder, find in files, and richer sidebar navigation.

### Features
- ⌘P opens a fast fuzzy file finder for the active workspace.
- ⇧⌘F runs find-in-files: literal, case-insensitive, .gitignore-aware, streams live (250ms debounce so a typing burst issues one search, not five).
- ⌥↑ / ⌥↓ now walk every visible sidebar row (workspaces plus their expanded terminal tabs); ⌥⌘↑ / ⌥⌘↓ still hops workspace-only.
- ⌘1..⌘9 switches between tabs in the active workspace (Chrome / VS Code convention) instead of jumping workspaces.
- Workspace breadcrumb drops the redundant 'name on branch' when the workspace was never renamed; repo-root workspaces get the same REPO ROOT chip the sidebar shows.
- Tab titles no longer carry the agent's leading state glyph (Claude's ✳, Gemini's ◇); busy/idle detection still uses the raw title.
- Project menu has a new Terminal entry that opens the repo in a plain shell tab.
- Denied hosts popover gets one-click copy for hosts and paths.
- Sandbox now allows ~/.local/share (uv, pipx, pnpm, mise) and ~/.config/git/{ignore,config,attributes} by default.
- Multi-repo Layers marker sits after the project name so rows stay vertically aligned.

## [0.5.6] - 2026-05-25

Wider Changelog dialog so release notes have room to breathe.

### Features
- Changelog dialog is now noticeably wider (max-w-2xl) so multi-line bullets stop wrapping into narrow ribbons.

## [0.5.5] - 2026-05-25

Save sandbox changes without restarting the agent, plus a make run alias.

### Features
- Sandbox dialog now has a Save without restart button that persists the new profile while leaving the running agent on its OLD profile until it next respawns.
- Save & restart terminal button gets a clearer restart icon.
- make run is now an alias for make dev.

## [0.5.4] - 2026-05-25

Update card puts the Changelog link above the Update button.

### Features
- Reordered the sidebar Update card so the Changelog link sits between the summary and the Update button.

## [0.5.3] - 2026-05-24

Scrollable sidebar, smarter workspace collapse, inline .termic.yaml editing, bulleted changelog, reordered agents.

### Features
- Sidebar project list now scrolls when it overflows, and the Update card floats above the footer so it stays visible no matter how far you scroll.
- Workspaces auto-collapse when they have a single terminal and auto-expand the moment a second tab is added.
- Idle workspaces show a moon icon in the sidebar.
- Clicking a focused workspace toggles its collapse; clicking an unfocused one just activates it.
- Inline .termic.yaml editing for scripts and sandbox settings, with a .termic.yaml / Personal toggle.
- Live syntax-highlighted code preview in Appearance settings.
- New sandbox bypass-permissions preference.
- Removed the one-agent-per-repo-root limit.
- No spellcheck on rename inputs.
- Changelog dialog now shows each version as a short headline plus a bulleted list of changes.
- Sidebar Update card shows just the headline. The full details live one click away in the Changelog.
- Reordered the built-in agents to Claude, Codex, Antigravity, Gemini across the new-tab menu, new-workspace picker, review picker, and Settings.

## [0.5.0] - 2026-05-22

Broadcast to multiple agents, premium file explorer, 8 syntax themes.

### Features
- Broadcast commands to multiple agents concurrently with the new Megaphone dialog (⇧⌘B).
- Premium file explorer with Sublime-style preview tabs.
- 8 syntax themes and razor-sharp static typography.
- Added standard Google hosts to the baseline sandbox allowlist for Gemini and Antigravity.

### Bug fixes
- Fixed a macOS sandbox crash and connection blocks for the Antigravity agent.

## [0.4.6] - 2026-05-21

Sharper keyboard focus for terminal tabs.

### Features
- Closing a tab keeps focus in the same pane.
- New tabs grab focus on spawn.
- ⌘T opens the new-tab menu.

### Bug fixes
- Fixed a doubled border on the collapsed Setup/Run footer.

## [0.4.5] - 2026-05-20

In-app self-update prompts and a detailed Changelog dialog.

### Features
- Self-update in-app prompts.
- Detailed Changelog dialog.
- Optimized, decoupled terminal rendering logic.

## [0.4.4] - 2026-05-20

Missing glyphs fall back to bundled JetBrains Mono.

### Bug fixes
- Characters missing from your chosen terminal font now fall back to the bundled JetBrains Mono instead of a thinner, mismatched system face.

## [0.4.3] - 2026-05-20

Two-step Esc to close Settings, Antigravity sandbox access to ~/.gemini.

### Features
- Esc now closes the Settings panel in two deliberate steps.
- Sandbox grants the Antigravity agent access to ~/.gemini.

## [0.4.2] - 2026-05-20

Save from the built-in editor, Antigravity CLI, plain shell tabs.

### Features
- Save files straight from the built-in editor with a dirty-state indicator.
- Use the new Antigravity CLI.
- Open plain shell tabs alongside your agents.
