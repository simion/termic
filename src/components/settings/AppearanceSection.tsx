// Appearance — editor + terminal fonts (separate), font sizes, ligatures.
// Mirrors Termic's split: "Mono Font" governs the editor; "Terminal Font"
// governs xterm. Sizes are independent.

import { usePrefs, resolveTheme, BUNDLED_FONT_ID, MONO_FONT_OPTIONS, APPEARANCE_DEFAULTS, availableMonoFonts, availableMonoFontsAsync, sortFontOptions, stackFor } from "@/store/prefs";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { EDITOR_THEMES, resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { AuxTerminal } from "@/components/task/AuxTerminal";
import { homeDir } from "@/lib/ipc";
import { IS_MAC, ALT_LABEL, CMD_LABEL } from "@/lib/shortcuts";
import { EditorView } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";

export function AppearanceSection() {
  const editorFontId    = usePrefs(s => s.editorFontId);
  const setEditorFontId = usePrefs(s => s.setEditorFontId);
  const editorThemeId    = usePrefs(s => s.editorThemeId);
  const setEditorThemeId = usePrefs(s => s.setEditorThemeId);
  const terminalFontId  = usePrefs(s => s.terminalFontId);
  const setTerminalFontId = usePrefs(s => s.setTerminalFontId);
  const terminalFontSize = usePrefs(s => s.terminalFontSize);
  const setTerminalFontSize = usePrefs(s => s.setTerminalFontSize);
  const terminalLetterSpacing = usePrefs(s => s.terminalLetterSpacing);
  const setTerminalLetterSpacing = usePrefs(s => s.setTerminalLetterSpacing);
  const terminalScrollback = usePrefs(s => s.terminalScrollback);
  const setTerminalScrollback = usePrefs(s => s.setTerminalScrollback);
  const terminalOptionAsMeta = usePrefs(s => s.terminalOptionAsMeta);
  const setTerminalOptionAsMeta = usePrefs(s => s.setTerminalOptionAsMeta);
  const terminalGpuEnabled = usePrefs(s => s.terminalGpuEnabled);
  const setTerminalGpuEnabled = usePrefs(s => s.setTerminalGpuEnabled);
  const editorFontSize = usePrefs(s => s.editorFontSize);
  const setEditorFontSize = usePrefs(s => s.setEditorFontSize);
  const uiScale = usePrefs(s => s.uiScale);
  const setUiScale = usePrefs(s => s.setUiScale);
  const codeLigatures = usePrefs(s => s.codeLigatures);
  const setCodeLigatures = usePrefs(s => s.setCodeLigatures);
  const showAllInstalledFonts = usePrefs(s => s.showAllInstalledFonts);
  const resetAppearance = usePrefs(s => s.resetAppearance);

  // Start with the curated subset so the picker is usable instantly, then
  // upgrade to the full system list when font-kit comes back (~50–200ms).
  // The currently-selected system: fonts are seeded into the initial list —
  // a <select> whose value has no matching <option> renders blank, and the
  // native popup won't take options added while it's open.
  const [fonts, setFonts] = useState(() =>
    withSelectedFonts(availableMonoFonts(), [editorFontId, terminalFontId]));
  // Re-runs when the show-all toggle flips: the font lists are cached
  // process-wide after the first enumeration, so the re-merge is instant.
  // The cancelled flag matters during that first enumeration window — a
  // flip mid-flight would otherwise race two calls, and the earlier
  // mode's result could resolve last and win.
  useEffect(() => {
    let cancelled = false;
    availableMonoFontsAsync(showAllInstalledFonts)
      .then(list => {
        if (cancelled) return;
        // Read the selected ids at resolve time, not mount time: the async
        // list is a filtered SUBSET of the instant curated list, so a pick
        // made while font-kit was still enumerating would otherwise vanish
        // from the list and blank the <select>.
        const { editorFontId, terminalFontId } = usePrefs.getState();
        setFonts(withSelectedFonts(list, [editorFontId, terminalFontId]));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [showAllInstalledFonts]);

  // Disable the reset button when every appearance pref already matches
  // the factory defaults — nothing to undo.
  const atDefaults =
    editorFontId          === APPEARANCE_DEFAULTS.editorFontId &&
    terminalFontId        === APPEARANCE_DEFAULTS.terminalFontId &&
    terminalFontSize      === APPEARANCE_DEFAULTS.terminalFontSize &&
    terminalLetterSpacing === APPEARANCE_DEFAULTS.terminalLetterSpacing &&
    terminalScrollback    === APPEARANCE_DEFAULTS.terminalScrollback &&
    terminalOptionAsMeta  === APPEARANCE_DEFAULTS.terminalOptionAsMeta &&
    terminalGpuEnabled    === APPEARANCE_DEFAULTS.terminalGpuEnabled &&
    editorFontSize        === APPEARANCE_DEFAULTS.editorFontSize &&
    uiScale               === APPEARANCE_DEFAULTS.uiScale &&
    codeLigatures         === APPEARANCE_DEFAULTS.codeLigatures &&
    showAllInstalledFonts === APPEARANCE_DEFAULTS.showAllInstalledFonts;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[20px] font-medium">Appearance</h1>
        <Button
          variant="secondary"
          size="sm"
          disabled={atDefaults}
          onClick={resetAppearance}
          title="Restore fonts, sizes, zoom, letter spacing, ligatures and font list filtering to their defaults."
        >
          Reset to defaults
        </Button>
      </div>

      <Field
        label="Editor font"
        hint="Font for the code editor and diff viewer."
        control={
          <FontSelect value={editorFontId} onChange={setEditorFontId} fonts={fonts} />
        }
      />

      <Field
        label="Editor theme"
        hint="Syntax color scheme for the code editor and diff viewer."
        control={
          <ThemeSelect value={editorThemeId} onChange={setEditorThemeId} />
        }
      />

      <CodePreview />

      <Field
        label="Editor font size"
        hint={`${editorFontSize}px`}
        control={
          <NumberInput value={editorFontSize} onChange={setEditorFontSize} min={10} max={20} />
        }
      />

      <Toggle
        label="Code ligatures"
        hint="Render font ligatures like `=>`, `!==`, `>=` as combined glyphs in the editor."
        value={codeLigatures}
        onChange={setCodeLigatures}
      />

      <Divider />

      <Field
        label="Terminal font"
        hint="Font for all xterm terminals (main + scratch shell)."
        control={
          <FontSelect value={terminalFontId} onChange={setTerminalFontId} fonts={fonts} />
        }
      />

      <Field
        label="Terminal font size"
        hint={`${terminalFontSize}px`}
        control={
          <NumberInput value={terminalFontSize} onChange={setTerminalFontSize} min={10} max={20} />
        }
      />

      <Field
        label="Terminal letter spacing"
        hint={`${terminalLetterSpacing}px added per cell. xterm packs glyphs snug; bump 1–2px to match iTerm / Terminal.app spacing.`}
        control={
          <LetterSpacingPicker value={terminalLetterSpacing} onChange={setTerminalLetterSpacing} />
        }
      />

      <Field
        label="Terminal scrollback"
        hint={`${terminalScrollback.toLocaleString()} lines. Agent terminals keep this many lines; the scratch shell keeps half.`}
        control={
          <NumberInput value={terminalScrollback} onChange={setTerminalScrollback} min={1000} max={100000} step={1000} />
        }
      />

      {IS_MAC && (
        <Toggle
          label={`Use ${ALT_LABEL} as Meta key`}
          hint={`Send ${ALT_LABEL}+key as an ESC-prefixed sequence so terminal editors (vim, emacs, nano) see it as Meta/Alt. When off, ${ALT_LABEL} types accented characters as usual.`}
          value={terminalOptionAsMeta}
          onChange={setTerminalOptionAsMeta}
        />
      )}

      {/* Linux/Windows only: macOS WKWebView always has a working GPU path,
          so exposing this there would only let a Mac user accidentally
          downgrade themselves to the slower DOM renderer. */}
      {!IS_MAC && (
        <Toggle
          label="GPU (WebGL) terminal renderer"
          hint="On is the fast path. Turn off if typing feels laggy: some Linux/WebKitGTK setups run WebGL on a software rasterizer where the plain renderer is faster. Applies to terminals opened after the change (relaunch to switch every terminal)."
          value={terminalGpuEnabled}
          onChange={setTerminalGpuEnabled}
        />
      )}

      {/* Live terminal preview — spawns a real shell in $HOME so
          font + size + weight changes are reflected immediately
          with real keystrokes, cursor blink, and ANSI colors.
          Fixed height so font resizes don't push the page around. */}
      <TerminalPreview />
      {/* Legacy static preview (kept off behind the `false` gate so
          a future revert is a one-flag change). */}
      {false && (<div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[var(--color-fg)]"
           style={{ fontFamily: stackFor(terminalFontId), fontSize: `${terminalFontSize}px`, lineHeight: 1.4 }}>
        <span className="text-[#7cd57e]">~/project</span> <span className="text-[#d97757]">main</span> <span className="text-[#f0b13a]">±3</span><br/>
        <span className="text-[#d97757]">{"〉"}</span> npm test <span className="text-[#7cd57e]">✓</span><br/>
        <span className="text-[#a7f3a0]">└─▶ All tests passed!</span>
      </div>)}

      <PanesSection />

      <Divider />

      <Field
        label="UI zoom"
        hint={`${uiScale}% of native. Scales the whole app (sidebar, tabs, files and git panels, terminals) like browser zoom.\nShortcuts: ${CMD_LABEL} +, ${CMD_LABEL} -, ${CMD_LABEL} 0.`}
        control={
          <NumberInput value={uiScale} onChange={setUiScale} min={50} max={200} step={10} />
        }
      />
    </div>
  );
}

function PanesSection() {
  const splitPaneDim = usePrefs(s => s.splitPaneDim);
  const setSplitPaneDim = usePrefs(s => s.setSplitPaneDim);
  const splitPaneDimAmount = usePrefs(s => s.splitPaneDimAmount);
  const setSplitPaneDimAmount = usePrefs(s => s.setSplitPaneDimAmount);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-[15px] font-medium">Panes</h2>
      <Toggle
        label="Dim inactive split panes"
        hint="Overlay a dark mask over split panes that do not have keyboard focus."
        value={splitPaneDim}
        onChange={setSplitPaneDim}
      />
      {splitPaneDim && (
        <Field
          label="Dimming amount"
          hint={`${splitPaneDimAmount}%`}
          control={
            <input
              type="range"
              min={0}
              max={80}
              step={1}
              value={splitPaneDimAmount}
              onChange={e => setSplitPaneDimAmount(Number(e.target.value))}
              className="w-32"
            />
          }
        />
      )}
    </div>
  );
}

function TerminalPreview() {
  const [home, setHome] = useState<string>("");
  useEffect(() => { void homeDir().then(setHome).catch(() => setHome("/tmp")); }, []);
  if (!home) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)]" style={{ height: 380 }}>
      <AuxTerminal taskPath={home} active={true} />
    </div>
  );
}

