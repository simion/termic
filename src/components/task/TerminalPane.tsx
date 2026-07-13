// Single terminal tab: spawns a PTY on first mount, attaches xterm.js, owns
// the resize/refit dance and the attention/unread heuristics. Stays mounted
// across tab switches (parent toggles visibility) so we don't reconnect PTYs.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, TerminalSquare, Copy, Check, ChevronUp, ChevronDown, ChevronRight, X, Loader2 } from "lucide-react";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { attachCmdClickLinkOpener } from "@/lib/termLinkOpener";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Osc52Base64 } from "@/lib/osc52";
import { attachCopyOnSelect } from "@/lib/terminalSelection";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { loadTerminalRenderer, awaitTerminalFonts } from "@/lib/terminalRenderer";
import { IS_MAC, bindingMatches, type ShortcutId } from "@/lib/shortcuts";
import { registerTerminalDropTarget } from "@/lib/terminalDrop";
import { setupImeReplacementBridge } from "@/lib/ime";
import { sendMessageToPty } from "@/lib/agentSend";
import type { TerminalTab, Task, SandboxMode } from "@/lib/types";
import { effectiveSandboxMode, isSandboxEnforced } from "@/lib/types";
import { SandboxIcon, SANDBOX_VISUALS } from "@/components/SandboxIcon";
import { TerminalExitedBanner } from "@/components/task/TerminalExitedBanner";
import * as ipc from "@/lib/ipc";
import { loginShell, loginShellArgs } from "@/lib/loginShell";
import { usePrefs, currentTerminalStack, currentTerminalTheme, currentColorFgBg, currentMinimumContrastRatio } from "@/store/prefs";
import { spawnArgsForCli, spawnCommandForCli, tryToggleYoloLive, envForCli, agentDisplayName, cliSupportsIdSession, cliSupportsCaptureResume, postLaunchCaptureForCli, decideResume, workDoneCapable, terminalLaunchCommand, isTerminalCli } from "@/lib/agents";
import { MessageQueueButton } from "./MessageQueueButton";
import { ReviewCommentsBar } from "./ReviewCommentsBar";

interface Props { task: Task; tab: TerminalTab; active: boolean; }

// Settled-detection knobs. We sample the visible buffer every SAMPLE_MS and
// mark the tab "settled" once SETTLE_SAMPLES consecutive samples produce the
// same hash. Net stillness threshold = SETTLE_SAMPLES * SAMPLE_MS = 6 s.
// This only fires when the tab was ALREADY in "working" — so a 6 s gap in
// the middle of an agent turn would demote spuriously only if every sender
// signal also fell silent during that gap. Acceptable tradeoff vs. 12 s of
// stale spinner after a real finish.
const SAMPLE_MS = 3000;
const SETTLE_SAMPLES = 2;
// Seconds a finished "Run setup" tab lingers before auto-closing (counter in
// the "Setup finished." banner; click closes immediately).
const SETUP_AUTO_CLOSE_S = 5;

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

/** Decode a raw PTY chunk into a readable string for debug logs.
 *  Control characters get named tokens (<ESC>, <BEL>, etc.); printable
 *  text (including UTF-8) passes through verbatim. Truncates at 500 B. */
function decodeForDebug(u8: Uint8Array): string {
  const MAX = 500;
  const excess = u8.length > MAX;
  const buf = excess ? u8.slice(0, MAX) : u8;
  const str = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  let out = "";
  for (const ch of str) {
    const c = ch.codePointAt(0)!;
    if      (c === 0x07) out += "<BEL>";
    else if (c === 0x08) out += "<BS>";
    else if (c === 0x09) out += "<TAB>";
    else if (c === 0x0a) out += "<LF>";
    else if (c === 0x0d) out += "<CR>";
    else if (c === 0x1b) out += "<ESC>";
    else if (c === 0x7f) out += "<DEL>";
    else if (c < 0x20)   out += `<x${c.toString(16).padStart(2, "0")}>`;
    else                 out += ch;
  }
  if (excess) out += `...(+${u8.length - MAX}B)`;
  return out;
}

// Theme is no longer a module-level constant - it depends on the user's
// current themeMode pref (dark / light / espresso / solarized). Each
// terminal instance picks the matching palette at mount AND re-reads it
// whenever the pref changes (see the themeMode effect below).

