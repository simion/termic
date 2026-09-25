# Driving Termic from an agent (instructions block)

The canonical instructions for teaching ANY coding agent to use the
`termic` CLI. Deliberately vendor-neutral: the block below drops into an
`AGENTS.md` (read by codex, gemini, cursor and friends), a `CLAUDE.md`,
or any agent's instruction channel, unchanged. The runtime discovery
floor needs none of this: spawned task PTYs carry `TERMIC_CLI` (binary
path) and `TERMIC_CLI_HELP` (a condensed version of these rules), and
`termic help --json` returns the whole surface machine-readably.

Distribution (a Settings action that appends/installs the block for
the user's agent setup) is still pending; the plan that tracked it was
retired when the CLI shipped. Until then, users paste it. To point ONE
agent at ONE task there is a short fragment instead: the task menu's
"Copy agent CLI briefing" (`src/lib/agentBriefing.ts`), which carries
the address and nothing else. Keep this file in lockstep with `termic
help`.

Why caged agents are excluded from all of this, and why the narrow
versions of "just let them report back" do not work either, is settled
in [sandbox.md](sandbox.md) ("Settled"). Do not reopen it here.

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

### Talking to another agent: prompt, do not wait

Every task is an agent with an inbox, and `send` is how you reach it.
Two agents coordinate by prompting each other, NOT by blocking on each
other. When you hand out work, end the prompt with the command you want
run once that work is done, and let the receiving agent pick the moment:

    "$TERMIC_CLI" send review-auth -p "[message from agent:claude
    task:$TERMIC_TASK id:$TERMIC_TASK_ID] <your prompt here: what you want
    it to do>. When done, reply: \"\$TERMIC_CLI\" send $TERMIC_TASK_ID -p
    '[message from agent:codex task:review-auth id:<its id>] done: <what
    you did> -- agent:codex task:review-auth id:<its id>'
    -- agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID"

The outer DOUBLE quotes are load-bearing: YOUR shell expands
`$TERMIC_TASK` and `$TERMIC_TASK_ID` at send time, so the other agent receives a literal
address it can just run. Single quotes there would block expansion and
leave it guessing at where to reply. `\$TERMIC_CLI` is escaped for the
opposite reason: the OTHER agent expands its own copy of that one.

Every prompt you send another agent opens with a header and ends with a
signature, both naming YOU, the sender: your agent name, your task's name
(`$TERMIC_TASK`) and its id (`$TERMIC_TASK_ID`, the address a reply goes
to). The reply you ask for carries the RECEIVER's identity the same way;
you know it, since it is the task you are prompting.

    [message from agent:<agent> task:<task name> id:<task id>]
    ...
    -- agent:<agent> task:<task name> id:<task id>

A prompt typed by the user and a prompt sent by an agent arrive in the
same terminal looking identical, so without this the receiver cannot tell
a peer's request from the user's instruction, or which peer sent it. The same goes the other
way: a prompt that arrives WITH that header came from another agent, not
from the user. Treat it as a request from a peer (the user's own
instructions win if the two conflict), and put the header and your own
signature on your reply.

A prompt arriving in your own terminal is one of those reports; act on
it and reply the same way. This is the preferred protocol because it
costs neither side its liveness, and because it does not depend on
work-done detection.

Prefer it over `--wait`. `--wait` blocks you on a heuristic (a settled
terminal is a guess, not a finished job), and a blocked agent can answer
nothing else meanwhile. Use it only for a short, self-contained step you
genuinely have nothing else to do during, and branch on its exit codes:
0 = settled done, 3 = stopped needing input, 7 = your --timeout expired
(the task keeps running), 9 = the prompt was never delivered. Never
assume 0, and remember exit 0 means the agent STOPPED, not that the work
is right.

If you are NOT running inside a Termic task you have no inbox to be
prompted back at. Then ask for a file (below) and read it when you next
have a reason to, rather than blocking.

