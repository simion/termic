# termic MCP endpoint

Status: Phase A shipped (see the landing notes); B1 and B2 not started. Tracked in
[#176](https://github.com/simion/termic/issues/176).

Build a scoped MCP control plane an agent can call without being handed a
terminal, using the 2026-07-28 spec revision. Two things made this
buildable now, where earlier MCP designs were parked.

First, the new revision made the protocol stateless. No handshake, no
sessions; every request authenticates itself. A per-task bearer token
now answers the question that killed every earlier design: WHICH task
is calling, and what may it do. Combined with a listener bound to one
loopback port, the grant to a caged agent shrinks from "a terminal"
to "one TCP port and one env var" - the narrowest hole seatbelt can
express.

Second, the CLI was always the wrong surface for agent control; we
chose it because it beat MCP v1 at the time, and that tradeoff no
longer holds. Granting an agent the CLI is granting terminal access:
a shell, an exec'd binary, a readable token file, a socket connect.
That is too permissive a grant to hand a sandboxed agent, and it
cannot be made narrow, so cli.md makes it zero: caged agents get no
control plane at all. A caged orchestrator today cannot create or
drive subtasks, period.

So: sandboxed agents get a scoped control plane for the first time
(a caged orchestrator farming out subtasks to caged workers, without
holding an escape), and outside MCP clients get the surface the
parked `termic mcp` shim was for, at no extra cost. This doc settles
the architecture and security constraints before any code.

Non-goals: a separate daemon (this is an in-process loopback listener,
like the automation bridge and proxy), remote access, replacing the
CLI, or any event/notification stream in v1.

## Why now

The stdio shim was parked because its only audience was outside
orchestrators nobody had, MCP tool definitions cost context tokens in
every session, and the CLI already served agents with shells. All
still true for the outside audience.

The new audience is INSIDE the sandbox. cli.md rules that caged agents
get no CLI surface: the socket is all-or-nothing under seatbelt, and
identifying which task a socket peer belongs to is unreliable. It
defers the fix as "scoped tokens placed inside the cage". Three
things in the 2026-07-28 revision make that buildable now:

1. **Stateless protocol.** No handshake, no sessions; every request
   carries its own identity. A bearer token per request maps exactly
   onto the token -> {task, scope} model cli.md wanted. Earlier MCP
   revisions were session-bound and would have reintroduced the
   caller-identification problem.
2. **Plain HTTP.** With sessions, resumability, and server-initiated
   requests gone, a loopback endpoint is simple request/response, and
   loopback TCP is something seatbelt can grant per task with
   primitives we already use.
3. **Cacheable tool lists.** Deterministic ordering and ttlMs blunt
   (not erase) the context-cost objection.

Unchanged: settle detection stays heuristic, so `wait` carries the
same caveat as `termic wait`, and no event stream ships before hooks.

## CLI access is terminal access; MCP access is a port

Granting a caged agent the CLI means granting a program: a shell, an
exec path for the binary, a read on the token file, a socket connect.
That is several seatbelt holes in an allow-list that user, repo, and
agent layers can extend, and cli.md documents how an allow-listed
ancestor silently re-exposes a denied path. The grant is ambient and
hard to audit, which is why cli.md made it zero instead of narrow.

The MCP grant is one TCP connect to one pinned loopback port plus one
env var holding a scoped token. No exec, no file reads, no socket, no
interaction with the FS allow-list. It is the narrowest grant seatbelt
can express and it is per-task by construction (the token is the
identity).

Two clarifications:

- The original CLI-over-MCP call was right at the time: for uncaged
  agents the CLI adds convenience, not capability, and MCP was still
  stateful. The ranking flips only for the in-cage audience, and only
  now that the protocol is stateless.
- MCP tools calling the CLI's implementation is fine. The risk is
  what the agent is granted, not what the server reuses internally.
  MCP dispatch goes through the same verb registry and cli_server
  paths; the agent never gets a shell, binary, or socket.

## Architecture

```
caged agent ──loopback HTTP──┐
uncaged / outside MCP client ┤──  Termic.app
                             │    ├─ Rust: mcp server (own thread)
                             │    │   ├─ stateless JSON-RPC core
                             │    │   ├─ token -> scope registry
                             │    │   └─ dispatch = cli_server's paths
                             │    └─ webview: same __termic.rpc handlers
```

- One app-wide listener on `127.0.0.1`, OS-assigned port, own thread
  (never the IPC thread). Not routed through the CONNECT proxy: the
  proxy is per-task and Enforce-only, so EnforceFs and Monitor would
  be stranded.
- Dispatch reuses the CLI server's two domains: Rust-native reads
  answer directly, orchestration goes through the webview RPC
  registry. MCP is a third presentation of the same verbs, never a
  third implementation, and it never execs the `termic` binary. Tool
  definitions are GENERATED from the same metadata as `help --json`
  so the surfaces cannot drift.
- The CLI is not replaced or diminished; the two surfaces serve
  different callers over the one implementation. CLI: humans,
  scripts, and uncaged agents with shells (zero context cost until
  invoked, pipes and exit codes, `attach` gives a real TTY, which no
  tool call can). MCP: caged agents, the only surface they can safely
  be granted, and MCP-native outside clients without a terminal.
- Hand-rolled stateless core: `POST /mcp` with `server/discover`,
  `tools/list`, `tools/call`, `_meta` validation, the spec's typed
  errors and headers. No sampling/roots/logging (deprecated anyway),
  no subscriptions, no MRTR. The rmcp SDK is beta and buys machinery
  we don't need; revisit if subscriptions ever land.
- Legacy clients: NOT served. `initialize` is refused with an
  `UnsupportedProtocolVersionError` naming 2026-07-28, because a
  handshake client has no fall-forward and that message is the only
  diagnostic its user gets. Notifications are still swallowed with 202
  (the revision defines no header requirements for them). No old
  handshake, no sessions, no resumability.
- `task_wait` is a bounded tool (`timeoutMs`, server-capped at
  minutes) returning `{outcome, state}`; callers loop. No hour-long
  hanging POSTs. Same quiescence semantics and staleness rules as
  `termic wait`.
- No `attach` (a TTY stream is not a tool call), no `quit`.

## Sandbox

The socket stays denied in-cage; nothing in cli.md's boundary changes.
The MCP port is the new, deliberately narrow hole. Two knobs in the
task's sandbox config, seeded from the project like hosts/paths:

1. **"MCP" checkbox** (default OFF). On = `provision()` renders the
   port allow and mints the task's token.
2. **"Projects" allow-list** (default: the task's own project). Which
   projects the token's tools may act on, checked server-side on
   every request. This is the `projects` half of cli.md's `{verbs,
   projects}` scope grain; verbs are fixed per scope class in v1.

Mechanics:

- **Provisioning.** `provision()` mints an independent random token,
  registers token -> {task_id, projects, scope}, and injects
  `TERMIC_MCP_URL` + `TERMIC_MCP_TOKEN` into that task's PTY env
  overlay only. Revoked at archive and at sandbox edits (which
  already SIGKILL PTYs).
- **Seatbelt: one port, not loopback.** Enforce adds exactly
  `(allow network-outbound (remote tcp "localhost:<mcp-port>"))` when
  the box is checked, emitted after the broad allows (last-match-wins,
  same discipline as the socket deny). The listener binds before any
  caged spawn so the port is known at render; a rebind means SIGKILL
  + reprovision for live cages. EnforceFs (`allow network*` by
  design) and Monitor reach the port regardless; the missing token is
  the gate there, same accepted posture as Monitor's socket
  reachability. cli.md's token invariants carry over: the full token
  never enters any env; the data dir deny stays the final FS rule.
- **Uncaged tasks** get a `full`-scope per-task token when the
  feature is on (attribution, not new capability). Outside clients
  (Claude Desktop etc.) authenticate with a dedicated per-boot
  `mcp-token` file (0600, same handling as `cli-token`, never the
  same value; see the Phase A threat model), mapping to `full`, so
  the endpoint doubles as the surface the original `termic mcp` was
  for. No stdio shim needed.

**Scoped requests pass two checks in order.** First the project
allow-list. Then monotonicity, because project scope alone is an
escape: a caged agent sending into an UNCAGED task in an allowed
project runs commands by proxy. cli.md's rules apply verbatim:

- `task_send` may only target tasks whose EFFECTIVE capability is a
  subset of the caller's. Compare effective, never stored lists:
  EnforceFs's effective network is ALL hosts regardless of its stored
  list; Off and Monitor are unbounded; Enforce > EnforceFs.
- `task_new` caps the child at the caller's effective capability:
  mode at least as strict, allow-lists a subset, control plane at
  most scoped, never uncaged YOLO.
- Reads leak: `task_list` is full-scope only (other projects' task
  names/paths are what the cage hides; the project list widens what a
  token may act on, never what it may enumerate). Scoped callers see
  themselves and tasks they created through the token (the server
  records parentage).

**Worked example.** Project A's task A1 has the default config; Project
B's task B1 has its allow-list widened to [B, C]. At spawn,
`provision()` mints one token per task and registers it server-side:

```
token_A -> {task: A1, projects: [A],    scope: scoped}
token_B -> {task: B1, projects: [B, C], scope: scoped}
```

`token_A` is injected into A1's PTY env only, `token_B` into B1's
only; the cage keeps them apart (a task cannot read another task's
env or token, and the values are independent, so holding one teaches
nothing about the other). Every request carries its token as a
bearer header, and the server decides from the lookup alone:

- Claude in A1 calls `task_send` targeting a Project C task: lookup
  says projects [A], target is in C, refused before anything runs.
- Claude in B1 makes the same call: projects [B, C] passes, THEN the
  monotonicity check runs (target at least as caged as B1), then it
  dispatches.

The agent never asserts an identity; possession of the token IS the
identity, decided at provision time by whoever edited the sandbox
config. This is why the design leans on the stateless revision:
identity is per-request, never per-connection.

Scoped v1 tools: `task_new`, `task_send`, `task_wait`, `task_status`,
`task_result`, `task_log`, `task_diff`, `task_tab`, `task_tab_close`,
`task_agents`, `prompts`. Full scope adds `task_list`, `task_archive`,
`task_apply`, `task_open`, `task_rename`, `project_*`. `tools/list`
reflects the caller's token scope (`cacheScope: private`, generous
ttlMs).

Tabs are scoped, not full: they act INSIDE a task the caller already
holds, which is the shape an orchestrator needs to run several agents
in one task. `task_agents` and `prompts` are scoped for the same
reason a refusal is worse than a listing: without them a caller
guesses an id and learns from the error. The tab SELECTOR rides on
`task_send`, `task_wait` and `task_log` too, since a tab you cannot
address is half a feature.

## Spec notes (2026-07-28)

- Verified against the published spec (modelcontextprotocol.io), not
  second-hand notes. The first pass was written from notes and shipped
  three wire bugs a real client caught: `versions` instead of
  `supportedVersions` on DiscoverResult (which left codex unable to
  negotiate and stalled it after discover), `ttlMs` buried in `_meta`
  instead of a top-level result field, and no caching hints on
  `server/discover` at all. Check shapes against the spec page, and
  against a real client, before believing them.
- `server/discover` -> `DiscoverResult`: `supportedVersions`,
  `capabilities`, `_meta['io.modelcontextprotocol/serverInfo']`, plus
  the mandatory `ttlMs` + `cacheScope` cache hints. Caching hints are
  REQUIRED on every `resultType: "complete"` result of `server/discover`
  and `tools/list`, as TOP-LEVEL result fields.
- `cacheScope` is `public` only while every caller sees the same
  surface. Phase B2 filters `tools/list` per token, so it must become
  `private` there or a shared cache serves one caller another's tools.
- Every result: `resultType: "complete"` as a top-level result FIELD
  (not `_meta`), plus `io.modelcontextprotocol/serverInfo` in `_meta`.
  serverInfo in the `DiscoverResult` body is the pre-final shape and
  SDK v2 rejects it.
- `_meta` keys are namespaced: `io.modelcontextprotocol/protocolVersion`
  and `io.modelcontextprotocol/clientCapabilities` are both REQUIRED on
  every request. Bare `protocolVersion` is a different key that no
  client sends.
- `MCP-Protocol-Version` header required on every POST and must equal
  the `_meta` version.
- `server/discover` implemented (mandatory), versions `["2026-07-28"]`,
  capabilities `{tools: {}}`.
- Header faults (missing or mismatched `Mcp-Method`, `Mcp-Name`,
  `MCP-Protocol-Version`) -> -32020/400. Missing required `_meta`
  fields -> -32602/400: the header was there, the body was not, and
  conflating the two strands the client. Unsupported version ->
  -32022/400 with `data.supported` + `data.requested`, machine-readable
  because that is what a client retries from. Unimplemented method ->
  -32601 at HTTP 404.
- Deterministic tool order (registry order).
- No icons, prompts, or resources in v1 (resources would double the
  context-cost surface).
- Auth: loopback bearer token on every request; the spec's OAuth
  framework is for real HTTP deployments, and the STDIO-style
  "credentials from the environment" posture is the sanctioned local
  shape.

## Phase A threat model

Phase A opens an outside-reachable surface before any sandbox work,
so it needs its own threat model; "nothing in-cage changes" covers
caged agents only. Loopback TCP is a wider boundary than the unix
socket: the socket had three gates (0600 socket file, getpeereid
same-uid check, token), TCP keeps only the token, and it is reachable
by every local process regardless of uid and by browser JavaScript.
Phase A compensates from day one rather than inheriting:

- **Own credential.** The endpoint authenticates against a dedicated
  per-boot `mcp-token` file (0600, 128+ bits), never reusing
  `cli-token`. A leak compromises one surface, and rotation is
  decoupled. All cli.md token invariants apply: never in the app
  process env, data dir denied to cages, scoped per-task tokens only
  inside their one cage.
- **Cross-uid processes** can connect to the port but cannot read the
  0600 token file. The token is the entire boundary here; that single
  factor is why the custody rules above are strict.
- **Same-uid processes** that read the token get full orchestration.
  That is the socket's existing posture (a same-uid process can
  already do anything as the user), but the socket had peer-cred and
  file-perm depth in front of its token; here there is none, so the
  server does constant-time token comparison and logs and backs off
  on auth failures.
- **Browser JavaScript (CSRF against loopback).** Any web page can
  fire requests at 127.0.0.1. Three independent stops, all Phase A
  requirements: the token rides an `Authorization` header a browser
  never attaches cross-origin; the spec-required `Mcp-Method` header
  makes every request non-simple, forcing a CORS preflight the
  server never answers; and any request carrying an `Origin` header
  is rejected outright, with no CORS headers ever emitted.
- **Peer identification is not attempted.** Mapping a loopback
  4-tuple to a pid is the same unreliable-under-adversary check
  cli.md rejected for the socket; at most it is logged as telemetry,
  never used as a gate.

## Settings and exposure

Same landing discipline as the CLI: merged is not live.

- Global "Enable MCP endpoint" setting, default OFF. Off = not bound
  (no first-run dead end here, unlike the CLI socket, so
  bind-on-enable is safe).
- The two per-task knobs above, default off / own-project.
- `TERMIC_MCP_URL`/`TERMIC_MCP_TOKEN` injected only when both levels
  agree, so the advertisement is never a lie.
- docs/cli-agent-instructions.md gains a short MCP section.

## Phasing

- **Phase A: endpoint + full scope.** Listener, stateless core,
  registry-generated tools, `mcp-token` -> full, and the full Phase A
  threat model above (own token file, Origin rejection,
  preflight-hostile headers, auth backoff) as landing requirements, not
  follow-ups. Outside clients work; nothing in-cage changes. Measures
  real client behavior and context cost before the sandbox work.
  Legacy tolerance was dropped during Phase A, see the landing notes.
- **Phase B1: token identity.** The registry the sandbox layer stands
  on, plus the delivery it enables. Replace the single-token compare
  with a `token -> Grant` lookup (the `mcp-token` file maps to a full
  grant, so outside clients are untouched); mint a distinct token per
  task, register it, and inject `TERMIC_MCP_URL` + `TERMIC_MCP_TOKEN`
  into that task's PTY env overlay only; revoke at archive and at
  sandbox edits, which already SIGKILL the PTYs.

  UNCAGED TASKS ONLY. Their tokens carry full scope: an uncaged agent
  can already read the 0600 file itself, so this is attribution, not
  new capability. A caged task gets nothing here, because a full token
  inside a cage IS the escape this design exists to prevent, and
  without B2's seatbelt allow it could not reach the port anyway.

  Split out of Phase B because it is separable and independently
  useful: agents in (uncaged) tasks get the credential with no shell
  setup, which is the in-app half of the product story, and every line
  of it is groundwork B2 needs rather than scaffolding B2 replaces.
- **Phase B2: sandbox.** The two sandbox knobs, the seatbelt port
  allow, parentage, project filter + monotonicity, scope-filtered
  `tools/list`. Its own PR and review; this IS cli.md's deferred
  scoped-access phase and inherits its invariants.

  Sequencing is forced, not chosen: scoped authority cannot exist
  without per-token identity, since the token is the ONLY identity
  signal (loopback gives no reliable caller id, and the protocol is
  stateless). B1 is therefore a prerequisite, not a convenience. The
  two gates stay independent and BOTH must pass: seatbelt decides
  whether the process can open the connection at all, the token
  decides what the request may do. Either alone is not a boundary.
- **Phase C (unscheduled): subscriptions / tasks extension.** Only
  after agent hooks give exact done signals; publishing heuristic
  settles on a stream is the `termic events` mistake, already ruled
  out.

## Testing

E2e rig (isolated `TERMIC_DATA_DIR`, fake-agent) plus:

- Stateless core: golden tests per method, legacy `initialize` path,
  `_meta` rejection matrix, header checks.
- Registry parity: `help --json` and `tools/list` render from one
  source; drift = red.
- Phase A boundary: no token -> 401 with no information; wrong token
  -> same; any request with an Origin header -> rejected, no CORS
  headers in any response; `cli-token` is not accepted as
  `mcp-token`.
- Sandbox, behavioral: in an Enforce cage without the checkbox, the
  MCP port refuses; with it, the MCP port connects and every OTHER
  loopback port still refuses. A scoped token cannot call full-scope
  tools, target outside its project list, send to a less-caged
  target, create a less-caged child, or read other tasks. The
  hostile-ancestor-allowlist fixture reruns against the token file
  invariants.
- Record the serialized scoped `tools/list` size in a test so surface
  growth is a conscious diff.

## Traps

- Listener on its own thread; blocking tools park on the cli_server
  condvar machinery. No sync IO near the WKWebView loop.
- `pty_spawn` copies the app env into every child. The full token
  must never enter the app env; scoped tokens enter exactly one
  task's overlay. Behavioral tests, not reasoning.
- Effective vs stored capability (EnforceFs = all hosts). Any subset
  check on stored lists is an escape.
- The MCP surface never grows logic the app doesn't have: no merge
  orchestration, no offline reads, no direct data-file access.
- CSP untouched; the listener adds no webview egress.
- Spec is days old, SDKs are betas. Pin the revision string; nothing
  in Phase B1/B2's security depends on the spec (tokens and seatbelt
  are ours), so spec churn can't weaken the boundary.

## Phase A landing notes (2026-08-10)

Decisions settled at implementation time (mcp_server.rs):

- **Registry.** "Generated from the same metadata" landed as one source
  per surface plus a drift gate: the MCP tool table is hand-written
  (machine_help() carries no types/enums, so JSON Schemas needed hand
  annotation regardless), and a src-tauri DEV-dependency on termic-cli
  asserts every tool, param, and full-scope verb against machine_help()
  in `mcp_registry_matches_machine_help`. Drift = red; runtime deps
  unchanged (the app still never links clap or the socket client).
- **Port stability, and its limit.** The bind prefers the last
  advertised port (from the in-run handle or the mcp-port file) so
  client configs survive toggle cycles and restarts. It does NOT fall
  back to a fresh port when that one is taken: it refuses to serve and
  takes the advertisement down. Falling back looks like the safe
  option and is the dangerous one, because a client config still holds
  the OLD url next to a helper that reads the CURRENT token file, so
  the next client start would hand a valid token to whatever process
  answers there. A port is only ours while we hold it.
- **Token stability: tried, then reversed.** A bind used to ADOPT a
  well-formed 0600 mcp-token so a pasted config survived a relaunch.
  Review found the hole: the token and port files persist across a
  crash while the port itself frees, so another local user can bind
  that port, collect the bearer from the next client that connects, and
  still hold a valid credential once we relaunch and adopt the same
  one. It defeats the cross-uid boundary the threat model rests on, and
  no amount of file permissions helps, because the client hands the
  token to whoever answers the port. Now minted fresh on every bind: a
  credential is never older than the binding that vouches for it. The
  ADDRESS is still kept stable, and the setups the settings page shows
  read the token from its file at connect time, so config stability
  survives without the credential outliving its port.
- **Client registration: superseded by the one-setup-rule note below.** The
  first shape had each client hold the NAME of an environment variable
  (`codex mcp add --bearer-token-env-var`, and a placeholder header for
  claude). It was replaced once minting per bind made any stored value
  wrong, and once codex turned out to read bearer tokens only from the
  environment, which would have meant a shell edit to use an MCP server.
- **Client reality, measured 2026-08-20.** Codex 0.148.0 (latest stable)
  defaults to revision 2025-06-18 and is refused; opting in through
  `[features] mcp_2026_07_28 = true` it speaks 2026-07-28 and completes
  discover -> tools/list -> tools/call against this endpoint. That opt-in
  is GLOBAL to codex, not per server: a server entry holds no protocol
  field and `codex mcp add --enable` persists nothing. It enables
  modern-era support generally; codex still resolves era per server.
  Claude Code 2.1.238 speaks 2026-07-28 natively with NO flag: measured
  through a logging proxy, it sends server/discover, tools/list and
  tools/call with header and body version agreeing, and completes a real
  tool call. Both shipping clients therefore work today, so the
  one-revision decision holds. The `initialize` refusal stays a
  diagnostic for anything still on the legacy era, never a negotiation,
  since a legacy client has no fall-forward.
- **The credential can arrive in `X-Termic-Token`, not only
  `Authorization`.** Codex reads bearer tokens from an environment
  variable and nothing else, and its per-server `http_headers_helper`
  refuses `Authorization` outright ("returned a reserved header"). Using
  it would therefore force every user to edit a shell profile to run an
  MCP server, which no other MCP server asks for. A non-reserved header
  lets that helper read the 0600 file at connect time: no variable, no
  shell edit, and no copy of the credential in any client config, which
  is strictly better custody than the env-var route it replaces. Same
  token, same constant-time compare, and if anything safer against
  browser JS, since a custom header cannot be set cross-origin without
  a preflight this server never answers. A deliberate local extension to
  the spec's auth guidance, for a loopback endpoint where we own both
  ends.
- **One setup rule, and a button (2026-08-21).** Both clients now run
  the SAME shell command to read the 0600 token file at connect time,
  differing only in config syntax (codex `http_headers_helper` in TOML,
  claude `headersHelper` in JSON, both verified against the real
  clients). This follows from minting per bind: once the credential
  rotates, anything that pastes the VALUE is wrong, and the page used to
  tell claude users to do exactly that. Settings also registers the
  server for you: claude through its own `mcp add-json`, because
  ~/.claude.json is written by every running session and its CLI is the
  only thing that takes the lock; codex by editing config.toml after a
  backup, since its `mcp add` cannot express a headers helper and `-c`
  overrides do not persist. That edit goes through toml_edit, NOT text
  manipulation: a line scan cannot see a quoted table header or a dotted
  key, so it appended a second definition of our table and produced TOML
  that does not parse, which makes codex refuse its whole config rather
  than just our entry. A config we cannot parse is refused rather than
  overwritten. The pasted blocks remain as the fallback.
- **Dual-era: not needed (settled 2026-08-21).** Both shipping clients
  reach the endpoint on the modern revision, so the case for serving the
  legacy era has gone: claude needs nothing, codex needs one feature
  line it will presumably default on. The option stays open and the spec
  sanctions it; revisit only if a client we care about is stuck on the
  legacy era, since no client-side setting can rescue one.
- **Phasing split.** Phase B became B1 (token identity) and B2
  (sandbox). Working through real client setup made the dependency
  explicit: the token is the only identity signal available, so scoped
  authority is impossible without per-token identity, and the registry
  is a prerequisite rather than part of the sandbox work. B1 also pays
  for itself alone by delivering the credential to agents in uncaged
  tasks. See Phasing.
- **Destructive tools.** task_apply, task_archive, project_remove ship
  in Phase A with `destructiveHint` annotations; possession of the
  full-scope token is the consent model (the CLI's --yes equivalent).
- **One revision, no legacy era.** 2026-07-28 or nothing (product
  decision: the handshake revisions are stateful and cost tokens we do
  not want to spend). That was made when the consequence was severe,
  and it was stated plainly rather than buried: at the time no shipping
  client could connect. It has since cost nothing, because both
  shipping clients now speak the revision (see Client reality). Judge
  the call on what was known then, not on how it turned out.
- **Standard headers: strict.** `Mcp-Method` on every request and
  `Mcp-Name` on `tools/call`, body-matching, with the `=?base64?...?=`
  sentinel decoded before comparison. Refusals are -32020.

## Open questions

1. ~~Which agent CLIs speak streamable-HTTP MCP as clients today?~~
   ANSWERED, and the answer moved twice in ten days. On 2026-08-11
   `claude` 2.1.228 was legacy-only (opened with `initialize` declaring
   2025-11-25), so the endpoint was reachable by nothing. On 2026-08-21
   `claude` 2.1.238 speaks 2026-07-28 with no opt-in, and codex 0.148.0
   speaks it behind `[features] mcp_2026_07_28`; both were verified
   against the live endpoint through a logging proxy, and both complete
   discover -> tools/list -> tools/call. The standing lesson is that
   client support is a moving target: re-probe rather than reasoning
   from the last answer, with that proxy plus
   `claude -p --strict-mcp-config --mcp-config '{...}'`.
2. Does caged `task_new` ship in Phase B2 v1, or does scoped v1 start
   with send/wait/reads and add create after field experience?
