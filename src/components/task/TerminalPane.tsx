// Single terminal tab: spawns a PTY on first mount, attaches xterm.js, owns
// the resize/refit dance and the attention/unread heuristics. Stays mounted
// across tab switches (parent toggles visibility) so we don't reconnect PTYs.

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, TerminalSquare, Copy, Check, ChevronUp, ChevronDown, ChevronRight, X, Loader2 } from "lucide-react";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { useUI } from "@/store/ui";
import { EMPTY_TABS, isUserWatching, useApp } from "@/store/app";
import { logWorkState } from "@/lib/workStateLog";
import { usePr } from "@/store/pr";
import {
  QUIET_MS, SAMPLE_MS, SCROLLBACK_STABLE_SAMPLES, SETTLE_SAMPLES,
} from "@/lib/settleTiming";
import { cn } from "@/lib/utils";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { attachCmdClickLinkOpener, registerPathLinkProvider, isAbsoluteToken, type ClickTarget } from "@/lib/termLinkOpener";
import { resolvePathClick, normalizePath, expandTilde, resolveAbsoluteClick, type TaskRoot } from "@/lib/pathMatch";
import { TerminalPathMenu, type ExternalTarget } from "@/components/task/TerminalPathMenu";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openWebUrl, browserCommandForTask } from "@/lib/previewBrowser";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Osc52Base64 } from "@/lib/osc52";
import { makeCtrlSniffer } from "@/lib/ctrlSniffer";
import { attachCopyOnSelect } from "@/lib/terminalSelection";
import { ImageAddon } from "@xterm/addon-image";
import { preserveImagesOnErase } from "@/lib/terminalImagePersistence";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { loadTerminalRenderer, awaitTerminalFonts } from "@/lib/terminalRenderer";
import { resyncViewportAfterReveal } from "@/lib/xtermViewportSync";
import { IS_MAC, bindingMatches, type ShortcutId } from "@/lib/shortcuts";
import { registerTerminalDropTarget } from "@/lib/terminalDrop";
import { HOOK_OSC_TITLE, HOOK_OSC_READY_BODY, hookOscSessionId } from "@/lib/agentHooks";
import { parseUsageBody } from "@/lib/agentUsage";
import { FooterAgentChip } from "./AgentChip";
import { activeFooterAgent, footerAgentIds, footerAgentKey } from "@/lib/footerAgents";
import { useAgentUsage } from "@/store/agentUsage";
import { imageFromClipboard, pastePathText } from "@/lib/clipboardImage";
import { setupImeReplacementBridge } from "@/lib/ime";
import { deliverMessage, sendMessageToPty } from "@/lib/agentSend";
import { failCliQueuedPrompts, reportCliPromptDelivery } from "@/lib/cliPromptReports";
import { waitForAgentReady } from "@/lib/agentReady";
import { hasDueScheduled, lateBy, pickQueueItem } from "@/lib/scheduledQueue";
import type { TerminalTab, Task, SandboxMode } from "@/lib/types";
import { effectiveSandboxMode, isTaskCaged } from "@/lib/types";
import { SandboxIcon, SANDBOX_VISUALS, DockerSandboxIcon } from "@/components/SandboxIcon";
import { TerminalExitedBanner } from "@/components/task/TerminalExitedBanner";
import * as ipc from "@/lib/ipc";
import { maybeRebuildDockerImageForLaunch } from "@/lib/dockerDailyRebuild";
import { loginShell, loginShellArgs } from "@/lib/loginShell";
import { usePrefs, useResolvedThemeFull, currentTerminalStack, currentTerminalTheme, currentColorFgBg, currentMinimumContrastRatio } from "@/store/prefs";
import { spawnArgsForCli, spawnCommandForCli, tryToggleYoloLive, envForCli, agentDisplayName, cliSupportsIdSession, cliSupportsCaptureResume, postLaunchCaptureForCli, decideResume, spawnResumeShape, resumeIdArgsForCli, workDoneCapable, terminalLaunchCommand, isTerminalCli, classifyAgentTitle, compileSignals, hasPendingWork, notificationWantsAttention, PENDING_TAIL_ROWS, STICKY_DONE_MS, ATTENTION_ECHO_MS, builtinBaseId, BUILTIN_OUTPUT_SIGNALS, resolveAgent } from "@/lib/agents";
import { recordTitle, noteSubmit, noteDone } from "@/lib/agentSignalLog";
import { MessageQueueButton } from "./MessageQueueButton";
import { ReviewCommentsBar } from "./ReviewCommentsBar";

interface Props { task: Task; tab: TerminalTab; active: boolean; }

// Settled-detection knobs live in lib/settleTiming.ts, which documents the
// 1 Hz floor a hidden webview clamps them to and is asserted on by
// settleTiming.test.ts. We sample the visible buffer every SAMPLE_MS and mark
// the tab "settled" once SETTLE_SAMPLES consecutive samples produce the same
// hash. Net stillness threshold = SETTLE_SAMPLES * SAMPLE_MS = 6 s. This only
// fires when the tab was ALREADY in "working" — so a 6 s gap in the middle of
// an agent turn would demote spuriously only if every sender signal also fell
// silent during that gap. Acceptable tradeoff vs. 12 s of stale spinner after
// a real finish.
// Seconds a finished "Run setup" tab lingers before auto-closing (counter in
// the "Setup finished." banner; click closes immediately).
const SETUP_AUTO_CLOSE_S = 5;

// How long after an interrupt keystroke the TITLE may end a turn. Wide enough
// for the agent to tear down and repaint (claude took 40-110ms, measured on
// both keys), narrow enough that a key which interrupted nothing cannot license
// a false done minutes later.
const ESC_INTERRUPT_WINDOW_MS = 3_000;
// The same licence for the terminal going QUIET, which needs a longer window
// because quiet is only observable after QUIET_MS of silence has accumulated.
// This is the only path that ends an interrupted turn for agy, which reports
// the interrupt through neither a hook nor a title. An agent that IGNORES the
// key (opencode ignores Escape outright) keeps painting, so quiet never
// arrives and the window closes with nothing done, which is the point.
const INTERRUPT_QUIET_GRACE_MS = 15_000;


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

/** The last `n` rows of the visible buffer, top to bottom, trailing whitespace
 *  trimmed.
 *
 *  Called only when something is trying to fire a done, never per frame. That
 *  is once per turn in the normal case, and once per 3s interval tick while a
 *  done is being deferred — bounded by `n` rows either way, so a deferral that
 *  lasts ten minutes costs ~200 row reads total. */
function visibleTailRows(t: Terminal, n: number): string[] {
  const buf = t.buffer.active;
  const top = buf.viewportY;
  // Anchor on the last row with CONTENT, not on the viewport's bottom edge.
  // A full-screen TUI draws all the way down, but a line-oriented agent that
  // hasn't scrolled yet leaves the bottom of the screen blank — anchoring on
  // the edge would then return n empty rows and match nothing, silently. (Found
  // by the e2e fixture, which is line-oriented; real claude fills the screen and
  // would have hidden it.)
  let last = top + t.rows - 1;
  while (last >= top && !buf.getLine(last)?.translateToString(true).trim()) last--;
  if (last < top) return [];
  const out: string[] = [];
  for (let i = Math.max(top, last - n + 1); i <= last; i++) {
    const line = buf.getLine(i);
    if (line) out.push(line.translateToString(true));
  }
  return out;
}

/** Debug override for the absolute working-state ceiling, in ms. Read ONCE when
 *  the sampler starts, like the other debug flags (ptyDebug, debugWorkDone),
 *  so set it before the terminal mounts. Returns null when unset or
 *  unparseable, and clamps to >= 1000 ms so a typo can't turn every turn into
 *  an instant forced done. */
function ceilingOverrideMs(): number | null {
  try {
    const raw = localStorage.getItem("workDoneCeilingMs");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1000 ? n : null;
  } catch { return null; }
}

/** Decode a raw PTY chunk into a readable string for debug logs.
 *  Control characters get named tokens (<ESC>, <BEL>, etc.); printable
 *  text (including UTF-8) passes through verbatim. Truncates at `max`
 *  bytes (500 by default; the raw recorder below passes a much larger
 *  bound because a full TUI repaint sliced at 500 B loses exactly the
 *  trailing escape sequence you were trying to find). */
function decodeForDebug(u8: Uint8Array, max = 500): string {
  const excess = u8.length > max;
  const buf = excess ? u8.slice(0, max) : u8;
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
  if (excess) out += `...(+${u8.length - max}B)`;
  return out;
}

/** Strip ANSI/OSC escape sequences from a stdout line before matching it
 *  against output-signal patterns (issue #68 Tier 3). Covers OSC (BEL- or
 *  ST-terminated), CSI/charset, and lone Fe escapes — enough to clean a
 *  status line without a full VT parser. */
