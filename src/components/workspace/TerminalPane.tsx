// Single terminal tab: spawns a PTY on first mount, attaches xterm.js, owns
// the resize/refit dance and the attention/unread heuristics. Stays mounted
// across tab switches (parent toggles visibility) so we don't reconnect PTYs.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalTab, Workspace } from "@/lib/types";
import * as ipc from "@/lib/ipc";
import { useApp } from "@/store/app";
import { usePrefs, currentTerminalStack } from "@/store/prefs";
import { spawnArgsForCli, tryToggleYoloLive } from "@/lib/agents";

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
const THEME = {
  background: "#0b0b0d",
  foreground: "#eceef1",
  cursor: "#d97757",
  cursorAccent: "#0b0b0d",
  selectionBackground: "rgba(217,119,87,0.30)",
  black: "#1a1a1d", red: "#ef5350", green: "#4caf50", yellow: "#f0b13a",
  blue: "#4c8bf5", magenta: "#c084fc", cyan: "#22d3ee", white: "#eceef1",
  brightBlack: "#6e747e", brightRed: "#ff6b66", brightGreen: "#7cd57e", brightYellow: "#ffd166",
  brightBlue: "#7fb1ff", brightMagenta: "#d7a4ff", brightCyan: "#67e8f9", brightWhite: "#ffffff",
} as const;

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

  const patchTab = useApp(s => s.patchTab);
  const markAttention = useApp(s => s.markAttention);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: currentTerminalStack(),
      fontSize: usePrefs.getState().terminalFontSize,
      fontWeight: usePrefs.getState().terminalFontWeight as any,
      // Bold face moves in proportion to regular: keep ~300 above regular but
      // capped at 900 so users on 500 still get a meaningfully bolder bold.
      fontWeightBold: Math.min(900, usePrefs.getState().terminalFontWeight + 300) as any,
      // 1.0 is xterm's default and what TUIs (gemini, claude, etc.) assume.
      // A larger lineHeight inflates every cell vertically, so any row the TUI
      // paints with a bg color reads as a visible "ribbon" instead of a tight
      // band against neighbouring rows.
      lineHeight: 1.0,
      theme: THEME as any,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // WebGL renderer tiles cell backgrounds pixel-perfectly — fixes the
    // "ribbon" artifacts in TUIs (gemini, claude) where adjacent bg-colored
    // rows show 1px gaps with the default DOM renderer. Load AFTER term.open
    // so the GL context can attach to an already-laid-out canvas. Graceful
    // fallback: ignore failures, the DOM renderer keeps working.
    //
    // We hold a ref to the addon so cleanup can dispose it BEFORE term.dispose().
    // Without that, a pending render frame fires after term._core._store is
    // nulled and throws "undefined is not an object (... _isDisposed)".
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon?.dispose());
      term.loadAddon(webglAddon);
    } catch (e) { /* WebGL unsupported — DOM renderer remains */ }

    // PTY spawn flow needs the webview to have laid the container out first,
    // otherwise fit.fit() returns 0×0 and we spawn a PTY with garbage dims.
    (async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (cancelled) return;
      try { fit.fit(); } catch {}
      const cols = Math.max(40, term.cols || 100);
      const rows = Math.max(10, term.rows || 30);

      try {
        const ptyId = await ipc.ptySpawn({
          cwd: ws.path,
          cmd: tab.cli,
          // Spawn with whatever auto-approve flag the agent needs *right now*.
          // Toggling YOLO later only affects future tabs (except for gemini,
          // which gets a live `/approval-mode` flip — see the effect below).
          args: spawnArgsForCli(tab.cli, usePrefs.getState().yoloMode),
          env: { TERMIC_PORT: String(ws.port), TERMIC_WORKSPACE_NAME: ws.name },
          rows, cols,
        });
        if (cancelled) { ipc.ptyKill(ptyId).catch(() => {}); return; }
        ptyRef.current = ptyId;
        patchTab(ws.id, tab.id, { ptyId, lastOutputAt: Date.now() });

        // Output stream → terminal write + attention bookkeeping.
        const unlistenData = await ipc.onPtyData(ptyId, (u8) => {
          term.write(u8);
          const now = Date.now();
          patchTab(ws.id, tab.id, { lastOutputAt: now });
          // BEL gating: only treat as attention when the user has typed since
          // boot (otherwise startup banners ring spuriously).
          const cur = (useApp.getState().tabs[ws.id] || []).find(t => t.id === tab.id);
          if (cur && cur.type === "terminal" && u8.indexOf(0x07) !== -1 && cur.lastInputAt) {
            markAttention(ws.id, tab.id, "bell");
          }
        });
        unlistenDataRef.current = unlistenData;

        const unlistenExit = await ipc.onPtyExit(ptyId, () => {
          markAttention(ws.id, tab.id, "exit");
          ptyRef.current = null;
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
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(host);

    return () => {
      cancelled = true;
      ro.disconnect();
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      if (ptyRef.current) ipc.ptyKill(ptyRef.current).catch(() => {});
      // Dispose WebGL FIRST so its render loop can't fire on a
      // half-disposed terminal.
      try { webglAddon?.dispose(); } catch {}
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [ws.id, ws.path, ws.port, ws.name, tab.id, tab.cli, patchTab, markAttention]);

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
  // refit so the cell grid recomputes against the new metrics. Skips the
  // initial run since the constructor already used the current values.
  const terminalFontId     = usePrefs(s => s.terminalFontId);
  const terminalFontSize   = usePrefs(s => s.terminalFontSize);
  const terminalFontWeight = usePrefs(s => s.terminalFontWeight);
  const firstFontRun = useRef(true);
  useEffect(() => {
    if (firstFontRun.current) { firstFontRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.fontFamily     = currentTerminalStack();
    t.options.fontSize       = terminalFontSize;
    t.options.fontWeight     = terminalFontWeight as any;
    t.options.fontWeightBold = Math.min(900, terminalFontWeight + 300) as any;
    try { fitRef.current?.fit(); } catch {}
    if (ptyRef.current) ipc.ptyResize(ptyRef.current, t.rows, t.cols).catch(() => {});
  }, [terminalFontId, terminalFontSize, terminalFontWeight]);

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

  return <div ref={hostRef} className="h-full w-full bg-[var(--color-bg)]" />;
}
