# CLI and MCP control surface

Use this reference for tool discovery, task/project routing, tab control,
and CLI-to-MCP translation. It describes Termic's control interface, not
the external MCP servers declared in profile customizations.

## Discover arguments from the running version

Run `"$TERMIC_CLI" help --json` for the installed CLI's commands, flags,
arguments, exit codes, and global options. MCP clients use `tools/list`
for each tool's `inputSchema` and annotations, plus the server's discovery
instructions for coordination rules. A tool schema is an argument contract;
it does not explain how to author skills or MCP configuration files.

The map below covers the current MCP registry. The running version's
discovery result is authoritative; do not invent a missing tool or flag.

| CLI verb | MCP tool | Purpose |
| --- | --- | --- |
| `list` | `task_list` | Tasks and work states |
| `status` | `task_status` | Task details, path, and tabs |
| `new` | `task_new` | Create a task, with any multi-repo members, and optionally start an agent |
| `review` | `task_review` | Create a PR review task |
| `send` | `task_send` | Prompt or resume an agent |
| `wait` | `task_wait` | Wait for a settled turn |
| `result` | `task_result` | Read the agent's last message |
| `logs` | `task_log` | Read terminal output |
| `diff` | `task_diff` | Inspect changes against the base |
| `open` | `task_open` | Select and raise a task |
| `rename` | `task_rename` | Retitle a task |
| `group` | `task_group` | Name, color, join, or leave a group |
| `apply` | `task_apply` | Apply changes to the project's main checkout |
| `archive` | `task_archive` | Archive a task and remove its worktree |
| `tab` | `task_tab` | Open or rename a tab |
| `tab close` | `task_tab_close` | Close a tab and kill its process |
| `prop` | `task_prop` | Read or set sidebar tab properties |
| `agents` | `task_agents` | Discover registry agent IDs |
| `prompts`, `prompts show` | `prompts` | List or select library prompts |
| `scratchpad new` | `scratchpad_new` | Create a note outside git |
| `scratchpad write` | `scratchpad_write` | Replace or append note text |
| `scratchpad read` | `scratchpad_read` | Read a note |
| `scratchpad list` | `scratchpad_list` | List notes |
| `scratchpad rm` | `scratchpad_remove` | Delete a note |
| `scratchpad clear` | `scratchpad_clear` | Delete all notes in a target scope |
| `project list` | `project_list` | List registered projects, their type, and multi-repo members |
| `project add` | `project_add` | Register a repository or plain folder |
| `project remove` | `project_remove` | Unregister a project and delete its tasks |
| `schedule list` | `schedule_list` | List recurring schedules |
| `schedule show` | `schedule_show` | Inspect one schedule |
| `schedule set` | `schedule_set` | Create or update a schedule |
| `schedule run` | `schedule_run` | Trigger a scheduled run now |
| `schedule delete` | `schedule_delete` | Remove a schedule |
| `peer list` | `peer_list` | List paired machines |
| `peer pair` | `peer_pair` | Pair a machine |
| `peer unpair` | `peer_unpair` | Remove a pairing |
| `peer rename` | `peer_rename` | Rename a paired machine |
| Global `--peer` | `peer_call` | Run another operation on a paired machine |

CLI-only exceptions: `attach` is an interactive TTY stream; `path` is a
shell convenience (MCP gets the path from `task_status`); `help` is CLI
discovery. `hello`, `raise`, and `open-url` are liveness/OS handoff helpers.
`quit` shuts down every agent and is reserved for the human, as the main
skill states. These exceptions do not represent missing MCP task features.

Mutating tools still need authorization from the user's task. Tool
annotations and CLI `--yes` confirmations do not grant a broader scope.
Especially, applying changes, deleting notes, archiving tasks, removing
projects, and changing schedules have effects beyond reading status.

## Tasks, subtasks, and projects

A Termic task owns a worktree or main checkout and can contain several
agent tabs. A delegated subtask is another task linked to its creator,
not a separate `subtask_new` command. Tasks created by an agent in the same
project join its group by default; descendants join that same group rather
than a nested tree. `--no-group` / `noGroup` opts out. MCP `parentTask` can
explicitly choose the grouping parent.

Choose the project and checkout mode explicitly when they matter:

