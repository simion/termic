# Idea: send bug reports and suggestions from the app

Not decided, not planned. This is the case for it and a design that fits
Termic's constraints, so the decision can be made on something concrete.

## What exists today

The sidebar footer has two support buttons (`Sidebar.tsx`, `openIssue` and
`openMailto`), and the command palette has "open issue":

- **Report a bug** (the bug icon) opens a prefilled "New issue" on
  `github.com/simion/termic` in the browser.
- **Contact** (the mail icon) opens a `mailto:` to `contact@termic.dev` and
  copies the address, because the `mailto:` handler on macOS can end up in a
  browser and do nothing (#103).

Both hand the user to another app. Neither sends anything from Termic.

## The problem

What that leaves out:

1. **A GitHub account is required** to file the issue. Users without one, or
   who do not want a public identity on the tracker, drop out at the login page.
2. **Nothing is captured.** The prefilled body is a template, so the user
   describes the problem from memory. Version, OS and the evidence of a crash
   are not attached.
3. **Crashes are out of reach.** The app is gone, the context is gone, and
   `logs/panic.log` (see [data-model.md](../data-model.md)) is a file the user
   would have to find and paste by hand.
4. **Suggestions are public by construction**, which suits some and stops
   others from writing at all.

This idea adds an in-app path that needs no account, attaches the facts the
app already knows, and can offer a report at the one moment after a crash when
the evidence exists. It does not replace the GitHub button: that stays for
people who want a public, discussable issue.

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
- an optional checkbox for each extra, off by default. The one that matters
  most is **Attach recent crash log** (see "Crash log attachment" below)

Never included: project names, task names, paths, terminal contents, git
remotes, environment variables. Anything that could carry an employer or a
person is out. This follows the same rule as fixtures in CLAUDE.md: the
repo and its tracker are public and permanent.

### Crash reports

Since `panic_log.rs` writes every Rust panic to `logs/panic.log` (`logs/crash.log` once renamed, see below), the app can
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

### Crash log attachment

A manual report (the bug button, no crash on the last launch) has an **Attach
recent crash log** checkbox, off by default. Ticking it adds the newest entry
from `logs/crash.log`, and the dialog shows exactly that text.

A **Load more** control under the preview pulls the next older entry into the
payload, one at a time, for the case where the crash the user means is not the
latest one. Each entry is shown before it counts, and the body-size cap (32
KiB) is the ceiling: when the next entry would exceed it, Load more is
disabled and says why.

Every entry goes through the same scrubbing as the post-crash flow before it is
displayed: the home directory becomes `~`, and the project and task names the
app knows become placeholders. Scrubbing runs on the entries as read from the
file, so what the user sees is what leaves the machine.

Entries are separated by a fixed `=== ` header line, so reading "the newest N"
is a split on that marker, across `crash.log` and the rotated `crash.log.1`
(rotation happens past 512 KiB, so older entries can be in either file).

### Other crashes into the same log

Today the log (`panic.log`) covers Rust panics only. The other ways Termic dies leave nothing
today, and three of them can be made to leave a line the same way:

1. **Objective-C exceptions.** Shipped: `panic_log.rs` installs the handler.
   `NSSetUncaughtExceptionHandler` runs in normal
   context and receives the exception name, reason and call stack, so it can
   append an entry like the panic hook does. This is the likeliest cause of an
   abort in AppKit callbacks that is not a Rust panic, and it is the case the
   panic hook cannot see.
2. **Fatal signals** (`SIGSEGV`, `SIGBUS`, `SIGILL`, `SIGABRT`). A signal handler
   may only use async-signal-safe calls, so it cannot format a backtrace or
   take a lock. It writes a fixed-size entry (time, version, signal number) to a
   file descriptor opened at startup, then re-raises. The entry has no message
   and no stack, but it says that it was a signal rather than a panic, which is
   already more than a bare crash report gives.
3. **The WebContent process being terminated.** WebKit tells its delegate when
   it kills or loses the web process (the interface reloads from scratch, as
   happened on 2026-11-08). A handler that logs the event with its cause costs
   one line and explains a restart that looks like a crash.

Each entry gets a `kind` field (`panic`, `objc-exception`, `signal`,
`webcontent-terminated`) so the report dialog can say what it is attaching.
The file name `panic.log` then understates what is in it, so the log becomes
**`logs/crash.log`** (rotated to `crash.log.1`, same 512 KiB cap). On first
start the app renames an existing `panic.log` (and `panic.log.1`) to the new
names, so no entry is lost, and `docs/data-model.md` and the `panic_log.rs`
module follow the rename in the same change.

What this still does not cover: a `SIGKILL` (the OS killing the app for memory
or a force quit) cannot be intercepted by any handler. The macOS
`DiagnosticReports` entry stays the fallback for what the app cannot log
itself, with the same scrubbing and consent, as a later phase.

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

## Where it is triggered

The existing **Report a bug** button in the sidebar footer (the bug icon,
`data-testid="sidebar-report-bug"`) stays the entry point. What changes is what
it does: instead of opening the browser on a prefilled GitHub issue, it opens an
in-app dialog.

- **The dialog** has the type (bug or suggestion), a title, a message, the
  optional extras (each off by default) and a preview of the exact payload.
  **Send** posts it from Rust.
- **"Open on GitHub instead"** is a link inside the dialog. It does what the
  button does today (the prefilled "New issue" in the browser), so anyone who
  wants a public, discussable issue loses nothing.
- **The command palette** entry "open issue" opens the same dialog, so the two
  entry points cannot drift.
- **Contact** (the mail icon) is unchanged.
- **After a crash**, the next launch offers a report once (see "Crash
  reports" above). It opens the same dialog, preselected as a crash report and
  filled with the scrubbed `crash.log` entry. There is no new button for it.

No new footer icon, so the footer row does not grow. The cost is that the bug
button now opens a dialog where it used to leave the app, one more click for
someone who only wanted GitHub, which the link in the dialog keeps to a single
extra click.

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
