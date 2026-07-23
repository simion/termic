# Driving Termic from an agent (instructions block)

The canonical instructions for teaching ANY coding agent to use the
`termic` CLI. Deliberately vendor-neutral: the block below drops into an
`AGENTS.md` (read by codex, gemini, cursor and friends), a `CLAUDE.md`,
or any agent's instruction channel, unchanged. The runtime discovery
floor needs none of this: spawned task PTYs carry `TERMIC_CLI` (binary
path) and `TERMIC_CLI_HELP` (a two-line version of these rules), and
`termic help --json` returns the whole surface machine-readably.

Distribution is a Phase 2 item (see docs/plans/cli.md, "Agents as
users"): a Settings action that appends/installs the block for the
user's agent setup. Until then, users paste it. Keep this file in
lockstep with `termic help`.

Everything between the markers is the instructions content, verbatim.

<!-- INSTRUCTIONS START -->
## Termic tasks

Termic runs coding agents in isolated git-worktree tasks inside a GUI
app. The `termic` CLI (absolute path in `$TERMIC_CLI` when available)
is a remote control for the running app. If `$TERMIC_CLI` is unset, the
control plane is not enabled; do not go looking for the binary. If it
refuses with "control plane unavailable", you are inside a sandboxed
task and may not use it; say so instead of retrying.

Run `"$TERMIC_CLI" help --json` once for every command, flag, and exit
code. `$TERMIC_TASK` / `$TERMIC_TASK_ID` name the task you are running
inside, if any; prefer the id for self-reference (names can be renamed
or reused).

### Creating a task that produces a result

Agent terminal output is NOT readable from the CLI. Always use the
file-drop convention: instruct the created agent, in the prompt, to
write its deliverable to a named file, then read that file after the
wait succeeds.

    out=$("$TERMIC_CLI" new review-auth --project myproj \
      --sandbox enforce --json --wait \
      -p "Review the auth module. Write your complete findings to
          RESULT.md in the repo root. Make no other changes.")
    code=$?
    path=$(echo "$out" | jq -r .task.path)
    [ "$code" -eq 0 ] && cat "$path/RESULT.md"

Rules that matter:

- Unattended tasks need `--sandbox enforce` (permission prompts
  self-approve inside the sandbox) or `--yolo` (no sandbox, skips
  permissions; prefer the sandbox). Otherwise the agent stops at its
  first permission prompt.
- `--wait` exit codes are the contract: 0 = agent settled done,
  3 = agent stopped and needs input, 7 = your --timeout expired
  (task keeps running), 9 = the prompt was never delivered. Branch on
  them; never assume 0.
- Exit 0 means the agent STOPPED, not that the work is correct.
  Verify the deliverable file exists and says what you need.
- Task names must be unique per project; a duplicate name is a clean
  error, so pick a fresh name or archive the old task first.

### Other verbs

- `"$TERMIC_CLI" list --json` - all tasks with live work state
  (working / waiting / done / idle / inactive).
- `"$TERMIC_CLI" wait <task> --timeout 10m` - block until an existing
  task's agent is quiescent (settled AND empty message queue).
- `"$TERMIC_CLI" status <task> --json` - one task in depth.
- `"$TERMIC_CLI" archive <task> --yes` - kill the task's agents and
  remove its worktree. Destructive; only when asked to clean up.
- `"$TERMIC_CLI" project add <path>` - register a repo (needed once
  before creating tasks in it).

Never edit Termic's own data files; the CLI is the only interface.
<!-- INSTRUCTIONS END -->
