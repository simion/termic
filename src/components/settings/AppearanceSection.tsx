// Appearance — editor + terminal fonts (separate), font sizes, ligatures.
// Mirrors Termic's split: "Mono Font" governs the editor; "Terminal Font"
// governs xterm. Sizes are independent.

import { CodeIntelServers } from "./CodeIntelServers";
import { usePrefs, resolveTheme, BUNDLED_FONT_ID, MONO_FONT_OPTIONS, APPEARANCE_DEFAULTS, availableMonoFonts, availableMonoFontsAsync, sortFontOptions, stackFor } from "@/store/prefs";
import type { TerminalRendererKind } from "@/store/prefs";
import { useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { codeIntelName } from "@/lib/lsp/featureName";
import { EDITOR_THEMES, resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Tip } from "@/components/ui/Tooltip";
import { AuxTerminal } from "@/components/task/AuxTerminal";
import { homeDir } from "@/lib/ipc";
import { IS_MAC, ALT_LABEL, CMD_LABEL } from "@/lib/shortcuts";
import { EditorView } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";

type AppearanceTab = "terminal" | "editor" | "interface";

const TABS: { id: AppearanceTab; labelKey: string }[] = [
  { id: "terminal",  labelKey: "appearance.tabTerminal" },
  { id: "editor",    labelKey: "appearance.tabEditor" },
  { id: "interface", labelKey: "appearance.tabInterface" },
];

export function AppearanceSection() {
  const { t } = useTranslation("settings");
  // Terminal leads: the embedded terminal is the product, and it is the font
  // stack people come here to change.
  const [subTab, setSubTab] = useState<AppearanceTab>("terminal");
  const [serversOpen, setServersOpen] = useState(false);
  // ...which means the landing tab is the one whose preview spawns a REAL pty
  // (TerminalPreview -> AuxTerminal). Mounting it on arrival would start a
  // shell in $HOME every time Appearance opens, including drive-by visits to
  // the other two tabs. So the preview arms on the first interaction with the
  // strip instead: land here and you get a one-click placeholder, come back
  // to the tab and it mounts straight away.
  const [previewArmed, setPreviewArmed] = useState(false);
  const selectTab = (id: AppearanceTab) => { setPreviewArmed(true); setSubTab(id); };
  const editorFontId    = usePrefs(s => s.editorFontId);
  const setEditorFontId = usePrefs(s => s.setEditorFontId);
  const editorThemeIdDark    = usePrefs(s => s.editorThemeIdDark);
  const setEditorThemeIdDark = usePrefs(s => s.setEditorThemeIdDark);
  const editorThemeIdLight    = usePrefs(s => s.editorThemeIdLight);
  const setEditorThemeIdLight = usePrefs(s => s.setEditorThemeIdLight);
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
  const terminalRenderer = usePrefs(s => s.terminalRenderer);
  const setTerminalRenderer = usePrefs(s => s.setTerminalRenderer);
  const editorFontSize = usePrefs(s => s.editorFontSize);
  const setEditorFontSize = usePrefs(s => s.setEditorFontSize);
  const uiScale = usePrefs(s => s.uiScale);
  const setUiScale = usePrefs(s => s.setUiScale);
  const codeLigatures = usePrefs(s => s.codeLigatures);
  const inlineBlame = usePrefs(s => s.inlineBlame);
  const editorWordWrap = usePrefs(s => s.editorWordWrap);
  const setEditorWordWrap = usePrefs(s => s.setEditorWordWrap);
  const codeIntelligence = usePrefs(s => s.codeIntelligence);
  const codeIntelDiagnostics = usePrefs(s => s.codeIntelDiagnostics);
  const setCodeIntelDiagnostics = usePrefs(s => s.setCodeIntelDiagnostics);
  const setCodeIntelligence = usePrefs(s => s.setCodeIntelligence);
  const setInlineBlame = usePrefs(s => s.setInlineBlame);
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
    terminalRenderer      === APPEARANCE_DEFAULTS.terminalRenderer &&
    editorFontSize        === APPEARANCE_DEFAULTS.editorFontSize &&
    uiScale               === APPEARANCE_DEFAULTS.uiScale &&
    codeLigatures         === APPEARANCE_DEFAULTS.codeLigatures &&
    inlineBlame           === APPEARANCE_DEFAULTS.inlineBlame &&
    editorWordWrap        === APPEARANCE_DEFAULTS.editorWordWrap &&
    codeIntelligence        === APPEARANCE_DEFAULTS.codeIntelligence &&
    codeIntelDiagnostics    === APPEARANCE_DEFAULTS.codeIntelDiagnostics &&
    showAllInstalledFonts === APPEARANCE_DEFAULTS.showAllInstalledFonts;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[20px] font-medium">{t("rail.appearance")}</h1>
        <Button
          variant="secondary"
          size="sm"
          disabled={atDefaults}
          onClick={resetAppearance}
          title={t("appearance.resetTip")}
        >
          {t("appearance.reset")}
        </Button>
      </div>

      {/* Sub-tabs, same strip as Settings → Projects. Terminal and Editor are
          two independent font/size stacks that were only adjacent because they
          were both "appearance"; reading one meant scrolling past the other,
          and the page carried both live previews at once. Leaving a tab
          unmounts its preview, which kills the terminal one's pty
          (AuxTerminal.tsx). */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)]">
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            data-appearance-tab={tab.id}
            onClick={() => selectTab(tab.id)}
            className={cn(
              "relative -mb-px flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
              subTab === tab.id
                ? "text-[var(--color-fg)]"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
            )}
          >
            {t(tab.labelKey)}
            {subTab === tab.id && (
              <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t bg-[var(--color-accent)]" />
            )}
          </button>
        ))}
      </div>

      {subTab === "terminal" && <div className="flex flex-col gap-8">
      <Field
        label={t("appearance.termFont.label")}
        hint={t("appearance.termFont.hint")}
        control={
          <FontSelect value={terminalFontId} onChange={setTerminalFontId} fonts={fonts} />
        }
      />

      <Field
        label={t("appearance.termFontSize.label")}
        hint={t("appearance.termFontSize.hint", { size: terminalFontSize })}
        control={
          <NumberInput value={terminalFontSize} onChange={setTerminalFontSize} min={10} max={20} />
        }
      />

      <Field
        label={t("appearance.letterSpacing.label")}
        hint={t("appearance.letterSpacing.hint", { spacing: terminalLetterSpacing })}
        control={
          <LetterSpacingPicker value={terminalLetterSpacing} onChange={setTerminalLetterSpacing} />
        }
      />

      <Field
        label={t("appearance.scrollback.label")}
        hint={t("appearance.scrollback.hint", { count: terminalScrollback.toLocaleString() })}
        control={
          <NumberInput value={terminalScrollback} onChange={setTerminalScrollback} min={1000} max={100000} step={1000} />
        }
      />

      {IS_MAC && (
        <Toggle
          label={t("appearance.meta.label", { alt: ALT_LABEL })}
          hint={t("appearance.meta.hint", { alt: ALT_LABEL })}
          value={terminalOptionAsMeta}
          onChange={setTerminalOptionAsMeta}
        />
      )}

      {/* All platforms (GH #140). Was a WebGL on/off toggle justified by a
          macOS 26 battery claim; measurement did not support that, so the
          framing is now "pick the renderer that suits the machine" and canvas
          exists as the actual idle-cost lever. Numbers behind the hints, one
          idle terminal maximized at ~3.4M device px, total CPU across
          WindowServer + WebContent + WebKit.GPU + app, M1 Max / macOS 26.5:
          idle canvas 8.7 / webgl 13.7 / dom 14.6, and under sustained output
          webgl 30% of a core against canvas 75% and dom 80%. So WebGL stays
          the default, canvas only wins when terminals mostly sit idle, and
          DOM is a compatibility fallback rather than a saving. */}
      <Field
        label={t("appearance.renderer.label")}
        hint={t("appearance.renderer.hint")}
        control={<RendererPicker value={terminalRenderer} onChange={setTerminalRenderer} />}
      />

      {/* Live terminal preview — spawns a real shell in $HOME so
          font + size + weight changes are reflected immediately
          with real keystrokes, cursor blink, and ANSI colors.
          Fixed height so font resizes don't push the page around.
          Gated on previewArmed: this is the landing tab, and a settings
          visit should not fork a shell on its own. One click, and it stays
          mounted for the rest of this Appearance session. */}
      {previewArmed ? (
        <TerminalPreview />
      ) : (
        <button
          type="button"
          data-testid="terminal-preview-start"
          onClick={() => setPreviewArmed(true)}
          className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-6 text-[13px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]"
        >
          <span className="font-medium">{t("appearance.preview.show")}</span>
          <span className="text-[12px] text-[var(--color-fg-faint)]">
            {t("appearance.preview.hint")}
          </span>
        </button>
      )}
      {/* Legacy static preview (kept off behind the `false` gate so
          a future revert is a one-flag change). */}
      {false && (<div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[var(--color-fg)]"
           style={{ fontFamily: stackFor(terminalFontId), fontSize: `${terminalFontSize}px`, lineHeight: 1.4 }}>
        <span className="text-[#7cd57e]">~/project</span> <span className="text-[#d97757]">main</span> <span className="text-[#f0b13a]">±3</span><br/>
        <span className="text-[#d97757]">{"〉"}</span> npm test <span className="text-[#7cd57e]">✓</span><br/>
        <span className="text-[#a7f3a0]">└─▶ All tests passed!</span>
      </div>)}
      </div>}

      {subTab === "editor" && <div className="flex flex-col gap-8">
      <Field
        label={t("appearance.editorFont.label")}
        hint={t("appearance.editorFont.hint")}
        control={
          <FontSelect value={editorFontId} onChange={setEditorFontId} fonts={fonts} />
        }
      />

      <Field
        label={t("appearance.themeDark.label")}
        hint={t("appearance.themeDark.hint")}
        control={
          <ThemeSelect value={editorThemeIdDark} onChange={setEditorThemeIdDark} />
        }
      />

      <Field
        label={t("appearance.themeLight.label")}
        hint={t("appearance.themeLight.hint")}
        control={
          <ThemeSelect value={editorThemeIdLight} onChange={setEditorThemeIdLight} />
        }
      />

      <CodePreview />

      <Field
        label={t("appearance.editorFontSize.label")}
        hint={t("appearance.editorFontSize.hint", { size: editorFontSize })}
        control={
          <NumberInput value={editorFontSize} onChange={setEditorFontSize} min={10} max={20} />
        }
      />

      <Toggle
        label={t("appearance.ligatures.label")}
        hint={t("appearance.ligatures.hint")}
        value={codeLigatures}
        onChange={setCodeLigatures}
      />

      <Toggle
        label={t("appearance.wordWrap.label")}
        hint={t("appearance.wordWrap.hint")}
        value={editorWordWrap}
        onChange={setEditorWordWrap}
      />

      <Toggle
        label={t("appearance.blame.label")}
        hint={t("appearance.blame.hint")}
        value={inlineBlame}
        onChange={setInlineBlame}
      />

      {/* ONE bounded section, not three loose toggles among the editor's.
          Everything here belongs to the same feature and the same decision,
          and read as a flat list it was impossible to tell where "code
          intelligence" started and the editor's own preferences stopped. The
          border is doing the work a heading alone could not. */}
      {/* Grouped by a RULE and a heading, not by a box. The bordered card read
          as a section but its padding pushed every label ~28px right of the
          toggles above it, so the one group that was supposed to look
          deliberate was the only one out of alignment. A divider plus the same
          h2 the Window/Sidebar/Panes sections use groups it without moving
          anything. */}
      <section
        data-testid="code-intel-settings"
        className="mt-2 border-t border-[var(--color-border-soft)] pt-6"
      >
        {/* The name follows the switch below it. With type checking off this
            feature IS navigation, and a heading promising "intelligence"
            sends the reader looking for a checker they have not turned on. */}
        <h2 className="text-[15px] font-medium">{codeIntelName(codeIntelDiagnostics)}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-fg-dim)]">
          {t("appearance.intel.desc")}
          {codeIntelDiagnostics ? t("appearance.intel.descErrors") : ""}
          {t("appearance.intel.descTail")}
        </p>

        <div className="mt-5 flex flex-col gap-6">
          <Toggle
            label={t("appearance.intel.offerLabel")}
            hint={t("appearance.intel.offerHint")}
            value={codeIntelligence}
            onChange={setCodeIntelligence}
          />

          <Toggle
            label={t("appearance.intel.typeCheckLabel")}
            badge={t("shared.experimental")}
            // Two sentences: what it does, and what to expect. The long
            // version explained mypy's config model in a settings row, which
            // is a paragraph nobody finishes; the detail it was carrying now
            // lives where somebody hunting a specific underline will look
            // (docs/lsp.md), and the rule id is printed on the underline
            // itself so it can be looked up.
            hint={t("appearance.intel.typeCheckHint")}
            value={codeIntelDiagnostics}
            onChange={setCodeIntelDiagnostics}
          />

          {/* Only once the feature is offered: with it off there is nothing
              running, nothing installed, and no reason to talk about versions. */}
          {/* Collapsed by default. The list answers "what could run, and what
              do I already have" — a question people ask once and then stop
              asking. Open, it is a dozen rows sitting between two switches
              that get read far more often. */}
          {codeIntelligence && (
            <div className="border-t border-[var(--color-border-soft)] pt-4">
              <button
                type="button"
                data-testid="lsp-servers-toggle"
                aria-expanded={serversOpen}
                onClick={() => setServersOpen(o => !o)}
                className="flex w-full items-center gap-1.5 text-left"
              >
                {serversOpen
                  ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
                  : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />}
                {/* "Language servers", not "Servers": on its own the word
                    suggests something termic runs for you, and not "plugins"
                    either, which would imply an extension point that does not
                    exist. These are separate processes, spawned from the
                    machine's own toolchain. */}
                <span className="text-[13px] font-medium">{t("appearance.intel.serversLabel")}</span>
                <span className="text-[12px] text-[var(--color-fg-dim)]">
                  {t("appearance.intel.serversSub")}
                </span>
              </button>
              {serversOpen && (
                <div className="mt-3">
                  <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
                    <Trans
                      t={t}
                      i18nKey="appearance.intel.serversHint"
                      components={{ 1: <code className="font-mono" /> }}
                    />
                  </p>
                  <CodeIntelServers />
                </div>
              )}
            </div>
          )}
        </div>
      </section>
      </div>}

      {subTab === "interface" && <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <h2 className="text-[15px] font-medium">{t("appearance.windowHeading")}</h2>
        <Field
          label={t("appearance.uiZoom.label")}
          hint={t("appearance.uiZoom.hint", { scale: uiScale, cmd: CMD_LABEL })}
          control={
            <NumberInput value={uiScale} onChange={setUiScale} min={50} max={200} step={10} />
          }
        />
      </div>

      <Divider />

      <PanesSection />

      <Divider />

      <SidebarSection />
      </div>}
    </div>
  );
}

