# Every state an agent tab can be in

One page for the question "why is this tab showing that". It covers what the
agent can tell termic, what termic turns that into, what you see, and what ends
it. The mechanics live elsewhere and are linked per row: the hook transport in
[agent-hooks.md](agent-hooks.md), the rendering conventions in [ui.md](ui.md),
the policy for delegated work in `src/lib/delegatedWork.ts`.

Two things to hold onto before the table:

**`workState` has three values, not seven.** `idle`, `working`, `done`. Two
separate fields qualify them, and that is why the list below is longer than
three: `unread.reason` (what the tab is owed, which survives the state
changing) and `delegatedWork` (what the agent handed off and has not
finished). A fourth `workState` would have to be understood by
`taskWorkState`, `waitingAgents`, `cliAgentState` (whose `work_state` is a
PUBLISHED CLI contract), the sidebar, the tab bar and the dashboard, none of
which have an opinion about it.

**"The agent is working" and "a model is computing" are different claims.** An
agent waiting on three subagents has stopped generating: nothing is being
computed, and it can stay that way for hours. Most of the subtlety here is
that distinction.

## The states

| # | State | What it means | You see | Bell? | What ends it |
| --- | --- | --- | --- | --- | --- |
| 1 | `idle` | Nothing running, nothing outstanding | nothing | no | a submit |
| 2 | `working` | The model is generating right now | solid spinner, 1s | no | a done, an interrupt, the process exiting, the ceiling |
| 3 | `working` + delegated | The model STOPPED; waiting on work it delegated | dashed ring, one slow turn per 8s | no | the work reporting back, or the grace |
| 4 | `working` + delegated `partial` | Some of that work came back; the rest runs on | outlined blue dot, or the ring when `partialDoneIndicator` is off | no | the remaining work, or the grace |
| 5 | `done` | The turn ended | solid blue dot | YES | focusing the tab, or the next submit |
| 6 | `done` / `idle` + delegated | The turn ended and left something running | blue dot, then the dashed ring once acknowledged | yes, once | the leftovers finishing, or the next turn |
| 7 | attention (`unread.reason`) | The agent is blocked ON YOU: a permission prompt, a question | bell | YES | answering it (a key in that terminal, Escape, Ctrl-C) or the agent's done hook; NOT looking at it |
| 8 | interrupted | You pressed Escape or Ctrl-C | nothing | no | (already over) |
| 9 | failed | A run or setup script exited non-zero | red triangle | no | a re-run |
| 10 | ceiling | termic gave up waiting after 20 minutes | nothing (clears to `idle`) | NO | the next heartbeat re-arms working |

Row 10 is not a state the agent reported, and it is the only row that is a
guess. It clears a spinner and deliberately says nothing else: announcing "your
agent finished" on the strength of a timer is a claim termic has not earned.

Rows 3, 4 and 6 are all `delegatedWork` and are worth reading together, since
the difference between them is the whole design (below).

## What the agent can say

Over the hook channel, which is one OSC 777 with a trusted `termic` sender and
a body that says which signal it is (`lib/agentHooks.ts`):

| Signal | Body | Meaning |
| --- | --- | --- |
| ready | `agent ready for input` | past its own startup; a typed message will land in the input box |
| working | `agent working` | a turn started, and the heartbeat that re-asserts it |
| done | `agent done` | the turn ended with nothing outstanding |
| delegated | `agent delegated: <count> <label> <ids>` | the turn ended but the AGENT has work outstanding |
| attention | `agent needs your permission: <tool>` | blocked on you |
| session | `session <id>` | the conversation moved (`/clear`, `/resume`) |
| usage / context | `usage …`, `ctx …` | the footer readouts, never a badge, with one exception below |

**A window at 100% parks the tab as delegated.** claude gives no hook for a
usage limit (2.1.304: none of its thirteen notification types is one) and
prints nothing on the wire while it waits to continue, which is byte-identical
to a model mid-token. Measured from termic-workstate.log: `agent working`,
the status line at `usage 100 ...` a second later, then nothing for twenty
minutes. The status line is the only witness, so a `usage` reading with
either window at exactly 100 while the tab is `working` sets `delegatedWork`
to the synthetic `usage_limit` label (state 3, the dashed ring, no bell). It
is cleared by the next working hook (the agent is generating again) or by a
reading below 100, and the absolute ceiling still applies on top. A tab with
a custom status line never gets a reading, never enters this, and keeps the
old behaviour: that path is guarded on the label, not on the reading.

