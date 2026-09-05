# Agent credentials: several accounts per agent, swapped in the OS store

Status: approved 2026-09-05 in
[#278](https://github.com/simion/termic/issues/278).

**Phase 2 of two, and a separate delivery.** Phase 1 is
[profiles.md](profiles.md). The two features compose but neither blocks the
other: profiles ship with the single shared login every agent already has,
and this lands afterwards without changing anything in the profiles data
model. Do not merge the two into one release.

Profiles answer "keep my work and personal contexts apart". This answers "my
account hit its 5-hour limit and I want to keep going, in this conversation,
right now".

## Settled

From the #278 thread. These are decisions.

1. **Swap the credential, never the history.** The session transcript must
   not move: the user is mid-conversation when they hit the limit. A profile
   does get its own config dir, because that is the only thing the credential
   store is keyed by, but the dir is a container for the credential and
   nothing else. `projects/` and `history.jsonl` are symlinks to the primary,
   so conversations are shared across every profile and every account, and a
   switch never relocates a session file. Revised 2026-09-05: an earlier
   draft banned relocation outright, which is the right instinct aimed at the
   wrong target.
2. **Each profile has its own set of credentials, with a default one**, and
   therefore its own config dir, because the credential store is keyed by
   the config dir and there is no other way to hold two live accounts. The
   dir carries ONLY the credential and identity: everything else is
   symlinked back to `~/.claude`, so no setting is ever duplicated. See "The
   profile dir is a symlink farm".
3. **An account is added once, then assigned.** A profile's set is a
   selection out of a single global list, not a fresh login per profile.
   Re-entering the same account per profile was rejected explicitly: it is
   tedious, and the copies drift so one profile ends up on a stale token.
4. **Optional auto-switch when a limit is reached**, and **the rotation pool
   is per profile**. A work profile rotates among work accounts and never
   falls back to a personal one, because that mixes billing and defeats the
   reason the profiles exist. The per-profile config dir makes this
   enforceable rather than advisory: a profile can only ever stage a
   credential into its own store.
5. **The UI says which account a session is on**, and says so again when a
   switch happens. Picking the account with the most headroom is a bonus
   over "the next one that is not maxed out"; the latter already solves the
   pain.

## What is measured

Reproduced 2026-09-03 against `claude 2.1.259`. This is the evidence the
design has to survive.

### A claude credential is two halves, in two places

- **The token** is a macOS Keychain item. Service name is
  `Claude Code-credentials` for the default config dir (and
  `Claude Code-credentials-<sha256(config_dir)[..8]>` for a relocated one,
  which decision 1 means we will never produce). The blob holds
  `accessToken`, `refreshToken`, `scopes`, `subscriptionType` and
  `rateLimitTier`.
- **The identity** is `.claude.json` under `oauthAccount`, at `~/.claude.json`
  for the default config dir (it folds INSIDE the dir only when relocated,
  which decision 1 means never):
  `emailAddress`, `organizationName`, `accountUuid`, `organizationUuid`.
  This is what `claude auth status` prints and what any UI would show.

**Writing only the Keychain half produces a lie, and this was measured.**
`CLAUDE_SECURESTORAGE_CONFIG_DIR` is the built-in knob that splits exactly
this way, and with it pointed at a second account, `claude auth status`
reported the FIRST account's email and organization together with the SECOND
account's `subscriptionType`. Token from one, every visible identity field
from the other: requests billing one org while the screen names another.

So a switch writes **both halves**, always: the blob into the Keychain item,
and `oauthAccount` into `.claude.json`. Writing one and not the other
reproduces the measurement above. Independently corroborated: Symbioose's
switcher restores its Keychain backup AND updates `~/.claude.json`, and
claude-swap warns that a whole-file restore is wrong for the opposite reason,
since `.claude.json` also holds account-INDEPENDENT OAuth state (MCP server
logins) that an older snapshot would clobber. Patch the `oauthAccount` key,
never replace the file.

### Session ids survive, because nothing moves

Two failure modes constrain any account switch, both measured, both silent
process exits:

- `--resume <uuid>` when the file is absent from that config dir prints
  `No conversation found with session ID: <uuid>` and exits. In a PTY that
  is a dead agent tab.
- `--session-id <uuid>` when the id already exists prints
  `Error: Session ID <uuid> is already in use.` and exits.

Swapping in place sidesteps both. The config dir is unchanged, the session
file is where it was, `TerminalTab.sessionId` stays valid, and the resume
arguments do not change. This is the concrete payoff of decision 1: the
rejected alternative has to copy an up-to-11MB `.jsonl` into the other
account's tree first, and that copy re-sends the entire prior transcript to
the other account's org.

### A switch does NOT require a respawn, and that is the problem

Corrected 2026-09-05 by research into prior art. The original assumption here
was that claude reads its credential once at startup and holds it. It does
not.

claude keeps the Keychain value in an in-memory cache with a **30 second
TTL** (`KEYCHAIN_CACHE_TTL_MS = 30_000`), so a running session picks up a
swapped credential once that cache expires, with no restart. `claude-swap`
documents the same behaviour from the outside ("on macOS, credentials live
in the Keychain, which Claude Code caches for about 30 seconds"), and
Linux/Windows are stricter still: credentials are a file there and claude
re-reads it whenever it changes.

The good half: a switch needs no respawn, and the session id never has to
move.

The bad half, and it is decisive: **the swap is machine-wide.** Within 30
seconds, every running claude on the machine is on the newly written
account, in every task, in every profile window. There is exactly one
Keychain item for the default config dir, and every process reads it on a
30 second loop.

## Why one shared config dir cannot work, and what replaces it

Start from the shape that looks simplest: every profile shares `~/.claude`,
and termic just writes the one Keychain item. Combined with the 30 second
cache above:

**It delivers, cleanly:**

- Switching the machine to another account without a browser login, without
  moving a directory, and without losing the conversation. The config dir
  never moves, so the session file stays where it is and `--resume` keeps
  working. This is the core ask in #278 and it works.
- Switching a session that is ALREADY RUNNING, mid-task, within 30 seconds.
  Better than the original plan assumed.
- Auto-switch on limit, since the same write is all a rotation needs.

**It cannot deliver, at all:**

- **Two profiles on two accounts at the same time.** The item is global and
  every process re-reads it every 30 seconds, so there is no such thing as
  staging a credential "for one spawn". Ten seconds after a work-profile tab
  switches accounts, the personal-profile window on the other monitor is on
  that account too. Decisions 2 and 4 describe a state this shape cannot
  hold, which is why it is not the one being built.

The Keychain service name is derived from the config dir
(`Claude Code{suffix}{dirHash}`), so the ONLY way to get two live accounts on
one machine is two config dirs. That is what every project that ships
parallel accounts does, without exception (see "Prior art"). It is also the
architecture Anthropic has publicly accepted.

**Decided 2026-09-05: per-profile config dir, and the dir holds nothing but
the credential.** The objection to config dirs is real and was measured
here: a second config dir carries its own `settings.json` (permissions,
hooks, plugins), `CLAUDE.md`, `commands/`, `agents/`, `skills/`, MCP list,
trust flags and history, and they drift silently. On the machine used for
the 2026-09-03 research, the second dir had no `permissions` block and none
of the `PreToolUse` hooks the default dir had, so every session on that
account had been running without the allowlist and without the hook, with
nothing on screen saying so.

The answer is not to avoid config dirs. It is to make the profile's dir a
**symlink farm**: it owns the credential and the identity, and every other
entry points back at `~/.claude`. This is what the projects that ship
parallel accounts actually do, and one property makes it work.

### The profile dir is a symlink farm

**Claude's settings writer follows symlinks and writes THROUGH to the
target.** An in-session `/config` change made in any profile lands in
`~/.claude/settings.json`, and every other profile sees it immediately,
because they are all the same file. Drift is not mitigated, it is
impossible: there is one copy.

The split, taken from `claude-swap`'s session bootstrap, which is the most
carefully worked example in the wild:

| Entry | Treatment | Why |
|---|---|---|
| `settings.json` | symlink | permissions, hooks, plugins. One copy or the drift measured above comes straight back. |
| `keybindings.json` | symlink | machine preference, not per account |
| `CLAUDE.md` | symlink | one set of instructions |
| `skills/`, `commands/`, `agents/` | symlink | user-authored assets, configure once |
| `projects/`, `history.jsonl` | symlink | **unified conversation history.** The `/resume` picker is cwd-scoped, so a task still only ever lists its own directory's sessions. This is what makes an account switch lossless. |
| `.credentials.json` | REAL, profile-owned | the whole point; seeded, then migrated into that dir's own Keychain item |
| `.claude.json` | REAL, profile-owned | fuses per-account identity (`oauthAccount`) with trust flags and MCP OAuth state, so it cannot be one file |
| `sessions/`, `ide/`, `shell-snapshots/`, `statsig/`, `plugins/` | NOT shared | PID tracking, instance and telemetry scoped |

Track what termic created in a manifest beside the farm, the way
`.cswap-shared.json` does, so removing a profile never deletes a symlink
target or user-accumulated data.

### The credential lands without a browser login

macOS keeps the credential in the Keychain, but `~/.claude/.credentials.json`
is a first-class fallback in the same JSON format, and **on macOS claude
consumes that file and migrates it into the Keychain item for that config
dir**. So seeding is: write the blob as `.credentials.json` in the profile's
dir, delete any stale Keychain entry for that dir's hash, and let claude
migrate it on first use. That is exactly `claude-swap`'s bootstrap, and it is
why adding an account is a one-time login (decision 3) rather than one per
profile.

It also means the file is a seed, never a store: it disappears on macOS. Do
not build anything that expects to read it back.

### What each profile gets, and what it costs

Each profile dir hashes to its own Keychain service
(`Claude Code-credentials-<sha256(dir)[..8]>`), so two profile windows hold
two live accounts with no contention, and the 30 second cache means a switch
inside one profile reaches its running tabs without a respawn and without
touching the other window.

The residual costs, both in `.claude.json` and both worth stating plainly:

- **MCP servers.** Mirror the `mcpServers` key from the primary into each
  profile's `.claude.json`, under an adoption marker so removing the mirror
  never eats a profile-local definition, and take claude's config lock while
  writing. Again, `claude-swap` already does exactly this.
- **Trust flags.** `hasTrustDialogAccepted` is per (config dir, project), so
  a new profile prompts on first open of a project the primary already
  trusts. Seed it when termic creates the profile dir, or the trust prompt
  swallows the first injected prompt.

### Also considered and dropped

- **Symlinking the credential itself**, the way `codex-accounts` re-points
  `~/.codex/auth.json` at the selected account's file. Ideal, and impossible
  for claude on macOS: the credential is a Keychain item, and the file form
  is deleted and migrated into the Keychain on first use. It stays the right
  answer for CODEX, where the credential IS a file and codex's in-place
  refresh then writes through to the account's own copy. Requires
  `cli_auth_credentials_store = "file"`.
- **One shared config dir with a machine-wide swap.** Considered and
  rejected: the Keychain item is global and every claude process re-reads it
  every 30 seconds, so an account switch in the work window drags the
  personal window with it. It cannot hold decisions 2 and 4.
- **`CLAUDE_SECURESTORAGE_CONFIG_DIR` per PTY.** Would relocate only the
  credential half, giving per-profile accounts with one shared config dir.
  Measured 2026-09-03: it reported the first account's email and organization
  with the second account's `subscriptionType`. Undocumented, absent from the
  public environment reference, removable without notice. The symlink farm
  reaches the same place on documented behaviour.
- **`CLAUDE_CODE_OAUTH_TOKEN` per PTY.** Sits above the Keychain in claude's
  credential priority order. Rejected on evidence: inference-only
  (`refreshToken: null`, `expiresAt: null`, `scopes: ['user:inference']`), so
  it cannot refresh and a long-lived task dies when it expires. `claude-swap`
  actively scrubs it from child environments to stop it hijacking the
  selected account.

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

## Auto-switch

The detection half already ships. `merge_statusline`
(`src-tauri/src/agent_hooks.rs`) claims claude's `statusLine` slot when it is
free or already ours, and claude pipes `rate_limits` (`five_hour` and
`seven_day`, each `used_percentage` plus `resets_at`) into it on every turn.
`src/lib/agentUsage.ts` parses the feed off the OSC channel, and the codex
half comes typed from `codex app-server` over JSON-RPC. "Which account has
headroom" is answerable today for the two agents that matter most.

Recommended shape:

- **Offer by default, auto behind an explicit opt-in.** Auto-switching
  mid-turn discards in-flight work, and a false positive burns the second
  account's quota too, which is the one thing the feature exists to protect.
- **Order the pool by headroom** when usage is known, falling back to the
  first entry that is not maxed. Both are cheap; the data is already there.
- **Never leave the profile's pool.** If every account in it is maxed, say so
  and wait for the earliest reset rather than reaching for one belonging to
  another profile. The per-profile config dir makes this structural: a
  rotation can only write its own profile's credential store.

## Per agent, because only claude is a Keychain

| Agent | Credential lives in | Identity lives in | Swap in place |
|---|---|---|---|
| claude | Keychain item, service keyed by config dir hash | `$CONFIG/.claude.json` `oauthAccount` | yes, both halves |
| codex | `$CODEX_HOME/auth.json` | same file | yes, file write |
| grok | `$GROK_HOME/auth.json`, keyed `provider::id` | same file | yes, already models several accounts |
| agy / gemini | `$DIR/oauth_creds.json` + `google_accounts.json` | `google_accounts.json` is literally `{active, old[]}` | yes, already models several |
| opencode | SQLite `credential` table | `account` table, has an `active` column | row update, real work |
| pi | `~/.pi/agent/auth.json` | unknown | out of scope for v1 |
| copilot | untested, not installed on the measuring machine | unknown | unknown |

So the swap is a per-agent descriptor, not one mechanism: where the
credential lives, how to write it, and where the matching identity lives.
Three of these (grok, gemini, opencode) already carry several accounts
internally and expose an active flag, so driving their own switch may be
cheaper and safer than writing their stores. Not investigated.

## Keychain access: answered, with a catch

The original draft listed "does writing claude's Keychain item prompt the
user?" as the question that gates everything. It is answered, from two
directions, and both matter:

- **No prompt, if you go through `/usr/bin/security`.** claude creates the
  item with `security add-generic-password` and no access-control arguments,
  so the trusted application on the item's ACL is the `security` binary
  itself. Any process can therefore read it
  (`security find-generic-password -s "Claude Code-credentials" -a "$USER" -w`)
  or replace it (`-U`) with no Touch ID, no password, no notification. This
  is documented as a security weakness rather than a feature
  ([Silverfort](https://www.silverfort.com/blog/skipping-the-lock-a-claude-code-cli-weakness-lets-any-macos-process-read-stored-credentials/)),
  and it is why the community switchers all shell out to `security`.
- **Prompts, and repeatedly, if you use the native Keychain APIs.** A signed
  app reading the item with `SecItemCopyMatching` gets the standard prompt,
  and "Always Allow" does not stick: claude DELETES AND RECREATES the item on
  every token refresh (roughly every 8 hours), which resets the ACL and
  re-prompts. CodexBar hit this 5-10 times a day and asked Anthropic for a
  usage cache or a `claude auth token` export;
  [the request was closed as not planned](https://github.com/anthropics/claude-code/issues/22144).

So: **shell out to `security`, never `SecItem*`**, and expect the item to be
deleted and recreated underneath termic every few hours. Anything cached by
item identity rather than re-read is wrong.

## One more risk to weigh: what Anthropic actually bans

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
since termic never speaks to the API itself. But note that option 2 above is
literally the blessed pattern, while lifting the token blob out of the
Keychain and planting it elsewhere is the part no vendor has blessed. That
is a product risk to weigh, not a legal opinion.

## Open, in the order that decides the design

1. **Claude's own credential lock.** `claude-swap` holds it so a swap never
   interleaves with a refresh, and claude's refresh path is a three-stage
   check ending in a file lock with 1000-2000ms jittered backoff and five
   retries. Find the lock's path and take it the same way. Writing the item
   without it races an 8-hourly refresh.
2. **Refresh-token rotation:** does claude invalidate the previous refresh
   token when it rotates? If it does, a stored blob for an account in use
   elsewhere goes dead rather than merely stale.
3. **Blind writes:** can a blob be written for an account that has never
   logged in on this machine, or does the first use need a real login? It
   decides how "add an account" feels.
4. **Failure UI:** rejected blob, expired token, an account deleted from
   Settings while a tab is running on it. Note the precedent: Symbioose's
   switcher refuses to restore a stale codex session and demands a re-login
   rather than half-restoring it.
