// Appearance — editor + terminal fonts (separate), font sizes, ligatures.
// Mirrors Termic's split: "Mono Font" governs the editor; "Terminal Font"
// governs xterm. Sizes are independent.

import { usePrefs, MONO_FONT_OPTIONS, availableMonoFonts, availableMonoFontsAsync } from "@/store/prefs";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { AuxTerminal } from "@/components/workspace/AuxTerminal";
import { homeDir } from "@/lib/ipc";

export function AppearanceSection() {
  const editorFontId    = usePrefs(s => s.editorFontId);
  const setEditorFontId = usePrefs(s => s.setEditorFontId);
  const terminalFontId  = usePrefs(s => s.terminalFontId);
  const setTerminalFontId = usePrefs(s => s.setTerminalFontId);
  const terminalFontSize = usePrefs(s => s.terminalFontSize);
  const setTerminalFontSize = usePrefs(s => s.setTerminalFontSize);
  const terminalLetterSpacing = usePrefs(s => s.terminalLetterSpacing);
  const setTerminalLetterSpacing = usePrefs(s => s.setTerminalLetterSpacing);
  const editorFontSize = usePrefs(s => s.editorFontSize);
  const setEditorFontSize = usePrefs(s => s.setEditorFontSize);
  const codeLigatures = usePrefs(s => s.codeLigatures);
  const setCodeLigatures = usePrefs(s => s.setCodeLigatures);

  // Start with the curated subset so the picker is usable instantly, then
  // upgrade to the full system list when font-kit comes back (~50–200ms).
  const [fonts, setFonts] = useState(() => availableMonoFonts());
  useEffect(() => { availableMonoFontsAsync().then(setFonts).catch(() => {}); }, []);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-[20px] font-medium">Appearance</h1>

      <Field
        label="Editor font"
        hint="Font for the code editor and diff viewer."
        control={
          <FontSelect value={editorFontId} onChange={setEditorFontId} fonts={fonts} />
        }
      />

      <CodePreview fontStack={stackById(editorFontId)} size={editorFontSize} />

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

      {/* Live terminal preview — spawns a real shell in $HOME so
          font + size + weight changes are reflected immediately
          with real keystrokes, cursor blink, and ANSI colors.
          Fixed height so font resizes don't push the page around. */}
      <TerminalPreview />
      {/* Legacy static preview (kept off behind the `false` gate so
          a future revert is a one-flag change). */}
      {false && (<div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[var(--color-fg)]"
           style={{ fontFamily: stackById(terminalFontId), fontSize: `${terminalFontSize}px`, lineHeight: 1.4 }}>
        <span className="text-[#7cd57e]">~/project</span> <span className="text-[#d97757]">main</span> <span className="text-[#f0b13a]">±3</span><br/>
        <span className="text-[#d97757]">{"〉"}</span> npm test <span className="text-[#7cd57e]">✓</span><br/>
        <span className="text-[#a7f3a0]">└─▶ All tests passed!</span>
      </div>)}
    </div>
  );
}

function TerminalPreview() {
  const [home, setHome] = useState<string>("");
  useEffect(() => { void homeDir().then(setHome).catch(() => setHome("/tmp")); }, []);
  if (!home) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)]" style={{ height: 380 }}>
      <AuxTerminal wsPath={home} active={true} />
    </div>
  );
}

function stackById(id: string) {
  return (MONO_FONT_OPTIONS.find(o => o.id === id) || MONO_FONT_OPTIONS[0]).stack;
}

function Field({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function FontSelect({ value, onChange, fonts }: {
  value: string;
  onChange: (id: string) => void;
  fonts: typeof MONO_FONT_OPTIONS;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] min-w-[180px]"
    >
      {fonts.map(f => (
        <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>{f.label}</option>
      ))}
    </select>
  );
}

// Compact integer stepper. Replaces the previous range slider — direct
// keyboard entry + step buttons is faster than dragging a slider to hit
// a specific px value, especially for the small 10..20 range we expose.
function NumberInput({ value, onChange, min, max }: { value: number; onChange: (n: number) => void; min: number; max: number }) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  return (
    <input
      type="number" min={min} max={max} step={1} value={value}
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
        {hint && <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>}
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
            background: "#ffffff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 150ms",
          }}
        />
      </button>
    </div>
  );
}

function Divider() { return <div className="h-px bg-[var(--color-border-soft)]" />; }

function CodePreview({ fontStack, size }: { fontStack: string; size: number }) {
  // Plain pre with explicit newlines via a template literal. JSX whitespace
  // between sibling spans is collapsed, so the previous per-token coloring
  // produced one giant line and a horizontal scrollbar. Keeping it monochrome
  // (and wrapping) avoids that — the editor itself shows the real syntax
  // highlighting; this is just a font preview.
  const sample = `// Fetch user data
async function getUser(id: number) {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}`;
  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-4 overflow-hidden"
         style={{ fontFamily: fontStack, fontSize: `${size}px`, lineHeight: 1.5 }}>
      <pre className="whitespace-pre-wrap text-[var(--color-fg)]">{sample}</pre>
    </div>
  );
}
