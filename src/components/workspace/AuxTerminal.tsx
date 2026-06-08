// Auxiliary shell in the right-panel footer / main-pane split. Spawns the
// user's login shell ($SHELL, see loginShell) in the workspace path so the
// user has a scratch terminal for git/grep/etc. without touching the agent
// CLI's PTY.
//
// When the shell exits (Ctrl+D, `exit`, crash) we surface an overlay with a
// "New shell" button — clicking it bumps a generation counter that retears
// down the xterm + spawns a fresh PTY.

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { loadTerminalRenderer } from "@/lib/terminalRenderer";
import { registerTerminalDropTarget } from "@/lib/terminalDrop";
import * as ipc from "@/lib/ipc";
import { loginShell } from "@/lib/loginShell";
import { usePrefs, currentTerminalStack, currentTerminalTheme, currentColorFgBg } from "@/store/prefs";

// Theme is no longer a module-level constant - see TerminalPane for why.
// `currentTerminalTheme()` picks the matching palette at mount; the
// themeMode effect below pushes updates into live instances.

export function AuxTerminal({ wsPath, active, onExited }: { wsPath: string; active: boolean; onExited?: () => void }) {
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
    const host = hostRef.current;
    // Drop target: dragging a file onto the scratch shell inserts its
    // escaped path at the prompt — same affordance as the agent terminals.
    const unregisterDrop = registerTerminalDropTarget(host, () => ptyRef.current);
    setExited(false);
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: currentTerminalStack(),
      fontSize: usePrefs.getState().terminalFontSize,
      // Regular 400 / bold 700 — the static JetBrains Mono masters. See
      // TerminalPane for why these are pinned rather than user-tunable.
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: usePrefs.getState().terminalLetterSpacing,
      lineHeight: 1.0,
      theme: currentTerminalTheme() as any,
      allowProposedApi: true,
      scrollback: Math.round(usePrefs.getState().terminalScrollback / 2),
      // Option-as-Meta for terminal editors. See TerminalPane. (issue #11)
      macOptionIsMeta: usePrefs.getState().terminalOptionAsMeta,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new ClipboardAddon());
    term.loadAddon(new ImageAddon());
    // Clickable links — same model as TerminalPane: always loaded so URLs
    // underline on hover, opening gated on Cmd/Ctrl so a plain click still
    // selects. Routes through `open_path` for the system browser (#14).
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) {
        ipc.openPath(uri).catch(() => {});
      }
    }));
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.open(hostRef.current);
    termRef.current = term;
    // Hold a ref to the WebGL addon so the cleanup path can dispose it BEFORE
    // term.dispose(). Without that, the addon's pending render frame fires
    // after term._core._store is nulled and crashes with
    //   "undefined is not an object (evaluating '..._core._store._isDisposed')".
    // Renderer addon — WebGL by default; localStorage override for A/B.
    const rendererAddon = loadTerminalRenderer(term);
    fitRef.current = fit;

    (async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (cancelled) return;
      try { fit.fit(); } catch {}
      const shell = await loginShell();
      if (cancelled) return;
      try {
        const { id: ptyId } = await ipc.ptySpawn({
          cwd: wsPath, cmd: shell, args: ["-l"],
          // Signal terminal theme so prompts / status bars that honor
          // COLORFGBG (oh-my-zsh themes, starship, etc.) pick the right
          // colors for the current chrome.
          env: { COLORFGBG: currentColorFgBg() },
          // NEVER pass workspace_id here. The aux shell is a scratch
          // zsh for the user's own git/grep/etc work - sandboxing it
          // would block exactly the moves the user opened it for
          // (`gh pr create`, `kubectl get pods`, etc.). The agent CLI
          // is the only thing we sandbox; everything else inside the
          // workspace runs with the user's normal permissions.
          rows: Math.max(8, term.rows), cols: Math.max(40, term.cols),
        });
        if (cancelled) { ipc.ptyKill(ptyId).catch(() => {}); return; }
        ptyRef.current = ptyId;
        unlistenData = await ipc.onPtyData(ptyId, u8 => term.write(u8));
        unlistenExit = await ipc.onPtyExit(ptyId, () => {
          ptyRef.current = null;
          // Bottom-split shells: parent passes onExited to close the
          // tab immediately (the tab strip is the affordance for
          // spawning a new one). Standalone previews keep the
          // "New shell" CTA overlay.
          if (onExited) onExited();
          else setExited(true);
        });
        term.onData(d => ipc.ptyWrite(ptyId, Array.from(new TextEncoder().encode(d))).catch(() => {}));
        term.onResize(({ cols, rows }) => ipc.ptyResize(ptyId, rows, cols).catch(() => {}));
        setTimeout(() => { try { fit.fit(); } catch {} }, 200);
      } catch (e) { term.write(`\x1b[1;31mspawn failed: ${e}\x1b[0m\r\n`); }
    })();

    // Skip fit() when the host has zero geometry — happens on the parent
    // toggling display:none for the split's collapse animation. fit()ing at
    // 0×0 resizes the PTY to 0 cols/rows, the agent re-paints on the new
    // size, then a second RO callback fires with the real size on expand
    // and the PTY re-grows. The double resize is visible as a flicker
    // inside the terminal text. Bailing early avoids the spurious resize
    // entirely; the next non-zero RO fire on expand still calls fit().
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const r = e.contentRect;
        if (r.width === 0 || r.height === 0) return;
      }
      try { fit.fit(); } catch {}
    });
    ro.observe(hostRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      unregisterDrop();
      unlistenData?.(); unlistenExit?.();
      if (ptyRef.current) ipc.ptyKill(ptyRef.current).catch(() => {});
      // Dispose the renderer addon FIRST so its render loop can't fire
      // on a half-disposed terminal.
      try { rendererAddon?.dispose(); } catch {}
      term.dispose();
    };
  }, [wsPath, gen]);

  // ⌘K clear handler — fires only when this aux terminal owns
  // focus. Cheap to subscribe per-instance; the dispatch is rare.
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

  useEffect(() => {
    // Re-fit on becoming active, but DO NOT steal focus — focus belongs to
    // the main agent terminal on workspace switch. Stealing it here meant
    // typing immediately after switching workspaces went into the scratch
    // shell instead of the agent.
    if (active) requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch {} });
  }, [active]);

  // Re-apply font / size when prefs change.
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
  }, [terminalFontId, terminalFontSize, terminalLetterSpacing, terminalOptionAsMeta]);

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
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--color-bg)]/85">
          <div className="text-[13px] text-[var(--color-fg-dim)]">Shell exited.</div>
          <button
            onClick={() => setGen(g => g + 1)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-1.5 text-[12.5px] text-[var(--color-fg)] hover:border-[var(--color-accent-soft)]"
          >
            New shell
          </button>
        </div>
      )}
    </div>
  );
}
