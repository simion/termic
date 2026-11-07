# Agent accounts

Several credential sets per agent, and a one-click switch
([#278](https://github.com/simion/termic/issues/278)). Phase 2 of the work
whose phase 1 is [profiles.md](profiles.md); the two compose and neither
depends on the other.

## The one rule that keeps this small

**termic never handles a secret.** Adding an account creates an EMPTY store and
the agent's own login command writes its credential there, wherever it likes,
file or keychain. Removing an account drops the name; the agent's own `logout`
removes the login.

Nothing here reads, copies, seeds or writes a credential. That is what makes
the per-agent difference collapse to two facts (where to point it, what its
login command is called), and it is why there is no import, export or backup.

## An account switcher, not a config switcher

The only noun is a LOGIN. Config-dir relocation is the private mechanism that
realises one and must not surface as a concept.

The mechanism is genuinely general, so this is easy to lose: every agent is
isolated by pointing an env var at a directory, and "per-agent environment
overlays" is one short step away. That would be a bigger surface, a worse
explanation, and it invites states nobody designed. termic already has the
general thing for people who want it, in agent CLONES with their own `env` map.

## Where a login lives

```
<data>/logins/<agent>/<name>/            host
<data>/docker-agents/<agent>/<name>/     docker
```

**Keyed by NAME, and the sharing falls out of that.** Two profiles both using
an account called "Work" resolve to the same directory, so the second is
already signed in. Nothing selects, syncs or copies; they address the same
path. The name is slugified because it becomes a path segment.

**The name is frozen.** For claude the store path is hashed into the Keychain
service name (`Claude Code-credentials-<sha256(dir)[..8]>`), so renaming would
move the directory, change the hash, and silently log that account out of a
credential that is still perfectly valid. Remove and add instead, which is
honest about costing one sign-in. Same rule as a profile's slug, reached from a
different direction.

**Two realms means two sign-ins, and that is not a gap.** Docker never reads
the host's config dir (`docker-agents/` is termic-owned), so a login performed
on the host is invisible in a container. A user signs in once per realm, and
each realm then shares that login across every profile.

**A config directory is not always where the credential is.** This is the
trap that makes this table hard, and it is why two agents ship with no
switcher rather than a broken one. Several CLIs keep the TOKEN in the OS
keyring (Keychain, libsecret/kwallet) and only the SETTINGS in the config
directory. Whether relocating the directory isolates the login then depends
entirely on how the keyring item is keyed:

| Keyring item keyed by | Relocating the config dir | Agents |
|---|---|---|
| a hash of the store path | isolates | claude, codex |
| a FIXED service name | does **not** isolate | copilot, gemini |

A fixed service name is the dangerous case, because the surface looks right:
the agent picks up the new directory, finds no settings, and says "please sign
in" — so a probe, and a human, both conclude it worked. Sign in and the token
lands back in the same one shared slot, and both accounts are now the same
account. `login_unsupported_reason` exists for exactly this: copilot gets NO
override and says why, rather than an override that appears to work.

gemini is the middle case and the reason `login_companion_env` exists: it
isolates only with `GEMINI_FORCE_FILE_STORAGE=true`, which pushes it off the
keyring onto a file inside the relocated directory. termic always spawns it
with that flag, and the probe always tests it with that flag, because a
measurement taken under different conditions than the spawn is not a
measurement of the spawn.

**No account means the old paths, exactly.** Only a NAMED account adds a
segment, so an install that never uses the feature keeps byte-identical paths
and an existing Docker login is not orphaned by shipping this.

## The first account names what you already have

Naming your first credential set does not create one: you already had a login,
and this is the name you gave it. `Agent.adopted_account` records it, and that
account relocates NOTHING.

Without this, someone whose agent works fine is told they are "not signed in",
and switching to that account hands them an empty store. It is the same rule as
the first profile being the install that already exists rather than a new
directory, and it was caught by looking at a screenshot rather than by a test.

Removing the adopted name does not promote another account into it: those have
their own stores, and calling one of them "the login you already had" would be
a lie. The ordinary login simply goes back to being unnamed.

## Scoping

The account list and the default live on the AGENT ENTRY, so they are
profile-scoped for free (`settings.agents` already is) with no second
mechanism. A work profile can default to a work account while a personal one
does not.

The STORES are global, because a login is a machine fact. A profile does not
own logins; it owns which names it offers and which is default.

**Living on the agent entry means the Settings form SHIPS these fields**, and
that cost a second account once. `agentsSave` sends the whole registry array,
and `AgentsSection` holds it as a snapshot taken when the section mounted: the
load is a `useEffect(…, [])` that never re-runs and never listens for
`termic://agent-accounts-changed` (the child `AgentAccountsRow` listens, which
is why the row looked right while the parent array rotted). So adding a second
account and then editing any field in that section wrote the pre-add array back
and deleted `accounts`, `default_account`, `adopted_account` and
`auto_switch_account` together. It reads as a second account that signs in,
works, and is then simply absent from Settings with "+ Second account" offered
again, because that button renders only while `accounts` is empty.

`agents_save` now carries the four fields across from the stored entry, matched
by id. The rule: **these are written by the `account_*` commands and by nothing
else**, so the backend does not accept them from the form at all. Fixing it
there rather than in the form covers the welcome dialog, which saves an array it
built from CLI detection and has the same problem. This is the same loss the
"Reset to defaults" bug had, where a default entry was spread over fields
TypeScript did not know about; `carriedOver` in `AgentsSection.tsx` is that
earlier repair, and it is now belt and braces.

**`settings_save` had the same hole, and it is the wider one.** It receives the
WHOLE `Settings`, agent registry included, and General, Tasks, Sandbox and
Docker build that object as `{ ...settings, field }` from a snapshot taken when
the section mounted. So after the `agents_save` fix, an account added from the
footer panel or the Agents section was still deleted by the next save of an
unrelated field anywhere else in Settings: saving the browser in General emptied
a three-account list (`credentials.e2e.ts` reproduces it). The registry cannot
be ignored on that path, because Docker writes `docker_env` through it, so
`settings_save` applies the same by-id carry (`keep_disk_account_fields`).
Only the four account fields are protected; the rest of a stale agent entry is
still written back, which is the general snapshot problem those sections have.

## Resolution, and where it is applied

```
task.accounts[agent]   ->  the switch, written by task_set_account
agent.default_account  ->  what new tasks use
none                   ->  the agent's ordinary login
```

Resolved in `pty_spawn`, not in the frontend. Every spawn path lands there (the
UI, the CLI, MCP), so none of them can forget to thread an account through, and
a Docker spawn takes the Docker realm because its container reads a different
store.
`termic new --account <name>` / MCP `task_new {account}` write the same
per-task override before the first spawn, so an agent launching tasks can pick
the account too (the server refuses a name the agent does not have).

**A switch takes effect on the NEXT spawn.** A running process cannot have its
environment changed underneath it, so the pill says so rather than letting
someone wonder why the number did not move.

## Three surfaces

| Surface | Job | Covers |
|---|---|---|
| Row at the top of the agent's card | discover and manage | all eight agents |
| Usage popover, "Running low? Add a second set..." | discovery **at the moment of need** | claude, codex, devin, agy, omp |
| Footer pill, appears at 2+ | see which account, switch it | all eight |

The usage popover is the best vector and cannot be the only one: it renders
nothing until an account has reported usage, which today means claude, codex and
devin. The pill stays hidden below two accounts, because before a second set
exists there is no account concept to name (see profiles.md's strip, same
reasoning).

## Maintaining this as agents change

The per-agent knowledge is `agent_dirs::login_store`, a table of measurements
of other people's software. It goes stale silently: the switcher keeps
"working", the tests keep passing, and two accounts quietly share one login.

- `every_builtin_agent_has_a_measured_login_store` fails when an agent is added
  without a row. `None` stays legitimate: an unmeasured agent gets NO override
  rather than a partial one, because a half-applied override is worse than
  none.
- `docker_only_ever_sees_the_shape_it_can_actually_honour` pins that only the
  `ConfigDir` shape reaches Docker, which sets that variable to the container
  path it mounted.
- **`make login-probe`** (one agent: `make login-probe AGENT=claude`) is the
  one that catches real drift: it points each
  variable at an empty dir against the ACTUAL installed CLI and asserts it
  reports itself signed out. Local only, never CI, same rule as
  `make lsp-smoke`. It reads no credential, only whether the agent thinks it
  has one. A cross-file test fails when the table gains an agent the probe does
  not check.

  **It tells drift apart from a stale probe**, which matters because the two
  need opposite fixes and confusing them sends someone to re-measure a table
  that is correct. The discriminator is whether the variable changed the
  output AT ALL, not whether a pattern matched:

  | | Reported |
  |---|---|
  | identical output with and without the variable | **DRIFT** — the agent changed, the table is stale |
  | the variable changed the output, but the signed-out pattern did not match | **cannot tell** — the probe's own pattern is stale, the table is probably fine |

  Using the pattern as the discriminator was the first attempt and it was
  wrong: a pattern that can never match makes both runs look "signed in" and
  reported a correct table as drift. Caught by mutating the probe rather than
  by reasoning about it, which is the only way this kind of check earns trust.
  The control run is LAZY, on the failure path only, because several of these
  probes are real prompts and the passing case should not pay for them.

`a_new_builtin_agent_is_registered_in_every_table_that_needs_it` derives the
agent list from `default_agents()` rather than a hand-written one. That
mattered: the first version of this guard listed agents by hand, so a new
built-in was absent from the list AND from the table, and the guard stayed
silent. Verified by adding a fake agent and watching the suite pass, then fail.

Six shapes, each because an agent measured that way: `ConfigDir` (claude,
codex, omp: `PI_CONFIG_DIR` moves the whole `~/.omp` root and the credential
is a SQLite row in its `agent.db`, no keyring involved — the one caveat is
that omp's `PI_CODING_AGENT_DIR` outranks it when a user sets both, in which
case their override wins over a clone's relocation), `SelfHostingDir` (grok: the login follows the var but its binary lives
in that tree, so Docker can never mount it), `ParentDir` (gemini appends
`.gemini`), `XdgRoot` (opencode, devin: broader than the agent, which the UI
says out loud), `HomeOnly` (pi), `TokenVar` (no agent currently, kept because it is the
shape an agent that reads only a token variable would take).

opencode 2 may defeat `XdgRoot` (read from the 2.2.5 source, not measured):
its TUI is a client of one background service per machine, which registers
under `XDG_STATE_HOME` (not moved) and keeps the environment of whichever
client started it, so a second account's tab can land on the first
account's service. See docs/agent-hooks.md "opencode 2".

`None` is a THIRD answer, distinct from both a shape and an unmeasured agent,
and `login_unsupported_reason` is what makes it distinct: copilot and muse
return `None` WITH a reason, and the UI shows that reason instead of an "add
account" control. An agent nobody has looked at returns `None` with no reason.
The guard demands one or the other, so "we decided no" can never be confused
with "nobody checked".

## How this is tested

The layers, and what each can prove:

- **`lib.rs` unit tests** — resolution (task override beats agent default), the
  two realms being different stores, name-keyed sharing, the adopted account
  relocating nothing, and gemini's parent shape getting the store rather than
  the config dir.
- **`accountPill.test.ts` / `autoSwitch.test.ts`** — the pill's rules and the
  switch decision as pure functions, because this repo has no React testing
  library and these are the parts worth pinning. `autoSwitch` is weighted
  towards the cases where the right answer is to do NOTHING: a missed switch
  costs a restart, a wrong one spends the wrong subscription.
- **`agentUsage.test.ts`** — that two accounts of one agent never share a
  reading, and that the key cannot be made to collide whatever the two halves
  contain. Both were mutation-checked: reverting the key to the agent id alone
  fails five of them.
- **`credentials.e2e.ts`** — the real UI: naming the first set adopts, a name
  that would slugify onto an existing one is refused, the pill appears at two
  and switches on one click.
- **The end-to-end proof** — `fakeclaude` and `fakecodex` are fixture agents
  that `extends` the real ones, so `base_agent_id` resolves them to claude and
  codex and they inherit those agents' real shapes while spawning a script.
  The fixture agent appends the login environment it received to a file
  (terminal output is a WebGL canvas, never the DOM), so the spec asserts what
  the PROCESS actually got: the right variable, a different directory after a
  switch, and NO override for the adopted account.

Two agents on purpose. A switcher that only ever set `CLAUDE_CONFIG_DIR` would
pass a single-agent test and be broken for codex.

## Switching when an account runs out

A switch takes effect on the NEXT spawn, because a running process cannot have
its environment changed underneath it. Everything below follows from that:
termic never rescues the turn in flight, it makes sure the restart a spent
account forces you into lands somewhere that works.

**One threshold, `SWITCH_AT_PERCENT` (95), for both the offer and the automatic
switch.** It is tempting to offer earlier than you act, on the grounds that an
offer is cheap. But both answer the same question, "is this account done?", and
giving them different answers produces a popover offering a switch that the
automatic mode is simultaneously declining to make. There is no way to word
that. 95 rather than 100 because the last few percent are not usable: a long
turn starting at 96% dies in the middle, which costs more than the sliver it
was trying to use.

`switchCandidate` (`src/lib/autoSwitch.ts`) picks the account, and returns null
in every uncertain case. Doing nothing leaves the user where they already are;
a wrong switch moves a work session onto a personal subscription.

| Rule | Why |
|---|---|
| never to an account that is not signed in | an empty store cannot start the agent at all, which is worse than the limit it was dodging |
| never to one we last saw over the line, unless its window has since reset | otherwise the rotation walks the user into a second wall |
| an unknown reset clock counts as still spent | we cannot show it recovered, and guessing wrong fails invisibly. Both feeds do send one, so this is the edge, not the path |
| rotate onward from the current account | a two-account rotation would otherwise bounce between the same pair and never reach a third |
| nothing at all for an unnamed login | termic would be moving someone off the account they have always used, having never asked |

**Automatic is opt-in, per agent, and only where a number exists.** The toggle
is offered only when `agent_dirs::reports_usage` is true (claude, codex, agy,
devin, omp), and
`account_set_auto_switch` REFUSES to store it anywhere else rather than keeping
a flag that can never fire. The view reports it as off for an agent that cannot
act on it whatever is stored, because a checked box for something that will
never happen is worse than an unchecked one: the user believes they are
covered.

It writes exactly what the user's own click writes and nothing more. It never
kills or restarts a process: that would take away a running session to save a
limit the session has not hit yet.

**Two surfaces, one setting.** The checkbox is in the account pill's menu and
in the usage popover, because those are the two places the thought occurs: one
is where you switch by hand, the other is what you open BECAUSE you are near a
limit. Both read through `useAgentAccounts`, a single hook owning the fetch for
the whole footer. That is not tidiness. Each component fetched for itself
first, and toggling in one left the other showing the old value until something
remounted it, which an e2e case caught.

**The pill names both accounts while a switch is staged** (`Work → Client`),
running account first. The usage numbers sit immediately to its right and they
are the RUNNING account's, so a pill naming only the configured one would
caption Work's 97% with the word "Client". That is the confusion the pill
exists to prevent, pointed the other way.

### Usage is keyed by account, and was not

`store/agentUsage.ts` keys a reading by agent entry AND account. Before the
switcher, an agent entry WAS a login (a second one meant cloning the agent and
relocating its config dir), so keying by entry id alone was correct and the
file said so. The moment one entry could hold several accounts that stopped
being true, and two tasks of one agent on different logins wrote into a single
slot: whichever spoke last painted its percentage under the other's name.
Nothing failed and nothing looked wrong.

The account in the key is the one the PROCESS was spawned with, returned by
`pty_spawn` in `SpawnResult` and recorded on the tab as `liveAccount`. Never
the configured one: between a click and the restart those differ, and using the
configured one files the old account's spending under the new account's name,
which is the single mistake the whole feature exists to prevent. Only when
nothing has spawned yet does it fall back to the configured account, because
there is then no reading to misattribute.

The key is an encoded tuple rather than two strings joined by a separator. Both
halves are typed by the user in Settings, and the first version joined them
with a NUL, which its own test broke by naming an agent `claude\u0000x`.

## Linux

The feature is not macOS-shaped: the store is a directory termic creates and an
environment variable it sets, and neither is a platform API. What differs is
the keyring behind the agents, and it differs in termic's favour rather than
against it, because the path-keyed agents stay path-keyed:

| Agent | Linux store | Isolates via the variable |
|---|---|---|
| claude | `~/.claude/.credentials.json`, mode 0600 | yes (plain file, no keyring at all) |
| codex | libsecret, account key hashes `CODEX_HOME`; `auth.json` fallback | yes, both paths |
| grok | `$GROK_HOME/auth.json` | yes |
| opencode | `$XDG_DATA_HOME/opencode/auth.json` | yes |
| devin | `$XDG_DATA_HOME/devin/credentials.toml` | yes |
| pi | `~/.pi` | yes (via `HOME`) |
| gemini | keytar `gemini-cli-oauth`, fixed name | only with the companion flag, same as macOS |
| copilot | libsecret `copilot-cli`, fixed name | no, same as macOS |

Two Linux-specific bugs came out of this and are fixed:

- **The XDG shapes cannot be applied blind.** On Linux `dirs::data_local_dir()`
  IS `$XDG_DATA_HOME`, so relocating it for opencode also moves where termic's
  own CLI looks for its socket, and `termic` in that agent's terminal stops
  finding the app. The spawn pins `TERMIC_SOCKET` to the real path whenever the
  overlay touches an `XDG_` variable. On macOS the two are unrelated
  directories and the bug does not exist, which is exactly why it needed
  finding rather than reasoning about.
- **Aux shells must not inherit the overlay.** The env is applied only to an
  AGENT spawn. A plain shell inheriting a redirected `XDG_DATA_HOME` would
  quietly relocate unrelated tools' state for the whole session.

`cargo test --workspace --lib` runs green on ubuntu 24.04 (the required CI
check runs there too). Two unrelated tests fail INSIDE a root container and
neither is a Linux failure: `docker_writes_the_container_path_not_the_host_path`
asserts a host path differs from a container path, and in a root container both
are `/root/...`; `reads_the_real_process_table` wants a populated process
table, and a container has four processes.

## What an account's store actually contains

Relocating a config dir moves EVERYTHING, not just the credential: transcripts
(`projects/`), `history.jsonl`, `settings.json` (permissions, hooks and
termic's status line), `CLAUDE.md`, plugins. A bare directory is therefore a
BLANK agent, and that is what a second account was at first: no instructions,
no permissions, no usage reporting, and `--resume` unable to find the
conversation the user was in the middle of, which is the exact thing the
switcher exists to protect.

So the store shares everything but the credential, by two mechanisms:

| Realm | How | Why not the other one |
|---|---|---|
| Host | symlink farm back to the primary config dir | claude's settings writer follows symlinks and writes THROUGH, so there is one copy and drift is impossible |
| Docker | bind-mount each shared entry over the account's mount | a host symlink is dangling inside a container |

`agent_dirs::shared_config_entries` is the list, and it is deliberately a list
of what IS shared rather than what is not: an entry nobody has thought about
stays the account's own, which is the safe direction. Getting it backwards
shares a credential. `the_shared_list_never_names_a_credential` pins that
`.credentials.json`, `.claude.json` and `auth.json` can never appear in it.

`termic-hooks` is in the list and is not optional: the shared `settings.json`
names those scripts by ABSOLUTE path, so an account without them gets an agent
that fails every hook on every turn. On the host that path resolves anyway,
which is why it only broke in Docker.

## Signing a new account in

An account starts signed out, by design: termic makes an empty directory and
never handles a credential, so only the agent's own login can fill it. The
trap is that the agent in front of the user is still running on the OLD
account, so every `/login` they can reach signs the old account in again. The
first version of this said "start this agent on it and run its login", which
was true and left them with nowhere to do it.

Picking a signed-out account now OPENS that place: a tab in the same task,
titled `Sign in: <name>`, where the agent runs as the new account.

Nothing about that tab is special-cased at the spawn, and that is the point.
`pty_spawn` resolves the account from the TASK, and `pick` writes the new one
before it checks whether it is signed in, so an ORDINARY agent tab in that
task already comes up on the new account with an empty store and a login
prompt. `task_login_store` resolves the same way, so the cage allows the store
the agent is about to write into. Everything needed was already there; the
button was not.

A tab rather than a restart, because the conversation in the running tab is
the thing the switcher exists to protect. Sign in beside it, close the tab,
then pick the account again to move the task over.

## Switching a RUNNING agent

A switch writes a setting; the process keeps its environment until it restarts.
Restarting is safe only because the store shares the transcripts above, so the
conversation resumes on the other subscription. If that sharing is ever
removed, `lib/accountRestart.ts` has to go with it.

- **By hand**: offered, never done. A confirm, because nobody should have a
  running conversation killed by a menu click they thought only changed a
  preference. It remembers "don't ask again" (Settings, Tasks re-exposes it),
  and is skipped entirely when the target account is not signed in, where the
  offer's promise would be false.
- **Automatically**: no confirm, because the point is that it works while
  nobody is watching and a dialog waiting for a click is the one thing that
  cannot. It restarts and sends "continue": the resume leaves the agent idle at
  a prompt, and the turn that hit the limit still has to be asked for again.

The restart waits for a DIFFERENT pty id, not merely for one to exist: the old
id stays on the tab until the respawn patches it, so a presence check would
type into the process just killed. `accountRestart.test.ts` pins that and the
rest of the failure modes with fake timers, because every one of them costs a
conversation and none is visible in a diff.

## The sandbox has to be told

A named account's config dir lives inside termic's data dir, which the control
plane denies wholesale as its FINAL filesystem rule. The allow for one
account's store is therefore emitted after those denies, narrow to that one
directory; the CLI token and `projects.json` are siblings and stay denied. See
[gotchas.md](gotchas.md) "A rendered sandbox rule can be inert" for why the
test asserts byte offsets rather than `contains`.

## Prior art, researched 2026-09-05

Every one of these ships today. Between them they have already answered most
of the open questions in the original draft of this doc.

| Project | Switch mechanism | Parallel accounts | Notes |
|---|---|---|---|
| [claude-swap](https://github.com/realiti4/claude-swap) | Keychain slot swap | yes, via per-session `CLAUDE_CONFIG_DIR` | Ships BOTH mechanisms because neither alone does everything. Holds claude's own credential locks while writing so a swap never interleaves with a refresh. `--share-history` symlinks `projects/` + `history.jsonl` so all accounts see one history. |
| [claude-account-switcher](https://github.com/Symbioose/claude-account-switcher) | Keychain: backs accounts up under `claude-switcher:{email}`, restores into `Claude Code-credentials`, and updates `~/.claude.json` | no | Confirms the two-halves rule independently. Codex: whole `~/.codex/auth.json` backed up per email, restored at `0600`, requires `cli_auth_credentials_store = "file"`. Auto-switch at 100%, same provider only, off by default. |
| [claude-multi](https://github.com/Chamanrajragu/claude-multi) | per-account `CLAUDE_CONFIG_DIR` | yes | The closest analogue to termic (a desktop app). On a limit error it reads the reset time, marks a cooldown, COPIES the transcript to the next account and re-issues the interrupted instruction with `--resume`. |
| [ccswitch](https://github.com/vyshnavsdeepak/ccswitch) | Keychain via `security(1)` | no | Restart required, per its own docs. |
| [codex-accounts](https://github.com/omarhoumz/codex-accounts) | SYMLINKS `~/.codex/auth.json` at the account's own file | yes, via `CODEX_HOME` | The symlink is the elegant part: codex refreshes the token in place, so the write lands in the account's own file and nothing goes stale. `config.toml` stays shared by symlink. |
| [codex-multi-auth](https://github.com/ndycode/codex-multi-auth) | wrapper binary, routing state under `~/.codex/multi-auth/` | n/a | Health probes, quota cache, cooldown on repeated 5xx bursts. |

Two things worth stealing outright:

- **codex-accounts' symlink.** For codex, termic needs no env var and no
  vault: point `~/.codex/auth.json` at the selected account's file and let
  codex's own in-place refresh write through to it. Decision 1 is satisfied,
  sessions stay in `~/.codex`, and the staleness problem does not exist.
  Requires `cli_auth_credentials_store = "file"` so the credential is not in
  the OS keyring.
- **claude-swap's credential lock cooperation.** It takes claude's own lock
  while writing so a swap can never interleave with a token refresh. That is
  the shape to copy, and it replaces the "hold a lock past exec" idea an
  earlier draft of this doc had.

(Its `--share-history` symlinking of `projects/` and `history.jsonl` is
noted only for the record: it exists to undo the damage of per-account config
dirs, which this plan does not create.)

## What Anthropic actually bans

Worth stating explicitly, since this ships in a public product. Anthropic's
position, as reported by its own Claude Code team, is that holding several
Max accounts is NOT a terms violation. What draws suspensions is routing
subscription OAuth tokens through third-party clients and relay servers that
impersonate the official client.

The architecture Anthropic has publicly accepted is the one where each
account authenticates through the official OAuth flow and the official
binary does the talking, isolated per `CLAUDE_CONFIG_DIR` (a variable
documented in Anthropic's own environment reference). termic running the
real `claude` binary keeps it on the right side of that line either way,
since termic never speaks to the API itself. The config-dir isolation this ships is literally that blessed pattern; lifting a token blob out of the Keychain and planting it elsewhere, which termic does NOT do, is the part no vendor has blessed. A product risk to weigh, not a legal opinion.

## A per-token seat sends nothing but a zero, at first

Measured on an enterprise usage-based seat (`claude_enterprise`,
`enterprise_usage_based`, `userRateLimitTier: default_claude_zero`), driven
through a real task:

```
usage - - - - 0            session start
usage - - - - 0.235401     after the first turn
```

No rate limits, EVER: a zero rate-limit tier has no personal window
allocation, because billing is per token at the org level. The cost is the
entire reading, and it is zero until the session spends something.

The first line is ALSO what a subscription sends before its first message.
Measured on claude 2.1.273 with a Max account, fresh session: `cost 0` and no
`rate_limits` until the first message, then `rate_limits` and a cost of
`0.119434` in the same payload. So a zero with no windows proves nothing about
the account, and until something does the chip reads "Usage unknown".

The proof of no plan is a session whose cost ROSE with no window alongside it
(`UsageEntry.noPlan`): a rise means a turn reached the API, and a subscription
reports its windows in that very payload. It is a rise within ONE session,
never a nonzero figure, because a restored session may start from a total it
already had. Each session's first figure is written even when the account's
total does not move, since it is the baseline the rise is measured from: one
write per session, not per turn (bear trap 8).

This replaced a count of window-less readings across sessions, two of which
were taken as proof. After a relaunch every restored task sends one before its
first message, so restoring two tasks on a Max account showed no chip on the
first and `$0.00` with "billed per token" on the second.

`costChipVisible` also requires `source === "statusline"`. codex answers plan
windows and nothing else, so a window-less codex reading would otherwise print
`$0.00` for a number it never sent.

## A plan's dollars are not spend

claude reports `total_cost_usd` on EVERY account, subscription included, so a
Max account shows plan windows AND a dollar figure. The two are not
alternatives and the panel shows both.

But the same number means two different things, and the label has to say
which. On a plan nothing was charged: the figure is what those tokens would
have cost at API rates, and the subscription covered them. On an account with
no plan it is money, because that account is billed per token.

So the row reads "Would have cost ... at API rates since launch. Your plan
covers it." when `sawPlan` is set, "Spent since launch" once `noPlan` has been
proved, and a neutral "Cost since launch ... at API rates" while neither is
known.
Reported from a real panel showing 9% and 1% next to "Spent since launch $11",
which reads as eleven dollars charged for a month that charged nothing.

The CHIP is unaffected and was already right: `costChipVisible` requires
`!sawPlan`, so dollars only ever reach the footer on an account whose
percentages would be meaningless.

## Known gaps

- **copilot and muse get no switcher, deliberately.** copilot keys its libsecret
  /Keychain item by a fixed service name, so no variable can isolate it. muse's
  metadata index relocates with `XDG_CONFIG_HOME`, but the keychain item behind
  it has not been shown to be keyed per directory, and shipping a switcher that
  might silently share one login is worse than shipping none. Both say so in
  the UI. Resolving muse means one measurement: sign into two stores and see
  whether the first still works.
- **Automatic switching needs a usage feed, so five agents only get the manual
  half.** That is the shape of the problem, not a gap in the work: "nearly out"
  is a number somebody has to report, and only claude, codex and devin report
  one. The manual switch works everywhere.
- **The switch never rescues the turn in flight.** A running process keeps its
  environment, so the earliest a switch can take effect is the next start. The
  UI says so in three places rather than letting anyone discover it.
