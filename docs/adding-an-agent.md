# Adding a built-in agent

A checklist, written after adding pi, opencode, codex hooks and Muse Code, because
every one of those shipped with something missed that only turned up in use. The
order matters: the measuring comes first, and half the entries below exist
because a default was written from a CLI's `--help` and was wrong.

Three rules run through all of it.

**Keep it unified.** A new agent fits the shared paths (one wire body per
signal, the shared status-line script, the `SOURCES` table, the install
schemas) or goes without the feature. A bespoke mechanism for one agent (its
own Tauri command, a parser for its private files, a one-agent schema) is a
cost every later change pays; say what it adds and offer leaving the feature
out before building it. muse's context was left out on exactly that ground.

**Measure, never infer.** `--help` describes intent; the binary decides. Every
default here has been wrong at least once for an agent whose help text said
otherwise. Where a claim can be checked with a live binary, check it, and put
what you saw in the comment: the version, and what the run actually printed.

**Prefer a failure that is loud.** An agent that refuses to start gets fixed the
day it ships. An agent that starts and silently stops reporting gets found weeks
later, by a user, from a symptom three layers away.

## 0. Install it, and find its offline mode first

Before anything else, find out whether the agent can run WITHOUT an account.
It decides how much of the rest you can verify at zero cost, and it is usually
undocumented:

- muse: `--provider echo`, a real offline provider. Everything in this document
  except its attention state was measured with it.
- codex: no offline provider, but `codex app-server` answers protocol requests
  (`hooks/list`) without a turn, and a bad `model_provider` fails after the
  session has started, which is enough to observe startup behaviour.

Where there is no offline mode, budget real turns and say so before spending
them: a maintainer on the cheapest plan has very few.

**A probe can change the user's install.** The first `agy -p` of an
investigation self-updated agy (1.1.28 to 1.2.6), and 1.2.6 rewrites its
`settings.json` on every launch, dropping keys it does not know. Back up any
config a probe could touch, restore it byte for byte, and tell the user when
the agent itself changed something; restoring the file does not stop the
agent doing it again.

## 1. The registry entry (`default_agents()` in `lib.rs`)

`id`, `display_name`, `command`, `icon_id`, `color`, and:

- **`yolo_args`** — measured, not assumed. Empty is a legitimate ANSWER (pi asks
  for no approval at all), so write the comment that says it was checked rather
  than leaving a reader unsure whether it was skipped.
- **`resume_args`** — the cwd-based resume. Right for a worktree; see §2.
- **`session_id_args` / `resume_id_args`** — see §2. Getting this wrong is
  invisible until two tasks share a conversation.
