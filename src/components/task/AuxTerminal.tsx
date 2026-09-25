// Auxiliary shell in the right-panel footer / main-pane split. Spawns the
// user's login shell ($SHELL, see loginShell) in the task path so the
// user has a scratch terminal for git/grep/etc. without touching the agent
// CLI's PTY.
//
// When the shell exits (Ctrl+D, `exit`, crash) we surface a non-blocking
// bottom banner with a "New shell" button — clicking it bumps a generation
// counter that retears down the xterm + spawns a fresh PTY.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Osc52Base64 } from "@/lib/osc52";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { attachCmdClickLinkOpener } from "@/lib/termLinkOpener";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openWebUrl, browserCommandForTask } from "@/lib/previewBrowser";
import { loadTerminalRenderer, awaitTerminalFonts } from "@/lib/terminalRenderer";
import { resyncViewportAfterReveal } from "@/lib/xtermViewportSync";
import { registerTerminalDropTarget } from "@/lib/terminalDrop";
import { attachCopyOnSelect } from "@/lib/terminalSelection";
import { setupImeReplacementBridge } from "@/lib/ime";
import * as ipc from "@/lib/ipc";
import { loginShell } from "@/lib/loginShell";
import { TerminalExitedBanner } from "@/components/task/TerminalExitedBanner";
import { SudoTouchIdBanner } from "@/components/task/SudoTouchIdBanner";
import { TerminalFindBar } from "@/components/task/TerminalFindBar";
import { isTerminalFindCombo } from "@/lib/terminalFind";
import { usePrefs, useResolvedThemeFull, currentTerminalStack, currentTerminalTheme, currentColorFgBg, currentMinimumContrastRatio } from "@/store/prefs";
import { useApp } from "@/store/app";
import { IS_MAC, bindingMatches } from "@/lib/shortcuts";

// Theme is no longer a module-level constant - see TerminalPane for why.
// `currentTerminalTheme()` picks the matching palette at mount; the
// themeMode effect below pushes updates into live instances.