function Field({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 whitespace-pre-line text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/** Ensure every selected font id has an entry in the option list — a
 *  <select> whose value has no matching <option> renders blank. Covers two
 *  cases: `system:` ids before the system scan finishes (the family name
 *  lives in the id, so an entry is synthesized from it), and curated ids
 *  whose font the installed-only filter dropped (the font was uninstalled
 *  after being chosen — the pick must stay visible and re-selectable). */
function withSelectedFonts(list: typeof MONO_FONT_OPTIONS, ids: string[]) {
  const extras = [...new Set(ids)]
    .filter(id => !list.some(o => o.id === id))
    .flatMap(id => {
      if (id.startsWith("system:")) return [{ id, label: id.slice(7), stack: stackFor(id) }];
      const curated = MONO_FONT_OPTIONS.find(o => o.id === id);
      return curated ? [curated] : [];
    });
  // Re-sort so rescued entries land in alphabetical position, not at the end.
  return extras.length ? sortFontOptions([...list, ...extras]) : list;
}

function FontSelect({ value, onChange, fonts }: {
  value: string;
  onChange: (id: string) => void;
  fonts: typeof MONO_FONT_OPTIONS;
}) {
  // One shared pref rendered on each picker (it widens the list both feed
  // from), so the affordance sits with the control it affects instead of
  // as a page-level toggle that looks tied to whichever picker it's near.
  const showAll = usePrefs(s => s.showAllInstalledFonts);
  const setShowAll = usePrefs(s => s.setShowAllInstalledFonts);
  // The bundled default is pinned first by sortFontOptions; give it its own
  // labeled group so it doesn't read as a sorting glitch above the A-Z list.
  const bundled = fonts.filter(f => f.id === BUNDLED_FONT_ID);
  const installed = fonts.filter(f => f.id !== BUNDLED_FONT_ID);
  const renderOption = (f: typeof MONO_FONT_OPTIONS[number]) => (
    <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>{f.label}</option>
  );
  return (
    <div className="flex flex-col items-end gap-1.5">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[180px]"
      >
        <optgroup label="Bundled">{bundled.map(renderOption)}</optgroup>
        <optgroup label="Installed">{installed.map(renderOption)}</optgroup>
      </select>
      <label
        title="List every installed font family, not just fonts detected as monospace. Applies to both font pickers. Proportional fonts will misalign terminal output."
        className="flex cursor-pointer select-none items-center gap-1.5 text-[12px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
      >
        <Checkbox checked={showAll} onChange={setShowAll} className="h-3.5 w-3.5" />
        <span>Show all fonts</span>
      </label>
    </div>
  );
}

function ThemeSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[180px]"
    >
      {EDITOR_THEMES.map(t => (
        <option key={t.id} value={t.id}>{t.label}</option>
      ))}
    </select>
  );
}