```sh
"$TERMIC_CLI" new api-fix --project api --worktree --agent codex \
  --model MODEL_ID -p "<signed assignment and report-back instruction>"
```

The equivalent MCP `task_new` arguments are:

```json
{
  "name": "api-fix",
  "project": "api",
  "mode": "worktree",
  "agent": "codex",
  "model": "MODEL_ID",
  "prompt": "<signed assignment and report-back instruction>"
}
```

Replace the illustrative names/model and follow the main skill's signed
report-back protocol. Without a checkout mode, the app's last-used mode
can select the main checkout. Unattended work needs an appropriate
permission/sandbox choice, as explained in the main skill.

For work spanning projects, launch a task in each project using `--project`
or MCP `project`, retain the returned IDs, and coordinate using `send` /
`task_send`. A task created in another project is linked by `spawned_by`,
but does not join a group in the first project's sidebar list.

That is distinct from one composed, multi-repository task, which lives in
a multi-repo project. `project list` / `project_list` shows which projects
are multi-repo and names their members. Pass each member the task needs as
`--member <name>`, repeated (MCP `task_new` `members`): each named member
gets a worktree on the task branch, and without it no member gets one. An
unknown name, or a project that is not multi-repo, fails and lists the
valid names.

CLI global `--profile <name-or-slug>` explicitly routes commands to a
profile. Otherwise the named project's profile is used, falling back to
the most recently focused window when no project determines it. MCP uses
the server/client context and the parameters actually advertised by
`tools/list`; do not assume a CLI global has a same-named tool parameter.
Prefer task IDs and explicit projects over ambiguous task names.

## Tabs and model overrides

Another tab shares the task's working directory; another worktree task
isolates filesystem changes. Choose based on whether workers may safely
edit the same files, rather than treating tabs as isolated worktrees.

```sh
"$TERMIC_CLI" tab TASK_ID --agent codex --title review --model MODEL_ID \
  -p "<signed review assignment and report-back instruction>"
"$TERMIC_CLI" tab TASK_ID --tab review --title api-review
"$TERMIC_CLI" send TASK_ID --tab api-review -p "<signed follow-up>"
"$TERMIC_CLI" logs TASK_ID --tab api-review --json
"$TERMIC_CLI" tab close TASK_ID --tab api-review
```

MCP `task_tab` opens an agent with `kind: "agent"` and `agentId`; use
`model` and `args` for per-tab overrides. It also supports `kind: "shell"`,
`"terminal"` (with a terminal registry `agentId`), and `"default"`.
For renaming, pass `task`, `tab`, and `title` without opening parameters.
Keep the returned tab ID for stable targeting. `send`, `wait`, `logs`,
and their MCP equivalents accept a tab selector: an exact ID (which reaches
both top-bar strip tabs AND agent tabs inside split panes), a strip title,
or a 1-based strip index. IDs survive reorder; indices do not. `tab close`
and `tab` rename apply only to top-bar strip tabs. When Termic runs the MCP headers helper inside an agent tab,
`X-Termic-Tab` (`$TERMIC_TAB_ID`) defaults `parentTab` on `task_new` /
`task_review` (when grouping under your own task, and explicit `parentTask` /
`parentTab` are also accepted on both) and `tab` on `task_prop` writes to
your own task, and unqualified replies from a spawned child route back to
that initiating tab while it is live. On macOS/Linux upgrades from earlier
Termic builds, re-register Claude Code / Codex in Settings > MCP (and
restart running agent sessions) so the helper sends `X-Termic-Tab`.

An explicit `--model` / `model` is appended after extra arguments; it is
launch configuration, not proof of the provider's active model. A fresh
tab starts a new conversation unless a specific `--resume` / `resume`
session is requested. Closing the default tab requires CLI `--yes` or
MCP `allowDefault: true`, since unqualified messages otherwise target it.

## Results and bounded waits

Prefer signed asynchronous report-back messages over blocking an agent.
MCP waits are capped at five minutes per call; timing out does not cancel
the task. CLI and MCP timeout units differ (`--timeout` duration versus
`timeoutMs`). A settled turn is not evidence that the work passed review.
Inspect results, diffs, or the requested report before using the output.
