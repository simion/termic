# Idea: send bug reports and suggestions from the app

Not decided, not planned. This is the case for it and a design that fits
Termic's constraints, so the decision can be made on something concrete.

## The problem

Today a user who hits a bug or has a suggestion has to leave the app, open
GitHub, and describe the problem from memory. Most never do. A crash is worse:
the app is gone, the context is gone, and `logs/panic.log` (see
[data-model.md](../data-model.md)) is a file the user would have to find and
paste by hand.

A "Send feedback" action inside the app lowers that cost. A "report this crash"
prompt after an abnormal exit captures the one moment the user has the
evidence in front of them.

## Constraints (decided up front)

These bound every option below.

1. **On-device by default.** The app talks to nothing but termic.dev, and
   `src/lib/cspGuard.test.ts` pins `connect-src` because the website
   publishes that as a promise. A report is therefore sent from **Rust**, never
   from the webview, and the CSP is not widened. The promise on
   <https://termic.dev/local/> is amended in the same change that ships this.
2. **Opt-in, per report.** Nothing is sent unless the user presses Send, and
   the dialog shows the exact payload first. No background upload, no
   "send automatically" switch in v1.
3. **No secret in the app.** The GitHub token (or any storage credential)
   lives in the Worker. The app never holds anything that can write to the
   tracker.
4. **Anonymous.** No account, no login. A report is tied to an install, not to
   a person.

## Design

```
Termic (Rust) --POST--> https://termic.dev/api/...  (Cloudflare Worker)
                              |
                              |-- verify install token (HMAC)
                              |-- throttle per IP and per install
                              |-- validate shape and size
                              '-- create a GitHub issue / store the report
```

### What a Cloudflare Worker is, here

A small serverless function on Cloudflare's network, deployed with `wrangler`.
It sees the client address in the `CF-Connecting-IP` header, which the client
cannot forge, and has bindings for rate limiting (`ratelimit`), KV, Durable
Objects and D1. The free plan (100k requests/day) is far above what feedback
needs.

### Install token (the authentication)

"Authenticated" here means the request comes from an install of Termic, not
from a person.

1. On first use the app generates a random UUID (`install_id`) and stores it in
   the global data dir.
2. `POST /register` with that id. The Worker throttles it per IP (for example 5
   per day) and answers with a token: `install_id`, issue time and an HMAC
   signature made with a Worker secret. Nothing is stored for this step.
3. The app keeps the token. Every later request carries it in a header.
4. The Worker verifies the signature statelessly, then throttles per
   `install_id` as well as per IP.

What this buys: two users behind one office NAT no longer share a limit, and
an abusive install can be blocked by id in KV without banning an IP range.

What it does not buy, and the doc should not pretend otherwise: it is
anti-spam, not security. Anyone can register many UUIDs. The cost is raised by
the per-IP limit on `/register`, not removed. Stronger options exist (Cloudflare
Turnstile, macOS App Attest) and are awkward in a desktop app or macOS-only, so
they are left for if abuse actually happens.

### Throttling and caps

| Layer | Example | Why |
| --- | --- | --- |
| `/register` per IP | 5/day | slows token farming |
| `/report` per IP | 10/day | catches one machine looping |
| `/report` per install | 3/day | catches one install looping |
| global per day | 200 | a hard ceiling on a flood |
| body size | 32 KiB | bounds storage and issue noise |

The `ratelimit` binding has fixed 10 or 60 second periods. Daily limits use a
Durable Object counter (consistent) rather than KV (eventually consistent, so a
fast abuser can overshoot). IPv6 is counted per `/64`.

### What a report contains

Suggestion or manual bug report:
- type (`bug` or `suggestion`), a title, and a free-text message the user wrote
- Termic version, OS and architecture
- an optional checkbox for each extra, off by default

Never included: project names, task names, paths, terminal contents, git
remotes, environment variables. Anything that could carry an employer or a
person is out. This follows the same rule as fixtures in CLAUDE.md: the
repo and its tracker are public and permanent.

### Crash reports

Since `panic_log.rs` writes every Rust panic to `logs/panic.log`, the app can
detect an abnormal exit on the next launch (a panic entry newer than the last
clean shutdown) and offer, once:

> Termic crashed last time. Send a report?

The dialog shows the entry that would be sent: version, thread,
`file:line:col`, the message and the backtrace. A backtrace holds source paths
of the build machine and symbol names, not user data, but the panic **message**
can: `unwrap()` on a path, a `format!` with a task name. So the payload is
scrubbed before display (home directory replaced by `~`, the project and task
names the app knows replaced by placeholders) and the user still sees the
final text before sending.

Limits of the signal: `panic.log` covers Rust panics only. A crash from an
Objective-C exception, a signal in a native library, or a WebContent kill
leaves no entry, so those would need their own source (the macOS
`DiagnosticReports` entry for the app is the obvious one, with the same
scrubbing and consent). That is a second phase.

## Where reports go

Options, in order of preference:

1. **Worker creates a GitHub issue** with a token held in the Worker. Zero
   infrastructure to read, lands where the maintainer already works. Risk: it
   publishes the report, so a crash payload must be safe to be public. Issues
   would carry a `from-app` label and no `planned` label (see CLAUDE.md:
   `planned` is for approved work only).
2. **Worker stores in D1** and the maintainer reads a small dashboard. Private
   by default, but one more thing to build and keep.
3. **Worker posts to a private channel** (Slack, Discord, email). Cheapest, no
   history to search.

A reasonable v1 is 2 or 3 for crashes (private, may contain more) and 1 for
suggestions (public discussion is the point). Not decided.

## Open questions

- Does a report include an optional contact (an email or GitHub handle) so the
  maintainer can ask a follow-up? It is the only way to close the loop, and it
  is personal data the app has never collected.
- Retention: how long are reports kept, who can read them, and is that said in
  the dialog.
- Do agent-written PRs need a guard so a tester running the e2e build does not
  send real reports? Probably a build-time switch that points the app at a
  stub or disables the action.
- Abuse response: who is on the hook when the global cap trips at 3 a.m.

## Not in scope

- Telemetry, usage analytics or any automatic upload.
- A user account or login.
- Receiving files, screenshots or terminal logs. A screenshot is a fixture, and
  terminal contents are the most private thing the app holds.