// Sidebar chrome. "Task expand behavior" lived in General until the settings
// split; it is about how the sidebar reveals a task's agents, which is the
// same kind of setting as the pane dimming above it.
function SidebarSection() {
  const { t } = useTranslation("settings");
  const taskExpandMode = usePrefs(s => s.taskExpandMode);
  const setTaskExpandMode = usePrefs(s => s.setTaskExpandMode);
  const sidebarHoverReveal = usePrefs(s => s.sidebarHoverReveal);
  const setSidebarHoverReveal = usePrefs(s => s.setSidebarHoverReveal);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-[15px] font-medium">{t("appearance.sidebarHeading")}</h2>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">{t("appearance.expand.label")}</div>
          <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("appearance.expand.hint")}
          </div>
        </div>
        <div className="inline-flex items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
          {([
            ["chevron", t("appearance.expand.chevron"), t("appearance.expand.chevronHint")],
            ["click",   t("appearance.expand.click"),   t("appearance.expand.clickHint")],
            ["always",  t("appearance.expand.always"),  t("appearance.expand.alwaysHint")],
          ] as const).map(([id, label, hint]) => (
            <Tip key={id} content={hint} side="top">
              <button
                type="button"
                onClick={() => setTaskExpandMode(id)}
                className={cn(
                  "h-7 rounded-[5px] px-2.5 text-[12px] transition-colors",
                  taskExpandMode === id
                    ? "bg-[var(--color-accent-deep)] text-white"
                    : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                )}
              >{label}</button>
            </Tip>
          ))}
        </div>
      </div>
      <Toggle
        label={t("appearance.hoverReveal.label")}
        hint={t("appearance.hoverReveal.hint")}
        value={sidebarHoverReveal}
        onChange={setSidebarHoverReveal}
      />
    </div>
  );
}

