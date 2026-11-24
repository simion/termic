# Caffeinate

The coffee mug in the sidebar footer's bottom-left corner controls
machine-wide sleep prevention. All profile windows share one native manager.
By default only the system is held awake: the display can sleep and the
session can lock while agents keep running. **Keep display on** adds a
display-awake request for the same session (it is released with it). The
popover states under the checkbox that the computer stays awake with it off,
and the status card says which of the two is in effect, because a dark screen
reads as "it went to sleep" otherwise. No simulated input is used.

The footer order is the coffee mug, then Theme, Report a bug, Contact,
Shortcuts and Activity, with Settings alone on the right. All actions stay direct
icons at narrow widths. The footer keeps its shared height, and the compact
sidebar keeps the same order in a vertical stack.

## Sessions

- **For a duration:** any positive duration up to 24 hours, including fractional
  hours, with selected-state presets for 1/2/4/8/16/24 hours and a custom field.
- **Until turned off (∞):** the last duration preset, native mode
  `indefinite`. No deadline; Turn off or the 10% battery check ends it. Like a
  timed session it does not restart on relaunch, so a forgotten one cannot
  outlive the app.
- **Until a time:** a future local date/time within 24 hours. The form shows
  the time zone and rejects nonexistent local times rather than normalizing a
  daylight-saving gap silently.
- **While agents are working:** armed until stopped, acquiring the system
  request when local agent activity is observed. This explicit selection
  survives relaunch; it waits for new live activity before acquiring anything.

The status card distinguishes Keeping awake, Automatic mode is on (waiting
for work), and Caffeinate is off. It shows the accepted end time and a Turn off
action. Outcome-specific confirmation buttons such as Keep awake for 16 hours
or Enable automatic mode commit a draft. Pending changes are labeled; browsing
options or dismissing the popover leaves the current session running.
Unchanged settings show a checkmark and These settings are active.
Reopening a duration restores its original hours, rather than the remaining
time; the native status includes `duration_minutes` for this purpose.
Timed sessions do not restart on relaunch. A webview reload reconnects to the
existing native session.

**Turn back on when Termic restarts** (a checkbox in the popover, off by
default) is the opt-in exception. Every accepted request is remembered in
localStorage (`caffeinateLast`, cleared by Turn off); at launch, with the
box ticked (`caffeinateRestore`) and the native side off,
`restoreAtLaunch` re-applies it. A duration comes back as Until its
original end, an Until only while its end is ahead, and indefinite as it
was; a closed-lid request without its permission comes back without the
lid. Automatic mode already survives a relaunch natively, so it is never
re-applied.

The mug is filled while the request is active and outlined otherwise.

The mug uses the native manager's accepted-request state. A warning and error
text distinguish acquisition failures and outstanding restoration from an
active request. OS overrides and platform restrictions can still allow sleep.

Duration uses a suspend-aware elapsed clock (`mach_continuous_time`,
`CLOCK_BOOTTIME` or `GetTickCount64`), so changing the wall clock does not change
its length. Until uses its resolved wall-clock instant. Native
channel waits are capped at one minute for resume/clock reconciliation and
battery checks, rather than relying on a foreground JavaScript timer.
Discharging at or below 10 percent stops a session, checked at most once a
minute. Emergency OS power actions remain outside the app's guarantees.

## Automatic activity

The manager receives trusted Termic OSC 777 bodies directly from the native
PTY reader and, on Windows, the hook-pipe reader. Each byte stream has its own
bounded carry buffer for fragmented BEL/ST-terminated frames. The manager
indexes agents by PTY ID, independently of profile windows or selected tabs.
It does not consume `cliAgentState`'s webview snapshots.

- Working and agent-owned delegated work keep the system request alive.
  They do not inherit the spinner's 20-minute timeout.
- Detached shell work stops counting after five minutes.
- An input/approval prompt has a five-minute grace.
- Agents without hooks use an explicit unknown state after a submit, bounded
  to 20 minutes. An idle process alone does not count as work.
