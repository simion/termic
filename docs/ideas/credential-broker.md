# Credential broker

**This is an IDEA, not a plan.** Nobody has committed to building it and
it has no tracking issue.

Let an agent USE a credential without being able to SEE it. The agent's
env holds a placeholder; Termic swaps in the real secret on the way out,
and only for the hosts that credential is bound to. Which agent gets
which credential is defined once, as policy, so there is no per-request
approval prompt.

## The hard requirement

Neither the agent NOR the tool it runs may hold the real secret. A tool
that holds a token will hand it over: `gh auth token` prints it, and so
does reading the tool's config or env. So `gh auth token` inside a task
must print a placeholder, and the only thing that ever sees the real
value is Termic, on its way to a bound host.

That rules out every "give the agent a weaker token" design:

- **Fine-grained PATs / scoped tokens injected as `GH_TOKEN`.** Smaller
  blast radius, but the agent can read and exfiltrate the token.
  Rejected.
- **GitHub App installation tokens.** Expire in an hour, but still
  readable, and setting up an App per user is too much work. Rejected.
- **Termic does the forge work itself** (`forge.rs` over the control
  plane). Meets the requirement, but takes general `gh` away from the
  agent. A fallback, not the design.

Substitution in transit is the only design that meets it.

A second constraint: **no change to the user's system trust.** Trusting
a Termic CA in the login keychain would make Go CLIs on macOS accept the
broker (see "Go on macOS ignores the CA env vars"), but macOS has no
per-process trust store, so the trust is user-wide: every process the
user runs, caged or not, would accept that CA. A name constraint narrows
it and a non-exportable key guards it, but the sandbox must not share a
trust layer with the user's own machine. Rejected, and not tested,
because no result would make it acceptable.

## Mechanism

1. The agent's env (or a per-task config the tool reads) holds a
   placeholder, `termic_ph_<random>`. The real secret stays in the
   Keychain.
2. The tool's traffic reaches Termic by one of three transports (below).
   Everything not bound to a secret passes through as today.
3. For a bound host, Termic swaps the placeholder for the real secret
   and sends the request upstream over TLS it verifies normally.
4. The placeholder sent anywhere else is substituted nowhere, so stealing
   it is worthless.

Two rules the substitution step must keep:

- **Substitute in one fixed spot per recipe** (gh: `Authorization`;
  git and registries: the password inside Basic auth), never wherever
  the placeholder turns up. Otherwise the agent puts it in a header a
  bound host echoes back (any echo or debug endpoint) and reads the
  real value from the response.
- **Never follow redirects.** The broker returns a 3xx to the client
  as-is. If it followed one itself, the credential would go to whatever
  host the redirect names.

Secrecy comes from never handing the secret over, not from the network
cage: an agent that bypasses the broker simply has no credentials. It
does need an FS cage (EnforceFs, Enforce, or Docker) so the store is out
of reach.

What it does not solve: a prompt-injected agent can still do anything
the credential allows on the bound host while the task runs. Fine-grained
tokens and role rules are where least privilege still comes from. Some
calls also answer with a NEW credential, which the agent then holds and
keeps after the task:

- AWS: `sts assume-role` / `get-session-token` /
  `get-federation-token` return real keys in the body;
  `ecr get-login-password` and `codeartifact get-authorization-token`
  return registry passwords; `iam create-access-key` mints a permanent
  key.
- GitHub: adding a deploy key or an SSH key to the account; the agent
  holds the private half.
- Registries: the bearer token exchange (see "oras").

The registry exchange is handled by rewriting the response. The rest is
open (see "Open questions").

What exists in Termic already:

- a per-task in-process CONNECT proxy (`src-tauri/src/proxy.rs`), so a
  placeholder is only meaningful inside the task it was issued to
- a Seatbelt cage that keeps the agent away from the Keychain and the
  tools' own credential files
- per-task env injection at spawn, and spawn-time resolution of merged
  global + project + task settings (`live_sandbox_lists`), the same
  layering a task's role resolves through (task, project, agent)
- the sandbox deny popover, which the Secrets popover copies

## Transports

Most of the broker is shared by every tool:

- credential store (Keychain) and the grant model
- per-task placeholders and their binding (socket or port, peer check)
- the broker core: parse, bound-host check, substitute, verified
  upstream TLS, allowlist, audit log
- the rules in "Security"

What varies per tool is only how it reaches the broker. Three transports
cover most tools:

