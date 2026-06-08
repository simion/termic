// Resolve the user's login shell for spawning interactive terminals
// (the scratch AuxTerminal and shell / custom-command tabs in
// TerminalPane). termic used to hard-code `zsh` here, so a machine
// without zsh installed couldn't open ANY terminal — bash and fish
// users were locked out entirely (issue #13). The backend resolves
// `$SHELL` (with a zsh → bash → fish → sh fallback); this caches the
// answer for the session and builds the right argv per shell.
import { defaultShell } from "./ipc";

let cached: Promise<string> | null = null;

/** Path to the user's login shell, resolved once on the backend and
 *  cached for the session. Falls back to `/bin/sh` if the IPC call ever
 *  fails — POSIX guarantees it exists, whereas hard-coding `/bin/zsh`
 *  would reintroduce the #13 lockout (spawn a non-existent binary, dead
 *  PTY) on a machine without zsh. */
export function loginShell(): Promise<string> {
  return (cached ??= defaultShell().catch(() => "/bin/sh"));
}

/** The shell's basename, e.g. "fish" for "/opt/homebrew/bin/fish".
 *  Used only to branch on shell family for argv quirks. */
export function shellName(shellPath: string): string {
  const base = shellPath.split("/").pop() || shellPath;
  // Strip a trailing major-version digit some distros append (bash5).
  return base.toLowerCase();
}

/** Build the PTY argv for an interactive login shell.
 *
 *  - Plain shell tab / aux terminal → a login shell (`-l`).
 *  - Custom-command tab → run `command`, then `exec` back into a
 *    login shell so the tab stays usable after the command exits (a
 *    Ctrl-C'd dev server leaves a live shell in the repo dir rather
 *    than a dead tab).
 *
 *  `-l` (login) and `-c` (run a command) are accepted by zsh, bash,
 *  fish, and POSIX sh alike, so the shape is shared. We pass the
 *  resolved shell path (not a bare `zsh`) to the trailing `exec` so
 *  the re-spawned shell matches whatever the user actually runs.
 *
 *  `-i` (force interactive) is added for the custom-command case so
 *  the command sees the same env as a real terminal — many users set
 *  PATH (nvm, mise, etc.) in their interactive rc, which a
 *  non-interactive shell skips. fish/zsh/bash all accept `-i`; we omit
 *  it for `sh`, whose `-i` semantics are flakier and which has no
 *  interactive rc worth sourcing here. */
export function loginShellArgs(shellPath: string, command?: string): string[] {
  if (!command) return ["-l"];
  const interactive = shellName(shellPath) === "sh" ? [] : ["-i"];
  return ["-l", ...interactive, "-c", `${command}; exec ${shellPath} -l`];
}
