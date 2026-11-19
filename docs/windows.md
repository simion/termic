# Windows

Status: **experimental.** The app builds on Windows 11 x64, and CI builds,
installs and launches it on every push (`.github/workflows/windows.yml`),
but nobody has used it day to day yet. Releases carry an NSIS installer
signed for the in-app updater (`release.yml`, `build-windows`), which is not
Authenticode-signed, so SmartScreen warns on the first install. Some features
are not available yet (see "Not on Windows yet"). What is
still to do, and the measurements that decide how, is in
[ideas/windows.md](ideas/windows.md).

## Building it

It needs [Git for Windows](https://git-scm.com/download/win) (the app needs
Git anyway). The first run is from **Git Bash**, in the clone:

```sh
bash scripts/setup-windows.sh    # or `make setup` once GNU make is installed
```

After that `make` works from Git Bash, PowerShell or cmd alike: the Makefile
finds Git's own bash from `git --exec-path` and runs every recipe under it,
rather than trusting a bare `bash`, which outside Git Bash is System32's WSL
launcher.

It installs whatever is missing through winget and skips what is there:
the Visual Studio C++ build tools, WebView2, Rust (rustup), Node 22 and GNU
make, picking each one up in the same run (no new shell needed). Then it sets
`git config --global core.longpaths true`, runs `npm install`, seeds the e2e
fixture and runs a first `cargo check`. `WITH_DOCKER=1` also installs Docker
Desktop, for the Docker sandbox (use the WSL2 backend, Linux containers).

It never elevates. Two machine-wide settings need an admin, so it checks
them and prints the command instead:

- **Windows long paths** (recommended: worktrees with `node_modules` or
  `target` pass 260 characters). Admin PowerShell, then reboot:
  `New-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`
- **Developer Mode** (optional). Without it the app links directories with
  junctions and files with hard links instead of symlinks
  (`src-tauri/src/fs_link.rs`), which works for everything it links.

`make doctor` checks the result without installing anything. CI runs
`make setup` on every push, on a runner that already has everything.

Daily use is the same as on macOS:

| Command | On Windows |
|---|---|
| `make dev` | Vite + `tauri dev`. |
| `make check`, `make check-web`, `npm test`, `cargo test` | As on macOS. |
| `make build` | An NSIS installer in `src-tauri/target/release/bundle/nsis/`. No MSI: WiX depends on VBScript and is unreliable on Windows 11 24H2. |
| `make install` | Builds, installs per user (silent NSIS, no admin prompt) into `%LOCALAPPDATA%\Termic`, launches it. |
| `make beta` | The current branch as `Termic Beta`, installed next to the shipped app and sharing its data dir, exactly as on macOS. |
| `make uninstall` | Runs both apps' uninstallers silently. |
| `make reset`, `make reset_dev` | The Windows data locations (`%LOCALAPPDATA%\termic`, the WebView2 profile, window state). |
| `make cli-dev` | Copies (not links) the debug CLI to `~/.local/bin/termic-dev.exe`. Re-run after rebuilding it. |
| `make e2e` | Runs; CI runs it on every push (reporting, not gating). Most specs pass; the open ones are in ideas/windows.md. The fake agent is a bash script started through `scripts/fake-agent.cmd`. |
| `make perf` | The CI section runs; the local section (idle CPU / GPU) is macOS-only and says so. |

`make release` and `make icons` are maintainer tooling and stay macOS.

Without the updater signing key, `make build` skips the updater artifacts
rather than failing (on every platform).

## How it works differently

Each of these is a deliberate choice; the reasoning lives next to the code.

