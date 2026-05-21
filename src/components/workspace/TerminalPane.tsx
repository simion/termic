// Single terminal tab: spawns a PTY on first mount, attaches xterm.js, owns
// the resize/refit dance and the attention/unread heuristics. Stays mounted
// across tab switches (parent toggles visibility) so we don't reconnect PTYs.

import { useEffect, useRef, useState } from "react";
import { RotateCcw, Shield, AlertTriangle, TerminalSquare } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { loadTerminalRenderer } from "@/lib/terminalRenderer";
import type { TerminalTab, Workspace } from "@/lib/types";
import * as ipc from "@/lib/ipc";
import { usePrefs, currentTerminalStack, currentTerminalTheme, currentColorFgBg } from "@/store/prefs";
import { spawnArgsForCli, spawnCommandForCli, tryToggleYoloLive, envForCli } from "@/lib/agents";

interface Props { ws: Workspace; tab: TerminalTab; active: boolean; }

// Settled-detection knobs. We sample the visible buffer every SAMPLE_MS and
// mark the tab "settled" once SETTLE_SAMPLES consecutive samples produce the
// same hash. Net stillness threshold = SETTLE_SAMPLES * SAMPLE_MS.
const SAMPLE_MS = 3000;
const SETTLE_SAMPLES = 2;

/** FNV-1a 32-bit hash of the visible viewport's text content. Cheap enough
 *  to run every 3s on every live terminal; the cost is one pass over ~3K
 *  characters + multiply-and-xor per char. */