A task sandboxed in `enforce` / `enforce-fs` cannot take part at all: the
cage denies it the control plane, so it can neither be asked to report
back nor do so. That is deliberate and permanent, not a bug to work
around - a cage with a text channel to an uncaged agent is not a cage.
Ask such a task for a file in its worktree and read that yourself, or
run it in `monitor` (which reaches the CLI by contract) or uncaged.

The sidebar's task menu has "Copy agent CLI briefing", which puts one
task's identity and that exact command shape on the clipboard as a short
block wrapped in `<termic-task id="..." name="..." project="..."
agent="..." path="...">`, ready to paste into a prompt for another agent:
the tag keeps it one clearly attributed unit whatever surrounds it. It
deliberately does NOT repeat the protocol above, because you are reading
it here and in `$TERMIC_CLI_HELP` already. It keeps exactly one sentence
the help does not have: leave the outer double quotes and the
`$TERMIC_` variables alone. The reader is an agent that rewrites the line
to slot its own prompt in, and mangling either kills the reply address
with no error.

### Creating a task that produces a result

Ask for a report back. End the prompt you give the new agent with the
signed `send` to your own task (see "Talking to another agent" above),
and its result arrives in your terminal when it is done. Termic's agent
hooks make this reliable, and it is the normal way results come back.

Use `--model <id>` to choose a model for one task without changing the
agent's shared Settings. Use `--arg=<value>` repeatedly for other agent
arguments; each value is one argv element, so a flag and its value are
two occurrences. Explicit `--model` is appended after `--arg` values and
wins when the agent treats the last model flag as authoritative:

    "$TERMIC_CLI" new implement-auth --agent codex --yolo \
      --arg=--reasoning-effort --arg=low --model <model-id> \
      -p "[message from agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID]
          Implement the approved authentication plan. When done, reply:
          \"\$TERMIC_CLI\" send $TERMIC_TASK_ID -p '[message from
          agent:codex task:implement-auth id:<its id>] done: <what you
          did> -- agent:codex task:implement-auth id:<its id>'
          -- agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID"

If no report arrives (the agent stopped early, or you need the answer
before it replies), `"$TERMIC_CLI" result <task>` reads a claude agent's
last message and `"$TERMIC_CLI" logs <task>` the rendered terminal.

