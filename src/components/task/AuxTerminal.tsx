// Auxiliary shell in the right-panel footer / main-pane split. Spawns the
// user's login shell ($SHELL, see loginShell) in the task path so the
// user has a scratch terminal for git/grep/etc. without touching the agent
// CLI's PTY.
//
// When the shell exits (Ctrl+D, `exit`, crash) we surface a non-blocking
// bottom banner with a "New shell" button — clicking it bumps a generation
// counter that retears down the xterm + spawns a fresh PTY.

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Osc52Base64 } from "@/lib/osc52";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { attachCmdClickLinkOpener } from "@/lib/termLinkOpener";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadTerminalRenderer, awaitTerminalFonts } from "@/lib/terminalRenderer";
import { registerTerminalDropTarget } from "@/lib/terminalDrop";
import { attachCopyOnSelect } from "@/lib/terminalSelection";
import { setupImeReplacementBridge } from "@/lib/ime";
import * as ipc from "@/lib/ipc";
import { loginShell } from "@/lib/loginShell";
import { TerminalExitedBanner } from "@/components/task/TerminalExitedBanner";
import { usePrefs, currentTerminalStack, currentTerminalTheme, currentColorFgBg, currentMinimumContrastRatio } from "@/store/prefs";
import { useApp } from "@/store/app";
import { IS_MAC, bindingMatches } from "@/lib/shortcuts";

// Theme is no longer a module-level constant - see TerminalPane for why.
// `currentTerminalTheme()` picks the matching palette at mount; the
// themeMode effect below pushes updates into live instances.

