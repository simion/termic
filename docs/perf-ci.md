# Performance benchmarks in CI (investigation)

**Status: reference.** Written as research, and the question it opened has
since been answered and partly built, which is why it sits in `docs/` rather
than `docs/ideas/`: CLAUDE.md makes it required reading before anyone adds
a perf check or a threshold. It answers one question, from a README roadmap
item that has since shipped and been pruned: can
"performance trumps polish" be enforced by CI instead of by review and
habit, and if so, which parts of it. It was
written before any of it existed and is kept as the reasoning behind
what shipped, so a future reader can tell which parts were argued for
and which were only assumed.

What exists now, and where the argument for each lives below:

| Tier | Built | Where |
|---|---|---|
| 0 — counts, PR-gating | yes | `src/store/selectorFanout.test.ts` |
| 1 — e2e invariants, PR-gating | no | still proposal |
| 2 — nightly, one gated row | yes | `perf/`, `.github/workflows/perf.yml` |
| 3 — local only | yes | `perf/local/`, section 2 of `make perf` |

Idle CPU was deliberately left out of the nightly, per the Tier 3
argument below and Orca's own practice of never running theirs in CI.

Sections marked **Finding** are things I read in a file and can point at.
Sections marked **Proposal** are a strawman for the findings to knock
over. The distinction matters here more than usual, because the first
version of this doc got its central claim about Orca wrong by reasoning
from script names instead of reading workflows.

The short answer: **yes, but only for metrics that are counts or
static facts.** App-level timings, CPU percentages and GPU utilisation
cannot be gated on a GitHub macOS runner. That split is not a compromise
invented here; it is what Orca independently converged on, and it maps
cleanly onto the bear traps in [performance.md](performance.md).

## Finding: what Orca actually gates on