function hashVisibleBuffer(t: Terminal): number {
  const buf = t.buffer.active;
  const top = buf.viewportY;
  const rows = t.rows;
  let h = 0x811c9dc5;
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(top + i);
    if (!line) continue;
    // `true` = trim trailing whitespace — keeps the hash stable against
    // cursor-position-only changes that leave the row content identical.
    const s = line.translateToString(true);
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 10; // newline marker between rows
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
// Theme is no longer a module-level constant - it depends on the user's
// current themeMode pref (dark / light / espresso / solarized). Each
// terminal instance picks the matching palette at mount AND re-reads it
// whenever the pref changes (see the themeMode effect below).

export function TerminalPane({ ws, tab, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  const ptyRef = useRef<string | null>(null);
  // Settled-detection state: hash of the last sampled viewport + count of
  // consecutive identical samples + whether we've already marked this cycle
  // (so we mark once per "agent goes from working → settled" transition).
  const settledRef = useRef({ lastHash: 0, unchangedCount: 0, marked: false });
  // Respawn machinery: when the agent process exits (user typed `exit`,
  // claude crashed, etc.) we tear down the PTY but KEEP the terminal
  // mounted with its scrollback. The "Restart" overlay then bumps `gen`
  // which retriggers the spawn effect with a fresh PTY. Without this the
  // pane was dead until the user closed + reopened the tab.
  const [gen, setGen] = useState(0);
  const [exited, setExited] = useState(false);
  // Sandbox status from Rust's per-spawn `sandbox-status://<ptyId>`
  // event. Drives the warning chip in the status footer when the
  // tinyproxy failed to start (= full network deny instead of
  // allowlist). Resets to null on each respawn so a stale warning
  // from the prior PTY doesn't carry over.
  const [sandboxWarning, setSandboxWarning] = useState<string | null>(null);
  // Per-component "has the worktree's history flag been flipped during
  // THIS spawn yet" — separate from the persisted ws.has_resumable_history
  // so we don't double-set across reloads. Resets each gen bump.
  const hasHistoryLocalRef = useRef(false);
  // Auto-fallback machinery: a resume-attempt spawn that dies within
  // RESUME_FAILURE_MS is almost certainly "no conversation found" —
  // flip the persistent ws.has_resumable_history → false and respawn
  // fresh. failedResumeRef gates the in-component immediate retry
  // (next render of the effect skips resume even before loadAll
  // refreshes the prop). It clears once a fresh spawn succeeds.
  const spawnStartedAtRef = useRef(0);
  const lastSpawnWasResumeRef = useRef(false);
  const failedResumeRef = useRef(false);
  const RESUME_FAILURE_MS = 2000;

  const patchTab = useApp(s => s.patchTab);
  const markAttention = useApp(s => s.markAttention);
  const clearAttention = useApp(s => s.clearAttention);
  const setTabLiveTitle = useApp(s => s.setTabLiveTitle);
  // Per-effect busy ref: tracks whether OSC 9;4 has us in a busy state.
  // Used to emit a "done" attention edge when the program transitions
  // busy → idle (state = 0). Persisting on the tab model would just be
  // noise — only the edge matters.
  const busyRef = useRef(false);
  // Bridge from the PTY data listener (registered deep inside the
  // spawn flow) to the OSC 9;4 done timer (defined right after the
  // terminal is opened). Set inside the effect after the timer is
  // wired; called from the data callback to debounce-extend.
  const pushOscDoneRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: currentTerminalStack(),
      fontSize: usePrefs.getState().terminalFontSize,
      // Regular 400 / bold 700 — the two static JetBrains Mono masters
      // bundled with the app. Any other weight forces xterm's WebGL atlas
      // to interpolate, which WKWebView rasterizes soft. Pinned, not a pref.
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: usePrefs.getState().terminalLetterSpacing,
      // 1.0 is xterm's default and what TUIs (gemini, claude, etc.) assume.
      // A larger lineHeight inflates every cell vertically, so any row the TUI
      // paints with a bg color reads as a visible "ribbon" instead of a tight
      // band against neighbouring rows.
      lineHeight: 1.0,
      theme: currentTerminalTheme() as any,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Links: underline on hover (addon default), but only OPEN on
    // Cmd/Ctrl+click. A plain click in a terminal means "move cursor /
    // select" — opening a browser on every stray click is jarring, and
    // TUIs (gemini/claude) print URLs constantly. Matches the editor's
    // Cmd-click convention. Route through `open_path` so the link hits
    // the system browser, not the WKWebView (window.open would navigate
    // or silently no-op inside the webview).
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey || event.ctrlKey) {
          ipc.openPath(uri).catch(() => {});
        }
      }),
    );
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // Shift+Enter → newline-without-submit.
    //
    // xterm.js by default sends plain \r for BOTH Enter and Shift+Enter,
    // so without an override the agent can't tell them apart.
    //
    // We send `\\` + `\r` (literal backslash then CR) — the same
    // sequence `/terminal-setup` writes into iTerm2 for Claude Code.
    // Claude's input parser reads the trailing backslash as a
    // continuation marker and inserts a soft newline instead of
    // submitting. Gemini + codex also accept this convention.
    //
    // ESC+CR (`\x1b\r`, the old Option+Enter convention) was tried
    // first but recent claude builds no longer recognize it — they
    // require the explicit backslash-Enter pair.
    term.attachCustomKeyEventHandler((e) => {
      const isEnter = e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
      if (e.type === "keydown" && e.shiftKey && isEnter && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const pid = ptyRef.current;
        if (pid) {
          // `\` + `\r` (0x5c 0x0d) — claude's `hasUsedBackslashReturn`
          // path. Gemini + codex accept it too.
          ipc.ptyWrite(pid, [0x5c, 0x0d]).catch(() => {});
        }
        // BOTH stops are required:
        //   - return false      → xterm.js skips its keydown handler
        //                         (otherwise it'd also emit \r)
        //   - preventDefault    → WKWebView skips inserting `\n` into
        //                         the helper textarea, which would
        //                         otherwise fire xterm's input-event
        //                         listener and submit anyway. This was
        //                         the bit that took the longest to
        //                         find: every "right" byte sequence
        //                         (ESC+CR, \\\r, LF, modifyOtherKeys)
        //                         was being suffixed by a stray LF
        //                         from the textarea insertion, so
        //                         claude always submitted.
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      return true;
    });

    // ── Sender-driven status signals ──────────────────────────────────
    //
    // Each agent CLI has its own dialect (researched from upstream
    // source). Termic listens to ALL of them so detection works
    // regardless of which agent is running in this tab:
    //
    //   Claude Code → OSC 9;4 (ConEmu progress protocol). State 1/3 =
    //     busy, state 0 = idle. The reliable signal. Caveat: Claude
    //     emits 0 between tool calls too, so we debounce.
    //
    //   Gemini CLI → OSC 0 title with explicit per-state strings from
    //     packages/cli/src/utils/windowTitle.ts:
    //       "◇  Ready (folder)"           idle
    //       "✦  Working… (folder)"        busy
    //       "⏲  Working… (folder)"        busy (silent variant)
    //       "✋  Action Required (folder)" busy/waiting (treat as busy
    //                                      so the agent looks live;
    //                                      attention dot is separate)
    //
    //   Codex → OSC 0 title with literal status words from
    //     codex-rs/tui/src/chatwidget/status_surfaces.rs:
    //       "Ready"                       idle
    //       "Working" / "Thinking"        busy
    //       "Waiting" / "Action Required" busy/waiting
    //
    // For unknown CLIs (custom agents) we fall back to the OSC 9;4
    // signal only — no title heuristic, no churn timer (which always
    // ran the risk of false positives).
    //
    // Set `localStorage.debugWorkDone = "1"` in devtools to log every
    // signal — useful for diagnosing future mis-fires.
    const wdDebug = (() => { try { return localStorage.getItem("debugWorkDone") === "1"; } catch { return false; } })();
    const wdlog = (msg: string, extra?: unknown) => {
      if (!wdDebug) return;
      const tag = `[work-done ${ws.name}/${tab.cli}]`;
      if (extra !== undefined) console.log(tag, msg, extra);
      else console.log(tag, msg);
    };

    // Per-CLI title classifier. Three states:
    //   "busy"      → agent is actively working; cancel any pending done-mark.
    //   "idle"      → agent finished, no input needed; fire "done" (green ✓).
    //   "attention" → agent stopped, waiting on user (Action Required,
    //                 Waiting, ✋); fire "attention" (orange bell).
    // Returns null when the title doesn't match any known state for
    // this CLI.
    const classifyTitle = (cli: string, title: string): "busy" | "idle" | "attention" | null => {
      const t = title.trim();
      if (!t) return null;
      if (cli === "gemini") {
        if (t.startsWith("✋") || /Action Required/i.test(t)) return "attention";
        if (t.startsWith("◇") || /^\s*Ready\b/.test(t)) return "idle";
        if (t.startsWith("✦") || t.startsWith("⏲") || /Working/i.test(t)) return "busy";
        return null;
      }
      if (cli === "codex") {
        if (/\b(Waiting|Action Required)\b/.test(t)) return "attention";
        if (/\bReady\b/.test(t)) return "idle";
        if (/\b(Working|Thinking)\b/.test(t)) return "busy";
        return null;
      }
      return null;
    };

    // Single done-timer shared between OSC 9;4 (Claude) and the title
    // classifier (Gemini, Codex). Arming twice cancels the prior arm;
    // any "busy" signal cancels outright. PTY data activity also pushes
    // it out — see pushOscDoneRef below.
    busyRef.current = false;
    const OSC_DONE_DELAY_MS = 8_000;
    const TITLE_DONE_DELAY_MS = 2_500;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;
    let doneArmedAt = 0;
    let doneArmedDelay = 0;
    // The done-timer carries the REASON it was armed with so it can
    // emit "done" (regular finish) or "attention" (Action Required /
    // Waiting / OSC 1337 RequestAttention) → different sidebar icons.
    let doneReason: "done" | "attention" = "done";
    const cancelDoneTimer = (reason: string) => {
      if (!doneTimer) return;
      clearTimeout(doneTimer);
      doneTimer = null;
      wdlog(`done-timer cancelled (${reason})`);
    };
    const armDoneTimer = (reason: string, delay: number, kind: "done" | "attention" = "done") => {
      if (doneTimer) clearTimeout(doneTimer);
      doneArmedAt = Date.now();
      doneArmedDelay = delay;
      doneReason = kind;
      doneTimer = setTimeout(() => {
        wdlog(`done-timer fired → markAttention("${doneReason}")`);
        markAttention(ws.id, tab.id, doneReason);
        doneTimer = null;
      }, delay);
      wdlog(`done-timer armed (${reason}, kind=${kind}) for ${delay}ms`);
    };

    // OSC 0/2 — title change. Always surface as the live tab label;
    // additionally feed the per-CLI classifier for done detection.
    // Edge-detect for title-driven states. Gemini re-emits "◇ Ready"
    // on spawn AND periodically while idle — firing markAttention()
    // every time spams the unread dot for work that never happened.
    // Only fire "done" on a BUSY → IDLE transition (mirrors the OSC
    // 9;4 detector). "attention" still fires on any edge → attention
    // because "✋ Action Required" is always actionable.
    let lastTitleState: "busy" | "idle" | "attention" | null = null;
    term.onTitleChange(t => {
      setTabLiveTitle(ws.id, tab.id, t);
      const state = classifyTitle(tab.cli, t);
      wdlog(`title change [classifier=${state ?? "unknown"}, last=${lastTitleState ?? "none"}]`, t);
      if (state === "idle") {
        // Only fire if we ACTUALLY saw busy first. Initial spawn /
        // periodic re-emits of "Ready" without prior work are no-ops.
        if (lastTitleState === "busy" || lastTitleState === "attention") {
          armDoneTimer(`title busy→idle`, TITLE_DONE_DELAY_MS, "done");
        }
      } else if (state === "attention") {
        // Always honor explicit attention — even from a cold start
        // the user wants to see "I'm blocked on you."
        armDoneTimer(`title attention`, 600, "attention");
      } else if (state === "busy") {
        cancelDoneTimer(`title busy`);
      }
      if (state) lastTitleState = state;
    });

    // OSC 9;4 — Claude. Same arm/cancel as the title classifier so
    // both paths funnel through one timer.
    term.parser.registerOscHandler(9, (data) => {
      const parts = data.split(";");
      if (parts[0] !== "4") return false;
      const state = Number(parts[1] ?? "0");
      const nowBusy = state === 1 || state === 2 || state === 3 || state === 4;
      wdlog(`OSC 9;4;${state} (busy=${nowBusy}, was=${busyRef.current})`);
      if (busyRef.current && !nowBusy) {
        armDoneTimer(`OSC 9;4;${state}`, OSC_DONE_DELAY_MS);
      } else if (nowBusy) {
        cancelDoneTimer(`OSC 9;4;${state}`);
        // New work started — drop the stale "done" check (set on a
        // previous turn) so it doesn't read as "this turn finished
        // immediately." The next busy→idle transition arms a fresh
        // done-mark.
        const cur = useApp.getState().tabs[ws.id]?.find(t => t.id === tab.id)?.unread;
        if (cur?.reason === "done") clearAttention(ws.id, tab.id);
      }
      busyRef.current = nowBusy;
      return false;
    });
    // Backwards-compat names for the rest of this effect.
    const cancelOscDoneTimer = cancelDoneTimer;
    const armOscDoneTimer = (reason: string) => armDoneTimer(reason, OSC_DONE_DELAY_MS);
    void cancelOscDoneTimer; void armOscDoneTimer;
    // Push-on-data extender is INTENTIONALLY a no-op now.
    //
    // Previously we extended the done-timer on every PTY output burst
    // so a chatty agent (long tool output, streaming thoughts) didn't
    // trigger "done" while it was still talking. Side-effect: the done
    // timer kept rearming indefinitely while claude streamed, spamming
    // the work-done log and sometimes never firing the actual "done"
    // because OSC idle was always followed by another byte.
    //
    // Now: we trust OSC 9;4 entirely. The agent's sender-driven
    // busy=true / busy=false transitions arm + cancel the timer; PTY
    // bytes don't matter. Less noise, more honest "done."
    pushOscDoneRef.current = () => {};
    // OSC 1337 — iTerm proprietary. RequestAttention=yes/fireworks is
    // an explicit "user, look at me." Treat as "done" too — both want
    // the sidebar dot + a notification.
    term.parser.registerOscHandler(1337, (data) => {
      if (/^RequestAttention=(yes|fireworks)$/i.test(data)) {
        markAttention(ws.id, tab.id, "attention");
      }
      return false;
    });

    // WebGL renderer tiles cell backgrounds pixel-perfectly — fixes the
    // "ribbon" artifacts in TUIs (gemini, claude) where adjacent bg-colored
    // rows show 1px gaps with the default DOM renderer. Load AFTER term.open
    // so the GL context can attach to an already-laid-out canvas. Graceful
    // fallback: ignore failures, the DOM renderer keeps working.
    //
    // We hold a ref to the addon so cleanup can dispose it BEFORE term.dispose().
    // Without that, a pending render frame fires after term._core._store is
    // nulled and throws "undefined is not an object (... _isDisposed)".
    // Renderer addon — WebGL by default; localStorage override for A/B.
    const rendererAddon = loadTerminalRenderer(term);

    // PTY spawn flow needs the webview to have laid the container out first,
    // otherwise fit.fit() returns 0×0 and we spawn a PTY with garbage dims.
    (async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (cancelled) return;
      try { fit.fit(); } catch {}
      const cols = Math.max(40, term.cols || 100);
      const rows = Math.max(10, term.rows || 30);

      try {
        // Resume iff the worktree has a persisted history flag AND we
        // haven't already proven this session that the flag is stale —
        // AND it isn't a repo-root workspace. The repo-root shares the
        // project's actual checkout directory, so `claude --continue` /
        // `codex resume --last` would pick up sessions the user had in
        // that dir BEFORE installing termic (or via plain `claude`
        // outside termic). Forcing fresh on is_repo_root prevents that
        // surprise; user can still use the agent's resume command
        // manually if they actually want to continue an external session.
        // Only the AUTO-CREATED default tab (one per workspace) may
        // resume the agent's prior conversation. User-added tabs
        // always start fresh - otherwise opening a second claude tab
        // inside the same workspace tries to resume the same session,
        // and N tabs end up fighting over one conversation. `is_default`
        // is set by `ensureDefaultTab` in the app store and never
        // again by the "+" tab-add path.
        const shouldResume = !!ws.has_resumable_history
          && !failedResumeRef.current
          && !ws.is_repo_root
          && !!tab.is_default;
        spawnStartedAtRef.current = Date.now();
        lastSpawnWasResumeRef.current = shouldResume;
        hasHistoryLocalRef.current = false;
        // `cli: "shell"` → a plain login shell (the "+" → New terminal
        // menu), not an agent. It carries its own sandbox choice in
        // `tab.sandboxed`; agent tabs leave that unset.
        const isShell = tab.cli === "shell";
        const spawn = await ipc.ptySpawn({
          cwd: ws.path,
          // Agent: resolve the executable through the registry (users
          // can repoint `claude` etc. in Settings → Agent CLIs). Shell:
          // a login zsh, mirroring the AuxTerminal scratch shell.
          cmd: isShell ? "zsh" : spawnCommandForCli(tab.cli),
          args: isShell ? ["-l"] : spawnArgsForCli(tab.cli, {
            // YOLO auto-on whenever the workspace is sandboxed: the
            // seatbelt cage is the real security boundary, so the
            // agent's own permission-prompt scaffolding is just
            // friction. The user pref still wins when sandbox is off,
            // and the wizard / sandbox dialog spell this out so
            // nobody is surprised.
            yolo: usePrefs.getState().yoloMode || !!ws.sandbox_enabled,
            resume: shouldResume,
            ws,
          }),
          // Order matters: base TERMIC_*/COLORFGBG block first, then
          // the user's per-agent env block (Settings → Agents). The
          // per-agent values win on key collision so a power user can
          // override e.g. COLORFGBG or even TERMIC_PORT if they really
          // want to. Rust merges this overlay AFTER the inherited
          // parent env, so anything set here always trumps a system env.
          env: {
            TERMIC_PORT: String(ws.port),
            TERMIC_WORKSPACE_NAME: ws.name,
            COLORFGBG: currentColorFgBg(),
            ...(isShell ? {} : envForCli(tab.cli)),
          },
          // Sandbox gating: a shell tab created "no sandbox"
          // (`sandboxed === false`) omits workspace_id → Rust spawns it
          // uncaged. Everything else passes the id; Rust then gates on
          // ws.sandbox_enabled (harmless no-op when sandbox is off).
          workspace_id: tab.sandboxed === false ? undefined : ws.id,
          // The tab's CLI may differ from the workspace's primary CLI
          // (claude workspace with a gemini tab open, etc.). Send the
          // tab's agent id so the rendered SBPL profile uses THIS
          // agent's allowed paths + host allowlist, not the workspace
          // default. A shell tab has no agent id → Rust falls back to
          // the workspace's primary CLI for the profile.
          agent_id: isShell ? undefined : tab.cli,
          rows, cols,
        });
        const ptyId = spawn.id;
        if (cancelled) { ipc.ptyKill(ptyId).catch(() => {}); return; }
        ptyRef.current = ptyId;
        patchTab(ws.id, tab.id, { ptyId, lastOutputAt: Date.now() });
        // Sandbox truth lands synchronously with the spawn (no event
        // race possible). Render the warning chip immediately when the
        // cage degraded.
        setSandboxWarning(spawn.sandbox.warning || null);
        // Fire-and-forget analytics. Real resume gating lives on the
        // has_resumable_history flag below, not here.
        ipc.workspaceRecordSpawn(ws.id).catch(() => {});
        // If the spawn survives RESUME_FAILURE_MS without exiting, we
        // take that as proof there's a real session — persist true so
        // future spawns (even after termic restart) will pass resume
        // args. Cleared in the exit handler if we never reach the
        // timeout (the rapid-exit branch fires first).
        window.setTimeout(() => {
          if (cancelled || ptyRef.current !== ptyId) return;
          if (hasHistoryLocalRef.current) return;
          hasHistoryLocalRef.current = true;
          // Auto-failure flag should now be cleared too — a survived
          // spawn means we have a usable session regardless of whether
          // this one was a resume or a fallback fresh.
          failedResumeRef.current = false;
          // Skip persisting `has_resumable_history` for repo-root
          // workspaces — they share the project's actual checkout dir
          // with whatever the user does outside termic, and we never
          // want to auto-resume in that shared space.
          if (!ws.has_resumable_history && !ws.is_repo_root) {
            ipc.workspaceSetHasHistory(ws.id, true).catch(() => {});
          }
        }, RESUME_FAILURE_MS);

        // Output stream → terminal write + attention bookkeeping.
        const oscSniffer = wdDebug
          ? (() => {
              // Decode bytes to UTF-8 once and regex-scan for any OSC
              // introducer (`ESC ] <digits> ;`). Logs the full
              // payload up to the ST (ESC\) or BEL terminator so we
              // can see what undocumented OSCs an agent emits during
              // e.g. an approval prompt. Cheap — only runs when the
              // debugWorkDone localStorage flag is set.
              const dec = new TextDecoder("utf-8", { fatal: false });
              const re = /\x1b\](\d+)(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;
              return (u8: Uint8Array) => {
                const s = dec.decode(u8);
                let m: RegExpExecArray | null;
                while ((m = re.exec(s)) !== null) {
                  const id = m[1];
                  // Suppress the ones we already log via dedicated handlers.
                  if (id === "9" || id === "0" || id === "1" || id === "2" || id === "1337") continue;
                  wdlog(`OSC ${id}`, m[2] ?? "");
                }
              };
            })()
          : null;
        const unlistenData = await ipc.onPtyData(ptyId, (u8) => {
          term.write(u8);
          oscSniffer?.(u8);
          const now = Date.now();
          patchTab(ws.id, tab.id, { lastOutputAt: now });
          // Output activity extends the OSC 9;4 done timer — even if
          // the agent went OSC-idle, fresh bytes mean it's still
          // streaming output (thought summary, tool result text, etc.)
          // so it's not really done.
          pushOscDoneRef.current();
          // BEL gating: only treat as attention when the user has typed since
          // boot (otherwise startup banners ring spuriously).
          const cur = (useApp.getState().tabs[ws.id] || []).find(t => t.id === tab.id);
          if (cur && cur.type === "terminal" && u8.indexOf(0x07) !== -1 && cur.lastInputAt) {
            markAttention(ws.id, tab.id, "bell");
          }
        });
        // Compose data + sandbox unlisteners into the existing ref so
        // cleanup tears down both. Avoids adding another ref.
        unlistenDataRef.current = unlistenData;

        const unlistenExit = await ipc.onPtyExit(ptyId, () => {
          ptyRef.current = null;
          const fastExit = Date.now() - spawnStartedAtRef.current < RESUME_FAILURE_MS;
          if (fastExit && lastSpawnWasResumeRef.current) {
            // Rapid exit during a resume attempt = "no conversation
            // found to continue" or similar. Flip the in-component
            // failure flag AND persist false on the workspace so
            // future spawns (this session AND across restarts) skip
            // resume until proven otherwise. Then bump gen → respawn
            // fresh. No overlay flicker because we never set exited=true.
            failedResumeRef.current = true;
            ipc.workspaceSetHasHistory(ws.id, false).catch(() => {});
            setGen(g => g + 1);
            return;
          }
          // Sandbox-driven restart: the user just hit "Save & restart"
          // on the Sandbox dialog. Auto-respawn instead of showing the
          // exited overlay so they don't have to click Restart manually.
          if (useUI.getState().consumePendingSandboxRestart(ws.id)) {
            setGen(g => g + 1);
            return;
          }
          // Plain shell tabs close on exit (Ctrl+D / `exit`) — a shell
          // that's done is done. The "exited / Restart" overlay is for
          // agents only, where an unexpected death is worth surfacing.
          if (tab.cli === "shell") {
            useApp.getState().closeTab(ws.id, tab.id);
            return;
          }
          markAttention(ws.id, tab.id, "exit");
          setExited(true);
        });
        unlistenExitRef.current = unlistenExit;

        // Input: pipe xterm keystrokes back to PTY. Also reset settled state
        // — the user has invalidated whatever "done" we may have decided.
        term.onData(data => {
          patchTab(ws.id, tab.id, { lastInputAt: Date.now() });
          settledRef.current = { lastHash: 0, unchangedCount: 0, marked: false };
          const bytes = new TextEncoder().encode(data);
          ipc.ptyWrite(ptyId, Array.from(bytes)).catch(() => {});
        });
        term.onResize(({ cols, rows }) => { ipc.ptyResize(ptyId, rows, cols).catch(() => {}); });

        // Post-mount refit pulses (covers WKWebView layout settle quirks).
        const refit = () => { try { fit.fit(); } catch {} };
        setTimeout(refit, 200);
        setTimeout(refit, 600);
      } catch (e) {
        term.write(`\x1b[1;31mspawn failed: ${String(e)}\x1b[0m\r\n`);
      }
    })();

    // ResizeObserver keeps the terminal honest when the panel/window grows.
    // Skip 0×0 entries: hidden tabs and the bottom-split's display:none
    // collapse both yield zero-geometry callbacks that would resize the PTY
    // to 0 cols/rows. The agent re-paints on the new dims, then the second
    // callback (on un-hide) re-grows everything — visible as a flicker.
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const r = e.contentRect;
        if (r.width === 0 || r.height === 0) return;
      }
      try { fit.fit(); } catch {}
    });
    ro.observe(host);

    return () => {
      cancelled = true;
      ro.disconnect();
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      if (ptyRef.current) ipc.ptyKill(ptyRef.current).catch(() => {});
      // Dispose the renderer addon FIRST so its render loop can't fire
      // on a half-disposed terminal.
      try { rendererAddon?.dispose(); } catch {}
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  // `gen` in the deps array is what makes the Restart button work: it
  // bumps, the effect tears down, the effect runs again, fresh PTY.
  }, [ws.id, ws.path, ws.port, ws.name, tab.id, tab.cli, patchTab, markAttention, gen]);

  // Refit + focus when the tab becomes active OR when its workspace
  // becomes the active workspace (e.g., clicking a workspace in the
  // sidebar). Mounted workspaces stay rendered with visibility-hidden, so
  // the tab's `active` prop alone doesn't change on workspace switch —
  // we have to also watch the global activeWorkspaceId to know when this
  // pane just became the one the user is looking at.
  const isActiveWorkspace = useApp(s => s.activeWorkspaceId === ws.id);
  useEffect(() => {
    if (!active || !isActiveWorkspace) return;
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch {}
      try { termRef.current?.focus(); } catch {}
    });
  }, [active, isActiveWorkspace]);

  // Live-react to font / size preference changes: rewrite the options and
  // ⌘K clear handler — see AuxTerminal for context.
  useEffect(() => {
    const onClear = () => {
      const host = hostRef.current;
      const focused = document.activeElement as HTMLElement | null;
      if (host && focused && host.contains(focused)) {
        try { termRef.current?.clear(); } catch {}
      }
    };
    window.addEventListener("termic-clear-focused", onClear);
    return () => window.removeEventListener("termic-clear-focused", onClear);
  }, []);

  // refit so the cell grid recomputes against the new metrics. Skips the
  // initial run since the constructor already used the current values.
  const terminalFontId        = usePrefs(s => s.terminalFontId);
  const terminalFontSize      = usePrefs(s => s.terminalFontSize);
  const terminalLetterSpacing = usePrefs(s => s.terminalLetterSpacing);
  const firstFontRun = useRef(true);
  useEffect(() => {
    if (firstFontRun.current) { firstFontRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.fontFamily     = currentTerminalStack();
    t.options.fontSize       = terminalFontSize;
    t.options.letterSpacing  = terminalLetterSpacing;
    try { fitRef.current?.fit(); } catch {}
    if (ptyRef.current) ipc.ptyResize(ptyRef.current, t.rows, t.cols).catch(() => {});
  }, [terminalFontId, terminalFontSize, terminalLetterSpacing]);

  // Live theme swap: when the user picks a different theme in the
  // dropdown, push the new xterm palette into every mounted terminal.
  // xterm's `options.theme` setter triggers an internal repaint so we
  // don't need to touch the WebGL atlas explicitly.
  const themeMode = usePrefs(s => s.themeMode);
  const firstThemeRun = useRef(true);
  useEffect(() => {
    if (firstThemeRun.current) { firstThemeRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.theme = currentTerminalTheme() as any;
  }, [themeMode]);

  // YOLO live toggle — for agents that support runtime mode switching (only
  // gemini today), send the appropriate slash command. For claude/codex this
  // is a no-op; the next spawn picks up the new flag.
  const yoloMode = usePrefs(s => s.yoloMode);
  const firstYoloRun = useRef(true);
  useEffect(() => {
    if (firstYoloRun.current) { firstYoloRun.current = false; return; }
    if (!ptyRef.current) return;
    tryToggleYoloLive(tab.cli, ptyRef.current, yoloMode);
  }, [yoloMode, tab.cli]);

  // Settled detection: hash the visible buffer every SAMPLE_MS. Once the hash
  // is identical across SETTLE_SAMPLES consecutive samples, the agent has
  // stopped producing meaningful output — mark the tab unread (only if it's
  // inactive and the user has actually interacted with it since boot).
  //
  // This replaces the old "lastOutputAt + 3s" heuristic which never fired for
  // TUI agents like gemini/codex: their cursor blink + status-bar timer keep
  // bumping lastOutputAt every second even when nothing meaningful changed.
  // Hashing the rendered viewport ignores those redraws (same content → same
  // hash) and only counts as activity when the user-visible screen differs.
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = termRef.current;
      if (!t || !ptyRef.current) return;
      const h = hashVisibleBuffer(t);
      const s = settledRef.current;
      if (h === s.lastHash && s.lastHash !== 0) {
        s.unchangedCount++;
        if (s.unchangedCount >= SETTLE_SAMPLES && !s.marked) {
          const cur = (useApp.getState().tabs[ws.id] || []).find(x => x.id === tab.id);
          if (cur && cur.type === "terminal" && cur.lastInputAt
              && useApp.getState().activeTab[ws.id] !== tab.id) {
            markAttention(ws.id, tab.id, "idle");
          }
          s.marked = true;  // don't re-mark until something changes again
        }
      } else {
        s.lastHash = h;
        s.unchangedCount = 0;
        s.marked = false;
      }
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [ws.id, tab.id, markAttention]);

  return (
    <div className="relative flex h-full w-full flex-col" data-tab-id={tab.id}>
      <div ref={hostRef} className="min-h-0 flex-1 bg-[var(--color-bg)]" />
      {/* Sandbox status footer was here — moved up to WorkspaceView
          so it sits BELOW the bottom-split (when open) and stays the
          visual bottom of the workspace, not the agent tab. The
          degraded-warning string isn't plumbed across that boundary
          yet (rare case); plumb through useUI later if it matters. */}
      {void sandboxWarning}
      {exited && (
        // Overlay on the dead xterm. The terminal underneath stays mounted
        // so the user can still scroll through whatever the agent printed
        // before it died — we just block input + offer a restart. `gen++`
        // tears down the spawn effect and re-runs it with a fresh PTY.
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)]/85">
          <div className="text-[13px] text-[var(--color-fg-dim)]">{tab.cli} exited.</div>
          <button
            onClick={() => { setExited(false); setGen(g => g + 1); }}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-1.5 text-[12.5px] text-[var(--color-fg)] hover:border-[var(--color-accent-soft)]"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Restart {tab.cli}
          </button>
        </div>
      )}
    </div>
  );
}