**Fallback: a file.** Only when the agent cannot report back. A task
sandboxed in `enforce` / `enforce-fs` is denied the control plane, and a
script (or anything outside Termic) has no inbox to be prompted at. Then
the file you ask for is the whole channel, read on your own schedule:

    out=$("$TERMIC_CLI" new review-auth --project myproj \
      --sandbox enforce --json \
      -p "Review the auth module. Write your complete findings to
          RESULT.md in the repo root. Make no other changes.")
    path=$(echo "$out" | jq -r .task.path)
    # Caged, so nothing will arrive to tell you it finished: get on with
    # your own work and read "$path/RESULT.md" when you next need it.

Rules that matter:

- Unattended tasks need `--yolo` (no sandbox, skips permissions) or
  `--sandbox enforce` (permission prompts self-approve inside the
  sandbox); otherwise the agent stops at its first permission prompt.
  The sandbox costs you the report-back, per the section above: that is
  the trade, pick per task.
- Task names must be unique per project; a duplicate name is a clean
  error, so pick a fresh name or archive the old task first.

### Your task group

Every task you create with `new` from inside your own task joins YOUR
task's group: the sidebar draws them as one coloured block with a
caption, led by your task, so the user can see which tasks you started.
A worker that creates tasks adds them to the same group (groups do not
nest). `new --no-group` keeps a task out.

A group lives in one project's list, so a task you create in ANOTHER
project joins no group. It is still linked to yours: its summary carries
`spawned_by` (your task, as `project/name`), and the sidebar draws the
link when the user hovers either task.

Name the group for the batch of work, the way you would title a PR:

    "$TERMIC_CLI" group --name "Auth refactor" --color teal

`group` alone prints it (name, colour, members). `--name ""` goes back
to following your task's name, which is what an unnamed group shows.
Setting a name or colour on a task in no group founds one around it, so
you can name the group before creating any workers. Over MCP it is the
same: `task_new` joins your group with no argument and `task_group`
names it, because the MCP setup Termic installs tells the server which
task you run in (the headers helper sends your `$TERMIC_TASK_ID`).

### Driving an existing task

- `"$TERMIC_CLI" send <task> -p "<text>"` - prompt the RUNNING
  agent (queues if it is mid-turn or the user is typing into it, but is
  typed at once while it only waits on subagents or shells it started).
  With no agent running, add
  `--resume` (restore the last session) or `--fresh` (new agent, no
  context). `-p -` reads stdin. This is the notification channel above:
  ask for a report back rather than adding `--wait`.
- A task can hold SEVERAL agent tabs. `"$TERMIC_CLI" tab <task>
  --agent <id> -p "<text>"` opens one and prompts it; record the
  printed tab id and pass `--tab <id>` to `send`/`wait`/`logs` to keep
  addressing that tab (ids are stable; indexes shift, and a title the
  agent sets for itself changes mid-turn).
- Name the tab when you open it with `--title <name>` (unique in the
  task, not a bare number) and `--tab <name>` works just as well: a
  title you set survives the agent retitling itself and a relaunch.
  `"$TERMIC_CLI" tab <task> --tab <tab> --title <name>` renames an open
  tab, and `--title ""` gives it back its automatic title.
  `status --json` lists every tab with its id, state and queue.
- Without a task, `tab` opens the new agent in YOUR task:
  `"$TERMIC_CLI" tab --agent codex -p "..."` starts a second agent
  beside you, sharing your worktree. Sign the prompt as above.
- `"$TERMIC_CLI" tab close <task> --tab <id>` - close a tab you opened,
  so the strip does not fill up with finished ones. Kills that tab's
  agent (no `/exit` negotiation needed) and leaves the task and its
  other tabs running. This is the one tab verb that also reaches shell
  and custom-terminal tabs, so anything `tab` opens, it can close.
  Closing the task's DEFAULT tab needs `--yes`, because it is what an
  unqualified `send`/`wait`/`attach` resolves to.
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

### Scratchpads: notes for the user to read

A scratchpad is a tab in a task that holds text outside the worktree:
nothing in it reaches git, and the user sees it update as you write.
Use one for findings, a plan, logs, or a running report meant to be
READ, not committed: it is the place for temporary output, so never drop
throwaway `.md` files into the repo instead. Every `scratchpad` verb
targets your own task unless you pass `--task`. Over MCP the same verbs
are `scratchpad_new`, `scratchpad_write`, `scratchpad_read` and
`scratchpad_list`, also defaulting to your own task.

- `"$TERMIC_CLI" scratchpad new --title "<title>" -c "<text>"` - create one
  (it opens without taking focus) and print its id. `-c -` reads stdin.
- `"$TERMIC_CLI" scratchpad write <id> --append -c "<text>"` - add to it;
  without `--append` the text replaces it. With no `-c`, stdin, so
  `make test 2>&1 | "$TERMIC_CLI" scratchpad write <id> --append` works. An
  open pad updates in place and the user can undo your write.
- `"$TERMIC_CLI" scratchpad read <id>` - print it, including the user's edits.
- `"$TERMIC_CLI" scratchpad list` - every pad in the task, with ids.

Address pads by id: a title works when it is unique, but titles change.

### Other verbs

- `"$TERMIC_CLI" list --json` - all tasks with live work state
  (working / waiting / done / idle / inactive).
- `"$TERMIC_CLI" wait <task> --timeout 10m` - block until an existing
  task's agent is quiescent (settled AND empty message queue). Last
  resort; see "Talking to another agent" above for why.
- `"$TERMIC_CLI" status <task> --json` - one task in depth.
- `"$TERMIC_CLI" prompts --json` - the user's prompt library. Pass a
  prompt to `new`/`send`/`tab` with `-P <id>` (e.g. `-P builtin:review`);
  it delivers that prompt's body, and with `-p` too the body arrives
  first, then a blank line, then your text - so
  `... result plan | ... new review -P builtin:review -p -` hands one
  agent's output to another under a curated prompt. Pin ids in scripts
  (titles are user-editable); `prompts show <id>` prints a body.
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
