---
name: termic
description: Control agents within Termic and configure shared skills, MCP servers, and agent personas. Use for task delegation across projects, peer reviews in tabs, asynchronous coordination, or profile customization formats and model selection.
---

# Termic Task Orchestration

Termic runs coding agents in isolated git-worktree tasks inside a GUI app. The `termic` CLI (absolute path in `$TERMIC_CLI` when available) is a remote control for the running app. If `$TERMIC_CLI` is unset, the control plane is not enabled; do not go looking for the binary. If it refuses with "control plane unavailable", you are inside a sandboxed task and may not use it; say so instead of retrying.

Run `"$TERMIC_CLI" help --json` once for every command, flag, and exit code. `$TERMIC_TASK` / `$TERMIC_TASK_ID` name the task you are running inside, if any; prefer the id for self-reference (names can be renamed or reused).

## Read the Relevant Reference

- Before using customizations with a particular harness, read
  [Harness compatibility](references/compatibility.md). Termic has native
  adapters for Claude Code, Codex, and Antigravity; other harnesses have
  partial compatibility that differs between skills, personas, and MCP.
- To add or edit shared skills, MCP servers, or agent personas, read
  [Customizations and profiles](references/customizations.md). It contains
  file formats, secret handling, profile paths, inheritance, and persona
  model tiers. Edit customization sources, rather than generated task files.
- To use MCP instead of the CLI, find every tool's CLI counterpart, or
  coordinate tasks across projects, read
  [CLI and MCP control surface](references/control-surface.md). Use the
  installed CLI's `help --json` or MCP `tools/list` for exact arguments.

## Choose the Launch Configuration Explicitly

A new `tab` starts a fresh conversation. Use `--resume SESSION_ID` only when the assignment is to continue that specific conversation. Do not use a model-switch prompt to repair a tab that resumed the wrong thread.

Choose the registry agent with `--agent`; choose a model with `--model`. Pass provider-specific reasoning options as repeated `--arg` values, one argv element per flag. For example, Codex accepts a configuration override:

    "$TERMIC_CLI" tab --agent codex --model MODEL \
      --arg=-c --arg='model_reasoning_effort="xhigh"'

Honor the user's explicit model/effort choice and project routing policy. Otherwise match the assignment: routine, well-specified edits usually need less reasoning than unresolved design, difficult debugging, or a broad review. Consult the selected provider's help/configuration for its actual supported values; different providers need not share reasoning names. State the choice in the assignment. Never silently fall back to a different model or change global agent settings to configure one tab.

These overrides belong to that tab and survive restoration. Opening replies and `status --json` expose `agent_args` for verification. They report the configured arguments, not a provider-confirmed active model. `help --json` is the discovery source for installed CLI support.

## Talking to Another Agent: Prompt, Do Not Wait

Every task is an agent with an inbox, and `send` is how you reach it. Two agents coordinate by prompting each other, NOT by blocking on each other. When you hand out work, end the prompt with the command you want run once that work is done, and let the receiving agent pick the moment. Ask for that report every time it finishes or gets stuck, follow-up work included, until a human tells it to stop:

    "$TERMIC_CLI" send review-auth -p "[message from agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID}] <your prompt here: what you want it to do>. When done, reply: \"\$TERMIC_CLI\" send $TERMIC_TASK_ID ${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }-p '[message from agent:codex task:review-auth id:<its id>] done: <what you did> -- agent:codex task:review-auth id:<its id>' -- agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID}"

The outer DOUBLE quotes are load-bearing: YOUR shell expands `$TERMIC_TASK`, `$TERMIC_TASK_ID`, and `$TERMIC_TAB_ID` at send time (using `${TERMIC_TAB_ID:+...}` so `tab:` and `--tab` are included only when running inside an agent tab), so the other agent receives a literal address it can just run. Single quotes there would block expansion and leave it guessing at where to reply. `\$TERMIC_CLI` is escaped for the opposite reason: the OTHER agent expands its own copy of that one.