export function FooterBar({ ws, sandboxWarning }: {
  ws: { id: string; sandbox_enabled?: boolean; sandbox_allowed_hosts?: string[]; sandbox_rw_paths?: string[] };
  sandboxWarning: string | null;
}) {
  const splitOpen = useApp(s => !!s.terminalSplit[ws.id]);
  const toggleSplit = useApp(s => s.toggleTerminalSplit);

  // Live deny counter. Polls the Rust-side counter every 2s while
  // the workspace is sandboxed; cheap (one mutex lookup). Replaces
  // the old "Recent denies" panel that needed `log show` shellouts.
  const [totalDenies, setTotalDenies] = useState(0);
  useEffect(() => {
    if (!ws.sandbox_enabled) { setTotalDenies(0); return; }
    let cancelled = false;
    const tick = () => {
      ipc.sandboxDenyCounts(ws.id)
        // network + path: footer chip wants the COMBINED total so the
        // number matches "rows visible in the popover." Previously
        // showed network-only which under-counted (popover had paths
        // too). Both come from the same IPC payload.
        .then(c => { if (!cancelled) setTotalDenies(c.network + c.path); })
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [ws.id, ws.sandbox_enabled]);

  // Sandbox half — three visual states (warning > on > off). Off
  // state is muted but still clickable so users discover the cage
  // exists.
  const sandboxNode = sandboxWarning ? (
    <>
      <AlertTriangle className="h-3 w-3 text-[var(--color-warn)]" />
      <span className="font-medium">Sandbox degraded</span>
      <span className="text-[var(--color-fg-faint)]">·</span>
      <span className="truncate">{sandboxWarning}</span>
    </>
  ) : ws.sandbox_enabled ? (
    <>
      <Shield className="h-3 w-3 text-[var(--color-ok)]" fill="currentColor" />
      <span>Sandboxed</span>
      <span className="text-[var(--color-fg-faint)]">·</span>
      <span>{(ws.sandbox_allowed_hosts?.length ?? 0)} extra host{(ws.sandbox_allowed_hosts?.length ?? 0) === 1 ? "" : "s"}</span>
      <span className="text-[var(--color-fg-faint)]">·</span>
      <span>{(ws.sandbox_rw_paths?.length ?? 0)} extra path{(ws.sandbox_rw_paths?.length ?? 0) === 1 ? "" : "s"}</span>
    </>
  ) : (
    <>
      <Shield className="h-3 w-3 text-[var(--color-fg-faint)]" />
      <span>Unsandboxed</span>
      <span className="ml-1 text-[var(--color-fg-faint)]">— full filesystem + network</span>
    </>
  );

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-t px-3 py-1 text-[11.5px]",
        sandboxWarning
          ? "border-[var(--color-warn)]/40 bg-[var(--color-warn)] text-[var(--color-fg)]"
          : "border-[var(--color-border-soft)] bg-[var(--color-bg-1)] text-[var(--color-fg-dim)]",
      )}
    >
      <button
        type="button"
        onClick={() => useUI.getState().openSandbox(ws.id)}
        title={sandboxWarning ?? (ws.sandbox_enabled ? "Edit sandbox" : "Enable sandbox")}
        className="flex flex-1 items-center gap-1.5 truncate text-left hover:text-[var(--color-fg)]"
      >
        {sandboxNode}
      </button>
      {/* Live deny counter chip — click to see WHICH hosts got
          blocked. Sibling of the edit button so its click doesn't
          bubble to "open Edit dialog." Only shown when sandboxed +
          we've actually seen denies. */}
      {ws.sandbox_enabled && totalDenies > 0 && (
        <DeniedHostsPopover wsId={ws.id} count={totalDenies} />
      )}
      {/* +Terminal opens the bottom split. Hidden when split is
          already open — no point offering to add what's there.
          (The split itself is owned by WorkspaceView; this is just
          a convenient trigger that lives where you'd expect it.) */}
      {!splitOpen && (
        <button
          type="button"
          onClick={() => toggleSplit(ws.id)}
          title="Open a bottom terminal split"
          className="ml-2 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
        >
          <TerminalSquare className="h-3 w-3" />
          <span>Terminal</span>
        </button>
      )}
    </div>
  );
}

