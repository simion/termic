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
  | "auto"
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

/** "auto" — the default: follow the app palette so code is never light
 *  tokens on a light background (issue #40). Resolves to a light syntax
 *  theme under a light app theme, a dark one otherwise. */
export const DEFAULT_EDITOR_THEME: EditorThemeId = "auto";

/** Concrete syntax themes "auto" maps to, by app palette brightness. */
type ConcreteThemeId = Exclude<EditorThemeId, "auto">;
const AUTO_DARK: ConcreteThemeId = "atomone";
const AUTO_LIGHT: ConcreteThemeId = "github-light";

const THEME_EXT: Record<Exclude<EditorThemeId, "auto">, Extension> = {
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
  { id: "auto", label: "Auto (match app)" },
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

/** Resolve a (possibly stale) theme id to its CodeMirror extension.
 *  "auto" follows the app palette (`appIsLight`) so a light app never
 *  renders dark-theme tokens on a light background (issue #40). Unknown
 *  ids fall back to the auto behaviour. */
export function resolveEditorTheme(id: string, appIsLight = false): Extension {
  if (id === "auto") return THEME_EXT[appIsLight ? AUTO_LIGHT : AUTO_DARK];
  return THEME_EXT[id as ConcreteThemeId] ?? THEME_EXT[appIsLight ? AUTO_LIGHT : AUTO_DARK];
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
    // Search panel — sit it on the elevated surface, not the theme's,
    // and re-skin the browser-default buttons/inputs/checkboxes that
    // CodeMirror leaves un-styled. WKWebView's defaults are the bevelled
    // gray buttons + bright green :focus ring on inputs.
    ".cm-panels": {
      backgroundColor: "var(--color-bg-2)",
      color: "var(--color-fg)",
      borderColor: "var(--color-border)",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid var(--color-border)",
    },
    ".cm-panel.cm-search": {
      padding: "6px 8px",
      fontFamily: "inherit",
      fontSize: "12px",
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "6px",
    },
    ".cm-panel.cm-search br": { display: "none" },
    ".cm-panel.cm-search label": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      fontSize: "12px",
      color: "var(--color-fg-dim)",
      cursor: "pointer",
      userSelect: "none",
    },
    ".cm-panel.cm-search input[type=checkbox], .cm-panel.cm-search input[name=case], .cm-panel.cm-search input[name=re], .cm-panel.cm-search input[name=word]": {
      appearance: "none",
      WebkitAppearance: "none",
      width: "12px",
      height: "12px",
      borderRadius: "3px",
      border: "1px solid var(--color-border)",
      backgroundColor: "var(--color-bg)",
      margin: "0 2px 0 0",
      cursor: "pointer",
      position: "relative",
      verticalAlign: "middle",
    },
    ".cm-panel.cm-search input[type=checkbox]:checked, .cm-panel.cm-search input[name=case]:checked, .cm-panel.cm-search input[name=re]:checked, .cm-panel.cm-search input[name=word]:checked": {
      backgroundColor: "var(--color-accent)",
      borderColor: "var(--color-accent)",
    },
    ".cm-panel.cm-search input[type=checkbox]:checked::after, .cm-panel.cm-search input[name=case]:checked::after, .cm-panel.cm-search input[name=re]:checked::after, .cm-panel.cm-search input[name=word]:checked::after": {
      content: '""',
      position: "absolute",
      left: "3px",
      top: "0px",
      width: "4px",
      height: "8px",
      // Checkmark sits on an accent-filled box, so it takes the on-accent ink.
      // Longhands, not `border: solid var(...)`: a var() inside a shorthand
      // makes the whole declaration pending-substitution, and one unset token
      // would drop border-style back to `none` and erase the checkmark.
      borderStyle: "solid",
      borderColor: "var(--color-accent-fg)",
      borderWidth: "0 1.5px 1.5px 0",
      transform: "rotate(45deg)",
    },
    ".cm-panel.cm-search input.cm-textfield, .cm-panel.cm-search input[name=search], .cm-panel.cm-search input[name=replace]": {
      appearance: "none",
      WebkitAppearance: "none",
      height: "22px",
      padding: "0 6px",
      borderRadius: "4px",
      border: "1px solid var(--color-border)",
      backgroundColor: "var(--color-bg)",
      color: "var(--color-fg)",
      fontFamily: "inherit",
      fontSize: "12px",
      outline: "none",
      minWidth: "140px",
    },
    ".cm-panel.cm-search input.cm-textfield:focus, .cm-panel.cm-search input[name=search]:focus, .cm-panel.cm-search input[name=replace]:focus": {
      borderColor: "var(--color-accent)",
      boxShadow:
        "0 0 0 2px color-mix(in srgb, var(--color-accent) 25%, transparent)",
    },
    ".cm-panel.cm-search button.cm-button, .cm-panel.cm-search button, .cm-panel.cm-search [name=close]": {
      appearance: "none",
      WebkitAppearance: "none",
      height: "22px",
      padding: "0 8px",
      borderRadius: "4px",
      border: "1px solid var(--color-border) !important",
      backgroundColor: "var(--color-bg) !important",
      backgroundImage: "none !important",
      color: "var(--color-fg)",
      fontFamily: "inherit",
      fontSize: "12px",
      cursor: "pointer",
      lineHeight: "1",
      textTransform: "none",
      margin: "0",
    },
    ".cm-panel.cm-search button.cm-button:hover, .cm-panel.cm-search button:hover": {
      backgroundColor:
        "color-mix(in srgb, var(--color-fg) 6%, var(--color-bg)) !important",
      backgroundImage: "none !important",
      borderColor:
        "color-mix(in srgb, var(--color-fg) 20%, var(--color-border)) !important",
    },
    ".cm-panel.cm-search button.cm-button:active, .cm-panel.cm-search button:active": {
      backgroundColor:
        "color-mix(in srgb, var(--color-fg) 10%, var(--color-bg)) !important",
      backgroundImage: "none !important",
    },
    ".cm-panel.cm-search [name=close]": {
      position: "absolute",
      top: "4px",
      right: "4px",
      width: "20px",
      height: "20px",
      padding: "0",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--color-fg-dim)",
    },
  });
}