Every prompt you send another agent opens with a header and ends with a signature, both naming YOU, the sender: your agent name, your task's name (`$TERMIC_TASK`), its id (`$TERMIC_TASK_ID`, the address a reply goes to), and when `$TERMIC_TAB_ID` is set, `tab:$TERMIC_TAB_ID` (your tab, whether on the strip or inside a split pane). The reply you ask for carries the RECEIVER's identity the same way; you know it, since it is the task you are prompting.

    [message from agent:<agent> task:<task name> id:<task id> tab:<tab id>]
    ...
    -- agent:<agent> task:<task name> id:<task id> tab:<tab id>

A prompt typed by the user and a prompt sent by an agent arrive in the same terminal looking identical, so without this the receiver cannot tell a peer's request from the user's instruction, or which peer sent it. The same goes the other way: a prompt that arrives WITH that header came from another agent, not from the user. Treat it as a request from a peer (the user's own instructions win if the two conflict), put the header and your own signature on your reply, and pass `--tab <tab id>` (MCP `tab`) when the incoming header includes `tab:<tab id>` (and note that direct replies from a spawned child default back to the initiating parent tab even when `--tab` is omitted while that tab is still live). Keep reporting back to that id every time you finish or get stuck, follow-up work included, and stop only when a human tells you to.

A prompt arriving in your own terminal is one of those reports; act on it and reply the same way. This is the preferred protocol because it costs neither side its liveness, and because it does not depend on work-done detection.

Prefer it over `--wait`. `--wait` blocks you on a heuristic (a settled terminal is a guess, not a finished job), and a blocked agent can answer nothing else meanwhile. Use it only for a short, self-contained step you genuinely have nothing else to do during, and branch on its exit codes: 0 = settled done, 3 = stopped needing input, 7 = your --timeout expired (the task keeps running), 9 = the prompt was never delivered. Never assume 0, and remember exit 0 means the agent STOPPED, not that the work is right.

If you are NOT running inside a Termic task you have no inbox to be prompted back at. Then ask for a file (below) and read it when you next have a reason to, rather than blocking.

A task sandboxed in `enforce` / `enforce-fs` cannot take part at all: the cage denies it the control plane, so it can neither be asked to report back nor do so. Ask such a task for a file in its worktree and read that yourself, or run it in `monitor` (which reaches the CLI by contract) or uncaged.

## Reviewing a Pull Request

`"$TERMIC_CLI" review <pr>` (MCP `task_review`) fetches the PR (a number, `#123`, or its link), checks its branch out in a new worktree task named `review-pr-<n>` (`--main` uses the project's main checkout instead), and starts an agent on the PR's details followed by a prompt from the library tagged "Code review". `-P <id or title>` picks that prompt; without it the first tagged one is used. `-p` adds your own text after it. A second review of the same PR fails on the existing task: `send` to it instead.

## Creating a Task That Produces a Result

Ask for a report back. End the prompt you give the new agent with the signed `send` to your own task (see "Talking to another agent" above), and its result arrives in your terminal. Ask for a report every time it finishes or gets stuck, follow-up work included, until a human tells it to stop. Termic's agent hooks make this reliable, and it is the normal way results come back.

Use `--model <id>` to choose a model for one task without changing the agent's shared Settings. Use `--arg=<value>` repeatedly for other agent arguments; each value is one argv element, so a flag and its value are two occurrences. Explicit `--model` is appended after `--arg` values and wins when the agent treats the last model flag as authoritative:

    "$TERMIC_CLI" new implement-auth --agent codex --yolo \
      --arg=--reasoning-effort --arg=low --model <model-id> \
      -p "[message from agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID}]
          Implement the approved authentication plan. When done, reply:
          \"\$TERMIC_CLI\" send $TERMIC_TASK_ID ${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }-p '[message from
          agent:codex task:implement-auth id:<its id>] done: <what you
          did> -- agent:codex task:implement-auth id:<its id>'
          -- agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID}"