// Compact integer stepper. Replaces the previous range slider — direct
// keyboard entry + step buttons is faster than dragging a slider to hit
// a specific px value, especially for the small 10..20 range we expose.
function NumberInput({ value, onChange, min, max, step = 1 }: { value: number; onChange: (n: number) => void; min: number; max: number; step?: number }) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  return (
    <input
      type="number" min={min} max={max} step={step} value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(clamp(n));
      }}
      className="h-7 w-[64px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12.5px] text-[var(--color-fg)] tabular-nums focus:border-[var(--color-accent-soft)] focus:outline-none"
    />
  );
}

// Integer px only. Fractional values misalign the WebGL atlas; values
// beyond ~3px start making TUI column math read wrong.
const LETTER_SPACINGS: { px: number; label: string }[] = [
  { px: 0, label: "Compact" },
  { px: 1, label: "Default" },
  { px: 2, label: "Roomy" },
  { px: 3, label: "Wide" },
];

function LetterSpacingPicker({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  return (
    <div className="inline-flex items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
      {LETTER_SPACINGS.map(({ px, label }) => (
        <button
          key={px} type="button" onClick={() => onChange(px)}
          className={cn(
            "h-7 rounded-[5px] px-2.5 text-[12px] transition-colors",
            value === px
              ? "bg-[var(--color-accent-deep)] text-white"
              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
          )}
        >{label}</button>
      ))}
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 whitespace-pre-line text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      </div>
      {/* 100% inline-style geometry — Tailwind size utilities were getting
          shrunk by something (still investigating: possibly user-agent button
          width or some flex parent). Hard-coding sidesteps the question. */}
      <button
        role="switch" aria-checked={value} onClick={() => onChange(!value)}
        style={{
          position: "relative",
          width: 36, height: 20,
          flexShrink: 0,
          borderRadius: 999,
          padding: 0, border: 0,
          background: value ? "var(--color-accent)" : "var(--color-bg-3)",
          transition: "background-color 150ms",
          cursor: "pointer",
          display: "inline-block",
          verticalAlign: "middle",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: value ? 18 : 2,
            width: 16, height: 16,
            borderRadius: 999,
            /* Dark ink knob on a filled track (see GeneralSection Toggle). */
            background: value ? "var(--color-accent-fg)" : "#ffffff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 150ms, background-color 150ms",
          }}
        />
      </button>
    </div>
  );
}

function Divider() { return <div className="h-px bg-[var(--color-border-soft)]" />; }

const CODE_SAMPLE = `// Fetch user data
async function getUser(id: number) {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}`;

function CodePreview() {
  const themeId  = usePrefs(s => s.editorThemeId);
  const size     = usePrefs(s => s.editorFontSize);
  const ligatures = usePrefs(s => s.codeLigatures);
  const themeMode = usePrefs(s => s.themeMode);
  const appIsLight = resolveTheme(themeMode) === "light";
  const hostRef  = useRef<HTMLDivElement>(null);
  const viewRef  = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: CODE_SAMPLE,
        extensions: [
          javascript({ typescript: true }),
          EditorView.editable.of(false),
          EditorView.theme({ "&.cm-editor": { outline: "none" } }),
          themeComp.current.of([
            resolveEditorTheme(themeId, appIsLight),
            editorSurfaceTheme(size, ligatures),
          ]),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  // theme/size/ligatures are picked up by the reconfigure effect below
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({
      effects: themeComp.current.reconfigure([
        resolveEditorTheme(themeId, appIsLight),
        editorSurfaceTheme(size, ligatures),
      ]),
    });
  }, [themeId, size, ligatures, appIsLight]);

  return (
    <div ref={hostRef} className="rounded-lg border border-[var(--color-border-soft)] overflow-hidden bg-[var(--color-bg)]" />
  );
}