- **Sandbox: Docker only.** The macOS Seatbelt sandbox does not exist on
  Windows, and is not offered. A Seatbelt mode stored on a task (a Mac
  teammate's committed `.termic.yaml`, a project default, `--sandbox
  enforce`) reads as Off everywhere, backend
  (`Task::effective_sandbox_mode`) and frontend (`effectiveSandboxMode`),
  so it can never spawn uncaged while the UI calls it caged. See
  [sandbox.md](sandbox.md).
- **Docker paths.** The container is Linux, so a host path maps to
  `/c/Users/u/repo` inside it (`docker::in_container`, mirrored by
  `toContainerPath` in `src/lib/osPath.ts` for pasted and dropped files).
  A worktree's `.git` pointer file is rewritten to that form and mounted
  read-only over the host one. `core.autocrlf` is passed into the
  container, and automatic `git gc` is off there, because the worktree
  metadata holds host paths. Containers run as `1000:1000`: Claude refuses
  its skip-permissions mode as root. "Docker is ready" means a daemon
  running Linux containers.
- **Shells.** `.termic.yaml` scripts, command tabs, and session-capture
  commands run under Git for Windows' own `bash.exe`, found from `git`'s
  location (`shell_env::script_bash`). A bare `bash` on Windows is
  System32's WSL launcher. Plain terminal tabs open `pwsh`, then Windows
  PowerShell, then `cmd`.
- **PATH.** No login-shell probe: PATH is read from the registry (machine,
  then user) on every use, plus what the process inherited, so a tool
  installed while Termic runs (Git, an agent CLI) is found without a
  restart (`shell_env::windows_live_path`). Every PATH walk splits with the
  platform separator and resolves PATHEXT (`shell_env::which_in`), skipping
  npm's extensionless shell shim that sits next to every `.cmd` one, and a
  bare agent command is resolved that way before the spawn.
- **Processes.** No process groups: stopping a script, a language server or
  an agent kills its process tree (`proc_ctl.rs`, a ToolHelp snapshot with
  a creation-time check so a reused pid is never mistaken for a child).
  There is no SIGTERM for console programs: archiving a task types Ctrl+C
  into each agent's terminal and gives it the same grace period before the
  tree kill; a script's Stop is forceful.
  Every background command is spawned with `CREATE_NO_WINDOW`.
- **Terminals (ConPTY).** Two things a unix PTY never does, both measured
  by `src-tauri/examples/conpty_osc_probe.rs`. The reader gets no EOF when
  the child exits by itself: ConPTY holds its output pipe open until the
  pseudoconsole is closed, so the PTY waiter closes it (drops the slot)
  after a short drain, or `pty-exit` would never fire. And ConPTY
  announces the program's path as the window title before the program
  runs (`isConsoleHostTitle` drops it). Archiving stops every PTY of the task,
  its shell and command tabs included, before deleting its worktree,
  because Windows will not delete a directory that is a live process's
  working directory.
  The ConPTY is Microsoft's newer `conpty.dll` + `OpenConsole.exe`, shipped
  beside `termic.exe` (`src-tauri/resources/windows/conpty`, placed by
  `tauri.windows.conf.json`), not the one built into Windows: that one does
  not forward a program's mouse reporting request, so the wheel scrolled
  xterm's scrollback instead of reaching TUIs like opencode (GH #437).
  portable-pty prefers a `conpty.dll` next to the exe and falls back to the
  system one without it. The EOF and title behaviour above was measured on
  the system ConPTY. `src-tauri/tests/conpty_mouse.rs` gates the mouse
  request in the Windows CI job.
- **CLI control plane.** Loopback TCP on an ephemeral port, whose address
  is written into the `termic.sock` path (`termic_proto::local`). The
  per-boot token in the per-user data dir remains the credential. This is
  weaker than unix (no kernel peer-identity check): another local account
  can reach the unauthenticated `hello`, `raise` and `open_url` verbs.
  `termic attach` uses console VT mode, with the window size polled.
- **`termic` on PATH.** A copy of the sidecar, not a link (creating a
  symlink needs elevation or developer mode): `bin\termic.exe` under the
  data dir for the user, `%ProgramFiles%\Termic\bin\termic.exe` for every
  user. Both directories are Termic's own, which is what lets a file found
  there be treated as ours. Never the install dir itself, where `termic`
  would resolve to `Termic.exe`. "Add to PATH" appends the directory to
  `HKCU\Environment\Path`; the all-users install copies and appends to the
  machine `Path` behind one UAC prompt. Both edits read the value
  unexpanded and write it back expandable, so an existing
  `%USERPROFILE%\...` entry stays a reference
  (`cli_server::add_to_path_script`). The user copy is refreshed at launch
  when an update changed the sidecar, by renaming the old exe aside (a
  running exe renames, it does not overwrite). The all-users copy cannot be
  refreshed without a prompt, so it stays at the version it was installed
  from until "Install system-wide" is clicked again, and the machine `Path`
  comes before the user one.
- **MCP headers helper.** Claude runs a server's `headersHelper` through
  cmd.exe (measured on 2.1.291, with Git Bash installed), where the POSIX
  `printf ... "$(cat ...)"` registered on unix prints no token. The request
  then goes out bare, the 401 sends claude into its OAuth probe, and the
  failure reads "Dynamic Client Registration rejected (HTTP 404)". Windows
  registers `"<termic-cli.exe>" mcp-headers "<token file>"` instead
  (`mcp_server::helper_command`). A registration made by an older build
  keeps the old helper until "Add to Claude" is clicked again. Which shell
  codex runs its helper in on Windows is unmeasured.
- **MCP port.** Hyper-V (WSL, Docker) reserves blocks of 100 ports inside
  the dynamic range 49152-65535 and reshuffles them on restart (`netsh int
  ipv4 show excludedportrange protocol=tcp`). A port in a reserved block
  cannot be bound by anyone, the bind answers WSAEACCES with nothing
  listening, so an endpoint on 65510 served for days and then refused. An
  unset port is therefore picked from 23517-23616 (`AUTO_PORTS`), never
  OS-assigned, and a refused typed port is reported in Settings > MCP as
  reserved rather than as held by another process.
- **LAN sharing** ([peers.md](peers.md)). The first wildcard bind (the
  peer listener, and the mDNS socket on 5353) raises the Defender
  Firewall prompt: choose Private networks. On a network Windows marks
  Public, other machines cannot reach this one whatever was chosen, and
  Settings says so. Port 5353 is shared with the DNS Client service
  through `SO_REUSEADDR`, and interfaces come from
  `GetAdaptersAddresses`. The listener port is picked from 23620-23719,
  below the Hyper-V reserved range (see MCP port, above). All of it
  type-checks for Windows; none of it has run on real Windows hardware
  yet.
- **Paths in the UI.** `src/lib/osPath.ts` holds the platform rules:
  segment-safe `relUnder`, `baseName`, standard `file:///C:/...` URIs for
  the language servers (mirrored by `lsp_path_to_uri`), and quoting rather
  than backslash-escaping a dropped path.
- **Window.** No native frame (`decorations(false)` in
  `build_profile_window`): the app's own top bar is the title bar, as on
  macOS. It drags the window, a double click maximizes or restores it (read
  off the mousedown's click count, since the system's move loop swallows a
  dblclick), and `WindowControls` draws minimize, maximize / restore and
  close in Windows' look. The window keeps its shadow and resize edges.
  `-webkit-app-region` is still applied only on macOS: WebView2 honours it
  (WKWebView ignores it), so a dialog's full-screen backdrop would become
  window caption on Windows. While a modal dialog is open its backdrop
  covers the caption buttons (Radix blocks and dismisses on outside
  clicks), so the window is closed from the dialog first. No Windows 11
  snap-layout flyout on the maximize button yet. WebView2's browser keys
  (F5 and Ctrl+R reload, Ctrl+P prints) are switched off
  (`disable_browser_accelerators`).
- **Text.** Grayscale antialiasing, not ClearType: every window is created
  with `--disable-lcd-text` (`with_grayscale_text`), because ClearType's
  colour fringes read as a shadow on a dark theme. A WebView2 browser
  argument has a cost worth knowing: every process sharing a WebView2
  user-data folder shares one browser process, and a webview asking for
  different arguments than the running one is never created. Measured: a
  build with the flag, started beside an installed build without it, came
  up with no webview at all. Two builds that differ in their arguments
  cannot run side by side on one folder (`WEBVIEW2_USER_DATA_FOLDER` moves
  one of them; the e2e suite sets it).
- **Keys.** Ctrl stands in for Cmd, and so does the Windows key (the same
  rule as Linux, see docs/shortcuts.md "What Cmd is on each platform").
  Shortcut hints read `Ctrl+Alt+P`.
  In a terminal, plain Ctrl+letter goes to the shell (Ctrl+P is readline's,
  not the file finder), and Ctrl+V pastes, as in every Windows terminal.
  With an image and no text on the clipboard, Ctrl+V saves the image and
  pastes its path, which the agent attaches (`windowsPasteText` in
  `src/lib/clipboardImage.ts`). The agents bind their own image paste to
  Alt+V on Windows, because Ctrl+V never reaches them.
  Ctrl+Shift+F is find-in-files everywhere, terminals included, as in
  VS Code; a terminal's own find is Ctrl+Alt+F (plain Ctrl+F is readline's
  forward-char).
  Ctrl+Shift+W closes the tab from inside a terminal, for the same reason:
  close-tab is Ctrl+W, and in a terminal that is the shell's
  delete-previous-word. Outside a terminal Ctrl+W closes as before. The same
  holds on Linux (`isTerminalCloseCombo`, `lib/terminalFind.ts`).