function PanesSection() {
  const { t } = useTranslation("settings");
  const splitPaneDim = usePrefs(s => s.splitPaneDim);
  const setSplitPaneDim = usePrefs(s => s.setSplitPaneDim);
  const splitPaneDimAmount = usePrefs(s => s.splitPaneDimAmount);
  const setSplitPaneDimAmount = usePrefs(s => s.setSplitPaneDimAmount);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-[15px] font-medium">{t("appearance.panesHeading")}</h2>
      <Toggle
        label={t("appearance.dim.label")}
        hint={t("appearance.dim.hint")}
        value={splitPaneDim}
        onChange={setSplitPaneDim}
      />
      {splitPaneDim && (
        <Field
          label={t("appearance.dim.amountLabel")}
          hint={t("appearance.dim.amountHint", { amount: splitPaneDimAmount })}
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
  const { t } = useTranslation("settings");
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
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[180px]"
      >
        <optgroup label={t("appearance.fonts.bundled")}>{bundled.map(renderOption)}</optgroup>
        <optgroup label={t("appearance.fonts.installed")}>{installed.map(renderOption)}</optgroup>
      </select>
      <label
        title={t("appearance.fonts.showAllTip")}
        className="flex cursor-pointer select-none items-center gap-1.5 text-[12px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
      >
        <Checkbox checked={showAll} onChange={setShowAll} className="h-3.5 w-3.5" />
        <span>{t("appearance.fonts.showAll")}</span>
      </label>
    </div>
  );
}

const RENDERERS: Array<{ id: TerminalRendererKind; label: string }> = [
  { id: "webgl",  label: "GPU (WebGL)" },
  { id: "canvas", label: "Canvas" },
  { id: "dom",    label: "DOM" },
];

/** Renderer picker (GH #140). Segmented rather than a <select> to match
 *  LetterSpacingPicker directly above it: three short options that fit
 *  inline, where showing all of them at once is what separates them. A
 *  collapsed dropdown pushed that job onto the hint text, which is how the
 *  hint turned into a six-line wall in the first place. */
function RendererPicker({ value, onChange }: {
  value: TerminalRendererKind; onChange: (v: TerminalRendererKind) => void;
}) {
  return (
    <div className="inline-flex items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
      {RENDERERS.map(({ id, label }) => (
        <button
          key={id} type="button" onClick={() => onChange(id)}
          data-renderer={id}
          className={cn(
            "h-7 rounded-[5px] px-2.5 text-[12px] transition-colors",
            value === id
              ? "bg-[var(--color-accent-deep)] text-white"
              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
          )}
        >{label}</button>
      ))}
    </div>
  );
}

function ThemeSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-3 pr-8 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[180px]"
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
const LETTER_SPACINGS: { px: number; labelKey: "compact" | "default" | "roomy" | "wide" }[] = [
  { px: 0, labelKey: "compact" },
  { px: 1, labelKey: "default" },
  { px: 2, labelKey: "roomy" },
  { px: 3, labelKey: "wide" },
];

function LetterSpacingPicker({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  const { t } = useTranslation("settings");
  return (
    <div className="inline-flex items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
      {LETTER_SPACINGS.map(({ px, labelKey }) => (
        <button
          key={px} type="button" onClick={() => onChange(px)}
          className={cn(
            "h-7 rounded-[5px] px-2.5 text-[12px] transition-colors",
            value === px
              ? "bg-[var(--color-accent-deep)] text-white"
              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
          )}
        >{t(`appearance.letterSpacing.${labelKey}`)}</button>
      ))}
    </div>
  );
}

function Toggle({ label, hint, value, onChange, badge }: {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void;
  /** A word beside the label: "Experimental". Set it only where the honest
   *  answer is that the feature does not work everywhere yet, and take it off
   *  when that stops being true. A badge on everything says nothing. */
  badge?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium">{label}</span>
          {badge && (
            <span className="rounded border border-[var(--color-border)] px-1.5 py-px text-[10.5px] uppercase tracking-wide text-[var(--color-fg-dim)]">
              {badge}
            </span>
          )}
        </div>
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
  const themeIdDark  = usePrefs(s => s.editorThemeIdDark);
  const themeIdLight = usePrefs(s => s.editorThemeIdLight);
  const size     = usePrefs(s => s.editorFontSize);
  const ligatures = usePrefs(s => s.codeLigatures);
  const themeMode = usePrefs(s => s.themeMode);
  const appIsLight = resolveTheme(themeMode) === "light";
  const themeId = appIsLight ? themeIdLight : themeIdDark;
  const hostRef  = useRef<HTMLDivElement>(null);
  const viewRef  = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const langComp = useRef(new Compartment());

  // The grammar is fetched, not imported. This pane is in the MAIN chunk, and
  // a static `@codemirror/lang-*` import here does two bad things: it puts a
  // grammar on the app-start path, and it pins that package into the main
  // chunk, where the namespace object the registry's own `import()` receives
  // comes back missing its exports — every .ts and .js file in the app lost
  // its highlighting that way. `lib/mainChunkGuard.test.ts` pins it now.
  useEffect(() => {
    let alive = true;
    import("@/lib/languageExts")
      .then(m => m.langForId("TypeScript"))
      .then(ext => {
        if (!alive || !ext) return;
        viewRef.current?.dispatch({ effects: langComp.current.reconfigure([ext]) });
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: CODE_SAMPLE,
        extensions: [
          langComp.current.of([]),
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