const ANSI_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[[(][0-9;?]*[a-zA-Z]|\x1b[@-_]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
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
  const [pathMenu, setPathMenu] = useState<
    { x: number; y: number; candidates: string[]; line?: number; col?: number; external?: ExternalTarget } | null
  >(null);
  const openPathFile = useCallback((path: string, line?: number, col?: number) => {
    useApp.getState().openPreviewTab(task.id, {
      type: "edit",
      path,
      title: path.split("/").pop() || path,
      revealAt: line ? { line, col } : undefined,
    });
  }, [task.id]);
  const unlistenDataRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  const ptyRef = useRef<string | null>(null);
  // The account the CURRENT process was spawned with (GH #278). A ref rather
  // than state: it is read on the OSC path, which runs on every turn, and it
  // never needs to paint anything by itself.
  const spawnAccountRef = useRef<string | null>(null);
  // Settled-detection state: hash of the last sampled viewport + count of
  // consecutive identical samples + whether we've already marked this cycle
  // (so we mark once per "agent goes from working → settled" transition).
  const settledRef = useRef({ lastHash: 0, unchangedCount: 0, marked: false });
  // Wall-clock of last PTY byte we received. Used by the
  // byte-based idle fallback: if `workState === "working"` and this
  // timestamp is older than QUIET_MS, force `done`. More robust than
  // content-hash for TUIs that repaint status bars during/after work.
  const lastDataAtRef = useRef(0);
  // Last time we wrote lastOutputAt into the store. The data handler
  // coalesces that write to one per 500 ms: a streaming agent delivers up
  // to ~125 chunks/s, and patching the tabs array per chunk re-rendered
  // every tabs subscriber (TabBar, sidebar rows) at chunk rate — per
  // terminal. Nothing in-app reads lastOutputAt at finer granularity
  // (settled detection uses lastDataAtRef above); the write is kept, not
  // deleted, because the automation bridge / e2e flows assert PTY
  // liveness through it (.claude/skills/e2e). A trailing-edge timer
  // (below) stamps the final value once the burst ends, so the store
  // never understates the real last-output time by the window width.
  const lastOutputPatchRef = useRef(0);
  // Whether firstOutputAt has been stamped for the CURRENT PTY, so the
  // data handler patches it once rather than per chunk.
  const firstOutputPatchedRef = useRef(false);
  const lastOutputTrailerRef = useRef<number | null>(null);
  // Scrollback line count over time. Real work GROWS the scrollback
  // (agent prints lines that scroll off). Status-bar ticks ("Cooking
  // for 5s"), cursor blinks, and in-place repaints do NOT — they
  // rewrite the same row(s) without scrolling. ONLY VALID FOR NORMAL
  // BUFFER (Claude Code prints linearly). Alt-screen TUIs (Codex)
  // keep a fixed-length buffer; for those we fall through to the
  // hard-ceiling check.
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
  // Read inside the spawn effect, which must NOT re-run when this flips.
  const hooksOwnStateRef = useRef(false);
  /** Has a hook for THIS pty actually reached us? Installed is not the same as
   *  working, and conflating them hangs the UI.
   *
   *  Measured: a Docker-sandboxed tab has its hooks installed in the container's
   *  config dir and fires them correctly, and not one OSC arrives, because the
   *  hook writes to `$TERMIC_PTY` and that is a host device path the container
   *  cannot see. With the heuristics stood down on the strength of "installed",
   *  the tab sat on `working` from 07:47:35 onwards and nothing could ever end
   *  it. Its neighbours on the same agent, unsandboxed, cycled fine.
   *
   *  So hooks EARN the right to own the state, per pty, by delivering once. A
   *  working hook proves itself on the first submit, so the switchover costs a
   *  fraction of one turn; a transport that cannot deliver leaves the fallbacks
   *  armed, which is the behaviour that was there before hooks existed. */
  const hookSeenRef = useRef(false);
  // Whether this PTY's readiness has been stamped. One patch per PTY lifetime,
  // like firstOutputAt: `SessionStart` fires again on resume/compact, and a
  // later stamp would move a readiness that has already been acted on.
  const agentReadyPatchedRef = useRef(false);
  /** When the user last pressed Escape or Ctrl-C in this tab, and the only
   *  thing that licenses a heuristic to end a turn while hooks own the state.
   *
   *  Measured on a real turn, mid-generation, all four agents:
   *
   *    claude    ESC and Ctrl-C: NO hook of any kind. Title repaints its idle
   *              glyph 40-110ms later, and that is the whole signal.
   *    grok      both keys: `StopCancelled`, `reason: "user_interrupt"`.
   *    agy       both keys: nothing. The turn really is interrupted (its own
   *              UI prints "Interrupted") but no hook fires, and agy has no
   *              title signals either, so the PTY falling quiet is all we get.
   *    opencode  the FIRST Escape does nothing and it keeps streaming; the
   *              SECOND fires `session.error` then `session.idle` 30ms later.
   *              One Ctrl-C fires the same pair and then EXITS.
   *
   *  claude and agy therefore report nothing, which is why this ref exists at
   *  all. It is deliberately not enough on its own: something else (the title,
   *  or the terminal going quiet) has to corroborate it, so opencode's first
   *  Escape cannot end a turn that is still running. opencode's second one
   *  needs no help from this path, since `session.idle` is already Done. */
  const escAtRef = useRef(0);
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

  const patchTab = useApp(s => s.patchTab);
  const markAttention = useApp(s => s.markAttention);
  const setTabLiveTitle = useApp(s => s.setTabLiveTitle);
  const setWorkState = useApp(s => s.setWorkState);
  const setWorkProgress = useApp(s => s.setWorkProgress);
  // True when this tab's agent reports its own state. The title then keeps
  // driving `working` (harmless, and it is often first) but is no longer
  // allowed to END a turn, because that is the judgement it gets wrong: it
  // goes idle the moment the parent turn returns, while subagents and
  // background shells keep running. See docs/agent-hooks.md.
  const hooksOwnState = useApp(s => s.agentHooksInstalled[tab.cli] === true);
  // Mirrored into a ref so the spawn effect can read it without listing it
  // as a dependency and tearing down the PTY when it flips.
  hooksOwnStateRef.current = hooksOwnState;
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
  // A session uuid termic minted for THIS spawn, held back until the user
  // actually submits (issue #102). Persisting it at spawn time meant a
  // close+reopen before the first prompt resumed a session the agent had
  // never written to disk, and claude answers that with "No conversation
  // found". Cleared once persisted, and on every respawn.
  const pendingSessionUuidRef = useRef<string | null>(null);
  // Set when THIS spawn's agent reported the session it is in (GH #306). The
  // minted id is only held after the spawn survives RESUME_FAILURE_MS, so a
  // `/clear` inside that window would otherwise be overwritten by it.
  const sessionReportedRef = useRef(false);
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
  // When that token was spent. A busy signal arriving more than STICKY_DONE_MS
  // later means the done was premature, so goWorking hands the token back —
  // without that the turn's REAL completion is dropped as "already fired this
  // turn" and a long multi-stage turn ends in silence.
  const doneFiredAtRef = useRef(0);
  // Has the user ALREADY been interrupted about this turn finishing?
  //
  // Deliberately NOT `doneFiredSinceSubmitRef`, which is a state token and is
  // handed back twice on purpose: `goWorking` reopens it after
  // STICKY_DONE_MS so a premature done cannot swallow the turn's real
  // completion, and a hook done bypasses it outright so the agent's own
  // statement always ends the turn. Both are right for the spinner and both
  // silently restored the right to NOTIFY, which is how one turn came to cost
  // one banner per stage boundary (GH #276). Long agentic turns have many.
  //
  // So the latch is keyed on the ONE value every send path already stamps:
  // `lastInputAt`. Keyboard Enter, the message queue, a broadcast, `seedPrompt`,
  // `runPrompt`, `sendComments` and the CLI/deep-link path all patch it, so
  // "the turn moved on" needs no reset hook of its own and cannot be missed by
  // a path added later. Nothing the AGENT does touches it, which is the point:
  // a turn the user has been told about stays told about however many stages it
  // goes on to have.
  //
  // `-1` is the fresh-PTY value, chosen because no timestamp can equal it: a
  // respawn keeps the tab's old `lastInputAt`, so a plain reset-to-0 would have
  // matched a turn already announced and swallowed the first real completion
  // after a restart.
  const announcedForInputAtRef = useRef(-1);
  // When this tab last marked a needs-you that was NOT itself an echo. Bounds
  // the window in which a second attention mark is the same prompt being
  // reported twice rather than the agent asking again. See `goAttention`.
  const attnMarkedAtRef = useRef(0);
  // Newest OSC title seen on this tab. fireDone hands it to a signal capture as
  // the "resting" title. A ref, not state, so the spinner's ~10/s repaint can
  // never re-render the terminal.
  const lastTitleRef = useRef<string | null>(null);
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
  //
  // Returns false ONLY when the done was HELD BACK by the agent's own "still
  // working" status line. A caller that got `false` has not finished its job:
  // it must keep its retry path alive rather than latching a one-shot flag or
  // skipping the ceilings below it. Every other outcome (fired, acknowledged,
  // drained into the message queue, or already spent this turn) returns true —
  // the turn needs nothing further.
  // Persist the uuid this spawn minted, on the FIRST real submit (keyboard
  // Enter or a broadcast stamping lastInputAt). One-shot: the ref clears, so
  // later submits cost nothing. Before this, a fresh agent closed and reopened
  // without a single prompt came back with `--resume <uuid>` for a session the
  // CLI had never written, i.e. "No conversation found" (issue #102).
  const persistMintedSession = useCallback(() => {
    const uuid = pendingSessionUuidRef.current;
    if (!uuid) return;
    pendingSessionUuidRef.current = null;
    useApp.getState().setTabSessionId(task.id, tab.id, uuid);
  }, [task.id, tab.id]);

  /** The user stopped the agent. Clears the in-progress state and NOTHING
   *  else: an interrupt is not a completion, so there is no badge, no bell,
   *  and critically no spending of the one-done-per-submit token. Routing this
   *  through `fireDone` would burn that token and swallow the NEXT genuine
   *  done for the tab. */
  const interruptWork = useCallback((reason: string) => {
    debugLogRef.current?.("state→interrupted", reason);
    useApp.getState().setWorkState(task.id, tab.id, "idle", `interrupt: ${reason}`);
  }, [task.id, tab.id]);

  const fireDone = useCallback((reason: string, attn: "done" | "attention" = "done", seen = false, force = false, fromHook = false): boolean => {
    // Trust the hook. The one-done-per-submit token exists for HEURISTIC dones
    // (a settle timer, byte-quiet, a late OSC 9) where a repeat is noise and
    // the user has already been told. A hook done is the agent stating that
    // its turn ended, which outranks a guard built to second-guess a guess.
    //
    // Safe by measurement, not by hope: claude fires `Stop` several times in a
    // turn, and the installed script drops every one whose `background_tasks`
    // is non-empty, so at most one qualifying done per turn reaches us. The
    // notifier's own 8s debounce is the backstop if an agent ever disagrees.
    if (doneFiredSinceSubmitRef.current && !fromHook) {
      // The token stops one turn NOTIFYING twice: a trailing settle or a late
      // OSC 9 must not stack a second badge and bell on a turn the user was
      // already told about. It was never meant to stop the turn ENDING, and
      // returning here without touching workState is what pinned a tab to
      // "working" for 44 seconds with the agent idle at its prompt (captured:
      // a 133;D arrived, found the token spent, and did nothing at all).
      //
      // So: no badge, no bell, but the spinner still stops. Repeating a done
      // is harmless for the STATE and only ever harmful for the notification,
      // which is the half this guard keeps.
      const live = useApp.getState().tabs[task.id]
        ?.find(t => t.id === tab.id) as TerminalTab | undefined;
      if (live?.workState === "working") {
        debugLogRef.current?.("done-again", `state cleared, badge suppressed (${reason})`);
        useApp.getState().setWorkState(task.id, tab.id, "idle", `done again: ${reason}`);
      } else {
        debugLogRef.current?.("done-suppressed", `already fired this turn (${reason})`);
      }
      return true;
    }
    // The agent's UI still says it has work outstanding (backgrounded
    // subagents, running shells). Bail WITHOUT spending the one-done-per-submit
    // token and without touching workState: the tab stays "working" and the 3s
    // interval demoters keep re-testing, so the real done fires on the first
    // tick after the agent's own status line clears. That self-retry is why
    // this is a plain return rather than re-arming a timer — a deferral that
    // had to schedule its own retry would be a second timer racing the first.
    // It only holds because the callers honor the `false` below; when they
    // didn't, a held done starved both ceilings and pinned the tab to
    // "working" until the user focused it by hand.
    //
    // `force` is the 10-minute absolute ceiling, which must outrank this: a
    // status line that somehow never clears would otherwise pin the tab to
    // "working" forever.
    const term = termRef.current;
    if (!force && term && hasPendingWork(tab.cli, visibleTailRows(term, PENDING_TAIL_ROWS))) {
      debugLogRef.current?.("done-deferred", `agent reports pending work (${reason})`);
      return false;
    }
    doneFiredSinceSubmitRef.current = true;
    doneFiredAtRef.current = Date.now();
    // If a message queue is draining, send the next message now and suppress
    // this turn's badge/bell — the user is running an automated loop and
    // doesn't want a notification between every iteration. Runs before the
    // focus-gating below so a loop the user is watching keeps advancing.
    if (sendNextQueuedRef.current?.()) return true;
    const app = useApp.getState();
    // Shared predicate: also false while windowless, where there is no window
    // to have seen anything. Without that this returns early, sets "idle", and
    // never reaches markAttention - so a task left active when the window
    // closed would finish with no badge and no notification.
    const isActive = isUserWatching(task.id, tab.id);
    if (seen || isActive) {
      // Acknowledged: clear to idle, no badge, no bell.
      debugLogRef.current?.("done-seen", reason);
      // The user was looking, so the done is acknowledged rather than badged.
      // Named in the trace because it is indistinguishable from "no done ever
      // fired" once it has happened, and the two have opposite causes.
      app.setWorkState(task.id, tab.id, "idle", `done-while-watching: ${reason}`);
      return true;
    }
    debugLogRef.current?.("state→done", reason);
    app.setWorkState(task.id, tab.id, "done");
    // The dot is marked either way; `repeat` decides whether it also
    // interrupts. See the ref's comment and lib/attentionNotify.ts (GH #276).
    const turnKey = (useApp.getState().tabs[task.id]
      ?.find(t => t.id === tab.id) as TerminalTab | undefined)?.lastInputAt ?? 0;
    const repeat = attn === "done" && announcedForInputAtRef.current === turnKey;
    if (repeat) {
      debugLogRef.current?.("done-repeat", `badge only, already announced (${reason})`);
      logWorkState("done-repeat",
        `cli=${tab.cli} task=${JSON.stringify(task.name)} why=${reason}`
        + ` turn=${turnKey} badge marked, banner suppressed (already announced this turn)`);
    } else if (attn === "done") {
      announcedForInputAtRef.current = turnKey;
    }
    app.markAttention(task.id, tab.id, attn, undefined, repeat);
    // End of a turn: the title standing right now is the idle candidate for a
    // signal capture. No-op unless one is recording for this agent.
    noteDone(tab.cli, lastTitleRef.current);
    return true;
  }, [task.id, tab.id, tab.cli]);

  // Throttle state for the message queue: the wall-clock of the last send and
  // a handle to a pending deferred send. Enforces prefs.queueMinIntervalMs so
  // a fast loop (or false-"done" oscillation) can't fire prompts at the agent
  // faster than the user-configured floor.
  const lastQueueSendAtRef = useRef(0);
  const queueThrottleTimerRef = useRef<number | null>(null);
  // The scheduled item (GH #300) whose readiness wait + delivery is under way,
  // so a second kick during the wait does not type it twice.
  const scheduledInFlightRef = useRef<string | null>(null);

  // Deliver one scheduled item. Unlike an ordinary queue send, this can be
  // the first thing typed into a chat that was resumed seconds ago (the whole
  // point: "send it when I open the chat"), and a resumed TUI is not ready at
  // its first idle. So it waits for readiness the way seedPromptWhenReady
  // does, and every way it can fail KEEPS the item: the next idle, or the
  // minute ticker, tries again. Removed only once the write has landed.
  const deliverScheduled = useCallback(async (ptyId: string, itemId: string, force: boolean) => {
    const getTab = () => useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
    const keep = (why: string) => {
      scheduledInFlightRef.current = null;
      debugLogRef.current?.("scheduled-kept", why);
      logWorkState("scheduled-kept", `cli=${tab.cli} ${why}`);
    };
    try {
      const hooksOwnReadiness = useApp.getState().agentHooksInstalled[tab.cli] === true;
      const outcome = force ? "ready" : await waitForAgentReady(getTab, { hooksOwnReadiness });
      if (outcome === "lost" || outcome === "blocked") return keep(`agent not ready (${outcome})`);
      const now = getTab();
      if (!now?.ptyId || now.ptyId !== ptyId) return keep("pty changed during the wait");
      // The user started a turn while we waited: its done drains us after.
      if (!force && now.workState === "working") return keep("agent went busy during the wait");
      const item = now.queue?.find(q => q.id === itemId);
      if (!item) return keep("item removed during the wait");
      try {
        await deliverMessage(ptyId, item.text, { verifyEcho: outcome !== "ready" });
      } catch (e) {
        return keep(String((e as Error)?.message ?? e));
      }
      const sentAt = Date.now();
      lastQueueSendAtRef.current = sentAt;
      const after = getTab();
      patchTab(task.id, tab.id, {
        lastInputAt: sentAt,
        queue: (after?.queue ?? []).filter(q => q.id !== itemId),
      });
      useApp.getState().syncScheduledMessages(task.id, tab.id);
      scheduledInFlightRef.current = null;
      debugLogRef.current?.("scheduled-send", `"${item.text.slice(0, 40)}"`);
      const late = item.notBefore != null ? lateBy(item.notBefore, sentAt) : null;
      if (late) useUI.getState().pushToast(`Scheduled message sent (due ${late} ago)`, "info");
    } catch (e) {
      keep(String(e));
    }
  }, [task.id, tab.id, tab.cli, patchTab]);

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
    if (!cur || cur.type !== "terminal") return false;
    const q = cur.queue ?? [];
    // A scheduled item (GH #300) is eligible once due whether or not the
    // queue is active; a future one is skipped so ordinary items still drain.
    const idx = pickQueueItem(q, { queueActive: !!cur.queueActive, now: Date.now(), force });
    if (idx < 0) {
      if (!cur.queueActive) return false;
      // No ordinary item is left, so the loop is over. Future scheduled
      // items do not keep it running (they never needed it), but they do
      // mean the queue is not "finished", so no toast while any remain.
      patchTab(task.id, tab.id, { queueActive: false });
      if (!q.length) useUI.getState().pushToast("Message queue finished");
      return false;
    }
    const head = q[idx];
    if (head.notBefore != null) {
      if (scheduledInFlightRef.current) return true;
      scheduledInFlightRef.current = head.id;
      // fireDone returns on `true` without ending the turn, trusting the send
      // to start the next one. This send is async and may be KEPT (agent not
      // ready), so end the turn here: a tab left "working" is skipped by both
      // the kick effect and the ticker, and the item would never retry.
      if (cur.workState === "working") {
        useApp.getState().setWorkState(task.id, tab.id, "idle", "scheduled send pending");
      }
      void deliverScheduled(ptyId, head.id, force);
      return true;
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
    if (head.promptId) {
      // CLI-queued prompt (`termic send` to a busy agent): the server's
      // --wait blocks on this report, so the delivery is tracked, not
      // fire-and-forget. Reported once; the retained repeat (below)
      // drops the id. Same rules as the direct-send path (cliRpc.ts):
      // clear stale done/attention FIRST so the server's own-prompt
      // settle logic can't trust a "done" that predates this prompt,
      // and delivered means the SAME live PTY after both writes
      // (pty_write silently no-ops on a dead id).
      const pid = head.promptId;
      patchTab(task.id, tab.id, { workState: "idle", unread: null });
      deliverMessage(ptyId, head.text)
        .then(async () => {
          const now = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id);
          const samePty = now?.type === "terminal" && now.ptyId === ptyId;
          const alive = samePty && (await ipc.ptyAlive(ptyId).catch(() => false));
          return reportCliPromptDelivery(
            pid,
            !!alive,
            alive ? undefined : "the agent PTY exited while the queued prompt was being typed",
          );
        })
        .catch(e => reportCliPromptDelivery(pid, false, String((e as Error)?.message ?? e)));
    } else {
      sendMessageToPty(ptyId, head.text);
    }
    lastQueueSendAtRef.current = Date.now();
    patchTab(task.id, tab.id, { lastInputAt: Date.now() });
    // A queued prompt is user text reaching the agent, so it starts the task
    // exactly like an Enter does (src/lib/taskPhase.ts). Through `getState()`
    // rather than a subscription: the action is stable, and pulling it in as
    // a hook value would add it to this callback's deps.
    useApp.getState().markStarted(task.id);
    const remaining = head.remaining - 1;
    const nextQueue = remaining <= 0
      ? q.filter((_, i) => i !== idx)
      : q.map((item, i) => i === idx ? { ...head, remaining, promptId: undefined } : item);
    patchTab(task.id, tab.id, { queue: nextQueue });
    debugLogRef.current?.("queue-send", `"${head.text.slice(0, 40)}" remaining=${remaining} left=${nextQueue.length}`);
    return true;
  }, [task.id, tab.id, patchTab, deliverScheduled]);
  sendNextQueuedRef.current = sendNextQueued;

  // Programmatic Restart (the CLI's `send --resume` on an exited agent):
  // a respawnKick bump respawns exactly like the exited banner's button.
  // The ref guard skips the mount run so a kick left over from an
  // earlier session never double-spawns a freshly mounted pane. A kick
  // that lands while the PTY is (transiently) live is NOT consumed: the
  // store's ptyId is in the deps, so the real exit re-runs the effect
  // and honors the pending kick then. Consuming it early would silently
  // drop the respawn the CLI is waiting on.
  const respawnKick = tab.type === "terminal" ? tab.respawnKick : undefined;
  const tabPtyLive = tab.type === "terminal" ? !!tab.ptyId : false;
  const lastRespawnKickRef = useRef(respawnKick);
  useEffect(() => {
    if (respawnKick === lastRespawnKickRef.current) return;
    if (ptyRef.current) return; // live PTY: keep the kick pending
    lastRespawnKickRef.current = respawnKick;
    setExited(false);
    setGen(g => g + 1);
  }, [respawnKick, tabPtyLive]);

  // Kick the queue when a message is added (queueKick bumps) or it first
  // activates. Only send immediately if the agent isn't mid-turn; if it's
  // already working, the in-flight turn's eventual done advances the queue via
  // fireDone instead. Watching queueKick (not just the queueActive edge) means
  // adding a message to an idle agent with an already-active queue still fires.
  const queueActive = tab.type === "terminal" ? tab.queueActive : undefined;
  const queueKick = tab.type === "terminal" ? tab.queueKick : undefined;
  //
  // A due scheduled item (GH #300) wakes it too, without an active queue.
  // `tabPtyLive` is in the deps for exactly that: reopening a chat whose item
  // came due while it was closed spawns the PTY, and the spawn is the kick.
  useEffect(() => {
    const cur = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
    if (!queueActive && !hasDueScheduled(cur?.queue, Date.now())) return;
    if (cur?.workState === "working") return;
    sendNextQueuedRef.current?.();
  }, [queueActive, queueKick, tabPtyLive, task.id, tab.id]);

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
    // brand-new process the user didn't queue them for. CLI-queued
    // prompts fail fast at the same moment: the paused queue only
    // drains again on a manual "Send now", so a pending `send --wait`
    // would otherwise sit on it forever (exit 9 now, honest).
    {
      const cur = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
      const queue = failCliQueuedPrompts(cur?.queue, "the agent restarted before the queued prompt delivered");
      if (cur?.queueActive || queue !== cur?.queue) {
        patchTab(task.id, tab.id, {
          queueActive: false,
          ...(queue !== cur?.queue ? { queue } : {}),
        });
      }
    }

    // Shared link opener (WebLinksAddon, OSC 8 linkHandler, capture-phase
    // opener below). Routes through the opener plugin so the system browser
    // opens, not the WKWebView (window.open silently no-ops).
    const openLink = (via: string) => (uri: string) => {
      ipc.logLine(`[link] agent activate via=${via} uri=${uri}`).catch(() => {});
      // GH #245: a configured browser takes the argv path in Rust. With
      // NOTHING configured (the default) this falls through to the exact
      // plugin-opener call that shipped before the setting existed, so the
      // default carries none of the new path's risk. Link activation itself
      // (#14, #58, #117) is untouched — this is only the handoff to the OS.
      const browser = browserCommandForTask(task.id);
      if (browser) { void openWebUrl(uri, browser); return; }
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
      // Allow bypassing mouse reporting (e.g. in vim/tmux) for text selection
      // by holding the Option key, matching iTerm2/xterm.js convention.
      macOptionClickForcesSelection: true,
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
    const imagePersistence = /(?:^|\/)pi$/.test(spawnCommandForCli(tab.cli)) || (import.meta.env.VITE_E2E && tab.cli === "fakeagent")
      ? preserveImagesOnErase(term)
      : null;
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
    // Hover-underline for file-path references, mirroring the URL addon above.
    const disposePathLinks = registerPathLinkProvider(term, (path, line, col, event) => {
      if (event.metaKey || event.ctrlKey) handlePathTarget({ path, line, col }, event.clientX, event.clientY);
    });
    term.open(host);
    // GH #58: when the agent TUI enables xterm mouse reporting, the modified
    // click is consumed by the mouse pipeline before the addon's activation
    // runs — links "randomly" die inside agents. The capture-phase opener
    // sees the gesture first, resolves the URL from the buffer itself, and
    // swallows the click so nothing double-fires. Must attach AFTER
    // term.open (it reads .xterm-screen geometry).
    // GH #117: the same opener also resolves file-path references.
    // GH #240: an ABSOLUTE path says exactly where it lives, so it is resolved
    // against the task's roots rather than suffix-matched against its file
    // list. Landing outside every root is a real answer ("this file is not in
    // this task"), not a reason to go hunting for a same-named file — which is
    // how `~/notes/todo.md` used to open an unrelated `docs/notes/todo.md`.
    async function handleAbsoluteTarget(
      target: { path: string; line?: number; col?: number }, x: number, y: number,
    ) {
      const abs = expandTilde(target.path, await ipc.cachedHomeDir());
      // `task.path` and `task.composition` are frozen for a task's lifetime,
      // so capturing them in this long-lived effect cannot go stale.
      const roots: TaskRoot[] = [
        { path: task.path, prefix: "" },
        ...(task.composition ?? []).map(m => ({ path: m.path, prefix: m.dir_name })),
      ];
      const resolved = resolveAbsoluteClick(abs, roots);
      if (resolved.kind === "inside") {
        const stat = await ipc.taskPathStat(task.id, resolved.rel).catch(() => null);
        if (stat?.exists && !stat.is_dir) {
          openPathFile(resolved.rel, target.line, target.col);
          return;
        }
        // Inside the task but not a readable file (deleted since it was
        // printed, or a directory). Fall through to the OS actions below,
        // which can still reveal a directory.
      }
      if (!(await ipc.pathExists(abs).catch(() => false))) {
        useUI.getState().pushToast("That path no longer exists", "error");
        return;
      }
      // Is it text? Not answerable from the extension: `.ts` is TypeScript AND
      // MPEG transport stream, `.txt`/`LICENSE`/dotfiles carry no grammar at
      // all, and a 2 GB `.json` is still `.json`. The read itself already caps
      // size, requires UTF-8 and rejects anything that is not a regular file,
      // so its verdict IS the answer. Costs one extra read of a ≤2 MB file on
      // the click (EditorPane reads again on mount); worth it to decide
      // between an editor tab and the OS menu BEFORE showing either.
      const readable = await ipc.fileReadExternal(abs).then(() => true).catch(() => false);
      if (readable) {
        useApp.getState().openPreviewTab(task.id, {
          type: "external",
          path: abs,
          title: abs.split("/").pop() || abs,
          revealAt: target.line ? { line: target.line, col: target.col } : undefined,
        });
        return;
      }
      // Binary, oversized, or a directory: nothing the editor can show, so
      // hand it to the OS actions instead of an error state.
      setPathMenu({ x, y, candidates: [], external: { abs } });
    }
    function handlePathTarget(target: { path: string; line?: number; col?: number }, x: number, y: number) {
      if (isAbsoluteToken(target.path)) {
        void handleAbsoluteTarget(target, x, y);
        return;
      }
      ipc.taskListFilesForFinder(task.id)
        .then(async files => {
          let matches = resolvePathClick(files, target.path);
          if (matches.length === 1) {
            openPathFile(matches[0], target.line, target.col);
            return;
          }
          if (matches.length === 0) {
            // The finder list is git-tracked + untracked-not-ignored only, so a
            // gitignored path (build output, .env, node_modules/…) never has a
            // suffix match. Fall back to a direct on-disk check on the clicked
            // path and open it if it's a real file. (GH #117)
            const rel = normalizePath(target.path);
            const stat = await ipc.taskPathStat(task.id, rel).catch(() => null);
            if (stat?.exists && !stat.is_dir) {
              openPathFile(rel, target.line, target.col);
              return;
            }
            // Still nothing: same exact suffix match, but over the whole
            // working tree including gitignored files (an agent printing
            // "meeting/agenda.md" from an ignored scratch folder). Rust
            // filters and caps, so the big listing never crosses IPC.
            matches = await ipc.taskMatchIgnoredFiles(task.id, rel).catch(() => []);
            if (matches.length === 1) {
              openPathFile(matches[0], target.line, target.col);
              return;
            }
          }
          setPathMenu({ x, y, candidates: matches, line: target.line, col: target.col });
        })
        .catch(() => useUI.getState().pushToast("Couldn't list files to open that path", "error"));
    }
    const onActivate = (target: ClickTarget, x: number, y: number) => {
      if (target.kind === "url") openLink("capture")(target.uri);
      else handlePathTarget(target, x, y);
    };
    const disposeLinkOpener = attachCmdClickLinkOpener(term, host, onActivate);
    termRef.current = term;
    fitRef.current = fit;

    // WebKit's Korean path can compose through textarea input events without
    // compositionstart/end. The bridge forwards replacement deltas and the
    // initial insertText that xterm drops while an IME key is held. Real
    // composition sessions stay with xterm, including their final input.
    // See lib/ime.ts and the custom key guard below.
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
      // entries are always uncaged (see the spawn gating). A dropped path is
      // otherwise readable directly.
      //
      // `isTaskCaged`, not `isSandboxEnforced`: a DOCKER task cannot read
      // `~/Desktop/shot.png` either (nothing outside the mounts exists in
      // there), and it used to get the raw path inserted anyway - the file
      // looked present and every read failed. Only Seatbelt ENFORCING denies
      // reads (MONITORING just logs), and `isTaskCaged` already folds both
      // engines' answers together.
      sandboxed: () => isTaskCaged(task)
        && tab.cli !== "shell" && !isTerminalCli(tab.cli),
    });

    // Image paste, DOCKER TASKS ONLY.
    //
    // Everywhere else this must not fire at all. Outside a container the
    // agent reads the Mac clipboard ITSELF (claude shells out to `osascript
    // -e 'the clipboard as «class PNGf»'`) and gets the real bytes with no
    // help, so intercepting would be a downgrade: the user would get a file
    // path where they used to get an image. Inside a container it cannot:
    // the agent is a Linux process whose clipboard path shells out to
    // xclip / wl-paste, with no route to the Mac's pasteboard, so ⌘V with a
    // screenshot silently did nothing at all.
    //
    // What we send is the file's path, and it goes through `term.paste()`
    // rather than a raw `ptyWrite` - which is the difference between working
    // and not. Measured against claude's own TUI: typed, the path is echoed
    // as literal text; sent as a PASTE (xterm wraps it in the bracketed
    // paste markers `\x1b[200~`/`\x1b[201~` when the app has that mode on),
    // claude runs its pasted-image-path branch, READS the file and renders
    // `[Image #1]` - the same attachment a native paste produces. So the
    // agent ends up with the actual image, not a path to talk about.
    //
    // Capture phase, because xterm's own paste handler sits on the textarea
    // underneath and would otherwise consume the event first. Text pastes
    // fall straight through (`imageFromClipboard` returns null), so the
    // common path is untouched.
    const onPaste = (e: ClipboardEvent) => {
      // Live read, not the captured `task`: toggling Docker restarts the PTY
      // but does not necessarily re-run this effect, and a stale answer here
      // would either break a native paste or silently drop a caged one.
      const live = useApp.getState().tasks.find(t => t.id === task.id);
      if (!live?.docker_sandbox_enabled) return;
      const file = imageFromClipboard(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      file.arrayBuffer()
        .then(buf => ipc.clipboardImageSave(new Uint8Array(buf)))
        .then(path => {
          // Still Docker, and still a live PTY: this lands an IPC round trip
          // after the gesture, and either could have changed in between.
          const now = useApp.getState().tasks.find(t => t.id === task.id);
          if (!now?.docker_sandbox_enabled || !ptyRef.current) return;
          term.paste(pastePathText(path));
        })
        .catch(err => {
          // Silence here would read as "paste is broken": the image is gone
          // from the prompt either way, so say why.
          useUI.getState().pushToast(`Could not paste that image: ${String(err)}`, "error");
        });
    };
    host.addEventListener("paste", onPaste, true);

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
      // ctrl+V inside a DOCKER task: attach the clipboard image, the way the
      // agent would if it could reach the pasteboard.
      //
      // On macOS this is not a paste event at all - it is byte 0x16 going
      // down the PTY, and it is the gesture claude binds its own
      // "attach the clipboard image" action to. Inside a container that
      // action always fails ("no image in clipboard"): the agent is a Linux
      // process asking xclip about a pasteboard that is not there. So termic
      // reads the pasteboard natively (`clipboard_image_capture`, no webview
      // permission and no user gesture needed) and pastes the saved path,
      // which claude turns into a real `[Image #N]` attachment.
      //
      // Swallow FIRST, decide after: the handler has to answer synchronously
      // and the read is async. If there is no image, the original 0x16 is
      // forwarded verbatim, so a ctrl+V with text on the clipboard reaches
      // the agent exactly as it does today. Outside Docker this whole branch
      // is skipped and ctrl+V is never touched - there the agent reads the
      // Mac clipboard itself and gets the real image unaided.
      if (
        e.type === "keydown" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
        && (e.key === "v" || e.key === "V")
        && useApp.getState().tasks.find(t => t.id === task.id)?.docker_sandbox_enabled
      ) {
        e.preventDefault();
        e.stopPropagation();
        ipc.clipboardImageCapture()
          .then(path => { term.paste(pastePathText(path)); })
          .catch(() => {
            // No image on the clipboard (or the read failed): hand the agent
            // the keystroke it was going to get anyway and let it answer.
            const pid = ptyRef.current;
            if (pid) ipc.ptyWrite(pid, [0x16]).catch(() => {});
          });
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
    // Signal archaeology: `localStorage.ptyDebugRaw = "1"` turns the per-PTY
    // log into a lossless recording — chunks are logged whole instead of
    // sliced at 500 B, and EVERY control sequence is reported (see
    // makeCtrlSniffer), including the ones our own handlers consume. This is
    // how you answer "what does this agent emit when it puts a question on
    // screen, if anything". Implies ptyDebug. Off by default; the log holds
    // verbatim terminal output, so delete it when you're done with it.
    const ptyRawOn = (() => { try { return localStorage.getItem("ptyDebugRaw") === "1"; } catch { return false; } })();
    const ptyDebugOn = ptyRawOn || (() => { try { return localStorage.getItem("ptyDebug") === "1"; } catch { return false; } })();
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
    pendingSessionUuidRef.current = null;
    sessionReportedRef.current = false;
    submitWindowUntilRef.current = 0;
    submitAtRef.current = 0;
    preSubmitHashRef.current = 0;
    const ECHO_DEAD_MS = 300;
    // Reset the ref for this new PTY session. The lastInputAt-watching
    // effect and term.onData both set it to true once the user submits.
    submittedSinceSpawnRef.current = false;
    // Proof is per PTY, not per tab. A restart gets a fresh container, a fresh
    // env and possibly a different sandbox mode, so it has to demonstrate
    // delivery again rather than inherit a claim the previous process earned.
    hookSeenRef.current = false;
    agentReadyPatchedRef.current = false;
    // Reset sender classification so signal-silent agents (agy, custom CLIs)
    // get submit-window working detection on every respawn, not just the first.
    senderStateRef.current = null;
    captureArmedRef.current = false;
    // Fresh PTY → no done has fired yet for the (eventual) first submit.
    doneFiredSinceSubmitRef.current = false;
    // ...and nothing has been announced for it either. A respawn is a new turn
    // by definition, so the user is owed the first completion after it - which
    // is why this is -1 and not 0 (the tab keeps its old `lastInputAt`).
    announcedForInputAtRef.current = -1;
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
      const seenAtIdle = isUserWatching(task.id, tab.id);
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
      // The agent is working again well after we called this turn done, so the
      // done was premature (a stage boundary read as the end). Hand the turn's
      // done token back — otherwise the completion that actually ends the turn
      // is dropped as "already fired this turn" and nothing ever badges. The
      // window matches the store's sticky-done gate, so the token and the
      // spinner come back together instead of one without the other.
      if (doneFiredSinceSubmitRef.current
          && doneFiredAtRef.current > 0
          && Date.now() - doneFiredAtRef.current >= STICKY_DONE_MS) {
        wdlog(`done token reopened (${reason})`);
        dbg("done-reopened", reason);
        doneFiredSinceSubmitRef.current = false;
        doneFiredAtRef.current = 0;
      }
      if (!localBusy) {
        wdlog(`→ working (${reason})`);
        dbg("state→working", reason);
        localBusy = true;
        workingStartedAtRef.current = Date.now();
      } else if (workingStartedAtRef.current === 0) {
        // The absolute ceiling fired mid-turn and cleared the clock. It does
        // not go through here (it calls `fireDone` directly, so `localBusy` is
        // still true), which is why this is an `else`: without it the ceiling
        // latched and killed every later heartbeat about a second in.
        workingStartedAtRef.current = Date.now();
      }
      setWorkState(task.id, tab.id, "working", reason);
    };
    const goIdle = (reason: string, delay = SETTLE_MS, fromHook = false) => {
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
        fireDone(reason, "done", false, false, fromHook);
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
    /** The title corroborated an interrupt. Delegates to `interruptWork` so
     *  this and the quiet-corroborated path in the demoter tick cannot drift,
     *  and clears the licence so the two cannot both fire for one keystroke. */
    const goInterrupted = (reason: string) => {
      if (!workDoneEnabled) return;
      cancelSettle(reason);
      localBusy = false;
      escAtRef.current = 0;
      wdlog(`→ interrupted (${reason})`);
      interruptWork(reason);
    };

    const goAttention = (reason: string, message?: string) => {
      if (!workDoneEnabled) return;
      cancelSettle(reason);
      localBusy = false;
      // Mark workState=done so the visual indicator is consistent — the
      // agent has stopped. The orange "attention" badge is layered on top
      // via the unread channel.
      dbg("state→attention", reason);
      setWorkState(task.id, tab.id, "done", `attention: ${reason}`);
      // One needs-you, one banner, and the badge agrees with what the banner
      // said (GH #276).
      //
      // A single permission prompt marks attention TWICE, measured: termic's
      // hook fires the moment claude blocks, and claude's own OSC 9 arrives
      // 6.0s behind it. The second one was silent only by accident, because the
      // rising edge was already spent - if anything had cleared `unread` in
      // between, the user got two banners for one prompt. `repeat` makes it
      // deliberate.
      //
      // And the FIRST wording wins rather than the last. The hook names the
      // tool it is blocked on ("needs your permission: Bash", see
      // agent_hooks.rs); claude's own later body does not, so letting it
      // overwrite would leave the badge less specific than the banner the user
      // already read, and disagreeing with it.
      // Bounded in TIME, not by "an attention mark is already held", which was
      // the first attempt and had a hole: a permission prompt is answered with a
      // BARE KEY (`y`), and only `\r` clears the mark. So a state-only test
      // would treat the next genuine needs-you, minutes later, as a repeat of
      // one the user had already dealt with, and go silent on it.
      //
      // ATTENTION_ECHO_MS is the measured 6.0s gap plus room: inside it the two
      // marks are one prompt being reported twice, outside it the agent is
      // asking again and that is news. A re-ask INSIDE the window can only
      // happen with the user at the keyboard, where `isUserWatching` suppresses
      // the banner anyway.
      const held = (useApp.getState().tabs[task.id]
        ?.find(t => t.id === tab.id) as TerminalTab | undefined)?.unread;
      const already = held?.reason === "attention"
        && Date.now() - attnMarkedAtRef.current < ATTENTION_ECHO_MS;
      if (!already) attnMarkedAtRef.current = Date.now();
      markAttention(
        task.id, tab.id, "attention",
        (already && held?.message) ? held.message : message,
        already,
      );
      // The turn reached a terminal state (waiting on the user). Spend the
      // one-done-per-submit token so a trailing settle/OSC 9 can't stack a
      // blue done dot on top of the attention until the user responds.
      doneFiredSinceSubmitRef.current = true;
      doneFiredAtRef.current = Date.now();
    };

    // Tier 3 (issue #68): opt-in output-line matching. When the agent enables
    // `match_output`, precompile its signal patterns ONCE here and scan
    // complete stdout lines in the data sink. `outputSignals` null (the
    // default) means the sink does nothing, so there is zero cost when off.
    //
    // Null unless there is at least one pattern to test. Output matching runs
    // the USER's signals — it deliberately does not fall back to
    // BUILTIN_TITLE_SIGNALS, since claude's "^\s*✳" describes a title, not a
    // line of stdout. So with the pattern fields empty (every agent's default)
    // the switch has nothing to match, and without this guard the sink would
    // still decode, line-split and ANSI-strip every chunk on the hot data path
    // in order to test zero patterns. Settings disables the switch in that
    // state; this is the enforcement.
    // Resolved, so a CLONE gets its parent's signals and its parent's
    // `match_output` rather than falling out of this tier entirely.
    const agentsNow = useApp.getState().agents;
    const sigAgent = resolveAgent(agentsNow, tab.cli);
    const sigs = sigAgent?.capabilities?.signals;
    // Some agents ship OUTPUT patterns of their own, and those are not opt-in:
    // for agy this is the ONLY way needs-you can be reported at all. Measured
    // at a live permission prompt, it writes no title, no OSC and no bell, so
    // its hooks cover working and done and the screen is all that is left for
    // the third state. A user's own patterns still win per field.
    const builtinOut = BUILTIN_OUTPUT_SIGNALS[builtinBaseId(tab.cli, agentsNow)];
    const pick = (k: "attention" | "busy" | "idle") =>
      compileSignals(sigs?.[k]?.length ? sigs[k] : builtinOut?.[k]);
    const compiled = workDoneEnabled && (sigAgent?.capabilities?.match_output || builtinOut)
      ? { attention: pick("attention"), busy: pick("busy"), idle: pick("idle") }
      : null;
    const outputSignals =
      compiled && (compiled.attention.length || compiled.busy.length || compiled.idle.length)
        ? compiled
        : null;
    const scanDecoder = new TextDecoder("utf-8", { fatal: false });
    let scanLineBuf = "";
    const MAX_SCAN_LINE = 4096;
    // Break on CR as well as LF. The CLIs this tier exists for (status to
    // stdout, no title) are exactly the ones that repaint one status line
    // with a bare \r and never send a newline — splitting on \n alone, that
    // line would sit in the buffer until the length bound sliced it away and
    // no pattern would ever run against it.
    const SCAN_EOL = /\r\n|[\r\n]/;
    const scanOutputLines = (u8: Uint8Array) => {
      if (!outputSignals) return;
      scanLineBuf += scanDecoder.decode(u8, { stream: true });
      let m: RegExpMatchArray | null;
      while ((m = scanLineBuf.match(SCAN_EOL))) {
        let raw = scanLineBuf.slice(0, m.index);
        scanLineBuf = scanLineBuf.slice(m.index! + m[0].length);
        if (raw.length > MAX_SCAN_LINE) raw = raw.slice(0, MAX_SCAN_LINE);
        const line = stripAnsi(raw).trim();
        if (!line) continue;
        // Precedence attention > busy > idle, mirroring the title classifier.
        const state = outputSignals.attention.some(re => re.test(line)) ? "attention"
          : outputSignals.busy.some(re => re.test(line)) ? "busy"
          : outputSignals.idle.some(re => re.test(line)) ? "idle"
          : null;
        if (!state) continue;
        // Record it the same way the title handler does. This is what tells
        // the interval demoters below that a sender signal exists: without
        // it senderStateRef stays null forever for a title-less agent, so
        // byte-quiet fires at QUIET_MS through any silent think and reports
        // `attention` (its no-signal fallback) — the exact false bell this
        // tier is meant to replace with a real `done`.
        senderStateRef.current = state;
        // Same rule as the title above: while hooks own this agent's state,
        // a line of output must not re-arm `working` behind a hook that has
        // already ended the turn.
        const hooksOwnHere = hooksOwnStateRef.current && hookSeenRef.current;
        if (state === "attention") goAttention("output line");
        else if (state === "busy") {
          if (!hooksOwnHere && submittedSinceSpawnRef.current) goWorking("output line");
        } else if (!hooksOwnHere) goIdle("output line");
      }
      // Bound the buffer so an EOL-less stream can't grow without limit.
      if (scanLineBuf.length > MAX_SCAN_LINE * 4) scanLineBuf = scanLineBuf.slice(-MAX_SCAN_LINE);
    };

    // ── Agent-authored notifications (OSC 9 plain, OSC 777) ──
    //
    // The agent is asking for the user. Route it through the attention
    // channel and let useAttentionNotifier own the banner, carrying the
    // verbatim body as `unread.message`. This used to forward the body to the
    // OS here AND (elsewhere) mark unread, which is two banners for one event;
    // that is why the old code deliberately kept OSC 9 away from
    // markAttention, and why it therefore never produced a needs-you badge.
    //
    // Three things are checked before badging:
    //   - the body: claude sends "is waiting for your input" 60s after EVERY
    //     turn you don't immediately reply to, which is not news (see
    //     BUILTIN_NOTIFY_IGNORE).
    //   - back-to-work: you already answered and the agent moved on.
    //   - pending work: the agent's own UI says subagents are still running,
    //     so "needs you" would be as wrong as "done" (measured — a background
    //     wait emits a byte-identical notification to a real permission
    //     prompt, so the body alone cannot separate them).
    const notifyAttention = (reason: string, body: string, trusted = false) => {
      if (isRunTab || !workDoneEnabled) return;
      const text = body.trim();
      if (!text) return;
      // `trusted` = termic's own agent hook, not something the agent chose to
      // say. The body filter below exists to sort an agent's chatter from a
      // real needs-you, and a user's `attention` list is an ALLOW-LIST, so
      // teaching termic "my agent says X when it needs me" would otherwise
      // silence our own hook: it says something else, matches nothing, and the
      // whole feature dies with no error. Caught by the e2e fixture, which
      // seeds exactly such a list.
      if (!trusted && !notificationWantsAttention(tab.cli, text)) {
        logWorkState("notify-drop", `cli=${tab.cli} body=${JSON.stringify(text.slice(0, 160))}`);
        wdlog(`${reason} ignored (body not actionable): ${text}`);
        dbg("notify-ignored", text.slice(0, 120));
        return;
      }
      const live = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
      // Skipped for a trusted hook, and this is the case the whole feature
      // turns on. `goIdle` does NOT clear `workState`; it arms the settle and
      // leaves the tab reading "working" for the full SETTLE_MS. Claude paints
      // its idle title ~20ms BEFORE the hook fires, so a trusted notification
      // always lands inside that window and this guard would drop it every
      // single time. The agent's own hook saying "blocked on you" outranks a
      // store field that is about to be corrected anyway.
      if (!trusted && (localBusy || live?.workState === "working")) {
        wdlog(`${reason} ignored (agent already back at work): ${text}`);
        dbg("notify-ignored", `back to work: ${text.slice(0, 100)}`);
        return;
      }
      const term = termRef.current;
      if (!trusted && term && hasPendingWork(tab.cli, visibleTailRows(term, PENDING_TAIL_ROWS))) {
        wdlog(`${reason} ignored (agent reports pending work): ${text}`);
        dbg("notify-ignored", `pending work: ${text.slice(0, 100)}`);
        return;
      }
      logWorkState("notify-badge", `cli=${tab.cli} body=${JSON.stringify(text.slice(0, 160))}`);
      goAttention(reason, text);
    };

    // Title classification now lives in lib/agents (classifyAgentTitle):
    // registry-driven so custom agents can teach it their own signals (#68),
    // with the built-in claude/codex heuristics as the fallback.

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
      const state = classifyAgentTitle(tab.cli, t, useApp.getState().agents);
      // Retain it for Settings → Agents. Recorded BEFORE the branches below so
      // unmatched titles survive too: those are precisely the ones a user needs
      // to see to write a pattern for an agent that signals nothing yet.
      recordTitle(tab.cli, t, state);
      lastTitleRef.current = t;
      wdlog(`title change [classifier=${state ?? "unknown"}, last=${lastTitleState ?? "none"}]`, t);
      dbg("title", `classifier=${state ?? "??"} title=${t}`);
      // Record the sender-classified state so the interval-based
      // demoters below (byte-quiet, settled-hash, scrollback) can
      // skip when the title actively says "busy" — Gemini's "✦ Working"
      // title can sit unchanged for 30+ s while the agent thinks,
      // beating our 4 s/6 s heuristic thresholds.
      if (state) senderStateRef.current = state;
      if (state === "idle") {
        // Hooks own the end of a turn when they are installed. The title is
        // still allowed to end one within a moment of the user pressing
        // Escape, because that is an interrupt: no agent except grok reports
        // it, and claude repaints its idle glyph ~90ms after the keystroke.
        //
        // ALSO gated on the user actually watching this tab, which costs
        // nothing and removes the only dangerous false positive. Claude's
        // title oscillates between its idle glyph and a spinner for a few
        // frames after a response (the reason STICKY_DONE_MS exists), so an
        // Escape pressed for an unrelated reason, followed by a switch away,
        // followed by a flicker, could otherwise badge a done that never
        // happened. It costs nothing because `fireDone` already suppresses the
        // badge entirely on a watched tab: the interrupt's whole job there is
        // to stop the spinner, not to notify. The cost of being wrong the
        // other way is a tab that reads "working" until the next prompt, which
        // is the direction to fail in.
        const interrupted = Date.now() - escAtRef.current < ESC_INTERRUPT_WINDOW_MS
          && isUserWatching(task.id, tab.id);
        if (hooksOwnStateRef.current && hookSeenRef.current) {
          if (interrupted) goInterrupted("title idle after interrupt");
          else wdlog("title idle ignored (hooks own done for this agent)");
          if (state) lastTitleState = state;
          return;
        }
        // Same submit gate as the busy branch below, and for the same reason.
        // Codex paints its Braille spinner during startup, then settles on a
        // wordless idle title; without this gate that startup busy→idle pair
        // fires a settle on a tab the user has never typed into, and 5s later
        // a fresh Codex tab shows a "done" badge for a turn that never
        // happened. `lastTitleState` is recorded even when the busy branch is
        // suppressed, so gating only the busy side is not enough.
        if (submittedSinceSpawnRef.current
            && (lastTitleState === "busy" || lastTitleState === "attention")) {
          goIdle(`title busy→idle`);
        } else if (!submittedSinceSpawnRef.current) {
          wdlog(`title idle suppressed (no submit since spawn)`);
        }
      } else if (state === "attention") {
        goAttention(`title attention`);
      } else if (state === "busy") {
        // Hooks own BOTH edges, not just the end of a turn.
        //
        // The title was left driving `working` here on the grounds that it is
        // harmless and often first. It is not harmless. Captured live: a hook
        // reported 133;C then 133;D 1ms apart, the title re-armed `working`
        // 19ms later, and the NEXT genuine 133;D was swallowed by the
        // one-done-per-submit token the first done had already spent. The tab
        // then claimed to be working for 44 seconds with the agent sitting
        // idle at its prompt, until an unrelated re-render cleared it.
        //
        // Two sources for one state, and the slower one re-arming after the
        // faster one finished, is the overlap this whole design set out to
        // remove. The heartbeat (PreToolUse) is what makes dropping it safe:
        // working is re-asserted by the protocol many times per turn.
        if (hooksOwnStateRef.current && hookSeenRef.current) {
          wdlog("title busy ignored (hooks own both edges for this agent)");
        } else if (submittedSinceSpawnRef.current) {
          // Gate on submittedSinceSpawnRef: startup animations (Codex Braille
          // spinner, Claude's initial render) look identical to working
          // spinners. Only trust busy titles after the user has sent at
          // least one message this PTY session (keyboard Enter or broadcast).
          goWorking(`title busy`);
        } else {
          wdlog(`title busy suppressed (no submit since spawn)`);
        }
      }
      if (state) lastTitleState = state;
    });

    // BEL — a real bell, as decided by the VT parser.
    //
    // This used to be `u8.indexOf(0x07) !== -1` on the raw chunk, which cannot
    // tell a bell from the terminator of an OSC: `ESC ] 0 ; title BEL` ends in
    // 0x07, and claude repaints its title about once a second. That is what the
    // old "agents emit BEL every ~1s during their spinner" comment was actually
    // describing — not a bell, a title. Worse, it was chunk-dependent: across
    // three byte-identical OSC 9 sequences in one recording it fired on two and
    // missed the third, so needs-you badges appeared at random. In 1300 lines
    // of recorded claude output there was not one genuine bell.
    //
    // Still gated on having typed (a splash-screen bell on a tab you never used
    // is not for you) and on not being mid-work.
    term.onBell(() => {
      if (!workDoneEnabled || isRunTab) return;
      const cur = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
      if (!cur || !cur.lastInputAt || cur.workState === "working") return;
      dbg("bel", `lastInputAt=${cur.lastInputAt} workState=${cur.workState}`);
      markAttention(task.id, tab.id, "bell");
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
      // This is the agent asking for the user, so it raises ATTENTION, not
      // done. It used to settle to done, on the theory that OSC 9 is a
      // straggler arriving after a turn we had already called. Two recordings
      // say otherwise: it is the only signal claude emits when it is blocked,
      // and it arrives a fixed 6.0s after the title goes idle — i.e. always
      // just behind byte-quiet (4s) and the settle timer (5s). Racing it by
      // slowing those down would make every genuine completion feel sluggish,
      // so instead attention is allowed to land on top of a done we already
      // fired (goAttention does not check the one-done-per-submit token).
      wdlog(`OSC 9 notify`, data);
      dbg("osc9-notify", data.slice(0, 200));
      notifyAttention(`OSC 9 notify`, data);
      return false;
    });

    // OSC 777;notify;<title>;<body> — VTE/urxvt notification dialect.
    // Some custom agents emit this instead of OSC 9. Same meaning, same
    // handling.
    term.parser.registerOscHandler(777, (data) => {
      const parts = data.split(";");
      if (parts[0] !== "notify") return false;
      if (!hookSeenRef.current) {
        hookSeenRef.current = true;
        logWorkState("hook-proven", `cli=${tab.cli} task=${JSON.stringify(task.name)} (via OSC 777)`);
      }
      logWorkState("hook-osc", `cli=${tab.cli} osc=777 body=${JSON.stringify(data.slice(0, 120))}`);
      const body = parts.slice(2).join(";") || parts[1] || "";
      // The `title` field names the SENDER. Our own agent hook stamps
      // HOOK_OSC_TITLE there, which is how a signal termic installed itself is
      // told apart from whatever the agent decided to notify about. See
      // lib/agentHooks.ts and docs/agent-hooks.md.
      const trusted = parts[1] === HOOK_OSC_TITLE;
      // READY shares this OSC id and the trusted title with the attention
      // signal, and is told apart by its body alone. It is NOT attention: it
      // reports that the agent is past its own startup and a typed message
      // will reach its input box. Routed before notifyAttention so a ready
      // session can never badge as needing you.
      if (trusted && body === HOOK_OSC_READY_BODY) {
        wdlog("OSC 777 ready (termic hook)", body);
        dbg("osc777-ready", body.slice(0, 200));
        if (!hookSeenRef.current) {
          hookSeenRef.current = true;
          logWorkState("hook-proven", `cli=${tab.cli} task=${JSON.stringify(task.name)} (via ready)`);
        }
        // Stamped once per PTY: seedPrompt waits on it, and a resumed session
        // re-firing SessionStart must not look like a second, later readiness.
        if (!agentReadyPatchedRef.current) {
          agentReadyPatchedRef.current = true;
          patchTab(task.id, tab.id, { agentReadyAt: Date.now() });
        }
        return false;
      }
      // The agent reporting the id of the session it is running, so termic can
      // resume THAT session later rather than "whatever ran last in this
      // directory". codex and devin report it at every start (they cannot be
      // told an id at launch); claude reports it only when the session MOVES
      // inside a running process, on `/clear`, `/resume` and `/compact`
      // (GH #306), because a relaunch otherwise resumes the pre-`/clear` one.
      //
      // Routed BEFORE notifyAttention, and that ordering is load-bearing: a
      // trusted body skips every notification filter by design, so an
      // unrecognised one falls straight through to a needs-you badge. Reporting
      // a session id would otherwise ring a bell on every session start, which
      // is the exact bug codex's own OSC 9 had just been fixed for.
      const reported = trusted ? hookOscSessionId(body) : null;
      if (reported) {
        wdlog("OSC 777 session id (termic hook)", reported);
        dbg("osc777-session", reported);
        // Bail on an unchanged value. This lands once per spawn today, but it
        // is an agent-controlled path and `setTabSessionId` rewrites the tabs
        // record AND the tasks record on every call, which is the fanout trap
        // docs/performance.md bear trap 8 is about.
        const live = useApp.getState().tabs[task.id]
          ?.find(t => t.id === tab.id) as TerminalTab | undefined;
        // The reported id supersedes the one this spawn minted and has not
        // persisted yet. `persistMintedSession` writes that on the first
        // submit, so a `/clear` BEFORE the first prompt would otherwise be
        // undone by the next Enter, back to a session nothing was said in.
        pendingSessionUuidRef.current = null;
        sessionReportedRef.current = true;
        if (live?.sessionId !== reported) {
          logWorkState("session-reported",
            `cli=${tab.cli} task=${JSON.stringify(task.name)} id=${reported}`);
          useApp.getState().setTabSessionId(task.id, tab.id, reported);
        }
        return false;
      }
      // Subscription usage from claude's termic status line (GH #277). Not a
      // hook and not a notification: it reports a NUMBER, and nothing about it
      // should ever badge a tab.
      //
      // Routed BEFORE notifyAttention for the same reason the session id is: a
      // trusted body skips every notification filter by design, so an
      // unrecognised one falls straight through to a needs-you badge. This body
      // arrives on EVERY TURN, so getting the order wrong would ring a bell on
      // every turn of every task.
      const usage = trusted ? parseUsageBody(body) : null;
      if (usage) {
        dbg("osc777-usage", body.slice(0, 200));
        // Keyed by the AGENT, not the task: a clone holds its own login, and
        // two tasks on one clone spend the same quota. `report` bails on an
        // unchanged reading, which matters here more than anywhere else in this
        // handler (docs/performance.md bear trap 8): most turns move a
        // percentage by nothing at all.
        useAgentUsage.getState().report(
          tab.cli ?? "claude",
          // The account THIS process is running as, captured at spawn. Not the
          // configured one: a switch applies on the next spawn, so between the
          // click and the restart the setting names an account this process is
          // not using, and filing under it would credit one subscription's
          // spending to another (GH #278).
          spawnAccountRef.current,
          usage,
          "statusline",
          // The SESSION this reading belongs to, for the spend accumulator.
          //
          // claude's cost is a per-session RUNNING TOTAL, so the key has to be
          // the session. The tab is not it: resuming a session in a different
          // tab (reopen a task, or a second tab on the same conversation)
          // reports the same cumulative figure again, and a tab-keyed
          // accumulator adds it on top of what it already had. The spend then
          // doubles for work nobody did.
          //
          // The tab id is only the fallback for an agent that has not reported
          // a session id yet, where "this tab" is the best identity there is.
          (useApp.getState().tabs[task.id]
            ?.find(t => t.id === tab.id) as TerminalTab | undefined)?.sessionId
            || `${task.id}:${tab.id}`,
        );
        return false;
      }
      wdlog(`OSC 777 notify${trusted ? " (termic hook)" : ""}`, body);
      dbg("osc777-notify", body.slice(0, 200));
      notifyAttention(`OSC 777 notify`, body, trusted);
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
      // Logged on ARRIVAL, not on the state change it may or may not cause.
      // The working hook is a heartbeat: most of its firings land on a tab that
      // is already working, which is a no-change and therefore invisible in the
      // transition trace. "Did the hook fire at all" and "did the hook change
      // anything" are different questions, and while diagnosing whether hooks
      // work the first one is the one being asked.
      if (!hookSeenRef.current) {
        hookSeenRef.current = true;
        logWorkState("hook-proven", `cli=${tab.cli} task=${JSON.stringify(task.name)}`
          + " first hook delivered; fallbacks stand down for this pty");
      }
      logWorkState("hook-osc", `cli=${tab.cli} osc=133;${sub} task=${JSON.stringify(task.name)}`);
      wdlog(`OSC 133;${sub}`);
      dbg("osc133", sub);
      if (sub === "C") {
        goWorking(`OSC 133;C`);
      } else if (sub === "D") {
        // 133;D is a hard "command ended" — no need to wait SETTLE_MS.
        goIdle(`OSC 133;D`, 0, true);
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
    // The log sink is read lazily: debugLogRef is wired later, inside the
    // spawn IIFE, and is null unless localStorage.ptyDebug === "1".
    const rendererAddon = loadTerminalRenderer(term, (tag, content) =>
      debugLogRef.current?.(tag, content));

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
    // Capture-resume agents (opencode): inject the captured (or externally
    // seeded, GH #169) session ID as a resumeOverride so spawnArgsForCli
    // uses it without touching decideResume. Composed from the registry's
    // resume_id_args, not a hardcoded flag, so any agent in this class
    // resumes with its own spelling. Honors failedResume like the id-based
    // path: a rapid-exit (dead or foreign session id) retries FRESH instead
    // of respawning into the same failing resume forever.
    const captureResumeOverride =
      captureCapable && storedUuid && !failedResumeRef.current
        ? resumeIdArgsForCli(tab.cli, storedUuid).join(" ") || undefined
        : undefined;
    // Harvest the session ID a capture-resume agent created lazily, once per
    // tab. Called from two places (5s after the first Enter, and again on
    // exit as a backstop) and no-ops after either one lands. Every step is
    // logged: the whole path is silent on failure by design (an empty
    // capture is indistinguishable from "no session yet"), which is exactly
    // what made GH #243 impossible to tell apart from a resume bug.
    const captureSessionId = (reason: string) => {
      if (!captureCapable) return;
      const liveTab = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
      if (liveTab?.sessionId) return;
      const capture = postLaunchCaptureForCli(tab.cli);
      if (!capture) return;
      dbg("session-capture", `${reason}: running \`${capture.command}\` in ${task.path}`);
      // The agent + docker flag matter: a Docker task's sessions were written
      // INSIDE the container, into termic's mounted dir, not the user's own
      // ~/.local/share. Without them the capture returns a host session id the
      // container cannot resume ("retained session not found").
      ipc.runCaptureCommand(
        capture.command, task.path, tab.cli,
        !!useApp.getState().tasks.find(t => t.id === task.id)?.docker_sandbox_enabled,
      )
        .then(id => {
          if (id) {
            dbg("session-capture", `${reason}: captured ${id}`);
            useApp.getState().setTabSessionId(task.id, tab.id, id);
          } else {
            dbg("session-capture", `${reason}: no output (CLI missing from PATH, or no session yet)`);
          }
        })
        .catch(e => dbg("session-capture", `${reason}: failed — ${String(e)}`));
    };
    const decision = decideResume({
      isAgent,
      idCapable,
      isPrimary: isPrimaryTab,
      // The task's resume override is written in ONE agent's flag spelling, so
      // only that agent may be handed it. A "+" tab running a different CLI is
      // still primary-for-its-cli, which is how `codex` came to be launched
      // with claude's `--resume <name>` and died on argv.
      runsTaskAgent: tab.cli === task.cli,
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
    // What this spawn actually did about resuming. NOT `decision.kind` alone:
    // a capture-resume agent (codex, opencode) resumes through
    // `captureResumeOverride`, which decideResume never sees. Pure + unit
    // tested in lib/agents.ts, for the same reason decideResume is.
    const resumeShape = spawnResumeShape({ decision, captureResumeOverride });

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
        lastSpawnWasResumeRef.current = resumeShape.isResume;
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
          // YOLO auto-on whenever the task is caged, by EITHER mechanism:
          // Seatbelt ENFORCING / ENFORCING (FS), or Docker mode. Either way
          // the cage is the real security boundary, so the agent's own
          // permission-prompt scaffolding is just friction. The user pref
          // still wins when neither cage is on, and the wizard / sandbox
          // dialog spell this out so nobody is surprised.
          yolo: isTaskCaged(task) || !!task.yolo,
          resume: shouldResume,
          isPrimary: isPrimaryTab,
          sessionUuid,
          resumeKnown,
          resumeOverride,
          unattended: !!(tab as TerminalTab).unattended,
          task,
        });
        // On-the-fly ports (GH #196): names configured after this task
        // was created freeze into its buffer now, so this tab's env sees
        // them. Best-effort: a failure spawns with the already-frozen
        // pairs. The store refresh (loadAll) only fires when pairs were
        // actually added, so the common path costs one cheap IPC.
        let extraPorts = task.extra_named_ports ?? [];
        try {
          const fresh = await ipc.taskEnsureExtraPorts(task.id);
          const freshPorts = fresh.extra_named_ports ?? [];
          if (freshPorts.length !== extraPorts.length) {
            extraPorts = freshPorts;
            void useApp.getState().loadAll();
          }
        } catch { /* keep the frozen pairs */ }
        // Daily Docker image refresh (opt-out, on by default): agent CLIs
        // in the image are unpinned/always-latest, so a task launched
        // today on an image built yesterday can silently run a stale
        // binary. No-ops for anything not in Docker mode, already built
        // today, or with the setting off. Can take 1-2 minutes on a cache
        // miss (it's a --no-cache rebuild, same as "Update agents") -
        // re-check cancelled after, the tab may have been closed/navigated
        // away from while this awaited.
        if (isAgent) await maybeRebuildDockerImageForLaunch(task);
        if (cancelled) return;
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
            // Extra named ports (GH #196): frozen name→port pairs under
            // the exact names the user configured (topped up just above).
            // Before the per-agent block below, so a power user's env
            // overrides still win.
            ...Object.fromEntries(
              extraPorts.map(np => [np.name, String(np.port)]),
            ),
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
          // CLI attach/logs targeting: agent tabs only (run/setup tabs
          // and shells are not addressable). The default target is the
          // task's primary tab of its OWN cli, one per task, so
          // `termic attach` with several agents open stays
          // deterministic.
          role: isAgent
            ? {
                task_id: task.id,
                // The stable selector `--tab` resolves to. Index and title
                // both move; this does not.
                tab_id: tab.id,
                kind: "agent" as const,
                is_default: isPrimaryTab && tab.cli === task.cli,
              }
            : undefined,
          // Activity monitor provenance (reporting only). Unlike `task_id`
          // and `role` above, EVERY tab type sets this: a run script or a
          // scratch shell eating a core is exactly what the monitor is for,
          // and without an owner it would show up unattributed.
          owner: {
            task_id: task.id,
            tab_id: tab.id,
            kind: (tab as TerminalTab).runTab
              ? ((tab as TerminalTab).runTab!.kind === "setup" ? "setup" : "run")
              : isShell ? "shell"
              : isAgent || isRegistryTerminal ? "agent"
              : "custom",
          },
          rows, cols,
        });
        const ptyId = spawn.id;
        if (cancelled) { ipc.ptyKill(ptyId).catch(() => {}); return; }
        ptyRef.current = ptyId;
        spawnAccountRef.current = spawn.account ?? null;
        // firstOutputAt starts null: this PTY has not painted yet.
        firstOutputPatchedRef.current = false;
        patchTab(task.id, tab.id, {
          ptyId, lastOutputAt: Date.now(), firstOutputAt: null,
          liveAccount: spawn.account ?? null,
        });
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
          // Everything needed to join this log to an EXTERNAL ground truth,
          // which is the only way to call a `done` false rather than argue
          // about it. Every later line is `+Nms` off this `t0`, so the
          // absolute epoch is what converts them to wall clock. `session` +
          // `cwd` locate the agent's own transcript (claude appends
          // ~/.claude/projects/<cwd-slug>/<session>.jsonl live, and termic
          // minted that uuid, so the pairing is exact, not inferred): replay
          // the two side by side and a done we fired while the transcript
          // was still mid-turn is a fact with a timestamp.
          dbg("spawn", `task=${task.name} cli=${tab.cli} ptyId=${ptyId} file=${file}`
            + ` t0=${t0} t0iso=${new Date(t0).toISOString()}`
            + ` session=${sessionUuid ?? "none"} resume=${decision.kind} cwd=${task.path}`);
        }
        // One unconditional line per spawn. `hooksOwn` is the first thing to
        // check and the easiest to get wrong: it is what switches the title and
        // every heuristic demoter off, and if it is false for an agent whose
        // hooks ARE installed on disk, nothing else in this log will make
        // sense. Cheap: once per PTY, not per event.
        // `base` is the built-in table this agent's behaviour comes from, and
        // it is the second-easiest thing to get wrong after hooksOwn. A
        // duplicated agent inherits through `extends`; if that resolves to
        // itself for a clone of claude, it has no title patterns and no
        // notification filter, and every later line will look inexplicable.
        // Once per PTY.
        const base = builtinBaseId(tab.cli, useApp.getState().agents);
        // The resume half of the line is here for the same reason the rest is:
        // "it came back empty" is only diagnosable after the fact, and the
        // three facts that separate the causes apart are the shape of the
        // decision, the id it pointed at, and the argv that came out.
        // `decision.kind` alone is not enough — a capture-resume agent
        // (codex, opencode) resumes through `captureResumeOverride`, which
        // decideResume never sees and reports as `fresh`.
        logWorkState("spawn",
          `task=${JSON.stringify(task.name)} cli=${tab.cli} base=${base}`
          + ` inherited=${base !== tab.cli} hooksInstalled=${hooksOwnStateRef.current}`
          + ` hookProven=${hookSeenRef.current}`
          + ` mainCheckout=${!!task.is_main_checkout} primary=${isPrimaryTab}`
          + ` resume=${decision.kind}${captureResumeOverride ? "+capture" : ""}`
          + ` session=${sessionUuid ?? storedUuid ?? "none"}`
          + ` args=${JSON.stringify(spawnArgs)}`
          + ` ptyId=${ptyId}`);
        // Sandbox truth lands synchronously with the spawn (no event
        // race possible). Render the warning chip immediately when the
        // cage degraded.
        setSandboxWarning(spawn.sandbox.warning || null);
        // Persist the spawn and fold the new count back into the store, so a
        // task launched this session stops reading as never-spawned. Real
        // resume gating still lives on the has_resumable_history flag below,
        // not here.
        useApp.getState().recordSpawn(task.id);
        // Launching a task is exactly the moment its PR/MR status is worth
        // knowing, not something to wait on the user opening the Git tab
        // for - only the primary agent tab counts as "the task launched",
        // and only for a task that could ever have one (main checkouts
        // never do, see GitPanel). Unforced: the store's own 30s floor still
        // applies, so a crash-looping agent respawning repeatedly doesn't
        // turn this into a hammer.
        if (isAgent && isPrimaryTab && !task.is_main_checkout) {
          usePr.getState().refresh(task.id);
        }
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
          // Just minted a uuid for THIS tab: hold it until the first real
          // submit (see persistMintedSession), then persist it per-tab so each
          // agent in the task resumes independently and the next spawn — this
          // session or after a restart — uses --resume <uuid> instead of
          // --session-id <uuid>. The agent only writes its session file once
          // there is a conversation, so persisting at spawn time hands the
          // next spawn a --resume id that does not exist yet.
          if (decision.kind === "mint" && sessionUuid && !sessionReportedRef.current) {
            pendingSessionUuidRef.current = sessionUuid;
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
        // Lossless recorder (localStorage.ptyDebugRaw). Unlike oscSniffer
        // above it is stateful, so a sequence split across chunks is still
        // reported, and it filters nothing.
        const ctrlSniffer = ptyRawOn
          ? makeCtrlSniffer((kind, payload) => dbg(`raw-${kind}`, payload))
          : null;
        const unlistenData = await ipc.onPtyData(ptyId, (u8) => {
          term.write(u8);
          oscSniffer?.(u8);
          ctrlSniffer?.(u8);
          const now = Date.now();
          lastDataAtRef.current = now;
          // One patch per PTY lifetime: the agent has started painting.
          if (!firstOutputPatchedRef.current) {
            firstOutputPatchedRef.current = true;
            patchTab(task.id, tab.id, { firstOutputAt: now });
          }
          if (now - lastOutputPatchRef.current >= 500) {
            lastOutputPatchRef.current = now;
            patchTab(task.id, tab.id, { lastOutputAt: now });
          } else if (lastOutputTrailerRef.current === null) {
            // Chunks landing inside the window would otherwise be lost if
            // the burst ends before the next >=500ms chunk: schedule one
            // trailing write for when the window closes.
            lastOutputTrailerRef.current = window.setTimeout(() => {
              lastOutputTrailerRef.current = null;
              const t = lastDataAtRef.current;
              lastOutputPatchRef.current = t;
              patchTab(task.id, tab.id, { lastOutputAt: t });
            }, 500 - (now - lastOutputPatchRef.current));
          }
          if (outputSignals) scanOutputLines(u8);
          if (ptyDebugOn) dbg("data", decodeForDebug(u8, ptyRawOn ? 65_536 : 500));
          // Output activity extends the OSC 9;4 done timer — even if
          // the agent went OSC-idle, fresh bytes mean it's still
          // streaming output (thought summary, tool result text, etc.)
          // so it's not really done.
          pushOscDoneRef.current();
          const cur = (useApp.getState().tabs[task.id] || []).find(t => t.id === tab.id);
          if (cur && cur.type === "terminal") {
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
        // The effect cleanup calls this (with unlistenExitRef) before any
        // respawn, so the listener never outlives its PTY. NB: a previous
        // comment here claimed this COMPOSED several unlisteners into one ref;
        // it does not, it assigns. Anything else that needs tearing down wants
        // its own ref, not this one — assigning over it would silently drop
        // whatever was already there and leak a listener per respawn.
        unlistenDataRef.current = unlistenData;
        // Rust holds this PTY's output until the ack lands, because a Tauri
        // event emitted before `listen()` registers reaches nobody. Without
        // it an agent that prints its banner and one OSC title at startup and
        // then blocks on stdin can lose both to the spawn round trip and show
        // an empty terminal with no live title, for good.
        ipc.ptyAttached(ptyId).catch(() => {});

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
          // Every resume that dies gets a line, INCLUDING the ones too slow to
          // qualify as a fast exit. A resume that takes longer than
          // RESUME_FAILURE_MS to fail gets no toast, no cleared id and no
          // retry — it lands on the exited banner, and Restart reruns the same
          // doomed argv — so "did this exit at 400ms or at 2100ms" is the
          // first question to ask of a session that never comes back.
          if (lastSpawnWasResumeRef.current) {
            logWorkState("resume-exit",
              `task=${JSON.stringify(task.name)} cli=${tab.cli} code=${code}`
              + ` afterMs=${Date.now() - spawnStartedAtRef.current} fastExit=${fastExit}`
              + ` storedId=${resumeShape.usedStoredSessionId}`);
          }
          if (fastExit && lastSpawnWasResumeRef.current) {
            // Rapid exit during a resume attempt = the stored session
            // doesn't resolve anymore (id-CLI: log rotated / deleted;
            // legacy: "no conversation to continue"). Drop the bad
            // state + bump gen → respawn fresh. No overlay flicker —
            // we never set exited=true. The in-component failure flag
            // makes the immediate retry skip resume even before the
            // task prop refreshes.
            failedResumeRef.current = true;
            if (resumeShape.usedStoredSessionId) {
              // This tab's stored uuid did not resolve, so clear the slot and
              // let the immediate retry mint a fresh session. Say so once,
              // now: termic losing its pointer does NOT delete the transcript,
              // and every id-resuming agent has its own picker for it
              // (`claude --resume`, `codex resume`, `opencode session list`).
              // We used to stash the uuid and offer a "Resume it" banner
              // instead; it outlived the failure it described, never cleared
              // itself, and came back on every relaunch worded as if nothing
              // had gone wrong.
              //
              // Reached by codex/opencode now too. It was gated on
              // `decision.kind === "resume-id"`, which a capture-resume agent
              // cannot produce, so a codex tab pointed at a session it could
              // not open started a fresh one on every spawn and never said
              // why. Measured cause: a SECOND Codex holding the same thread
              // ("already has an active writer"), which is what made clicking
              // R look like it did nothing.
              useUI.getState().pushToast(
                `Couldn't resume the previous ${agentDisplayName(tab.cli)} session. Started a fresh one.`,
                "info",
              );
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
          captureSessionId("exit");
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
          // Escape and Ctrl-C both mean "stop", and agents disagree about
          // which they honour: measured mid-turn, claude, grok and agy take
          // either, while opencode needs TWO Escapes and exits on one Ctrl-C.
          // Recording both is therefore necessary and safe, because the key
          // alone never ends a turn: something has to corroborate it, and a
          // press the agent did not act on never produces that corroboration.
          //
          // A bare ESC is exactly one byte, which is what separates it from
          // xterm's automated replies: a cursor-position report is
          // `\x1b[<row>;<col>R` and also begins with ESC. Matching the whole
          // payload keeps those out. Alt-chords arrive as `\x1b` PLUS the
          // character in one call, so they are excluded too.
          if (data === "\x1b" || data === "\x03") {
            escAtRef.current = Date.now();
            wdlog(`${data === "\x03" ? "Ctrl-C" : "ESC"} pressed; the title or a quiet terminal may end this turn briefly`);
          }
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
            // The gate this rides is "a human submitted something", which is
            // the same question the Todo -> In progress edge asks. Write-once
            // and bails on an already started task, so this costs one lookup
            // per Enter thereafter (src/store/app.ts).
            useApp.getState().markStarted(task.id);
            submittedSinceSpawnRef.current = true;
            persistMintedSession();
            noteSubmit(tab.cli);
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
              const liveTab = useApp.getState().tabs[task.id]?.find(t => t.id === tab.id) as TerminalTab | undefined;
              if (!liveTab?.sessionId) {
                captureArmedRef.current = true;
                window.setTimeout(() => captureSessionId("first-submit"), 5000);
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
    //
    // The zero → non-zero edge is also where we repair the viewport
    // scroller: WKWebView zeroes .xterm-viewport's scrollTop while the pane
    // sits in a display:none subtree, and when fit() lands on unchanged
    // dims xterm has no event that re-syncs it — scrolling reads as
    // "locked" (wheel-up dead at the bottom, or bottom unreachable) until
    // new output happens to scroll the buffer. See lib/xtermViewportSync.
    let wasHiddenAtZeroGeometry = false;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const r = e.contentRect;
        if (r.width === 0 || r.height === 0) { wasHiddenAtZeroGeometry = true; return; }
      }
      try { fit.fit(); } catch {}
      if (wasHiddenAtZeroGeometry) {
        wasHiddenAtZeroGeometry = false;
        resyncViewportAfterReveal(term);
      }
    });
    ro.observe(host);

    return () => {
      cancelled = true;
      ro.disconnect();
      disposeCopyOnSelect();
      disposeLinkOpener();
      disposePathLinks.dispose();
      unregisterDrop();
      host.removeEventListener("paste", onPaste, true);
      disposeImeBridge();
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      // A pending trailing lastOutputAt write must not fire into the next
      // PTY session (gen-bump Restart reuses this component).
      if (lastOutputTrailerRef.current !== null) {
        clearTimeout(lastOutputTrailerRef.current);
        lastOutputTrailerRef.current = null;
      }
      if (ptyRef.current) ipc.ptyKill(ptyRef.current).catch(() => {});
      // Dispose the renderer addon FIRST so its render loop can't fire
      // on a half-disposed terminal.
      // Cancel any pending settle timer so it can't fire on the next PTY
      // session after a gen-bump Restart. settleTimer is a local let in this
      // closure — we must clear it here rather than in cancelSettle() because
      // the new effect's cancelSettle is a different closure instance.
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      imagePersistence?.dispose();
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
  // sidebar). Mounted tasks stay rendered with display:none, so
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
      persistMintedSession();
      noteSubmit(tab.cli);
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
  // The RESOLVED palette id, not the raw mode: under "auto" the mode string
  // survives a macOS dark/light flip unchanged, so keying this on it left
  // every terminal painting the old palette until the user re-picked a theme.
  // Resolved also means an explicit pick ignores the flip, re-running nothing.
  const themeKey = useResolvedThemeFull();
  // customThemeRev bumps when the active custom theme's FILE was edited
  // (same theme id, new palette) — see prefs.loadCustomThemes.
  const customThemeRev = usePrefs(s => s.customThemeRev);
  const firstThemeRun = useRef(true);
  useEffect(() => {
    if (firstThemeRun.current) { firstThemeRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.theme = currentTerminalTheme() as any;
    t.options.minimumContrastRatio = currentMinimumContrastRatio();
  }, [themeKey, customThemeRev]);

  // YOLO live toggle — for agents that support runtime mode switching (only
  // gemini today), send the appropriate slash command. For claude/codex this
  // is a no-op; the next spawn picks up the new flag.
  const effYolo = isTaskCaged(task) || !!task.yolo;
  // Whichever cage mechanism is on, its own toggle already restarts the
  // PTY (Sandbox dialog's Save & restart, or Docker's taskSetDocker which
  // always restarts) - so this effect's "ask to restart" prompt below only
  // needs to fire for a genuine per-task YOLO flip on an otherwise-uncaged
  // task, same reasoning `isTaskCaged` already carries for `effYolo`.
  const enforced = isTaskCaged(task);
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
    // The prompt belongs to THIS pane and this toggle. Without a key to
    // withdraw it by, it outlived both: toggling twice in a row replaced the
    // first modal and orphaned its promise, and closing the tab (or archiving
    // the task) left a modal on screen asking about an agent that no longer
    // exists — one confirm slot for the whole window, so nothing else could
    // ask anything until someone answered it.
    const confirmKey = `yolo-restart:${task.id}:${tab.id}`;
    let asked = false;
    (async () => {
      // Agents that support runtime mode-switching (gemini) flip live.
      const applied = await tryToggleYoloLive(tab.cli, ptyId, effYolo);
      if (applied || cancelled) return;
      // Enforce transitions already restart the PTY (Sandbox dialog), so
      // only prompt for a genuine per-task YOLO toggle on a running
      // agent that can't switch mid-session (claude / codex).
      if (enforced) return;
      asked = true;
      const ok = await useUI.getState().askConfirm({
        key: confirmKey,
        title: `Restart ${agentDisplayName(tab.cli)} to ${effYolo ? "enable" : "disable"} YOLO?`,
        message: `${agentDisplayName(tab.cli)} applies YOLO only on a fresh launch. Restart now (the session auto-resumes), or pick Later and it takes effect on the next restart.`,
        confirmLabel: "Restart now",
        cancelLabel: "Later",
      });
      asked = false;
      if (ok && !cancelled) { setExited(false); setGen(g => g + 1); }
    })();
    return () => {
      cancelled = true;
      if (asked) useUI.getState().withdrawConfirm(confirmKey);
    };
  }, [effYolo, enforced, tab.cli, task.id, tab.id]);

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
    // ABSOLUTE ceiling — see the check below. Resolved here rather than per
    // tick: the tick is already the hot path (it hashes the viewport), and a
    // debug knob has no business adding a storage read to it.
    // TWENTY minutes, not ten. An agent orchestrating staged background agents
    // runs well past ten on a single turn (measured: 818s and still going),
    // so ten fired routinely on healthy work. The ceiling is a backstop
    // against a dead hook transport, not a guess at how long a turn should
    // take, and now that firing it costs nothing but a cleared spinner (see
    // below) there is no reason to keep it tight.
    const absoluteCeilingMs = ceilingOverrideMs() ?? 1_200_000;
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
      // When the agent reports its own state, NOTHING below may end a turn.
      // The title was switched off for hook-owning agents first, but the
      // byte-quiet, scrollback, settled-hash and ceiling demoters below are
      // the same heuristic wearing a different hat, and leaving them armed
      // reproduced the exact bug hooks exist to fix: over an 8.5 minute run
      // with four real subagents the agent's own `Stop` correctly stayed
      // silent the whole time, while the screen sat unchanged for minutes at a
      // stretch. A `done` from any of these is a `done` the agent never
      // reported. Fail towards "still working", which the next prompt clears.
      // Both halves: configured to own the state AND observed doing it.
      const hooksOwn = hooksOwnStateRef.current && hookSeenRef.current;
      // The one exception, and the only reason an interrupted turn ever ends
      // for an agent that reports nothing. Licensed by an actual keystroke,
      // corroborated by the terminal going quiet, and it calls
      // `interruptWork` rather than `fireDone`: an interrupt is not a
      // completion, so it earns no badge and spends no done token.
      const interruptPending = hooksOwn
        && escAtRef.current > 0
        && Date.now() - escAtRef.current < INTERRUPT_QUIET_GRACE_MS
        && isUserWatching(task.id, tab.id);
      if (interruptPending
          && cur && cur.type === "terminal" && cur.workState === "working"
          && lastDataAtRef.current > 0
          && Date.now() - lastDataAtRef.current >= QUIET_MS) {
        escAtRef.current = 0;
        interruptWork(`interrupt then quiet (quietMs=${Date.now() - lastDataAtRef.current})`);
        return;
      }
      // The absolute ceiling runs for HOOK-OWNING agents too, and is the only
      // thing below this line that does. Everything else here is a heuristic
      // guessing at whether a turn ended, which is what hooks replace; this is
      // a liveness backstop, and standing it down on the strength of hooks left
      // the state machine with no bound at all.
      //
      // Measured, and the reason this moved: publishing an artifact opens an
      // ambient websocket monitor that stays `running` for the whole session,
      // claude reports it in every later `Stop` payload, and the done hook's
      // "anything in flight" guard dropped every one of them. The guard is a
      // whitelist now (src-tauri/src/agent_hooks.rs), so that specific hole is
      // closed, but a hook contract termic does not control cannot be the only
      // thing standing between a tab and a spinner that never stops. The next
      // agent release that adds a task type, or a hook whose transport dies
      // mid-session, would strand a tab exactly the same way.
      //
      // `force` is passed for the same reason the non-hook path passes it: this
      // is the one demoter that outranks a screen-scanned pending-work hold.
      // Ten minutes of a genuinely working agent costs a spinner that clears
      // early and is re-armed by the next `PreToolUse` heartbeat, which is a
      // frame of wrong against a session of stuck.
      if (cur && cur.type === "terminal" && cur.workState === "working"
          && workingStartedAtRef.current > 0
          && Date.now() - workingStartedAtRef.current >= absoluteCeilingMs) {
        logWorkState("ceiling-backstop",
          `cli=${tab.cli} hooksOwn=${hooksOwn} ageMs=${Date.now() - workingStartedAtRef.current}`
          + " forcing done; a hook done never arrived");
        // Stand the backstop back up before firing, or it LATCHES.
        //
        // This path calls `fireDone` directly rather than going through
        // `goIdle`, and `fireDone` touches neither of these. So the first
        // ceiling used to leave `localBusy` true and the clock parked on a
        // turn start from ten minutes ago: the next heartbeat re-armed
        // working, `goBusy`'s `if (!localBusy)` skipped the reset, and the
        // ceiling fired again on the same stale timestamp about a second
        // later. Measured on an orchestrator turn running staged subagents,
        // from termic-workstate.log: working at :18.177, done at :19.303,
        // working at :42.859, done at :43.339, same `turn` id throughout,
        // forever.
        //
        // That makes the comment above wrong in the case it matters. "A
        // spinner that clears early and is re-armed by the next PreToolUse
        // heartbeat" is a frame of wrong only if the re-arm STICKS; latched,
        // it is a tab that reads done for the rest of a turn that may run for
        // half an hour, which is the exact failure the ceiling exists to
        // prevent, wearing the other mask.
        //
        // Clearing the clock means the next working period starts its own
        // ten minutes (see `goBusy`, which restarts it whenever it has been
        // cleared, not only on a busy EDGE, because `localBusy` is still true
        // here and this code cannot see it anyway). The backstop still bounds
        // every period; it just stops spending its whole budget on the first.
        workingStartedAtRef.current = 0;
        // `seen: true`, which is the difference between clearing a spinner and
        // making a claim.
        //
        // This path fires because termic does NOT know what the agent is
        // doing: a hook done never arrived and the clock ran out. Stopping the
        // spinner on that basis is honest. Announcing "your agent is done" on
        // it is not, and that notification is the one that pulls someone away
        // from what they are doing. Reported from a real turn: the badge
        // self-corrected on the next heartbeat, the notification could not.
        //
        // `seen` also routes to `idle` rather than `done`, which is the state
        // this deserves. `done` asserts the turn ended; `idle` says only that
        // nothing is spinning, which is all a backstop ever established.
        fireDone(`absolute ceiling (${absoluteCeilingMs}ms, hooksOwn=${hooksOwn})`,
          fallbackReason, true, true);
        return;
      }
      if (hooksOwn) return;
      // Byte-quiet fallback: if no PTY data has arrived for QUIET_MS
      // and the tab is `working`, demote to `done`. Fires when the
      // agent goes silent entirely. (Doesn't fire for Claude Code's
      // "Cooking for Ns" ticker — for that we need the scrollback
      // check below.)
      //
      // Only give up the tick when the done actually fired. A done HELD by the
      // agent's pending-work line must fall through to the ceilings below —
      // returning here on a held done starved both of them, and byte-quiet is
      // true on every tick once an idle agent stops painting, so the tab sat on
      // "working" past the 10-minute backstop until the user focused it.
      if (!senderBusy
          && cur && cur.type === "terminal" && cur.workState === "working"
          && lastDataAtRef.current > 0
          && Date.now() - lastDataAtRef.current >= QUIET_MS) {
        if (fireDone(`byte-quiet (quietMs=${Date.now() - lastDataAtRef.current})`, fallbackReason)) return;
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
            // Latch only when the done wasn't held. `marked` makes this a
            // one-shot per stable stretch, and it resets on a length change —
            // so latching a held done means this path never retries for a
            // screen that stays exactly as it is, which is precisely the
            // screen a pending-work hold leaves behind.
            let held = false;
            if (cur && cur.type === "terminal" && cur.workState === "working") {
              held = !fireDone(`scrollback-stable (len=${len})`, fallbackReason);
            }
            if (!held) sb.marked = true;
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
        // Same rule as byte-quiet: a held done falls through to the absolute
        // ceiling, which is the one that outranks the hold.
        if (fireDone(`90s hard ceiling`, fallbackReason)) return;
      }
      // The ABSOLUTE ceiling used to sit here. It now runs ABOVE the hooksOwn
      // gate, because down here it was unreachable for exactly the agents that
      // had no other way out. Its rationale is unchanged and lives at the new
      // site: it fires even when senderBusy, it is the only path that outranks
      // a screen-scanned pending-work hold, and `localStorage.workDoneCeilingMs`
      // shortens it so a test can reach it at all.
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
            // Held done → don't latch (same reasoning as scrollback-stable).
            let held = false;
            if (cur && cur.type === "terminal" && cur.lastInputAt && cur.workState === "working" && contentChanged) {
              held = !fireDone(`hash-stable (0x${h.toString(16)})`, fallbackReason);
            }
            if (!held) s.marked = true;
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
  }, [task.id, tab.id, fireDone, interruptWork]);

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
      {/* data-* hooks: the terminal renders to a WebGL canvas, so e2e has no
          text to select this pane by (see the drop spec in files.e2e.ts). */}
      <div ref={hostRef} data-terminal-host={tab.id} className="min-h-0 flex-1 bg-[var(--color-bg)]" />
      {pathMenu && (
        <TerminalPathMenu
          x={pathMenu.x}
          y={pathMenu.y}
          candidates={pathMenu.candidates}
          external={pathMenu.external}
          onPick={(path) => { openPathFile(path, pathMenu.line, pathMenu.col); setPathMenu(null); }}
          onClose={() => setPathMenu(null)}
          onCloseAutoFocus={(e, picked) => {
            // The anchor is an invisible, non-focusable div, so never let Radix
            // return focus to it. On dismiss, hand focus back to the terminal;
            // on a pick, leave it for the editor that just opened.
            e.preventDefault();
            if (!picked) termRef.current?.focus();
          }}
        />
      )}
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
  task: { id: string; cli?: string; path?: string; sandbox_enabled?: boolean; sandbox_mode?: SandboxMode; sandbox_allowed_hosts?: string[]; sandbox_rw_paths?: string[]; docker_sandbox_enabled?: boolean };
  sandboxWarning: string | null;
}) {
  const splitOpen     = useApp(s => !!s.terminalSplit[task.id]);
  const splitCollapsed = useApp(s => !!s.terminalSplitCollapsed[task.id]);
  const toggleBottomTerminal = useApp(s => s.toggleBottomTerminal);
  const mode = effectiveSandboxMode(task);
  // Hidden panes stay MOUNTED (display:none, never visibility:hidden), so a
  // footer that fetched on mount would have every open task doing it at once.
  // Selected as a BOOLEAN, not as the id: subscribing to activeTaskId itself
  // re-renders every task's footer on every task switch.
  const isActiveTask = useApp(s => s.activeTaskId === task.id);

  // Every agent this task RUNS, not just the one it was created with (GH
  // #277). A task holding a claude tab and a codex tab used to show one chip
  // bound to `task.cli`, so the other agent's plan usage was nowhere at all.
  //
  // Both selectors return a STRING, and the unpacking happens out here: a
  // selector that builds an array hands back a fresh reference on every store
  // write and re-renders this footer under every keystroke of every task
  // (docs/performance.md bear trap 8, pinned by store/selectorFanout.test.ts).
  const agentIds = footerAgentIds(
    useApp(s => footerAgentKey(s.tabs[task.id] ?? EMPTY_TABS, task.cli ?? "claude")));
  // Which agent's tab is on screen: the chip that survives a footer too narrow
  // for all of them.
  const activeAgent = useApp(
    s => activeFooterAgent(s.tabs[task.id] ?? EMPTY_TABS, s.activeTab[task.id], task.cli ?? "claude"),
  );

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
  ) : task.docker_sandbox_enabled ? (
    <>
      <DockerSandboxIcon className="h-3.5 w-3.5" />
      <span className="@max-[560px]:hidden">Sandbox: docker container</span>
    </>
  ) : (
    <>
      <SandboxIcon mode={mode} className="h-3.5 w-3.5" />
      <span className="@max-[560px]:hidden">Sandbox: {SANDBOX_VISUALS[mode].shortLabel.toLowerCase()}</span>
    </>
  );

  return (
    <div
      data-testid="task-footer"
      className={cn(
        // --bottom-bar-h is the shared height for every bottom bar. text-[12.5px]
        // matches the queue/terminal buttons and the right-panel footer tabs.
        // Suppress border-t when the split is collapsed: the strip's border-b
        // already provides the separator; two adjacent 1px lines look doubled.
        // `@container`: the collapse below is CSS, not a ResizeObserver, so a
        // window drag costs no React render on a bar that sits under a
        // streaming terminal.
        "@container flex h-[var(--bottom-bar-h)] shrink-0 items-center gap-1.5 px-3 text-[12.5px]",
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
          open — no point offering to add what's there. Goes through
          toggleBottomTerminal (the ⌘J action) so the new shell also takes
          focus; a raw toggleTerminalSplit leaves the seeded shell unfocused. */}
      {!splitOpen && (
        <button
          type="button"
          onClick={() => toggleBottomTerminal(task.id)}
          title="Open a bottom terminal split"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12.5px] text-[var(--color-fg-faint)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
        >
          <TerminalSquare className="h-3.5 w-3.5" />
          {/* Label goes before the numbers do: the icon is unambiguous next
              to the one beside it, and the usage figures are what the user is
              actually reading in a narrow footer. */}
          <span className="@max-[680px]:hidden">Terminal</span>
        </button>
      )}
      {/* Right group: the blocked-hosts chip on the LEFT, the sandbox status
          as the rightmost item. Click the chip to see WHICH hosts got
          blocked; it's a sibling of the edit button so its click doesn't
          bubble to "open Edit dialog." Chip only shows when sandboxed + we've
          actually seen denies. */}
      <div className="ml-auto flex items-center gap-1.5">
        {/* Subscription usage (GH #277). Leftmost of the right group, so the
            two things that can APPEAR (usage, "N blocked") grow leftwards and
            the sandbox status stays pinned as the rightmost item. It self-hides
            until an account has actually reported, so an agent with no usage
            feed costs this row no width at all. */}
        {/* GH #278. Immediately left of the usage chip and one unit with it:
            usage is THAT account's usage, so with two accounts a bare
            percentage is ambiguous. Renders nothing until a second credential
            set exists. */}
        {/* ONE control: which account this agent runs as, and what that
            account has spent. They were two chips and two panels, which the
            account pill's own comment already argued against ("forms one unit
            with the usage chip"). */}
        {agentIds.map(id => (
          <FooterAgentChip
            key={id}
            taskId={task.id}
            agentId={id}
            cwd={task.path}
            docker={!!task.docker_sandbox_enabled}
            visible={isActiveTask}
            // Never true for a single-agent task, which is every task until
            // somebody opens a second agent in one: nothing to choose between,
            // so nothing to drop.
            secondary={agentIds.length > 1 && id !== activeAgent}
          />
        ))}
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
