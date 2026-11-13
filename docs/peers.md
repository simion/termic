# LAN pairing (Other computers)

**Status: reference, experimental.** Termic on two computers of one
network finds the other, pairs when a person types the four-digit code one
of them shows, and then lets an agent on one drive (or report back to) the
agents on the other.
It replaces the manual setup of binding the MCP endpoint to `0.0.0.0` and
copying the one master token across, which never rotated and could do
everything.

**Where this is going** (not decided): pairing becoming a live stream
that a phone app (#165) and other computers use to drive this one, and
later headless boxes (#82). That design is
[ideas/remote-control.md](ideas/remote-control.md). Everything below is
what ships today.

**Off by default.** Nothing listens, nothing is advertised, until the
user turns on Settings > Agent access > Other computers > "Share on this
network"
(`lan_sharing_enabled`). Turning it off unbinds the listener, sends an
mDNS goodbye, and cancels any pairing in progress.

Code: `src-tauri/src/peers.rs` (store, listener, pairing, forwarding),
`src-tauri/src/peer_crypto.rs` (every cryptographic step, pure and
tested), `src-tauri/src/mdns.rs` (discovery). UI:
`src/components/settings/PeersSection.tsx` and the global
`src/components/dialogs/PeerPairingDialog.tsx`.

## The shape

```
 Mac agent --termic --peer laptop new ...--> Mac Termic ==sealed HTTP==> Laptop Termic --> dispatch --> task
              (local socket or MCP)           (holds the pair key)  LAN   (checks the grant)
 Laptop agent --termic --peer mac send <id>--> Laptop Termic ==sealed==> Mac Termic --> agent's inbox
```

Agents never hold a credential for another machine. `--peer` and MCP
`peer_call` reach THIS app, which forwards the request sealed with the
pair's key. The other app runs it through the same
`cli_server::dispatch_authenticated` the CLI socket and MCP use: a peer
is a third presentation of the same verbs, never a second
implementation. The master MCP token is never involved.

## Discovery

- mDNS / DNS-SD, IPv4 only, on 224.0.0.251:5353, with `SO_REUSEADDR`
  (plus `SO_REUSEPORT` on unix) so it coexists with mDNSResponder,
  Windows' DNS Client and avahi.
- Service `_termic._tcp.local`, instance label `termic-<first 12 hex of
  the id>` (unique by construction, so no conflict probing). SRV carries
  the listener port; TXT carries `id`, `name` (capped at 63 bytes on a
  character boundary), `ver` (app version), `proto` (CLI wire protocol)
  and `pv` (peer protocol, currently 2). A records are informational.
- A peer's address is the SOURCE address of its mDNS answer, not its A
  record, so a machine with several interfaces is reached on the one we
  actually heard it on.
- One thread. It announces twice at start (0 s and 1 s), queries once,
  re-queries every 60 s (re-joining the group on any new interface on the
  same tick), and forgets a machine not heard for 180 s. It blocks in
  `recv_from` with a timeout equal to the time until the next scheduled
  action; there is no sleep-poll. Responses to queries are rate-limited
  to one per 500 ms. A goodbye (TTL 0) removes a machine at once.
- An answer is used only when one packet carries the PTR, SRV and TXT
  (with `id`) together. That interoperates with ourselves, which is all
  it needs to do.
- Nothing discovery says is trusted. It only proposes addresses; pairing
  and every call authenticate on their own.

**Pair by address** is the fallback for networks that drop multicast
(client isolation, corporate Wi-Fi, VPNs). The target is `ip` or
`ip:port`. With no port, the first six ports of the listener range
(23620-23625) are probed with `hello`, which covers a release, a beta and
a dev build on one machine.

## The peer listener

One TCP port on every interface, picked from 23620-23719 (below every
platform's dynamic range, clear of the MCP range under it), and the last
port is preferred on the next bind so a peer's remembered address keeps
working across restarts. Bound only while sharing is on; the setting is
re-read per request, so a switch-off also refuses connections racing the
unbind.

HTTP/1.1, one request per connection, everything under
`/termic-peer/v1`:

| Method + path | Auth | What |
|---|---|---|
| `GET /hello` | none | `{id, name, version, proto, pv, port}`: what the advertisement already says |
| `POST /pair/request` | none, rate-limited per address | opens pairing mode here, naming the asker |
| `POST /pair/start` | none, and only in pairing mode | step 1 of pairing (below) |
| `POST /pair/confirm` | sealed with the new key | step 2 |
| `POST /call` | sealed | run one verb |
| `POST /unpair` | sealed | forget the sender |

Pre-auth caps match the MCP endpoint: 16 KB head, 4 MB body grown from
bytes that arrive (never from the declared length), chunked encoding
refused, 10 s read and 30 s write timeouts, 32 connections at once. Any
request carrying an `Origin` header is refused with 403 before routing,
so a web page on any machine of the network cannot so much as open a
pairing dialog, and no response carries a CORS header.

## Pairing

**Click Pair, type the code the other screen shows.** Like Bluetooth. On
machine A the person clicks Pair on a computer under Nearby (or pairs by
address). A sends `POST /pair/request`; B opens pairing mode ON ITS OWN,
naming who asked (`pair_mode.requested_by`), and pops up a global dialog
(`PeerCodeDialog`, any screen) with a fresh four-digit code for 5 minutes and
a Decline button. A's row turns into "Type the code shown on B", and the
four digits submit on their own. Nobody opens anything on B first: an
earlier version made the person on B press "Show pairing code" before the
other side could pair, which was backwards. The request is unauthenticated
(nothing is shared yet), so it is limited: once per 5 s per address
(`REQUEST_COOLDOWN`), and an open mode is reused, never replaced, so a second
asker cannot swap the code under the first person. The code exists only on
B's screen, so the consent is still a person reading it; three wrong codes
still close the mode. The advert gains `pair=1` while it is open.

**A name on this side.** The after-pairing dialog asks "Name it on this
computer", starting from the name the other machine gives itself, and a
role chip (Orchestrator / Worker) fills it in unless one was
typed. It is LOCAL (`peer_rename`): the Mac stays "MacBook Pro" to itself
and to every other pair, and is "Orchestrator" to the Windows box, which is
the name agents there use for it (`--peer`, the MCP `peer` argument).
Messages follow it: an agent signs `peer:<its own name>` because that is
the only name it knows, so a prompt arriving from a pair has that name
after `peer:` (bare or quoted) rewritten to the local one
(`localize_signature`). The Windows box's report reaches the Mac signed
`peer:windows laptop`, not `peer:DESKTOP-DO50EUS`. Replying works with
either, since a selector finds a pair by both.

**A report back is delivered at once.** A `send` from a pair into a task
here that sent that pair work (its `contacts`) is the answer the task is
waiting for, so it gets `now` on arrival and skips the agent's queue
(`report_back_now`). New work going the other way, into a task that never
contacted the sender, follows the sender's choice (immediate unless it
passed `--queue`). Set by the
receiving Termic, not asked of the sending agent, which cannot tell the two
apart. Either machine can be B; both
can be in pairing mode at once. Leaving the Settings page closes it.

A machine that is NOT in pairing mode answers every pairing request with
403 `not_pairing`, and nothing appears on its screen. The person at B
opening pairing mode is the consent; the code only B's screen shows is the
proof that A's person can see it.

**SPAKE2** (the RustCrypto `spake2` crate, Ed25519 group, the exchange
magic-wormhole uses for short codes) with the code as the password and the
two instance ids as identities. A is side A, B side B.

1. **start.** A sends `{from: {id, name, version, proto, pv, port}, msg}`.
   B, in pairing mode, answers `{to: {...}, pairing, msg}` and holds the
   derived key for 30 s. Neither side knows yet whether the codes matched.
2. **confirm.** A sends `{pairing, env}`, its grant sealed under
   `pair key = HKDF-SHA256(salt "termic-pair-v2", ikm = SPAKE2 secret,
   info "termic-peer-v2|" id_a "|" id_b)`. The envelope opens only under
   the same key, which only the same code gives: that IS the check. B
   stores the pair, closes pairing mode, and replies sealed with its own
   grant; A opens it (same key, echoed `rid`) and stores the pair. Both
   sides raise the after-pairing dialog (`peer://pairing`), which asks what
   the other machine is for.
3. A wrong code: B's open fails, it answers 403 `wrong_code`, counts it,
   and refuses that address for 2 s. **Three wrong codes close pairing
   mode**; a new opening draws a new code.

**Why a PAKE.** A four-digit code is safe only when it never travels and
cannot be tested offline. SPAKE2 gives an attacker one online guess per
attempt: a man in the middle without the code holds neither side's key
(`peer_crypto::tests::a_man_in_the_middle_without_the_code_holds_neither_key`),
and a guesser gets three tries per time a person opens pairing mode, 3 in
10,000, each one counted on that person's screen. The earlier design
(numeric comparison, six digits both people confirm) needed BOTH people to
compare and click; typing once is what people actually do, and comparing
was easy to click through without looking.

Limits on the unauthenticated half:

- **One incoming pairing at a time**: a second start inside the first's
  30 s gets 429 ("busy").
- A request naming B's own id, or an id that is not 32 hex characters, is
  refused; a different peer protocol (`pv` 2 now) answers 409.

Re-pairing a machine that is already paired replaces its key (the dialog
says so, `replaces_existing`), keeping the local name, the note and the
reply contacts.

**From an agent.** `termic peer pair <target>` / MCP `peer_pair
{target}` with no code asks the machine to show one (the same
`/pair/request` as clicking Pair under Nearby) and answers
`peer_code_shown` with a `next` line telling the agent to ask the user
for it. `peer pair <target> <code>` / `peer_pair {target, code}` then
pairs. So an agent pairs end to end, but the code only ever reaches it
from a person who read it off the other screen; it can never see one on
its own. A v24 app refuses the code-less form outright (`code` was
required), so this needed no protocol bump.

## The credential

- One 256-bit key per pair, in `<global data dir>/peers.json`, written
  owner-only (0600; on Windows the per-user data dir's ACL, the same
  custody as `mcp-token`) through a write-beside-and-rename so a crash
  never truncates it. Never in any environment, never sent to the
  webview, never shown. An unreadable file is moved aside to
  `peers.json.unreadable` rather than overwritten.
- Every call is sealed with ChaCha20-Poly1305 under a key per DIRECTION,
  `HKDF(pair key, "termic-dir-v1", sender "->" receiver)`, so a message
  cannot be reflected back at its sender. 96-bit random nonce. The AAD is
  `termic-peer-v1|<path>|<sender>|<receiver>`, so a sealed body moved to
  another endpoint, or presented by another sender, fails to open.
- The plaintext carries `ts` (sender's clock, ms) and a random `rid`.
  Outside a 5-minute window, or a `rid` already seen from that sender in
  the window, is refused. The reply is sealed the other way and must echo
  the `rid`. It also carries `grant` (what the sender lets the receiver
  do), which keeps each side's "Lets this computer" current, and the
  sender's listener `port`.
- Unknown sender, bad seal, stale, replayed: the same bare 401, after a
  delay that grows per failure (100 ms steps, capped at 2 s, reset on a
  success).
- So a LAN sniffer sees neither the key nor the prompts and diffs, and
  can neither replay nor alter them. No TLS, no certificates.

## What a paired machine may do

Each side decides, per peer, what that peer may do HERE. Paired computers
work together: pairing grants Drive agents on both sides, and the dialog
says so in one line (what it means, and where to narrow it) instead of
asking. Narrowing one machine to Reply only is a choice in Settings,
made per machine, afterwards. The protocol still carries each side's own
grant, and a grant that fails to parse is still Reply only. Two levels:

**Reply only.** The peer may `send` a prompt to a task on
this machine that has itself contacted that peer, and nothing else. The
contacts are recorded on THIS side: every outgoing `--peer` / `peer_call`
records the calling task (`from_task`, from `$TERMIC_TASK_ID` or the MCP
task header) against that peer, up to 200 per peer. The send must
reach a RUNNING agent: `fresh` and `resume` are refused, because
starting an agent or bringing back a session is more than replying
(`--tab` is fine, it addresses an agent that is already open). This is
the worker-reports-back channel. Said plainly: it is still a prompt typed
into one of your agents. If that agent runs with YOLO, whoever controls
the paired machine can steer it.

**Drive agents (what pairing grants).** Every verb an MCP client has, except `quit`, `attach`,
`project add`, `project remove`, the `peer` verbs, and forwarding on to
a third machine. Said plainly: **this is remote code execution as you.**
The peer can create tasks in any project you registered, with `--yolo`
and `--sandbox off`, and any prompt.

A machine that is not paired can call `hello` and ask to pair, which
shows a dialog here and nothing more. It can never run a verb.

The setup this was built for: long-running agents on the laptop that
ask their orchestrator on the Mac for help when stuck, and the Mac's
agents prompting them. Both directions are prompts, so both machines
drive each other. A user who wants a one-way setup sets the worker's
grant on the orchestrator to Reply only.

## Unpairing

`unpair` deletes the key here at once, then sends a sealed `unpair` to
the other machine (best effort, 5 s). If the other machine is offline it
keeps a dead key that opens nothing here; its next call gets 401, it
marks the pair `revoked_by_peer`, and Settings tells that person "No
longer paired on the other computer. Unpair here too."

Every call is stamped with the sender's clock and refused outside 5
minutes of the receiver's. Pairing has no such check, so two machines
whose clocks disagree (a Windows laptop with a wrong time zone, say)
would pair fine and then have every call refused. So pairing checks it
too: the confirm is stamped, and a machine showing the code refuses one
outside the window with a sealed 409 carrying its clock, stores nothing,
and closes pairing mode; the typing side says "<machine>'s clock is 7 h
57 min ahead of this machine's" and pairs nothing. A paired sender with a stale
stamp gets a sealed 409 carrying the receiver's clock, not the bare 401,
so the caller reports "<machine>'s clock is 7 h 57 min ahead of this
machine's" and does not mark the pair revoked. Older versions answer it
with the 401.

Renaming is local: it sets this machine's name for the peer, the other
machine is not told, and either name or the id (a prefix of 6+
characters) still selects it. This machine's own name defaults to the
computer's (macOS ComputerName, Windows `COMPUTERNAME`, else the
hostname) and is stored as empty while it is the default, so a renamed
computer is followed.

## Agent surface (CLI and MCP)

- **`--peer <machine>`** is a global CLI flag: `termic --peer laptop new
  fix-x -p "..." --yolo`. In MCP, the five verbs an orchestrator uses
  across machines take an optional `peer` argument: `task_new`,
  `task_send`, `task_wait`, `task_result`, `task_list` (`task_new {peer:
  "laptop", ...}`). `peer_call {peer, tool, arguments}` runs any other
  tool there. Both are validated here first, against the same registry,
  and reach the same forwarding path. Not a `peer` param on EVERY tool,
  which would have cost about 4 KB more in tools/list; the five cost 460
  bytes (see the size pin in `mcp_server.rs`).
- **A note per paired machine**, what it is for ("Windows builds and
  installer tests"), set in Settings, local like the alias, one line of
  at most 200 characters, kept across a re-pair. `peer list` / `peer_list`
  return it, and the MCP server's discover instructions list every paired
  machine with its note, so an agent knows where to send what without a
  call.
- **`termic peer list | pair <target> | unpair <peer> [--yes] | rename
  <peer> <name>`**, MCP `peer_list`, `peer_pair`, `peer_unpair`
  (destructiveHint), `peer_rename`. `peer pair` without a code makes
  the other machine show one; with it, it pairs (see "From an agent"). These act on this machine
  and refuse `--peer`.
- Wire (CLI protocol v22): `Request.peer` and `Request.from_task` (not
  `caller_task`, which `group` already owns in the flattened command;
  the peer verbs say `target` for the same reason), the `peer_*` verbs,
  and `ErrorCode::PeerUnreachable`, **exit 12**: nothing ran there. A
  refusal by the grant is `auth`, exit 6.
- What does not cross: `cwd`, `parent_task` and `caller_task` are
  stripped on both ends (they name the caller's machine), the CLI drops
  its `$TERMIC_TASK_ID` / `$TERMIC_TAB_ID` defaults under `--peer`, and
  `attach` and `send --here` are refused. Task names, paths and
  `--profile` are the OTHER machine's.
- Waits are clamped to the MCP cap there (5 minutes): loop `wait`. While
  a streamed verb runs remotely, the local app heartbeats the CLI so its
  30 s socket timeout never fires.
- Both machines must speak the SAME CLI protocol to call each other (a
  field the other side does not know would be dropped silently). A
  mismatch is refused with both versions named. Pairing itself only
  needs the same peer protocol.
- A machine that moved (new DHCP lease) is not gone: on a connection
  failure the app re-queries discovery, waits up to 2 s for a fresh
  sighting, and retries once at the new address.

**Report-back.** The usual signed header gains `peer:<machine>` when the
prompt crosses machines: `[message from agent:claude task:fix-x id:<id>
peer:studio]`. Ask for the reply as `termic --peer <this machine> send
<your task id> ...` (or a `peer_call` back). A prompt whose header
carries `peer:<machine>` came from that machine, so answer it with
`--peer <machine>`. This machine's name is in `termic peer list`. Taught
in `termic --help`, `TERMIC_CLI_HELP`, the MCP instructions and
[cli-agent-instructions.md](cli-agent-instructions.md).

## UI

Settings > Agent access (the rail item, with a faded "MCP & CLI"), two
tabs shown one at a time: MCP first, the Termic CLI second. They were one
long scroll first, which read as a wall of prose and left pairing at the
bottom where nobody found it. The MCP tab opens with Other computers,
then the MCP endpoint: pairing is how agents reach another machine, and
they do it through this Termic's MCP tools. Turning sharing on turns the
MCP endpoint on with it (turning sharing off leaves MCP alone). Off with
nothing paired, Other computers is its toggle and one line. Tab ids are
settings tabs (`mcp`, `cli`); `peers` opens the MCP tab.

The MCP endpoint's network address sits folded under "Network address
(advanced)", open only when it is already off loopback, with a line pointing here: it used to read as THE way to
reach another machine, with one all-powerful token sent in the clear.

Other computers (Experimental): the toggle with a plain warning; the
pairing-mode panel (the code in large type, a countdown, wrong codes so
far, Stop pairing) or its "Pair a computer" button; Nearby with "Ready to
pair" rows first, each asking for the code inline and submitting at four
digits; this
computer's name, address and any bind or discovery error, plus a
platform hint; paired computers (inline rename, "What it is for" with
role presets, online or last seen, "May do on this computer", "Lets this
computer", Unpair behind a confirm); Pair by address (address and code).
The after-pairing dialog is global, on both machines, since the one that
showed the code may be on any screen: the one line on working together,
then "What is X for?" with Just a pair / Orchestrator / Worker presets that
fill the note, Done / Skip. Everything is read from
`peer_status` and refreshed on `peer://changed`, never polled
([ipc.md](ipc.md)).

## Platforms

- **Windows.** The first wildcard bind raises the Defender Firewall
  prompt: choose Private networks. On a network Windows marks Public,
  inbound stays blocked whatever was chosen (Settings says so). Port
  5353 is shared with the DNS Client service through `SO_REUSEADDR`.
  The interface list comes from `GetAdaptersAddresses`. All of this
  type-checks for Windows but is **untested on real Windows hardware**.
- **macOS.** Local Network privacy: until the user allows it, every
  multicast send fails (`EHOSTUNREACH`) and nothing arrives, while the
  bind and the group joins still succeed. `mdns.rs` counts a round where
  every send was refused that way as BLOCKED (`peer_status.network_blocked`),
  and Settings says so with a button to the Local Network pane, instead of
  an empty Nearby that looks like a quiet network. Each bundle id is its
  own grant: Termic Beta (`com.simion.termic.beta`) is asked separately,
  and an ad-hoc signed beta was measured never prompted at all
  (`DenyMulticast = 1`, `MulticastPreferenceSet = 0` in
  `/Library/Preferences/com.apple.networkextension.plist`), so its switch
  in System Settings is the way in. Pair by address works either way.
  Our raw multicast sends are not a reliable trigger for the permission
  prompt (Apple TN3179), and a fresh Mac was never asked, so starting
  discovery also opens one system Bonjour browse for `_termic._tcp`
  (`mdns::ask_local_network_access`, `DNSServiceBrowse`), the documented
  trigger.
  `Info.plist` carries `NSLocalNetworkUsageDescription` (mentions
  pairing) and `NSBonjourServices` (`_termic._tcp`). The application
  firewall only prompts when the user turned it on.
- **Linux.** Same path as macOS (`getifaddrs`); coexists with avahi on
  5353.

## Profiles

**A paired computer is not confined to one profile, and its work is never
hidden.** Its requests resolve projects and tasks across every profile,
like a local `termic` command without `--profile`. Whatever it does in a
profile brings that profile's window on screen: shown if hidden or
minimized, built if closed, the same path as picking the profile from the
menu (`reveal_profile_window`, triggered by `cli_server::PEER_ORIGIN` just
before the request's RPC reaches the window). Found when a paired laptop
named a project that lived in the Personal profile while only the NextTech
window was open: its task started in a window nobody could see. Confining
each pair to one profile was considered and left out on purpose; visibility
is the rule instead.

A window built on the spot is waited for: the app-wide RPC latch is
already set by then, so `cli_rpc_ready` also records readiness per window
label, and the RPC waits for that label before emitting (an event emitted
before a webview's listener exists is dropped, not queued).

Sharing, like the CLI and MCP switches, belongs to the app, not a
profile: one node per machine, read from the root profile's settings.
`settings_save` from any profile window writes these to root too, and
`settings_load` shows root's (`copy_machine_wide` in lib.rs). Before
that, turning sharing on in a second profile's window started the node
for the session while root still said off, so `termic peer list`
printed "sharing off" beside an open port and the next launch came up
off.

## Debugging

- `plutil -p /Library/Preferences/com.apple.networkextension.plist`
  shows each app's Local Network decision (`DenyMulticast`).

- `dns-sd -B _termic._tcp` (macOS) lists every advertising Termic;
  `dns-sd -L <instance> _termic._tcp` shows its TXT.
- `curl http://192.168.1.20:23620/termic-peer/v1/hello` answers with the
  instance's id and versions; 403 means its sharing is off.
- `[peers]` lines in the debug log: bind, discovery errors, unpair
  notices, "listening on port N".

## Decisions

- **Hand-rolled mDNS over `socket2`** (already in the tree via hyper),
  not the `mdns-sd` crate, which would have added flume, if-addrs and
  mio. The subset needed is small and unit-tested, including malformed
  and adversarial packets; swapping in `mdns-sd` is contained to
  `mdns.rs` if some network needs it.
- **`ring` AEAD instead of TLS.** `ring` is already linked for rustls;
  TLS would need certificate generation (`rcgen`) and pinning for no
  gain over a pre-shared key we already hold.
- **`peer` on five verbs plus one proxy tool**, `peer_call`, over a
  `peer` param on every tool, for the tools/list size.
- **No permission question in the pairing dialog.** Two people comparing
  codes are not weighing grants, and the one-way default made the common
  setup (each machine asking the other for help) need the opposite
  answer on each screen.
- **Forwarding through the app** over registering each peer as its own
  MCP server in agents' configs: the key stays in the app, an address
  change is absorbed by discovery instead of breaking a pasted config,
  unpair and rename apply instantly, and the CLI gets it for free.

## Not done / known limits

- Agents on one machine drive the other; a person cannot. A task made
  on a pair shows in that machine's window only, its terminal cannot be
  watched or typed into from here, and `attach` is refused. What comes
  back is text (`task_log`, `task_result`). One request per connection
  cannot carry a terminal stream.
- Both ends run the full app. A headless server cannot be a pair.
- IPv4 only, for discovery and the listener.
- No TLS, by design (above).
- The pairing protocol and every call path are covered by Rust tests
  between two real in-process listeners; the e2e spec fakes the second
  machine (`e2e/specs/peers.e2e.ts`). Two real machines, the Windows
  firewall prompt and the macOS Local Network prompt have no automated
  coverage: they need the manual pass.
- Two machines on different CLI protocol versions can pair but not call
  each other until both update.
- A response lost after B stored the pair leaves B paired and A not; B's
  next call is refused and shows "no longer paired", unpair and re-pair.
