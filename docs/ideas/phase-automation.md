# Driving work from the phase

**Status: idea. Nothing here is built, and nobody has committed to building
it.** The phase it builds on is implemented and documented in
[ui.md](../ui.md); this doc is only about what could sit on top of it.

## What exists, and why it makes this possible

A task's phase is derived at render from signals already in memory: the task
record, the PR store and a git lookup. Todo, In progress, In review and Done
are computed, not typed. The one hand-set value is Parked, which exists
because "I put this down" has no live twin anywhere in git or the forge, and
it clears itself on the next prompt.

The rule the design stands on:

> A person may set the states the machine cannot see. The machine owns every
> state it can see. A manual state clears itself the moment evidence arrives.

That rule is what makes automation cheap here. Walk a task through the
pipeline and every step leaves a real fact behind:

| Step | The fact it writes | What the phase does |
| --- | --- | --- |
| goal submitted as a prompt | `started_at` | Todo to In progress |
| agent commits and pushes | clean tree, `ahead = 0` | In progress to In review |
| PR opens | forge state | stays In review |
| PR merges, or the branch reaches base | `merged_into_base` | Done |

So an automated pipeline needs **no status field at all**. It does the work,
and the phase follows because the work happened. Compare that with syncing a
stored column on a PR webhook: the column is a second copy of something git
already knows, and a second copy is the thing PR #292 was rejected for.

## The shape

A Planned task (a goal, no `started_at`) is the entry point. Today you start
it by hand and the goal is delivered as the first prompt. The idea is that
the same transition can be asked to carry more:

```
Planned          In progress            In review              Done
+-----------+    +-----------------+    +----------------+    +-----------+
| rate-     | -> | agent runs with | -> | second model   | -> | PR merged |
| limits    |    | the goal as its |    | reviews the    |    |           |
| (goal set)|    | prompt          |    | diff, pushes   |    |           |
+-----------+    +-----------------+    | a PR           |    +-----------+
                                        +----------------+
       ^                  ^                     ^
       |                  |                     |
   you write          automatic            automatic, and
   the goal                                optional per task
```

You define the work once, in the goal. Starting it runs the implementation,
the review and the PR, and you are handed something to look at. The phase is
the readout throughout, never the mechanism.

## What would have to exist first

1. **An action attached to a transition.** Termic already has the pieces: the
   prompt library, the review flow, the message queue and PR create. What is
   missing is the binding from "this task entered In progress" to "run this
   prompt in it".
2. **A place to configure it per project.** A repo whose review prompt is
   special needs to say so, and `.termic.yaml` is where that already lives.
3. **Completion that is not a guess.** "The agent finished" has to be a real
   signal. Agent hooks report done today, and the git state says whether
   anything was committed. Both are needed: an agent that reports done having
   written nothing has not finished, it has failed.

## Where this should stop

**No automatic merge.** The pipeline's job is to hand back a reviewable PR,
not to land it. This repo's own contributing rules say green suites are not a
manual test and that the one gate an agent-written change has to pass is a
human actually driving it. An automation that merges its own work walks
straight past that. Producing the PR is the valuable part anyway; the last
click is cheap and it is the one worth keeping.

**Fan-out has to be deliberate and visible.** One transition could spend a lot
of money across a lot of agents. Whatever starts work from a transition should
say what it is about to do before it does it, and should be off by default.

## Open questions

1. Is the transition the right trigger, or is it a button on the card? The
   trigger reads better on a board and worse everywhere else, and Termic has
   no board today.
2. Should a failed run move the phase back, or park the task with the failure
   as its reason? Parking is more honest and it reuses something that exists,
   but a machine writing the one hand-set field needs thinking about.
3. Does the second-model review belong here at all, or is it just a prompt you
   run like any other? The answer probably depends on whether its result has
   to gate the PR.