| Transport | Shape | Works for | Breaks on |
|---|---|---|---|
| MITM (`HTTPS_PROXY` + CA) | today's CONNECT proxy, intercepting bound hosts | curl, Python, Node with proxy env, git (verified, URL-scoped `sslCAInfo`), oras (verified, `--ca-file` via a PATH wrapper) | Go/Rust clients using the macOS verifier with no CA flag, on Seatbelt |
| Base-URL override | tool's API base points at a plaintext Termic endpoint that forwards upstream | any SDK/CLI with a base-URL knob (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `AWS_ENDPOINT_URL` (verified for the AWS CLI), kubeconfig `server:`) | tools with no knob |
| Unix socket | tool speaks plaintext HTTP down a socket | gh (`http_unix_socket`), docker CLI (`DOCKER_HOST=unix://`) | most else, few tools have the knob |

The base-URL override needs no CA, so it reaches Go/Rust on macOS where
MITM cannot; `kubectl proxy` is precedent for the shape.

Adding a tool is then a RECIPE, not code: which transport, the env or
config to write, the bound hosts, where the placeholder goes. gh's
recipe is "socket, `config.yml` in `GH_CONFIG_DIR`, `GH_TOKEN`
placeholder, `api.github.com`". The first tool pays for the core and
one transport, the second probably pays for a second transport, and
after that most additions are recipes.

Not portable: SSH keys (a filtered ssh-agent, separate component),
DB wire protocols, AWS presigned URLs and SigV4a (see "AWS SigV4"), and
any Go CLI with no socket or base-URL knob (each one has to be checked
the way gh was).

TLS details for the MITM transport:

- Per-task CA minted in memory, name-constrained to that task's bound
  hosts (`rcgen` + `rustls`; both work over the proxy's sync
  `TcpStream`s, no tokio).
- Advertise only `http/1.1` on the client side so the proxy never parses
  h2. Rewrite headers only, never bodies.
- Upstream verification uses the platform verifier so corporate CAs keep
  working.

## Security

### The socket transport