- **`resume_picker_args`** — the args that open the agent's OWN session
  picker (claude: `--resume` with no id). Opened when a stored id fails to
  resume, instead of a fresh session (GH #311). Measure three things before
  filling it: the picker actually opens with termic's `name_args` after it,
  picking a session makes the agent REPORT the id (a hook, §5, so the next
  relaunch resumes it), and leaving the picker exits (termic then starts a
  fresh session once). Empty is the honest default until measured.
- **`sandbox_allowed_paths`** — see §4. These grant **`file-write*`**.
- **`signals`** — leave empty unless you have CAPTURED titles (§3).

Also: `agent_dirs::login_store` (§1b, and a test FAILS until you add it),
`agent_dirs::state_dirs`, `docker::KNOWN_SAFE_AGENTS` and
`docker::base_agent_id_str`'s `BUILTINS`, the TS `BUILTIN_FALLBACK` in
`lib/agents.ts` (the two tables MUST agree; the TS one runs before the registry
loads), `CliIcon`'s `case`, `CLI_BRAND_COLOR`, `CLI_LABEL`, `index.css` brand
vars for both themes, and a line in `Dockerfile.default`.

An existing install picks the new agent up through `load_settings_inner`'s
merge, so no migration is needed. It also means every user gets the row.

## 1b. Where its LOGIN lives, and how to find out (GH #278)

`agent_dirs::login_store` is what lets an agent hold more than one credential
set. **`every_builtin_agent_has_a_measured_login_store` fails until you add a
row**, so this is not optional and cannot be deferred.

**Measure it. Do not guess.** Point the candidate variable at an empty
directory and run the agent's cheapest read-only auth command. If it reports
itself signed out, the login follows that variable:

```sh
CANDIDATE_VAR=$(mktemp -d) <agent> <auth-status-command>
```

Then pick the shape that MATCHES WHAT YOU SAW, not the one that looks closest:

| Shape | You saw | Example |
|---|---|---|
| `ConfigDir` | the var IS the config dir, and nothing else lives there | claude, codex |
| `SelfHostingDir` | the login follows it, but the agent's own BINARY or bundled assets are in that tree too | grok |
| `ParentDir` | the agent APPENDED a name to what you set (`$VAR/.gemini`) | agy / gemini |
| `XdgRoot` | only a generic XDG variable moved it, and other tools read that variable too | opencode |
| `HomeOnly` | no dedicated variable exists; only `HOME` moved it | pi |
| `TokenVar` | a token variable outranks whatever is stored, so no directory is involved | no agent today; kept because it is the shape such an agent would take |

`None` is a legitimate answer, and it has TWO meanings that the guard forces
you to tell apart:

- **`None` with no reason** is "nobody measured this". The agent gets no
  override rather than a partial one, and the UI says "one login".
- **`None` with a `login_unsupported_reason`** is "we measured, and the answer
  is that it cannot be isolated". The UI shows that reason instead of an "add
  account" control.

**A config directory is not always where the credential is, and this is the
trap.** Several CLIs keep the token in the OS keyring and only the settings in
the config directory. Whether moving the directory isolates the login then
depends on how the keyring item is keyed:

| Keyring item keyed by | Moving the config dir | Agents |
|---|---|---|
| a hash of the store path | isolates | claude, codex |
| a FIXED service name | does **not** isolate | copilot, gemini |

A fixed service name is dangerous precisely because the measurement above
LOOKS like it passed: the agent picks up the new empty directory, finds no
settings, and says "please sign in". Sign in, and the token lands back in the
one shared slot. So the measurement is necessary and not sufficient: if the
agent uses a keyring at all, find out what names the item before believing a
signed-out message. gemini is the middle case, isolating only with
`GEMINI_FORCE_FILE_STORAGE=true`, which is why `login_companion_env` exists and
why the probe tests it WITH that flag. A measurement taken under different
conditions than the spawn is not a measurement of the spawn.

The two shapes people get wrong:

- **`ParentDir` typed as `ConfigDir`** puts the login one level too deep,
  silently. If the agent created `<your tmpdir>/.something/`, it is a parent.
- **`SelfHostingDir` typed as `ConfigDir`** hands Docker a directory it will
  mount an empty volume over, shadowing the agent's own binary so it vanishes
  inside the container. `docker_only_ever_sees_the_shape_it_can_actually_honour`
  fails if you do this, and grok is the worked example.

If the agent reports plan usage, see `reports_usage` in 1c: that is a separate
table, and it is what decides whether the AUTOMATIC switch is offered.

Finally, **add a row to `scripts/login-probe.mjs`** with the variable and a
read-only command that reveals whether the agent is signed in.
`the_probe_covers_every_agent_with_a_measured_login_store` fails until you do.
That probe is the only thing that catches the agent CHANGING later: unit tests
prove the table is self-consistent, never that it is still true.

## 1c. Every per-agent table, and how each one tells you it is wrong

Adding a built-in used to fail **zero** tests. Measured, not assumed: a fake
agent was added to `default_agents()` and the whole suite passed, so an agent
could ship registered in none of the tables below and nothing said so.

`a_new_builtin_agent_is_registered_in_every_table_that_needs_it`
(`agent_dirs.rs`) now derives the agent list from `default_agents()` and checks
the three that fail SILENTLY. The others fail loudly on their own. This is the
map, for whoever is debugging one:

| Table | Where | If it is missing |
|---|---|---|
| `default_agents()` | `lib.rs` | the agent does not exist |
| `login_store` | `agent_dirs.rs` | **guarded.** No account switching, and a wrong SHAPE relocates the login somewhere the agent does not read |
| `state_dirs` | `agent_dirs.rs` | **guarded.** Seatbelt will not allow its config dir and Docker will not mount it, so it loses its login every run |
| `BASE_BUILTINS` | `docker.rs` | **guarded.** A CLONE silently resolves to claude's config shape |
| `KNOWN_SAFE_AGENTS` | `docker.rs` | no Docker config mount; the opt-in toggle is the fallback, so this is a degraded mode rather than a break |
| `BUILTIN_FALLBACK` | `lib/agents.ts` | the agent cannot spawn before the registry loads. `agents.test.ts` pins it against the Rust table |
| `hooks_for` / `state_dir` | `agent_hooks.rs` | no work-state signals; the agent looks permanently idle |
| `CliIcon` / `CLI_BRAND_COLOR` / `CLI_LABEL` | `icons/cli.tsx` | a blank icon and an unstyled name, visible immediately |
| `scripts/login-probe.mjs` | | **guarded.** The login table can rot with no way to notice |
| `reports_usage` | `agent_dirs.rs` | no automatic account switch. Default `false`, and leaving it there is the CORRECT answer for a new agent: turn it on only once a transport actually produces numbers AND the agent has a login store |
| `SOURCES` | `lib/agentContext.ts` | no "Usage unknown" state and no "Install hooks" offer in the footer, so an agent that CAN report shows an empty footer with nothing saying why. See section 5b |
| `config_slot` | `agent_hooks.rs` | an agent whose status line (or muse's managed-hooks pointer) lives outside its hooks file never gets it written, so the hooks install and nothing reports |
| `askUsage` | `components/task/AgentChip.tsx` | a pull-usage agent's command exists and is never called |
| `shortWindowWords` | `lib/agentUsage.ts` | a quota that is not five hours (devin daily, copilot monthly) is labelled `5h` |

Three of those are guarded because they are the ones that go wrong QUIETLY: a
missing icon is obvious the first time you look, a missing `state_dirs` row is
not obvious until someone's login disappears a week later.

`reports_usage` is the one table where the safe default is to say NOTHING. It
gates a control that acts on the user's behalf (the automatic account switch),
so it is pinned by NAME rather than by count
(`only_the_two_agents_with_a_measured_transport_report_usage`): adding an agent
to it has to be a deliberate edit backed by a working transport, not something
a refactor can do quietly. A second guard pins that anything reporting usage
can also hold a second account, since otherwise the switch would have nowhere
to go.

### Debugging "this agent behaves oddly"

Work down, cheapest first:

1. `cargo test --workspace --lib` — the guards above name the missing table.
2. `make login-probe <agent>` — is the login table still TRUE of the installed
   CLI, or did the agent change under us?
3. `docs/sandbox.md`'s deny-debugging section — is it a cage problem rather
   than a registry one?
4. Only then read the agent's own output.

## 2. Resume: three shapes, and how to tell which one you have

The question is only interesting for a REPO-ROOT task, because several of those
share one cwd, so "resume the last session here" is another task's conversation.

1. **Mint** (claude, grok, pi). Termic can hand the agent a uuid at launch, so
   it owns the session. Both `session_id_args` and `resume_id_args`.
2. **Capture** (opencode, codex, muse). The agent will resume an id but will not
   accept one at launch. `resume_id_args` only, plus a way to learn the id after
   the fact: `post_launch_capture` (a shell command, opencode and muse) or the
   agent's own hook reporting it (codex, which is better, see §5).
3. **Neither**. `resume_args` only; repo-root tasks start fresh. agy used to
   be here, until its hook proved it could report `conversationId`: it is now
   a capture agent (`--conversation {UUID}`), learned the codex way.

**When a stored id stops resolving** (the transcript was deleted, the id was
never written, or claude holds it as a background session), the resume exits
within `RESUME_FAILURE_MS`. With `resume_picker_args` the next spawn opens the
agent's picker and the toast carries the agent's own reason, read from the raw
output of that first window (`lib/resumeTail.ts`: xterm's buffer can lag the
exit, Rust drains every byte before emitting it). Without one, a fresh session,
as before. There used to be a "Resume it" banner here; it outlived the failure
and came back on every relaunch, which is why this is a toast and the agent's
own picker rather than anything termic keeps on screen.

Measured on claude 2.1.278: `--resume --name <task>` opens the picker; picking
fires `SessionStart` with `source: resume`, the chosen id and entrypoint `cli`,
which the READY hook reports; Esc exits 1 with no `SessionStart`.

Three guards keep the picker from swapping two tasks. The picker lists every
session in the cwd, and every main-checkout task shares one, so its top row is
whichever SIBLING task ran last; one reflexive Enter took it (reproduced on
2.1.280). Stored, the sibling's own resume was then refused ("running in
another terminal", exit 1), which cleared its id and opened its picker in turn.

- **A fast exit counts as a failed resume only when it is non-zero.** Every
  refusal measured exits 1 (claude's "No conversation found" and "running in
  another terminal", `--continue` with nothing to continue, codex's "active
  writer"). Ctrl+C right after a relaunch exits 0, and used to open the picker.
- **A reported id another tab already holds is not stored** (`sessionHolder` in
  `lib/agentHooks.ts`, live tabs and `persisted_tabs` both); a toast names the
  task that owns it.
- **The picker spawn carries no `name_args`.** claude applies `--name` to the
  session PICKED, so a wrong pick renamed the sibling's conversation to this
  task. A right pick gets the name back on the next relaunch, which resumes it
  by id with `--name`.

**The id is not always a UUID.** devin's is a slug (`brassy-polish`). The TS
parser (`hookOscSessionId`) and the hook's charset guard both have to accept
the agent's real shape, or the report is dropped, and a dropped trusted body
used to fall through to a notification ("session brassy-polish").

**Check the agent accepts its OTHER flags on a resume.** copilot refuses
`--name` on any resume, with `--session-id <existing>` and with `--continue`,
and exits 1 before drawing, which termic reads as "resume failed" and answers
with a fresh session every time. It is in `NAME_ONLY_ON_NEW_SESSION`
(`lib/agents.ts`). Run a real create-then-resume with the full argv termic
composes, not the resume flag alone.

**Test for the mint shape properly**, because two agents looked like it and were
not:

```sh
<agent> resume 11111111-1111-4111-8111-111111111111   # a uuid that does not exist
```

pi CREATES it (so one flag serves both mint and resume). codex answers
"no rollout found for thread id" and muse's TUI rejects `--session-id` outright
as an `exec`-only flag. Then prove resume actually carries HISTORY, not just
that it exits 0: ask the agent to remember a word, resume, ask for the word.

## 3. Work-state signals

Capture real titles before writing a pattern. `script` will not do: an agent TUI
that queries the terminal (DSR/CPR) hangs against it. Use tmux, which answers,
and read `#{pane_title}`; use `tmux pipe-pane` for the raw byte stream when you
need to know which OSC ids it emits.

Leave `attention` EMPTY unless you have captured the blocked state. A pattern
written from reasoning is what c35d297 had to remove from two agents.

**Check whether the agent puts prose on `OSC 9`.** Codex sends its ENTIRE final
message there at the end of every turn, and termic reads `OSC 9` as "the agent
wants you", so every completion became a needs-you bell. If it does that, it
belongs in `NOTIFY_NEVER_ATTENTION` — and confirm the negative too, by driving it
to a real permission prompt and checking no `OSC 9` appears.

## 4. The sandbox, which is where the loud failures live

`Agent.sandbox_allowed_paths` grants **read AND write** on a `subpath`. Two
consequences, both learned the hard way:

- **Never list a SHARED directory.** Muse's entry had `~/.local/bin`, which is
  where claude, codex, agy and grok also keep a binary or shim: a sandboxed muse
  could have overwritten any of them. Use a `regex:` scoped to the agent's own
  files instead (claude's sidecar regex is the precedent).
- **Never list another agent's config.** Some agents read their neighbours'
  personal rules; that is theirs to do uncaged, not termic's to grant.

**List every state dir, including the macOS-native one.** Agents commonly use
`~/.config/<a>` AND `~/Library/Application Support/<A>`. Muse shipped without the
second and failed to start under ENFORCING, because the missing access was a
WRITE (`session-name-authority/session-names.db`).

### Debugging a cage failure

```sh
DUMP_AGENT=<id> DUMP_PATH=<a worktree> DUMP_OUT=/tmp/a.sb \
  cargo test --lib profile_dump -- --ignored --nocapture
cd <the worktree> && sandbox-exec -f /tmp/a.sb <agent> ...
```

with, in another shell:

```sh
log stream --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny"' --style compact
```

Three things that will waste your time otherwise. The system log **dedupes**
violations, so each run usually reveals ONE new path and you iterate. Bisect from
the working side (`(allow file-read*)` appended, then narrow) rather than adding
denied paths one at a time. And a path may only work as a broad `subpath` even
when every child is listed individually, because of macOS firmlinks
(`/Library` is really `/System/Volumes/Data/Library`) — that is what `/Library`
being a read root exists for.

Check the Sandbox dialog's monitoring mode too. It found muse's missing
`Application Support` dir immediately, listed with its access counts, which is
faster than any of the above.

## 5. Hooks (optional, and check the transport FIRST)

Hooks are only worth wiring where the terminal gets a state WRONG or cannot
express it. Before designing anything, check the two things that make it
possible at all:

- **Does the agent pass `$TERMIC_PTY` and `$TERMIC_TASK_ID` through to a hook
  command?** Muse does not, for ORDINARY hooks. It strips them (`HOME`
  survives, custom vars do not), and `shell_environment_policy` does not change
  it, so every generated script would exit 0 having written nothing. That kept
  muse off the list until 1.3.0, whose MANAGED hooks
  (`managed_hooks_path` + `managed_hooks_env_vars`) forward the variables they
  name. Look for a side door like that before giving up, and verify it the way
  muse's was: a hook that dumps `env` to a file, with the setting on and off.
- **Does the readiness event fire at STARTUP?** Muse's `SessionStart` fires on
  the first PROMPT, despite its payload saying `source: "startup"`, so it cannot
  gate readiness.

Then the shape: `hooks_for`, `schema_for`, `settings_rel`, `SUPPORTED`, and
whether the agent needs a required field in a config termic creates from
scratch (muse rejects a `settings.json` with no `schema_version`). There are
four schemas, pick by how the agent loads hooks, not by what looks similar:

| schema | agents | what termic writes |
|---|---|---|
| `ClaudeCompatible` | claude, codex, devin, grok, muse | a `hooks.<Event>[] = {hooks:[…]}` map merged into the agent's config (grok and muse into a file of termic's own) |
| `AntigravityNamed` | agy | one named key in `config/hooks.json` |
| `PluginFile` | opencode, pi, omp | one in-process module in a directory the agent autoloads; install is a write, removal a delete. Extra files beside it (opencode 2's TUI plugin directory) come from `plugin_companions` and share that lifecycle |
| `CopilotFile` | copilot | the agent's NATIVE hook file, whole, in a directory it loads every `*.json` from |

A plugin file is written whole on every install, and must never pass through
the JSON config guard (docs/gotchas.md "A guard that parses the wrong format
blocks every UPGRADE"): test an UPGRADE over an old version, not only a fresh
install.

An in-process plugin (opencode, pi) is the easiest transport there is when it
exists: it sees the agent's own env, needs no script per event, and can read
state a hook payload never carries (pi's `ctx.getContextUsage()`, opencode's
message tokens). Wrap every handler, since a throw lands in the agent.
First check WHICH process "in-process" means: opencode 2 runs server plugins
in a shared background service whose env is not the task's, so its reporting
had to move to the TUI (docs/gotchas.md "An agent's plugin process may not be
the process termic spawned").

**Look at what the agent says on its OWN, with hooks installed.** Three
agents rang the wrong bell with a correct install (docs/agent-hooks.md "An
agent's own notifications"):

- its own end-of-turn notification (grok, devin, muse each send one) belongs
  in `BUILTIN_NOTIFY_IGNORE`, anchored;
- a hook event that is really several (grok's `Notification`:
  `permission_prompt` vs `idle_prompt`) has to be filtered by its type field;
- raw OSC 133 from the agent is ignored once termic's hooks own it, so the
  hooks must never signal with 133 themselves (they send `agent working` /
  `agent done`).

Then relaunch termic with a task of the new agent open and send nothing: no
bell, no badge, no spinner left running. A restored session that reports a
done must not announce it.

**An agent reads its hooks at launch.** grok, claude and the others pick up an
install on the next spawn, not in the running tab; the footer says "restart
this tab" for that reason. Test an install with a fresh spawn.

**Filter out the agent's own subagents.** muse fires hooks for its internal
reminder subagents under their own `session_id`, and a subagent's `Stop` ends
the tab's turn early. If the agent has subagents, check what their hook
payloads look like before trusting a Done.

**There is no UI step.** Settings → Agents' hooks row is driven by `SUPPORTED`
crossed with what is on PATH, so adding the id there is what makes the agent
appear. It also puts the agent under "Install
hooks for every agent": a user with that switch on gets the new agent's hooks
installed on the next sync, without doing anything, so the install must be
safe to run unattended (no prompt, no failure that leaves a half-written
config). The corollary is the part that looks
like a bug and is not: an agent deliberately left out shows NOTHING in that
dropdown rather than a row explaining why. If you decide against hooks for an
agent, the reasoning goes in `docs/agent-hooks.md` — that is the only place
anyone will find it, and "why is muse missing from the hooks list" is a
question that has now been asked.

**Watch for a trust model.** Codex discovers hooks, reports them `enabled`, and
does not RUN them until a `trusted_hash` entry exists in its `config.toml` —
with no error, no log and no output in any failing state. If the agent has one,
ask the agent for the hash rather than computing it, or a patch release silently
turns every hook off.

Bump `SCHEMA_VERSION` whenever a script BODY changes, or existing installs keep
the old scripts forever. There is a test that fails if you forget.

## 5b. Footer readouts: plan usage and the context window

The task footer's agent chip shows two things per agent, and a new agent owes
both a measured answer: **where does its plan usage come from, and where does
its context window come from?** "Nowhere" is a valid answer, but it has to be
the result of looking, and it is written down in `SOURCES`
(`lib/agentContext.ts`), which is the one table the chip reads to decide
whether to show "Usage unknown" and whether to offer "Install hooks".

Look in this order, because each one is cheaper to build on than the next:

1. **A status line command.** claude, agy, copilot and grok each pipe a JSON
   payload to a configured command on every repaint or turn. Check: does it
   carry `context_window` (and which fields), a quota or `rate_limits`, and does
   the command inherit the env (`TERMIC_PTY`)? Does it render the command's
   stdout (it must stay empty)? Does it run under `-p` (claude's does not, so a
   print-mode probe measures nothing)? If yes, the shared
   `STATUSLINE_TEMPLATE` (`agent_hooks.rs`) covers it: add the agent's field
   names to the fallback lists in its context parse, and a `config_slot` entry
   for where the slot lives. Claim it only when free.
2. **A hook payload.** Look for token counts, or a `transcript_path` whose
   file has them (codex's rollout `token_count`). Read it in the Done hook and
   send `ctx` in the SAME write as done.
3. **An in-process plugin** (opencode, pi): read the agent's own numbers.
4. **Something on disk, read at turn end** (devin's `sessions.db`): a small
   Tauri command, called from TerminalPane on the hook's done. Last resort,
   because the format is the agent's internal business and will move.
5. **Usage from the agent itself, cold** (codex's app-server RPC, devin's API,
   copilot's own quota cache): an `agent_usage_*` command and an `askUsage`
   arm. Never an OAuth refresh or a keychain read termic does not own
   (`docs/ideas/usage-footer.md` has the full reasoning).

Whatever the transport, the context goes out as ONE body, `ctx <used tokens>
<window tokens> [<used percent>]`, on the trusted OSC 777 channel. Send the
percent only when the agent's own formula is not tokens/window (codex reserves
a 12000-token baseline), and send nothing rather than a zero when the window is
not known yet. Usage goes on the existing `usage` body or a pull command.

Then:

- a `SOURCES` row: `"hooks"` if it only arrives once termic's hooks are in,
  `"pull"` if termic asks for it, `null` if there is none. A wrong `"pull"`
  tells the user to wait for a poll that does not exist when the fix is
  installing hooks.
- `reports_usage` only if the usage is real AND the agent has a login store
  (see 1c).
- `shortWindowWords` if the short window is not five hours.
- the measured fields in docs/agent-hooks.md "The context window, per agent".

The Settings > Agents card shows a "Show plan usage" and "Show context window"
switch for every agent; the hints come from `SOURCES` too, so there is nothing
else to wire.

## 6. Tests and docs

- Rust: the seeded-default test (assert the flags AND the reasoning, including
  what is deliberately EMPTY).
- TS: `agents.test.ts` for spawn-arg composition; keep `BUILTIN_FALLBACK` in
  step with the Rust table.
- Footer readouts: a `statusline_run_as("<agent>", …)` test with the agent's
  measured payload SHAPE (placeholders, never pasted output), or the
  equivalent run of its hook or plugin (`codex_done_reports_…`,
  `the_opencode_plugin_reports_…` run the real script / module), and a
  `footerSources` expectation in `agentContext.test.ts`.
- **Grep the whole test suite for agents used as EXAMPLES.** Giving codex
  `resume_id_args` broke `cli.e2e.ts`, which used codex as its example of an
  agent that cannot resume by id, and it was caught by CI on main rather than
  locally. Run the FULL `make e2e`, not the two specs you touched.
- `make login-probe` must pass for your agent, and `make login-probe <agent>`
  runs just yours. It is local-only: it needs the CLI installed and really
  logged in, which no runner has.
- Docs: `docs/agent-accounts.md` if the login shape was interesting,
  `docs/sandbox.md` (vendor hosts, the Docker agent list),
  `docs/agent-hooks.md` if hooks were considered — including if they were
  REJECTED, with the measurement, so nobody repeats the investigation.
- README's built-in list.
- Do NOT touch `CHANGELOG.md`; that is the maintainer's.

## 7. Before saying it works

The suites do not catch what this feature class gets wrong. Run the agent by
hand in a worktree AND in a repo-root task, with the sandbox both off and
enforcing, and check: it starts, the spinner tracks a real turn, a completed
turn produces ONE notification, resume brings the conversation back, and the
Docker image still builds.
