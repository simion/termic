# Changelog

All notable changes to Termic, newest first. This file is the human-authored
source of truth: the in-app Update card and the /changelog page on termic.dev
are generated from it. See the `release` skill for how entries are added.

## [1.23.0] - 2026-11-13

Agents pair computers for you, faster PR badges, easy-to-send crash logs.

### Features
- Pairing: an agent can pair this machine with another one end to end. It asks the other machine to show a code, then asks you only for the 4 digits (`termic peer pair <machine>`, MCP `peer_pair`).
- PR status for GitHub tasks is fetched in one query per host instead of one call per task, so a merge shows within a minute even with many PR tasks. Merged and closed PRs are re-checked hourly instead of every tick.
- Todos: every GitHub list on a host loads in one query instead of one call per project and list.
- Termic tracks its share of your GitHub API limit. Background polling pauses before it can run the token dry, Settings, General shows the budget per host, and a top-bar pill appears while polling is paused ([#455](https://github.com/simion/termic/pull/455)).
- Report a bug fills in the Termic version and OS. When Termic has a crash log, it also selects the file in Finder (Explorer on Windows) so you can drag it into the issue.
- macOS: the crash log also records Objective-C exceptions, which it missed before.
- New Task: importing an existing worktree uses the column beside the fields, like the branch, PR and issue sources ([#456](https://github.com/simion/termic/pull/456)).

### Bug fixes
- Pairing with a machine whose clock is off now says so, with how far off it is. Before, each side showed the other as revoked, and removing and re-pairing never fixed it.
- macOS: ⌘W inside an HTML preview closes the tab instead of the whole window.
- Sandbox: a caged agent's hook no longer hangs forever when its terminal is gone, and `cargo test` run by a caged agent finishes ([#457](https://github.com/simion/termic/pull/457)).

## [1.22.1] - 2026-11-11

Secrets for agents, a sectioned New Task dialog, and accounts that share your MCP servers.

### Features
- Secrets (experimental): give a task a role, and its agent uses that role's tokens through a local broker without ever seeing them. Settings, Secrets holds the secrets, the roles and their rules, with a simple view, starter roles, a request tester and JSON import and export. Host env vars you name are kept out of agent tabs.
- A terminal tab can run a Secrets role of its own, picked from the new-tab menu, with its own broker separate from the agent's.
- The status bar's sandbox and Secrets controls are one cage chip: mode, Keychain block, role and YOLO in one popover, and Cage activity lists what was blocked, used or looked suspicious, with Allow and Undo.
- New Task: one fixed size, with a rail of sections (Task setup, Repos, Pick agent, Sandbox, Secrets) that shows each section's value and flags a warning. A disabled Create says what is missing and jumps to it.
- New Task: agents and sandbox modes are listed in a column beside their options, and the issue, PR or branch column grows in beside the form when you pick that source.
- New Task: extra agent arguments, and a session to resume, set when the task is created.
- Accounts: a second Claude account gets the same MCP servers as your main one, user and project ones alike, and the MCP sign-ins it is missing, so it does not ask you to log in to each server again.
- Accounts: rename an account (the pencil on its chip in Settings). The new name is a label only; its login stays where it is.
- Accounts: make an account the default with the star in the footer's account panel or on its chip in Settings, and a dot marks the account this task uses, with "after restart" while a switch is waiting for one.
- termic CLI and MCP: `send` types the message at once, even into an agent that is busy mid-turn. `--queue` (MCP `queue`) waits for the turn to end instead.

### Bug fixes
- Picking a pull request in New Task or Review PR uses a local branch of the PR's own name when you already have one, instead of creating a second `pr-<number>` branch. It is only fast-forwarded, so your local commits stay.
- Linux and Windows: the Claude credentials file Termic writes for a second account is readable by your user only ([#453](https://github.com/simion/termic/pull/453)).
- Agents started from a Termic that was itself launched from inside Claude Code no longer inherit that session: transcript saving stays on, and they no longer pick up its effort level or session id.
- macOS: opening many terminals no longer fails with "Too many open files" once about 50 are open across tasks.
- The sandbox proxy tries every address a host resolves to, so a network with a broken IPv6 route no longer fails every connection with a 502.
- Save & restart in the sandbox dialog brings back every agent in the task, not just the first.
- Blocking the Keychain also denies keychain files outside `~/Library/Keychains`, and keeps the system services that need it reachable.
- A caged agent told it is not logged in to gh is told that the cage is why.
- A program placed in a worktree under the name of one Termic runs (such as `env` or `docker`) can no longer run in its place outside the sandbox.
- opencode 2: Termic's plugin loads again, so its working and done states show ([#447](https://github.com/simion/termic/pull/447)).
- Settings: a project's tasks folder override is no longer saved as the repo itself while its check is still running.
- Settings: pressing Esc to close a menu or popover no longer counts toward closing Settings.
- New Task: a branch name containing angle brackets is shown as text.

## [1.21.0] - 2026-11-05

Turn a plain folder into a git repo, bind mouse buttons, a full-width markdown preview.

### Features
- Add project: a folder that is not a git repository can be made one right there (git init and an empty first commit), so its tasks get their own branches ([#443](https://github.com/simion/termic/issues/443)).
- Shortcuts: the mouse back and forward buttons can be bound to any command in Settings, Shortcuts, with or without modifier keys ([#442](https://github.com/simion/termic/issues/442)).
- Markdown preview: text runs the full width of the pane by default. Readable, Wide and Narrow are still under Aa.
- The new-task menu keeps anything you used in the last 7 days at the top level, up from 5.
- The command palette's Recent section remembers commands for 8 hours, up from 1.
- Set syntax lists Markdown, Plain Text, YAML, JSON and Shell first.
- Every Rust panic is written to `logs/panic.log` in the app data folder, so a crash can be traced back to what caused it ([#439](https://github.com/simion/termic/issues/439)).
- Install on macOS or Linux with one command: `curl -fsSL https://termic.dev/install.sh | sh`.

### Bug fixes
- Agents installed under nvm and similar no longer go missing from New Task when the login shell is slow to start ([#441](https://github.com/simion/termic/issues/441)).
- Creating a task in a repo with no commits says to make a first commit, instead of showing git's error ([#443](https://github.com/simion/termic/issues/443)).
- A task created from an existing PR no longer gets the new-PR highlight on its badge.
- The task keys (⌥⌘↑/↓, ⌥↑/↓ and the waiting jump) walk the sidebar's rows in order, task groups included.
- macOS: the font list no longer takes an hour and gigabytes of memory with a very large font collection installed, such as Sarasa Gothic ([#444](https://github.com/simion/termic/pull/444)).
- Settings, Shortcuts: rows without a description no longer show a raw translation key.

## [1.20.0] - 2026-10-28

Review markdown in the preview, pick Todos projects, keep the display on.

### Features
- Markdown preview as a review surface: a reader layout with its own text width, font and line height (Text width: Full brings the old look back), line numbers, an outline, go to line (⌘G), and task lists and whole blocks you can edit right in the preview. It also renders callouts, footnotes, definition lists, highlights, math and collapsible sections.
- Todos: pick several projects in the filter, remembered. Issue and PR lists are cached, so Todos, New Task and Review PR open with the last lists right away.
- Keep awake: a Keep display on option (off, the screen can still turn off and lock while the computer stays awake), an ∞ preset that holds until you turn it off, and the last duration you started is preselected.
- Sidebar: a PR opened in a task you have not visited yet is highlighted on its badge until you open the task.
- Task finder: an Open filter (⌘7, Ctrl+7 on Linux and Windows, or `is:open`) for tasks with a live agent, and ⌘O opens the finder on it whenever an agent is running.
- Audio files in the file tree open in a player.
- termic CLI and MCP: `new --member` (MCP `members`) picks which repos of a multi-repo project get a worktree, and `project list` shows each project's members.

### Bug fixes
- A task's PR badge no longer gets stuck: review tasks on a detached HEAD find their PR by number, and a PR an agent opens shows up when its turn ends ([#435](https://github.com/simion/termic/issues/435)).
- Windows: the mouse wheel reaches terminal apps that ask for it, such as opencode ([#437](https://github.com/simion/termic/issues/437)).
- Windows: settings files are replaced in one step, so a read never finds one missing or half-written ([#195](https://github.com/simion/termic/issues/195)).
- Windows: the comment box fits its text at 125% display scaling instead of showing a scrollbar.
- The Keep awake popover no longer shows its title twice.
- Schedules: a one-off set from the CLI or MCP with a time already past is refused instead of marked done, and a time skipped by a clock change is reported ([#403](https://github.com/simion/termic/issues/403)).

## [1.19.2] - 2026-10-26

Keep your computer awake while agents work, triage todos, share shell history.

### Features
- Keep awake: a coffee button at the bottom left of the sidebar stops your computer from sleeping for a set time, until a date and time, or while agents are working. The screen can still sleep and lock. Optionally it also keeps a closed-lid Mac awake, and puts normal sleep back when the session ends, at logout, or when Termic quits.
- Todos: a new sidebar view gathers the issues and pull requests from every project, filtered by kind and by what needs you, with one click to start a task from an issue or review a PR. It can be hidden in Settings, Appearance.
- Agent customizations: skills and MCP servers kept per profile are added to every task for Claude, Codex and agents that read `.agents/`, with a project able to opt out or opt in on its own.
- Sandbox: a per-task Block Keychain access option for Seatbelt-caged tasks, so the agent cannot read the macOS Keychain.
- Shell history is kept when you close a terminal tab, and zsh tabs share one history as you type (on by default, Settings, Appearance).
- Sidebar: a task can show its branch name after the name, on the right or below it. Off by default, in the Projects menu and Settings, Appearance.
- Task finder: ⌘1 to ⌘6 (Ctrl on Linux and Windows) filter by All, Working, Settled, Attention, Review and Backlog, shown as chips in the footer.
- Settings, Agents & Terminals: agents are a vertical list beside their card, and Agent hooks and Agent customizations sit below them.

### Bug fixes
- A Codex permission prompt no longer rings again every 10 seconds while it waits.
- With Codex's automatic approval review on, a command it approves by itself no longer marks the tab as needing you. Only a prompt a person has to answer does.
- Messages from other agents (task reports sent with termic send or the MCP server) no longer stay queued forever when the receiving agent's turn ends right after a permission request, for example one Codex's automatic review approved.
- Clicking Install hooks for every agent right after opening Settings is no longer undone a moment later.
- Codex accounts on credits show their budget in the usage footer instead of "Usage unknown".
- Antigravity (agy) no longer drops the first prompt of a new tab, and new folders no longer stop at its trust question.
- Agents started with termic new or tab, or the MCP tools, are told to report back to the agent that started them.
- The Git tab keeps its Push button after you commit every change, so the commit can still be pushed ([#426](https://github.com/simion/termic/issues/426)).
- Dropping files from Finder onto a terminal works on Retina displays.
- The Run script hints say a server must stay in the foreground: one started with &, nohup or --background keeps its port after Stop.

## [1.18.2] - 2026-10-20

Review tasks get names, pins sit atop the file tree, usage limits read as waiting.

### Features
- Review a PR asks for the task's name and group. The name defaults to the PR's branch and the task files under a Review group, both remembered.
- The termic CLI and the MCP server can move a task into another task's group (--join) or out of its group (--leave).
- A tab row's menu gains New above and Mark as unread. A marked tab shows an orange dot until you revisit it, and the mark survives a relaunch.
- Shift+Enter sends a newline in OpenCode.
- A pinned folder or file is drawn at the top of the file tree as an ordinary entry, labelled with its path, and expands in place. The separate Pinned section is gone, and the pin glyph shows only on pinned rows, not on every row you hover. Pin from the row's context menu.
- A Claude tab that hits its usage limit shows as waiting (the dashed ring, "usage limit") instead of spinning, and goes back to work on its own when the window resets.
- Settings, Agents & Terminals: each agent's card can show its recent hook reports, grouped per tab, with what Termic made of each one and a Copy all button, for checking what the agent actually told Termic.
- The project filter icon in the sidebar is drawn at rest, like the + beside it.
- The termic CLI and the MCP server can launch a task on a named agent account (new --account, task_new's account), and the agents listing shows each agent's accounts with the default marked. Meant for when you ask an agent for a specific account; without it the default is used.

### Bug fixes
- Quitting Termic now gives agents a moment to shut down (SIGTERM, then SIGKILL after 1.5s) instead of killing them outright, so they can save and their MCP servers and shells do not linger.
- A held agent message is no longer pasted while you are still clearing a draft with a held Backspace, which deleted it before it sent.
- Typing a font size, scrollback or UI scale in Settings no longer snaps to the minimum or maximum mid-keystroke.
- After dragging a sidebar row, the next real click is no longer swallowed.
- Turning on Share on this network now reads the MCP setting from disk, so sharing can no longer come on with MCP off.
- A pinned folder or file is moved to the top of the file tree, not copied: it no longer shows a second time in its parent's listing.
- Codex is launched with --no-daemon. Since codex 0.157 the interactive session ran through a shared background daemon that executed Termic's hooks with the first tab's environment, so codex tabs read as working or done from the terminal, and their reports could land in another tab. Needs codex 0.156 or newer.

## [1.17.2] - 2026-10-16

Sharing asks for local network access, and pairing makes sure your agent can use it.

### Bug fixes
- Turning on Share on this network (Settings, Agent access) now makes macOS
  ask for local network access. Before, a Mac that had never been asked
  stayed blocked without a prompt, and no other computer showed up.
- Pairing now requires Termic's MCP server in your coding agent. Settings
  shows it as a required step with Add to Claude Code and Add to Codex, and
  Pair stays off until it is done; a computer paired without it says so.
- Add to Claude Code now adds Termic to every Claude account, not just the
  default one. Each account keeps its own MCP servers, so tasks on a second
  account could not reach a paired computer.
- `make beta` builds again on a Mac with no Developer ID, ad-hoc signed.

## [1.17.0] - 2026-10-15

Pair your computers so agents work across them, and a tidier sidebar and new-task menu.

### Features
- **Pair computers on your network (experimental).** Settings, Agent access,
  Other computers. Click Pair on a computer Termic finds nearby; it shows a
  four-digit code, you type it here, and the two are paired. Name the other
  computer on this side (it keeps its own name everywhere else) and give it a
  role, Orchestrator or Worker, or none. Agents on either one can then start,
  prompt and read tasks on the other (`termic --peer`, the MCP `peer`
  argument), a report back skips the waiting agent's queue, and work a paired
  computer starts in a closed profile opens that profile's window. Off by
  default, and macOS asks for local network access the first time.
- **Agent access.** The CLI and MCP settings are one page with a tab each.
  Connecting an agent over MCP has a tab per client (Claude Code, Codex,
  other) with just the command or config to copy.
- **A shorter new-task menu.** Entries you have not used in five days move
  under More, with Start a race and Resume. Each agent's place is a choice in
  Settings, Agents: Auto, Always shown, Pinned (first), In More, or Off,
  which replaces the Enable switch. Claude, Codex and Antigravity are always
  shown, dimmed with "not installed" until they are.
- **New task under a project's tasks.** A `+` row below the last task, where
  the new task lands, with a setting in Appearance (empty projects, two or
  fewer projects, or always).
- **View options.** The sidebar's list menu (now a sliders icon) is three
  short sections, with switches that keep the menu open while you change
  several.

### Improvements
- The sidebar's headers are filled bars instead of boxes and borders, each
  project's menu is always visible, and every menu uses one text size.
- An agent's card in Settings folds its rarely used fields away and moves
  the long explanations into tooltips.
- The deep review prompt labels findings BL, SG and NT.

### Bug fixes
- ⌘W in a focused HTML preview closes the preview, not the Termic window.
- A "needs you" bell no longer stays on after the prompt went away without
  an answer (denied by the agent's own countdown, say) and the agent carried
  on working.
- Turning the CLI or MCP endpoint on or off from a second profile's window
  now holds after a restart.
- Windows: Ctrl+V with an image on the clipboard pastes the image's path.

## [1.16.1] - 2026-10-14

A guided first launch, Review a PR, History by PR, and new-file previews.

### Features
- **A shorter welcome and a short tour.** The first-launch wizard is one
  screen now: the agents Termic found, and two ways out. "Show me around"
  walks you through five cards that point at the real controls (add a
  project, where the agent works, naming the task, starting it, the
  sidebar's status marks), each with a step count and a Got it. Pressing
  the control a card points at moves you on.
- **Tips, once.** Small cards point at a feature the moment it is useful
  (an agent waiting in another task, changes ready to review, an account
  near its limit, a status line keeping usage numbers out) and never come
  back once seen. If you already had Termic set up, you only get tips for
  features added after this release. Settings, General can replay the tour
  or show every tip again, or turn tips off.
- **Review a PR.** Paste a PR number or link, pick a worktree or the main
  checkout, an agent and a review prompt, and Termic fetches the PR and
  starts the review with the PR's details in front of the prompt, which you
  can edit for that review. Open it from the command palette or a project's
  `+` menu, or bind a shortcut. `termic review <pr>` and the MCP
  `task_review` tool do the same.
- **Review prompts, as many as you like.** Prompts in Settings, Prompts take
  labels, and the list filters by them. Every prompt labelled Code review is
  offered when you review a PR. Two come built in: Review, and Deep review,
  which runs eight focused reviewers side by side, filters out false
  positives, and reports findings as BL-1, SUG-1 and NIT-1. "Edit or add
  review prompts" opens Settings without losing the review you were setting
  up, and a prompt you add there is picked when you come back.
- **History by pull request.** The History page is a wide table with each
  task's branch, what it was cut from, and its PR: number, last known
  state and title. Search a PR number (`#123`, or the link) to find the
  task behind it and restore it.
- **Preview new files from the Git tab.** A new Markdown, HTML or SVG file
  opens rendered, with a switch back to source. A new file's diff no longer
  paints every line as an insertion.
- **A schedule can run once,** on a date you pick, beside daily, weekdays
  and weekly. Thanks to [@GabrielDumbrava](https://github.com/GabrielDumbrava).
- **Right-click a tab row in the sidebar** to open a new tab below it or
  close it, and drag tab rows to reorder them. Thanks to
  [@AppsOfUse](https://github.com/AppsOfUse).
- **`is:open` in the task filter** and an action chip find the tasks that
  have an agent running. Thanks to [@nvkvin](https://github.com/nvkvin).

### Improvements
- **Add Project asks where your repos live** and lists what is in a folder
  as soon as you stop typing its path.
- **The status line fix prompt covers context too,** asks whether to change
  the repo or a git-ignored local file, and is in each project's settings
  for later.
- **Recently used tabs and Search everywhere take your own keys.** Record
  the hold-and-tap gesture, and bind a chord to Search everywhere. Thanks
  to [@AppsOfUse](https://github.com/AppsOfUse).
- **The theme list names the current theme** beside the search box and
  scrolls to it on open. Thanks to [@wagoodman](https://github.com/wagoodman).
- **Agents can delete scratchpads:** `termic scratchpad rm` and `clear`, and
  the matching MCP tools.

### Bug fixes
- A task an agent created from inside another task could land in an
  unrelated task group that shared its group's name.
- macOS: Termic could crash when the pointer rested over selected text, on
  macOS versions with Writing Tools. Thanks to [@nvkvin](https://github.com/nvkvin).
- macOS: Ctrl+P reaches the shell in a terminal again. Thanks to
  [@jeromewir](https://github.com/jeromewir).
- A PR closed without merging shows as a muted red, struck through, and the
  sidebar's mode mark sits beside the task name.
- The "pi" agent's name was nearly invisible in the New Task agent picker
  on dark themes.
- Linux: switching a Markdown preview to split view could leave the editor
  at the top instead of beside what you were reading.

## [1.15.0] - 2026-10-12

Shared scratchpads, Ghostty and Warp themes, markdown review comments, pinned folders, and a Linux pass.

### Features
- **Scratchpads for a project, a profile, and everything.** Beside a task's
  own scratchpad there are now three shared ones, each a folder of files
  rather than a single note: per project, per profile, and global. They have
  their own panel on the right, where you can create, rename, delete and
  reveal files, or copy one into the task's worktree. ⌘S on an untitled note
  asks which one to save it to. The CLI and the MCP tools take a scope
  (`task`, `project`, `profile`, `global`), and config sync carries them
  between machines. Thanks to [@nvkvin](https://github.com/nvkvin).
- **Your Ghostty and Warp themes are in the theme list.** Themes found on
  disk show up beside the built-in ones, with a live preview as you arrow
  through them. Picking one saves a copy in Termic's own format, so it keeps
  working if the original goes away. The sidebar's theme icon opens the list.
  Thanks to [@wagoodman](https://github.com/wagoodman).
- **Comment on rendered markdown.** Select anything in a markdown preview and
  a Comment pill opens the same composer as the code side: send now or add to
  the pending batch. The comment also shows beside its source in the editor.
  Thanks to [@wagoodman](https://github.com/wagoodman).
- **Markdown split view scrolls together.** Scroll the source or the preview
  and the other follows, smoothly through tall images and long paragraphs.
  Thanks to [@wagoodman](https://github.com/wagoodman).
- **Pin folders in the file tree.** Pin a folder from its menu or the pin on
  its row, and a Pinned section at the top of All files jumps to it. Pins
  belong to the project, so every task in it sees them. Thanks to
  [@lymanzhao](https://github.com/lymanzhao).
- **"From a PR" works on GitLab, and can list every open PR.** New Task now
  lists your merge requests and the ones waiting for your review on GitLab,
  and takes a pasted MR number. Two chips switch the list between For you
  and All open (the newest 50) on GitHub, GitLab and Azure DevOps. Thanks to
  [@nvkvin](https://github.com/nvkvin).

### Improvements
- **"From an issue" filters to yours on GitLab and Azure DevOps.** The
  Assigned to you chip in New Task was GitHub only. Thanks to
  [@nvkvin](https://github.com/nvkvin).
- **The sidebar's status chips are a total and its parts.** Tasks in action
  comes first and counts everything that is not in the backlog; Working,
  Needs you, In review and the new Settled chip say where those tasks are,
  and always add up to it. The Done chip left the row (`status:done` still
  works in the filter), and the filter's "1 of 10 tasks" count moved to the
  foot of the list. Thanks to [@nvkvin](https://github.com/nvkvin).
- **The Status section folds.** Its header is a bar with a count; click it to
  collapse the section, and the marks of the tasks inside stay visible on the
  folded header. Thanks to [@nvkvin](https://github.com/nvkvin).
- **The task finder shows each task's status** and searches by it: type
  `working` or `review`, combine it with a name, or use `status:working`.
  Thanks to [@nvkvin](https://github.com/nvkvin).
- **Shortcut names in Chinese.** With the UI in Chinese, the rows of the
  Shortcuts settings page and the ⌘/ sheet are now translated too. Thanks to
  [@lymanzhao](https://github.com/lymanzhao).
- **Linux: the app's bar is the title bar.** No separate native title bar,
  with minimize, maximize and close on the app's own bar, as on Windows.
- **Linux: Super works as Cmd**, including from inside a terminal, and
  shortcut chips are drawn in the order Linux writes them.
- **The approved tick sits left of the PR number** in the sidebar, so the
  numbers keep one right edge down the list.

### Bug fixes
- Linux: in the AppImage, scripts starting with `#!/usr/bin/env` and common
  commands failed in a Termic terminal on recent Ubuntu, because the app's
  bundled libraries leaked into every child process.
- Linux: Ctrl+Shift+V pasted nothing into a terminal.
- Linux: the `termic` command was a dead link whenever the app was closed.
- Linux: "Install system-wide" now asks for your password, as it says.
- Linux: Ctrl+Alt shortcuts (pane left and the rest), Ctrl+Shift+Tab and
  previous / next tab did nothing from inside a terminal.
- Linux: the dock showed a generic icon instead of Termic's.
- Windows: the MCP endpoint could stop binding its port after a restart and
  blame another process. An unset port now comes from a range Windows does
  not reserve, and Settings says why a bind was refused.
- A typed MCP port that could not be bound was retried even after you
  cleared the field.
- An agent that exited in the middle of a turn could keep its working
  spinner under the exited banner.
- Windows: fast Korean input followed by Enter could reach the agent out of
  order.
- Renaming a file from the file tree's menu could cancel itself before you
  typed anything.

## [1.14.4] - 2026-10-09

A sidebar filter bar and status chips, HTML preview, and review requests in New Task.

### Features
- **A filter bar in the sidebar.** The Kanban board's filter now also sits at
  the top of the sidebar and narrows the status section and the project tree
  together: type a task name, or use `project:`, `agent:`, `status:`, `pr:`
  and the rest, with the funnel for the same filters as chips. A long query
  wraps while you are typing it. Projects with no match fold away, and the
  open task always stays listed. Thanks to
  [@wagoodman](https://github.com/wagoodman).
- **Status chips.** Under the filter, four counts in the order a task moves
  through them: working, needs you, done and unread, in review. Click one to
  filter the tree to those tasks. They are always there, so nothing shifts
  when an agent starts or stops. "Done" is the blue dot: a turn that finished
  and you have not opened, and `status:done` filters by it anywhere the
  filter works. Thanks to [@wagoodman](https://github.com/wagoodman).
- **A task finder on ⌘O.** Type to jump to any task in any project, matched
  on its name, project and branch, most recent first, without leaving what
  you are in. Also "Open task finder" in the command palette. Thanks to
  [@nvkvin](https://github.com/nvkvin).
- **`termic send --now` skips the queue.** A message to a busy agent normally
  waits for its turn to end; `--now` (and `now` on the MCP `task_send` tool)
  types it at once, for the message that cannot wait: stop, a correction, new
  information. It still never lands in a draft you are typing.
- **Schedules from the CLI and MCP.** `termic schedule list`, `show`, `set`,
  `run` and `delete` (and the matching `schedule_*` MCP tools) let an agent
  or a script create and manage recurring runs, not only the Scheduled view.
  Setting and deleting ask for `--yes`. Thanks to
  [@nvkvin](https://github.com/nvkvin).
- **HTML files preview.** An `.html` file opens on a rendered preview, with
  source and split views beside it, like markdown and SVG. The page runs in a
  sandboxed frame with no scripts, and remote images stay off until you allow
  them. Thanks to [@nvkvin](https://github.com/nvkvin).
- **New Task lists the work that pulled you in.** "From a PR" now also lists
  the open pull requests waiting for your review, and "From an issue" can be
  narrowed to the ones assigned to you or mentioning you. GitHub only for
  now. Thanks to [@franzkurt](https://github.com/franzkurt).
- **Config sync runs when a window comes forward**, if the last attempt is
  more than five minutes old, and at launch. It pulls and pushes, so a change
  made on one machine reaches the others without a manual Sync now. A conflict
  or a sign-in failure is announced once, and being offline stays quiet.
  Thanks to [@nvkvin](https://github.com/nvkvin).

### Improvements
- **Open an HTML file in your browser.** The preview runs without scripts, so
  a report that needs JavaScript (charts, for instance) has an "Open in
  default browser" button, in the file's header and beside Editor / Preview /
  Split. Thanks to [@nvkvin](https://github.com/nvkvin).
- **The sidebar is easier to scan.** Status section headers carry the glyph
  and colour of their rows, a branch name draws its leading path
  (`feature/`) faint so rows differ where your eye lands, and a collapsed
  project or folder shows the marks of the tasks inside it. Thanks to
  [@nvkvin](https://github.com/nvkvin).
- **The title bar's waiting pill counts the two kinds separately:** a bell for
  agents blocked on you and a blue dot for turns you have not read. It is
  amber only while something is actually blocked.
- **"Show task git icon" shows the icons it means**, on the menu row and on
  each choice.
- **"Show task PR" in the sidebar.** A task row now draws its pull request
  as the number alone, in the colour of its state. You can switch to the
  icon, icon and number, or neither. In the Projects list options, and in
  Settings, Appearance, Interface & Sidebar.
- **An approved pull request is ticked.** A green check follows the PR
  number on a sidebar task row once the PR is approved and still open.
  GitHub, GitLab and Azure DevOps.
- **PR status shows at launch.** Each task's last known PR status (draft,
  open, failing checks, merged, approved) is remembered, so the sidebar no
  longer starts grey and colours in one row at a time.
- **Deleting a schedule can archive its tasks.** The confirmation offers to
  archive the schedule's task and its past runs along with it, which also
  removes their reports. Also `termic schedule delete --archive-tasks`.
  Thanks to [@nvkvin](https://github.com/nvkvin).
- **Windows and Linux: Ctrl+Shift+W closes the tab from inside a terminal.**
  Ctrl+W closes it everywhere else, and in a terminal stays the shell's
  delete-previous-word.
- **Settings, Appearance: the Interface tab is now "Interface & Sidebar".**

### Bug fixes
- An agent that exited in the middle of a turn (one that updated itself and
  quit, for instance) kept its spinner in the tab and the sidebar.
- The Queue messages button, and the queue icon on the tab, stayed lit after
  the last queued message had been sent.
- In the project list options menu, a ticked row with a long description drew
  a shrunken checkmark and sat out of line with the rows above it.
- Sidebar task rows ended in an empty column: the hover-only task menu had
  been given a reserved slot of its own. It shares the status slot again.
- The three dots on a sidebar task row did not open the task menu.

## [1.13.4] - 2026-10-06

Scheduled tasks, config sync through your own git repo, and a sidebar status section.

### Features
- **Scheduled tasks.** Recurring agent runs: a daily dashboard check, a
  morning triage. A schedule is a parent task, each run is a new task in its
  group, and every run writes a report you can open from the new Scheduled
  view. Daily, weekdays or weekly at a time you pick. Runs happen only while
  Termic is running, and a missed run is skipped unless you ask for one
  catch-up at launch. Create one from the Scheduled view, the command palette,
  or "Schedule..." on a task. Thanks to
  [@nvkvin](https://github.com/nvkvin).
- **Config sync (experimental).** Settings, Sync keeps your setup in a private
  git repo you own: projects, per-project overrides, custom agents, prompts,
  shortcuts and themes. No account, no token stored, no new host the app talks
  to. Sync is manual for now: one pull at launch and a "Sync now" button.
  Agent environment variables, paths, port ranges and logins never leave the
  machine, and a change to a YOLO or sandbox default from another machine is
  always announced. Thanks to [@nvkvin](https://github.com/nvkvin).
- **Profiles sync too.** A profile on one machine is created on the other,
  with its name and colour, and a rename follows. Delete a profile you do not
  want on a machine and it stays deleted there; disconnect one you do not want
  synced. Two profiles that merely share a name are never merged without
  asking.
- **A status section in the sidebar.** Tasks that need you, are working or are
  in review, listed above Projects in the Kanban board's columns, with task
  groups kept whole and rows that expand to their agent tabs. Off by default:
  turn it on from the project list options or Settings, Appearance. Thanks to
  [@nvkvin](https://github.com/nvkvin).
- **Agents can label their own tab.** `termic prop ticket ABC-1` (or the
  `task_prop` MCP tool) puts a small property on the agent's tab, and the
  task's sidebar row collects them, so a row can say which ticket each agent
  is on. The sidebar filter matches them. Thanks to
  [@GabrielDumbrava](https://github.com/GabrielDumbrava).
- **oh-my-pi (omp)** joins the built-in agents, with hooks. Thanks to
  [@lymanzhao](https://github.com/lymanzhao).
- **One "Agent state" section per agent.** Settings, Agents now says where
  each agent's state comes from: reported by the agent through hooks, or
  guessed from the terminal, with Install right there when hooks are available
  and not installed. The terminal patterns are folded away as a fallback while
  hooks are in.
- **The MCP endpoint can be reached from another device.** Settings, MCP has a
  bind address and a port, and shows a ready-to-copy `claude mcp add` command
  while the endpoint is on the network. The token now changes only when you
  press "Regenerate token", so a client on another machine survives a restart.
- **Windows: the `termic` command installs onto PATH**, for you or for all
  users, and "Add to Claude" now produces a working MCP connection there.
- **Sidebar choices.** Hide the Kanban entry, show Scheduled always, never, or
  only when you have a schedule, and optionally carry a profile's colour from
  the title bar down the sidebar.
- **A custom run command's tab is titled "Run · name"**, so it reads as a run
  and not as a terminal that happens to share the command's name.
- **A filter bar on the Kanban board.** Type to narrow every column by task
  name, tab title or branch, or use qualifiers like `project:`, `agent:`,
  `status:`, `pr:` and `checks:`, with a comma for "or" and a leading `-` to
  exclude. The funnel opens every facet as a chip with a live count, a click
  on a lane divider or project header filters by it, and `/` or ⌘F focuses the
  bar. Thanks to [@wagoodman](https://github.com/wagoodman).
- **Middle-click a tab to close it**, as in a browser. A pinned tab ignores
  it. Thanks to [@franzkurt](https://github.com/franzkurt) for the report.
- **Profiles is no longer experimental.**

### Improvements
- **Sandboxed tasks cost less in the background.** Every sandboxed terminal
  used to start its own system log reader; they now share one. Thanks to
  [@wagoodman](https://github.com/wagoodman).

### Bug fixes
- **A question you looked at no longer reads as answered.** An agent waiting
  on a permission prompt lost its bell as soon as its tab was on screen, so a
  question glanced at and left alone looked like a finished turn. The bell
  now stays until you answer.
- **A Docker extra mount can no longer reach Termic's own data folder**, which
  holds agent logins and the CLI token. Such a mount is refused when saved and
  skipped at launch.
- **Quick create follows the right profile.** In a second profile's window it
  started from the first profile's last task type.
- **Windows: opening a folder showed Documents** instead of the folder. Thanks
  to [@lymanzhao](https://github.com/lymanzhao).
- **Windows: `termic help --json` could crash** with a stack overflow.
- **The agents strip in Settings** no longer draws a scrollbar under itself;
  it fades at the end that has more.
- **Two tasks given the same group name ended up in two groups.** Naming a
  task's group over MCP or the CLI always started a new group, so an agent
  that created two tasks and named each one's group the same got two groups
  with one name and two colours. A task now joins the group in its project
  that already has that name.
- **Messages from other agents could queue forever behind an empty prompt.**
  Termic holds a message while you have a draft in the agent's prompt, and it
  could believe there was one when there was not: after answering a Claude
  permission prompt with a digit, after deleting a word with Ctrl-W or
  Option-Backspace, or after stepping back out of history. Nothing was sent
  until you pressed Enter in that terminal.
- **A queued message could wait forever behind an idle agent.** Pressing
  Enter on something that starts no turn (a slash command that restarts the
  session) could leave the tab marked as working with nothing to end it, so
  messages queued for it, including ones another agent sent, never went out.

## [1.12.2] - 2026-10-02

Azure DevOps, the Cursor CLI, and agent hooks on by default.

### Features
- **Azure DevOps.** A third forge beside GitHub and GitLab: detected remotes,
  PR status, checks, reviewers and comments, Boards work items in the issue
  picker, and PR creation, all through the `az` CLI. Thanks to
  [@kaceper11](https://github.com/kaceper11).
- **Per-repo pull requests on a multi-repo task.** Each member's own PR and CI
  show in the Git tab and on its board card, polled by the branch actually
  checked out, plus an "update all repos" action that pulls or rebases every
  member on its own base. Thanks to
  [@kaceper11](https://github.com/kaceper11).
- **Cursor CLI** joins the built-in agents, with its login persisted in Docker
  mode like claude and codex.
- **Agent hooks are on by default.** They are what let a tab report working,
  needs you and done instead of Termic guessing from output, and they were
  opt-in. They turn on once at the next launch; Settings, Agents turns them
  back off and that sticks. They are never installed for an agent whose config
  cannot be read or that sets `disableAllHooks`.
- **Quit asks before it stops an agent mid-turn.** Only when there is
  something to lose: an agent working, or a queued message that would die
  unsent. A window of finished tasks still quits without a word.
- **A launcher entry for the Linux AppImage.** An AppImage registers nothing
  when it runs, so Termic had no menu entry, no icon and no handler for
  `termic://` links. The welcome wizard offers to add one, and Settings,
  General does it later.
- **Right-click a terminal** for Copy, Paste and Select all.
- **The Activity monitor works on Windows.**

### Bug fixes
- **Creating a worktree task on Windows could delete the worktree it was
  registering.** Git reports its own path spelling (`C:/x`) and the
  registered-vs-orphan check compared it raw against Windows' (`C:\x`), so a
  live worktree read as an abandoned directory. Thanks to
  [@kaceper11](https://github.com/kaceper11).
- **Archiving a task announced that its agent had exited.**
- **A codex tab could end every task with its prompt never sent**, because
  codex fires its session-start hook on the first submit rather than at
  startup, so waiting for it guaranteed a timeout. Thanks to
  [@kaceper11](https://github.com/kaceper11).
- **Text on Windows had colour fringes**, from ClearType's subpixel
  antialiasing; it is grayscale now.
- **The YOLO bolt showed on tasks with nothing running**, where there is no
  agent and so nothing it can do. It is also an outline now rather than a
  solid red fill.
- **A long reviewer name overflowed the PR card's row.** Thanks to
  [@kaceper11](https://github.com/kaceper11).
- **Messages between agents could pile up unsent.** An agent waiting on
  subagents it started has no turn left to end, so nothing was ever going to
  deliver what had queued behind it. Those messages now go through.
- **Right-click menu entries were invisible to screen readers.** Every plain
  item in every context menu rendered without the role that says it is one.

## [1.11.3] - 2026-09-30

A kanban board over every task, and multi-repo tasks pick their own members.

### Features
- **Kanban board.** A third nav view beside Dashboard and History, every task
  a card in a column derived from what the terminal is actually doing (not
  started, needs you, working, in review, settled), never from a status
  somebody dragged. Swimlanes by agent when more than one has cards, drop on
  Archived to archive through the usual confirm, drop on In review to open the
  PR. Columns with nothing in them collapse into an Inactive column at the
  right, which still takes their drops. Thanks to
  [@lymanzhao](https://github.com/lymanzhao).
- **Pick which repos a multi-repo task gets.** A member checklist in the New
  task dialog, saved sets you can reapply, and an Edit task dialog that adds or
  removes members on a task that already exists. Thanks to
  [@kaceper11](https://github.com/kaceper11).
- **Choose the model and reasoning when opening an agent tab**, per tab, and
  new tabs start fresh instead of inheriting the last one. `termic tab` takes
  the same options. Thanks to
  [@thiagorbernardo](https://github.com/thiagorbernardo).
- **Send queued messages now.** "Send all now" empties an agent's queue in one
  pass without waiting for work-done between messages, and each row in the
  queue has its own send icon that jumps that one ahead of the rest.
- **Start a task from a pull request.** New task, From a PR lists the PRs you
  opened, or paste a number or a URL for any other. It fetches the branch and
  cuts a worktree from it, or checks it out in the main checkout, forks
  included.
- **Kanban cards show the pull request and what the task changed.** The PR
  number, its state and its checks, all one link, and beside it the lines
  added and removed with the file count. Both appear only when there is
  something to show.
- **Choose which board columns are always on.** A column in the Inactive list
  stays on the board once you click it, and an empty one you pinned has an X
  to send it back. A column with cards in it never offers to hide.
- **The Linux AppImage can update itself.** It now carries zsync update
  information, so Gear Lever, AppImageLauncher and AppImageUpdate can see a new
  version and fetch only the parts that changed.

### Bug fixes
- **The Linux AppImage could not start for anyone whose mount enforces file
  permissions.** `AppRun.wrapped` shipped as 0770 with everything inside owned
  by root, so the file the launcher runs was not executable by the person
  running it. It survived a plain double-click because squashfuse does not
  enforce the mode, and failed under firejail, `default_permissions`, or an
  extracted copy run by another user.
- **A long queued message reached the agent with its beginning missing.** The
  queue could send while the agent was still finishing the previous message,
  and the input box it clears took the new text with it. A queued message now
  waits for the agent to actually start its turn, and long ones are sent as a
  single paste.
- **A queue could wait forever.** If an agent never reported work-done again,
  the messages behind it were never delivered, which is what a handoff from
  another agent looked like. After a few minutes of complete silence from a
  busy agent the next message goes anyway. Tunable in Settings, Tasks.
- **A second Codex tab in a task resumed the wrong conversation.** `codex
  resume --last` means the newest session in that directory, which stops
  identifying a conversation once the task has two Codex tabs.
- **The quick-create row could vanish the moment you picked an agent**, when
  the closing menu handed focus back to the "+" button.
- **A draft pull request no longer turns red** when its checks fail: a draft is
  not asking to be looked at.
- **A pull request no longer reads as broken** when a check was cancelled (a
  newer push supersedes a run) or is waiting for a maintainer to approve a fork
  workflow. Neither means the build failed.
- Two switches in the New task dialog ("Existing branch" and "New branch
  instead") were still English in every language.
- **The first message to a freshly spawned agent could be typed and never
  sent.** Termic waits for the agent to echo the text before pressing Enter, so
  that it never answers a trust prompt by accident, but it started watching the
  terminal a moment after typing. If the echo arrived in that gap it was
  missed, and the message sat in the agent's input box forever.
- **A column you clicked open on the board hid itself again** as soon as you
  left the Kanban view and came back.
- **A pull request no longer turns red at all.** Failing checks on an open PR
  are orange, a draft has no colour whatever its checks say, and a closed one
  is grey rather than looking like an error.
- **The New task dialog changed size as you moved through it.** It jumped
  between four widths and resized vertically on nearly every click, which moved
  the Create button out from under the pointer.
- **The Archived column was empty when the archive limit was Unlimited**, under
  a badge showing the full count, and clearing the custom limit field stored 0
  and emptied the column mid-edit. Thanks to
  [@lymanzhao](https://github.com/lymanzhao).
- **Dragging a card blanked the other cards of the same project** in every
  other column and lane, and lit them as drop targets, for as long as you held
  it. Dropping a card that was archived or deleted mid-drag could also corrupt
  the task list. Thanks to [@lymanzhao](https://github.com/lymanzhao).
- **Hovering a drop target lit every row of the Inactive column** instead of
  the one the card would land in. Thanks to
  [@lymanzhao](https://github.com/lymanzhao).
- **The YOLO checkbox named something no agent shows you.** It now uses the
  agent's own word for the mode it turns on (bypass permissions for claude,
  full access for codex), with the exact flag on hover.
- **Dismissing the update card left "Check for updates" with nothing to
  show.** The check reported an update in a toast and then displayed no card
  and no pill, because both hide the version you dismissed. Asking for a check
  now brings it back.
- **A Kanban column scrolled sideways** when a card carried a long pull
  request line and a large change summary, clipping the file count off the
  right edge of every card in that column. The card's bottom row wraps now,
  and a column never scrolls sideways.

## [1.10.0] - 2026-09-28

Termic now speaks Simplified Chinese, and idles much lighter with many live
tasks.

### Features
- **Simplified Chinese, and a language setting.** Every screen in the app is
  translated, and Settings, General, Language picks between System, English
  and 简体中文. The switch applies immediately, with no restart.
- **History filters by project.** A project picker at the top of History
  narrows the list, and combines with the search box. The sidebar's Resume,
  More... lands pre-filtered to that project, and "Empty archive" under a
  filter deletes only that project's archive. Thanks to
  [@earthpyy](https://github.com/earthpyy).
- **Name a tab from the CLI.** `termic tab --title <name>` opens a tab under a
  name you choose, for every kind of tab, and
  `termic tab --tab <tab> --title <name>` renames one that is already open
  (`--title ""` gives it its automatic title back). The name counts as a
  rename you made, so the agent cannot replace it and it survives a relaunch,
  which makes it something a script can address: two tabs of the same agent
  used to be reachable only by id. MCP's `task_tab` takes the same `title` and
  `tab` parameters.

### Improvements
- **A much quieter app while agents stream.** Two things were costing a busy
  main thread and whole percents of a core per task. The sidebar re-rendered
  every row on each terminal's output stamp (one per 500ms per streaming
  terminal), and PTY output was routed through a lookup that never matched, so
  every flush re-read every task file in every profile: about 50 full scans a
  second with 7 streaming terminals.
- **Spawn marks reach the dashboard.** A task an agent started in another
  project shows the mark naming its parent on the dashboard's rows too, not
  only in the sidebar, and a row with more than one terminal tab carries the
  tab count.

### Bug fixes
- The sidebar and right-panel dividers can be grabbed. The band that lit up on
  hover was wider than the area that actually took the drag, which was one
  pixel.
- The usage chip is no longer blank on a machine whose locale writes decimals
  with a comma (ro_RO, de_DE, fr_FR and the rest): the reading was parsed as a
  dotted number and dropped.
- Windows: an account you have never signed into no longer reads as signed in
  when Developer Mode is off.

## [1.9.1] - 2026-09-25

Termic now runs on Windows, and tasks show which agent started them.

### Features
- **Windows (experimental).** Releases now include a Windows 11 x64
  installer, `Termic_<version>_x64-setup.exe`. It installs per user, needs
  no admin rights, and updates itself like the macOS and Linux builds. It is
  not code-signed yet, so SmartScreen asks first: More info, then Run
  anyway. The sandbox on Windows is Docker only, and agent hooks report
  working and done for claude only for now. What differs from macOS:
  [docs/windows.md](https://github.com/simion/termic/blob/main/docs/windows.md).
- **Spawn links.** A task an agent starts in another project carries a small
  mark naming the task that started it; click it to go there. Hovering a
  task draws lines to its parent and to the tasks it started, wherever the
  group rail does not already show it. `termic new` prints a `from:` line
  for a cross-project spawn.

### Improvements
- Task groups stay within one project. A task an agent starts in another
  project is linked to it instead of joining its group, which the sidebar
  drew as two unrelated groups of one.
- **Windows: one title bar.** The app's own top bar is now the window's
  title bar: drag it to move the window, double-click it to maximize, and
  minimize, maximize and close sit at its right, as in any Windows app.
- **The welcome wizard turns agent hooks on for every agent**, including
  agents you install later. Untick "Keep every agent hooked up" to turn it
  off.

### Bug fixes
- A `git commit` in a terminal no longer fails now and then with "Unable to
  create index.lock": Termic's background git status no longer takes the
  lock.
- Archiving a task no longer waits on Docker when the task does not use it.
  With Docker Desktop slow or asleep, every archive stalled for minutes.
- Archiving a task now also stops its shell and command tabs, which kept
  running in the deleted worktree.
- Dragging a task into a group could put it back in its old group a moment
  later.
- Emptying History no longer re-runs each task's archive script.
- Archiving with "delete branch" no longer reports an error when the branch
  is already gone.
- A main window closed while another profile is open stays closed across a
  relaunch, including the one after an update.
- Windows: a tool installed while Termic runs (Git, an agent CLI) is found
  without restarting Termic.
- Windows: agents installed outside the PATH are found, including Claude
  Code from its PowerShell installer.
- Adding a repo that git cannot open now says why, instead of "not a git
  repo": git is missing, or git's ownership check refuses the folder (with
  the command that trusts it).

## [1.8.3] - 2026-09-25

Tasks your agents start now group together in the sidebar.

### Features
- **Task groups.** When an agent starts tasks of its own, from the `termic`
  CLI or over MCP, they appear under its task as one coloured group, named
  after it. A worker that starts tasks in turn adds them to the same group.
  Click a group to collapse it: the caption keeps its task count and one of
  each mark its tasks carry, so a finished agent and one that needs you both
  stay visible. Rename or recolour a group from its menu, drag tasks in and
  out, drag the whole group, or start one by hand with Move to group > New
  group. Opening a task in a collapsed group expands it.
- **Agents can name their group.** `termic group --name "Auth refactor"`
  (or the MCP `task_group` tool) names and colours the group an agent's
  tasks form, so the sidebar says what the batch of work is.
- **The MCP server matches the CLI.** Every `termic` option is now a tool
  argument too (sandbox, YOLO, model, agent arguments, adopting a worktree,
  resuming a session, prompt-library prompts), and scratchpads are
  available over MCP. A client set up by Termic tells the server which task
  it runs in, so an agent's own task is the default, as on the CLI. Re-run
  the MCP setup in Settings to pick this up.
- **Agents know they are inside Termic.** The CLI's help and the MCP
  server now open by telling an agent it runs in a Termic task and what it
  can do from there, messages between agents are signed with the sender's
  agent, task name and id, and results come back as a report rather than a
  file by default.
- **Filter a project's tasks** by text or by notifications. Thanks to
  [@GabrielDumbrava](https://github.com/GabrielDumbrava).
  ([#324](https://github.com/simion/termic/issues/324))
- **Check out an existing branch into a new worktree task**, including one
  that only exists on the remote. Thanks to
  [@nvkvin](https://github.com/nvkvin).
- **Start new tasks in YOLO by default**, for this machine or per project.
  Thanks to [@nvkvin](https://github.com/nvkvin).
- **A scratchpad an agent writes while you are elsewhere is marked** with a
  ring on its tab until you look at it.

### Improvements
- Cmd+clicking a file path in a terminal opens it in a regular tab, not the
  preview tab the next file you open replaces.
- A PR your agent opens from its own terminal now shows in the sidebar as
  soon as you open the task, rather than only after opening its Git tab.
- A `.termic.yaml` Termic writes starts with a comment explaining what it is.

### Bug fixes
- With a second profile's window open, a task created from the CLI or MCP
  could be reported as failed although it was created, and every other CLI
  or MCP command ran in both windows.
- When resuming a main-checkout task fell back to the session picker, one
  Enter could pick a sibling task's conversation and swap the two tasks'
  sessions. ([#311](https://github.com/simion/termic/issues/311))
- A report from another agent (`termic send`, MCP `task_send`) waited in
  the receiving agent's queue while that agent was only waiting on
  subagents or shells it had started, so an orchestrator did not hear from
  its workers until all of its work was done. It is now delivered at once.
- A message from another agent, or from the message queue, arriving while
  you were typing into that agent landed in the middle of your text, and the
  next Enter sent both as one prompt. Nothing is typed into a draft now: the
  message waits until you send or clear yours.
- A `files to copy` pattern with `**` or several wildcards (such as
  `**/.env*`) now copies nested files, keeping their paths. Thanks to
  [@adamatan](https://github.com/adamatan).
  ([#320](https://github.com/simion/termic/issues/320))
- A window restored at a size larger than the screen now fits on it.
- The partially-done mark stayed on a tab after you had looked at it. Looking
  now clears it, and the tab shows the delegated ring until the next piece
  of background work reports back.

## [1.7.0] - 2026-09-22

Agents now report the work they hand off, and every status mark says what it means.

### Features
- **A tab says when its agent is waiting on something it started.** An agent
  that spawns subagents or leaves a script running has stopped generating,
  and until now that looked identical to a model mid-sentence. It gets its
  own mark: a dotted ring that turns slowly, an outlined dot once some of
  that work has come back, and the usual bullet when the turn really ends.
  A turn that leaves a shell running (a dev server, say) now finishes
  instead of spinning until it times out, and it stops swallowing the
  completion of every later turn in that session.
- **One ping, after the last one.** Three background agents reporting back
  at one, two and three minutes notify you once, at the end, rather than
  claiming the turn finished when the first one lands.
- **Settings shows you the marks.** Notifications has one switch per mark,
  each drawing the mark it controls, including new switches for the
  partially-done dot and the needs-you bell.
- **A first-run step on how Termic is laid out.** Projects, tasks, and every
  status mark against a replica of the real sidebar, plus main checkout
  against worktree drawn with the New Task toggle, since a worktree is a
  second folder on disk and not everyone reads it that way.
- **Agent hooks show what they install, one tab per file.** Paths relative
  to your home directory, and the events each script runs on.
- **A failed resume opens the agent's own session picker.**
  ([#311](https://github.com/simion/termic/issues/311))

### Bug fixes
- The working spinner was thicker on a retina display than anywhere else. It
  now lands on whole pixels on both.
- A status mark jumped a pixel when you hovered its row.
- A finished badge stayed on an agent that had already started working again.
- The tab strip ignored the work-done and needs-you settings, so turning
  them off quietened the sidebar and left the tabs lit.
- A deleted image in a diff showed as a binary summary instead of an image.
  ([#315](https://github.com/simion/termic/issues/315))
- A profile's load-time migration wrote to the wrong file.
  ([#316](https://github.com/simion/termic/issues/316))
- Terminal glyphs could come back wrong after a theme or font change.
  ([#314](https://github.com/simion/termic/issues/314))
- The activity monitor remembered its size instead of its position.
- A footer chip could render half its detail; it is now shown in full or not
  at all.

## [1.6.0] - 2026-09-18

Context window in the footer, plan usage for more agents, and quieter notifications.

### Features
- **The context window, next to plan usage.** Each agent's footer chip now
  shows how full the current conversation is (`42% ctx`), and clicking it
  spells out the token counts. It works for Claude, Codex, Antigravity,
  GitHub Copilot, Grok, opencode, pi and Devin, each reporting through the
  hooks Termic installs.
- **Plan usage for Antigravity and GitHub Copilot**, beside Claude, Codex and
  Devin. Copilot's is its monthly quota.
- **Agent hooks for GitHub Copilot, pi and Muse Code**, so their tabs report
  when a turn starts, when it needs you and when it is done.
- **Install hooks for every agent** with one switch at the top of Settings >
  Agents > Agent hooks. It also covers agents you add later.
- **Choose what each agent's chip shows.** Every agent card in Settings >
  Agents has a switch for plan usage and one for the context window.
- **Antigravity resumes its own conversation** in a main-checkout task, rather
  than whichever one ran last in that folder.
- **The compact sidebar says what is inside a task.** Hovering a task in the
  collapsed sidebar lists its agents and terminals with their titles and state.

### Bug fixes
- A hook stuck writing to a closed tab could stop every new Claude session from
  starting, in every Termic window. Hooks now give up after two seconds.
- GitHub Copilot started a fresh session instead of resuming the task's own.
- Grok rang the needs-you bell a minute after every turn, and Grok's and
  Devin's own "turn finished" messages were shown as needing you.
- Devin's session name could appear as a notification.
- Relaunching Termic announced "agent finished" for agents nobody had sent
  anything to.
- opencode hooks never upgraded after their first install, and opencode's turn
  took several seconds longer than its reply to show as done.
- The collapsed sidebar shows no scrollbar; a fade marks that there is more
  below.

## [1.5.1] - 2026-09-17

Scheduled messages, agent scratchpads from the CLI, and a GitHub-style markdown preview.

### Features
- **Schedule a message for later.** The message queue grows a "Send after"
  row: tomorrow, in 3 days, in a week, or a date you pick. The message is
  saved with the tab and sent the first time that chat is open and idle on or
  after the date, into the same session that already holds the context, so
  "check the release logs next week" lands where the work was done. Nothing
  fires with the app closed or in a chat you never open, and a message that
  goes out late says so. Pending ones sit in the queue popover, where you can
  cancel them. Thanks to
  [@mikolajhilgert](https://github.com/mikolajhilgert) for the request.
  ([#300](https://github.com/simion/termic/issues/300))
- **Agents keep notes you can read.** `termic scratchpad new`, `write`,
  `read` and `list` let an agent put findings, a plan or a running report in
  a scratchpad tab in its own task: outside git, updating live as it writes,
  and undoable. A new pad opens without taking focus. `termic tab` with no
  task now opens the tab in the caller's own task, so an agent can start a
  second agent beside itself, and `termic --help` opens with a quick start
  for exactly those moves.
- **Agents sign what they send each other.** The instructions every agent
  gets now ask for a prompt sent to another agent to open with
  `[Agent message from <agent>, task <id>]` and end with a signature, and tell
  the receiver such a prompt comes from a peer, not from you.
- **A markdown preview that reads like GitHub.** GitHub's typography (heading
  scale, code, tables, a centered measure) in the theme's colours. The
  rendered text is selectable and copies as clean rich text. A `.md` opened
  from a path in the terminal previews too.
- **Word wrap in the editor**, in Settings > Appearance and as "Toggle word
  wrap" in the command palette.
- **A resizable usages list.** Drag its corner to see long paths and the
  code beside them; the size is remembered, and hovering a row shows its full
  path.
- **Touch ID for sudo, offered where you need it.** When a terminal stops at
  a sudo password prompt, a strip offers to turn on Touch ID for sudo. Run it
  in a new tab, where the script shows its source and asks sudo for your
  password, or copy the command and run it yourself. "Don't ask again" is
  reversible in Settings > General.
- **Find in terminal highlights every match**, in agent, shell and footer
  terminals alike, with the current one marked and a match count.

### Bug fixes
- **A claude tab resumes the session it moved to with `/clear` or
  `/resume`.** A relaunch used to resume the session from before the
  `/clear`, so the agent had no memory of the work since.
  ([#306](https://github.com/simion/termic/issues/306))
- **Saving General, Tasks, Sandbox or Docker settings no longer deletes
  agent accounts** added since that settings page was opened.
  ([#308](https://github.com/simion/termic/issues/308))
- **A file opened with ⌘P takes the keyboard**, so ⌘F right after searches
  that file. Markdown and SVG files included.
- **Devin Enterprise shows its usage.** An ACU-billed plan has no quota, so
  the footer read "Usage unknown"; it now shows the ACUs used this billing
  period.
- **An agent's write to a scratchpad is no longer lost** when it lands while
  the pad's editor is switching to the markdown view.

## [1.4.6] - 2026-09-16

Clone a project from a git URL, walk recent tabs, read changed files.

### Features
- **Open a changed file, not just its diff.** A diff is the wrong reader for a
  file that is mostly prose: a markdown file has no rendered preview inside one,
  and a file added in a single commit is an unbroken wall of `+`. Every changed
  row in Commit and Compare now opens the file itself three ways, a button on
  the row, the context menu, or an option-click, while a plain click still
  opens the diff. A markdown file arrives in whichever view you last read one
  in, and the file opens into the same tab the file tree would use, so one file
  is one tab however you got there. Thanks to
  [@nvkvin](https://github.com/nvkvin).
  ([#299](https://github.com/simion/termic/pull/299))
- **Ctrl+Tab walks the tabs you actually used.** Every other way to move
  around termic is positional: the sidebar rows, the tab strip, Cmd+1..9.
  None of them answers "take me back to the thing I was just looking at",
  which with several agents open is the question you ask most, and the tab
  two slots to the left is not the tab you were in. Hold Ctrl and tap Tab to
  step back through the places you were actually looking at, add Shift to
  step the other way, release to land. The ring crosses tasks, so it reaches
  a tab in another one; used inside a single task it cycles that task's
  tabs. There is a toggle in Settings if you want the chord back. Thanks to
  [@nvkvin](https://github.com/nvkvin).
  ([#303](https://github.com/simion/termic/pull/303))
- **Add a project by cloning a git URL.** New Project grows a third mode:
  paste a repo URL, pick where it lands, and the clone runs in a real
  terminal before the result is registered as a project. A terminal rather
  than a progress bar, because a private clone needs a credential (an SSH
  key passphrase, a credential helper, a host key prompt, a 2FA code), and
  running it as you means every one of those works exactly as it does in
  your own shell. The command is typed at the prompt but deliberately not
  run, so you can add `--depth` or `--branch` first, and pressing Enter
  stays your decision.
  ([#285](https://github.com/simion/termic/issues/285))
- **Check for updates from the version row.** The version line in the
  Settings rail gains a refresh button, reporting the outcome in the same
  words the command palette uses so the two surfaces read as one action.
  The automatic check also drops from every six hours to hourly.

### Bug fixes
- **A second account no longer vanishes from Settings.** Adding a second login
  to an agent worked, signed in, and ran fine, and then editing anything else
  on the Agents page silently deleted it: the page saves the whole agent list
  from a copy it took when it opened, and that copy predated the account. The
  account list, the default, and the auto-switch setting went together, so the
  switcher disappeared from the footer and "+ Second account" was offered
  again as though nothing had been added. Adding it a second time looked like
  it did nothing, because the next save removed it again.
- **Reading a changed file no longer stages it.** Double-clicking the
  mark-as-viewed eye on a changed row staged the file, because a button that
  swallows the click still lets the row see the double-click. Reading is never
  supposed to touch the index.
- **Multi-repo members living inside the host folder are no longer skipped.**
  Opening a multi-repo project on the main checkout symlinks every member into
  place, and when a member already sat at exactly that path (a parent folder
  holding its repos) the guard read the real directory as foreign content and
  skipped it. The task then froze an empty composition and the Git panel
  listed no member repos at all. Thanks to
  [@GabrielDumbrava](https://github.com/GabrielDumbrava).
  ([#301](https://github.com/simion/termic/issues/301))
- **Usage says it is unknown instead of guessing a plan.** After a relaunch a
  Max account could read as billed per token: every restored session sends one
  window-less zero-cost report before its first message, and two of those
  across sessions were taken as proof of no plan, so the first restored task
  showed no chip and the second showed $0.00. No plan is now proved only by a
  session whose cost rises with no window alongside it. Until usage is known
  the chip says so, and its panel explains which of the two reasons applies,
  hooks not installed or hooks installed and nothing reported yet. Thanks to
  [@GabrielDumbrava](https://github.com/GabrielDumbrava).
  ([#304](https://github.com/simion/termic/issues/304))

### Improvements
- **Switching tasks no longer re-asks for a usage figure it already has.** The
  reading is shared by every task on one login, but the chip that owns the
  poll timer is per task, so moving between two tasks on the same login
  respawned `codex app-server` to re-learn a number that was seconds old, and
  cost devin an HTTPS call for the same. The first poll now schedules against
  the shared reading's age, so a cold entry still asks at once and a warm one
  waits out the rest of the interval.

## [1.4.4] - 2026-09-15

Closing an agent tab always leaves a way back, and a quieter usage chip.

### Improvements
- **The usage chip reads as two numbers, not four marks.** Each window's gauge
  is now the fill behind its own percentage rather than a separate bar in front
  of it, so `85% wk` sits on a box filled to 85% with the unused part left as a
  visible track. The chip is 45px narrower, which is width a short footer was
  spending on instrumentation. The figure goes neutral on an amber or red fill
  instead of taking that colour itself, because a number tinted the same hue as
  the thing behind it gets hardest to read exactly when it matters most.

### Bug fixes
- **A second agent no longer inherits the task's resume override.** The
  override is written in one agent's flag spelling, and any agent opened from
  the + menu was handed it verbatim: a Codex tab in a task set up for Claude
  launched with `--resume`, which Codex rejects, so the tab died before drawing
  a frame and did the same on every restart. The task's own agent still uses
  it; everything else now falls back to its own resume behaviour.
- **Closing the main agent tab no longer strands its session.** Closing it is
  meant to end the agent for now and bring the conversation back when the task
  reopens, but that only happened for a task with nothing else open. Leave a
  shell, a run or a diff open alongside it and the task never went to sleep, so
  nothing ever woke it: the session stayed on disk, unreachable, and opening
  the agent again from + started a fresh one. It now appears in the + menu's
  Resume list, on the same tab it was closed from. Most visible in a main
  checkout, where there is no directory fallback quietly covering for it.
- **A Codex tab no longer claims to need you while it is working.** Codex
  0.154.0 renames the conversation partway through a turn and puts that name in
  the terminal title, so a thread it decided to call "Explain Action Required"
  matched the words Termic watches for: the attention dot lit and stayed lit for
  the rest of the session, spinner still turning, no prompt anywhere on screen.
  Asking Codex about approvals or CI was enough to set it off. Termic now reads
  that state only where Codex actually puts it, at the front of the title.

## [1.4.2] - 2026-09-14

No more "your agent is done" while it is still working.

### Bug fixes
- **A long turn no longer announces itself as finished.** The safety net that
  stops a tab spinning forever fires when Termic cannot tell what an agent is
  doing, and it was sending you a notification when it did. That is a guess
  announced as a fact, and it is the half that cannot take itself back: the
  badge corrected on the agent's next signal, the notification had already
  pulled you away. It now just stops the spinner and says nothing. The net also
  waits twenty minutes rather than ten, because an agent running background
  agents passes ten minutes on a single turn routinely.

## [1.4.1] - 2026-09-14

A long agent turn no longer reads as finished while it is still working.

### Bug fixes
- **A task could show as done while its agent was still working.** A safety
  net that force-clears the spinner after ten minutes, so a tab can never spin
  forever, was clearing it over and over instead of once: after the first time
  it fired, every later signal from the agent was cancelled about a second
  later, for the rest of that turn. An agent orchestrating background agents
  runs well past ten minutes on one turn, so the tab sat on "done" while
  subagents were visibly working. The net still bounds every stretch of work,
  it just no longer spends its whole budget on the first one.

## [1.4.0] - 2026-09-14

Devin joins the built-in agents, project groups reach the dashboard, and two fixes.

### Features
- **Devin is a built-in agent.** Launch it like any other: its own login (with
  several accounts if you keep them), its own sandbox profile, hooks so it
  reports when it is working and when it needs you, and its plan quota in the
  task footer. Resume works the way Devin itself works, by the slug it mints
  for a session rather than an id Termic hands it. Thanks to
  [@bohdan-shulha](https://github.com/bohdan-shulha), who measured every table
  in the runbook against a live install rather than guessing at it.
- **The dashboard shows what your fleet is doing.** Project groups render as
  folders there, collapsing in step with the sidebar because both read the one
  map. Task rows carry the same work badge and pull request chip the sidebar
  has, and a Recent row lists the tasks you were last in, so the home screen is
  somewhere you can see and re-enter work instead of a list of names. Thanks to
  [@nvkvin](https://github.com/nvkvin).

### Bug fixes
- **Korean input could delete text you had already typed.** A jamo that arrived
  between the key going down and the browser reporting it going up was dropped
  on the floor, and because Termic had already moved its mark forward, the next
  correction ate the characters in front of it instead. Thanks to
  [@yb-yu](https://github.com/yb-yu), who found it, fixed it, and tested it by
  hand on two machines.
  ([#293](https://github.com/simion/termic/issues/293))
- **The usage bar in the footer could report the wrong window.** There was one
  bar for two numbers, and it showed whichever of the two was closest to its
  limit while sitting hard against the five hour figure. So it read as that
  number's gauge and was usually about the other one. Each number has its own
  bar and its own colour now.

## [1.3.7] - 2026-09-11

Terraform support, per-task agent parameters, and two fixes worth having.

### Features
- **Terraform.** Syntax highlighting for `.tf`, `.tfvars` and `.hcl` in the
  editor and the diff viewer, and Terraform joins the languages code
  navigation can serve: go to definition, find usages, hover types and
  diagnostics through terraform-ls. Opt-in like every other language, and it
  will not download a server or run any Terraform command until you ask it to.
  Thanks to [@yb-yu](https://github.com/yb-yu), who reported it and then built
  it. ([#289](https://github.com/simion/termic/issues/289))
- **Per-task agent parameters from the CLI.** `termic new` can now set the
  model and extra arguments for the agent it starts, without touching the
  agent's shared Settings: `termic new planner --agent codex --model <id>`, and
  `--arg` (repeatable) for anything else the CLI takes. A planner task can run
  a stronger model while the workers it fans out to stay cheap, which is the
  case that prompted it. Thanks to [@adamatan](https://github.com/adamatan).
  ([#287](https://github.com/simion/termic/issues/287))

### Bug fixes
- **A Codex tab could quietly start a fresh session instead of resuming
  yours.** If anything else still had that conversation open, Codex refuses to
  reopen it, and Termic was not reading the refusal: the tab started a new
  session, said nothing about it, and pressing R did the same thing again. The
  failure is now noticed and reported, and Termic stops retrying the session id
  that failed. If you hit this, closing the tab and opening a new one is the
  way back.
  ([#291](https://github.com/simion/termic/issues/291))
- **Branch names could carry two dashes in a row.** A task called "fix - auth
  bug" became the branch `fix---auth-bug`, and the worktree directory took the
  same name. A run of dashes now collapses to one, in both the branch and the
  directory, and a name that leaves nothing to build a branch from says so in
  the New task dialog instead of failing later in git's own words.

## [1.3.6] - 2026-09-09

Open a task's folder in any app, plus a profiles fix that moved projects.

### Features
- **Open a task's folder in the app you actually want.** The folder button in
  the title bar always opened Finder, and a git worktree is usually something
  you want to hand to an editor or a terminal instead. It is now a split
  control: the left half launches whatever you picked last, and the chevron
  lists the well-known editors and terminals found on your machine. Finder
  stays first and stays the default, so nothing that worked before stopped
  working. ([#284](https://github.com/simion/termic/pull/284))

### Bug fixes
- **A project could move to the default profile on its own.** Changing anything
  on a project from a second profile's window (spotlight, a run script, the
  code intelligence toggle) filed that project under the default profile and
  left the profile it belonged to empty. The window kept its own list until it
  was restarted, so the change surfaced on the next launch and looked like the
  update had caused it. Nothing was lost. A project that already moved cannot
  be put back automatically, because the record no longer says where it came
  from: remove it from the default profile and add it again in the profile it
  belongs to. Its tasks are still on disk and come back with it.
- **A project added as a subdirectory of a monorepo showed every file as
  deleted.** Opening any diff drew the whole file as removed lines, and staging
  a file from the Git panel quietly did nothing. Git reports its paths from the
  repository root whatever directory it runs in, and Termic was reading them
  against the project directory. The Git panel now also lists only the changes
  inside the project, rather than the whole monorepo's.
- **The PR badge on a task stayed grey, and a merged PR went unnoticed.** Live
  status was only fetched for a task whose Git tab was open, so every other
  task with a pull request kept the "state unknown" glyph for the whole session
  and no poll ever arrived to see it merge (or to archive it). Every task with
  a PR is now polled in the background.
  ([#281](https://github.com/simion/termic/issues/281))
- **A task running two agents showed only one agent's plan usage.** The footer
  chip was tied to the agent the task was created with, so a Claude tab sitting
  beside a Codex tab reported nothing at all for the second one. Each agent in
  a task now gets its own chip, and the one whose tab is on screen is the one
  that survives a narrow window.
  ([#277](https://github.com/simion/termic/issues/277))

### Improvements
- **Existing worktrees moved behind one row in the new-task menu.** A project
  with worktrees you had made outside Termic listed every one of them at the
  top level, which pushed the agents (the thing the menu is for) further down
  the more worktrees you had. They now sit in a submenu called Import
  worktree, next to Resume, and the row is absent entirely when there is
  nothing to import.

### Thanks
- Vinodkumar Naidu (@nvkvin) for the open-with control, and for following it
  onto Windows before anyone could run it there.

## [1.3.3] - 2026-09-07

Work and personal profiles, and a Claude/Codex credentials switcher that moves a running task.

### Features
- **Profiles.** A fully separate instance of Termic with its own window,
  projects, tasks and settings, so work and personal can be open on two
  monitors at once and neither can see the other's work. Each one carries an
  accent colour (or none) and its name in the title bar, and the profiles you
  had open when you quit are the ones that come back. Turning profiles off
  keeps every byte: the app returns to one window and nothing is deleted.
  Settings, Profiles. ([#280](https://github.com/simion/termic/issues/280))
- **Several logins per agent.** Add a second Claude or Codex account, choose
  which one a task runs as, and switch a task that is mid-conversation without
  losing it: the switch restarts the agent, and the conversation resumes on the
  other account. Termic never sees a credential. It creates an empty directory
  and runs the agent's own login in it, and everything that is not the
  credential (your settings, skills, commands, prompts and history) is shared
  back to your main config by symlink, so a second account is a second login
  and not a second setup. Picking an account you have not signed into yet
  opens a tab where you can run that agent's own login, beside the
  conversation rather than instead of it. Works sandboxed and in Docker.
  Settings, Agents. ([#278](https://github.com/simion/termic/issues/278))
- **Switch accounts by yourself, at the limit.** Off by default, one checkbox
  per agent in the usage popover. When the account in use passes 95% of a
  rolling window, Termic moves the task to an account that has room, restarts
  it and sends "continue", so a task that hits a wall at 3am is still working
  at 4am. It only ever moves to an account it has seen headroom on, and it
  says what it did.
- **What an agent has cost you.** The usage popover now carries the dollars
  spent on the current account since Termic launched, from Claude's own
  reporting. An account with no subscription, where percentages mean nothing,
  shows the figure on the footer chip itself.
- **Add several repositories in one sweep.** The project picker scans for
  checkouts and lets you tick the ones you want, instead of one dialog per
  repository.
- **The running version is in Settings**, bottom left of the rail. Click it
  for the release notes.

### Bug fixes
- **`termic new --base` refuses a ref it cannot resolve**, instead of silently
  cutting the worktree from your main checkout's current commit while
  reporting the ref you asked for. A bare branch name that exists only as
  `origin/<name>`, which is what `gh pr view --json headRefName` gives you,
  now resolves the way `git checkout` resolves it.
- Your plan usage shows on an account billed per token from the first turn,
  rather than staying blank until it had spent something, and a subscription's
  dollar figure is labelled as what it would have cost rather than as money
  spent.
- The plan usage chip no longer sits blank with nothing to explain it. Termic
  reads Claude's usage off the status line it installs, so a project or a
  status line of your own that already owns that slot silently took the feed
  away. The chip now names what is holding the slot and where, and offers a
  prompt you can hand to the agent that owns the script. That prompt now also
  teaches the script to report what the account has cost, which on an account
  with no subscription is the only reading there is.
  ([#277](https://github.com/simion/termic/issues/277))

## [1.2.3] - 2026-09-04

Muse Code, Codex self-reporting, and plan usage in the task footer.

### Features
- **Muse Code**, Meta's terminal agent, ships as a built-in: launch it, YOLO
  it, sandbox it and resume it like any other CLI.
  ([#275](https://github.com/simion/termic/issues/275))
- **Codex reports its own state** through agent hooks, so ready, working,
  needs-you and done come from Codex rather than from Termic reading its
  terminal. Turn them on in Settings, Agents.
- **Codex resumes the right conversation in a main checkout.** Several tasks
  in one repo root used to share whichever session ran last there; each task
  now returns to its own.
- **Your plan usage, in the task footer.** How much of the current agent's
  subscription you have spent, as two percentages and a bar: the rolling
  session window and the rolling weekly one. The bar turns amber past 70% and
  red past 90%, following whichever window is closest to its limit, because a
  comfortable five-hour figure sitting in front of a nearly spent week is the
  case that catches people out. Click it for the reset times. Claude reports
  its own numbers through a status line Termic installs alongside the agent
  hooks (so it needs those turned on, and your own status line is left alone
  if you have one), and Codex is asked directly. Neither costs you a request.
  Each cloned agent shows its own account.
  ([#277](https://github.com/simion/termic/issues/277))

### Bug fixes
- One turn interrupts you once. A long turn could raise a desktop notification
  at every stage boundary, so an agent working for ten minutes could ring
  repeatedly. The badge still tracks each stage; only the notification is
  deduplicated. ([#276](https://github.com/simion/termic/issues/276))
- Claude's needs-you notification names the tool it is blocked on ("needs your
  permission: Bash") instead of "agent needs your input".
- The agent hooks install preview was empty for a cloned agent, even though
  installing on that clone worked. It now shows the same scripts and config the
  install actually writes.
- Plan usage now appears for Codex. Termic asks Codex for it by running its
  binary, and a Termic launched from the Dock does not inherit the PATH your
  terminal has, so on a released build it could not find Codex at all and the
  footer stayed empty. A Codex task in a Docker container is also asked about
  the account that is logged in inside the container, rather than the one on
  your Mac. ([#277](https://github.com/simion/termic/issues/277))
- The `termic` command now installs itself. The CLI setting has been on by
  default for a while, but the command was only ever created when you toggled
  the setting off and on again, so on a fresh Mac the row said it was enabled
  and no command existed. It is now installed into `~/.local/bin` on launch.
  Removing it by hand is still respected: it is never put back.
- **Add to PATH**, next to Install system-wide. `~/.local/bin` is not on a
  stock macOS PATH, so the command could be installed and still not found. The
  new button adds it to your shell startup file and needs no password, where
  Install system-wide asks for one. It writes the right line for your shell,
  and will not add a second copy of one you already have.
- Multi-line prompts sent between tasks arrive whole. Newlines were delivered
  to the receiving agent as Enter, so a multi-line prompt was submitted one
  line at a time and only the last line survived as the message. Single-line
  prompts were never affected.
- The plan usage popover no longer tells Claude subscribers that their plan has
  no session limit. Claude reports both windows, and a reading that briefly
  omits one no longer clears the number that was already there.
- The toolbar's sandbox icon now matches the sidebar, the footer and the mode
  picker for monitoring mode.
- Settings no longer calls your Docker sandbox Dockerfile "customised" just
  because Termic shipped a new default one. It now remembers which default your
  file came from, so an untouched Dockerfile picks up new agents on its own and
  an edited one is left alone.

### Heads-up
- **Your Docker sandbox Dockerfile is reset to the shipped default once, on
  first launch of this version, even if you edited it.** This release is where
  Termic starts remembering which default your file came from, and profiles
  from before it carry no such record, so there is no way to tell a real edit
  from an older Termic's copy. Save anything you want to keep before updating.
  From this release on, your edits survive.

## [1.1.2] - 2026-09-03

Agents now tell Termic what they are doing, instead of Termic guessing from the terminal.

### Features

- **Agent hooks: the agent reports its own state.** Termic installs a small script into an agent's own config so it says when a turn starts, when it needs you, and when it is done, instead of Termic inferring all three from the terminal. Inference is usually right and sometimes wrong in the way that costs you most: Claude paints its idle glyph while it is blocked on a permission prompt, and again while its background agents are still running, so a task can read as finished while it is not. Measured over an 8.5 minute run with four subagents, the title claimed idle for 30% of the time the work was still outstanding. Supported for Claude, Grok, Antigravity and opencode, each with the events that agent actually has: Grok is the only one that reports an interrupt, Antigravity has no needs-you event at all so its permission prompt is read from the screen instead, and Codex is left alone because its title already says `Action Required`. Works the same sandboxed, in Docker, and unsandboxed. Installs globally, one agent at a time, shows you the exact scripts and config before writing anything, and removal puts your config back byte for byte. Find it in Settings, Agents & Terminals, in the Agent hooks row above the per-agent tabs. Off by default and marked **Experimental**. (#269)
- **Cloned agents inherit instead of copying.** Duplicating an agent used to take a full copy of its settings, once. That copy then rotted: when a CLI renames a flag, the built-in agent moves with the app and every clone keeps the old value forever, with no way to tell which of its seventeen fields you actually chose. A clone now stores only what you override and reads everything else from its parent as it changes, with the inherited values shown greyed in each field so you can see what is in force. One button clears every override and returns the clone to its parent.
- **Task ports are a range you choose.** Settings, Tasks now carries a min and max instead of a hard-coded floor at 18100. Existing tasks keep the ports they were given, because a task's ports are frozen at creation, so narrowing the range never moves a live task off the port its dev server is bound to. (#271)
- **A way out when the editor cannot show a file.** Binary and very large files now offer Open in default app and Reveal in Finder, with a plain explanation instead of an empty pane.
- **Agents say when they are ready, not only when they are working.** Claude's session start is part of the hook set now, so Termic knows an agent is past its own startup before it types a task's first message into it. It is the one thing the terminal cannot tell you: a blocking startup dialog paints and then goes quiet, which is exactly what a waiting input box looks like.
- **Hook coverage at a glance.** The Agent hooks row shows a green check when every detected agent is wired, and an amber marker when some are not, instead of a count you have to read.

### Bug fixes

- **An agent tab no longer loads forever after publishing an artifact.** Publishing leaves a background subscription running for the whole session, which Claude reports as unfinished work, so every completed turn after it kept the tab spinning. Termic now holds the spinner only for work the agent is actually waiting on, and a tab can never stay in progress indefinitely.
- **A finished turn no longer rings the needs-you bell.** Claude sends a notification when work completes, not only when it wants you, and Termic treated every notification as needs-you. Only a genuine request for you rings now.
- **Termic no longer hands a spawned agent another agent's session.** Launching Termic from inside an agent session copied that session's identity into every agent it spawned: the new agent believed it was a child and turned transcript saving off, adopted the launcher's session, and was handed a live messaging socket and token for it, inside the sandbox.
- **A badge clears when you come back to it.** A done or needs-you badge on the tab already in front of you now clears when you focus the window, instead of only when you clicked away and back.
- **Cloned agents were second-class everywhere.** A duplicated agent was blocked from its vendor's API by the sandbox, denied its own config directory, drew a generic icon instead of its parent's, and could not register with the MCP endpoint. All of that resolves through the agent it was cloned from now.
- **A commit inside a Docker sandbox no longer fails with "Please tell me who you are".** Your git identity is mounted at git's global level, so a repo with its own `user.email` still wins.
- **Agent state read from terminal titles, rebuilt from captured titles.** The previous patterns covered two agents and were written from reasoning; these are derived from titles recorded off live sessions. Grok's plan approval freezes its spinner and used to read as busy forever, and an agent with no patterns at all rang the needs-you bell on every completed turn.
- **Settings fields fit their placeholders.** Multi-line placeholders were scrolling inside a two-row box, so the example patterns a field exists to show were clipped.
- **A task's first message can no longer kill the agent.** Claude asks whether it trusts a folder the first time it runs in a repo, with "No, exit" pre-selected. That question paints and then goes quiet, which reads exactly like a waiting input box, so Termic typed the first message into it and the Enter that followed answered "No, exit". Termic now waits for the agent to report itself ready, and for agents that report nothing it checks that the text it typed came back before pressing Enter.
- **Agent hooks update themselves.** An install from an older Termic kept its original hook set forever while still reporting as installed, so every fix and every new signal reached only people installing for the first time.
- **One `termic` command, whichever app is open.** A beta build installed a second `termic-beta` command that talked to the same socket as `termic`, so it drove whichever app happened to be running regardless of which name you typed. There is one command now, and `termic --help` says which build it is.
- **`termic://` links reach whichever Termic is open.** With a beta installed alongside the shipped app, a link could start the other one, bring the running one to the front and then do nothing, because the URL was lost in the handoff between them.
- **A link-delivered prompt opens at full height** instead of in a one-row box that only grew once you typed into it. (#192)

## [1.0.2] - 2026-08-28

🎉 Termic 1.0 ships the last three headline features: code navigation, pull requests, Docker sandboxing.

### Features
- **Code navigation across seven languages.** Go to definition, find usages, hover types and diagnostics for TypeScript/JavaScript/TSX, Python, Rust, Go, C/C++/Objective-C, Swift and Ruby. Termic resolves the server your project already has before falling back to its own pinned download, so a repo with `node_modules` or a `.venv` uses that one and nothing gets installed behind your back. Python picks between zuban, ty and basedpyright, and you can override the choice per project or per machine. clangd, sourcekit-lsp and ruby-lsp are PATH-only on purpose: they ship with the Command Line Tools or are one package away, and duplicating a binary you already have is a liability. Double-Shift opens Search everywhere, and you choose when it does. (#174)
- **Pull requests from inside the app, GitHub and GitLab.** Open a PR from the task you built it in, then watch it from the right panel: checks, review state, and comments that can be handed straight to the agent working in that worktree. Start a task FROM an issue: its own command palette row, a picker that opens beside the form instead of inside it, and the composed prompt (title, body, the thread's own URL) filled into the first-message box, so you read and edit it before anything is sent. Comments are not inlined; the agent is told to fetch them itself. When a PR merges, Termic can offer to archive the task, or do it for you. Each project gets its own Git settings tab. Self-hosted GitHub Enterprise and GitLab work too, as long as the CLI is signed in to that host. (#21, #22, #255)
- **Docker sandboxing, an alternative to the seatbelt.** Run an agent inside a container instead of a macOS seatbelt profile: a stronger filesystem boundary, and a blast radius that ends at the container. One generic image for every agent, editable as a plain Dockerfile in Settings, built by an explicit action and never lazily on a spawn. Your logins survive because each agent's own config folder is mounted, one per agent, so cloning an agent is all it takes to keep a work login separate from a personal one. Environment variables and the directories kept between runs are per agent too, and a persisted directory can be anywhere, not only under the container home. Termic offers to rebuild on a schedule you choose (or does it in the background), rebuilds only the agent layers so it takes seconds rather than minutes, and streams the build into the task's own pane instead of a spinner. Containers run as your host user, not root, drop every Linux capability and cap PID exhaustion. A command preview shows the exact `docker run` a launch would build, agent command included, before you commit to it. Marked **Experimental**: network egress is not yet restricted the way the seatbelt's proxy restricts it. (#231)
- **An MCP endpoint, Phase A.** A scoped control plane an agent can call without being handed a terminal. The 2026-07-28 spec revision made the protocol stateless, so a per-task bearer token can answer which task is calling and what it may do. Settings carries the surface and a one-click setup for each client. Phases B1 and B2 are not built. Thanks to [@MHohlios](https://github.com/MHohlios). (#176)
- **Copy a task's agent CLI briefing**, a short fragment you paste into a prompt that carries one task's address, so an agent can prompt another agent without you relaying between them. On the task's right-click menu and in the command palette.
- **Cmd+click a path in the terminal and it opens**, including files outside the task, which get a read-only tab. Relative paths pointing outside the project are not resolved yet: that needs cwd tracking Termic does not do. (#240)
- **Choose which browser opens preview URLs** and terminal links, instead of always taking the system default. (#245)
- **A diff tab says when it has gone stale.** Review a file while the agent keeps working and the tab used to hold whatever it read when it opened, forever, with nothing saying so; clicking the file again in the Git panel just focused the stale tab. It now says it is out of date and re-reads on demand. Deliberately not live-updating: content shifting under you mid-review is worse than content being old. (#266)
- **Multi-repo tasks can run in the main checkout**, the same host-level choice a single-repo task has, and the dialog remembers each member's mode between opens with a Set all toggle for changing them together. Thanks to [@cajbecu](https://github.com/cajbecu).
- **The editor reads a file's own indentation** instead of assuming two spaces, so editing a tab-indented or four-space file no longer mixes styles into it.
- **`.mcp.json` is linked into new worktrees** by default, alongside the other paths a task inherits. (#251)
- **Run controls on the task row.** Start or stop a run straight from the sidebar tree without expanding the task first, including from a collapsed task's header.
- **Worktree tasks can be labelled by their branch** instead of the name you typed. (#260)
- **The new-task launcher leads with the project's default CLI** rather than a fixed order, so the agent you actually use for that repo is the first one offered.

### Bug fixes
- **Docker CLI detection on macOS.** GUI launches inherit launchd's minimal PATH and missed `/usr/local/bin` and `/opt/homebrew/bin`, causing the Docker probe to report Docker as not installed.
- **`files_to_copy` reaches multi-repo tasks.** Member worktrees arrived with none of their gitignored files, so keystores, service-account keys and `.env` had to be copied in by hand before anything would build. The list now resolves at three levels: the multi-repo project's own list into the task root, a per-member override beside that member's scripts, and, failing that, the member repo's own committed `.termic.yaml`. Archiving and restoring re-copies all of it. (#264)
- **A blank line in "Files to copy" no longer copies the whole repo.** An empty glob resolved to the repository root, so a trailing newline recursively copied the entire checkout, `.git` included, into the worktree.
- **Terminals that go blank behind your back come back.** A Mac driven over Screen Sharing never blurs or hides its window, so none of the existing GPU-context recovery paths ever got to run, and every terminal stayed black until Termic was restarted. There is now a return-from-away rebuild that fires on the first input after a long gap. Thanks to [@MHohlios](https://github.com/MHohlios). (#257)
- **A failed WebGL attach no longer wedges every pane blank.** The failed attempt leaked its canvas, and the leak counted against the browser's live-context limit, so each retry made the next one likelier to fail until nothing could draw at all.
- **A first message is no longer dropped into an agent that was not listening.** Every prompt-injection path (Agent Race, the New Task first message, the CLI's `--wait`) slept a few fixed seconds after the PTY came up and then typed. Lose that bet, which a cold start in a freshly-added project does, and the text went into a TUI not yet reading. Nothing noticed: writing to a live PTY always succeeds. Readiness is observed now instead of guessed.
- **A leading `~` in a per-agent environment value is expanded.** `CLAUDE_CONFIG_DIR=~/.next-claude` was handed to the agent unexpanded (the PTY child is exec'd directly, with no shell to expand it), so the agent created a directory literally named `~` inside the worktree and put its whole session store there.
- **A repo with no remote reports its real changes.** The stored base ref was `origin/main` whether or not that remote existed, so `git diff` exited 128 and the task reported zero changes.
- **Inline blame stops fighting the line you are typing.** The annotation sat on the cursor line and moved with every keystroke. (#234)
- **File reads follow the config-dir symlinks Termic creates itself**, instead of refusing to read through a link it put there. (#250)
- **A file opened while the window is behind another one is focusable.** Focus was scheduled with `requestAnimationFrame`, which WebKit freezes for an occluded window, so a `termic://` deep link or a CLI-opened file came back unfocused and swallowed the first keystrokes.
- **The CLI no longer claims a task has no tabs** when it simply has not been opened in this session. `status` and `list` turned "the UI holds nothing for this task" into `open_tabs: 0`, so a task with four durable tabs read as having none.
- **The sidebar's sandbox badge no longer claims a task is caged before it has ever run.** An idle task showed its mode's real color at reduced opacity, which read as "actively sandboxed" for a task sitting untouched. It is gray until the task has a terminal, and still encodes the mode by fill, so enforce and monitor stay distinguishable either way.
- **One focus outline, everywhere.** Five components each drew their own focus ring, at two different widths and colors, and everything else fell back to the browser's, which is drawn outside the element and came out clipped on anything sitting flush against a container edge. There is one indicator now, drawn inside the box so nothing can crop it, and controls that had none (the Agents toggles, file-tree rows) show it too.
- **Enter submits the Add project dialog** instead of doing nothing.
- **Settings shows the Default CLI a project is actually set to**, rather than the first one in the list.
- **Words no longer run together after inline code** in the multi-repo members hint, where ".termic.yaml" and the word after it had collided into ".termic.yamllist".
- **Agents dropped from Termic can be removed again.** `gemini` was shipped once, then retired, and existing installs kept it flagged as built-in: visible, undeletable, with nothing behind it. The built-in flag is now derived from what Termic actually ships rather than trusted from your settings file.

## [0.29.0] - 2026-08-21

Scratchpads that survive a relaunch, highlighting for every language CodeMirror knows, and editable SVGs.

### Features
- **Scratchpad tabs.** An unsaved buffer that happens to survive restarts, scoped to one task. Open one from the tab strip's + menu, the command palette or Option-Cmd-N, type a note, and it is still there after a relaunch, with no filename to choose and nothing stray in `git status`. Cmd-S does not write to the scratch store, it promotes the pad to a real file inside the task (pick a folder, pick a name), after which the tab is an ordinary edit tab. Quitting keeps your pads; closing one asks. Notes live in Termic's own data directory, never the worktree, so they never reach a diff the agent reviews, and archiving a task keeps its pads. The tab title folds in as many buffer lines as fit, and the syntax is detected from what you type (or picked by hand, and remembered). (#244)
- **Highlighting for roughly 150 languages, with nothing to add here first.** The editor and the diff view take their grammars from CodeMirror's own language registry instead of a hand-maintained list, so `.php`, `.lua`, `.zig`, `.hs` and the next one all just work. Each grammar is a separate lazy chunk fetched only for a language you actually open, so app start is unaffected. Makefile, proto3 and Elixir stay hand-written, since the registry has no usable grammar for them.
- **Set the syntax by hand.** A language button on the editor path bar, and a `Set syntax` row in the command palette, for the `.txt` that is really JSON. The pick reconfigures the editor in place, so the cursor, undo history and scroll survive it. Files that claim nothing get content detection (shebangs, markup declarations, real JSON) with high-confidence signals only: a wrong guess is worse than no guess.
- **SVGs open as source, preview or split**, the same toggle markdown has, instead of a read-only image you had to leave the app to change. The preview renders the live buffer, so a split-view edit updates as you type. SVG keeps its own default-view preference, set to preview, so clicking an `.svg` in the file tree still shows the picture. (#247)

### Bug fixes
- A terminal no longer starts blank with an untitled tab. Anything an agent printed between the spawn and the moment the window started listening reached nobody, which for a CLI that paints a banner and then waits for input meant a blank pane and a generic tab title, permanently. The first output is held until the window is listening.
- The "modified" chip in the Git panel was hard to read on the light theme: its ink was hard-coded black and ignored the theme. Light fills and inks it from the tokens that exist for that, measured at 5.98:1.
- Expanding the bottom split left the caret in the agent terminal above it, so the next keystroke went to the agent instead of the shell. Focus retries on a timer now, which keeps running while the window is behind another one.
- A folder that will not read says why: permission denied, the folder links outside the task, the folder no longer exists, with the raw error underneath. The retry row said "Couldn't read this folder" and nothing else, which for a symlink pointing out of the task was hopeless advice, since retrying can never work. (#250)
- Committing no longer clears every mark-as-viewed in a review, on files the commit never touched. A file's mark expires on its own evidence now, and marks survive archiving, so unarchiving a task resumes the review where it left off.
- The Activity window names an agent row after its tab within a second of the tab getting a title, instead of up to 50 seconds later when the window is behind another one.

## [0.28.1] - 2026-08-20

An Activity monitor for your agents, inline git blame, and a command palette that finally knows what the app can do.

### Features
- **Activity.** A window that answers "which agent is eating my machine?". CPU and memory rolled up over the whole process tree under each agent, grouped project, task, tab, and sorted so the culprit is the top row. Termic's own processes get their own group instead of being taken on faith. Every column sorts (CPU descending by default), PID is its own column, and the per-child breakdown is in the row's tooltip. Open it from the Activity button in the sidebar footer or "Activity monitor" in the command palette. It is a real window, not a modal, so the numbers keep moving while you drive the agent that moves them; sampling is on demand, stops when the window closes, and backs off to 5s while the window is occluded. On macOS, memory is `phys_footprint`, the same number macOS Activity Monitor shows, never a sum of RSS; on Linux it's `VmRSS` (no WebKit-sidecar breakdown there yet).
- Each Activity row names the tab it's actually showing (its renamed title, or the live status text the tab strip itself shows) instead of a generic "Agent" label, so several tabs running the same CLI in one task no longer look identical.
- **Inline git blame in the editor.** The line your cursor is on gets `subject, Author (age)` in dimmed text after the code, and resting on it opens a card with the full commit: author, date, short sha, co-authors, message body. Two actions in the card: Open diff (that commit's diff in a real tab) and Show in History (jumps the Git graph straight to the sha, even if it is tens of thousands of rows down). Off by default, togglable in Settings, Appearance, Editor and from the command palette. Cursor line only, and the file is blamed once and cached, so moving the cursor is an array index rather than a git fork. (#234)
- **The command palette caught up.** It was last extended in July and had missed 95 feature commits. Added: Add project, Run commands, Resume options, Stop task, Prompt library, Agent Race, Broadcast to agents, Broadcast to project, Jump to next waiting agent, Split pane right, Split pane down. Agent Race and both broadcasts had no palette presence at all. Reopening the palette now shows your last three commands under a Recent header, cleared after an hour. Archive and Stop are excluded from it, because the top Recent row is pre-selected and Enter must never mean "archive another task".
- **The palette has a button.** A boxed `>` in the bar, before Run, so it can be found without reading the shortcuts list. Its tooltip carries the glyphs. Prompts and the right-panel toggle name their shortcuts in their tooltips too, read from the live bindings, so rebinding one retitles it instead of leaving it advertising a dead key.
- **Extra named ports per task.** Name the environment variables your stack needs (`API_PORT`, `DB_PORT`) in Repo Settings or a committed `.termic.yaml`, and every task gets its own frozen port for each, injected wherever `$TERMIC_PORT` is and expanded in the preview URL. Names added later reach existing tasks on the next tab spawn or run. Invalid or reserved names are refused inline. (#196)
- A **Fix merge conflicts** built-in prompt.
- The "No projects yet" card on an empty dashboard is a button now. It looked actionable and did nothing; it opens the new-project dialog, the same one the sidebar + opens. (#152)
- The confirmation opt-out reads **"Show this every time"** and starts ticked, instead of "Don't ask again" starting unticked, which was the inverse of the setting it wrote. The copy stops implying loss where there is none: archiving keeps the task in History and the branch in git, and closing an agent tab is one click from the + menu's Resume list, so neither gets the red button any more. A pane tab, the one close with no way back, keeps it and says why. A silent archive now toasts "It's in History" with a button that goes there. (#102)

### Bug fixes
- **Creating a worktree no longer locks the window.** Both the New Task dialog and the sidebar's quick-create row used to wait out `git worktree add` plus the file copy with a modal open, so the whole app was unusable on a big repo until it finished. Both close/proceed immediately now: the sidebar shows the task with a spinner while its own pane streams live creation progress, and you can keep working elsewhere in the meantime. A failed create leaves a dismissible error in that pane instead of an error dialog. (#242)
- **Terminal panes going blank, again.** 0.27.3 fixed the case where the GPU context is lost and never comes back. This is the other half: when WebKit restores the context, xterm repairs itself in place and the repair is incomplete, leaving the renderer pointing at an evicted glyph atlas. From outside, that state looks healthy (no loss event fires, and the context genuinely is alive), which is why only restarting the tab cured it. The renderer now rebuilds on the raw lost and restored events on its own canvas, so a fresh context always gets a fresh atlas. That also removes the 3 seconds of black the already-working path used to cost. (#232, #241)
- A long branch name no longer takes the whole row it shares in the Git tab. On Commit the filter box had collapsed to its own padding, with no room for a character; it keeps 30% of the row now. On Compare the base ref you had picked was the thing that got crushed, down to a single letter, because the two names split the space in proportion to how long each already was. That bar wraps to a second row instead, so both refs stay readable.
- A folder in the file tree whose read fails no longer hangs on "Loading…" forever. A background refresh dropped any directory that failed to read and replaced the tree with what was left, which is exactly what happens when a build or a generator rewrites a directory mid-refresh. Refreshes merge now, a failed read retries once and then offers a Retry instead of spinning, and a failed root read cannot wipe the tree to empty. (#159)
- The History archive scrolls when it outgrows the window. Once you had more archived tasks than fit on screen, the rows below the fold were unreachable.
- A command palette action no longer fires minutes late over whatever you are doing. It was deferred by one animation frame, which macOS freezes while the window is occluded, so the dialog it opens arrived whenever you next looked at the window.
- Closing and reopening a fresh agent tab before its first prompt no longer resumes a session that never existed ("No conversation found"). The session id was persisted on a timer, before the agent had written its session file.
- Port allocation is serialized, so concurrent task creates and restores cannot scan the same snapshot and claim the same ports.
- opencode resumes the conversation you left instead of starting a fresh one. Its session id is created by opencode itself, so Termic reads it back after your first message, and the command that reads it could not find `opencode` on the installed app's PATH. Affects both worktree and main-checkout tasks. (#243)

### Thanks
- Preeti Yuankrathok (@earthpyy) for extra named ports and their hardening, the Fix merge conflicts prompt, and the CI fix for forked repos.
- Adrian Cristea (@cajbecu) for the History scroll fix.

## [0.27.3] - 2026-08-17

A commit graph, branch compare, comments on any file, and a big idle-CPU fix.

### Features
- **Git.** The right panel's Git tab is three sub-tabs. **Commit** stages and commits as before, with a Push button badged by the number of commits waiting to go out. **History** is a full-height commit graph: a dense row per commit (lane gutter, ref chips, subject, age), hover for the author, date and full message, click through to any file's diff at that revision. Scope it to this branch, every branch or refs you pick, collapse merged side branches with "First parent only", and search commit messages across the whole branch (git runs the search, so a match ten pages back still comes up first). **Compare** answers what all of it adds up to: one list of every path that differs between any ref and your working tree, committed, staged, unstaged and untracked together, rendered as a tree, and because its right side is the live file, mark-as-viewed and inline comments keep working, so a whole feature can be reviewed file by file without leaving Termic. Committed work used to vanish from the panel the moment the tree went clean, which is the gap all of this closes. In a multi-repo task all three sub-tabs follow the repo pill you picked. The Unstaged and Staged sections collapse, with Stage all / Unstage all still live. Lane colours come from the theme palette. (#199, #208)
- Select code in any file you are reading and comment on it, the same surface the diff pane has. Several remarks ship as one message, a body is optional, and Shift+Cmd+L stacks a selection from the keyboard. Queued comments follow their code as you edit around them, and the quote is frozen at capture. (#174)
- Find in files runs on ripgrep when you have it: faster on large repos, Unicode-aware, and its regex is what the results highlight with. Without it, `git grep` exactly as before, named in the dialog. (#181)
- Find in files gets a `.*` regexp toggle and an `Aa` match-case toggle, both off by default.
- Right-click any tab pill for Pin, Close, Close others, Close to the right. Pinned tabs sit in their own block outside the scroller, so they stay in reach however far the strip is scrolled, and the flag persists. (#183)
- Right-clicking a tab also offers Split right, Split down and Move to split. Move to split arms a cursor-following drag with the same ghost and edge highlight as a real one, so a tab can be placed in an existing pane without a grab; the next click drops it, Escape cancels.
- Right-clicking a task row in the sidebar offers a New submenu, the same rows as the tab strip's "+". (#197)
- `termic://` links open a pre-filled New Task dialog: `termic://new?project=web&worktree=1&name=fix-login&p=Fix%20the%20login%20bug`. The link only fills the form; a human still presses Create, which is the whole security model for taking a prompt from any page that can navigate to a URL scheme. New Task grows an optional first-message box. (#192)
- New Task can set the agent's resume arguments before its first spawn, the same override the task menu edits. It replaces a session-ID box that only appeared for agents able to resume by id, so codex and gemini had no field at all. (#169)
- Set a default location for worktrees in Settings, Tasks, and override it per repository. An invalid or git-tracked path is refused at save time.
- `termic tab close <task> --tab <sel>` closes a tab from the shell, the one tab verb that also reaches plain shells and custom terminals. (#185)
- `termic prompts` lists your prompt library and `-P/--library <sel>` fires one from `new`, `send` and `tab`. With `-p` too the library body arrives first: `termic result plan | termic new review --agent codex -P builtin:review -p -`.
- The archive dialog gets "Don't ask again". With confirmation off the delete-branch choice moves to Settings, Tasks. Note that the command palette's Archive then archives on Enter with no prompt.

### Bug fixes
- Idle Termic no longer sits on a third of a core doing nothing. An agent TUI re-emits its unchanged window title while it waits, and the setter wrote to the store every time, re-running every selector in every open task. On a 16-terminal window idle CPU drops from 19% to 12.7%. (#212)
- A slow login shell no longer costs a session its environment for the rest of the app's life. A failed probe used to be cached forever; it now retries in the background and swaps the real environment in for new sessions. (#186)
- Nix profile directories lead the fallback PATH, so a nix-darwin or home-manager machine no longer hides nix-installed CLIs from spawned sessions. Detection reads the same list. (#187)
- Narrowing one of an agent's title patterns in Settings no longer deletes the other two. Each field resolves on its own; empty means inherit, so switching one off needs an unmatchable pattern like `(?!)`.
- A `termic://` link's name fills the branch field too, instead of waiting for you to edit the name first.
- The "Couldn't resume your previous session" banner is gone. It outlived the failure it described and came back on every relaunch reworded as if nothing had happened. A failed resume now says so once and starts fresh; the agent's own picker (`claude --resume`) is the way back to the old session, which was never deleted.
- In a multi-repo task the Git tab opens on a repo that actually changed, instead of the empty wrapper.
- Terminal panes no longer go black after the Mac sleeps or the window sits in the background for hours. WKWebView reclaims the GPU context of a webview it thinks is idle, and every terminal kept compositing its last, empty frame, so restarting each tab by hand was the only way back even though the shell and the scrollback were fine the whole time. The renderer re-attaches on a fresh context now, and if the GPU is genuinely gone it stays on the DOM renderer with a forced repaint rather than black-flashing on a retry loop. It also checks on window focus, for the case where the loss never fires an event at all. (#232)
- `termic logs --tab <id>` no longer answers "no tab matches" for an id `termic tab` printed a second earlier. Tab lookup consulted only what the window had last reported, which a brand-new tab is not in yet; an exact id now falls back to the durable record. (#185)
- Clicking a desktop notification only brings the window forward. It used to yank you to that task on any refocus within 15 seconds.
- The bottom terminal takes focus when you open it, and collapsing the split hands focus back to the pane you came from.
- A pinned tab holds its width instead of resizing on every title the agent emits.
- Settings, projects and task metadata are written atomically, so a crash mid-write cannot truncate your configuration.
- Terminal in the new-task menu asks for a name in main-checkout mode, like every other item in that menu. It used to create the task at once and let Rust name it.
- The dashed "New task" placeholder in an empty project is the same height as a task row.

### Thanks
- Preeti Yuankrathok (@earthpyy) for the worktree path settings, atomic writes, and the archive confirmation opt-out.
- Bohdan Shulha (@bohdan-shulha) for tab pinning and close actions, collapsible git sections, the regexp and match-case toggles, and the terminal focus fixes.
- Michael Hohlios (@MHohlios) for `termic tab close`, the CLI prompt library, and both shell environment fixes.
- Adrian Cristea (@cajbecu) for the WebGL context-loss recovery.

## [0.26.0] - 2026-08-11

CLI tab targeting and worktree adoption, folder browsing in the editor, and image diffs.

### Features
- The Termic CLI is now stable and ON by default, so the `termic` command drives the app from any shell with no setup step: create a task, prompt an agent, wait for one to go quiet, read its result, list and archive. Every task's terminal is also handed the command in its environment, so an agent can instruct other tasks: fan a job out to several agents, wait on them, and read back what they produced, without you brokering it. Access still needs a token only your own user account can read, and agents in an enforced sandbox still never get it. Upgrading turns the CLI on once, including on profiles where it was off because that used to be the default. Switch it off after that and it stays off.
- `termic tab` opens another tab in a task and prints its id, and every verb that talks to a task takes `--tab` to aim at one: `send --tab`, `logs --tab`, `tab -p` to open and prompt in a single call. `status` lists the strip with the same ids and 1-based indices, and a selector that misses is a typed error naming the candidates rather than a silent default. `termic agents` prints the configured agent registry. (#138, #154, #156)
- `termic new --from <path>` adopts a worktree you created outside Termic: the project is resolved from its repo and the task name derived from its branch. `--resume <id>` on `new` and `tab` seeds an existing agent session instead of starting a fresh one, so a session you began in a terminal continues inside Termic. (#169, #171)
- `termic rename` retitles a task from the shell. A same-project duplicate refuses with a typed conflict instead of creating a second task with the same name. (#153, #162)
- A folder link in the markdown preview opens a GitHub-style listing in the same tab, not a dead link: rows navigate in place, `..` climbs back out, the folder's README renders underneath, and Cmd+[ / Cmd+] walk the trail you browsed. Clicking a file row keeps the listing and opens the file beside it. (#160)
- Editor syntax theme is configured per app mode. A dark-optimized scheme no longer gets forced onto a light surface: Appearance, Editor now has an "Editor theme (dark)" and an "Editor theme (light)". Existing settings carry over as the dark theme, and light starts from the same value until you change it.
- The terminal renderer is a three-way choice in Appearance, Terminal, on every platform: GPU (WebGL), Canvas, or DOM. It used to be a WebGL on/off toggle that macOS hid entirely, so a Mac user had no way to change renderer without hand-editing localStorage. WebGL stays the default and the right choice for almost everyone. Canvas and DOM are there for glitches, not for speed: text drawn wrong, flicker or leftover artifacts, or typing that lags on a setup running WebGL through a software rasterizer, as some Linux/WebKitGTK boxes do. Both cost more than twice the CPU of WebGL under heavy output, so there is no performance reason to move off it. Applies to terminals opened after the change; relaunch to switch the ones already open. (#140)
- Images in a git diff render as before and after pictures instead of pages of binary garbage. (#142)
- Protobuf and Elixir syntax highlighting, including the proto3 syntax the legacy mode missed. (#141)
- Double-click a file in the tree to open it in the OS default app, for anything the in-app editor cannot usefully render. (#150)
- Drag tasks to reorder them inside a project. The order persists, so a restart reads it back. (#146)
- The PDF preview keeps its page across tab switches instead of snapping back to page 1. (#148)

### Bug fixes
- `termic archive` now asks a task's agents to stop before it kills them. It used to SIGKILL them outright, which gave an agent no chance to flush its session transcript, so archiving a task could quietly cost you the history that makes it resumable and that `termic result` reads. Anything still running after a short grace is killed as before, so the worktree is never removed under a live agent.
- Find in the markdown preview marks the text you searched for, not the code spans around it. Stepping with Enter and Shift+Enter stays in step with the counter and wraps at both ends, a phrase the markdown source hard-wrapped still matches, and a regex metacharacter in the query is treated as literal text. (#168)
- The editor's line-number gutter is opaque, so a long line scrolled right no longer shows through it. (#161)
- The diff's line numbers stay level with the code when inline review comments are added. (#157)
- Settings dropdowns no longer carry WKWebView's own bevelled gradient, which read as a stray system widget against the light theme's flat panels.
- A run command with no label is no longer a nameless row in the Run menu and a nameless tab: it shows the command itself, clipped if it runs long, and the Settings label field previews what you'll get. Custom run tabs are keyed by label or by command, never both, so two unlabelled commands can't land on the same tab. (#177)
- A resume override no longer has its session renamed out from under it: `--name` is skipped whenever a verbatim resume override is active, so the second relaunch can still find the session. The Resume override dialog says so.

### Thanks
- Michael Hohlios (@MHohlios) for the CLI tab addressing, `termic rename`, worktree adoption, and the macOS GPU renderer toggle.
- Adam Matan (@adamatan) for folder listings in the editor, open-in-default-app, task reordering, the PDF page fix, and the branch label on the dev-build pill.
- Alex Goodman (@wagoodman) for the find-in-preview fix and both gutter fixes.
- Bohdan Shulha (@bohdan-shulha) for image diffs and protobuf/elixir highlighting.
- Preeti Yuankrathok (@earthpyy) for the unlabelled run command fix.

## [0.25.3] - 2026-08-01

A tray attention list, CLI send and attach, and several agent work-state fixes.

### Features
- A menu bar item that's always there, not just while windowless. It shows a numeral badge and a dropdown of tasks that need your input or just finished a turn, grouped by project; click one to bring Termic forward and jump straight to it.
- The termic CLI can now interact with a running agent, not just create and watch one: `send` types a prompt into a task (optionally `--wait`ing for the reply), `attach` opens a live raw-terminal session to it, `logs`, `diff`, `result`, and `apply` read its output and land its changes, and `path` prints its worktree. (#134)
- Settings shows what an agent's terminal actually emits and can propose done/attention patterns from a captured turn, instead of guessing at regexes against blank textareas. (#133)
- Choose, and see, which branch a worktree is cut from per project: current branch, the project default, or any local/remote branch, remembered as a policy rather than a one-time pin. (#133)
- Drag a file from the sidebar tree onto a terminal to type its path at the prompt, the same affordance a Finder drag already had. (#136)
- Resume now lives behind one row in the project menu that opens a submenu of your last 5 archived sessions, instead of listing them at the top level.
- History gets a bulk "empty the archive" action, behind a destructive confirmation naming the exact count.
- A "Show Termic in the menu bar" toggle in Settings, General, for anyone who doesn't want a permanent icon there. On by default and applies live, no restart needed. Choosing "Keep in Menu Bar" from the close prompt turns it back on if it was off, since that button is an explicit ask for the tray as your way back in.
- `termic quit` tears a windowless Termic down from the shell, naming what it's about to kill (agents, working tasks) and asking to confirm, or `--yes` for scripts. Windowless mode had left the menu-bar Quit as the only way to stop Termic, backwards for a CLI-driven setup.

### Bug fixes
- Claude's questions and permission prompts are detected as needing your input instead of being marked done, and a backgrounded subagent still running no longer shows as finished.
- Work state no longer gets stuck on "working" past a ten-minute ceiling, and no longer loses its spinner mid-turn with the tab only recovering on focus.
- Restoring a split task no longer leaves a blank pane where a terminal used to be.
- The working spinner no longer visibly wobbles while it spins.
- The signal inspector's Observed titles column no longer truncates to an ellipsis; the text wraps, is selectable, and has a copy button.
- Worktree tasks and races now prefer the `origin` remote and read its default branch from the remote's own HEAD, instead of guessing against local branch names.
- `make beta` no longer silently exits without opening a window when a previous Beta instance is still shutting down.
- The termic CLI's Getting started commands in Settings can now be selected and copied.

### Thanks
- Michael Hohlios (@MHohlios) for CLI phases 2 and 3 (send, attach, logs, result, diff, apply), `termic quit`, and the agent signal proposer.
- ghelton-procense for the CLI Getting started selectable-text fix.

## [0.24.0] - 2026-07-24

The termic CLI: create, watch, and archive tasks from any shell, plus per-repo run commands.

### Features
- A `termic` command, off by default and enabled in Settings, Termic CLI (marked experimental: the commands and their output can still change between releases). It drives the running app over a local socket, so a task it creates is a real task in your window, not a second copy of Termic. `termic new fix-auth -p "fix the login redirect"` creates a task in the repo you are standing in (worktree or main checkout, sandboxed or YOLO, any agent you have configured) and streams the setup script's output while it runs. `list`, `status`, `open`, `wait`, `archive`, and `project add|list|remove` cover the rest. Enabling installs the command into `~/.local/bin`; a button upgrades that to a system-wide install. Agents in an enforced sandbox never get access. (#125, #132, #133)
- The CLI is built to be scripted, including by agents. `--wait` blocks until the agent goes quiet and only reports success once the prompt was confirmed delivered, `--output-format json` and `stream-json` give machine-readable output with heartbeats so a consumer can tell a working agent from a hung one, exit codes are pinned in `--help`, and `termic help --json` dumps the whole command surface. (#133)
- Agents can drive Termic themselves. Every task terminal is handed the command's path, the task's own id, and a two-line usage note, so an agent working in a task can create more tasks, wait for them, and read what they produced, with no setup on its side. One agent farming work out to several in parallel is now a thing you can ask for. Agents in an enforced sandbox are refused. (#133)
- Custom run commands per repo, beyond the single primary run script. Right-click any file in the tree to run it once, or add it to the repo's run commands, kept personal or committed to `.termic.yaml` for the team. Saved commands get their own section in the Run dropdown with play/stop each, open as real run tabs, and are editable in Settings, Repositories, Scripts. (#124)
- A Run configuration dialog gathers the run, setup, and preview scripts plus the new run commands in one place, from the Run dropdown. (#124)

### Improvements
- Settings are organized by what they change. General had grown to 18 unlabelled rows, so it split into General, Tasks, Notifications, Sandbox, and Termic CLI. The rail is grouped now: the pages you open often at the top, the ones you set once in the middle, the sandbox and the CLI at the bottom. Two settings moved to where you would look for them: "Task expand behavior" is in Appearance, "Copy on select" is in Agents & Terminals. Nothing you configured changed, only where it lives.
- The file tree and Git status keep themselves current instead of waiting for the next poll. Discarding a file, switching or updating a branch, saving in the editor, renaming or deleting in the tree, a setup or run script finishing, and commands you type in the aux terminal all refresh the panels now. The 4 second poll also stops ticking while the window is in the background.
- Re-expanding a folder in the file tree re-reads it from disk, so a file created while it was collapsed appears without reloading the whole tree.
- Cmd/Ctrl+click on a path in terminal output now finds files inside gitignored folders anywhere in the working tree instead of reporting no matches. (#117)

### Bug fixes
- Worktree tasks and agent races work in a repo with no remote. The default base is `origin/main`, which such a repo does not have, so every worktree spawn failed at branch creation and the race just sat there. The base now falls back to your local `main`, then `HEAD`.
- "Copy" in the context menus (file tree, Git panel, diff header, breadcrumb, sidebar) works again. WKWebView refused the clipboard write from a menu selection; copying goes through the native pasteboard now.
- Terminal glyphs no longer cache against the wrong font and visibly swap when you select text. (#131)
- Creating a task whose name matches a branch an archived task left behind no longer collides: the auto-filled branch is numbered past it. A branch you typed yourself is never touched. (#129)
- Saving only the Personal tab of the Run configuration no longer writes an empty `.termic.yaml` into your repo. (#124)
- Termic declares its local network usage, so macOS can explain the permission prompt instead of asking for unexplained access. (#130)

### Thanks
- Michael Hohlios (@MHohlios) for the termic CLI, the design, the control plane, and the create/wait/archive/project verbs, and for the terminal font atlas fix.
- Justin Edmund (@jedmund) for the local network declaration.

## [0.23.4] - 2026-07-20

Fixes a tab-drag crash and clipped dialogs on scaled displays, plus tab and terminal fixes.

### Bug fixes
- Closing a split pane's last tab with the X now collapses the pane, matching ⌘W, instead of leaving an empty pane behind.
- Reordering tabs by dragging no longer crashes the task view on fractionally scaled displays. (#127)
- Dialogs no longer cut off their right edge (the Browse and Add buttons in Add project, Import worktree) on fractionally scaled displays. (#120, #126)
- Terminals no longer lock scrolling to the bottom after their pane was hidden and shown again. (#128)
- Cmd/Ctrl+click in terminal output now opens gitignored files too, and path detection requires a file extension so plain words stop turning into links. (#117)

### Thanks
- Michael Hohlios (@MHohlios) for the terminal scroll-lock fix.

## [0.23.1] - 2026-07-20

Agent races, Git branch switching, big battery savings, stop tasks, crisper terminal text.

### Features
- Agent races: fire one prompt at several agents at once, each in its own fresh worktree, and watch them attempt the same task side by side. When every racer finishes, compare their diffs in an N-up view and adopt the winner into your main checkout, optionally archiving the rest in the same step. Races take a name and an editable branch segment, and can launch sandboxed or in YOLO so permission prompts don't stall unattended racers. The launch dialog shows live progress while the worktrees spin up, and a race strip above the racers tracks each one with a live work-state badge. Start one from a project's actions menu. (#113)
- The Git tab shows your current branch and lets you switch to another local branch, Fork-style: local work (including untracked files) is stashed, the branch is checked out, and the stash is re-applied. A failed checkout rolls the stash back, and a re-apply conflict is surfaced instead of losing your changes. (#101, #111)
- Update a task branch without leaving the Git tab: pull from its upstream, or merge or rebase the task's base branch. Each op fetches first and auto-stashes local work. Conflicts are left in place for you to resolve in the task's terminal, and a conflicting stash re-apply is reported instead of being passed off as restored. (#101, #116)
- Worktree tasks symlink the project's agent config folders (.claude, .gemini, .codex by default, editable in Settings) so an agent working in a worktree keeps its skills, subagents, and permissions. (#112)
- Dismiss repos you no longer care about from the Add Project picker; a "Show hidden" row brings them back. The choice survives restarts without deleting anything from disk. (#109)
- A default-off "Show all fonts" checkbox in the font pickers widens the list from detected monospace fonts to the full installed catalog, for monospace fonts the detector misses. (#114)
- The work-in-progress spinner (agent tab and sidebar icon) is on by default now. If you turned it off, your choice sticks.
- Resume lists (the tab strip's + menu and the New task launcher) are one-line rows now: a compact greyed age (10m, 2d) sits before the name instead of a second line under it.
- Stop a task without archiving it: "Stop task" in the task row menu (and "Stop all tasks" on the project) kills its agents and frees the memory while keeping every session. Opening the task again resumes the conversations where they left off. (#119)
- Cmd/Ctrl+click a file path in terminal output to open it in the editor. (#117)

### Improvements
- Termic no longer drains your battery while idle. The PTY backend stopped sleep-polling (about 1,900 CPU wakeups per second, gone) and hidden panes stop rendering entirely instead of drawing every background repaint. Combined power drops up to 37% while agents stream, 15% at idle. (#121)

### Bug fixes
- Terminals no longer render mixed-height, wavy text after a cold start. The WebGL glyph atlas now waits on font faces Termic owns instead of trusting the browser's font registry, which reported ready before the font was. (#70, #100)
- The font pickers list only fonts actually installed on your machine, alphabetized, instead of offering curated names that silently fell back to the bundled font when picked. (#110)
- Option+click makes a selection in terminal panes even when the running program has captured the mouse. (#105)
- codex and grok no longer pop a startup update menu that swallows an injected prompt on unattended spawns (run-prompt into a new agent). When you are at the keyboard they still ask.
- The contact link copies the email address to the clipboard as a fallback when a hijacked mailto: handler eats the click. (#106)
- Creating a group pre-selects the suggested name so you can type straight over it. (#107)
- Clicking a changed file shows the diff its pane implies: an Unstaged row diffs the index against your working tree, a Staged row diffs HEAD against the index (what git diff and git diff --cached show). A file staged and then edited again no longer shows the same full diff from both rows. (#122)
- The built-in diff viewer stays precise on large files (pnpm-lock.yaml) instead of painting whole regions as changed; it matches git diff now. (#118)
- The Git tab no longer fills several gigabytes of RAM when a large directory (e.g. `node_modules` after `npm install`) is untracked. File lists are now capped at 5 000 entries per pane and rendered with virtual scrolling. A banner appears when the cap is hit. (#123)

### Thanks
- Orel Ohayon (@Orellius) for agent races, branch switching and updates with stash re-apply, worktree config symlinks, dormant repo dismissal, and the terminal font atlas fix.
- Michael Hohlios (@MHohlios) for the installed-fonts picker, the show-all-fonts escape hatch, the group-name pre-select, and for hunting down the idle battery drain (PTY sleep-polling plus hidden panes that never stopped rendering).
- @dancras for Cmd/Ctrl+click to open file paths from terminal output.
- @shimonenator for the bug reports behind both diff fixes and for the stop-without-archiving request.
- Nikhil Verma (@nikhilweee) for Option+click selection.
- Adam Matan (@adamatan) for the mailto fallback.

## [0.22.0] - 2026-07-14

Signed and notarized by Apple, adopt existing worktrees, custom work-done signals.

### Features
- Termic is signed and notarized by Apple now. A `.dmg` you download opens on first launch: no "unidentified developer" warning, no right-click to Open, nothing to strip from the command line. macOS also remembers the microphone permission across updates instead of asking again on every release.
- Adopt an existing worktree when you make a task. The launcher menu lists worktrees already on disk, so you can pick one up where you left it instead of branching a new one.
- Custom work-done signal detection for custom CLIs. Give your own agent the patterns that mean "finished" and Termic notices when it is done, the same way it does for claude, gemini, and codex. (#68, #97)
- Each agent's live title heuristics show as the signal placeholders, so you can see what Termic is actually matching on instead of guessing.
- A bigger starter prompt library. (#93)
- Group folder colors use per-theme palette shades, so a Finder-style color tag looks right in every theme instead of only the one it was picked in. (#95)
- Settings field groups sit in full-bleed bands, so a switch visibly owns the section it governs.

### Bug fixes
- A failed session resume keeps the live session instead of discarding it, and a later recovery swaps the two rather than overwriting whichever one you are actually working in. (#94)
- Light theme: raised terminal contrast so truecolor text from CLIs stays readable. (#83, #98)
- The output-scan switch is disabled until you give it patterns, since it does nothing without them.
- New task names count worktree rows in the sidebar, so the default name does not collide with a task you already have.

### Thanks
- Orel Ohayon (@Orellius) for the expanded prompt library, custom work-done signals, the light-theme contrast fix, and preserving the session on a failed resume.
- MHohlios (@MHohlios) for per-theme palette shades on group folder colors.

## [0.21.0] - 2026-07-13

Project folders, a prompt palette, and in-pane image and PDF previews, thanks to our contributors.

### Features
- Project groups: give any project a group label and it collapses under a folder in the sidebar, so a fleet of similarly named repos (app-ios, app-android, service-auth) clusters by product or layer while staying visible at a glance. Right-click a project to move it into a group, or drag it into, out of, or between folders; drag a folder header to reorder whole groups. Folders take Finder-style color tags, and a collapsed folder still shows a dot when one of its hidden agents needs you. (#84)
- Prompt palette: press Option+Cmd+P to search your prompt library by name and fire one straight at the focused agent, or pick a destination when there isn't one. While the search box is empty, keys 1 through 9 fire the top prompts instantly. (#81)
- Whole-app zoom: Cmd+= and Cmd+- scale the entire interface like a browser, Cmd+0 resets to 100%, and the level persists across launches. (#91)
- Image and PDF preview: click an image or a PDF in the file tree and it opens in the pane, rendered natively, right alongside your agents and diffs. (#75)
- Reopen closed sessions: the "+" tab menu now lists sessions you have closed in a task, so you can pick one back up instead of starting over. (#88)
- Find in the markdown preview: Cmd+F now searches within the rendered preview, and wins over the editor's own find when the preview pane has focus. (#71)
- New worktrees branch from a fresh base: task creation fetches the base ref first, so a new branch starts from the up-to-date base instead of a stale local copy. (#86)
- Remote images in the markdown preview are off by default now, behind a new setting, so opening a document can't silently reach out to the network until you opt in. (#85)
- Project discovery reaches one level deeper inside grouping folders, so nested repo layouts show up without adding each repo by hand. (#89)

### Bug fixes
- A single Claude agent no longer shows two "working" indicators at once. (#78)
- Directory links in the markdown preview reveal the folder in the file tree instead of opening Finder. (#87)
- Terminals wait for the font to load before spawning, so the first frame can't cache fallback glyphs into the WebGL atlas. (#70)
- The command palette moved to Shift+Cmd+P, and Cmd+K now clears the terminal, matching VS Code and standard terminals. Both remain rebindable in Settings, under Shortcuts.

### Thanks
This release leans heavily on community contributions. Thank you:
- Adam Matan (@adamatan) for the prompt palette, image and PDF preview, off-by-default remote images, and reopening closed sessions.
- MHohlios (@MHohlios) for project groups, drag-and-drop folders with Finder-style color tags.
- Orel Ohayon (@Orellius) for reaching one level deeper when discovering repos.
- Ehtasham Yasin (@Ehtasham-Yasin) for fixing the duplicate agent working indicators.

## [0.20.1] - 2026-07-10

Workspaces are now Tasks, and you can create one in two clicks from the sidebar.

### Features
- Renamed "workspace" to "task" everywhere: labels, menus, the command palette, shortcuts, and settings. Existing workspaces migrate automatically on first launch, with the old data backed up first, and templates that use {workspace_name} style placeholders keep working.
- Every task now has a location. "Main checkout" runs the agent in the repo's live checkout on its current branch, so edits land on your real files. "Worktree" is an isolated branch in its own working directory. A small icon marks each task in the sidebar, top bar, dashboard, and history.
- Quick task creation from the sidebar: click a project's "+", flip the Main checkout / Worktree toggle, pick an agent (or Terminal, or a custom command), and type a name inline. Worktrees also get an auto-filled, editable branch field, so there's no dialog for the common case.
- The Main checkout / Worktree choice is remembered across the app and shared by the quick menu, the New Task dialog, and Advanced, so it always opens the way you last worked.
- Custom launch command tasks (ssh, a dev server, a REPL) can now be created as a worktree too, with an editable branch.
- Creating a single-repo worktree opens the task right away and runs its setup script as a background tab, so you land on the agent immediately instead of waiting.
- Empty projects show a single "New task" button that opens the same menu as the "+" icon.

### Bug fixes
- Setup and run scripts always run outside the sandbox now, so they get the full network and filesystem they need (npm install, dev servers, and the like) even in projects that default to an enforcing sandbox.
- A task name that contains no letters or numbers is now rejected with a clear message instead of silently failing.
- Dragging the last main tab into a split pane no longer strands the main pane empty and unclosable: the main tab bar always keeps at least one tab, and dragging its only tab shows no drop target.

### Also in this release
Smaller improvements that landed alongside the rename:
- Custom themes: drop a JSON file in `~/.config/termic/themes/` and it shows up in the theme picker as a first-class theme, chrome and terminal together. The folder ships with a README and a copyable example. (#62)
- Rosé Pine, a new built-in theme, using the official ANSI palette so agent TUIs look the same in Termic as in Ghostty. (#61)
- Markdown preview renders images (relative and remote) and follows links, including `file.md#heading` jumps, missing-file notices, and folder-reveal in Finder. (#65)
- Fonts you pick from the system list are actually used, in both the terminal and the editor, so Nerd Font glyphs from oh-my-posh, starship, and Powerlevel10k stop rendering as empty boxes. The picker also lists every system font the first time you open it. (#63)
- Text on accent-colored buttons and badges stays readable in every theme, including the light accents of Cobalt, Matrix, and Rosé Pine. (#60)
- Custom light themes fall back to the light palette for any color they leave out, and the file tree keeps its expanded folders when you switch tasks.

## [0.18.4] - 2026-07-08

A Sublime-style split-pane rewrite, plus Run now lives in the main window.

### Features
- Split panes, reimagined: every pane now has its own tab strip. Drag tabs between panes, resize panes, and split in any direction by dropping a tab near a pane edge. A drag ghost with drop overlays shows exactly where the tab will land.
- Files now open in the active pane instead of always taking over the main one, and git diffs open there too. Open a file on one side while an agent keeps working on the other.
- Run and Setup now run in the main window, as a tab or a split of your choosing, with play, restart, and stop controls right in the tab pill. The bottom-right run log is gone.
- Top bar Run controls: Run/Stop plus a dropdown for per-repo run targets, setup, preview URL, and configure.
- Spotlight: the run executes at the repository root while a workspace is spotlighted, and moving the spotlight stops the old run and restarts it on the new workspace.
- Files changed on disk reload automatically when the editor has no unsaved edits (#57).
- Broadcast to a project's main agents: right-click a project and pick "Broadcast message" to send one message to the main agent of every workspace at once.
- Run setup tabs tidy themselves away a few seconds after the script finishes, with a countdown button in the "Setup finished" bar that closes it right away.
- Jump to the next waiting agent: press Shift+Cmd+A, or click the bell pill in the top bar (it shows how many agents are waiting), to cycle to the next workspace whose agent finished a turn or is blocked on you. (#56)
- Open your app's preview URL in the browser from a new button in the top bar run controls, shown while a run is active.
- A keyboard shortcuts icon in the sidebar footer opens the shortcuts cheat-sheet.

### Bug fixes
- Cmd+click opens links from terminals reliably, including hyperlink-style links (anchor text like "Learn more") inside TUIs with mouse reporting on, and plain clicks on them no longer pop a confirm dialog (#58).
- Restarting a run no longer flips the controls to idle while the new process is alive; restarts wait for the old process to exit so dev servers keep their port.
- Voice input: the microphone permission prompt now works in release builds.
- Run and Setup tabs no longer show up as destinations for reusable prompts or broadcast messages.

## [0.17.7] - 2026-07-01

Split pane layout persists across relaunches; TabBar buttons are now split-pane shortcuts.

### Features
- Split pane layout (tree, ratios, and all pane tabs including shells) is saved and fully restored on relaunch.
- Both TabBar shortcut buttons now open split panes: split right (Cmd+D) and split below (Shift+Cmd+D). The old bottom-shell toggle is replaced.

### Bug fixes
- Splitting from the main agent while other panes exist now places the new pane directly adjacent to main, not in the far corner.
- Splitting from the main agent via TabBar buttons now always targets main regardless of which pane was last focused.
- Pane navigation (Option+Cmd+arrows) now reaches panes that don't share a center-aligned edge with the current pane (e.g. navigating left from a small bottom-right pane now finds the full-height main pane).
- Keyboard shortcuts cheat-sheet no longer has a keyboard binding (was Shift+?), eliminating the "?" key being intercepted in the terminal. Open it from the icon or via the command palette. (issue #53)
- Option+Cmd+Up/Down now navigates workspaces when no horizontal split is open (previously cycled agent tabs). When a horizontal split exists, it still focuses the pane above or below.
- Option+Cmd+Left/Right now does nothing when no vertical split is open (previously switched tabs). It only navigates panes when a vertical split exists.
- Cmd+Left/Right in the terminal now moves to the beginning/end of line (Ctrl+A / Ctrl+E), matching macOS Terminal.app and iTerm2. (issue #51)
- Clicking back on the app window now reliably restores keyboard focus to whichever terminal or editor was last active, without requiring a second click.

## [0.17.0] - 2026-06-30

iTerm-style split panes: drag to rearrange, keyboard shortcuts, auto-close on exit.

### Features
- Split the main agent pane right (Cmd+D) or below (Shift+Cmd+D) into multiple panes, each running its own agent or shell.
- Drag pane headers to rearrange, with a red drop-zone preview showing exactly where the pane will land.
- Drop onto the main agent pane to reorient the layout (vertical or horizontal split).
- Non-main split panes close automatically when their agent exits.
- Dim inactive panes setting with adjustable opacity (Appearance settings).
- Dashboard workspace rows now show the workspace name and an explicit repo/worktree badge.

### Bug fixes
- Cmd+W now closes the active tab when no split pane is focused (regression from drag-target attribute added to main pane).
- Shift+? (was Cmd+/) opens the keyboard shortcut cheat-sheet.

## [0.16.1] - 2026-06-27

Restore archived workspaces, project context menu, opencode agent, terminal performance.

### Features
- History: restore archived workspaces; redesigned with search, branch and kind columns, archive dates, and auto-refresh.
- Sidebar: right-click a project for quick actions: new workspace, settings, rename, reveal in Finder, copy path, remove.
- Agents: opencode added as a built-in agent with icon, session capture, and resume support (worktrees via --continue, other workspaces via captured session ID).
- Agents: gemini CLI removed (Google is retiring it).

### Bug fixes
- Terminal: eliminated a 1-2 minute freeze when printing large files (was caused by JSON-serializing thousands of PTY events individually).
- Terminal: Cmd+Delete now kills the line to the beginning (sends Ctrl+U), matching macOS Terminal.app and iTerm2.

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