- Work completion has a two-minute release grace for queued follow-ups and
  short orchestration gaps. PTY exit removes that PTY's activity.
- An exhausted short or weekly usage reading stops counting as work, using
  the same 100-percent threshold as the existing usage UI. A new working hook
  re-arms activity; a reset reading alone does not invent work.
- Ctrl-C or a standalone Escape needs a completion hook or 15 seconds of PTY
  quiet before ordinary work is treated as interrupted. Delegated work and
  attention prompts are not cancelled by a key press. Cursor sequences and
  bracketed paste are not interrupts.

Quota resets and future scheduled jobs do not wake a sleeping computer.
Use a timed session when unattended work must remain reachable through a long
permission prompt, quota wait or an agent without reliable hooks.

On macOS 14 and later, an enabled caffeinate session switches each window to
WebKit's `Throttle` background policy so queued messages and CLI
orchestration can still be delivered while hidden. Windows are left alone
while caffeinate is off, and turning it off puts back the value each window
had before, rather than assuming WebKit's default.
This does not keep terminal renderers on
screen: their existing geometry/presence gates still apply. OS lock/display
and prolonged background behaviour require hardware validation. Tauri does
not expose this background policy on older macOS, Linux or Windows; the
native sleep manager itself remains independent of webview execution.

## Optional closed-lid control

The checkbox is separate from ordinary caffeinate. Its availability and
active state are reported independently. Changes follow the session's held
request and its completion grace, avoiding per-turn global-setting writes.

A local helper owns the lid change. The desktop owns the helper's input
pipe, which is not inherited by agent children. EOF restores the change if
the desktop dies; an independent three-minute heartbeat lease handles a
stalled manager, and a session deadline is enforced in the helper too. The
helper has no socket, service registration or persistent daemon. It exits
after restoration. A file lock serializes helper/recovery ownership.

Logout and shutdown can end the helper without closing its pipe. On macOS
and Linux it blocks SIGTERM, SIGHUP and SIGINT and takes them on one thread;
on Windows a hidden top-level window receives `WM_ENDSESSION` and waits up to
five seconds for the restore. Quitting Termic, which is how macOS logout and
restart begin, sends the helper `quit` over its pipe. In each of these cases
the helper restores without requesting sleep. Only expiry, Stop and the
desktop dying (EOF) re-evaluate a lid that is still closed.

macOS and Windows write the original state to an atomic recovery journal
**before** changing it. Failed restoration retains the journal and surfaces a
Restore normal sleep action. Startup recovery is a backstop for helper death,
power loss and unfinished restoration. The helper itself being forcibly
killed can defer cleanup until that recovery.

### macOS

Ordinary mode uses `PreventUserIdleSystemSleep` through IOKit; Keep display on
adds a second `PreventUserIdleDisplaySleep` assertion. Closed-lid mode
uses privileged `pmset disablesleep 1`, restoring `0` afterward. If sleep was
already disabled, Termic refuses to take ownership. Do not combine this
system-wide boolean override with another app changing the same setting;
macOS provides no ownership token for independent tools to coordinate.

Set up closed-lid permission requests administrator authorization to install
`/etc/sudoers.d/termic-caffeinate`. The rule permits only the current numeric
user ID to run the exact `pmset disablesleep 0` and `1` commands without a
password. It is a per-user grant, not an app-signature restriction; other
unsandboxed programs running as that user can execute those commands too.
Remove closed-lid permission removes the rule, after active changes and any
recovery journal have been cleared. Dragging the app to Trash does not remove
this permission automatically.

If the rule disappears while closed-lid control is active, the manager's
minute check stops closed-lid control at once, while someone is more likely
to be there to approve the fallback. Without the rule the unattended restore
cannot write the setting back, so the journal stays and the error says what
happened. Restore normal sleep then asks for administrator approval through
`osascript` to run `pmset disablesleep 0`. The restore runs off the policy
worker, like permission setup, so an unanswered prompt does not stall
expiry, Stop or battery checks.