export function TerminalPane({ task, tab, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  const ptyRef = useRef<string | null>(null);
  // Settled-detection state: hash of the last sampled viewport + count of
  // consecutive identical samples + whether we've already marked this cycle
  // (so we mark once per "agent goes from working → settled" transition).
  const settledRef = useRef({ lastHash: 0, unchangedCount: 0, marked: false });
  // Wall-clock of last PTY byte we received. Used by the
  // byte-based idle fallback: if `workState === "working"` and this
  // timestamp is older than QUIET_MS, force `done`. More robust than
  // content-hash for TUIs that repaint status bars during/after work.
  const lastDataAtRef = useRef(0);
  // Scrollback line count over time. Real work GROWS the scrollback
  // (agent prints lines that scroll off). Status-bar ticks ("Cooking
  // for 5s"), cursor blinks, and in-place repaints do NOT — they
  // rewrite the same row(s) without scrolling. ONLY VALID FOR NORMAL
  // BUFFER (Claude Code prints linearly). Alt-screen TUIs (Codex)
  // keep a fixed-length buffer; for those we fall through to the
  // hard-ceiling check.
  const scrollbackRef = useRef({ lastLen: -1, stableCount: 0, marked: false });
  // Timestamp when workState last transitioned TO "working". Hard
  // ceiling: after WORKING_HARD_CEILING_MS without any demoter firing,
  // force `done`. Last-resort safety net for alt-screen TUIs whose
  // sender signal we missed and whose status counter keeps producing
  // bytes (so byte-quiet never fires).
  const workingStartedAtRef = useRef(0);
  // Most recent sender-classified state from a title / OSC handler.
  // Heuristic demoters (byte-quiet, settled-hash, scrollback) skip when
  // this is "busy" — the sender just told us the agent is still
  // working, so a quiet 4 s gap doesn't mean it's done. Cleared back to
  // null/idle when a sender says so, or when the user submits.
  const senderStateRef = useRef<"busy" | "idle" | "attention" | null>(null);
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
  // THIS spawn yet" — separate from the persisted task.has_resumable_history
  // so we don't double-set across reloads. Resets each gen bump.
  const hasHistoryLocalRef = useRef(false);
  // Auto-fallback machinery: a resume-attempt spawn that dies within
  // RESUME_FAILURE_MS is almost certainly "no conversation found" —
  // flip the persistent task.has_resumable_history → false and respawn
  // fresh. failedResumeRef gates the in-component immediate retry
  // (next render of the effect skips resume even before loadAll
  // refreshes the prop). It clears once a fresh spawn succeeds.
  const spawnStartedAtRef = useRef(0);
  const lastSpawnWasResumeRef = useRef(false);
  const failedResumeRef = useRef(false);
  const RESUME_FAILURE_MS = 2000;
  // The uuid a resume attempt failed on during THIS app run. Only used to
  // word the recovery banner: the stashed session is a known-bad resume
  // ("Couldn't resume") when it matches, and a still-usable session we
  // swapped away from ("switch back") when it doesn't (including after a
  // restart, where the failure is no longer news).
  const [failedUuid, setFailedUuid] = useState<string | null>(null);

  const patchTab = useApp(s => s.patchTab);
  const markAttention = useApp(s => s.markAttention);
  const setTabLiveTitle = useApp(s => s.setTabLiveTitle);
  const setWorkState = useApp(s => s.setWorkState);
  const setWorkProgress = useApp(s => s.setWorkProgress);
  // Bridge from the PTY data listener (registered deep inside the
  // spawn flow) to the OSC 9;4 done timer (defined right after the
  // terminal is opened). Set inside the effect after the timer is
  // wired; called from the data callback to debounce-extend.
  const pushOscDoneRef = useRef<() => void>(() => {});
  // Per-PTY debug logger. Null when inactive. Set after ptyId is known
  // (inside spawn IIFE) when localStorage.ptyDebug === "1". Cleared on
  // cleanup so stale OSC handler closures become no-ops automatically.
  // Writes timestamped lines to termic-pty-<task>-<cli>-<ptyId>.log in
  // the OS temp dir. Find path: python3 -c 'import tempfile; print(tempfile.gettempdir())'
  const debugLogRef = useRef<((tag: string, content: string) => void) | null>(null);
  // True once the user has submitted (Enter) since THIS PTY spawned.
  // Stored as a ref so it survives across re-renders and can be set from
  // both the spawn effect (term.onData) and a lastInputAt watcher (broadcast).
  const submittedSinceSpawnRef = useRef(false);
  // Submit-window state as refs so the lastInputAt watcher (which fires
  // for broadcast) can arm them, and so the onPtyData closure always
  // reads the current value without closure-staleness issues.
  const submitWindowUntilRef = useRef(0);
  const submitAtRef = useRef(0);
  // Viewport hash at submit time. Hash-based done only fires if the
  // content actually changed from this baseline — prevents false-done
  // when the user presses Enter on an idle agent (echo arrives, hash
  // stabilizes, but the terminal looks exactly the same as before).
  const preSubmitHashRef = useRef(0);
  // One-done-per-submit guard. Set true the first time we mark "done"
  // after a submit; reset false on each new submit. Blocks Claude's
  // post-response spinner oscillation (a brief ✳→spinner→✳ flicker with
  // no new user input) from re-firing a second done badge, and blocks a
  // late OSC 9 "waiting for input" arriving tens of seconds after the
  // user already saw the answer.
  const doneFiredSinceSubmitRef = useRef(false);
const captureArmedRef = useRef(false);

  // Holds the latest sendNextQueued so fireDone (defined first) can call it.
  // fireDone is the single completion funnel; draining the message queue from
  // there means a focused agent's loop still advances (the store downgrades
  // a focused tab's "done" to "idle", so we can't watch workState for this).
  const sendNextQueuedRef = useRef<((force?: boolean) => boolean) | null>(null);

  // Single funnel for every "work done" transition. Enforces one-done-per-
  // submit (blocks oscillation / late-OSC re-fires) and suppresses the
  // sidebar bell + OS notification when the user is actively looking at
  // this exact tab. Used by the settle timer, OSC 9/133, and all interval
  // fallbacks so the rules can't drift between paths.
  // `seen` = the user was looking at this tab at the moment the agent
  // FINISHED (e.g. focused when the title went idle), even if they then
  // navigated away during the settle window. In that case they already
  // saw the result, so consume the done token but show no badge/bell.
  const fireDone = useCallback((reason: string, attn: "done" | "attention" = "done", seen = false) => {
    if (doneFiredSinceSubmitRef.current) {
      debugLogRef.current?.("done-suppressed", `already fired this turn (${reason})`);
      return;
    }
    doneFiredSinceSubmitRef.current = true;
    // If a message queue is draining, send the next message now and suppress
    // this turn's badge/bell — the user is running an automated loop and
    // doesn't want a notification between every iteration. Runs before the
    // focus-gating below so a loop the user is watching keeps advancing.
    if (sendNextQueuedRef.current?.()) return;
    const app = useApp.getState();
    const isActive = app.activeTaskId === task.id && app.activeTab[task.id] === tab.id;
    if (seen || isActive) {
      // Acknowledged: clear to idle, no badge, no bell.
      debugLogRef.current?.("done-seen", reason);
      app.setWorkState(task.id, tab.id, "idle");
      return;
    }
    debugLogRef.current?.("state→done", reason);
    app.setWorkState(task.id, tab.id, "done");
    app.markAttention(task.id, tab.id, attn);
  }, [task.id, tab.id]);

  // Throttle state for the message queue: the wall-clock of the last send and
  // a handle to a pending deferred send. Enforces prefs.queueMinIntervalMs so
  // a fast loop (or false-"done" oscillation) can't fire prompts at the agent
  // faster than the user-configured floor.
  const lastQueueSendAtRef = useRef(0);
  const queueThrottleTimerRef = useRef<number | null>(null);

  // Drain one message from the tab's queue (the ralph loop). Returns true if
  // a message was sent OR a send is already scheduled (so fireDone suppresses
  // the badge either way), false when the queue is inactive or empty. Sending
  // mirrors the broadcast path: type the text, submit the CR a beat later
  // (sendMessageToPty), and stamp lastInputAt so the watcher below re-arms
  // work-done detection for the next turn.
  const sendNextQueued = useCallback((force = false): boolean => {
    const ptyId = ptyRef.current;
    if (!ptyId) return false;
    const cur = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
    if (!cur || cur.type !== "terminal" || !cur.queueActive) return false;
    const q = cur.queue ?? [];
    if (!q.length) {
      // Loop finished — stop and let fireDone show the final done badge.
      patchTab(task.id, tab.id, { queueActive: false });
      useUI.getState().pushToast("Message queue finished");
      return false;
    }
    // Rate limit the automatic loop: if the floor hasn't elapsed since the last
    // send, defer this one to the remainder rather than firing now. A timer
    // already pending means we're scheduled — report success so the badge stays
    // suppressed. `force` (the "Send now" button) bypasses the floor entirely;
    // it also cancels any pending deferred send so we don't double-fire.
    if (force) {
      if (queueThrottleTimerRef.current != null) {
        clearTimeout(queueThrottleTimerRef.current);
        queueThrottleTimerRef.current = null;
      }
    } else {
      const minInterval = usePrefs.getState().queueMinIntervalMs;
      if (minInterval > 0) {
        if (queueThrottleTimerRef.current != null) return true;
        const wait = minInterval - (Date.now() - lastQueueSendAtRef.current);
        if (wait > 0) {
          queueThrottleTimerRef.current = window.setTimeout(() => {
            queueThrottleTimerRef.current = null;
            sendNextQueuedRef.current?.();
          }, wait);
          debugLogRef.current?.("queue-throttle", `deferring next send ${wait}ms`);
          return true;
        }
      }
    }
    const head = q[0];
    sendMessageToPty(ptyId, head.text);
    lastQueueSendAtRef.current = Date.now();
    patchTab(task.id, tab.id, { lastInputAt: Date.now() });
    const remaining = head.remaining - 1;
    const nextQueue = remaining <= 0
      ? q.slice(1)
      : [{ ...head, remaining }, ...q.slice(1)];
    patchTab(task.id, tab.id, { queue: nextQueue });
    debugLogRef.current?.("queue-send", `"${head.text.slice(0, 40)}" remaining=${remaining} left=${nextQueue.length}`);
    return true;
  }, [task.id, tab.id, patchTab]);
  sendNextQueuedRef.current = sendNextQueued;

  // Kick the queue when a message is added (queueKick bumps) or it first
  // activates. Only send immediately if the agent isn't mid-turn; if it's
  // already working, the in-flight turn's eventual done advances the queue via
  // fireDone instead. Watching queueKick (not just the queueActive edge) means
  // adding a message to an idle agent with an already-active queue still fires.
  const queueActive = tab.type === "terminal" ? tab.queueActive : undefined;
  const queueKick = tab.type === "terminal" ? tab.queueKick : undefined;
  useEffect(() => {
    if (!queueActive) return;
    const cur = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
    if (cur?.workState === "working") return;
    sendNextQueuedRef.current?.();
  }, [queueActive, queueKick, task.id, tab.id]);

  // "Send now": drain the head immediately on a queueForceKick bump, WITHOUT
  // the mid-turn guard above — the user explicitly asked to advance now.
  // Skip the initial mount run so resuming a tab with an active queue doesn't
  // fire a stray send (only real bumps after mount should send).
  const queueForceKick = tab.type === "terminal" ? tab.queueForceKick : undefined;
  const forceKickMountedRef = useRef(false);
  useEffect(() => {
    if (!forceKickMountedRef.current) { forceKickMountedRef.current = true; return; }
    sendNextQueuedRef.current?.(true);
  }, [queueForceKick]);

  // Cancel any pending throttled send when this pane unmounts so the timer
  // doesn't fire into a torn-down tab.
  useEffect(() => () => {
    if (queueThrottleTimerRef.current != null) {
      clearTimeout(queueThrottleTimerRef.current);
      queueThrottleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    // A (re)spawn (incl. a manual Restart via `gen`) stops any running
    // message queue — otherwise the loop would keep firing prompts into a
    // brand-new process the user didn't queue them for.
    if ((useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined)?.queueActive) {
      patchTab(task.id, tab.id, { queueActive: false });
    }

    // Shared link opener (WebLinksAddon, OSC 8 linkHandler, capture-phase
    // opener below). Routes through the opener plugin so the system browser
    // opens, not the WKWebView (window.open silently no-ops).
    const openLink = (via: string) => (uri: string) => {
      ipc.logLine(`[link] agent activate via=${via} uri=${uri}`).catch(() => {});
      openUrl(uri)
        .then(() => ipc.logLine("[link] agent open ok").catch(() => {}))
        .catch((e) => ipc.logLine(`[link] agent open FAILED: ${e}`).catch(() => {}));
    };

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
      // Keeps CLI truecolor text readable on a light bg — see
      // currentMinimumContrastRatio (#83).
      minimumContrastRatio: currentMinimumContrastRatio(),
      allowProposedApi: true,
      scrollback: usePrefs.getState().terminalScrollback,
      // Option-as-Meta for terminal editors (vim/emacs/nano). Off by default;
      // pref lives in Appearance. (issue #11)
      macOptionIsMeta: usePrefs.getState().terminalOptionAsMeta,
      // OSC 8 hyperlinks (anchor text like "Learn more" with the URL only in
      // the escape sequence). Same Cmd/Ctrl gate as visible URLs; without a
      // linkHandler xterm parses these links but activates nothing.
      linkHandler: {
        activate: (ev, uri) => { if (ev.metaKey || ev.ctrlKey) openLink("osc8")(uri); },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Custom base64 codec repairs double-encoded OSC 52 payloads (Claude
    // Code) so pasted text isn't mojibake. See lib/osc52.ts.
    term.loadAddon(new ClipboardAddon(new Osc52Base64()));
    const disposeCopyOnSelect = attachCopyOnSelect(term, host);
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    term.loadAddon(new ImageAddon());
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    // Links — Terminal.app / VS Code convention: the WebLinksAddon stays
    // loaded the whole time, so URLs are detected up front and underline
    // on hover. Opening is gated on Cmd/Ctrl inside the handler, so a
    // plain click still selects/positions normally and only a deliberate
    // Cmd+click navigates.
    //
    // The previous design loaded the addon ONLY while Cmd was held, but
    // loading it mid-hold didn't re-linkify the already-visible buffer, so
    // Cmd+clicking a URL that was already on screen did nothing (#14).
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) openLink("addon")(uri);
    }));
    term.open(host);
    // GH #58: when the agent TUI enables xterm mouse reporting, the modified
    // click is consumed by the mouse pipeline before the addon's activation
    // runs — links "randomly" die inside agents. The capture-phase opener
    // sees the gesture first, resolves the URL from the buffer itself, and
    // swallows the click so nothing double-fires. Must attach AFTER
    // term.open (it reads .xterm-screen geometry).
    const disposeLinkOpener = attachCmdClickLinkOpener(term, host, openLink("capture"));
    termRef.current = term;
    fitRef.current = fit;

    // ── Korean/CJK IME fix for WKWebView ───────────────────────────────
    // WebKit drives CJK composition NOT through compositionstart/update/end
    // (those never fire here; isComposing stays false, keyCode is always
    // 229) but through `input` events on the helper textarea:
    //   • insertText            → a fresh jamo is appended (syllable start)
    //   • insertReplacementText → the composing syllable is refined
    // xterm's _inputEvent only forwards inputType === 'insertText', so every
    // replacement is DROPPED and only the leading jamo of each syllable
    // reaches the PTY (안녕 → ㅇㄴ). We fill the gap: on a replacement event,
    // diff the textarea against its previous value and emit backspaces + the
    // new tail so the PTY line tracks the textarea exactly — this also
    // handles Korean's final-consonant migration (안 + ㅏ → 아나), since the
    // whole composing value is diffed, not just the last char. `prevTaVal`
    // is synced on EVERY input event (including the insertText ones xterm
    // forwards) so the diff baseline stays correct across syllable
    // boundaries. English/control keys route through keypress/keydown and
    // never hit the replacement branch, so they're untouched. See the
    // keyCode-229 guard above, which keeps the keydown path inert for IME.
    const disposeImeBridge = setupImeReplacementBridge(host, () => ptyRef.current, ipc.ptyWrite);

    // Drop target: dragging a file (screenshot, etc.) onto this terminal
    // inserts the file's escaped path at the prompt — like macOS Terminal.
    // The getter reads ptyRef lazily so a Restart (fresh pty id) still works.
    // taskId + sandboxed let the drop handler stage the file into TMPDIR (or
    // prompt) when this tab runs under the seatbelt, so a dropped path the
    // sandbox would deny is still readable. task.sandbox_enabled is read lazily.
    const unregisterDrop = registerTerminalDropTarget(host, () => ptyRef.current, {
      taskId: task.id,
      // Caged tabs are the task's primary process (agents + custom-
      // command tasks); plain shells and registry "custom terminal"
      // entries are always uncaged (see the spawn gating). Only ENFORCING
      // denies reads (MONITORING just logs), so stage drops only for a caged
      // tab. A dropped path is otherwise readable directly.
      sandboxed: () => isSandboxEnforced(effectiveSandboxMode(task))
        && tab.cli !== "shell" && !isTerminalCli(tab.cli),
    });

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
    // Global app shortcuts that must still work while the terminal has
    // focus. xterm would otherwise swallow the keys (send them to the PTY
    // and preventDefault), so the window-level handler never fires. We
    // return false for these → xterm ignores the event → it bubbles up to
    // useShortcuts, which dispatches the command. Read from resolved prefs
    // so user rebinds are honored.
    const PASS_TO_APP: ShortcutId[] = [
      "file-finder", "find-in-files", "broadcast", "open-settings",
    ];
    term.attachCustomKeyEventHandler((e) => {
      // IME composition guard (Korean/Japanese/Chinese). xterm's
      // CompositionHelper.keydown() decides "still composing?" purely by
      // `keyCode === 229`. Chromium sets that for every composition keystroke,
      // but WKWebView (WebKit) reports the real jamo key instead, so xterm
      // finalizes the composition on EVERY keystroke — committing the partial
      // syllable and resetting (안녕하세요 → ㅇㄴㅎ세). Returning false here
      // short-circuits xterm's keydown BEFORE its composition handler runs and,
      // crucially, without preventDefault — so the native textarea + xterm's
      // own compositionstart/update/end listeners assemble the full syllable
      // and emit it once on compositionend. `isComposing` covers continuation
      // keystrokes; `keyCode === 229` covers the one that starts composition.
      if (e.type === "keydown" && (e.isComposing || e.keyCode === 229)) {
        return false;
      }
      if (e.type === "keydown") {
        const binds = usePrefs.getState().shortcuts;
        if (PASS_TO_APP.some(id => bindingMatches(e, binds[id]))) {
          return false; // let the global handler take it (file finder, find-in-files, …)
        }
      }
      // Open the in-terminal search overlay. ⌘F on macOS (EXACTLY ⌘F — no
      // Shift, so ⇧⌘F stays the app's find-in-files); Ctrl+Shift+F
      // elsewhere — plain Ctrl+F is readline's forward-char, so hijacking it
      // would break the shell on Linux/Windows.
      const searchOpenCombo = IS_MAC
        ? e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "f"
        : e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "f";
      if (e.type === "keydown" && searchOpenCombo) {
        setSearchOpen(true);
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Linux/Windows terminal copy/paste. macOS keeps native ⌘C / ⌘V (this
      // whole block is skipped), so standard Mac behavior is untouched. Defaults
      // are Ctrl+Shift+C / Ctrl+Shift+V — the Shift keeps plain Ctrl+C as SIGINT
      // for the shell. Rebindable via Settings > Shortcuts.
      if (!IS_MAC && e.type === "keydown") {
        const binds = usePrefs.getState().shortcuts;
        // Copy only when there's a selection; otherwise fall through so the
        // combo isn't swallowed.
        if (bindingMatches(e, binds["terminal-copy"]) && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
        if (bindingMatches(e, binds["terminal-paste"])) {
          navigator.clipboard.readText().then(t => term.paste(t)).catch(() => {});
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }
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
      // Cmd+Backspace → kill line to beginning (\x15, Ctrl+U), matching
      // macOS Terminal.app and iTerm2. xterm.js does not translate this
      // combo on its own; without the override WKWebView may also navigate
      // back, so both preventDefault and return false are required.
      if (IS_MAC && e.type === "keydown" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key === "Backspace") {
        const pid = ptyRef.current;
        if (pid) ipc.ptyWrite(pid, [0x15]).catch(() => {});
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // Cmd+Left → beginning of line (\x01, Ctrl+A); Cmd+Right → end of line
      // (\x05, Ctrl+E). macOS Terminal.app / iTerm2 convention. xterm.js does
      // not send these on its own for Cmd+Arrow on macOS.
      if (IS_MAC && e.type === "keydown" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const pid = ptyRef.current;
          if (pid) ipc.ptyWrite(pid, [e.key === "ArrowLeft" ? 0x01 : 0x05]).catch(() => {});
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }
      return true;
    });

    // ── Sender-driven status signals (iTerm2-parity) ─────────────────
    //
    // Reliability strategy: trust authoritative sender signals over
    // heuristics. Priority (high → low):
    //
    //   1. OSC 9 (plain)   — Claude Code "Send notification". Body text
    //                        is verbatim from the agent. iTerm2 forwards
    //                        it to the OS as a banner notification; we
    //                        do the same and treat it as a definitive
    //                        attention/done transition.
    //   2. OSC 777;notify  — VTE/urxvt notification dialect. Same
    //                        treatment as OSC 9 plain.
    //   3. OSC 9;4         — ConEmu progress protocol. State 1/2/3/4 =
    //                        busy, 0 = idle. Reliable busy/idle edge
    //                        from Claude Code.
    //   4. OSC 133;C / ;D  — FinalTerm semantic prompt marks. Command
    //                        running / command ended. Works for any
    //                        shell-integration-aware tool.
    //   5. OSC 1337        — iTerm proprietary. RequestAttention → fire
    //                        attention.
    //   6. OSC 0/2 title   — Gemini/Codex per-state strings (fallback
    //                        for CLIs that don't emit 9 or 133).
    //   7. Settled-hash    — interval-based viewport stillness, only
    //                        fires "done" if no higher-priority signal
    //                        was seen this turn.
    //
    // The reducer below is the single funnel. Every signal calls
    // `transition(kind)` so we never end up with two timers racing.
    //
    // Set `localStorage.debugWorkDone = "1"` to log every signal.
    const wdDebug = (() => { try { return localStorage.getItem("debugWorkDone") === "1"; } catch { return false; } })();
    const wdlog = (msg: string, extra?: unknown) => {
      if (!wdDebug) return;
      const tag = `[work-done ${task.name}/${tab.cli}]`;
      if (extra !== undefined) console.log(tag, msg, extra);
      else console.log(tag, msg);
    };
    // Short-hand that writes to the per-PTY debug file (and console) when
    // localStorage.ptyDebug === "1". Safe before ptyId is known — the ref
    // is null until the spawn IIFE initializes it, so calls are no-ops.
    const ptyDebugOn = (() => { try { return localStorage.getItem("ptyDebug") === "1"; } catch { return false; } })();
    const dbg = (tag: string, content: string) => debugLogRef.current?.(tag, content);

    const isRunTab = !!(tab as TerminalTab).runTab;

    // Work-done detection: respect per-agent opt-out. When disabled, skip
    // the entire state machine — no OSC handlers, no submit-window
    // promotion, no badge, no bell. Shell tabs and registry terminal
    // entries (kind: "terminal") always skip — a raw shell never emits
    // the OSC signals, so detection would only produce noise. Managed
    // Run/Setup tabs also skip: a stopped dev server is not an agent event.
    // ONE rule, shared with the queue/right-split UIs via workDoneCapable.
    const workDoneEnabled = !isRunTab && workDoneCapable(tab.cli);

    // ── State machine ──
    //
    // localBusy is the "agent is currently working" truth as decided by
    // whichever signal last spoke. settleTimer arms a `working → done`
    // transition after SETTLE_MS of declared idleness; canceled if a new
    // busy signal arrives. The settled-hash fallback in the
    // poll-interval effect below only fires when `workState === "working"`
    // — which itself only becomes true via sender signals — so the
    // heuristic can never produce false-positive `done` out of cold start.
    // 5s: long enough to survive Claude's ✳ ↔ spinner oscillation between
    // tool calls (~1-3s), short enough to feel responsive. OSC 9 fires
    // immediate done for real completions so this only affects the fallback.
    const SETTLE_MS = 5_000;
    let localBusy = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    // Submit-anchored heuristic: when the user presses Enter we open a
    // detection window. Any PTY data inside the window promotes to
    // "working" once; once we go to "done" the window closes until the
    // next Enter. Splash screens / periodic redraws on tabs the user
    // has never submitted to → no false positive. Cleared on workState
    // going back to idle (next submit reopens it cleanly).
    // Stamp spawn start synchronously — BEFORE any async work and before
    // the lastInputAt-watcher effect runs (effects run in definition order,
    // so this effect precedes the watcher). The watcher uses this value to
    // reject stale lastInputAt timestamps from prior PTY sessions. If this
    // stays 0 until the async IIFE sets it, the watcher sees 0 and any
    // lastInputAt > 0 (i.e. from the previous session) falsely arms the
    // submit-window and submittedSinceSpawn on launch.
    spawnStartedAtRef.current = Date.now();
    // Reset submit-window refs for this new PTY session.
    submitWindowUntilRef.current = 0;
    submitAtRef.current = 0;
    preSubmitHashRef.current = 0;
    const ECHO_DEAD_MS = 300;
    // Reset the ref for this new PTY session. The lastInputAt-watching
    // effect and term.onData both set it to true once the user submits.
    submittedSinceSpawnRef.current = false;
    // Reset sender classification so signal-silent agents (agy, custom CLIs)
    // get submit-window working detection on every respawn, not just the first.
    senderStateRef.current = null;
    captureArmedRef.current = false;
    // Fresh PTY → no done has fired yet for the (eventual) first submit.
    doneFiredSinceSubmitRef.current = false;
    // Reset workState for this (re)spawn — stale "done" from a prior
    // PTY (or pre-Restart session) would otherwise show a bullet for a
    // freshly-spawned agent.
    setWorkState(task.id, tab.id, "idle");

    const cancelSettle = (reason: string) => {
      if (!settleTimer) return;
      clearTimeout(settleTimer);
      settleTimer = null;
      wdlog(`settle cancelled (${reason})`);
    };
    const armSettle = (reason: string, delay = SETTLE_MS) => {
      if (settleTimer) clearTimeout(settleTimer);
      // Snapshot focus at the moment the agent went idle (work finished).
      // If the user was looking then, they saw the result even if they
      // navigate away before this 5s timer fires → no badge.
      const a = useApp.getState();
      const seenAtIdle = a.activeTaskId === task.id && a.activeTab[task.id] === tab.id;
      settleTimer = setTimeout(() => {
        wdlog(`settle fired → workState=done`);
        fireDone(`settle timer (${reason})`, "done", seenAtIdle);
        settleTimer = null;
      }, delay);
      wdlog(`settle armed (${reason}) for ${delay}ms`);
    };
    const goWorking = (reason: string) => {
      if (!workDoneEnabled) return;
      cancelSettle(reason);
      if (!localBusy) {
        wdlog(`→ working (${reason})`);
        dbg("state→working", reason);
        localBusy = true;
        workingStartedAtRef.current = Date.now();
      }
      setWorkState(task.id, tab.id, "working");
    };
    const goIdle = (reason: string, delay = SETTLE_MS) => {
      if (!workDoneEnabled) return;
      cancelSettle(reason);
      if (delay === 0) {
        // Hard idle (OSC 133;D, OSC 9 notify) — flip to done now. No
        // settle window: the sender explicitly told us the turn ended.
        wdlog(`→ done (${reason})`);
        const wasWorking = localBusy ||
          ((useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as import("@/lib/types").TerminalTab | undefined)?.workState === "working");
        localBusy = false;
        // Only transition to done if we were actually working. If the user
        // already focused and cleared the previous done (workState → idle,
        // localBusy false), a late OSC 9 from the same turn must not re-fire
        // done — the user already acknowledged it. fireDone also enforces
        // one-done-per-submit as a second layer.
        if (!wasWorking) return;
        fireDone(reason);
        return;
      }
      const cur = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id);
      const wasWorking = localBusy || (cur?.type === "terminal" && cur.workState === "working");
      if (wasWorking) {
        wdlog(`→ settling (${reason})`);
        dbg("state→settling", `${reason} delay=${delay}ms`);
        localBusy = false;
        armSettle(reason, delay);
      }
      // No prior busy → ignore: avoids "Ready" titles on cold spawn
      // marking the tab done out of nowhere.
    };
    const goAttention = (reason: string) => {
      if (!workDoneEnabled) return;
      cancelSettle(reason);
      localBusy = false;
      // Mark workState=done so the visual indicator is consistent — the
      // agent has stopped. The orange "attention" badge is layered on top
      // via the unread channel.
      dbg("state→attention", reason);
      setWorkState(task.id, tab.id, "done");
      markAttention(task.id, tab.id, "attention");
      // The turn reached a terminal state (waiting on the user). Spend the
      // one-done-per-submit token so a trailing settle/OSC 9 can't stack a
      // blue done dot on top of the attention until the user responds.
      doneFiredSinceSubmitRef.current = true;
    };

    // ── OS notification forwarding (the iTerm2 "session is …" banner) ──
    //
    // OSC 9 plain + OSC 777 are agent-authored notification requests.
    // We forward the body to the OS verbatim, skipping only when the
    // user has the desktopNotifications pref off OR is currently
    // looking at the task. iTerm2 does the same focus-gating.
    // Format mirrors the screenshot the user provided:
    //   Title: "Session ⁂ <task> (<cli>)"
    //   Body:  <agent's verbatim message>
    const forwardNotification = (msg: string) => {
      if (isRunTab) return;
      const trimmed = msg.trim();
      if (!trimmed) return;
      try {
        const prefs = usePrefs.getState();
        if (!prefs.desktopNotifications) {
          wdlog(`OS notify suppressed (pref off): ${trimmed}`);
          return;
        }
        const app = useApp.getState();
        // Skip focused task — matches useAttentionNotifier's gating.
        if (app.activeTaskId === task.id) {
          wdlog(`OS notify suppressed (focused task): ${trimmed}`);
          return;
        }
        // Title = "project · task" (terminal/cli name dropped — it
        // was noise; the body carries the agent's message).
        const proj = app.projects.find(p => p.id === task.project_id);
        const title = proj?.name ? `${proj.name} · ${task.name}` : task.name;
        ipc.notify(title, trimmed, { taskId: task.id, tabId: tab.id }).catch(() => {});
        // Seed the focus-edge router so the user clicking the banner
        // (or otherwise refocusing the window within ROUTE_WINDOW_MS)
        // lands on the tab that emitted the notification. See
        // useAttentionNotifier.ts for the consumer.
        useUI.getState().setNotifyRoute({ taskId: task.id, tabId: tab.id });
        wdlog(`OS notify fired: ${title} — ${trimmed}`);
      } catch (e) {
        wdlog(`OS notify error`, e);
      }
    };

    // Per-CLI title classifier (fallback for agents that don't emit
    // OSC 9 / 133). Three states: busy / idle / attention.
    const classifyTitle = (cli: string, title: string): "busy" | "idle" | "attention" | null => {
      const t = title.trim();
      if (!t) return null;
      if (cli === "claude") {
        // Idle/done: title starts with "✳" (Claude's brand glyph).
        // Working: title leads with one or two spinner frames — we've
        // seen Braille (U+2800..U+28FF) AND combinations like "⠐ ⠂".
        // Rule: if the leading non-whitespace char is NOT ✳, it's the
        // spinner = busy. Falsely flagging an unknown title as busy
        // is the safer side: a momentary spurious busy gets reconciled
        // when the title next becomes "✳" or via byte-quiet; the
        // reverse (missing busy → premature done) is the bug we're
        // chasing.
        if (/^\s*✳/.test(t)) return "idle";
        // Any leading non-✳ glyph → assume spinner = working.
        if (/^\s*\S/.test(t) && !/^\s*[A-Za-z0-9]/.test(t)) return "busy";
        return null;
      }
      if (cli === "codex") {
        if (/\b(Waiting|Action Required)\b/.test(t)) return "attention";
        if (/\bReady\b/.test(t)) return "idle";
        if (/\b(Working|Thinking)\b/.test(t)) return "busy";
        // Codex uses Braille spinner frames (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) as the
        // leading char in titles like "⠋ AlertaAnunt" while processing.
        if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)) return "busy";
        return null;
      }
      return null;
    };

    // OSC 0/2 — title change. Always surface as the live tab label.
    // Only used as a busy/idle source for CLIs without OSC 9;4 (gemini,
    // codex). For claude (OSC 9;4 source) the title is a label only.
    let lastTitleState: "busy" | "idle" | "attention" | null = null;
    term.onTitleChange(t => {
      // Display the title verbatim (no prefix strip). The spinner /
      // brand glyphs are SIGNAL: seeing "⠐ ⠂ Task" vs "✳ Task" in the
      // tab pill tells the user "agent is working" at a glance —
      // stripping erased that signal AND was the only displayed
      // difference between working / idle for users who turned the
      // bullet pref off.
      setTabLiveTitle(task.id, tab.id, t);
      // Any title update is activity. Reset the stillness counters so
      // the agent can keep repainting its title (progress, elapsed
      // time, etc.) without us falsely demoting to "done." Note
      // byte-quiet already updates because OSC 0 titles flow through
      // PTY data → lastDataAtRef.
      settledRef.current.unchangedCount = 0;
      settledRef.current.marked = false;
      scrollbackRef.current.stableCount = 0;
      scrollbackRef.current.marked = false;
      const state = classifyTitle(tab.cli, t);
      wdlog(`title change [classifier=${state ?? "unknown"}, last=${lastTitleState ?? "none"}]`, t);
      dbg("title", `classifier=${state ?? "??"} title=${t}`);
      // Record the sender-classified state so the interval-based
      // demoters below (byte-quiet, settled-hash, scrollback) can
      // skip when the title actively says "busy" — Gemini's "✦ Working"
      // title can sit unchanged for 30+ s while the agent thinks,
      // beating our 4 s/6 s heuristic thresholds.
      if (state) senderStateRef.current = state;
      if (state === "idle") {
        if (lastTitleState === "busy" || lastTitleState === "attention") {
          goIdle(`title busy→idle`);
        }
      } else if (state === "attention") {
        goAttention(`title attention`);
      } else if (state === "busy") {
        // Gate on submittedSinceSpawnRef: startup animations (Codex Braille
        // spinner, Claude's initial render) look identical to working
        // spinners. Only trust busy titles after the user has sent at
        // least one message this PTY session (keyboard Enter or broadcast).
        if (submittedSinceSpawnRef.current) goWorking(`title busy`);
        else wdlog(`title busy suppressed (no submit since spawn)`);
      }
      if (state) lastTitleState = state;
    });

    // OSC 9 — Claude / VTE. Two sub-forms:
    //   "9;<text>"       → notification (forward to OS verbatim).
    //   "9;4;<state>..." → ConEmu progress.
    // xterm's parser strips the leading "9;" before calling the handler,
    // so `data` here is the rest. Empty/no-leading-"4;" = notification.
    term.parser.registerOscHandler(9, (data) => {
      const parts = data.split(";");
      if (parts[0] === "4") {
        // OSC 9;4;<state>[;<pct>] — ConEmu progress protocol.
        //   state 0 = clear (idle)
        //         1 = normal       (pct 0..100)
        //         2 = error        (pct 0..100, red bar)
        //         3 = indeterminate (no pct → spinner-only)
        //         4 = warning      (pct 0..100, yellow bar)
        const state = Number(parts[1] ?? "0");
        const pctRaw = parts[2];
        const pct = pctRaw === undefined || pctRaw === "" ? null : Number(pctRaw);
        const nowBusy = state === 1 || state === 2 || state === 3 || state === 4;
        wdlog(`OSC 9;4;${state}${pct !== null ? ";" + pct : ""} (busy=${nowBusy}, was=${localBusy})`);
        dbg("osc9;4", `state=${state} pct=${pct ?? "null"} busy=${nowBusy}`);
        if (nowBusy) {
          goWorking(`OSC 9;4;${state}`);
          // Indeterminate (state 3) keeps the spinner visible without a
          // bar. States 1/2/4 carry a pct → render the strip tinted by kind.
          if (state === 1 || state === 2 || state === 4) {
            const k = state as 1 | 2 | 4;
            setWorkProgress(task.id, tab.id, Number.isFinite(pct as number) ? pct : null, k);
          } else {
            setWorkProgress(task.id, tab.id, null, 3);
          }
        } else {
          // 9;4;0 → idle. Settle to "done" after SETTLE_MS.
          goIdle(`OSC 9;4;0`);
        }
        return false;
      }
      // OSC 9;<text> — Send notification. Body is `data` itself
      // (no leading "4;"). Empty payload = no-op.
      //
      // iTerm2 treats this as: forward to OS AND render the tab's
      // work-done indicator (blue bullet). It does NOT escalate to the
      // attention/bell — the screenshot we mirror shows a blue bullet
      // even when the body reads "Claude is waiting for input." So
      // we settle to `done` here and forward the body verbatim. We
      // intentionally do NOT route through markAttention(), which
      // would cause useAttentionNotifier to fire a SECOND OS
      // notification on top of our verbatim forward.
      wdlog(`OSC 9 notify`, data);
      dbg("osc9-notify", data.slice(0, 200));
      // Only forward the OS notification if we're still in working state.
      // Claude sends OSC 9 tens of seconds after the settle timer already
      // fired done and the user acknowledged it — forwarding then produces
      // a spurious desktop banner for a turn they already saw.
      const stillWorking = localBusy ||
        ((useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as import("@/lib/types").TerminalTab | undefined)?.workState === "working");
      if (stillWorking) forwardNotification(data);
      goIdle(`OSC 9 notify`, 0);
      return false;
    });

    // OSC 777;notify;<title>;<body> — VTE/urxvt notification dialect.
    // Some custom agents emit this instead of OSC 9.
    term.parser.registerOscHandler(777, (data) => {
      const parts = data.split(";");
      if (parts[0] !== "notify") return false;
      const body = parts.slice(2).join(";") || parts[1] || "";
      wdlog(`OSC 777 notify`, body);
      dbg("osc777-notify", body.slice(0, 200));
      forwardNotification(body);
      goIdle(`OSC 777 notify`, 0);
      return false;
    });

    // OSC 133 — FinalTerm semantic prompt marks. Shell-integration
    // signal; works for any tool that emits it (claude builds with
    // shell-integration on, shells with iTerm2's shell-integration
    // installed, etc.). Subcommands:
    //   A → prompt start    (idle)
    //   B → prompt end      (idle, user-input window open)
    //   C → command running (busy)
    //   D[;<exit>] → command done (idle, immediate — no settle delay)
    term.parser.registerOscHandler(133, (data) => {
      const sub = (data.split(";")[0] || "").toUpperCase();
      wdlog(`OSC 133;${sub}`);
      dbg("osc133", sub);
      if (sub === "C") {
        goWorking(`OSC 133;C`);
      } else if (sub === "D") {
        // 133;D is a hard "command ended" — no need to wait SETTLE_MS.
        goIdle(`OSC 133;D`, 0);
      } else if (sub === "A" || sub === "B") {
        // Prompt boundary — idle, but only settle if we were busy.
        goIdle(`OSC 133;${sub}`);
      }
      return false;
    });

    // Push-on-data extender is INTENTIONALLY a no-op.
    // We trust sender signals; PTY bytes between busy=true/false
    // transitions don't matter. Keeps the timer honest.
    pushOscDoneRef.current = () => {};

    // OSC 1337 — iTerm proprietary. RequestAttention=yes/fireworks is
    // an explicit "user, look at me." Fires attention immediately.
    term.parser.registerOscHandler(1337, (data) => {
      dbg("osc1337", data.slice(0, 200));
      if (/^RequestAttention=(yes|fireworks)$/i.test(data)) {
        goAttention(`OSC 1337 RequestAttention`);
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

    // Decide synchronously — BEFORE the rAF await in the spawn IIFE below —
    // whether this is the task's "primary" agent tab (the one allowed to
    // auto-resume). Reading the tab list after the async gap can see a stale
    // snapshot: two same-cli tabs mounting in the same frame could each miss
    // the other and both claim primary, racing two resumes onto one uuid.
    // We can't lean on tab.is_default alone — a task woken from sleep
    // re-creates its agent tab without that flag — so treat the FIRST terminal
    // tab of this cli as primary too (a "+" tab is never first → still starts
    // fresh). `tabs` deliberately stays OUT of the effect deps: respawning the
    // PTY on every tab add/remove would be far worse than this one snapshot.
    const isShell = tab.cli === "shell";
    // Custom-command tasks run a user-supplied launch command in a
    // login shell — never an agent. They share the shell's "no resume,
    // no agent_id, no per-agent env" treatment; only the spawned argv
    // differs (see spawnArgs below).
    const isCustom = tab.cli === "custom";
    // Registry terminal entries (Settings → kind: "terminal", #27): spawn
    // like custom tabs (launch line through a login shell, no resume) but
    // KEEP their registry env block + agent_id (so their sandbox path /
    // host lists apply), since both are user-configured on the entry.
    const isRegistryTerminal = !isShell && !isCustom && isTerminalCli(tab.cli);
    const isAgent = !isShell && !isCustom && !isRegistryTerminal;
    const idCapable = isAgent && cliSupportsIdSession(tab.cli);
    const captureCapable = isAgent && cliSupportsCaptureResume(tab.cli);
    const taskTabsNow = useApp.getState().tabs[task.id] || [];
    const firstAgentOfCli = taskTabsNow.find(
      t => t.type === "terminal" && (t as TerminalTab).cli === tab.cli,
    );
    const isPrimaryTab = !!tab.is_default || firstAgentOfCli?.id === tab.id;

    // Per-tab resume. EVERY agent tab resumes now (not just the primary):
    // id-capable agents (claude / gemini) get their own `sessionId` so two
    // agents in one task resume independently; cwd-only agents (codex)
    // resume on the primary tab and start fresh on secondary tabs (the CLI
    // can't address a specific past session). decideResume is pure + unit-
    // tested; here we just map its verdict onto spawnArgsForCli's inputs.
    // Read the uuid from the LIVE store snapshot, not the captured `tab`
    // prop — `setTabSessionId` updates it out-of-band and `tabs` is kept
    // out of this effect's deps (respawning on every tab edit is far worse).
    const tabNow = taskTabsNow.find(t => t.id === tab.id) as TerminalTab | undefined;
    const storedUuid = tabNow?.sessionId;
    // Capture-resume agents (opencode): inject the captured session ID as a
    // resumeOverride so spawnArgsForCli uses it without touching decideResume.
    const captureResumeOverride = captureCapable && storedUuid
      ? `--session ${storedUuid}` : undefined;
    const decision = decideResume({
      isAgent,
      idCapable,
      isPrimary: isPrimaryTab,
      isRepoRoot: !!task.is_main_checkout,
      hasResumableHistory: !!task.has_resumable_history,
      storedUuid,
      resumeOverride: task.resume_override ?? undefined,
      failedResume: failedResumeRef.current,
    });
    const resumeOverride = captureResumeOverride ?? (decision.kind === "override" ? decision.override : undefined);
    const useIdResume = decision.kind === "resume-id" || decision.kind === "mint";
    const sessionUuid =
      decision.kind === "mint" ? crypto.randomUUID()
      : decision.kind === "resume-id" ? storedUuid
      : undefined;
    const resumeKnown = decision.kind === "resume-id";
    const shouldResume = decision.kind === "cwd-resume";

    // PTY spawn flow needs the webview to have laid the container out first,
    // otherwise fit.fit() returns 0×0 and we spawn a PTY with garbage dims.
    (async () => {
      await new Promise<void>(r => {
        let settled = false;
        const fin = () => { if (!settled) { settled = true; r(); } };
        requestAnimationFrame(() => requestAnimationFrame(fin));
        // rAF freezes to zero in occluded windows (the user switches Space
        // right after opening a task; automation-driven instances run
        // unfocused by design) - without a fallback the spawn stalls until
        // the window repaints, possibly forever. On the fallback path
        // fit.fit() may read 0x0, but cols/rows below clamp to sane
        // minimums and the next real paint resizes the PTY to true dims.
        setTimeout(fin, 400);
      });
      if (cancelled) return;
      // GH #70: don't measure/spawn until the terminal font's faces are
      // active, so cell metrics and the WebGL glyph atlas come from the
      // real font, not the fallback. Warmed at app boot — normally this
      // resolves in a microtask. See awaitTerminalFonts.
      await awaitTerminalFonts(term, fit, host, () => cancelled, () => ptyRef.current);
      if (cancelled) return;
      try { fit.fit(); } catch {}
      const cols = Math.max(40, term.cols || 100);
      const rows = Math.max(10, term.rows || 30);

      try {
        // The per-tab resume decision (resumeOverride / useIdResume /
        // sessionUuid / resumeKnown / shouldResume) was resolved
        // synchronously ABOVE, before the rAF await, alongside isPrimaryTab
        // — reading the live store snapshot there avoids the stale-snapshot
        // race two same-cli tabs mounting in one frame would otherwise hit.
        // See decideResume for the strategy table.
        spawnStartedAtRef.current = Date.now();
        // Override owns its own "session not found" handling (claude shows
        // the resume picker), so it never counts as a resume for the fast-
        // exit fallback — only real resume-id / cwd-resume spawns do.
        lastSpawnWasResumeRef.current = shouldResume || (useIdResume && resumeKnown);
        hasHistoryLocalRef.current = false;
        // Agent: resolve the executable through the registry (users can
        // repoint `claude` etc. in Settings → Agent CLIs). Shell / custom:
        // the user's login shell ($SHELL, falling back to bash/fish/sh),
        // mirroring the AuxTerminal scratch shell. Hard-coding zsh here
        // locked out users without it (#13).
        const userShell = isAgent ? "" : await loginShell();
        if (cancelled) return;
        const spawnCmd = isAgent ? spawnCommandForCli(tab.cli) : userShell;
        // Custom / registry terminal: run the launch command, then drop
        // into an interactive login shell so the terminal stays usable
        // after it exits (an ssh disconnect / Ctrl-C'd dev server leaves a
        // live shell in the repo dir rather than a dead tab). `-i` so the
        // command sees the same env as a real terminal — many users set
        // PATH (nvm, etc.) in their rc, which a non-interactive shell
        // skips. loginShellArgs handles the cross-shell argv
        // (zsh/bash/fish/sh). Shell: plain login shell. Agent:
        // registry-resolved argv.
        let launchCmd = isCustom && tab.command ? tab.command
          : isRegistryTerminal ? terminalLaunchCommand(tab.cli, task)
          : undefined;
        // Spotlight: the host Run tab executes at the REPO ROOT while this
        // task is spotlighted (the root serves the synced changes).
        // Decided at spawn time, not tab-creation time, so restarting after
        // a spotlight start/stop picks up the right cwd automatically.
        {
          const rt = (tab as TerminalTab).runTab;
          if (launchCmd && rt && (rt.kind ?? "run") === "run" && rt.member === "" && !task.is_main_checkout) {
            const st = useApp.getState();
            const project = st.projects.find(p => p.id === task.project_id);
            if (project?.spotlight_enabled && st.spotlightTaskId[task.project_id] === task.id) {
              launchCmd = `cd "${project.root_path.replace(/"/g, '\\"')}"\n${launchCmd}`;
            }
          }
        }
        const spawnArgs = !isAgent
          // Run/Setup pop-out tabs: PTY lifetime = script lifetime (no
          // exec-back-into-shell tail), so "PTY alive" ≈ "script running"
          // for the pill / top-bar controls.
          ? loginShellArgs(userShell, launchCmd, !!(tab as TerminalTab).runTab)
          : spawnArgsForCli(tab.cli, {
          // YOLO auto-on whenever the task is sandboxed: the seatbelt
          // cage is the real security boundary, so the agent's own
          // permission-prompt scaffolding is just friction. The user pref
          // still wins when sandbox is off, and the wizard / sandbox dialog
          // spell this out so nobody is surprised.
          // Per-task YOLO flag, OR auto-on when ENFORCING / ENFORCING
          // (FS) (there the seatbelt filesystem cage is the real boundary,
          // so the agent's own prompts are friction). In Off/Monitoring
          // it's purely the saved per-task flag — no silent auto-
          // approve in an uncaged task.
          yolo: (() => { const m = effectiveSandboxMode(task); return m === "enforce" || m === "enforce-fs" || !!task.yolo; })(),
          resume: shouldResume,
          isPrimary: isPrimaryTab,
          sessionUuid,
          resumeKnown,
          resumeOverride,
          task,
        });
        const spawn = await ipc.ptySpawn({
          cwd: task.path,
          cmd: spawnCmd,
          args: spawnArgs,
          // Order matters: base TERMIC_*/COLORFGBG block first, then
          // the user's per-agent env block (Settings → Agents). The
          // per-agent values win on key collision so a power user can
          // override e.g. COLORFGBG or even TERMIC_PORT if they really
          // want to. Rust merges this overlay AFTER the inherited
          // parent env, so anything set here always trumps a system env.
          env: {
            TERMIC_PORT: String(task.port),
            TERMIC_WORKSPACE_NAME: task.name,
            COLORFGBG: currentColorFgBg(),
            // Registry entries (agents AND terminal-kind) carry a
            // user-configured env block; sentinel shell/custom tabs don't.
            ...(isAgent || isRegistryTerminal ? envForCli(tab.cli) : {}),
          },
          // Sandbox gating: ad-hoc TERMINALS the user drives spawn UNCAGED —
          // a plain shell (`cli: "shell"`) and registry "custom terminal"
          // entries (docker/ssh/repl, #27). Omitting task_id makes Rust
          // skip the seatbelt, so git/ssh, shell history, and the full login
          // env work. RUN and SETUP script tabs (any `runTab`) are ALSO
          // uncaged: per the threat model only the agent CLI is sandboxed, and
          // setup/run scripts (npm install, dev servers) legitimately need
          // full network + filesystem. The task's PRIMARY process keeps the
          // cage: agents AND a custom-command task's own default tab (`cli:
          // "custom"`, no runTab) pass the id, since both run something
          // automated against the repo. Rust then gates on
          // task.sandbox_enabled (a no-op when sandbox off).
          task_id: (isShell || isRegistryTerminal || !!(tab as TerminalTab).runTab) ? undefined : task.id,
          // The tab's CLI may differ from the task's primary CLI
          // (claude task with a gemini tab open, etc.). Send the
          // tab's agent id so the rendered SBPL profile uses THIS
          // agent's allowed paths + host allowlist, not the task
          // default. Registry terminal entries pass theirs too — their
          // sandbox lists are equally user-configured. A shell tab has
          // no agent id → Rust falls back to the task's primary
          // CLI for the profile.
          agent_id: isAgent || isRegistryTerminal ? tab.cli : undefined,
          rows, cols,
        });
        const ptyId = spawn.id;
        if (cancelled) { ipc.ptyKill(ptyId).catch(() => {}); return; }
        ptyRef.current = ptyId;
        patchTab(task.id, tab.id, { ptyId, lastOutputAt: Date.now() });
        // Per-PTY debug logger — active only when localStorage.ptyDebug === "1".
        // Writes to termic-pty-<task>-<cli>-<ptyId>.log in OS temp dir.
        // Find it: python3 -c 'import tempfile; print(tempfile.gettempdir())'
        if (ptyDebugOn) {
          const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
          const file = `termic-pty-${safe(task.name)}-${tab.cli}-${ptyId}.log`;
          const t0 = Date.now();
          debugLogRef.current = (tag: string, content: string) => {
            const elapsed = Date.now() - t0;
            const line = `[+${String(elapsed).padStart(7)}ms] ${tag.padEnd(18)}: ${content}`;
            ipc.ptyDebugAppend(file, line).catch(() => {});
          };
          console.log(`[ptyDebug] logging to OS_TEMP_DIR/${file}`);
          dbg("spawn", `task=${task.name} cli=${tab.cli} ptyId=${ptyId} file=${file}`);
        }
        // Sandbox truth lands synchronously with the spawn (no event
        // race possible). Render the warning chip immediately when the
        // cage degraded.
        setSandboxWarning(spawn.sandbox.warning || null);
        // Fire-and-forget analytics. Real resume gating lives on the
        // has_resumable_history flag below, not here.
        ipc.taskRecordSpawn(task.id).catch(() => {});
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
          // Just minted a uuid for THIS tab: persist it (per-tab, so each
          // agent in the task resumes independently) so the next spawn
          // — this session or after a restart — uses --resume <uuid> instead
          // of --session-id <uuid>. setTabSessionId updates both the
          // in-memory tab and disk.
          if (decision.kind === "mint" && sessionUuid) {
            useApp.getState().setTabSessionId(task.id, tab.id, sessionUuid);
          }
          // Cwd-resume agents (codex) + legacy worktree continue: keep the
          // has_resumable_history flag flow so the next worktree spawn (this
          // session or after a restart) appends resume_args. id-resume tabs
          // never touch this — their per-tab uuid carries the resume state.
          if (!useIdResume && !task.is_main_checkout && !task.has_resumable_history) {
            ipc.taskSetHasHistory(task.id, true).catch(() => {});
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
          lastDataAtRef.current = now;
          patchTab(task.id, tab.id, { lastOutputAt: now });
          if (ptyDebugOn) dbg("data", decodeForDebug(u8));
          // Output activity extends the OSC 9;4 done timer — even if
          // the agent went OSC-idle, fresh bytes mean it's still
          // streaming output (thought summary, tool result text, etc.)
          // so it's not really done.
          pushOscDoneRef.current();
          const cur = (useApp.getState().tabs[task.id] || []).find(t => t.id === tab.id);
          if (cur && cur.type === "terminal") {
            // BEL gating: only treat as attention when the user has typed
            // AND the agent is not actively working. Agents like Claude
            // emit BEL every ~1s during their spinner — we don't want to
            // ring the sidebar bell 60 times while they're mid-task, only
            // when they ring it from an idle/done state to get user input.
            if (workDoneEnabled && u8.indexOf(0x07) !== -1 && cur.lastInputAt && cur.workState !== "working") {
              dbg("bel", `lastInputAt=${cur.lastInputAt} workState=${cur.workState}`);
              markAttention(task.id, tab.id, "bell");
            }
            // Submit-anchored "working" promotion. Only fires for agents
            // that have emitted NO title/OSC signals (senderStateRef null)
            // — i.e. fully silent CLIs like agy. Claude/Gemini/Codex all
            // set senderStateRef on their first title change and get
            // reliable working detection from there; using the submit-
            // window for them causes false positives because Claude's TUI
            // redraws on every Enter (viewport shifts, hash changes,
            // settled-done fires on idle prompt).
            if (workDoneEnabled
                && senderStateRef.current === null
                && now < submitWindowUntilRef.current
                && now - submitAtRef.current >= ECHO_DEAD_MS
                && cur.workState !== "working") {
              wdlog(`→ working (submit-window data)`);
              dbg("state→working", `submit-window data (+${now - submitAtRef.current}ms after submit)`);
              setWorkState(task.id, tab.id, "working");
              submitWindowUntilRef.current = 0; // one-shot per submit
            }
          }
        });
        // Compose data + sandbox unlisteners into the existing ref so
        // cleanup tears down both. Avoids adding another ref.
        unlistenDataRef.current = unlistenData;

        const unlistenExit = await ipc.onPtyExit(ptyId, (code) => {
          ptyRef.current = null;
          // Run/setup tabs (GH #54): surface a non-zero exit as "failed" on
          // the tab pill. code === null means the process was killed (Stop
          // button, app quit) rather than actually failing, so that's left
          // alone. Runs regardless of which branch below fires next — a run
          // tab either gets the "exited" overlay (below) or, for a plain
          // shell/registry terminal, closes outright; either way the exit
          // code is already known here.
          if (isRunTab && code !== null && code !== 0) {
            const live = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as
              import("@/lib/types").TerminalTab | undefined;
            if (live?.runTab) {
              patchTab(task.id, tab.id, { runTab: { ...live.runTab, failed: true } });
            }
          }
          const fastExit = Date.now() - spawnStartedAtRef.current < RESUME_FAILURE_MS;
          if (fastExit && lastSpawnWasResumeRef.current) {
            // Rapid exit during a resume attempt = the stored session
            // doesn't resolve anymore (id-CLI: log rotated / deleted;
            // legacy: "no conversation to continue"). Drop the bad
            // state + bump gen → respawn fresh. No overlay flicker —
            // we never set exited=true. The in-component failure flag
            // makes the immediate retry skip resume even before the
            // task prop refreshes.
            failedResumeRef.current = true;
            if (decision.kind === "resume-id") {
              // This tab's stored uuid didn't resolve on this spawn. Don't
              // discard it — the failure may be transient (the session's
              // transcript still exists on disk), and nuking the pointer
              // turns that into permanent conversation loss. Stash it as the
              // tab's previous session so the recover banner can offer it,
              // then clear the live slot so the immediate retry mints fresh.
              // An occupied stash is left alone: it holds the session we
              // swapped away from to try this one, which is worth keeping
              // over a uuid that just proved unresumable.
              const stashed = (useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as
                TerminalTab | undefined)?.previousSessionId;
              if (storedUuid) {
                if (!stashed) useApp.getState().setTabPreviousSessionId(task.id, tab.id, storedUuid);
                setFailedUuid(storedUuid);
              }
              useApp.getState().setTabSessionId(task.id, tab.id, "");
            } else if (!useIdResume) {
              // Worktree rapid-exit on `--continue` = "no conversation"
              // — flip the persistent flag so future spawns skip resume.
              ipc.taskSetHasHistory(task.id, false).catch(() => {});
            }
            setGen(g => g + 1);
            return;
          }
          // Config-driven restart: the user just hit "Save & restart" on a
          // config dialog (Sandbox or Resume override). Auto-respawn instead
          // of showing the exited overlay so they don't click Restart.
          if (useUI.getState().consumePendingPtyRestart(task.id)) {
            setGen(g => g + 1);
            return;
          }
          // Run pop-out tabs stay alive on exit — Stop / a crashed dev server
          // shows the "exited / Restart" overlay in place, keeping the tab's
          // spot in the layout. Only an explicit ✕ closes it (GH #54).
          // Plain shell tabs AND registry terminal entries close on exit
          // (Ctrl+D / `exit`) — a shell that's done is done. The "exited /
          // Restart" overlay and the unread "exit" badge are for agents
          // (and custom-command tasks), where an unexpected death is
          // worth surfacing.
          if ((tab.cli === "shell" || isRegistryTerminal) && !isRunTab) {
            if (tab.paneId) {
              useApp.getState().closePane(task.id, tab.paneId);
            } else {
              useApp.getState().closeTab(task.id, tab.id);
            }
            return;
          }
          // Non-main split panes (agents): close the pane on exit rather than
          // showing the "exited / Restart" banner — the pane's job is done.
          if (tab.paneId && !isRunTab) {
            useApp.getState().closePane(task.id, tab.paneId);
            return;
          }
          if (isRunTab) useApp.getState().clearAttention(task.id, tab.id);
          else markAttention(task.id, tab.id, "exit");
          // Capture-based session resume (opencode): on the first normal exit
          // when no session ID is stored, run the capture command so the next
          // spawn can use --session <id> instead of starting fresh.
          if (captureCapable) {
            const liveTab = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as import("@/lib/types").TerminalTab | undefined;
            if (!liveTab?.sessionId) {
              const capture = postLaunchCaptureForCli(tab.cli);
              if (capture) {
                ipc.runCaptureCommand(capture.command, task.path)
                  .then(id => { if (id) useApp.getState().setTabSessionId(task.id, tab.id, id); })
                  .catch(() => {});
              }
            }
          }
          // Clear the PTY id — the process is gone. Otherwise the dead
          // id lingers on the tab and features that enumerate live PTYs
          // (Broadcast) would target a corpse. A Restart respawns and
          // sets a fresh id; the resume/sandbox-restart branches above
          // return early and respawn without reaching here.
          patchTab(task.id, tab.id, { ptyId: undefined });
          setExited(true);
        });
        unlistenExitRef.current = unlistenExit;

        // Input: pipe xterm keystrokes back to PTY. User input is the
        // canonical "I've seen and addressed the done bullet" signal —
        // clear the workState ("done"/"working" → idle) and any
        // attention badge. iTerm2 keeps the bullet around until the
        // user actually types; matching that means clicking the tab to
        // check doesn't make the indicator vanish.
        term.onData(data => {
          // Note: onData fires for xterm automated responses too (cursor
          // position reports \e[row;colR in reply to \e[6n from TUI apps
          // like Claude Code). Do NOT update lastInputAt here for all data —
          // only stamp it on Enter (below), which is the only keystroke that
          // means "user submitted work". Updating on every onData event was
          // causing Claude's TUI cursor-query cycle (~200ms) to continuously
          // re-arm the submit-window with a fresh lastInputAt timestamp.
          // Only treat CR/LF as real user input. onData also fires for
          // xterm automated responses (cursor-position reports, DA replies)
          // that Claude Code's TUI sends every ~200ms. Those must NOT clear
          // the done badge or the attention state — they'd wipe the badge
          // within 200ms of it appearing. Arrow keys, backspace, tab
          // completion, and paste also pass through here but none of them
          // contain CR/LF, so they leave the done state alone too.
          if (data.indexOf("\r") !== -1 || data.indexOf("\n") !== -1) {
            settledRef.current = { lastHash: 0, unchangedCount: 0, marked: false };
            scrollbackRef.current = { lastLen: -1, stableCount: 0, marked: false };
            // Demote workState to idle on Enter — the user is now driving.
            const cur = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id);
            if (cur?.type === "terminal" && cur.workState === "done") {
              setWorkState(task.id, tab.id, "idle");
            }
            if (cur?.unread) {
              useApp.getState().clearAttention(task.id, tab.id);
            }
            patchTab(task.id, tab.id, { lastInputAt: Date.now() });
            submittedSinceSpawnRef.current = true;
            submitAtRef.current = Date.now();
            submitWindowUntilRef.current = submitAtRef.current + 5_000;
            preSubmitHashRef.current = hashVisibleBuffer(term);
            // New submit → a new turn begins. Re-arm done detection so the
            // next completion fires a badge (the prior turn's done is spent).
            doneFiredSinceSubmitRef.current = false;
            wdlog(`submit detected (Enter) → 5s working window armed`);
            dbg("user-submit", `Enter → 5s window armed preHash=0x${preSubmitHashRef.current.toString(16)}`);
            // Capture-based resume (opencode): on the first Enter with no
            // stored session ID, wait 5s then harvest the session ID the
            // CLI just created. Strictly one-shot per spawn.
            if (captureCapable && !captureArmedRef.current) {
              const liveTab = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as import("@/lib/types").TerminalTab | undefined;
              if (!liveTab?.sessionId) {
                const capture = postLaunchCaptureForCli(tab.cli);
                if (capture) {
                  captureArmedRef.current = true;
                  window.setTimeout(() => {
                    ipc.runCaptureCommand(capture.command, task.path)
                      .then(id => { if (id) useApp.getState().setTabSessionId(task.id, tab.id, id); })
                      .catch(() => {});
                  }, 5000);
                }
              }
            }
          }
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
      disposeCopyOnSelect();
      disposeLinkOpener();
      unregisterDrop();
      disposeImeBridge();
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      if (ptyRef.current) ipc.ptyKill(ptyRef.current).catch(() => {});
      // Dispose the renderer addon FIRST so its render loop can't fire
      // on a half-disposed terminal.
      // Cancel any pending settle timer so it can't fire on the next PTY
      // session after a gen-bump Restart. settleTimer is a local let in this
      // closure — we must clear it here rather than in cancelSettle() because
      // the new effect's cancelSettle is a different closure instance.
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      try { rendererAddon?.dispose(); } catch {}
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      debugLogRef.current = null;
    };
  // `gen` in the deps array is what makes the Restart button work: it
  // bumps, the effect tears down, the effect runs again, fresh PTY.
  }, [task.id, task.path, task.port, task.name, tab.id, tab.cli, patchTab, markAttention, gen]);

  // Refit + focus when the tab becomes active OR when its task
  // becomes the active task (e.g., clicking a task in the
  // sidebar). Mounted tasks stay rendered with visibility-hidden, so
  // the tab's `active` prop alone doesn't change on task switch —
  // we have to also watch the global activeTaskId to know when this
  // pane just became the one the user is looking at.
  const isActiveTask = useApp(s => s.activeTaskId === task.id);
  useEffect(() => {
    if (!active || !isActiveTask) return;
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch {}
      try { termRef.current?.focus(); } catch {}
    });
  }, [active, isActiveTask]);

  // Arm the submit-window refs when lastInputAt changes from outside
  // (i.e. BroadcastDialog stamping it via patchTab). Only counts if it's
  // after the current spawn started — stale values from prior PTY sessions
  // are ignored. This gives broadcast the same working-detection capability
  // as keyboard Enter, including for signal-silent agents like agy.
  useEffect(() => {
    const t = tab.lastInputAt;
    if (t && t > (spawnStartedAtRef.current || 0)) {
      submittedSinceSpawnRef.current = true;
      submitAtRef.current = t;
      submitWindowUntilRef.current = t + 5_000;
      // Capture the pre-submit viewport hash so the hash-done check can
      // detect whether the agent actually responded. Matches what term.onData
      // does for keyboard Enter. Without this, preSubmitHashRef stays 0 for
      // broadcast submits and the false-positive guard is bypassed.
      preSubmitHashRef.current = termRef.current ? hashVisibleBuffer(termRef.current) : 0;
      // New turn → re-arm done detection (matches the term.onData Enter path).
      doneFiredSinceSubmitRef.current = false;
    }
  }, [tab.lastInputAt]);

  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => {
        const el = searchInputRef.current;
        if (!el) return;
        el.focus();
        el.select();
      });
    } else {
      termRef.current?.focus();
    }
  }, [searchOpen]);

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
  const terminalOptionAsMeta  = usePrefs(s => s.terminalOptionAsMeta);
  const firstFontRun = useRef(true);
  useEffect(() => {
    if (firstFontRun.current) { firstFontRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.fontFamily     = currentTerminalStack();
    t.options.fontSize       = terminalFontSize;
    t.options.letterSpacing  = terminalLetterSpacing;
    t.options.macOptionIsMeta = terminalOptionAsMeta;
    try { fitRef.current?.fit(); } catch {}
    if (ptyRef.current) ipc.ptyResize(ptyRef.current, t.rows, t.cols).catch(() => {});
    // No font-load settle needed here (GH #70): every selectable family
    // except the bundled JetBrains Mono is an installed system font
    // (active synchronously), and the bundled faces were warmed at prefs
    // module load — long settled before Settings can even be opened.
  }, [terminalFontId, terminalFontSize, terminalLetterSpacing, terminalOptionAsMeta]);

  // Live theme swap: when the user picks a different theme in the
  // dropdown, push the new xterm palette into every mounted terminal.
  // xterm's `options.theme` setter triggers an internal repaint so we
  // don't need to touch the WebGL atlas explicitly.
  const themeMode = usePrefs(s => s.themeMode);
  // customThemeRev bumps when the active custom theme's FILE was edited
  // (same themeMode string, new palette) — see prefs.loadCustomThemes.
  const customThemeRev = usePrefs(s => s.customThemeRev);
  const firstThemeRun = useRef(true);
  useEffect(() => {
    if (firstThemeRun.current) { firstThemeRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.theme = currentTerminalTheme() as any;
    t.options.minimumContrastRatio = currentMinimumContrastRatio();
  }, [themeMode, customThemeRev]);

  // YOLO live toggle — for agents that support runtime mode switching (only
  // gemini today), send the appropriate slash command. For claude/codex this
  // is a no-op; the next spawn picks up the new flag.
  const effYolo = isSandboxEnforced(effectiveSandboxMode(task)) || !!task.yolo;
  const enforced = isSandboxEnforced(effectiveSandboxMode(task));
  const firstYoloRun = useRef(true);
  useEffect(() => {
    if (firstYoloRun.current) { firstYoloRun.current = false; return; }
    // YOLO only exists for agents. Shell / custom / registry-terminal tabs
    // spawn through the login shell and never receive yolo_args, so the
    // restart prompt would offer a respawn that changes nothing.
    if (isTerminalCli(tab.cli)) return;
    const ptyId = ptyRef.current;
    if (!ptyId) return;
    let cancelled = false;
    (async () => {
      // Agents that support runtime mode-switching (gemini) flip live.
      const applied = await tryToggleYoloLive(tab.cli, ptyId, effYolo);
      if (applied || cancelled) return;
      // Enforce transitions already restart the PTY (Sandbox dialog), so
      // only prompt for a genuine per-task YOLO toggle on a running
      // agent that can't switch mid-session (claude / codex).
      if (enforced) return;
      const ok = await useUI.getState().askConfirm({
        title: `Restart ${agentDisplayName(tab.cli)} to ${effYolo ? "enable" : "disable"} YOLO?`,
        message: `${agentDisplayName(tab.cli)} applies YOLO only on a fresh launch. Restart now (the session auto-resumes), or pick Later and it takes effect on the next restart.`,
        confirmLabel: "Restart now",
        cancelLabel: "Later",
      });
      if (ok && !cancelled) { setExited(false); setGen(g => g + 1); }
    })();
    return () => { cancelled = true; };
  }, [effYolo, enforced, tab.cli]);

  // Settled detection: hash the visible buffer every SAMPLE_MS. Once the hash
  // is identical across SETTLE_SAMPLES consecutive samples, the agent has
  // stopped producing meaningful output — promote to workState="done" only
  // if the tab is currently "working" (so we never produce false positives
  // out of nowhere; sender signals are authoritative). Acts as a last-resort
  // fallback for agents that don't emit OSC 9 / 9;4 / 133 / title — and as a
  // safety net if a sender signal got dropped. Skipped when work_done is off.
  useEffect(() => {
    // Read work_done from the live store inside the callback so that
    // toggling the setting in Settings takes effect immediately without
    // requiring a terminal remount. Previously captured at render time
    // (stale snapshot) which meant the toggle had no effect on mounted tabs.
    const QUIET_MS = 4_000;
    // 3 samples × 3s = 9s of no NEW scrollback lines before declaring
    // done from scrollback-stability. Tolerant of slow tool output;
    // strict enough to fire even when a status counter keeps ticking.
    const SCROLLBACK_STABLE_SAMPLES = 3;
    const id = window.setInterval(() => {
      // Same gate as the rest of the state machine — workDoneCapable reads
      // the LIVE registry, so a Settings toggle (or a kind change) takes
      // effect without a terminal remount. Also skips shells and registry
      // terminal entries, which must never produce a done/attention badge.
      if (!workDoneCapable(tab.cli)) return;
      const t = termRef.current;
      if (!t || !ptyRef.current) return;
      const cur = (useApp.getState().tabs[task.id] || []).find(x => x.id === tab.id);
      // Sender-signal gate: if the most recent title classification
      // says "busy", trust it over every heuristic. Gemini's title
      // ("✦ Working") can sit unchanged through a 30 s think while
      // the agent emits nothing — without this gate, byte-quiet
      // would falsely demote to `done`.
      const senderBusy = senderStateRef.current === "busy";
      // For agents that have never emitted a title or OSC signal we
      // can't distinguish "task done" from "waiting for user input".
      // Use "attention" (orange bell) instead of "done" (blue dot) for
      // these fallback paths — it's honest about the ambiguity and
      // prompts the user to check rather than claiming the task finished.
      const fallbackReason = senderStateRef.current === null ? "attention" : "done";
      // Byte-quiet fallback: if no PTY data has arrived for QUIET_MS
      // and the tab is `working`, demote to `done`. Fires when the
      // agent goes silent entirely. (Doesn't fire for Claude Code's
      // "Cooking for Ns" ticker — for that we need the scrollback
      // check below.)
      if (!senderBusy
          && cur && cur.type === "terminal" && cur.workState === "working"
          && lastDataAtRef.current > 0
          && Date.now() - lastDataAtRef.current >= QUIET_MS) {
        fireDone(`byte-quiet (quietMs=${Date.now() - lastDataAtRef.current})`, fallbackReason);
        return;
      }
      // Scrollback-stability check — only meaningful for NORMAL
      // buffer mode (Claude Code, plain shells). Alt-screen TUIs
      // (Codex) keep a fixed-length buffer so this would falsely
      // fire during real work. Also gated on senderBusy.
      if (!senderBusy && t.buffer.active.type === "normal") {
        const len = t.buffer.active.length;
        const sb = scrollbackRef.current;
        if (sb.lastLen === -1) {
          sb.lastLen = len;
        } else if (len === sb.lastLen) {
          sb.stableCount++;
          debugLogRef.current?.("settled-scrollback", `len=${len} stableCount=${sb.stableCount}/${SCROLLBACK_STABLE_SAMPLES} workState=${cur?.type === "terminal" ? cur.workState : "?"}`);
          if (sb.stableCount >= SCROLLBACK_STABLE_SAMPLES && !sb.marked) {
            if (cur && cur.type === "terminal" && cur.workState === "working") {
              fireDone(`scrollback-stable (len=${len})`, fallbackReason);
            }
            sb.marked = true;
          }
        } else {
          debugLogRef.current?.("settled-scrollback", `len changed ${sb.lastLen}→${len} (reset)`);
          sb.lastLen = len;
          sb.stableCount = 0;
          sb.marked = false;
        }
      }
      // Hard ceiling: 90s of "working" without any demoter firing —
      // force done. Skipped when senderBusy — if the title is actively
      // saying "working", the agent is genuinely still running; the
      // ceiling is only a safety net for when we lost the sender signal.
      const WORKING_HARD_CEILING_MS = 90_000;
      if (!senderBusy
          && cur && cur.type === "terminal" && cur.workState === "working"
          && workingStartedAtRef.current > 0
          && Date.now() - workingStartedAtRef.current >= WORKING_HARD_CEILING_MS) {
        fireDone(`90s hard ceiling`, fallbackReason);
        return;
      }
      // ABSOLUTE ceiling — fires even when senderBusy. The 90s ceiling and
      // byte-quiet fallback both defer to the sender's "busy" title, which
      // is correct for genuine long work but leaves one failure mode: a
      // sender signal that gets STUCK on "working" (a crashed TUI, a title
      // that never clears) would otherwise spin forever. This backstop
      // force-clears any "working" state older than the cap regardless of
      // sender signals, so the experimental work-in-progress spinner can
      // never get permanently stuck. Set high enough (10 min) that a real
      // long-running task is extremely unlikely to trip it.
      const WORKING_ABSOLUTE_CEILING_MS = 600_000;
      if (cur && cur.type === "terminal" && cur.workState === "working"
          && workingStartedAtRef.current > 0
          && Date.now() - workingStartedAtRef.current >= WORKING_ABSOLUTE_CEILING_MS) {
        fireDone(`10min absolute ceiling`, fallbackReason);
        return;
      }
      // Content-hash check (kept as a third path). Also gated on
      // !senderBusy — Codex's TUI can pause rendering mid-task for
      // several seconds without the hash changing, but if the title
      // still says the Braille spinner it's still working.
      if (!senderBusy) {
        const h = hashVisibleBuffer(t);
        const s = settledRef.current;
        if (h === s.lastHash && s.lastHash !== 0) {
          s.unchangedCount++;
          debugLogRef.current?.("settled-hash", `hash=0x${h.toString(16)} unchanged=${s.unchangedCount}/${SETTLE_SAMPLES} workState=${cur?.type === "terminal" ? cur.workState : "?"}`);
          if (s.unchangedCount >= SETTLE_SAMPLES && !s.marked) {
            // Require content to have changed from pre-submit baseline.
            // If the hash equals what it was when the user pressed Enter,
            // the agent never actually responded — it's an idle-prompt
            // false-positive (echo arrived just past ECHO_DEAD_MS).
            const contentChanged = preSubmitHashRef.current === 0 || h !== preSubmitHashRef.current;
            if (cur && cur.type === "terminal" && cur.lastInputAt && cur.workState === "working" && contentChanged) {
              fireDone(`hash-stable (0x${h.toString(16)})`, fallbackReason);
            }
            s.marked = true;
          }
        } else {
          debugLogRef.current?.("settled-hash", `hash changed 0x${s.lastHash.toString(16)}→0x${h.toString(16)} (reset)`);
          s.lastHash = h;
          s.unchangedCount = 0;
          s.marked = false;
        }
      }
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [task.id, tab.id, fireDone]);

  const exitedRunTab = !!tab.runTab;
  const exitedRunKind = tab.runTab?.kind ?? "run";

  // Setup is one-shot: once its script finishes SUCCESSFULLY, tidy the tab
  // away after a short countdown. The "Setup finished." banner hosts a live
  // counter button (right of "Run setup again") that closes now on click;
  // "Run setup again" clears `exited`, which disarms the countdown. A FAILED
  // setup (non-zero exit → runTab.failed) is never auto-closed: its red flag
  // and error scrollback must stay put so the user can see and act on it.
  const setupDone = exited && exitedRunTab && exitedRunKind === "setup" && !tab.runTab?.failed;
  const [closeIn, setCloseIn] = useState<number | null>(null);
  useEffect(() => {
    setCloseIn(setupDone ? SETUP_AUTO_CLOSE_S : null);
  }, [setupDone]);
  useEffect(() => {
    if (closeIn == null) return;
    if (closeIn <= 0) { useApp.getState().closeTab(task.id, tab.id); return; }
    const t = setTimeout(() => setCloseIn(n => (n == null ? null : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [closeIn, task.id, tab.id]);

  return (
    <div
      className="relative flex h-full w-full flex-col"
      data-tab-id={tab.id}
      // Clicking into either pane's terminal makes that pane the focused one,
      // so the single-active-tab cue and file-open routing follow the cursor.
      // Capture phase so it fires before xterm grabs the mousedown.
      onMouseDownCapture={() => {
        if (tab.paneId) useApp.getState().setActivePaneId(task.id, tab.paneId);
      }}
    >
      {exited && (
        // In-flow banner above the terminal (NOT a full-cover overlay): the
        // dead xterm below stays interactive so the user can select + copy
        // its scrollback (e.g. the crash message). `gen++` tears down the
        // spawn effect and re-runs it with a fresh PTY; the pane's
        // ResizeObserver refits the terminal when this strip appears/clears.
        <TerminalExitedBanner
          label={exitedRunTab
            ? (tab.runTab?.failed
                ? (exitedRunKind === "setup" ? "Setup failed." : "Run failed.")
                : (exitedRunKind === "setup" ? "Setup finished." : "Run stopped."))
            : `${agentDisplayName(tab.cli)} exited.`}
          actionLabel={exitedRunTab
            ? (exitedRunKind === "setup" ? "Run setup again" : "Run again")
            : `Restart ${agentDisplayName(tab.cli)}`}
          tone={exitedRunTab ? "muted" : "warning"}
          onAction={() => {
            // Restarting from the banner is a fresh run: drop any prior
            // failed flag so the red pill indicator clears (the pill's own
            // play button does this via clearFailed; keep both paths in sync).
            const live = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as
              import("@/lib/types").TerminalTab | undefined;
            if (live?.runTab?.failed) patchTab(task.id, tab.id, { runTab: { ...live.runTab, failed: false } });
            setExited(false);
            setGen(g => g + 1);
          }}
          secondary={setupDone && closeIn != null ? {
            label: `Close (${closeIn})`,
            title: `Closing in ${closeIn}s. Click to close now.`,
            icon: X,
            onAction: () => useApp.getState().closeTab(task.id, tab.id),
          } : undefined}
        />
      )}
      {!exited && tab.previousSessionId && (
        // A --resume attempt fast-exited and we fell back to a fresh session;
        // the old session id was stashed, not discarded, so offer to recover
        // it. In-flow (like the exited banner) so it pushes the live terminal
        // down instead of covering it. The banner outlives the failure (it's
        // persisted, and the fallback session may be days old by the time it's
        // clicked), so it swaps the two uuids rather than dropping the live
        // one, and words itself by whether the stashed session is the one that
        // failed to resume in this run.
        <TerminalExitedBanner
          label={tab.previousSessionId === failedUuid
            ? "Couldn't resume your previous session."
            : "Your previous session is still available."}
          actionLabel={tab.previousSessionId === failedUuid ? "Resume it" : "Switch back"}
          tone="warning"
          onAction={() => {
            const live = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as
              TerminalTab | undefined;
            const prev = live?.previousSessionId;
            if (!prev) return;
            // SWAP, don't discard: the session we're leaving is a real
            // conversation too (the user may have been working in it since the
            // failed resume), and dropping its uuid is the same permanent loss
            // this banner exists to prevent. Then respawn: reset the fail flag
            // + bump gen so the spawn effect re-reads the uuid live and resumes
            // it via --resume.
            useApp.getState().setTabSessionId(task.id, tab.id, prev);
            useApp.getState().setTabPreviousSessionId(task.id, tab.id, live?.sessionId ?? "");
            failedResumeRef.current = false;
            setGen(g => g + 1);
          }}
          secondary={{
            label: "Dismiss",
            title: "Keep the current session and forget the previous one",
            icon: X,
            onAction: () => useApp.getState().setTabPreviousSessionId(task.id, tab.id, ""),
          }}
        />
      )}
      <div ref={hostRef} className="min-h-0 flex-1 bg-[var(--color-bg)]" />
      {searchOpen && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            placeholder="Find in terminal"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            onChange={e => {
              setSearchQuery(e.target.value);
              if (e.target.value) searchAddonRef.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={e => {
              if (e.key === "Escape") { e.preventDefault(); setSearchOpen(false); }
              else if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? searchAddonRef.current?.findPrevious(searchQuery) : searchAddonRef.current?.findNext(searchQuery); }
            }}
            className="w-44 bg-transparent text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:outline-none"
          />
          <button type="button" title="Previous match (Shift+Enter)" onClick={() => searchAddonRef.current?.findPrevious(searchQuery)} className="rounded p-0.5 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"><ChevronUp className="h-3.5 w-3.5" /></button>
          <button type="button" title="Next match (Enter)" onClick={() => searchAddonRef.current?.findNext(searchQuery)} className="rounded p-0.5 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"><ChevronDown className="h-3.5 w-3.5" /></button>
          <button type="button" title="Close (Esc)" onClick={() => setSearchOpen(false)} className="ml-0.5 rounded p-0.5 text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {/* Sandbox status footer was here — moved up to TaskView
          so it sits BELOW the bottom-split (when open) and stays the
          visual bottom of the task, not the agent tab. The
          degraded-warning string isn't plumbed across that boundary
          yet (rare case); plumb through useUI later if it matters. */}
      {void sandboxWarning}
      {!exited && tab.promptPendingTitle && (
        // The agent is still booting after a "new agent" prompt spawn. Cover
        // the tab with a loader until runPrompt injects the prompt (then it
        // clears promptPendingTitle). The terminal boots underneath.
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)]/80">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--color-accent)]" />
          <div className="text-center">
            <div className="text-[13px] text-[var(--color-fg)]">Starting {agentDisplayName(tab.cli)}…</div>
            <div className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">
              Sending "{tab.promptPendingTitle}" when it is ready.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function FooterBar({ task, sandboxWarning }: {
  task: { id: string; cli?: string; sandbox_enabled?: boolean; sandbox_mode?: SandboxMode; sandbox_allowed_hosts?: string[]; sandbox_rw_paths?: string[] };
  sandboxWarning: string | null;
}) {
  const splitOpen     = useApp(s => !!s.terminalSplit[task.id]);
  const splitCollapsed = useApp(s => !!s.terminalSplitCollapsed[task.id]);
  const toggleSplit = useApp(s => s.toggleTerminalSplit);
  const mode = effectiveSandboxMode(task);

  // no right-split agent queue state needed; split panes show their own queue via SplitView

  // Live counter. ENFORCING polls the deny counter ("N blocked");
  // MONITORING polls the access counter ("N accesses"). Cheap (one
  // mutex lookup); 2s cadence.
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (mode === "off") { setTotal(0); return; }
    let cancelled = false;
    const fetchCounts = mode === "monitor" ? ipc.sandboxAccessCounts : ipc.sandboxDenyCounts;
    const tick = () => {
      fetchCounts(task.id)
        .then(c => { if (!cancelled) setTotal(c.network + c.path); })
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [task.id, mode]);

  // Sandbox half — the "degraded" warning state, else the standard
  // per-mode icon + label sourced from SANDBOX_VISUALS (see SandboxIcon).
  const sandboxNode = sandboxWarning ? (
    <>
      <AlertTriangle className="h-3.5 w-3.5 text-[var(--color-warn)]" />
      <span className="font-medium">Sandbox degraded</span>
      <span className="text-[var(--color-fg-faint)]">·</span>
      <span className="truncate">{sandboxWarning}</span>
    </>
  ) : (
    <>
      <SandboxIcon mode={mode} className="h-3.5 w-3.5" />
      <span>Sandbox: {SANDBOX_VISUALS[mode].shortLabel.toLowerCase()}</span>
    </>
  );

  return (
    <div
      className={cn(
        // --bottom-bar-h is the shared height for every bottom bar. text-[12.5px]
        // matches the queue/terminal buttons and the right-panel footer tabs.
        // Suppress border-t when the split is collapsed: the strip's border-b
        // already provides the separator; two adjacent 1px lines look doubled.
        "flex h-[var(--bottom-bar-h)] shrink-0 items-center gap-1.5 px-3 text-[12.5px]",
        !(splitOpen && splitCollapsed) && "border-t",
        sandboxWarning
          ? "border-[var(--color-warn)]/40 bg-[var(--color-warn)] text-[var(--color-fg)]"
          : "border-[var(--color-border-soft)] bg-[var(--color-bg-1)] text-[var(--color-fg-dim)]",
      )}
    >
      {/* Queue + Terminal sit on the LEFT (only while the split/aux terminal
          is closed — when open the queue moves into that strip, see
          TaskView). The sandbox status is pushed to the RIGHT. */}
      {!splitOpen && <MessageQueueButton taskId={task.id} />}
      {/* Pending inline review comments (#28). Self-hides when there are none,
          so it's safe to render unconditionally — keeps the "N comments · Send"
          affordance reachable from any tab regardless of split state. */}
      <ReviewCommentsBar taskId={task.id} />
      {/* +Terminal opens the bottom split. Hidden when the split is already
          open — no point offering to add what's there. */}
      {!splitOpen && (
        <button
          type="button"
          onClick={() => toggleSplit(task.id)}
          title="Open a bottom terminal split"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12.5px] text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
        >
          <TerminalSquare className="h-3.5 w-3.5" />
          <span>Terminal</span>
        </button>
      )}
      {/* Right group: the blocked-hosts chip on the LEFT, the sandbox status
          as the rightmost item. Click the chip to see WHICH hosts got
          blocked; it's a sibling of the edit button so its click doesn't
          bubble to "open Edit dialog." Chip only shows when sandboxed + we've
          actually seen denies. */}
      <div className="ml-auto flex items-center gap-1.5">
        {mode !== "off" && total > 0 && (
          <DeniedHostsPopover taskId={task.id} cli={task.cli ?? "claude"} count={total} mode={mode} />
        )}
        <button
          type="button"
          onClick={() => useUI.getState().openSandbox(task.id)}
          title={sandboxWarning ?? (task.sandbox_enabled ? "Edit sandbox" : "Enable sandbox")}
          className="flex items-center gap-1.5 truncate hover:text-[var(--color-fg)]"
        >
          {sandboxNode}
        </button>
      </div>
    </div>
  );
}

// Popover showing per-host + per-path deny breakdown. Click the
// "N blocked" chip in the footer → list of what the cage refused,
// sorted most-recently-seen first. Each row has an "Allow" button
// that adds the host to the task's allowed list + respawns the
// agent under the new profile. Polls every 1.5s while open.
function DeniedHostsPopover({ taskId, cli, count, mode }: { taskId: string; cli: string; count: number; mode: SandboxMode }) {
  const monitor = mode === "monitor";
  // ENFORCING (FS): the network sandbox is OFF, so there are no blocked
  // hosts to ever show. Drop every network surface from this popover —
  // we never fetch hosts, never render the hosts section, and the copy
  // talks about paths only (no "+ domains").
  const fsOnly = mode === "enforce-fs";
  // Scope for the Allow buttons — persisted app-wide, mandatory on first
  // use (radio starts unchosen). See prefs.allowScope.
  const allowScope = usePrefs(s => s.allowScope);
  const setAllowScope = usePrefs(s => s.setAllowScope);
  const scopeChosen = allowScope !== null;
  // Once a scope is set, the 3-row radio collapses to a single row to save
  // space; click it to expand and change. Until one is chosen it stays open
  // (the choice is mandatory before any Allow button works).
  const [scopeEditing, setScopeEditing] = useState(false);
  const scopeExpanded = !scopeChosen || scopeEditing;
  // Task dirs to optionally hide from the activity log — the agent
  // touches them constantly and they're always allowed anyway, so they're
  // pure noise. Default ON. Primitive selectors keep the snapshot stable.
  // .find() returns a stable reference (no snapshot churn) unless the
  // task object is replaced; compute the dir list from it directly.
  const taskObj = useApp(s => s.tasks.find(w => w.id === taskId));
  const taskDirs = taskObj ? [taskObj.path, ...(taskObj.composition ?? []).map(m => m.path)].filter(Boolean) : [];
  const [excludeTask, setExcludeTask] = useState(true);
  // "Only would-block" collapses the log to just the actionable rows
  // (everything the cage WOULD deny) — the set you actually need to
  // allow-list. Default ON: that's the point of monitoring. Uncheck to
  // see the full access log.
  const [wbOnly, setWbOnly] = useState(true);
  // Push the filters to the backend so they gate RECORDING (not just
  // display): excluded/non-would-block accesses are never stored, saving
  // CPU + memory. Fires on mount + whenever a checkbox flips.
  useEffect(() => {
    if (!monitor) return;
    ipc.sandboxSetMonitorFilters(taskId, excludeTask, wbOnly).catch(() => {});
  }, [monitor, taskId, excludeTask, wbOnly]);
  const SCOPES: { id: "agent" | "project" | "repo"; label: string; hint: string }[] = [
    { id: "agent",   label: "Per agent",        hint: `Every task that runs ${cli}, in any project.` },
    { id: "project", label: "Per project (me)", hint: "Only this project, only on your machine." },
    { id: "repo",    label: ".termic.yaml",     hint: "Committed to the repo, shared with your team." },
  ];
  const scopeLabel = (s: "agent" | "project" | "repo") =>
    s === "agent" ? `${cli} (agent)` : s === "repo" ? ".termic.yaml" : "this project";
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"aggregate" | "detailed">("aggregate");
  // ENFORCING data (blocked-only).
  const [hosts, setHosts] = useState<ipc.DenyHost[]>([]);
  const [paths, setPaths] = useState<ipc.DenyPath[]>([]);
  // MONITORING data (every access, with would_block flag).
  const [accHosts, setAccHosts] = useState<ipc.AccessHost[]>([]);
  const [accPaths, setAccPaths] = useState<ipc.AccessPath[]>([]);
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
      if (monitor) {
        Promise.all([
          ipc.sandboxRecentAccessHosts(taskId).catch(() => [] as ipc.AccessHost[]),
          ipc.sandboxRecentAccessPaths(taskId).catch(() => [] as ipc.AccessPath[]),
        ]).then(([h, p]) => {
          if (cancelled) return;
          setAccHosts(h); setAccPaths(p);
        });
      } else if (fsOnly) {
        // Filesystem-only enforce: no network sandbox, so only ever
        // fetch path denies. Hosts stay empty → no network section.
        ipc.sandboxRecentDeniedPaths(taskId).catch(() => [] as ipc.DenyPath[])
          .then(p => { if (!cancelled) { setHosts([]); setPaths(p); } });
      } else {
        Promise.all([
          ipc.sandboxRecentDeniedHosts(taskId).catch(() => [] as ipc.DenyHost[]),
          ipc.sandboxRecentDeniedPaths(taskId).catch(() => [] as ipc.DenyPath[]),
        ]).then(([h, p]) => {
          if (cancelled) return;
          setHosts(h); setPaths(p);
        });
      }
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, taskId, monitor, fsOnly]);

  async function allow(host: string) {
    if (!allowScope) return; // radio is mandatory; buttons disabled until chosen
    setAllowing(host);
    try {
      // Persist only — none of these kill the live PTY. The new entry is
      // additive, so the running agent's (narrower) profile stays safe;
      // it takes effect on the next spawn.
      if (allowScope === "agent")      await ipc.agentSandboxAddAllowedHost(cli, host);
      else if (allowScope === "repo")  await ipc.repoConfigAddAllowedHost(taskId, host);
      else                             await ipc.taskSandboxAddAllowedHost(taskId, host);
      setAllowed(prev => new Set(prev).add(host));
      useUI.getState().pushToast(
        `Allowed ${host} for ${scopeLabel(allowScope)}. Restart the agent for it to take effect.`,
        "success",
      );
    } catch (e) {
      useUI.getState().pushToast(`Couldn't allow ${host}: ${e}`, "error");
    } finally { setAllowing(null); }
  }
  async function allowPath(path: string) {
    if (!allowScope) return;
    setAllowing(path);
    try {
      if (allowScope === "agent")      await ipc.agentSandboxAddAllowedPath(cli, path);
      else if (allowScope === "repo")  await ipc.repoConfigAddAllowedPath(taskId, path);
      else                             await ipc.taskSandboxAddAllowedPath(taskId, path);
      setAllowed(prev => new Set(prev).add(path));
      const display = path.startsWith("$HOME") ? path : path.replace(/^.*\/Users\/[^/]+/, "$HOME");
      // Undo is only wired for the per-project (task) scope — that's
      // the one with a remove command. Agent/repo edits are removed in
      // their own surfaces (Settings → Agents / the .termic.yaml file).
      const undoable = allowScope === "project";
      useUI.getState().pushToast(
        `Allowed ${display} for ${scopeLabel(allowScope)}. Restart the agent to apply.`,
        "success",
        {
          ttlMs: 6000,
          action: undoable ? {
            label: "Undo",
            onClick: async () => {
              try {
                await ipc.taskSandboxRemoveAllowedPath(taskId, path);
                setAllowed(prev => { const n = new Set(prev); n.delete(path); return n; });
                useUI.getState().pushToast(`Removed ${display} from allow-list`, "info");
              } catch (e) {
                useUI.getState().pushToast(`Undo failed: ${e}`, "error");
              }
            },
          } : undefined,
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
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="ml-2 shrink-0 rounded px-1.5 py-0.5 text-[var(--color-warn)] hover:bg-[var(--color-warn)]/10"
          title={monitor
            ? `${count} access${count === 1 ? "" : "es"} logged (files + network). Click for the detailed activity log.`
            : `${count} request${count === 1 ? "" : "s"} blocked by the sandbox. Click to see details.`}
        >
          {monitor ? `${count} access${count === 1 ? "" : "es"}` : `${count} blocked`}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        // Auto-grow to the widest path/host row (w-max). Floor so short
        // content isn't puny; ceiling at viewport-2rem so a deeply-nested
        // path never escapes the pane edges. Rows are whitespace-nowrap so
        // their natural width drives the size; truncation kicks in only at
        // the ceiling. Base chrome (border/bg/shadow/z) comes from the
        // shared PopoverContent; here we only override shape/size/density.
        className={cn(
          "w-max max-w-[calc(100vw-2rem)] overflow-auto rounded-md p-2 text-[12px]",
          monitor ? "min-w-[580px] max-h-[520px]" : "min-w-[440px] max-h-[400px]",
        )}
      >
          {/* Scope selector — where "Allow" writes. Mandatory on first
              use (no preselection); the choice becomes the app-wide
              default and is remembered. */}
          <div className={cn(
            "mb-2 rounded-md border px-2 py-1.5",
            scopeChosen ? "border-[var(--color-border-soft)]" : "border-[var(--color-warn)]/60",
          )}>
            {scopeExpanded ? (<>
              <div className={cn(
                "mb-1 flex items-center gap-1.5 text-[11px]",
                scopeChosen ? "text-[var(--color-fg-faint)]" : "font-medium text-[var(--color-warn)]",
              )}>
                <span>{scopeChosen
                  ? `Save allowed paths${fsOnly ? "" : " + domains"} to:`
                  : `Pick where to save allowed paths${fsOnly ? "" : " + domains"}:`}</span>
              </div>
              {/* Radio list — one per line with a short explanation.
                  Picking a scope collapses this back to the summary row. */}
              <div className="flex flex-col gap-0.5">
                {SCOPES.map(s => {
                  const active = allowScope === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => { setAllowScope(s.id); setScopeEditing(false); }}
                      className={cn(
                        "flex items-center gap-2 rounded px-1.5 py-1 text-left transition-colors",
                        active ? "bg-[var(--color-accent)]/10" : "hover:bg-[var(--color-hover)]",
                      )}
                    >
                      <span className={cn(
                        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                        active ? "border-[var(--color-accent)]" : "border-[var(--color-border)]",
                      )}>
                        {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />}
                      </span>
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className={cn("shrink-0 text-[12px] font-medium", active ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)]")}>{s.label}</span>
                        <span className="truncate text-[11px] text-[var(--color-fg-faint)]">{s.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>) : (
              /* Collapsed summary: one row with the chosen scope; click to change. */
              <button
                type="button"
                onClick={() => setScopeEditing(true)}
                className="flex w-full items-center gap-1.5 rounded text-left text-[11px] text-[var(--color-fg-faint)] transition-colors hover:text-[var(--color-fg-dim)]"
                title="Change where allowed paths and domains are saved"
              >
                <span>Saving to</span>
                <span className="font-medium text-[var(--color-fg-dim)]">{SCOPES.find(s => s.id === allowScope)?.label}</span>
                <span className="ml-auto inline-flex items-center gap-0.5 text-[var(--color-fg-faint)]">
                  Change
                  <ChevronDown className="h-3 w-3" />
                </span>
              </button>
            )}
          </div>
          {monitor && (
            <MonitorActivity
              hosts={accHosts} paths={accPaths}
              tab={tab} setTab={setTab}
              scopeChosen={scopeChosen}
              taskDirs={taskDirs} excludeTask={excludeTask} setExcludeTask={setExcludeTask}
              wbOnly={wbOnly} setWbOnly={setWbOnly}
              allowed={allowed} allowing={allowing}
              onAllowHost={allow} onAllowPath={allowPath}
              shortenPath={shortenPath}
            />
          )}
          {!monitor && (<>
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
                    <CopyButton value={h.host} title="Copy host" />
                    <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">
                      {h.count}× · {relTime(h.last_seen_unix_ms)}
                    </span>
                    <button
                      type="button"
                      onClick={() => allow(h.host)}
                      disabled={allowing === h.host || !scopeChosen}
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
                Click any path segment to allow that prefix. Hover to preview which part you'll allow: green = will be allowed, dimmed = trimmed off.
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
                      pending={allowing === p.path || !scopeChosen}
                      onAllow={(prefix) => allowPath(prefix)}
                    />
                    <CopyButton value={p.path} title="Copy full path" className="ml-auto" />
                    <span
                      className="shrink-0 text-[11px] text-[var(--color-fg-faint)]"
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
            Clicking adds the {fsOnly ? "path" : "path or host"} to this task's allow-list.
            <br />
            Takes effect on next agent restart. The running agent keeps its current (narrower) permissions.
          </div>
          </>)}
      </PopoverContent>
    </PopoverRoot>
  );
}

// ── MONITORING activity view ─────────────────────────────────────────
// Two tabs inside the same footer popover:
//   Aggregate — network hosts + filesystem grouped by FOLDER, each
//               folder expandable to its files; counts + op breakdown +
//               would-block rollup. Click any path segment to whitelist.
//   Detailed  — the raw log: every (path, op) and every host:port with
//               counts, process, mode, and would-block flag.
type MonOp = ipc.AccessPath;
type MonHost = ipc.AccessHost;

function opTone(op: string): string {
  if (op.includes("write") || op.includes("create") || op.includes("unlink")) return "var(--color-warn)";
  if (op.includes("ioctl") || op.includes("exec")) return "var(--color-accent)";
  return "var(--color-fg-faint)";
}
function OpBadge({ op }: { op: string }) {
  return (
    <span
      className="shrink-0 rounded px-1 py-[1px] font-mono text-[10px] text-[var(--color-fg-dim)]"
      style={{ borderLeft: `2px solid ${opTone(op)}`, background: "var(--color-bg-2)" }}
      title={op}
    >
      {op.replace(/^file-/, "")}
    </span>
  );
}
function WouldBlockTag({ on }: { on: boolean }) {
  if (on) return (
    <span className="shrink-0 rounded px-1 py-[1px] text-[10px] text-[var(--color-warn)]"
      style={{ background: "color-mix(in srgb, var(--color-warn) 15%, transparent)" }}
      title="ENFORCING mode would block this. Click the path/host to whitelist it.">would block</span>
  );
  return (
    <span className="shrink-0 rounded px-1 py-[1px] text-[10px] text-[var(--color-ok)]"
      style={{ background: "color-mix(in srgb, var(--color-ok) 12%, transparent)" }}
      title="Allowed under ENFORCING too.">ok</span>
  );
}

function MonitorActivity({
  hosts, paths, tab, setTab, scopeChosen, taskDirs, excludeTask, setExcludeTask, wbOnly, setWbOnly, allowed, allowing, onAllowHost, onAllowPath, shortenPath,
}: {
  hosts: MonHost[];
  paths: MonOp[];
  tab: "aggregate" | "detailed";
  setTab: (t: "aggregate" | "detailed") => void;
  scopeChosen: boolean;
  taskDirs: string[];
  excludeTask: boolean;
  setExcludeTask: (v: boolean) => void;
  wbOnly: boolean;
  setWbOnly: (v: boolean) => void;
  allowed: Set<string>;
  allowing: string | null;
  onAllowHost: (h: string) => void;
  onAllowPath: (p: string) => void;
  shortenPath: (p: string) => string;
}) {
  // Hide accesses inside the task (+ member) dirs when toggled — the
  // agent hammers them constantly and they're always allowed, so pure noise.
  const inTask = (p: string) => taskDirs.some(d => p === d || p.startsWith(d + "/"));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (f: string) => setExpanded(prev => {
    const n = new Set(prev); n.has(f) ? n.delete(f) : n.add(f); return n;
  });

  // "would block" rows are the actionable ones (need whitelisting before
  // Enforcing), so they sort to the TOP — then by most-recent.
  const byBlockPath = (a: MonOp, b: MonOp) =>
    Number(b.would_block) - Number(a.would_block) || b.last_seen_unix_ms - a.last_seen_unix_ms;
  const byBlockHost = (a: MonHost, b: MonHost) =>
    Number(b.would_block) - Number(a.would_block) || b.last_seen_unix_ms - a.last_seen_unix_ms;
  // Display filters mirror the backend recording filters (for instant
  // feedback before the next 1.5s poll catches up).
  const vHosts = hosts.filter(h => !allowed.has(h.host) && (!wbOnly || h.would_block)).sort(byBlockHost);
  const vPaths = paths.filter(p => !allowed.has(p.path)
    && !(excludeTask && inTask(p.path))
    && (!wbOnly || p.would_block));
  const hiddenTask = excludeTask ? paths.filter(p => !allowed.has(p.path) && inTask(p.path)).length : 0;

  const fileCount  = vPaths.reduce((s, p) => s + p.count, 0);
  const netCount   = vHosts.reduce((s, h) => s + h.count, 0);
  const wbFiles    = vPaths.filter(p => p.would_block).length;
  const wbHosts    = vHosts.filter(h => h.would_block).length;

  // Group filesystem rows by parent folder for the Aggregate tab.
  type Folder = { folder: string; entries: MonOp[]; count: number; wouldBlock: number; lastSeen: number; ops: Set<string> };
  const folders: Folder[] = (() => {
    const map = new Map<string, Folder>();
    for (const p of vPaths) {
      const idx = p.path.lastIndexOf("/");
      const folder = idx > 0 ? p.path.slice(0, idx) : "/";
      let g = map.get(folder);
      if (!g) { g = { folder, entries: [], count: 0, wouldBlock: 0, lastSeen: 0, ops: new Set() }; map.set(folder, g); }
      g.entries.push(p);
      g.count += p.count;
      if (p.would_block) g.wouldBlock += 1;
      g.lastSeen = Math.max(g.lastSeen, p.last_seen_unix_ms);
      g.ops.add(p.op.replace(/^file-/, ""));
    }
    // Folders with would-block entries float to the top, then by recency.
    return [...map.values()].sort((a, b) =>
      Number(b.wouldBlock > 0) - Number(a.wouldBlock > 0) || b.lastSeen - a.lastSeen);
  })();

  const fileName = (p: string) => { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; };

  return (
    <div className="flex flex-col">
      {/* Tab strip (Settings-style button group). */}
      <div className="mb-2 flex items-center gap-1">
        {(["aggregate", "detailed"] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-2 py-0.5 text-[11.5px] font-medium capitalize",
              tab === t
                ? "bg-[var(--color-bg-2)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]",
            )}
          >
            {t}
          </button>
        ))}
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]"
          title="Only record accesses the cage WOULD block (the rows you need to allow-list). Drops always-allowed noise (not stored).">
          <input type="checkbox" checked={wbOnly} onChange={e => setWbOnly(e.target.checked)} className="h-3 w-3 accent-[var(--color-warn)]" />
          <span>Only would-block</span>
        </label>
        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]"
          title="Don't record accesses inside this task's own dir (always allowed, pure noise).">
          <input type="checkbox" checked={excludeTask} onChange={e => setExcludeTask(e.target.checked)} className="h-3 w-3 accent-[var(--color-accent)]" />
          <span>Exclude task dir{hiddenTask > 0 ? ` (${hiddenTask})` : ""}</span>
        </label>
        <span className="text-[11px] text-[var(--color-fg-faint)]">
          {fileCount + netCount} access{fileCount + netCount === 1 ? "" : "es"}
          {(wbFiles + wbHosts) > 0 && (
            <span className="ml-1 text-[var(--color-warn)]">· {wbFiles + wbHosts} would block</span>
          )}
        </span>
      </div>

      {vHosts.length === 0 && vPaths.length === 0 && (
        <div className="px-1 py-2 text-[var(--color-fg-faint)]">Waiting for activity… the agent hasn't touched anything yet.</div>
      )}

      {/* ── NETWORK (same in both tabs) ── */}
      {vHosts.length > 0 && (
        <>
          <div className="mb-1 mt-0.5 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">
            <span>Network</span><span>{vHosts.length} host{vHosts.length === 1 ? "" : "s"}</span>
          </div>
          <ul className="mb-2 flex flex-col">
            {vHosts.map(h => (
              <li key={h.host} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-hover)]">
                <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[var(--color-fg)]" title={`${h.host}:${h.port}`}>{h.host}<span className="text-[var(--color-fg-faint)]">:{h.port}</span></span>
                <WouldBlockTag on={h.would_block} />
                <CopyButton value={h.host} title="Copy host" />
                <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{h.count}× · {relTime(h.last_seen_unix_ms)}</span>
                <button
                  type="button"
                  onClick={() => onAllowHost(h.host)}
                  disabled={allowing === h.host || !scopeChosen}
                  className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] hover:border-[var(--color-ok)]/40 hover:text-[var(--color-fg)] disabled:opacity-50"
                  title={`Add ${h.host} to allowed hosts.`}
                >{allowing === h.host ? "…" : "Allow"}</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── FILESYSTEM ── */}
      {vPaths.length > 0 && (
        <div className="mb-1 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">
          <span>Filesystem</span>
          <span>{tab === "aggregate" ? `${folders.length} folder${folders.length === 1 ? "" : "s"}` : `${vPaths.length} entr${vPaths.length === 1 ? "y" : "ies"}`}</span>
        </div>
      )}

      {/* AGGREGATE: folder rows, expandable. */}
      {tab === "aggregate" && folders.map(g => {
        const isOpen = expanded.has(g.folder);
        return (
          <div key={g.folder} className="rounded">
            <div className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-[var(--color-hover)]">
              <button type="button" onClick={() => toggle(g.folder)} className="shrink-0 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]" title={isOpen ? "Collapse" : "Expand"}>
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <span className="min-w-0 flex-1">
                <PathSegments display={shortenPath(g.folder)} pending={allowing === g.folder || !scopeChosen} onAllow={onAllowPath} />
              </span>
              {g.wouldBlock > 0 && <WouldBlockTag on />}
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-fg-faint)]" title="operation kinds in this folder">{[...g.ops].join(" ")}</span>
              <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{g.entries.length} file{g.entries.length === 1 ? "" : "s"} · {g.count}×</span>
            </div>
            {isOpen && (
              <ul className="ml-5 flex flex-col border-l border-[var(--color-border-soft)] pl-2">
                {[...g.entries].sort(byBlockPath).map(p => (
                  <li key={p.path + p.op} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-[var(--color-hover)]">
                    <OpBadge op={p.op} />
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-[12px] text-[var(--color-fg)]" title={p.path}>{fileName(p.path)}</span>
                    {p.would_block && <WouldBlockTag on />}
                    <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]">{p.count}×</span>
                    <button
                      type="button"
                      onClick={() => onAllowPath(p.path)}
                      disabled={allowing === p.path || !scopeChosen}
                      className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-dim)] hover:border-[var(--color-ok)]/40 hover:text-[var(--color-fg)] disabled:opacity-50"
                      title={`Allow ${p.path}`}
                    >{allowing === p.path ? "…" : "Allow"}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {/* DETAILED: the raw access log (capped for perf). */}
      {tab === "detailed" && (() => {
        const CAP = 400;
        const rows = [...vPaths].sort(byBlockPath);
        const shown = rows.slice(0, CAP);
        return (
          <>
            <ul className="flex flex-col">
              {shown.map(p => (
                <li key={p.path + p.op} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-hover)]">
                  <OpBadge op={p.op} />
                  <span className="min-w-0 flex-1">
                    <PathSegments display={shortenPath(p.path)} pending={allowing === p.path || !scopeChosen} onAllow={onAllowPath} />
                  </span>
                  {p.would_block && <WouldBlockTag on />}
                  <CopyButton value={p.path} title="Copy full path" />
                  <span className="shrink-0 text-[11px] text-[var(--color-fg-faint)]" title={p.last_proc ? `${p.last_proc}(${p.last_pid})` : undefined}>
                    {p.last_proc && <span className="mr-2 font-mono text-[var(--color-fg-dim)]">{p.last_proc}({p.last_pid})</span>}
                    {p.count}× · {relTime(p.last_seen_unix_ms)}
                  </span>
                </li>
              ))}
            </ul>
            {rows.length > CAP && (
              <div className="px-1 py-1 text-[11px] text-[var(--color-fg-faint)]">
                Showing newest {CAP} of {rows.length} filesystem entries. Use Aggregate to see all, grouped by folder.
              </div>
            )}
          </>
        );
      })()}

      <div className="mt-2 px-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">
        Monitoring logs access; it does not block. Items tagged{" "}
        <span className="text-[var(--color-warn)]">would block</span> are the ones to whitelist
        (click the path/host or its Allow button) before switching to Enforcing.
      </div>
    </div>
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
function CopyButton({ value, title, className }: { value: string; title: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
      title={copied ? "Copied" : title}
      className={cn(
        "shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
        className,
      )}
    >
      {copied ? <Check size={12} className="text-[var(--color-ok)]" /> : <Copy size={12} />}
    </button>
  );
}

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