Only the first five touch the state machine. An agent with no hooks falls back
to its title, OSC 9 and quiet heuristics, which is the same machine with worse
inputs; see agent-hooks.md "Why not read the terminal".

## Delegated work: the three verdicts

When a done hook finds work outstanding it reports it rather than going
silent, and termic compares the outstanding set against the last report from
the same pty. `delegatedVerdict` in `src/lib/delegatedWork.ts`:

| Verdict | The set | Who asked | Result |
| --- | --- | --- | --- |
| `new` | anything was added, or it is the first report | either | state 3, no bell |
| `shrank` | strictly smaller, nothing added | either | state 4, no bell |
| `carried` | IDENTICAL to the last report | a HUMAN | state 6: a real done, with the bell |
| `new` | identical, but the turn was a resume | the agent itself | state 3, no bell |

Both halves of that last pair were measured, and both were got wrong first:

- **Subset is not the same as unchanged.** Three background tasks report back
  one at a time and every `Stop` carries the remainder: `{a,b,c}`, `{b,c}`,
  `{c}`, empty. Each is a subset of the one before, so a subset test called
  the turn over after the first one landed, ringing "done" with two still
  running.
- **An unchanged set only means "finished" relative to something a person
  asked for.** An agent re-invoked by its own task notification stopped twice,
  1.5 seconds apart, with a byte-identical set, mid-orchestration. The test is
  therefore whether `lastInputAt` moved since the previous report: every send
  path stamps it (typing, the queue, a broadcast, the CLI), and a
  `<task-notification>` resume stamps nothing.

Four switches govern which of these draw, under Settings, Notifications, one
row each showing the mark it controls:

| Switch | Governs |
| --- | --- |
| `workingIndicator` | every MID-TURN mark: states 2, 3 and 4 |
| `partialDoneIndicator` | state 4 only, falling back to state 3's ring |
| `settledHighlight` | state 5, the done bullet |
| `attentionIndicator` | state 7, the bell |

Two of those groupings are the point. Everything mid-turn is one switch,
because "do not show me busy agents" is a single question and a user who
answers no does not then want a quieter ring instead: the ring used to hang
off `settledHighlight`, so turning the spinner off left one in its place.
And `partialDoneIndicator` off falls back to the ring, never to a done: the
turn is not over, and the one thing that switch must not do is announce one
early.

The bell was split out of `settledHighlight`, which still carries the
"work done" name it has in Settings. `attentionIndicator` seeds from it when
its own key is absent, so an install that had the work-done UI switched off
does not start ringing after the upgrade.

So a turn that delegates work rings exactly once, when the last of it is done,
and the landings in between show as state 4. A shell nobody ever collects
(`npm run dev`) ends its turn at the detached grace,
`DELEGATED_DETACHED_GRACE_MS`, five minutes; agent-owned work has no clock on
it at all, because it is measured to come back on its own.

### Partial is news; looking at the tab reads it

Partially done (`delegatedWork.partial`) says "some of what the agent
delegated came back". Showing the tab (`setActiveTabId`, or
`useSeenWhenWatched` when it is already in front of a focused window) reads
that news: `partial` drops to false and the tab shows the plain delegated
ring, because the rest is still running. The next piece of work to report
back sets it again, and the last one ends the turn with the usual done.
Nothing but the badges reads the flag, so clearing it changes the mark only.

### A question is not answered by looking at it

Every other mark clears when the tab is in front of you (`setActiveTask`,
`setActiveTabId`, `useSeenWhenWatched`). Attention does not
(`unreadClearsOnSight` in `lib/taskWorkState.ts`): the agent is still
blocked while you read its question. It clears on an answer, meaning any key
you type in that terminal (claude's permission prompt takes a bare digit, no
Enter), a bare Escape or Ctrl-C, or the agent's own done hook (the turn is
over, so nothing in it is waiting: a question answered through claude's
remote control, or one it gave up on). xterm's automated replies begin with
ESC and arrow keys do too, so neither counts. A working heartbeat does not
count either: parallel subagents fire tool hooks while one of them sits on a
permission prompt. The board's "mark settled" drop still clears it, as an
explicit command.

It used to clear on sight like the rest. A question you had glanced at and
left read as a finished turn: off the bell, and under Settled on the board and
in the sidebar's status section, while the agent sat waiting.

### Agent messages while delegated

