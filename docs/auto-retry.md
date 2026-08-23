# Auto-resume on a usage limit

What happens when an agent runs out of subscription quota, why termic can fix
it and a wrapper script cannot, and where the parts live.

Off by default: **Settings → Tasks → "Resume automatically after a usage
limit"**.

## The problem

A subscription limit does not kill the session, it **parks** it. claude prints
a notice and then blocks on an interactive menu:

```
You've hit your limit · resets 3pm (Europe/Dublin)

❯ 1. Stop and wait for limit to reset
  2. Upgrade your plan
```

Until somebody answers that menu the turn is over and nothing else happens. So
a task left running overnight is not "waiting for 3pm", it is sitting on an
unanswered question, and it will still be sitting on it in the morning.

Answering it is only half the job. "Stop and wait" stops; it does not come
back. The session needs a fresh prompt after the reset passes.
[anthropics/claude-code#18980](https://github.com/anthropics/claude-code/issues/18980)
asks for a third "continue after the limit is reset" option. Until that exists,
this is it.

## Why this belongs in termic

The existing tools for this (claude-auto-retry and friends) run the agent
inside tmux and drive it with `tmux send-keys`, because from outside the
process that is the only handle they have. That costs them a tmux dependency, a
polling loop that screen-scrapes a pane every few seconds, and a guess about
whether the foreground process is even the agent before they start typing.

termic owns the PTY. It already has the whole apparatus:

| Need | What already existed |
|---|---|
| See the output | the `pty://<id>` chunk listener in `TerminalPane` |
| Match lines against per-agent patterns | `scanOutputLines` (tier 3, issue #68) |
| Read the current screen | `visibleTailRows` |
| Type into the agent like a human | `lib/agentSend` (text, then the CR a beat later) |
| Know which tab is which agent | the tab's `cli` and the agent registry |

So the feature is a detector, a clock, and about 150 lines of wiring. No new
dependency, no polling loop, no process sniffing, and it works for a tab that
is not on screen.

## The rule that outranks the feature

**Never select a menu option that spends money.**

A false negative parks a tab until the user looks at it, which is exactly what
happens today with the feature off. A false positive buys credits on their
card. Every ambiguous case in `lib/autoRetry.ts` therefore resolves to "do
nothing and let the user answer": no marker on the menu, no identifiable wait
row, a wait row that also mentions credits, a list that is not numbered 1..n,
fewer than two rows. `findWaitOption` returns `null` and the prompt is left
alone.

## How it works

1. **Detect.** `scanOutputLines` tests each complete output line against the
   agent's limit patterns (`lib/autoRetry` `BUILTIN_LIMIT_SIGNALS`, overridable
   per agent). Scoped to real quota exhaustion, deliberately NOT transient
   429/529 overload: those want a backoff, not a clock, and parking a tab for
   five hours over a blip is worse than doing nothing.

2. **Verify.** A match arms a staged check rather than acting immediately: the
   menu is painted after the line and repainted while it settles, so reading
   the screen the instant the notice lands reliably finds a half-drawn box.
   The check runs at 400ms, 1.2s, 2.5s and 5s (`LIMIT_VERIFY_DELAYS_MS`) and
   stops at the first one that finds either a menu or a reset time.

3. **Answer.** `findWaitOption` parses the last block of numbered rows out of
   the visible tail, finds the wait row, and returns the arrow keys to get
   there. Arrows and not the row's digit, because a digit shortcut is an
   assumption about the CLI's input handling and the marker position is
   observable fact. The Enter follows `LIMIT_SUBMIT_DELAY_MS` later, same
   reason as `agentSend`'s submit delay.

4. **Park.** The tab gets `limitWait` (runtime-only, never persisted) and a
   muted banner saying when it resumes. `resumeAt` is the parsed reset plus the
   user's margin, or `FALLBACK_WAIT_MS` (5 hours) when the notice carried no
   readable clock, in which case the banner says "estimated" rather than
   presenting a guess as a printed fact.

5. **Resume.** A 30s interval compares wall-clock against `resumeAt` and sends
   the configured message. An interval and not one long `setTimeout`: a laptop
   that slept through the reset has to wake up and fire, and a four-hour timer
   does not survive suspend reliably.

### Reading the reset time

`parseResetAt` handles the wordings observed so far, anchored on the word
"reset" so a `3pm` belonging to another sentence cannot be mistaken for one:

| Printed | Read as |
|---|---|
| `resets 3pm`, `Resets at 2pm`, `resets 3:30 pm` | that clock, today, or tomorrow if it has already gone |
| `resets 3am` seen at 10am | tomorrow's 3am, never this morning's |
| `resets at 14:30` | 24-hour clock |
| `resets Monday 9am` | next Monday (a week out if today is Monday and 9am has gone) |
| `...limit reached\|1763049600` | the unix timestamp, which beats any clock on the line |

Times resolve in **local** time, including when the notice carries a
parenthesised zone. claude prints that zone because it is already rendering the
clock in it, so "3pm (Europe/Dublin)" on a Dublin machine is 3pm local;
converting would double-apply the offset for every user whose machine agrees
with their account, which is nearly all of them. The margin absorbs the rest.

A parse landing in the past, or more than `MAX_WAIT_MS` (8 days) out, is
refused rather than clamped: a version string read as a clock would otherwise
park a tab until next year.

## What it costs when it is off

Nothing measurable, and that is load-bearing rather than incidental. Line
scanning means decoding, splitting and ANSI-stripping every PTY chunk, which
is why tier 3 was already gated behind `match_output`. With auto-resume off
the limit half contributes no patterns, `lineScanOn()` is exactly as false as
it was before the feature existed, and the data path is unchanged.

The pref is read through a store subscription rather than captured when the
PTY spawns, so turning it on reaches terminals that are already running. That
matters more here than it looks: this is the setting somebody flips *because
they are about to walk away*, and "restart your agents for it to take effect"
would miss precisely that case.

## Bounds

- **5 re-prompts per PTY lifetime** (`LIMIT_MAX_RESUMES`). A limit that has not
  really lifted prints the notice again the moment termic speaks, which re-arms
  the whole path; the ceiling is what stops that becoming a loop. Hitting it
  gives up loudly (an error toast), never silently.
- **Real user input clears the park and resets the budget.** The ceiling exists
  to stop an unattended loop, and a keystroke is proof somebody is attending.
- **A respawn clears both.** A park belongs to the process that hit the limit.
- **PTY exit clears the park.** There is nothing to type into, and the exited
  banner already says so.
- **Agent tabs only.** Never a shell, a run tab or a custom terminal entry:
  those print whatever they are told to, including the string "usage limit
  reached" out of a log file, and none of them has a menu to answer.

## Teaching another agent

The patterns are a per-agent signal class like the others, so a CLI termic has
no built-ins for is a Settings edit rather than a patch:

```jsonc
// Settings → Agents → <agent> → capabilities.signals
{ "limit": ["quota exhausted", "resets at"] }
```

Empty falls back to `BUILTIN_LIMIT_SIGNALS`, which today covers claude only.
The menu reader is agent-agnostic: it needs a numbered list, a selection
marker, and a row whose text says wait and reset.

## Files

| Path | What |
|---|---|
| `src/lib/autoRetry.ts` | patterns, `parseResetAt`, `findWaitOption`, `planLimitPark`. Pure, takes `now` as a parameter |
| `src/lib/autoRetry.test.ts` | 32 cases, most of them the refusals |
| `src/components/task/TerminalPane.tsx` | detection in the spawn effect, the clock effect, the banner |
| `src/store/prefs.ts` | `autoResumeOnLimit`, `autoResumeMessage`, `autoResumeMarginSec` |
| `src/lib/types.ts` | `TerminalTab.limitWait`, `capabilities.signals.limit` |

## Not covered yet

- **No e2e spec.** The unit tests cover the parsing and every refusal branch,
  but nothing exercises detect → answer → park → resume against a live PTY. The
  spec wants a fixture agent that prints a limit notice and a two-row menu, and
  should assert: the banner appears, the fixture received the arrow keys and
  the CR for the WAIT row (not the paid one), and a short `resumeAt` fires the
  configured message. Tracked in [e2e-coverage.md](e2e-coverage.md).
- **Verified against claude's real wording only as far as it has been
  published.** The four notice wordings and the two-row menu in
  `autoRetry.test.ts` come from Anthropic's docs, issue #18980 and
  claude-auto-retry's recorded strings, not from driving a real account into a
  limit. The patterns are overridable per agent precisely because that is a
  weaker source than a recording.