If no report arrives (the agent stopped early, or you need the answer before it replies), `"$TERMIC_CLI" result <task>` reads a claude agent's last message and `"$TERMIC_CLI" logs <task>` the rendered terminal.

**Fallback: a file.** Only when the agent cannot report back. A task sandboxed in `enforce` / `enforce-fs` is denied the control plane, and a script (or anything outside Termic) has no inbox to be prompted at. Then the file you ask for is the whole channel, read on your own schedule:

    out=$("$TERMIC_CLI" new review-auth --project myproj \
      --sandbox enforce --json \
      -p "Review the auth module. Write your complete findings to
          RESULT.md in the repo root. Make no other changes.")
    path=$(echo "$out" | jq -r .task.path)

Rules that matter:
- Unattended tasks need `--yolo` (no sandbox, skips permissions) or `--sandbox enforce` (permission prompts self-approve inside the sandbox); otherwise the agent stops at its first permission prompt.
- `--account <name>` (MCP `account`) runs the new task's agent on one of its named accounts (Settings > Agents > credentials).
- Task names must be unique per project.

## Multi-Repo Projects

A multi-repo project holds several repos, possibly many, plus a host folder whose CLAUDE.md and AGENTS.md every task of it sees. Its repos are its members, and each task picks the ones it needs. `"$TERMIC_CLI" project list` (MCP `project_list`) shows which projects are multi-repo and names their members; with `--json`, `type` is `"multi"` and `members` holds each one's `name` and `root_path`.

Name the members a task needs with `--member <name>`, once per member (MCP `task_new` `members`). Each named member gets its own worktree on the task branch, and the rest stay out. Without `--member` no member gets a worktree, so pass it whenever the work touches a member repo:

    "$TERMIC_CLI" new fix-login --project shop --member api --member web -p "..."

An unknown member name, or `--member` on a project that is not multi-repo, fails before anything is created and lists the valid names: the project's members, or the multi-repo projects. Read the names from `project list` rather than guessing them.

## Your Task Group

Every task you create with `new` from inside your own task joins YOUR task's group: the sidebar draws them as one coloured block with a caption, led by your task, so the user can see which tasks you started. A worker that creates tasks adds them to the same group (groups do not nest). `new --no-group` keeps a task out.

A group lives in one project's list, so a task you create in ANOTHER project joins no group. It is still linked to yours: its summary carries `spawned_by` (your task, as `project/name`), and the sidebar draws the link when the user hovers either task.

Name the group for the batch of work, the way you would title a PR:

    "$TERMIC_CLI" group --name "Auth refactor" --color teal

`group` alone prints it (name, colour, members). `--name ""` goes back to following your task's name.

To move a task between groups:

    "$TERMIC_CLI" group <task> --join <other>   # into <other>'s group
    "$TERMIC_CLI" group <task> --leave          # out of its group

## Driving an Existing Task

- `"$TERMIC_CLI" send <task> -p "<text>"` - prompt the RUNNING agent (queues if it is mid-turn or the user is typing into it). With no agent running, add `--resume` or `--fresh`. `-p -` reads stdin.
- A task can hold SEVERAL agent tabs (both on the top tab strip and inside split panes). `"$TERMIC_CLI" tab <task> --agent <id> -p "<text>"` opens one and prompts it; record the printed tab id and pass `--tab <id>` to `send`/`wait`/`logs` to keep addressing that tab (an exact tab id reaches both strip tabs and split-pane agent tabs).
- Name the tab when you open it with `--title <name>` (unique in the task, not a bare number) and `--tab <name>` works just as well.
- Without a task, `tab` opens the new agent in YOUR task: `"$TERMIC_CLI" tab --agent codex -p "..."` starts a second agent beside you, sharing your worktree.
- `"$TERMIC_CLI" tab close <task> --tab <id>` - close a tab you opened.
- `"$TERMIC_CLI" prop <key> <value>` - label YOUR tab with what you are working on (`prop ticket ABC-1`, `prop status review`).
- `"$TERMIC_CLI" result <task>` - the agent's last message from its session transcript.
- `"$TERMIC_CLI" logs <task> --json` - the last chunk of the agent's rendered terminal output.
- `"$TERMIC_CLI" diff <task> --json` - diff counts + commits vs the base branch; `--full` prints the unified patch.
- `"$TERMIC_CLI" apply <task> --yes` - land the task's diff as UNCOMMITTED changes in the project's main checkout.
- `"$TERMIC_CLI" path <task>` - print the task's worktree path.

## Scratchpads: Notes for the User to Read

A scratchpad is a tab in a task that holds text outside the worktree: nothing in it reaches git, and the user sees it update as you write. Use one for findings, a plan, logs, or a running report meant to be READ, not committed: never drop throwaway `.md` files into the repo. Every `scratchpad` verb targets your own task unless you pass `--task`.

- `"$TERMIC_CLI" scratchpad new --title "<title>" -c "<text>"` - create one and print its id. `-c -` reads stdin.
- `"$TERMIC_CLI" scratchpad write <id> --append -c "<text>"` - add to it; without `--append` the text replaces it.
- `"$TERMIC_CLI" scratchpad read <id>` - print it, including the user's edits.
- `"$TERMIC_CLI" scratchpad list` - every pad in the task, with ids.
- `"$TERMIC_CLI" scratchpad rm <id>` - delete one pad for good.

## Recurring Task Schedules

Termic supports recurring schedules on tasks: recurring runs cut child tasks at specified cadences (daily, weekdays, weekly, or once on a date), run the configured prompt, and generate markdown reports under `.termic/reports/`.

- `"$TERMIC_CLI" schedule list --json` - list recurring schedules.
- `"$TERMIC_CLI" schedule show <task> --json` - detailed schedule configuration.
- `"$TERMIC_CLI" schedule set <task> --cadence daily --time 09:00 -p "<prompt>" --yes` - configure or update a schedule. A one-off: `--cadence once --date YYYY-MM-DD --time HH:MM` runs a single time, never again.
- `"$TERMIC_CLI" schedule run <task>` - trigger an immediate run.
- `"$TERMIC_CLI" schedule delete <task> --yes` - delete a schedule.

## Another Machine

Termic on two computers of one network can be paired. `"$TERMIC_CLI" peer list` names this machine and paired ones. The global `--peer <machine>` runs any verb THERE instead of here:

    "$TERMIC_CLI" --peer laptop new fix-x --yolo -p "[message from agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID} peer:studio] <work>. When done, reply: \"\$TERMIC_CLI\" --peer studio send $TERMIC_TASK_ID ${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }-p '[message from agent:<its agent> task:fix-x id:<its id> peer:laptop] done: <what you did> -- ...' -- agent:claude task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID} peer:studio"

## Other Verbs

- `"$TERMIC_CLI" list --json` - all tasks with live work state.
- `"$TERMIC_CLI" wait <task> --timeout 10m` - block until an existing task's agent is quiescent.
- `"$TERMIC_CLI" status <task> --json` - one task in depth.
- `"$TERMIC_CLI" prompts --json` - the user's prompt library.
- `"$TERMIC_CLI" agents --json` - the agent ids `--agent` accepts.
- `"$TERMIC_CLI" rename "<new name>"` - retitle YOUR OWN task.
- `"$TERMIC_CLI" archive <task> --yes` - kill the task's agents and remove its worktree.
- `"$TERMIC_CLI" project add <path>` - register a repo.

DO NOT run `"$TERMIC_CLI" quit`. It exists for the human at the keyboard, not for you. It kills EVERY agent in EVERY task.
Never edit Termic's internal settings, registry, or task data files directly;
use the control interface. User-authored files under the profile's
`customizations/` folder are the intentional exception, described above.