In the delegated and partially-done states the agent's own loop has
stopped (its `Stop` hook reported the held work), so `delegatedIdle` is
set on the tab, and another agent's message (`termic send`, MCP
`task_send`) is typed at once instead of queueing until every subagent is
back. That is the report-back path: a worker finishing is exactly what an
orchestrator in this state is waiting to hear. Any working signal clears
the mark (a subagent's report making the agent resume, for one), so a
queued message never lands mid-generation. Since sends became immediate
by default, that only applies to `termic send --queue` (MCP `task_send`
with `queue`): a plain send types the prompt into a turn that is running
(wire field `now`, which the CLI and MCP set unless asked to queue). It leaves the tab's work state alone (the agent is
still working) and it does not outrank a draft the user is typing. The USER's message queue ignores the
mark and still waits for the turn to end.

### Never into a draft

Every automatic send types into the same prompt the user types into, so a
message arriving mid-sentence landed inside their text and the next Enter
submitted both. `composing` on the tab tracks the user's own keystrokes
(`nextDraft` in `lib/draftTracker.ts`, fed by TerminalPane `trackDraft`:
printable input and pastes start a draft, Up arrow's history recall counts as
one until Down steps back out, Enter or Ctrl-C / Ctrl-U or deleting it all
ends it, by character or by word; Shift+Enter is written straight to the PTY,
so a multi-line draft stays one). A key pressed while the tab is marked
`attention` is an ANSWER to the agent's own prompt and never a draft, and a
respawn starts empty.

**A draft that is not there is a deadlock.** Every message for the tab
queues, the turn-end drain refuses, the stall watchdog stands down, and only
an Enter in that terminal clears it, which an agent only other agents talk to
never gets. The tracker was a character count, and claude's permission
dialog, which takes a bare digit and no Enter, left it at one for good; so
did Ctrl-W and Option-Backspace. It still errs towards "there is a draft"
where it cannot see the text (an edited history entry, a kill-line), because
typing into a real one is the worse mistake. A hold is written to the
work-state log as `queue-held ... why=draft in the prompt`, once per hold. While it is set, the message queue does
not send (except "Send now", which is the user asking) and an agent's
message queues even on an idle agent. The queue resumes when the draft
ends: Enter starts the user's turn and its done drains the queue after, and
a draft cleared on an idle agent wakes the queue once the keyboard has
been quiet for 1.5s (`TYPING_QUIET_MS`). Not at once: a held Backspace
empties the draft while the key is still repeating, and a message pasted
the moment it was empty lost its text to the repeats that followed. The
log says `queue-held ... user still typing`. It is keystroke
based and so agent-agnostic; a key that clears a draft in only one agent
(claude's double Escape) leaves the message held until the next Enter,
which is the safe failure.

## What each surface draws

Priority, high to low, and it is the same chain everywhere:
`failed > attention > partial > done > working > delegated > dirty`.

- **Tab strip** (`TabBar`) — every state, with `data-work-state` and
  `data-delegated` for specs.
- **Sidebar row** — per tab when the task is expanded; one aggregate badge
  when collapsed (`taskWorkBadge`). The aggregate is what you scan when the
  task is not on screen, so state 6 draws there too.
- **Dashboard** — the same aggregate, same helper, deliberately not a second
  copy of the precedence.
- **Tray / OS notification / ⇧⌘A pill** — attention and done only. Delegated
  work never counts as waiting on you: a dev server running is not a thing you
  owe an answer to.

## When a tab reads wrong

Everything above is traced to `termic-workstate.log` in the OS temp dir
(`-dev` and `-e2e` suffixes per build flavour, `lib/workStateLog.ts`). It is
always on, because the person a stuck spinner happens to is running a packaged
build with no devtools.

The line for this feature is `hook-delegated`, and it carries every input the
rule saw plus what it decided:

```
hook-delegated cli=claude task="api" held=2 subagents verdict=shrank
               agentOwned=true humanAsked=false was=[a1,a2,a3] now=[a2,a3]
```

`was` and `now` are the two sets, `humanAsked` is the resume test, `verdict`
is the answer.

A badge that is stale rather than wrong usually shows up as `refused
rule=sticky-done` or `downgrade rule=working-inside-clear-grace`: both are
guards against a mark re-arming itself right after it was cleared, and both
stand down as soon as the tab has input newer than the thing they are
guarding. A run where they did not: done at :40.238, the user typed at :40.5,
the agent's working hook at :46.363 refused as sticky, and the tab read
"finished" for two more seconds with the agent working. Also useful nearby: `hook-proven` (hooks earned the right to
own this tab), `done-deferred` (a done held back by the agent's own status
line), `delegated-grace`, `ceiling-backstop`, and `done-unasked`.
