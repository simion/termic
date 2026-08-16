# Performance

## Bear traps

1. **Lazy editor.** `EditorPane`/`DiffPane` via `React.lazy` in `TaskView`. Don't break.
2. **Keep terminals mounted, hide with `display:none`.** `TaskView`/`MainArea` toggle `display:none` instead of unmounting. `mountedTasks: Set<string>` in app store keeps every visited task rendered. NEVER switch back to `visibility:hidden`: xterm's renderer pauses only on zero geometry (IntersectionObserver), so visibility-hidden terminals kept running WebGL draws for every background TUI repaint — GPU ~90% busy and ~0.5 core of WebContent CPU with the app nominally idle. `display:none` also blurs the hidden pane, pausing its cursor-blink loop. KNOWN COST: WKWebView zeroes scroll offsets inside a `display:none` subtree. xterm does NOT self-heal — its buffer position (ydisp) survives, but the DOM `.xterm-viewport` scroller stays zeroed and nothing re-syncs it when the on-reveal `fit()` lands on unchanged dims; scrolling reads as locked (wheel-up dead, or the bottom unreachable) until new output scrolls the buffer. Both terminal panes repair it on the ResizeObserver zero → non-zero edge via `resyncViewportAfterReveal` (`src/lib/xtermViewportSync.ts`). CodeMirror and plain overflow divs treat the DOM as the source of truth — any scrollable that must survive hiding needs `attachHiddenScrollRestore` (`src/lib/hiddenScrollRestore.ts`), as EditorPane/DiffPane do. ONE EXEMPTION: a hidden PDF tab keeps its `display` and goes to `opacity: 0` instead (`keepsDisplayWhenHidden`, TaskView). The native PDF view owns the page the reader is on, exposes it to no DOM API, and is destroyed inside a `display:none` subtree — so unlike every scroller above, there is nothing left to restore. It is safe there and nowhere else: a PDF is a static image that never repaints, so an invisible one costs a composite, not a draw loop. Do not read it as licence to hide anything else this way.
2b. **Hiding the WINDOW does not pause the renderers.** Same trap as 2, one level up, and the reason windowless mode has a webview half at all. `win.hide()` (plus `ActivationPolicy::Accessory`) takes the window off screen but leaves the DOM fully laid out — measured: `document.visibilityState === "hidden"` while `.xterm-screen` still reported **1368×1190 with 7 live canvases**. xterm keys its pause on ZERO GEOMETRY, which only `display:none` produces, so a windowless Termic would keep running WebGL draws for a window nobody can see. Rust emits `termic://windowless` on every windowless edge and `MainArea` drops the ACTIVE pane's display exemption (`src/lib/windowlessMode.ts`), which is what actually stops the draws. Deliberately NOT keyed on `visibilitychange`: that also fires for an occluded window or a Space switch, and collapsing panes on every Space switch would churn layout and xterm viewport state for a window still one gesture away. Measured cost, 3 tasks idle, WITH the collapse in place: hidden 0.23% CPU vs visible 0.33%. Both are near zero, so treat that delta as directional, not as a headline saving - and memory is not reclaimed at all (every mounted task keeps its scrollback and React tree). Windowless mode is about keeping agents alive, not about getting cheaper. Under load the comparison was confounded by the measurement harness and no reliable figure was obtained. THE 1 Hz CLAMP IS NOW LOAD-BEARING: `--wait`, `termic list` and the work-done indicator all ride the settle signal, and there is exactly one timer behind every settle path (the `setInterval` in TerminalPane's settle effect, period `SAMPLE_MS`). A knob tuned under the clamp stops being observable the moment Termic has no window, and nothing else catches it. The four knobs live in `src/lib/settleTiming.ts` with the floor asserted in `settleTiming.test.ts` — tune them freely above the floor; going below should mean deleting a test that says why.
3. **WebGL non-negotiable.** Load AFTER `term.open(host)`. Dispose `webglAddon` BEFORE `term.dispose()` — render loop fires on half-disposed terminal otherwise (`_isDisposed` crash). Same fix in TerminalPane AND AuxTerminal.
4. **`lineHeight: 1.0` in xterm.** Anything else inflates cells; TUIs show ribbons between rows.
5. **Tight Zustand selectors.** Never destructure the whole store. Use frozen empty constants (`EMPTY_TABS`) for referential stability — React 19 warns "getSnapshot should be cached". GUARDED: `src/store/selectorFanout.test.ts` mounts 500 `useTaskTabs` subscribers, runs 1000 `setSidebarWidth` writes (a sidebar drag) and asserts **zero** snapshot invalidations. Selector bodies are exported from `app.ts` (`selectTaskTabs`, `selectActiveTabId`) so the test measures the real thing. Making a selector derive a fresh array turns that 0 into 500,000 and fails the build — verified by injecting the regression, not assumed.
6. **`Math.round` every dimension.** Sub-pixel widths blur glyphs in WKWebView. All sidebar/right-panel/footer/split setters round on write AND on `localStorage` read.
7. **Disable transitions during drag.** `App.tsx` grid uses `transition: var(--cols-transition, …)` and `ResizeHandle` sets `--cols-transition: none` on `<html>` while dragging.
8. **A store setter that writes an UNCHANGED value is an idle CPU leak.** Zustand 5's `setState` does `Object.assign({}, state, next)` over the whole ~233-key `AppState`, and a fresh `tabs` record then invalidates every selector in every mounted task plus three module-level `useApp.subscribe` consumers (`cliAgentState`, `trayAttention`, `useAttentionNotifier`), each of which walks all tasks × all tabs. So the cost of one write is paid across the whole app, not just the tab that changed. `setTabLiveTitle` had no equality check while `setWorkState` and `setWorkProgress` did, and that asymmetry was worth ~a third of idle CPU: xterm fires `onTitleChange` for EVERY OSC 0/2 without comparing it to the previous value (`InputHandler.setTitle`), and an agent TUI re-emits its unchanged title while it sits at the prompt. Measured on a 16-terminal fixture doing nothing but repainting one title twice a second per terminal: **19.02% of a core and 62 store writes/s, falling to 12.70% and 31 writes/s** once the setter bailed. Any new setter on a PTY-driven path needs the same bail, and the invariant is a count assertion (`app.test.ts` "notifies subscribers ONCE for a title repainted 100 times"), so it can gate a PR where a timing would not. NB the profile of this failure has **zero** WebCore layout/paint frames — it is all `globalFuncCopyDataProperties` plus GC — so "the terminals aren't drawing" does not mean the terminals are free.
9. **PTY firehose.** Coalesced in Rust: the flusher batches reader output into ≤1 event per 8ms. The flusher and exit-waiter BLOCK on a condvar the reader signals — no sleep-loop polling. A quiet PTY must cost zero timer wakeups; the old `loop { sleep(8ms) }` flusher burned 125 wakeups/s per PTY forever, and the old `sleep(1ms)` exit-drain spun at ~1000/s (forever, if an orphan held the PTY slave open). On the JS side, the per-chunk `lastOutputAt` store patch is coalesced to one per 500ms so streaming doesn't re-render tabs/sidebar at chunk rate. KNOWN COST (CLI Phase 2): role-tagged PTYs (agent tabs, aux shell) additionally append each read into a 256 KiB `PtyRing` under a mutex on the reader thread (`termic logs` / attach backlog) — one uncontended lock + a bounded VecDeque extend per ≤64 KiB read, off the UI path, zero wakeups when quiet; attach taps only cost when a session is live and are bounded (force-detach on overflow). If profiling ever fingers it, gating the ring on "CLI enabled" is the lever.