export function AuxTerminal({ taskId, tabId, taskPath, active, autoFocus, onExited, onTitle, initialInput }: { taskId?: string; tabId?: string; taskPath: string; active: boolean; autoFocus?: boolean; onExited?: () => void; onTitle?: (title: string) => void;
  /** Typed at the prompt on spawn. Runs only if it ends with a CR. */
  initialInput?: string }) {
  const { t } = useTranslation("task");
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
  // Scratch shells have no agent-settle detection, so commands run here
  // (git, npm, rm) were invisible to the file tree / Git tab until the next
  // poll or agent turn. Cheap stand-in: Enter in the shell + the shell's
  // OSC 0/2 title updates (precmd/preexec in most zsh setups) both hint
  // "a command ran" — debounce them into one bumpFsRevision. False fires
  // are fine: every consumer dedupes against unchanged content.
  const fsBumpTimer = useRef<number | null>(null);
  const scheduleFsBump = () => {
    if (!taskId) return;
    const id = taskId;
    if (fsBumpTimer.current !== null) window.clearTimeout(fsBumpTimer.current);
    fsBumpTimer.current = window.setTimeout(() => {
      fsBumpTimer.current = null;
      useApp.getState().bumpFsRevision(id);
    }, 750);
  };
  useEffect(() => () => {
    if (fsBumpTimer.current !== null) window.clearTimeout(fsBumpTimer.current);
  }, []);
  // Visible when the PTY exits — overlays the dead terminal with a CTA.
  const [exited, setExited] = useState(false);
  // Rust's "this PTY is at a sudo password prompt" signal (sudo_touchid.rs).
  const [sudoOffer, setSudoOffer] = useState(false);
  // Find in terminal, same bar and same key as the agent/shell tabs.
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const offerTouchIdForSudo = usePrefs(s => s.offerTouchIdForSudo);
  // Has `initialInput` reached the PTY? Surfaced on the host element because
  // the alternative for anything waiting on it is a sleep: the spawn is async
  // (login shell lookup, ptySpawn, attach) so the container exists well before
  // the prompt is primed, and a keystroke sent into that gap is swallowed by
  // an xterm that has not wired its handler yet. Same failure the agent specs
  // hit before `waitForAgentReady` existed.
  const [primed, setPrimed] = useState(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    // Drop target: dragging a file onto the scratch shell inserts its
    // escaped path at the prompt — same affordance as the agent terminals.
    // taskId lets a path dragged out of this task's file tree arrive relative
    // (the scratch shell also starts at the task root). Finder drops are
    // unaffected: no taskId is consulted on that path.
    const unregisterDrop = registerTerminalDropTarget(host, () => ptyRef.current, { taskId });
    setExited(false);
    setPrimed(false);
    setSudoOffer(false);
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenSudo: (() => void) | null = null;

    // Clickable links — same model as TerminalPane: always loaded so URLs
    // underline on hover, opening gated on Cmd/Ctrl so a plain click still
    // selects. Routes through `open_path` for the system browser (#14).
    const openLink = (via: string) => (uri: string) => {
      ipc.logLine(`[link] scratch activate via=${via} uri=${uri}`).catch(() => {});
      // GH #245, same rule as TerminalPane: configured browser or the
      // untouched pre-#245 default path.
      const browser = browserCommandForTask(taskId);
      if (browser) { void openWebUrl(uri, browser); return; }
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
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
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
    // Mirror TerminalPane's IME handling: the shared bridge forwards WebKit
    // Korean input that xterm drops, while real composition sessions stay
    // with xterm. The guard below leaves native text editing enabled.
    // See src/lib/ime.ts for ownership of the input events.
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
      if (e.type === "keydown" && isTerminalFindCombo(e, IS_MAC)) {
        setSearchOpen(true);
        e.preventDefault();
        e.stopPropagation();
        return false;
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
          // `role` is the sandbox-neutral identity that keeps the shell
          // reachable for `termic attach --shell` / `logs --shell`.
          role: taskId ? { task_id: taskId, kind: "aux" as const } : undefined,
          // Reporting only (Activity monitor). Safe to set even where
          // `task_id` above must stay unset: nothing branches on it.
          owner: { task_id: taskId, tab_id: tabId, kind: "aux" as const },
          rows: Math.max(8, term.rows), cols: Math.max(40, term.cols),
        });
        if (cancelled) { ipc.ptyKill(ptyId).catch(() => {}); return; }
        ptyRef.current = ptyId;
        // The prefill waits for the shell's FIRST OUTPUT, which is its prompt.
        //
        // Writing it right after the spawn puts it into the tty before zsh has
        // started. The line discipline echoes it raw there and then, zsh comes
        // up, reads the same bytes as type-ahead, and renders them AGAIN at its
        // prompt: the user sees the command twice, once as a stray line above
        // the prompt and once in it. Reported with a screenshot of exactly
        // that. Waiting for the prompt means ZLE is running and renders it
        // once, where the user can edit it.
        let sentInitial = false;
        unlistenData = await ipc.onPtyData(ptyId, u8 => {
          term.write(u8);
          if (!initialInput || sentInitial || cancelled) return;
          sentInitial = true;
          ipc.ptyWrite(ptyId, Array.from(new TextEncoder().encode(initialInput)))
            .then(() => { if (!cancelled) setPrimed(true); })
            .catch(() => {});
        });
        // Output is held Rust-side until this lands: anything emitted before
        // the listener exists is dropped (see ipc.ptyAttached).
        ipc.ptyAttached(ptyId).catch(() => {});
        unlistenSudo = await ipc.onPtySudoTouchId(ptyId, show => {
          if (!cancelled) setSudoOffer(show);
        });
        unlistenExit = await ipc.onPtyExit(ptyId, () => {
          ptyRef.current = null;
          setSudoOffer(false);
          // Bottom-split shells: parent passes onExited to close the
          // tab immediately (the tab strip is the affordance for
          // spawning a new one). Standalone previews keep the
          // "New shell" CTA overlay.
          if (onExited) onExited();
          else setExited(true);
        });
        // `initialInput` types a command at the prompt WITHOUT running it
        // (GH #285). The clone flow lands the user on `git clone <url> <dir>`
        // ready to edit: flags like --depth, --branch or --recurse-submodules
        // are exactly the kind of thing a form would have to grow a field for,
        // and the shell already has an editor.
        //
        // Whether it RUNS is the caller's choice and is carried by the string:
        // ending it with a CR runs it, leaving it bare types it and waits. The
        // clone flow ends it with a CR, because clicking Clone is already the
        // decision. Same mechanic as dropping a file onto a scratch shell
        // (lib/terminalDrop.ts), which inserts a path the same way and never
        // runs it. The write itself is in the data handler above, on the first
        // byte the shell sends, for the reason documented there.
        term.onData(d => {
          if (d.includes("\r")) scheduleFsBump();
          ipc.ptyWrite(ptyId, Array.from(new TextEncoder().encode(d))).catch(() => {});
        });
        term.onResize(({ cols, rows }) => ipc.ptyResize(ptyId, rows, cols).catch(() => {}));
        // Surface the shell's OSC 0/2 title (running command / cwd) so the
        // bottom tab can show it, matching the main agent tabs. Title
        // changes also feed the debounced fs bump: shells that set the
        // title from precmd fire it right when a command finishes, which
        // catches commands that outlive the Enter-keyed debounce.
        term.onTitleChange(t => { onTitleRef.current?.(t); scheduleFsBump(); });
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
    // The zero → non-zero edge also repairs the viewport scroller: WKWebView
    // zeroes .xterm-viewport's scrollTop inside a display:none subtree
    // (collapsed split, inactive bottom tab, hidden task), and a fit() that
    // lands on unchanged dims gives xterm no event to re-sync it — the shell
    // reads as scroll-locked until output scrolls the buffer. See
    // lib/xtermViewportSync.
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
    ro.observe(hostRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      disposeCopyOnSelect();
      disposeLinkOpener();
      unregisterDrop();
      disposeImeBridge();
      unlistenData?.(); unlistenExit?.(); unlistenSudo?.();
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
    // taskId moves in lockstep with taskPath, so listing it can't cause an
    // extra respawn.
  }, [taskPath, taskId, gen]);

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
  const themeKey = useResolvedThemeFull();
  const customThemeRev = usePrefs(s => s.customThemeRev);
  const firstThemeRun = useRef(true);
  useEffect(() => {
    if (firstThemeRun.current) { firstThemeRun.current = false; return; }
    const t = termRef.current;
    if (!t) return;
    t.options.theme = currentTerminalTheme() as any;
    t.options.minimumContrastRatio = currentMinimumContrastRatio();
  }, [themeKey, customThemeRev]);

  return (
    <div className="relative flex h-full w-full flex-col">
      {sudoOffer && offerTouchIdForSudo && !exited && (
        <SudoTouchIdBanner taskId={taskId} onDismiss={() => setSudoOffer(false)} />
      )}
      <TerminalFindBar
        open={searchOpen}
        onClose={() => { setSearchOpen(false); termRef.current?.focus(); }}
        termRef={termRef}
        addonRef={searchAddonRef}
      />
      {exited && (
        // In-flow banner above the terminal: the dead xterm stays
        // interactive so its scrollback is still selectable/copyable, and it
        // isn't covered. `gen++` relaunches a fresh shell.
        <TerminalExitedBanner
          label={t("aux.shellExited")}
          actionLabel={t("aux.newShell")}
          icon={Plus}
          onAction={() => setGen(g => g + 1)}
        />
      )}
      <div
        ref={hostRef}
        className="min-h-0 w-full flex-1"
        // Only meaningful when the caller primed the prompt; absent otherwise
        // so an ordinary scratch shell grows no attribute it does not need.
        data-initial-input={initialInput ? (primed ? "sent" : "pending") : undefined}
      />
    </div>
  );
}