- **Agent hooks.** There is no PTY slave to write to, so each PTY gets a
  named pipe the app serves (`hook_pipe.rs`), exported as `TERMIC_PTY`;
  whatever a hook writes there joins that PTY's output. Git Bash cannot open
  a named pipe with `>`, so on Windows the generated scripts write through
  `"$TERMIC_CLI" hook-emit "$TERMIC_PTY"` (`bound_emits`). Claude only for
  now: its hooks run in Git Bash. An end-to-end test runs claude's real
  scripts on the Windows runner.
- **Activity monitor.** `procmon_windows.rs`: one ToolHelp snapshot is the
  pid table, and only the processes under one of our roots are opened.
  Memory is the private working set, the figure Task Manager's Memory column
  shows. A parent pid is kept only when the child is younger than the parent
  (the rule `proc_ctl` uses, for the same reason). WebView2's processes are
  the app's own descendants, so they are in the Termic row with no
  attribution step, except when another Termic on the same WebView2 data
  folder started first (a dev or e2e build beside the installed app): there
  is one browser process per folder, the later instance's renderers hang
  under the other app, and its Termic row says the webview is not
  attributable. There are no signals: Stop ends the row's process tree,
  and Pause / Resume suspend and resume all of it (`NtSuspendProcess`),
  counted so that one Resume undoes any number of Pauses.
