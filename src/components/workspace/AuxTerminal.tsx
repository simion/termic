// Auxiliary shell in the right-panel footer / main-pane split. Spawns a zsh
// in the workspace path so the user has a scratch terminal for git/grep/etc.
// without touching the agent CLI's PTY.
//
// When the shell exits (Ctrl+D, `exit`, crash) we surface an overlay with a
// "New shell" button — clicking it bumps a generation counter that retears
// down the xterm + spawns a fresh PTY.

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { RotateCcw } from "lucide-react";
import * as ipc from "@/lib/ipc";
import { usePrefs, currentTerminalStack, currentTerminalTheme, currentColorFgBg } from "@/store/prefs";

// Theme is no longer a module-level constant - see TerminalPane for why.
// `currentTerminalTheme()` picks the matching palette at mount; the
// themeMode effect below pushes updates into live instances.

export function AuxTerminal({ wsPath, active }: { wsPath: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef  = useRef<FitAddon | null>(null);
  const ptyRef  = useRef<string | null>(null);
  // Bumped on user "new shell" click — included in the spawn effect's deps so
  // the cleanup runs (disposes the dead xterm) and the body re-runs (spawns
  // a fresh PTY + xterm).
  const [gen, setGen] = useState(0);
  // Visible when the PTY exits — overlays the dead terminal with a CTA.
  const [exited, setExited] = useState(false);

  useEffect(() => {
    if (!hostRef.current) return;
    setExited(false);
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: currentTerminalStack(),
      fontSize: usePrefs.getState().terminalFontSize,
      fontWeight: usePrefs.getState().terminalFontWeight as any,
      fontWeightBold: Math.min(900, usePrefs.getState().terminalFontWeight + 300) as any,
      lineHeight: 1.0,
      theme: currentTerminalTheme() as any,
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    // Hold a ref to the WebGL addon so the cleanup path can dispose it BEFORE
    // term.dispose(). Without that, the addon's pending render frame fires
    // after term._core._store is nulled and crashes with
    //   "undefined is not an object (evaluating '..._core._store._isDisposed')".
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon?.dispose());
      term.loadAddon(webglAddon);
    } catch { /* DOM renderer fallback */ }
    fitRef.current = fit;

    (async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (cancelled) return;
      try { fit.fit(); } catch {}
      try {
        const ptyId = await ipc.ptySpawn({
          cwd: wsPath, cmd: "zsh", args: ["-l"],
          // Signal terminal theme so prompts / status bars that honor
          // COLORFGBG (oh-my-zsh themes, starship, etc.) pick the right
          // colors for the current chrome.
          env: { COLORFGBG: currentColorFgBg() },
          rows: Math.max(8, term.rows), cols: Math.max(40, term.cols),
        });
        if (cancelled) { ipc.ptyKill(ptyId).catch(() => {}); return; }
        ptyRef.current = ptyId;
        unlistenData = await ipc.onPtyData(ptyId, u8 => term.write(u8));
        unlistenExit = await ipc.onPtyExit(ptyId, () => {
          // Surface a CTA so the user can spawn a fresh shell without leaving
          // the panel. We don't auto-respawn — exiting is often intentional.
          ptyRef.current = null;
          setExited(true);
        });
        term.onData(d => ipc.ptyWrite(ptyId, Array.from(new TextEncoder().encode(d))).catch(() => {}));
        term.onResize(({ cols, rows }) => ipc.ptyResize(ptyId, rows, cols).catch(() => {}));
        setTimeout(() => { try { fit.fit(); } catch {} }, 200);
      } catch (e) { term.write(`\x1b[1;31mspawn failed: ${e}\x1b[0m\r\n`); }
    })();

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(hostRef.current);

    return () => {
      cancelled = true; ro.disconnect();
      unlistenData?.(); unlistenExit?.();
      if (ptyRef.current) ipc.ptyKill(ptyRef.current).catch(() => {});
      // Dispose WebGL FIRST so its render loop can't fire on a
      // half-disposed terminal.
      try { webglAddon?.dispose(); } catch {}
      term.dispose();
    };
  }, [wsPath, gen]);

  useEffect(() => {
    // Re-fit on becoming active, but DO NOT steal focus — focus belongs to
    // the main agent terminal on workspace switch. Stealing it here meant
    // typing immediately after switching workspaces went into the scratch
    // shell instead of the agent.
    if (active) requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch {} });
  }, [active]);

  // Re-apply font / size when prefs change.
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

  // Live theme swap mirrors TerminalPane's effect; see the comment there.
  const themeMode = usePrefs(s => s.themeMode);
  const firstThemeRun = useRef(true);
  useEffect(() => {
    if (firstThemeRun.current) { firstThemeRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.theme = currentTerminalTheme() as any;
  }, [themeMode]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {exited && (
        // Overlay sits on top of the dead xterm. Click-through is disabled
        // (own pointer events) so the user can't accidentally interact with
        // the corpse below.
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)]/85 backdrop-blur-[1px]">
          <div className="text-[13px] text-[var(--color-fg-dim)]">Shell exited.</div>
          <button
            onClick={() => setGen(g => g + 1)}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-1.5 text-[12.5px] text-[var(--color-fg)] hover:border-[var(--color-accent-soft)]"
          >
            <RotateCcw className="h-3.5 w-3.5" /> New shell
          </button>
        </div>
      )}
    </div>
  );
}