Reading [stablyai/orca](https://github.com/stablyai/orca)'s 28 workflows
rather than its `package.json`. It has a large bench surface:

```
bench:idle-cpu                  bench:startup
bench:main-thread-jank          bench:daemon-coldstart
bench:hang-watchdog-memory      bench:compare
bench:wsl-hook-relay-reattach   bench:wsl-git-shell
bench:macos-computer-helper-owner-loss
test:e2e:terminal-perf          test:e2e:terminal-perf:scale
test:e2e:terminal-perf:check-report ...:summarize ...:html-report
```

**The three benches named in our README enforce nothing.**
`run-idle-cpu-benchmark.mjs` launches Electron into an isolated home
dir, samples per-process CPU and RSS via `ps` (PowerShell
`Get-CimInstance` on Windows) at 1 s intervals for 30 s after a 15 s
warmup, classifies processes into `main`/`daemon`/`gpu`/`renderer`/
`utility`/`agent-or-node`, and prints mean/p95 CPU and max RSS per
category. It defines no pass/fail criteria. `main-thread-jank-bench.mjs`
is the same shape: `ORCA_MAIN_THREAD_DIAGNOSTICS=1`, parse
`[main-thread] {json}` from stderr every 5 s over a 120 s window after a
20 s warmup, aggregate event-loop stall counts (`maxGapMs`,
`gapsOver50Ms`, `gapsOver250Ms`) and subprocess spawn churn. Records
events over 50 ms and 250 ms; fails on nothing. These are instruments a
human runs while investigating.

**The app-level timing budgets exist but are not wired to PRs.**
`check-terminal-perf-report-budgets.mjs` does `exit(1)` on:

```js
const BUDGETS = {
  maxMedianKeyLatencyMs: 75,      maxWorstKeyLatencyMs: 300,
  maxRevisitLatencyMs: 300,       maxTimerDriftMs: 150,
  maxTimerDriftUnderLoadMs: 2_500, maxScrollLatencyMs: 150,
  maxRestoreLatencyMs: 1000,      maxRendererQueuedChars: 2*1024*1024,
  maxRendererPeakQueuedChars: 2*1024*1024,
  maxRendererDroppedBacklogs: 0,
}
```

A 75 ms median keystroke budget is not a "performance trumps polish"
bar, it is a "not visibly broken" bar. That looseness is the tell: it is
what survives on a shared runner.

**These budgets ARE enforced in CI, nightly.** `terminal-perf.yml` runs
on `workflow_dispatch` plus `schedule: cron '30 8 * * *'`, on
`ubuntu-latest` under `xvfb`, `timeout-minutes: 45`. Its build step is
`npx electron-vite build --mode e2e`, and the run step is
`xvfb-run --auto-servernum env SKIP_BUILD=1 pnpm run
test:e2e:terminal-perf:scale:report` under `set -euo pipefail`.

That script, `run-terminal-scale-perf-report-gate.mjs`, is a chain:

1. `run-terminal-scale-perf-e2e.mjs --reporter=json`
2. `summarize-terminal-perf-report.mjs`
3. `check-terminal-perf-report-budgets.mjs` — **returns its exit code
   immediately if nonzero**
4. `generate-terminal-perf-html-report.mjs`

So a budget violation fails the nightly job. The JSON report uploads on
`always()` with 14-day retention; Playwright traces upload on `failure()`
with 7 days. The workflow's own comment explains the placement: "keep the
expensive scale run off PRs, but exercise it daily so terminal throughput
regressions are caught before users report typing lag".

The distinction that matters is therefore **nightly vs per-PR**, not
gated vs ungated. Orca gates app-level timings; it just refuses to put
them on the PR path, because the run is expensive and the signal needs
medians over many samples rather than one observation.

Everything above is parameterised through `workflow_dispatch` inputs
(pane counts, frame counts, pressure chars, a Playwright `--grep`), so a
human chasing a regression can re-run one arm at a chosen scale without
editing the workflow. That is a large part of why it stays useful.

**But `pr.yml` does gate, on a different class of metric entirely.**
This is the part the first draft of this doc got wrong. Every PR runs,
on `ubuntu-latest`:

```yaml
- name: Check Zustand selector fan-out budget
  run: pnpm run check:zustand-selector-fanout
- name: Enforce React Doctor on changed lines
  run: pnpm run check:react-doctor:changed -- ${{ ...base.sha }}
- name: Enforce max-lines ratchet
  run: pnpm run check:max-lines-ratchet
- name: Check feature wall asset budget
  run: pnpm check:feature-wall-assets
```

`check:zustand-selector-fanout` is `zustand-selector-fanout-benchmark.mjs
--check`. It is named a benchmark and it is one, but it never launches
the app: it builds a store with `SUBSCRIBERS = 2500`, does
`WRITES = 2000` unrelated writes, runs 5 rounds and takes the median.
Its primary assertions are **counts** (expected selector runs, zero
unexpected render invalidations), with one very loose time backstop,
`MAX_MILLISECONDS_PER_WRITE = 5`. Exits 1 on violation.

Similarly `computer-e2e.yml` runs
`pnpm bench:macos-computer-helper-owner-loss --expect reaped --trials 1`
on PRs. A benchmark script used as a *behavioural* assertion, not a
timing one.

So the accurate statement, split by *where* rather than by whether:

- **On PRs:** counts, static facts, and headless pure-JS microbenchmarks
  with order-of-magnitude time headroom. All on Linux.
- **Nightly:** app-level latency budgets, enforced, on Linux under xvfb.
- **Never in CI at all:** idle CPU, startup, main-thread jank, daemon
  cold start, hang-watchdog memory. Verified by grepping all 28
  workflows for those script names: no hits. They are local tools.

The axis is not gated vs ungated. It is **what the metric is** (a count
can gate a PR; a latency distribution needs a nightly with many samples)
and **whether the platform can be Linux** (everything Orca gates, is).

Note in particular that their one runtime PR gate, Zustand selector
fan-out, is *termic's bear trap 5*, and that the metrics they never run
in CI are exactly the four the roadmap item named (listed under
"Recommendation" below).

## Finding: why termic cannot copy the runner strategy

Orca runs its perf suite on `ubuntu-latest` with `xvfb`. Electron is
Chromium; Chromium runs headless on Linux. Every PR-gating check quoted
above is on Linux.

Termic's app cannot run on Linux at all. WKWebView is macOS-only, so any
check that launches the app has to be on a macOS runner. Per GitHub's
runner reference, standard `macos-14` is **3 (M1) cores, 7 GB RAM, 14 GB
storage**, virtualised, and Apple's Virtualization Framework does not
expose Metal Performance Shaders to the guest.

The deltas termic cares about are small in absolute terms.
performance.md records the windowless-mode result as *"hidden 0.23% CPU
vs visible 0.33%"* and explicitly calls the delta directional rather
than a headline saving. A 0.1pp CPU delta is not resolvable on a shared
3-core VM.

(I could not confirm the macOS private-repo minutes multiplier from
GitHub's docs in this pass. Cost is a real consideration for a nightly
macOS job but I am not going to quote a number I did not verify.)

## Finding: the noise floor is already documented, and it is brutal

We have run this experiment. The GH #140 renderer benchmark
(`scratchpad/gpu-bench/`, gitignored) tried to reproduce a shipped claim
that the WebGL renderer costs ~33pp of WindowServer CPU while idle. It
did not reproduce: the measured delta was 1.4-2.5pp. Getting there took
four invalidated runs. The traps are recorded in `measure.sh`:

| Trap | Effect |
|---|---|
| Comma-decimal locale | `awk` parsed `159639,08` as `159639`; every sub-second delta rounded to 0. Needs `LC_ALL=C`. |
| Occlusion, not focus | WKWebView throttles when occluded, collapsing WindowServer/WebContent/WebKit.GPU *simultaneously*. Reads as "the GL surface is free". |
| Canvas pixel count | 1500x1000 at DPR 1 is ~0.8M pixels; a Retina laptop is ~3.2M. Not comparable until maximised. |
| Cursor blink | `cursorBlink: true` is hardcoded, so a focused terminal is never idle. DOM arm: 4.0% focused vs 0.1% blurred, a 40x swing. |
| `WebKit.GPU` is not a WebGL signal | It is WebKit's compositing process, busy under the DOM renderer too. |
| Startup noise | A fixed sleep after launch caught WebContent at 12%. Must poll until quiet. |
| Ambient typing | The user typing anywhere, including in another app, breaks a run. |

Map those onto a runner. The occlusion guard is `lsappinfo front`, which
is meaningless in a runner session. "Maximise first" is unverifiable
when nothing is watching. "Poll until quiet" cannot distinguish app
startup from a noisy neighbour. The cursor-blink confound makes the
metric depend on which pane holds focus.

Every one of those produced a *plausible wrong number*, not an error.
That is the failure mode to design against, and it is how a 33pp claim
reached the 0.26.0 changelog. A gate that launders noise as evidence is
worse than no gate.

## Proposal: gate counts, track times

The regressions performance.md exists to document were almost never
"this got 8% slower". They were structural:

- `visibility: hidden` instead of `display: none`, so hidden terminals
  kept issuing WebGL draws (bear trap 2). GPU ~90% busy while idle.
- `loop { sleep(8ms) }` in the PTY flusher, 125 wakeups/s per PTY, and a
  `sleep(1ms)` exit-drain at ~1000/s (bear trap 8).
- Losing the `React.lazy` split on `EditorPane`/`DiffPane` (bear trap 1).
- A store patch per PTY chunk re-rendering the sidebar at chunk rate
  (bear trap 8).
- Destructuring the whole Zustand store instead of a tight selector
  (bear trap 5).

Each is **countable**. Zero timer wakeups on a quiet PTY is an
invariant. Live canvases in a hidden subtree is an integer. Sidebar
renders during 5 s of streaming is an integer. Whether `EditorPane` is
its own chunk is a build-time fact. None depend on machine speed,
neighbours, or a virtualised GPU. That is what makes them gateable on a
3-core VM, and it is the same reasoning that put Orca's gates on Linux.

### Tier 0: headless microbenchmarks (vitest, any OS)

The tier I missed in the first draft, and the cheapest one. Orca's
selector fan-out check is pure JS against its own store, so it runs in
the normal Linux test job with no app, no window, no GPU.

Termic can do the same in the existing `npm test` job: build the real
Zustand stores, attach N subscribers, perform unrelated writes, and
assert selector-run and render-invalidation *counts*. That is bear trap
5 turned into a required check on every PR, at nearly zero cost, on the
`ubuntu-latest` job we already run. Copy Orca's shape including the
loose time backstop, and keep the counts as the real assertion.

### Tier 1: PR-gating in the existing macOS e2e job

Deterministic, count-or-structure only. Candidates, each mapped to the
trap it guards:

| Check | Guards |
|---|---|
| Hidden panes have zero live canvases and zero geometry | bear trap 2 |
| Windowless mode drops the active pane's display exemption | bear trap 2b |
| Quiet PTY costs zero timer wakeups (Rust counter, `cargo test`) | bear trap 8 |
| PTY output coalesces to <=1 event per 8 ms | bear trap 8 |
| `lastOutputAt` patches coalesce to <=1 per 500 ms | bear trap 8 |
| Sidebar/tab render count during streaming is bounded | bear traps 5, 8 |
| `EditorPane`/`DiffPane` stay in separate chunks (vite manifest) | bear trap 1 |
| Entry bundle size under a byte ceiling | cold start |
| Settle-timing knobs stay above the floor | already done, `settleTiming.test.ts` |

I have not verified the implementation cost of any of these. The Rust
wakeup counter in particular needs a look at the flusher/waiter code
before it is more than an idea.

**RSS growth is the borderline case worth trying.** Memory is far less
noise-sensitive than CPU; a leak is a monotonic trend, not a percentage.
`wdio.conf.ts` spawns the app from Node, so the suite can shell out to
`ps -o rss=`. Open and close N tasks, settle, assert
`rss_after - rss_baseline` is under a ceiling. Gate on the delta across
iterations, never on absolute RSS, and start it report-only until real
CI runs show the distribution.

### Tier 2: nightly, off the PR path

Same shape as Orca's `terminal-perf.yml`. Cron plus `workflow_dispatch`
on `macos-26`, JSON artifact on `always()`, traces on `failure()`.

**A nightly nobody watches fails silently.** Every scheduled run from the
day it landed (5 for 5) died before running one spec: the step built an
argv array for the optional `--mochaOpts.grep` and expanded it as
`"${args[@]}"` under `set -u`, which on the macOS runner's bash 3.2 is an
UNSET expansion when the array is empty. The manual path, which is the
only one anybody ever ran, passes a grep and so always had a non-empty
array. Two things to take from it: the failure looked like a red nightly
nobody had a reason to open, and the metric it was supposed to report
(`bootToFirstPaintMs`) has no history for those five days. If a nightly's
failure is not routed anywhere, budget the attention to read it.

Its artifact was empty for the same reason, independently: `.perf/` is a dot
directory and `actions/upload-artifact` treats hidden paths as excluded, so
the step uploaded nothing directly under a log line reading "wrote 10 rows".
`.e2e/artifacts` in `test.yml` had it too, which is why no failing e2e run
ever produced a screenshot. Both now pass `include-hidden-files: true`. Any
upload of a dot-path needs it, and `if-no-files-found` at `warn` or `ignore`
will not tell you.

### The first real numbers from the runner (2026-08-17)

The first scheduled-path run that actually completed, worth recording because
this doc keeps deferring the gating question to "distribution data from real
runs":

| Metric | macos-14 runner | M1 Max local |
| --- | ---: | ---: |
| `startup.bootToFirstPaintMs` | 7419 ms | 850 ms |
| `startup.firstContentfulPaintMs` | 1663 ms | 206 ms |
| `memory.growth.totalMiB` (12 cycles, since replaced) | -88.8 | n/a |

Startup is ~9x slower on the runner, which is the concrete version of the
argument above: a threshold loose enough to survive 7.4s cannot catch a
regression that matters locally, and one tight enough to catch it fails every
honest PR. It is one sample, so it bounds nothing yet; it does say the two
environments are not measuring the same machine in the same units.

The -88.8 was not a memory result at all, it was a broken metric: growth was
`after - baseline` and the baseline had been accepted 8s into a startup decay.
It is a slope across the churn cycles now, with an r² beside it and both
functions unit-tested (`src/lib/rssTrend.test.ts`). First two local runs after
the change: **+2.39 MiB/cycle at r² 0.90** and **+2.47 at r² 0.91** over 25
cycles, end-to-end +87.6 and +88.2 MiB. That reproduces, fits well, and is the
first thing this suite has ever said that is worth chasing: either the
Dashboard/History view swap retains something per cycle, or the debug build
does.

Splitting that slope by process answered the first question about it. Over 25
cycles: **Tauri/Rust 0.00 MiB/cycle at r² 0.00, WebKit helpers 2.41 at r²
0.87.** All of it is on the webview side, which also rules out the debug
binary's debuginfo, since that is mapped into the app process, the flat one.

**It is not a retention leak, and RSS alone could never have told us.** What it
took, in order:

1. **Isolate the step.** Churning the overlay mount/unmount with no HistoryView
   in it: **+0.05 MiB/cycle**, i.e. nothing. Calling `loadAll()` on its own with
   no view churn at all: **+1.08 MiB/call at r² 0.99**. The React trees are
   free; the refetch is not. `HistoryView` fires one `loadAll` per mount
   (`History.tsx`), which is why the view swap looked responsible.
2. **Ask the heap, not the OS.** Forcing a collection means allocating, which
   raises the high-water mark itself, so "RSS after GC pressure" is confounded
   by the probe. A `WeakRef` to the arrays from an early `loadAll`, checked
   after 60 more calls plus pressure, came back **collected** on all three
   (tasks, projects, agents) while a control WeakRef to the live array was still
   reachable. Nothing in app code holds the payloads.
3. **Rule out the transport.** 60 × `home_dir`, the smallest command in the app:
   **0.004 MiB/call**. 60 × a bare `browser.execute`: **0.005**. So neither
   Tauri's invoke path in general nor the test harness is the source; it is
   specific to the calls that carry real payloads.

So the growth is allocation churn whose pages WebKit never returns to the OS,
roughly proportional to payload size, not objects we forgot to release. That is
a different problem with a different fix: there is no retaining reference to
find, and the lever is how OFTEN the app refetches, not what it holds.

It still matters. `loadAll` runs on every window focus and on every History
mount, and ~0.4-1 MiB a call that never comes back is a footprint that only
grows across a long session.

**The lesson for this suite: a positive slope is necessary but not sufficient.**
It says "RSS is rising", never "we are leaking". Confirm with a reachability
probe before anyone goes looking for a retaining reference, or a day disappears
into code that is not holding anything.

- Cold start to first paint. Needs a first-paint marker; none exists.
- Main-thread jank as frame-gap counts, bucketed over 50 ms and 250 ms.
- Absolute RSS at steady state.

**Start ungated, but do not assume it must stay that way.** Orca's
nightly enforces its budgets and fails the job, which is the one thing
this doc originally got wrong about them. The reasons that works for
them are worth copying deliberately rather than by accident:

- The thresholds are absolute and very loose (75 ms for a keystroke),
  chosen so runner noise cannot reach them.
- The metrics are medians and worst-cases over many synthetic samples,
  not one observation.
- It runs on Linux, where there is no GPU variance to speak of. Termic
  cannot copy this part, which is the single biggest reason to hold the
  gate until there is distribution data from real runs.
- Everything is parameterised via `workflow_dispatch` inputs, so a human
  chasing a regression re-runs one arm without editing the workflow.
  Build this in from the start; it is most of what makes a nightly
  worth reading instead of ignoring.

The near-term value is a timestamped series, so "feels slower lately"
becomes a chart with a bisect range. A gate can come later, from data.

### The one nightly metric that gates (2026-09-22)

That data now exists: 38 nightly artifacts, and it splits the rows into two
groups rather than one.

The timings confirm the doc's own argument, emphatically. `bootToFirstPaintMs`
ranges 2876ms to 6934ms across the series with no trend in it, a 2.4x spread
between two nights running the same code. Any threshold you could set there
either sits above 6934 and catches nothing, or sits below it and fires on a
quiet runner. They stay ungated, and a six-point sample of that series is
enough to convince you of a 3s-to-5s "regression" that is not there, which is
worth knowing before reading one.

`memory.growth.slopeAppMiBPerCycle` behaves nothing like them. Across 36
nights with a value, the fitted slope of the Tauri process's RSS under view
churn stayed between **-0.01 and +0.01 MiB/cycle**. Not a tight distribution
around a machine-dependent number: it is zero, every night, because "the Rust
side does not retain anything per view" is a property of the code and not of
the hardware it ran on. That is the count-and-invariant class this doc says to
gate, arriving in the nightly rather than the PR job only because measuring it
needs a real app to churn.

So `memory.perf.ts` now throws when it exceeds **0.15 MiB/cycle**, a 15x
margin on the widest reading in a month, and the nightly is report-only except
for that one row. Replaying the predicate over all 36 historical values fails
none of them. Over the 25 fitted cycles, the ceiling is under 4 MiB total,
which a genuine Rust-side leak clears without trying.

Two deliberate exclusions. `slopeHelpersMiBPerCycle` is NOT gated even though
it is the larger number (1.1 to 2.2 MiB/cycle, r2 >= 0.86 every night): it is
consistent, it is the webview's behaviour rather than ours, and gating a
number we have decided to live with only teaches people to raise the ceiling.
And a null slope (too few samples, a run that lost a spec) skips the check
instead of failing it, because a partial report is still worth having, which
is also why the upload step is `if: always()`.

### Tier 3: local only, real hardware

Idle CPU, WindowServer cost, GPU utilisation, renderer A/B. Needs a real
GPU, a real display, a controlled desktop, and all seven trap
mitigations. Maintainer's machine, nowhere else.

Concrete and independent of everything above: **promote
`scratchpad/gpu-bench/` into the tracked tree.** It is gitignored
session-scoped scaffolding encoding seven hard-won traps that will
otherwise be rediscovered.

## Finding: one stale doc line

**CLAUDE.md says the e2e suite is "laptop-only, no CI".** It is not.
`.github/workflows/test.yml` has an `e2e` job on `macos-26` that builds
the `--features e2e` binary and runs the full suite on every PR. Its own
comment says it is deliberately not a required check yet, "here to
surface flakiness so we can harden it before gating merges on it". That
job is the delivery vehicle for all of Tier 1, so the stale line hides
what is already available.

README item 12 also credits Orca with CI-wired gates in a way this
research does not support. Worth a rewrite, since the true story is a
better argument for the tiered approach than the current framing.

## Recommendation

Feasible, with the scope inverted from how the roadmap item stated it.

The four targets it named (idle CPU, cold start to first paint,
main-thread jank, RSS growth) are three durations and a percentage.
Those are exactly the category that cannot be gated on a virtualised
3-core runner without manufacturing false confidence. Do not build them
as PR gates.

Suggested order:

1. **Tier 0 selector fan-out test in vitest.** Cheapest, runs on the
   Linux job that already exists, gates bear trap 5, directly modelled
   on a script known to work in production elsewhere.
2. **Promote the gpu-bench harness out of scratchpad.** Standalone
   value, no dependencies, preserves knowledge that is one
   `rm -rf scratchpad` from gone.
3. **Fix the stale CLAUDE.md line.**
4. **Three Tier 1 invariants as e2e specs**: hidden-pane canvas count,
   PTY event coalescing, sidebar render count under streaming. Per
   CLAUDE.md each lands with the change it guards; per the `e2e` skill
   each spec carries several cases, not one.
5. **RSS-delta as a report-only e2e step.** Collect distribution data
   across real CI runs before choosing a ceiling.
6. **Only then** the Tier 2 nightly job, and only if 4 and 5 show the
   harness is stable enough to be worth reading.

## Open questions

- Does the `macos-14` e2e job get a real window server session, and does
  WKWebView get a hardware WebGL context or fall back to software? All
  of Tier 2 depends on this; Tier 1 is designed not to care. Cheap to
  settle: log `UNMASKED_RENDERER_WEBGL` from the e2e binary on one run.
- Does WKWebView support `PerformanceObserver` `longtask`? Sources
  disagree (Safari 17+ is claimed to support it). If not, Tier 2 jank
  measurement has to be a self-instrumented rAF-gap loop. Verify against
  the actual WKWebView build before designing around either answer.
- Is a render-count instrument acceptable behind the `e2e` feature flag?
  It must not exist in release builds.
- Where does the Rust wakeup counter live so it costs nothing when off?
- What is the macOS private-repo minutes multiplier, and does a nightly
  macOS job fit the budget?