- **Editor.** A file whose line breaks are all CRLF is saved as CRLF.
- **Language servers.** The pinned downloads have Windows x64 and arm64
  entries; a server in the checkout is looked up in `.venv\Scripts` and as
  npm's `.cmd` (`lsp_local_exe`).
- **Names.** A task name never becomes a Windows reserved device name
  (`con`, `nul`, `com1`...), on every OS, so it checks out everywhere.
- **AltGr** never fires a Ctrl+Alt shortcut.
- **Closing the window quits**, as Windows users expect. The macOS
  close-to-menu-bar behaviour is macOS-only.
- **Remote control** ([remote.md](remote.md)). A Windows desktop hosts its
  own tasks for phones and paired computers like any other, and adds
  servers with Windows' built-in OpenSSH (`ssh.exe`, `ssh-keyscan`,
  `ssh-keygen`), every call without a console window
  (`remote_client::tool`). A missing OpenSSH Client is one sentence naming
  the Optional features switch. The QR code's address list includes
  adapters without multicast (`mdns::windows_addrs(false)`), which is how a
  Tailscale address reaches the phone. `termic-server` itself is unix only
  (Linux and macOS servers); its crate builds on Windows as a stub so the
  workspace does. Checked with `cargo check --workspace --all-targets
  --target x86_64-pc-windows-gnu`; not yet driven on a real Windows machine.

## Releases and updates

`release.yml` builds the NSIS installer on `windows-latest` with the same
updater key as the Mac and Linux builds, and checks the signature against the
public key in `tauri.conf.json` (`scripts/verify-updater-sig.mjs`) before
uploading. The job is not in the release job's `needs`: `release-windows`
attaches the installer to the finished release, and `latest.json` gains a
`windows-x86_64` entry only when that upload happened, so a Windows failure
costs Windows that version and nothing else. The recipe was rehearsed on the
Windows runner before the first release (signed build, signature check,
silent install, launch, uninstall). The updater installs in `passive` mode (progress bar, no
prompts); Windows cannot replace a running exe, so the app closes for the
install.

## Not on Windows yet

- **Agent hooks for agents other than claude.** Claude's hooks work (they
  run in Git Bash). Which shell codex, gemini and the rest run hooks in on
  Windows is unmeasured, so theirs are not offered yet.
- **CLI auto-launch.** With the app closed, `termic` says so instead of
  starting it (`termic-cli/src/client.rs` launches on macOS only).
- **PDF preview** (needs a CSP change) and **code signing** (updates work;
  the installer is not Authenticode-signed, so SmartScreen warns on the
  first install).