## Sub-pixel / rendering hardening

- Force grayscale font smoothing on `html` (`-webkit-font-smoothing: antialiased`) — subpixel AA produces colored fringing on dark backgrounds.
- Dialogs use flexbox centering on a full-viewport wrapper, no transforms on `Dialog.Content` — `-translate-x-1/2 -translate-y-1/2` hits sub-pixel offsets on odd viewport widths.
- Streaming output / `pre` boxes inside dialogs need `min-w-0` on grid items (default `min-width: auto` overflows).
- `ResizeHandle` is 1px wide (`-ml-px`/`-mt-px`) with 4px invisible hit area each side.
- Terminal text lighter than native: WebGL atlas rasterizes via Canvas 2D. Mitigation: `terminalFontWeight` pref, Medium (500) closes most of the gap.
- `document.fonts.check()` lies in WKWebView — use canvas measurement against two baselines (monospace + serif) instead.

## Measuring

Two places, and the split is deliberate: **counts can gate a PR, timings
cannot.**

- **CI-gateable (counts, invariants, static facts).** Runs in `npm test` /
  `cargo test` / the e2e job. `selectorFanout.test.ts` is the worked example.
  Machine-independent, so a 3-core CI VM gives the same answer as an M1 Max.
- **Nightly, ungated (startup, memory).** [`perf/`](../perf/README.md), run by
  `.github/workflows/perf.yml` at 03:30 UTC and never on a PR. Durations and
  RSS: measurable on a runner, too noisy there to gate a merge. Reports to the
  run's step summary and a 90-day JSON artifact.
- **Local only (CPU, GPU, compositor).** [`bench/`](../bench/README.md).
  Requires a real GPU, a real display and an undisturbed desktop. Read
  `bench/README.md` before trusting any number it prints: seven documented
  traps, every one of which produces a plausible wrong number rather than an
  error.

```sh
make perf       # nightly suite, then the local-only bench, reported separately
make perf-ci    # nightly suite only
```

Idle CPU is deliberately absent from CI. Why, and what it would take to gate
any of this: [docs/research/perf-ci.md](research/perf-ci.md).