export function AuxTerminal({ taskId, taskPath, active, autoFocus, onExited, onTitle }: { taskId?: string; taskPath: string; active: boolean; autoFocus?: boolean; onExited?: () => void; onTitle?: (title: string) => void }) {
  // Keep the latest onTitle in a ref so the long-lived spawn effect's
  // onTitleChange handler always calls the current callback without
  // re-running (and respawning the PTY) when the parent re-renders.
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
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

    // Clickable links — same model as TerminalPane: always loaded so URLs
    // underline on hover, opening gated on Cmd/Ctrl so a plain click still
    // selects. Routes through `open_path` for the system browser (#14).
    const openLink = (via: string) => (uri: string) => {
      ipc.logLine(`[link] scratch activate via=${via} uri=${uri}`).catch(() => {});
      openUrl(uri)
        .then(() => ipc.logLine("[link] scratch open ok").catch(() => {}))
        .catch((e) => ipc.logLine(`[link] scratch open FAILED: ${e}`).catch(() => {}));
    };

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
      // Light-theme truecolor readability. See TerminalPane / #83.
      minimumContrastRatio: currentMinimumContrastRatio(),
      allowProposedApi: true,
      scrollback: Math.round(usePrefs.getState().terminalScrollback / 2),
      // Option-as-Meta for terminal editors. See TerminalPane. (issue #11)
      macOptionIsMeta: usePrefs.getState().terminalOptionAsMeta,
      // Allow bypassing mouse reporting for text selection by holding Option.
      macOptionClickForcesSelection: true,
      // OSC 8 hyperlinks (anchor text like "Learn more"). Same Cmd/Ctrl gate;
      // without a linkHandler xterm parses them but activates nothing.
      linkHandler: {
        activate: (ev, uri) => { if (ev.metaKey || ev.ctrlKey) openLink("osc8")(uri); },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Repair double-encoded OSC 52 payloads (Claude Code). See lib/osc52.ts.
    term.loadAddon(new ClipboardAddon(new Osc52Base64()));
    const disposeCopyOnSelect = attachCopyOnSelect(term, host);
    term.loadAddon(new ImageAddon());
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) openLink("addon")(uri);
    }));
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.open(hostRef.current);
    // GH #58: mouse-reporting-proof Cmd/Ctrl+click opener — the user can run
    // a TUI in the scratch shell too (htop, an agent CLI by hand). See
    // TerminalPane / lib/termLinkOpener.
    // urlsOnly: file-path open is a TerminalPane feature. Without this the
    // opener would arm on path tokens here and swallow the click (dead in the
    // scratch shell, and eaten from under a mouse-reporting TUI).
    const disposeLinkOpener = attachCmdClickLinkOpener(term, host, (target) => {
      if (target.kind === "url") openLink("capture")(target.uri);
    }, { urlsOnly: true });
    // Korean/CJK IME (WKWebView). WebKit composes via textarea `input` events
    // (insertText + insertReplacementText), not compositionstart/end, and
    // xterm drops the replacement events — so input gets mangled (안녕 → ㅇㄴ).
    // setupImeReplacementBridge fills the gap; see src/lib/ime.ts. The
    // keyCode-229 guard below keeps xterm's keydown path inert during IME so
    // only the input-event bridge drives composition. Mirrors TerminalPane.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.isComposing || e.keyCode === 229)) {
        return false;
      }
      // Linux/Windows terminal copy/paste. macOS keeps native ⌘C / ⌘V (this
      // whole block is skipped), so standard Mac behavior is untouched. Defaults
      // are Ctrl+Shift+C / Ctrl+Shift+V — the Shift keeps plain Ctrl+C as SIGINT
      // for the shell. Rebindable via Settings > Shortcuts. Mirrors TerminalPane.
      if (!IS_MAC && e.type === "keydown") {
        const binds = usePrefs.getState().shortcuts;
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
      // Cmd+Backspace → kill line to beginning (\x15, Ctrl+U). Mirrors TerminalPane.
      if (IS_MAC && e.type === "keydown" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key === "Backspace") {
        const pid = ptyRef.current;
        if (pid) ipc.ptyWrite(pid, [0x15]).catch(() => {});
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      return true;
    });
    const disposeImeBridge = setupImeReplacementBridge(hostRef.current, () => ptyRef.current, ipc.ptyWrite);
    termRef.current = term;
    // Hold a ref to the WebGL addon so the cleanup path can dispose it BEFORE
    // term.dispose(). Without that, the addon's pending render frame fires
    // after term._core._store is nulled and crashes with
    //   "undefined is not an object (evaluating '..._core._store._isDisposed')".
    // Renderer addon — WebGL by default; localStorage override for A/B.
    const rendererAddon = loadTerminalRenderer(term);
    fitRef.current = fit;

    (async () => {
      await new Promise<void>(r => {
        let settled = false;
        const fin = () => { if (!settled) { settled = true; r(); } };
        requestAnimationFrame(() => requestAnimationFrame(fin));
        // Same fallback as TerminalPane: rAF freezes to zero in occluded
        // windows, and without it the scratch-shell spawn stalls until
        // the window repaints. rows/cols below already clamp to sane
        // minimums on the fallback path.
        setTimeout(fin, 400);
      });
      if (cancelled) return;
      // GH #70: don't measure/spawn until the terminal font's faces are
      // active. Mirrors TerminalPane; see awaitTerminalFonts.
      await awaitTerminalFonts(term, fit, host, () => cancelled, () => ptyRef.current);
      if (cancelled) return;
      try { fit.fit(); } catch {}
      const shell = await loginShell();
      if (cancelled) return;
      try {
        const { id: ptyId } = await ipc.ptySpawn({
          cwd: taskPath, cmd: shell, args: ["-l"],
          // Signal terminal theme so prompts / status bars that honor
          // COLORFGBG (oh-my-zsh themes, starship, etc.) pick the right
          // colors for the current chrome.
          env: { COLORFGBG: currentColorFgBg() },
          // NEVER pass task_id here. The aux shell is a scratch
          // zsh for the user's own git/grep/etc work - sandboxing it
          // would block exactly the moves the user opened it for
          // (`gh pr create`, `kubectl get pods`, etc.). The agent CLI
          // is the only thing we sandbox; everything else inside the
          // task runs with the user's normal permissions.
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
        // Surface the shell's OSC 0/2 title (running command / cwd) so the
        // bottom tab can show it, matching the main agent tabs.
        term.onTitleChange(t => onTitleRef.current?.(t));
        setTimeout(() => { try { fit.fit(); } catch {} }, 200);
        // Reliable focus for user-created scratch shells (⇧⌘D / + / ⌘T).
        // We do it HERE, once the PTY is live and the grid has rendered,
        // because the external focus poll fires during the heavy mount and
        // the focus doesn't stick. Direct (no rAF: that freezes in occluded
        // windows). Gated on `autoFocus` (so launch-restored and
        // preview/footer shells never grab focus) and on still being the
        // active task (so a quick task switch mid-spawn can't yank
        // focus into a now-background terminal).
        if (autoFocus && !cancelled && (!taskId || useApp.getState().activeTaskId === taskId)) {
          try { term.focus(); } catch {}
        }
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
      disposeCopyOnSelect();
      disposeLinkOpener();
      unregisterDrop();
      disposeImeBridge();
      unlistenData?.(); unlistenExit?.();
      if (ptyRef.current) ipc.ptyKill(ptyRef.current).catch(() => {});
      // Dispose the renderer addon FIRST so its render loop can't fire
      // on a half-disposed terminal.
      try { rendererAddon?.dispose(); } catch {}
      term.dispose();
      // Null the refs so any late async callback's staleness check fails
      // closed instead of touching a disposed terminal (TerminalPane does
      // the same).
      termRef.current = null;
      fitRef.current = null;
    };
  }, [taskPath, gen]);

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
    // the main agent terminal on task switch. Stealing it here meant
    // typing immediately after switching tasks went into the scratch
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
    // No font-load settle needed here — see TerminalPane's font effect (GH #70).
  }, [terminalFontId, terminalFontSize, terminalLetterSpacing, terminalOptionAsMeta]);

  // Live theme swap mirrors TerminalPane's effect; see the comment there.
  const themeMode = usePrefs(s => s.themeMode);
  const customThemeRev = usePrefs(s => s.customThemeRev);
  const firstThemeRun = useRef(true);
  useEffect(() => {
    if (firstThemeRun.current) { firstThemeRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.theme = currentTerminalTheme() as any;
    t.options.minimumContrastRatio = currentMinimumContrastRatio();
  }, [themeMode, customThemeRev]);

  return (
    <div className="relative flex h-full w-full flex-col">
      {exited && (
        // In-flow banner above the terminal: the dead xterm stays
        // interactive so its scrollback is still selectable/copyable, and it
        // isn't covered. `gen++` relaunches a fresh shell.
        <TerminalExitedBanner
          label="Shell exited."
          actionLabel="New shell"
          icon={Plus}
          onAction={() => setGen(g => g + 1)}
        />
      )}
      <div ref={hostRef} className="min-h-0 w-full flex-1" />
    </div>
  );
}