An IOKit lid observer requests real display sleep on closure. Lock/password
timing follows the user's macOS lock-screen settings. Restoration checks the
current lid policy and other sleep blockers before requesting lid sleep.
Vorssaint's source informed the behavioural investigation; this implementation
was written from the OS interfaces rather than translated from its code.

### Windows

Ordinary mode uses a handle-based `PowerRequestSystemRequired`, with a matching
clear/close. Keep display on sets `PowerRequestDisplayRequired` on the same
handle and clears it before the system request is cleared.

Closed-lid mode saves the active plan's AC and DC lid actions, sets both to
Do Nothing and reapplies that plan. A native lid notification calls
`LockWorkStation` on a new closure when no dock/external display is active.
Enabling the mode does not itself lock the session. Restoration preserves independent value edits
and never reactivates an old power plan after the user switches plans.
Plan changes are detected on the helper's bounded checks. Access restrictions
and Group Policy are reported as errors, not bypassed.

Modern Standby on battery can terminate ordinary power requests after the
system sleep timeout plus five minutes. The UI reports this limitation.
Termic does not change standby timeouts, critical-battery actions or keep the
display on as a workaround. If the lid remains closed with no external display
or dock, restoration re-evaluates the active plan's Sleep/Hibernate lid action
using [SetSuspendState](https://learn.microsoft.com/en-us/windows/win32/api/powrprof/nf-powrprof-setsuspendstate).
It does not force shutdown or override a changed plan. This needs hardware testing.

### Linux

Ordinary mode holds a logind `sleep` inhibitor FD. Closed-lid mode additionally
holds a `handle-lid-switch` inhibitor. A sleep inhibitor alone does not override
logind's default lid handling. No persistent logind configuration is edited.
logind has no display inhibitor, so Keep display on calls
`org.freedesktop.ScreenSaver.Inhibit` on the session bus and holds that
connection; the desktop drops the inhibit when it closes. Untested on hardware.
FDs are explicitly close-on-exec, and loss of the owning process releases them.
Periodic checks detect a lost sleep inhibitor and attempt reacquisition.

Lid mode requires a UPower lid sensor and a logind session. A new lid-close
transition requests a lock on the calling session unless logind reports that
the machine is docked. Enabling the mode does not itself lock the session.
System battery checks exclude supplies whose scope is `Device`, including
peripheral batteries. No idle/screensaver inhibitor
is taken. GNOME, KDE and other desktops may implement their own power policy,
so the UI marks Linux as subject to desktop restrictions. Missing services,
authorization denial or a lost lid inhibitor produce an error rather than a
successful indicator. Supported desktop/hardware combinations need validation.

## IPC and validation

`caffeinate_status`, `caffeinate_set`, `caffeinate_permission` and
`caffeinate_recover` expose the manager. `caffeinate://status` broadcasts
revisioned snapshots to every profile window. Revision ordering prevents a
late command reply from overwriting newer activity. Configuration and
privileged operations execute off the UI thread.
Administrator authorization also runs off the policy worker, so an unanswered
prompt does not pause expiry, Stop or low-battery checks. Lid acquisition is
held while permission changes are pending.

Unit tests exercise stream boundaries, work/delegation policy, cancellation,
validation, expiry and journal locking/replacement. The written
`e2e/specs/caffeinate.e2e.ts` drives the real popover and native manager,
including a real fixture PTY. `--features e2e` replaces OS actions with a fake
adapter: CI never prevents sleep or installs a sudoers rule. Separate helper
process tests prove deadline/EOF cleanup against a fake journal.

Compilation and automated tests do not prove real lock/lid/display power
behaviour. Before publishing platform support, verify actual agent progress
with display off, screen locked, lid closed, AC/DC transitions, expiry while
closed, force quit and recovery on the target hardware. macOS administrator
setup and Windows/Linux power changes must be exercised deliberately outside
the fake e2e adapter.
