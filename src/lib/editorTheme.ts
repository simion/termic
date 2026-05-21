// Shared CodeMirror theme layer for the editor AND the diff viewer.
//
// Strategy (cloned from terax-ai): the user picks a *syntax* theme
// (atomone, tokyo-night, …) — that supplies the token colors via the
// theme's HighlightStyle. We then layer `editorSurfaceTheme()` on top,
// which forces every surface (editor bg, gutters, panels) back to the
// app's own `@theme` CSS vars with `!important`. Result: the editor
// always sits flush with the surrounding chrome under any app palette,
// but the code itself is coloured by the chosen theme.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { atomone } from "@uiw/codemirror-theme-atomone";
import { aura } from "@uiw/codemirror-theme-aura";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { gruvboxDark } from "@uiw/codemirror-theme-gruvbox-dark";
import { nord } from "@uiw/codemirror-theme-nord";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { xcodeDark, xcodeLight } from "@uiw/codemirror-theme-xcode";

export type EditorThemeId =
  | "atomone"
  | "tokyo-night"
  | "aura"
  | "copilot"
  | "nord"
  | "gruvbox-dark"
  | "github-dark"
  | "github-light"
  | "xcode-dark"
  | "xcode-light";

/** atomone — the default. The theme terax-ai ships and what the
 *  user pointed at; warm, high-contrast, easy on the eyes. */
export const DEFAULT_EDITOR_THEME: EditorThemeId = "atomone";

const THEME_EXT: Record<EditorThemeId, Extension> = {
  atomone,
  "tokyo-night": tokyoNight,
  aura,
  copilot,
  nord,
  "gruvbox-dark": gruvboxDark,
  "github-dark": githubDark,
  "github-light": githubLight,
  "xcode-dark": xcodeDark,
  "xcode-light": xcodeLight,
};

/** Picker order — dark themes first (the app's primary look), the two
 *  light themes last. */
export const EDITOR_THEMES: { id: EditorThemeId; label: string }[] = [
  { id: "atomone", label: "Atom One" },
  { id: "tokyo-night", label: "Tokyo Night" },
  { id: "aura", label: "Aura" },
  { id: "copilot", label: "Copilot" },
  { id: "nord", label: "Nord" },
  { id: "gruvbox-dark", label: "Gruvbox Dark" },
  { id: "github-dark", label: "GitHub Dark" },
  { id: "github-light", label: "GitHub Light" },
  { id: "xcode-dark", label: "Xcode Dark" },
  { id: "xcode-light", label: "Xcode Light" },
];

/** Resolve a (possibly stale) theme id to its CodeMirror extension,
 *  falling back to the default if the stored id is unknown. */
export function resolveEditorTheme(id: string): Extension {
  return THEME_EXT[id as EditorThemeId] ?? THEME_EXT[DEFAULT_EDITOR_THEME];
}

/**
 * Surface overrides applied AFTER the syntax theme. Pulls every chrome
 * colour from the app's `@theme` vars so the editor tracks the active
 * app palette for free (CSS vars are live — a theme switch needs no
 * editor rebuild). Font size + ligatures fold in here too so they
 * reconfigure live via the theme compartment.
 *
 * @param dimActiveLine  diff viewer passes true — its own per-line
 *   red/green tints carry the signal, the active-line wash just muddies it.
 */
export function editorSurfaceTheme(
  fontSizePx: number,
  ligatures: boolean,
  dimActiveLine = false,
): Extension {
  return EditorView.theme({
    "&": { height: "100%", fontSize: `${fontSizePx}px` },
    "&, &.cm-editor, &.cm-editor.cm-focused": {
      backgroundColor: "transparent !important",
      color: "var(--color-fg)",
      outline: "none",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.55",
      // `normal` enables ligatures (=>, !==, …); `none` disables them.
      fontVariantLigatures: ligatures ? "normal" : "none",
      backgroundColor: "transparent !important",
    },
    ".cm-content": {
      caretColor: "var(--color-accent)",
      backgroundColor: "transparent !important",
    },
    ".cm-gutters": {
      backgroundColor: "transparent !important",
      color: "var(--color-fg-dim)",
      border: "none",
    },
    ".cm-gutter-lint": { width: "0px" },
    ".cm-lineNumbers .cm-gutterElement": { opacity: "0.55" },
    ".cm-foldGutter": { width: "12px" },
    ".cm-foldGutter .cm-gutterElement": {
      color: "var(--color-fg-dim)",
      opacity: "0.5",
    },
    ".cm-activeLine": {
      borderTopRightRadius: "5px",
      borderBottomRightRadius: "5px",
      backgroundColor: dimActiveLine
        ? "transparent"
        : "color-mix(in srgb, var(--color-fg) 4%, transparent)",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-lineNumbers .cm-activeLineGutter": {
      borderTopLeftRadius: "5px",
      borderBottomLeftRadius: "5px",
      backgroundColor: dimActiveLine
        ? "transparent"
        : "color-mix(in srgb, var(--color-fg) 4%, transparent)",
      userSelect: "none",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor:
        "color-mix(in srgb, var(--color-fg) 16%, transparent) !important",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor:
        "color-mix(in srgb, var(--color-accent) 28%, transparent)",
      outline: "none",
    },
    // Search panel — sit it on the elevated surface, not the theme's.
    ".cm-panels": {
      backgroundColor: "var(--color-bg-2)",
      color: "var(--color-fg)",
      borderColor: "var(--color-border)",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label":
      { fontFamily: "inherit", fontSize: "12px" },
  });
}