// Popover showing per-host + per-path deny breakdown. Click the
// "N blocked" chip in the footer → list of what the cage refused,
// sorted most-recently-seen first. Each row has an "Allow" button
// that adds the host to the workspace's allowed list + respawns the
// agent under the new profile. Polls every 1.5s while open.
function DeniedHostsPopover({ wsId, count }: { wsId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [hosts, setHosts] = useState<ipc.DenyHost[]>([]);
  const [paths, setPaths] = useState<ipc.DenyPath[]>([]);
  const [allowing, setAllowing] = useState<string | null>(null);
  // Hosts/paths allowed during this popover session. `sandbox_recent_
  // denied_*` is a log query, so an already-allowed entry keeps showing
  // (its past denial is still inside the log window) — filter locally.
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  // Cached $HOME for `/Users/...` → `$HOME/...` display rewrite.
  // Fetched once per popover lifetime; we don't expect the user's
  // home dir to change mid-session.
  const [home, setHome] = useState("");
  useEffect(() => { ipc.homeDir().then(setHome).catch(() => {}); }, []);
  const shortenPath = (p: string) => {
    if (home && (p === home || p.startsWith(home + "/"))) {
      return "$HOME" + p.slice(home.length);
    }
    return p;
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = () => {
      Promise.all([
        ipc.sandboxRecentDeniedHosts(wsId).catch(() => [] as ipc.DenyHost[]),
        ipc.sandboxRecentDeniedPaths(wsId).catch(() => [] as ipc.DenyPath[]),
      ]).then(([h, p]) => {
        if (cancelled) return;
        setHosts(h); setPaths(p);
      });
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, wsId]);

  async function allow(host: string) {
    setAllowing(host);
    try {
      // Persist only — the Rust handler doesn't kill the live PTY. The
      // new entry is additive, so the running agent's existing (narrower)
      // profile stays safe; the rule takes effect on the next spawn.
      await ipc.workspaceSandboxAddAllowedHost(wsId, host);
      // Drop the row locally + tell the user it needs a fresh PTY.
      setAllowed(prev => new Set(prev).add(host));
      useUI.getState().pushToast(
        `Allowed ${host} — restart the agent/shell for it to take effect`,
        "success",
      );
    } catch (e) {
      useUI.getState().pushToast(`Couldn't allow ${host}: ${e}`, "error");
    } finally { setAllowing(null); }
  }
  async function allowPath(path: string) {
    setAllowing(path);
    try {
      await ipc.workspaceSandboxAddAllowedPath(wsId, path);
      setAllowed(prev => new Set(prev).add(path));
      // Confirmation + undo. The toast TTL is bumped to 6s (vs default
      // 3.2s) so the user actually has time to read the path and decide
      // whether to revert.
      const display = path.startsWith("$HOME") ? path : path.replace(/^.*\/Users\/[^/]+/, "$HOME");
      useUI.getState().pushToast(
        `Allowed ${display} — restart the agent/shell to apply`,
        "success",
        {
          ttlMs: 6000,
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                await ipc.workspaceSandboxRemoveAllowedPath(wsId, path);
                setAllowed(prev => { const n = new Set(prev); n.delete(path); return n; });
                useUI.getState().pushToast(`Removed ${display} from allow-list`, "info");
              } catch (e) {
                useUI.getState().pushToast(`Undo failed: ${e}`, "error");
              }
            },
          },
        },
      );
    } catch (e) {
      useUI.getState().pushToast(`Couldn't allow ${path}: ${e}`, "error");
    } finally { setAllowing(null); }
  }

  // Rows minus anything allowed this popover session (see `allowed`).
  const visibleHosts = hosts.filter(h => !allowed.has(h.host));
  const visiblePaths = paths.filter(p => !allowed.has(p.path));

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="ml-2 shrink-0 rounded px-1.5 py-0.5 text-[var(--color-warn)] hover:bg-[var(--color-warn)]/10"
          title={`${count} request${count === 1 ? "" : "s"} blocked by the sandbox. Click to see details.`}
        >
          {count} blocked
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          // Auto-grow to the widest path/host row. Floor at 440px so
          // short content doesn't make the popover look puny; ceiling
          // at viewport-2rem so a deeply-nested path never escapes
          // the terminal pane edges. Rows use whitespace-nowrap so
          // their natural width drives the container's intrinsic
          // size; truncation only kicks in when we hit the ceiling.
          style={{ width: "max-content" }}
          className="z-50 min-w-[440px] max-w-[calc(100vw-2rem)] max-h-[400px] overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-2 shadow-2xl text-[12px]"
        >
          {hosts.length === 0 && paths.length === 0 && (
            <div className="px-1 py-1 text-[var(--color-fg-faint)]">Loading…</div>
          )}

          {visibleHosts.length > 0 && (
            <>
              <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">
                <span>Blocked hosts</span>
                <span>{visibleHosts.length}</span>
              </div>
              <ul className="flex flex-col">
                {visibleHosts.map(h => (
                  <li
                    key={h.host}
                    className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-hover)]"
                  >
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[var(--color-fg)]" title={h.host}>{h.host}</span>
                    <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">
                      {h.count}× · {relTime(h.last_seen_unix_ms)}
                    </span>
                    <button
                      type="button"
                      onClick={() => allow(h.host)}
                      disabled={allowing === h.host}
                      className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] hover:border-[var(--color-ok)]/40 hover:text-[var(--color-fg)] disabled:opacity-50"
                      title={`Add ${h.host} to allowed hosts. Takes effect on next agent restart.`}
                    >
                      {allowing === h.host ? "…" : "Allow"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {visiblePaths.length > 0 && (
            <>
              <div className="mt-3 mb-0.5 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">
                <span>Blocked filesystem paths</span>
                <span>{visiblePaths.length}</span>
              </div>
              <div className="mb-1.5 px-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">
                Click any path segment to allow that prefix. Hover to preview which part you'll allow — green = will be allowed, dimmed = trimmed off.
              </div>
              <ul className="flex flex-col">
                {visiblePaths.map(p => (
                  <li
                    key={p.path}
                    className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-hover)]"
                  >
                    {/* Path is split into clickable segments — clicking
                        a segment allows the prefix up to and including
                        that segment. Lets the user pick a parent dir
                        (e.g. `$HOME/.agents/skills`) instead of being
                        forced to allow each leaf separately. */}
                    <PathSegments
                      display={shortenPath(p.path)}
                      pending={allowing === p.path}
                      onAllow={(prefix) => allowPath(prefix)}
                    />
                    <span
                      className="ml-auto shrink-0 text-[11px] text-[var(--color-fg-faint)]"
                      title={p.last_proc ? `Process: ${p.last_proc}(${p.last_pid})` : undefined}
                    >
                      {p.last_proc && (
                        <span className="mr-2 font-mono text-[var(--color-fg-dim)]">
                          {p.last_proc}({p.last_pid})
                        </span>
                      )}
                      {p.count}× · {relTime(p.last_seen_unix_ms)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-2 max-w-[460px] px-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">
            Clicking adds the path or host to this workspace's allow-list.
            <br />
            Takes effect on next agent restart — the running agent keeps its current (narrower) permissions.
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Coarse "when was this" formatter. Deliberately low-precision so
// the popover rows aren't flickering every second while it's open
// (the previous "5s ago / 6s ago / ..." update on every 1.5s poll
// was visual noise). Buckets:
//   <  30s   → "just now"
//   < 5 min  → "<5m ago"
//   < 1 hr   → "Xm ago"  rounded to the nearest 5min
//   < 24 hr  → "Xh ago"
//   else     → "yesterday" / "Xd ago"
/** Clickable path-segment ribbon. Splits a `$HOME/.foo/bar/baz` (or
 *  absolute) path into individual segments; each segment-click allows
 *  the prefix up to and INCLUDING that segment. The trailing segments
 *  dim to hint at the cut-off. Lets the user pick a parent dir without
 *  having to retype the path into the sandbox dialog. */
function PathSegments({ display, onAllow, pending }: {
  display: string;
  onAllow: (prefix: string) => void;
  pending: boolean;
}) {
  // Hover state: index up to which the user is "selecting" — segments
  // 0..=hovered get the green-on-hover treatment, segments after dim.
  const [hovered, setHovered] = useState<number | null>(null);

  const absolute = display.startsWith("/");
  const parts = display.split("/").filter(Boolean);
  // Reconstruct the prefix string for each segment index. For absolute
  // paths we keep the leading "/"; for $HOME-relative the first segment
  // *is* $HOME and the rest concatenate with "/".
  const prefixAt = (i: number) =>
    (absolute ? "/" : "") + parts.slice(0, i + 1).join("/");

  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-0 font-mono text-[12px] text-[var(--color-fg)]"
      onMouseLeave={() => setHovered(null)}
    >
      {parts.map((seg, i) => {
        const isPrefix = hovered !== null && i <= hovered;
        const isSuffix = hovered !== null && i > hovered;
        return (
          <span key={i} className="flex items-center">
            {i > 0 && (
              <span className={cn(
                "select-none px-0.5 text-[var(--color-fg-faint)]",
                isSuffix && "opacity-40",
              )}>/</span>
            )}
            <button
              type="button"
              onMouseEnter={() => setHovered(i)}
              onClick={() => onAllow(prefixAt(i))}
              disabled={pending}
              title={`Allow ${prefixAt(i)}. Takes effect on next agent restart.`}
              className={cn(
                "rounded px-1 transition-colors disabled:opacity-50",
                isPrefix && "bg-[var(--color-ok)]/15 text-[var(--color-fg)]",
                isSuffix && "text-[var(--color-fg-faint)] opacity-40",
                hovered === null && "hover:bg-[var(--color-hover)]",
              )}
            >{seg}</button>
          </span>
        );
      })}
    </span>
  );
}

function relTime(unixMs: number): string {
  const delta = Math.max(0, Date.now() - unixMs);
  const s = Math.floor(delta / 1000);
  if (s < 30) return "just now";
  const m = Math.floor(s / 60);
  if (m < 5)  return "<5m ago";
  if (m < 60) return `${Math.round(m / 5) * 5}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}