The plaintext hop is not the risk. It only ever carries the placeholder
(the real token exists only on Termic's upstream TLS leg), a unix socket
is kernel-local IPC with nothing on the path to intercept, and the
bodies crossing it are data the agent already has. `ssh-agent` and
`docker.sock` are the same pattern: a plaintext local socket where
access to the socket IS the permission.

What does matter:

1. **The socket is a capability.** Whoever can connect gets the
   substitution, and by default that is any process running as the user.
   Bind it to the task: a per-task path only that task's Seatbelt profile
   may reach, mode `0600`, a peer check (`getpeereid` /
   `LOCAL_PEERPID`, refuse anything outside the task's process tree),
   and substitution only for that task's own placeholder. This is
   stronger than today's loopback TCP proxy, which any local process can
   reach.
2. **The broker routes, the client does not.** gh sends everything down
   the socket and `Host` is client-controlled. Substitute only when the
   broker itself is dialing a bound host; refuse or allowlist-check
   everything else, or the socket becomes an egress path around the cage.
3. **Parse strictly.** One request per connection (gh already disables
   keep-alive), reject ambiguous `Content-Length` / `Transfer-Encoding`,
   so a smuggled second request cannot inherit the token.
4. **Upstream is verified normally.** The broker runs outside the cage,
   so the platform verifier and the user's real trust store are correct
   there.

### Reading from the Keychain

Termic reads secrets from the user's existing Keychain items at the
moment of use and never stores them. What that implies:

1. **How Termic reads matters.** Reading through Security.framework
   from Termic itself gets a one-time "Termic wants to access
   gh:github.com" prompt; "Always Allow" adds Termic to that item's ACL
   for good, tied to Termic's code signature. Dev builds (`tauri:dev`)
   re-sign on every rebuild and re-prompt.
2. **Termic becomes a secret-handling process.** Real values pass
   through its memory per request:
   - `dlog` and the proxy's request logging must never write
     `Authorization` or decoded Basic auth.
   - The webview is outside the cage (sandbox.md "Known gap: the webview
     is outside the cage"): no Tauri command may ever return a secret;
     substitution lives entirely in Rust.
   - The CLI and MCP control planes must not read secrets or trigger
     substitution outside a task's own traffic.
   - Once on an item's ACL, any future Termic build reads it silently,
     so the update channel is a path to those secrets. Notarization and
     hardened runtime keep other processes out of Termic's memory; dev
     builds are weaker.
3. **The agent gets the token's full power** on the hosts it is bound
   to: it is the same token the host uses. Termic cannot attenuate a
   token; role rules are the only narrowing, and different power needs
   different tokens (different Keychain items).
4. **Coupling to other tools' storage formats.** gh wraps tokens as
   `go-keyring-base64:`; gh keeps an extra copy under an empty "active"
   account; git items key on protocol + host (+ path). A format change
   upstream breaks the secret (fail closed). Pin explicit accounts.
5. **Rotation.** Read at use (or cache briefly) so a host re-login
   takes effect. Never refresh OAuth tokens from Termic: with rotating
   refresh tokens, refreshing one copy logs the other out.
6. **Availability.** A locked login keychain (sleep, SSH session) fails
   requests closed; agents see 401s and may thrash. Many agents starting
   at once can trigger a burst of prompts, which trains "Always Allow"
   on anything.
7. **Writes from inside the cage** (`gh auth login`, `git credential
   approve`) cannot reach the Keychain. Termic must never write a
   placeholder back into the user's real gh config or Keychain item;
   only the per-task `GH_CONFIG_DIR` gets one.

## UX model

Guiding rule: easy to use, hard to misuse.

**Names.** The feature is **Secrets**, not "Credentials": Termic already
uses "Credentials" for agent logins (the account switcher). A bundle of
secrets is a **Role**, a working name ("Profile" is taken too).

**The model.**

- **Secret**: a name, one Keychain item (service AND explicit account,
  never gh's empty "active" slot, so `gh auth switch` on the host cannot
  change what agents get), the hosts it may reach, and how it is
  delivered (gh socket, git proxy, oras proxy, AWS re-sign, base URL).
  Termic never stores the value; it reads the item at use.
- **Role**: a set of secrets plus optional rules (method/path allow
  and deny on HTTP, fetch vs push on git). Rules live on the role, not
  the secret, so one token can serve a strict role and a loose one.
- **One role per task.** Any number of tasks share a role: N tasks as
  Reviewer on one GitHub token, M as Maintainer on another.
- **Which role a task gets**, first match wins: the task's own pick
  (New Task, switchable from the task footer), then the project's
  default (project settings), then the agent's default (Agents &
  Terminals), then **No secrets**, which is where everything starts.
- `.termic.yaml` may REQUEST secrets by name and suggest a default
  role. It cannot define a secret, point at a Keychain item, or loosen
  a role's rules, so a commit cannot grant itself access. A teammate
  missing a requested secret sees "Missing secret: <name>" on the task,
  not a silent 401.

**No cage, no secrets.** Roles exist only for caged tasks (Enforcing,
Enforcing (FS), Docker). With Sandbox off or Monitoring the agent can
read the Keychain itself, so there is nothing to broker:

- New Task greys out the role picker unless a caging sandbox card is
  selected.
- Project and agent default roles do not apply to an uncaged task; it
  runs with No secrets.
- Switching an existing task to Off or Monitoring clears its role
  (same dialog that already warns about restarting).
- There is no "role but exposed" state to show, because it cannot
  exist.

**Aux terminals and scripts get the real login.** Only the agent PTY is
caged (setup, run, archive scripts and AuxTerminal are not), so only
agent tabs get placeholders. In the same task, the user's terminal sees
the real gh login and the agent's sees a placeholder. Those processes
are the user's, not the agent's.

**Feedback loop**, modelled on the sandbox deny popover:

- Sidebar task rows carry a key in the role's colour; no key means No
  secrets. Red key: something in the task tried to misuse a secret.
- The task footer gets a Secrets chip (role name plus a count of
  blocked or suspicious events) next to the sandbox chip. Its popover:
  - **Blocked by role rules**: each with Allow.
  - **No secret for this host** (upstream answered 401 for a host no
    secret in the role covers): each with Grant.
  - **Used**: what was brokered, per secret and host.
  - **Suspicious**, red, never allowable: a placeholder sent to a host
    outside its secret's list (not swapped, request blocked), a
    direct Keychain lookup denied by the cage.
  - **Exposed outside the broker**, warn: a real-looking token in an
    agent's env (e.g. `GITHUB_TOKEN=ghp_...` in Agents & Terminals),
    with "Move to a secret".
  - The same "saving to" scope box as the deny popover: this task, the
    role, or `.termic.yaml` (request by name only).
- A rule denial never leaves Termic: the agent gets a 403 naming the
  role and rule, which agents read and work around (e.g. reviewing
  instead of merging).
- Allow applies to the next request with no restart, because the
  broker is in-process. (Sandbox allows still need a restart.)
- Grant usually needs a restart. Granting a secret is only live if its
  delivery was set up at spawn: a running agent cannot gain a new env
  var (`GH_TOKEN`), a `GH_CONFIG_DIR/config.yml`, or the `oras` wrapper
  on its PATH. See "Open questions".
- Settings → Secrets has health cards: how many secrets are readable
  (e.g. a locked keychain), and any agent with a real token in its env.

**Rejected: a role per tab.** E.g. one claude tab writes and pushes as
Maintainer while another in the same task reviews as Reviewer. The
broker could do it (placeholders, sockets and the peer check bind to a
process tree, and each tab is its own spawn), but the boundary would be
fake. Tabs share the worktree, so the weaker tab can drive the stronger
one:

- plant a `pre-push` hook, which runs in the Maintainer tab's cage with
  its credentials on the next push
- edit a Makefile, `package.json` script or test the Maintainer runs
- leave a file of instructions the Maintainer agent reads and follows
- change the code the Maintainer later pushes

The filesystem is the real boundary, and in Termic that is the task
(one worktree), so roles stop there. Per-tab roles would still catch
mistakes (a Reviewer tab cannot merge by accident), but they would read
as security, which fails "hard to misuse". Instead: review in a second
task, its own worktree on the same PR (`gh pr checkout`, or detached at
the same commit) with the Reviewer role. If that proves too much
friction, the fallback is a tab that may NARROW the task's role, never
widen it, labelled as accident protection rather than security. Not
worth building until someone needs it.

## Tools

### gh

#### Go on macOS ignores the CA env vars (spike, 2026-10-06)

The MITM transport assumes clients can be told to trust the per-task CA
through env (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, ...). That holds for Node,
Python, curl and git. It does NOT hold for Go binaries on macOS, and
`gh` (and `terraform`, `kubectl`, `glab`, `oras`) are Go.

Spike: a stub CONNECT proxy that MITMs every host with a throwaway CA and
answers with canned JSON, never talking upstream. `gh` 2.97.0 (Go 1.26.5),
isolated `GH_CONFIG_DIR`, `GH_TOKEN` set to a placeholder, `HTTPS_PROXY`
pointed at the stub:

| Config | Result |
|---|---|
| curl `--cacert ca.pem` (control) | OK, stub JSON returned |
| gh, no CA env | `x509: certificate signed by unknown authority` |
| gh, `SSL_CERT_FILE=ca.pem` | same failure |
| gh, `SSL_CERT_DIR=<dir with ca.pem>` | same failure |

gh does honour `HTTPS_PROXY` (the stub saw every handshake), so routing
is not the problem. Go's darwin verifier goes through Security.framework
and only consults the env vars on other Unixes.

Escape hatches checked:

- **`GH_HOST=github.localhost`.** gh's dev host speaks plain HTTP, so
  there is no TLS to trust: the stub received `Authorization: token
  termic_ph_...` in clear, ready to substitute. But inside a repo whose
  remote is `github.com` gh refuses ("none of the git remotes configured
  for this repository correspond to the GH_HOST environment variable"),
  and that is every repo an agent works in. Rewriting remotes to match
  would drag git push into the same hack. Dead.
- **System trust.** Rejected (see "The hard requirement").

So MITM cannot reach Go CLIs on macOS Seatbelt unless the tool has its
own CA flag (oras does, see "oras"). gh uses the socket transport
instead. Other Go CLIs (`terraform`, `kubectl`, `glab`) each need their
own answer.

#### `http_unix_socket` (spike, 2026-10-06)

gh has a long-standing config key, `http_unix_socket` ("the path to a
unix socket through which to send HTTP connections"). go-gh builds that
transport with `DialTLS` set to the plain unix dial
(`newUnixDomainSocketRoundTripper` in `cli/go-gh` `pkg/api/http_client.go`),
so net/http treats the socket as already secured and writes PLAINTEXT
HTTP down it, even for `https://api.github.com/...`. No TLS on the gh
side means no certificate to trust, and no trust store is touched.

So per task: Termic writes a `config.yml` with `http_unix_socket` into
the task's `GH_CONFIG_DIR`, sets `GH_TOKEN` to a placeholder, and listens
on that socket. The broker reads the plaintext request, substitutes the
token when `Host` is a bound host, and forwards it upstream over real
TLS that Termic verifies normally.

Verified against stock gh 2.97.0, with a stub broker on the socket and
`HTTPS_PROXY` pointed at a dead port so any request that skipped the
socket would fail loudly:

- `gh api user`, `gh api graphql`, `gh api 'repos/{owner}/{repo}'`
  inside a repo with a `github.com` remote, `gh pr list`, `gh repo view`,
  `gh issue list`, `gh pr view`, `gh release list`, `gh auth status`:
  every request arrived on the socket as plaintext with
  `Host: api.github.com` and `Authorization: token termic_ph_...`. None
  tried the network.
- `gh auth token` printed the placeholder.

Properties:

- **Fails closed.** If the agent rewrites the config or points
  `GH_CONFIG_DIR` elsewhere, gh goes direct with a placeholder and gets
  a 401. Nothing it can change hands it the real token.
- **Per-task socket**, so a placeholder only works through its own
  task's broker.
- gh sends ALL its traffic down the socket, not just the API: the broker
  must substitute only for bound hosts and pass everything else through
  untouched (Go already strips `Authorization` on cross-host redirects,
  e.g. release downloads).
- macOS caps a socket path at ~104 bytes. A path under the scratch dir
  failed with `bind: invalid argument`, so the socket needs a short home.
- Seatbelt must allow connecting to that one socket path.

Not yet verified:

- Commands the `api_host` work lists as building their own clients
  (`gh codespace`, `gh agent-task`, `gh copilot`, the update checker).
  Worst case they fail closed.
- A real upstream round trip; the spike never left the machine.

git push/fetch does not use gh's transport; see "git".

#### Upstream (researched 2026-10-06)

- [cli/cli#1735](https://github.com/cli/cli/issues/1735), open since
  2020: custom CA support. A maintainer floated a `GH_CERT_PATH`-style
  env var in go-gh (2025-08), not committed to.
- [cli/cli#13676](https://github.com/cli/cli/issues/13676): asks gh to
  honour `SSL_CERT_FILE` on macOS (loading it into `RootCAs` switches Go
  to its own verifier), naming agent sandboxes that block `trustd`.
  Closed as a duplicate of #1735, so nothing has shipped.
- [cli/cli#8237](https://github.com/cli/cli/issues/8237): a way to stop
  `gh auth token` printing the token. Open, no plan.
- [cli/cli#13032](https://github.com/cli/cli/issues/13032) and
  [#12912](https://github.com/cli/cli/issues/12912): scoped auth and a
  policy surface for AI agents. Open, backlog.
- [cli/cli#14104](https://github.com/cli/cli/pull/14104), merged: per-host
  `api_host` to route API traffic through a gateway. Not usable here:
  it takes a bare hostname (no scheme, no port) and still speaks HTTPS,
  so the trust problem comes back.

Nothing upstream solves this today; `http_unix_socket` is the existing
feature that does.

### git (spike, 2026-10-06)

Apple git 2.50.1 (`Apple Git-155`, libcurl on LibreSSL), a stub broker
that challenges with Basic 401 and logs what comes back, never upstream.
The credential helper is replaced by one that answers with the
placeholder, set through env-only config (`GIT_CONFIG_COUNT/KEY/VALUE`,
no file), with an empty `credential.helper` entry first to reset the
list so `osxkeychain` is never consulted.

| Route | Result |
|---|---|
| MITM, no CA (control) | `SSL certificate problem: self signed certificate in certificate chain` |
| MITM + `SSL_CERT_FILE` | same failure; git ignores it |
| MITM + `GIT_SSL_CAINFO` | works: `Basic(x-access-token:termic_ph_PLACEHOLDER)` on fetch AND push (`git-receive-pack`) |
| MITM + `http.https://github.com/.sslCAInfo` (URL-scoped, env-only) | works |
| `url.<loopback>.insteadOf https://github.com/`, plaintext | auth arrives, BUT `git remote -v` / `get-url` now print the loopback URL and gh stops recognising the repo ("none of the git remotes ... point to a known GitHub host"). Rejected. |

**Decision: git goes through the existing CONNECT proxy as MITM, with
the CA handed over via URL-scoped `http.https://github.com/.sslCAInfo`.**

- git is not Go; libcurl reads a CA file, so no system trust is
  involved. The CA lives only in that task's git config env.
- `sslCAInfo` REPLACES the bundle rather than adding to it. Scoping it
  to `https://github.com/` keeps every other host on git's default
  verification, so a GitLab or corporate remote is unaffected.
- Remotes stay untouched, so gh, Termic's `forge.rs` and the agent all
  see the real `https://github.com/...` URL.
- The broker decodes Basic, swaps the password if it is the task's
  placeholder, re-encodes. Username is irrelevant to GitHub with a token.
- gh and git use different transports (socket vs MITM) but the same
  credential, placeholder and grant.

Not covered:

- **SSH remotes.** A different mechanism entirely: a per-task
  `ssh-agent -a <sock>` outside the cage holding the key, loaded with
  `ssh-add -h github.com` (OpenSSH destination constraints), and
  `SSH_AUTH_SOCK` pointed at it. Use-without-see is native to the agent
  protocol. `~/.ssh` is already denied by the cage. Not spiked.
- Other forges' HTTPS remotes: same route, their own URL-scoped CA entry.

### oras (spike, 2026-10-09)

oras (OCI artifacts to and from registries) is Go, so on macOS it
ignores `SSL_CERT_FILE` like gh. Unlike gh it has a `--ca-file` flag,
which loads the CA into its own `RootCAs` pool; a non-nil pool makes Go
use its own verifier instead of the macOS one (the fix gh users asked
for in cli/cli#13676, already built into oras). So oras goes through
the existing CONNECT proxy as MITM, like git, not through a socket.

Spike: oras 1.1.0 (Go 1.21), `HTTPS_PROXY` at the MITM stub (throwaway
CA, Basic 401 challenge, logs auth, never upstream), placeholder
credentials in a docker-format `config.json`:

| Setup | Result |
|---|---|
| no CA (control) | `x509: certificate signed by unknown authority` |
| `SSL_CERT_FILE=<task CA>` | same failure |
| `--ca-file <task CA>` | works: `Basic(x-access-token:termic_ph_PLACEHOLDER)` to `ghcr.io` |
| `DOCKER_CONFIG=<task dir>`, no auth flag | works: oras reads the placeholder from `$DOCKER_CONFIG/config.json` |

Recipe:

- `DOCKER_CONFIG` points at a per-task dir whose `config.json` holds a
  placeholder `auth` for the registry. Env-only, like `GH_CONFIG_DIR`.
- `--ca-file` has no env equivalent, so the task's PATH gets a small
  `oras` wrapper that adds `--ca-file <task CA>`. Calling the real
  binary directly just fails TLS: fails closed.
- Bound hosts: the registry, plus its token endpoint when that is a
  different host.

**Token exchange, required and untested.** Real registries (ghcr.io,
Docker Hub) do not take the password per request: the registry answers
401 with `WWW-Authenticate: Bearer realm=...`, the client sends Basic
auth to that token endpoint, and gets back a short-lived bearer token
scoped to the repo. Swapping only the Basic placeholder would hand the
agent that real bearer token, which breaks the hard requirement. The
broker must also rewrite the token response (real bearer out, a second
placeholder in) and swap it back on registry calls. Both hosts are
bound, so this is possible, but the stub only did a Basic challenge.

Blob downloads redirect to presigned CDN URLs that need no secret; they
pass through untouched (under Enforce, their host must be on the
network allowlist).

On the host, registry logins usually live in
`docker-credential-osxkeychain` items. A secret points at that item like
it does for gh and git.

### AWS SigV4 (spike, 2026-10-06)

SigV4 never sends the secret: the client derives a key from it and signs
a canonical request (method, path, query, signed headers, payload hash).
So a header swap is impossible; the broker has to **discard the
client's signature and re-sign** with the real credentials. The agent's
SDK holds a placeholder access key ID and a placeholder secret, and
signs garbage that the broker throws away.

Transport: **base-URL override**, no CA. `AWS_ENDPOINT_URL` (honoured by
the AWS CLI and current SDKs) points at a plaintext Termic endpoint.

Spike: aws-cli 2.34.37 (Python), placeholder creds,
`AWS_ENDPOINT_URL=http://127.0.0.1:<port>` at a logging stub:

| Call | What arrived |
|---|---|
| `sts get-caller-identity` | `Credential=TERMICPH.../us-east-1/sts/aws4_request`, `SignedHeaders=content-type;host;x-amz-date` |
| `s3 ls` | path-style `GET /acme-bucket`, `x-amz-content-sha256` = hash of empty body |
| `s3 cp` 1 KiB (PutObject) | full SHA-256 in `x-amz-content-sha256`, plus `x-amz-checksum-crc64nvme` |
| `s3 cp` 20 MiB (multipart) | each UploadPart carries a plain per-part SHA-256; no `aws-chunked`, no signed streaming chunks |
| `s3 presign` | URL built entirely client-side with the placeholder; the broker never sees it |

What that means for the broker:

- **Routing comes free.** Region and service are in the credential scope
  of every request, so the broker knows the real endpoint
  (`<service>.<region>.amazonaws.com`, with a small exceptions table for
  global services like IAM and STS). With a custom endpoint the CLI uses
  path-style S3, which the broker forwards as-is.
- **Re-signing is header-only.** The client already put the payload hash
  in `x-amz-content-sha256`; the broker signs with that value and
  streams the body through without buffering it. A client that lies
  about the hash only breaks its own request, because AWS checks the
  body against it.
- Signed headers like `x-amz-checksum-*` are forwarded and re-signed.
- The placeholder access key ID identifies the task and grant, the same
  role `GH_TOKEN`'s placeholder plays.
- Signing library: `aws-sigv4` from the official Rust SDK
  (`awslabs/aws-sdk-rust`). Prior art for the exact shape:
  [awslabs/aws-sigv4-proxy](https://github.com/awslabs/aws-sigv4-proxy),
  a proxy that signs requests with its own credentials.

Limits:

- **Presigned URLs cannot work.** They are signed offline with the
  placeholder and handed to something else (a browser, curl, a third
  party), which never goes through the broker.
- **Signed streaming uploads** (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`)
  chain a signature through every chunk; re-signing those means
  rewriting the body. The Python CLI did not use them over plain HTTP,
  but other SDKs might: reject them, or re-sign chunks.
- **SigV4a** (S3 multi-region access points) uses ECDSA; needs its own
  signer.
- Not verified against real AWS; the stub never went upstream. A real
  round trip (re-signed `sts get-caller-identity`) is the next check.

#### Go-based AWS tools (spike, 2026-10-06)

Same stub, plus a trap on `HTTPS_PROXY`/`HTTP_PROXY` that logs any
request bypassing the endpoint. terraform 1.16.5 + hashicorp/aws 6.67.0,
aws-sdk-go-v2 v1.47.1, s5cmd 2.3.0 (SDK v1), rclone 1.75.1.

Across all of them: every PutObject and UploadPart carried a real hex
SHA-256 in `x-amz-content-sha256`. No `aws-chunked`, no `STREAMING-*`,
no trailers, no SigV4a, no forced virtual-hosted addressing.

| Tool | Verdict | Notes |
|---|---|---|
| terraform + aws provider | works as-is | `AWS_ENDPOINT_URL`, per-service `AWS_ENDPOINT_URL_<SVC>`, or an `endpoints {}` block all work, path-style automatic. The provider calls STS GetCallerIdentity at setup: cover STS too, or set `skip_credentials_validation` + `skip_requesting_account_id`, else STS escapes to the network. |
| aws-sdk-go-v2 (what most Go tools inherit) | works, one client-side exception | Files and the `manager`/`transfermanager` uploaders hash every part. A single `PutObject` from an UNSEEKABLE stream fails in the SDK before sending ("unseekable stream is not supported without TLS and trailing checksum"): over plain HTTP it cannot hash it. The broker never sees the request. |
| s5cmd | works with its own knob | SDK v1 ignores `AWS_ENDPOINT_URL` (the PUT escaped to `acme-bucket.s3.us-west-2.amazonaws.com`); needs `S3_ENDPOINT_URL` or `--endpoint-url`. Without `AWS_REGION` it probes `HEAD /bucket` in us-east-1 and reads `x-amz-bucket-region`, so the broker must pass that header back. |
| rclone | multipart works; single-part PUT needs settings | It wraps bodies in a non-seekable reader, so single-part PUT hits the SDK exception above. Fix: `--s3-provider Other`, or `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` + `--s3-use-unsigned-payload=true`; it then sends `UNSIGNED-PAYLOAD`. |

Broker requirements this adds:

- **Non-S3 services send no `x-amz-content-sha256`** (STS arrived with
  it empty and unsigned). The broker hashes those bodies itself; they
  are small form/JSON bodies, so buffering is cheap. Only S3 relies on
  reusing the client's hash.
- **Pass `UNSIGNED-PAYLOAD` through** unchanged when a client sends it;
  S3 accepts it over the broker's HTTPS upstream.
- **Handle `Expect: 100-continue`** (terraform and s5cmd UploadParts).
- **Pass `x-amz-bucket-region` back** for region discovery.

#### EKS and RDS auth (researched, not run)

`aws eks get-token`, aws-iam-authenticator and terraform's
`aws_eks_cluster_auth` presign an STS GetCallerIdentity URL offline
(fixed STS host, signed `x-k8s-aws-id`, 60s expiry) and send it as a
`k8s-aws-v1.` bearer token; the EKS control plane, not the client, calls
STS with it, so the broker never sees the request. Same for RDS IAM auth
tokens (`generate-db-auth-token`). The only route is Termic minting the
token itself with the real credentials (e.g. a kubeconfig exec helper),
which hands the agent a ~15 minute bearer token: a deliberate tradeoff,
not a transparent fix.

Rejected alternative: serve STS temporary credentials through
`AWS_CONTAINER_CREDENTIALS_FULL_URI` (the aws-vault model). Simple and
universally supported, but the SDK, and so the agent, holds working
credentials, which fails the hard requirement. Fine as a degraded mode
for a user who opts out of the requirement.

### Other credential kinds

| Kind | Approach |
|---|---|
| Bearer / API-key header | straight substitution |
| OCI registry (oras, docker) | MITM, substitute Basic on the token endpoint, and rewrite the bearer token response (see "oras") |
| git over HTTPS | MITM with a URL-scoped CA from env, substitute Basic auth (see "git") |
| SSH keys | per-task filtered ssh-agent socket (use without see, natively) |
| AWS SigV4 | base-URL override + broker re-signs (see "AWS SigV4") |
| DB wire protocols | out of scope |

## Docker mode

The trust problem does not exist here: a container has its own trust
store, separate from the host's. The per-task CA goes into the
container's bundle (`SSL_CERT_FILE`, or `update-ca-certificates` at
spawn), Linux Go honours it, and the host's trust is untouched. So MITM
reaches gh and oras directly (oras needs no wrapper), and
`http_unix_socket` also works by mounting the socket. gh holds only the
placeholder, and `DOCKER_CONFIG` carries oras's.

Work this needs, none of which exists today:

- Docker tasks routed through the proxy at all. They currently get the
  default bridge network with no `HTTPS_PROXY` ("network is
  unrestricted" in [sandbox.md](../sandbox.md)); the proxy has to be
  reachable from the container (`host.docker.internal`) and bound to
  that task.
- The per-task CA written into the container's trust store at spawn.
- The shared `.config/gh` mount (`docker_shared_config_dirs`) must hold
  no real token for a task with a bound GitHub credential, or gh just
  uses that instead. Same for registry logins: a container's docker
  config must hold only placeholders, or oras uses the real ones.

Not yet verified: gh and oras in a container accept a CA added this way,
and `gh auth token` prints the placeholder.

## Prior art (researched 2026-10-06)

Nothing found brokers gh on a macOS HOST without touching system trust.
Existing tools either move the agent into a VM, or trust a CA user-wide.

| Tool | Where the agent runs | gh on a Mac without system trust? |
|---|---|---|
| [nono](https://github.com/nolabs-ai/nono) | host, Seatbelt (closest to Termic) | **No.** Phantom `GH_TOKEN` + MITM, and for Go CLIs it installs its CA into the user trust store (`crates/nono-cli/src/macos_trust.rs`: "enables Go CLI tools (`gh`, `terraform`, etc.) that ignore `SSL_CERT_FILE`"). The CA has no name constraints. If the trust prompt is declined, Go tools simply fail. |
| [Infisical Agent Vault](https://github.com/Infisical/agent-vault) | anywhere, MITM proxy | **No.** Trust only via `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` / ...; same wall the spike hit. |
| [Docker Sandboxes (sbx)](https://docs.docker.com/ai/sandboxes/configuration/credentials/) | microVM on the Mac | **Yes, by moving into a VM.** gh and git see a sentinel; the proxy substitutes on `api.github.com`, `github.com` and friends. The VM's trust store is its own. Runs Claude Code. |
| [Gondolin](https://github.com/earendil-works/gondolin) | QEMU microVM on the Mac | **Yes, by moving into a VM.** Placeholder substituted host-side, including `Authorization: Basic` (git). Library/CLI, oriented at Pi, not Claude Code. |
| [octobroker](https://github.com/openabdev/octobroker) | broker service | Uses GitHub App tokens; rejected (see "The hard requirement"). |
| [Deno Sandbox](https://docs.deno.com/sandbox/security/) | hosted | Same placeholder model, not local. |

`http_unix_socket` as a gh proxying knob is known (an AI-generated
[research note](https://github.com/simonw/research/tree/main/github-cli-api-proxy)
lists it for "sandboxing/isolation"), but no tool found uses it for
credential substitution.

Older and adjacent:

- [Fly.io tokenizer](https://github.com/superfly/tokenizer): injects
  secrets the caller only holds encrypted, plus HMAC signing. Its
  [brute-force advisory](https://osv.dev/vulnerability/GHSA-f28g-86hc-823q)
  is relevant: a format parameter let a client recover the secret.
- Envoy's credential-injector filter, HashiCorp Boundary credential
  injection, and 1Password's SSH agent are the same idea at other layers.
  `op run` / Doppler are the counterexample: they resolve into env, which
  the agent can read.

## Open questions

- **Credential-minting calls** (see "Mechanism"). Options: a built-in
  deny list every role inherits and no Allow can lift (simple, but the
  list is never complete), or rewrite each response to swap the new
  credential for a placeholder (the oras approach; works, but needs a
  recipe per API). Likely both: rewrite where it is cheap (registry
  tokens, STS), deny the rest.
- **Grant without a restart.** Either always set up every delivery the
  role COULD use at spawn (placeholder env, gh config, wrappers), so a
  later Grant only flips broker state, or make Grant say "restart the
  agent to apply" like a sandbox allow. The first exposes which tools a
  role might reach in the agent's env, which is harmless.
- **Two secrets for one host in a role** (e.g. two GitHub tokens) is
  undefined. Proposal: one secret per host per role, enforced when the
  role is saved.
- **Where secrets not in the Keychain come from.** gh and git already
  keep tokens in the Keychain, so a secret just points at their item.
  AWS keys usually live in `~/.aws/credentials` (which the cage already
  denies) and API keys in env or files. Options: the user adds a
  Keychain item themselves (`security add-generic-password`); Termic
  offers "Add to Keychain", which means Termic writes after all, with
  an item ACL trusting Termic only; or Termic reads `~/.aws/credentials`
  at use, which keeps it write-free but makes a file the source of
  truth.
- **The agent's own API key.** Out of scope so far (the agent's own
  login is not what the broker protects), but `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` users could be brokered through `ANTHROPIC_BASE_URL`
  / `OPENAI_BASE_URL`, the base-URL transport. OAuth logins (claude
  `/login`) would not fit.
