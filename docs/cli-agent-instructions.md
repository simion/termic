# Driving Termic from an agent (instructions block)

The canonical instructions for teaching ANY coding agent to use the
`termic` CLI. Deliberately vendor-neutral: the block below drops into an
`AGENTS.md` (read by codex, gemini, cursor and friends), a `CLAUDE.md`,
or any agent's instruction channel, unchanged. The runtime discovery
floor needs none of this: spawned task PTYs carry `TERMIC_CLI` (binary
path) and `TERMIC_CLI_HELP` (a two-line version of these rules), and
`termic help --json` returns the whole surface machine-readably.

Distribution (a Settings action that appends/installs the block for
the user's agent setup) is still pending (see docs/plans/cli.md,
"Agents as users"). Until then, users paste it. Keep this file in
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

The file-drop convention is the reliable floor: instruct the created
agent, in the prompt, to write its deliverable to a named file, then
read that file after the wait succeeds. (`result` and `logs` below can
read a claude agent's last message / the rendered terminal stream, but
the file you asked for is the deliverable you verify.)

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

### Driving an existing task

- `"$TERMIC_CLI" send <task> -p "<text>" --wait` - prompt the RUNNING
  agent (queues if it is mid-turn). With no agent running, add
  `--resume` (restore the last session) or `--fresh` (new agent, no
  context). `-p -` reads stdin. Same exit-code contract as `new --wait`.
- A task can hold SEVERAL agent tabs. `"$TERMIC_CLI" tab <task>
  --agent <id> -p "<text>"` opens one and prompts it; record the
  printed tab id and pass `--tab <id>` to `send`/`wait`/`logs` to keep
  addressing that tab (ids are stable; indexes and titles shift).
  `status --json` lists every tab with its id, state and queue.
- `"$TERMIC_CLI" result <task>` - the agent's last message from its
  session transcript (claude only; other agents error and you fall back
  to the file convention).
- `"$TERMIC_CLI" logs <task> --json` - the last chunk of the agent's
  rendered terminal output (ANSI included). A quick look, not a
  deliverable.
- `"$TERMIC_CLI" diff <task> --json` - diff counts + commits vs the
  base branch; `--full` prints the unified patch on stdout.
- `"$TERMIC_CLI" apply <task> --yes` - land the task's diff as
  UNCOMMITTED changes in the project's main checkout. Exit 10 means
  conflict markers were left in the main checkout; say so, do not retry.
- `"$TERMIC_CLI" path <task>` - print the task's worktree path.

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

DO NOT run `"$TERMIC_CLI" quit`. Its `about` in `help --json` says the
same, so this block and the machine surface agree. It exists for the
human at the keyboard, not for you. It kills EVERY agent in EVERY task, including the sibling
agents you may be coordinating with and the session you are running in,
and it reverts any active spotlight session, which force-checks-out the
project's main checkout. `archive` is scoped to one task; this is not.

(`attach` exists too, but it is interactive and needs a real TTY; as an
agent you want `send`/`logs`/`result` instead.)

Never edit Termic's own data files; the CLI is the only interface.
<!-- INSTRUCTIONS END -->
