// Owns the terminal's critical JetBrains Mono faces (latin 400 + 700) as
// explicit FontFace handles so the WebGL glyph-atlas readiness gate can await
// GENUINE rasterization readiness instead of a document.fonts status query.
//
// Why this exists (GH #70): xterm's WebGL atlas keys glyphs per (char,fg,bg,ext)
// with no font in the key, so any glyph rasterized before the real face is
// active caches at the fallback height and never corrects until an atlas
// rebuild. The prior gate used document.fonts.check()/load() on the family
// string. Both return a truthy "ready" for a family that is not yet REGISTERED
// in the FontFaceSet (vacuous-true, reproduced on WKWebView: check() and load()
// against an unregistered family return/resolve truthy with zero faces).
// fontsource registers "JetBrains Mono" via async CSS @font-face, so that
// vacuous window is the #70 poison window on a cold spawn.
//
// Public surface: `terminalFontReady` (resolves when the owned faces are
// loaded) and `isTerminalFontReady()` (sync warm-path check).
// NOT responsible for: cyrillic JB Mono (kept on CSS @font-face; terminals are
// overwhelmingly latin and a rare cyrillic glyph mid-load is not the #70
// mixed-height bug), user-selected system fonts (installed, never race).
//
// These duplicate the fontsource latin @font-face rules (same family, weight,
// and woff2 URL, so the byte fetch is shared via HTTP cache). The duplication
// is intentional and sound: xterm rasterizes glyphs through Canvas 2D, which
// draws only with FontFaceSet faces that are actually LOADED and ignores
// unloaded ones, so once these awaited handles are loaded the atlas rasterizes
// against the real face regardless of the CSS faces' load state. Owning the
// handles is the whole point: it is the only way to await genuine readiness.

import url400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2";
import url700 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2";

// FontFaceSet is setlike in the spec, but TS 5.7's lib.dom omits add()/delete().
declare global {
  interface FontFaceSet {
    add(font: FontFace): void;
  }
}

const FAMILY = "JetBrains Mono";

const makeFace = (url: string, weight: string): FontFace =>
  new FontFace(FAMILY, `url("${url}") format("woff2")`, {
    weight,
    style: "normal",
    display: "swap", // mirror the fontsource CSS: fallback text, not invisible, while loading
  });

let ready = false;

// Cap on the face loads. The woff2s are bundled local assets, so load() should
// settle near-instantly; the cap exists because the catch below only covers a
// load() that REJECTS, not one that never settles. awaitTerminalFonts gates
// every PTY spawn on this promise, so a hung load without a cap would turn
// "wrong glyph heights" into "no terminal ever spawns", app-wide. Timing out
// resolves false, the same degradation as a failed load.
const LOAD_CAP_MS = 5000;

/** Resolves `true` once both owned latin faces (400 + 700) are genuinely
 *  loaded. Resolves `false` (never rejects, never hangs: loads are capped at
 *  LOAD_CAP_MS) if FontFace is unavailable or a load fails, so a font that
 *  will not load still lets the terminal attach its GPU renderer: a
 *  consistent fallback height beats the #70 mixed-height waves and beats a
 *  terminal stuck on the DOM renderer. */
export const terminalFontReady: Promise<boolean> = (async () => {
  if (typeof FontFace === "undefined" || !document.fonts) {
    ready = true;
    return true;
  }
  try {
    const faces = [makeFace(url400, "400"), makeFace(url700, "700")];
    faces.forEach(f => document.fonts.add(f));
    const loaded = await Promise.race([
      Promise.all(faces.map(f => f.load())).then(() => true),
      new Promise<boolean>(r => window.setTimeout(() => r(false), LOAD_CAP_MS)),
    ]);
    ready = true;
    return loaded;
  } catch {
    ready = true;
    return false;
  }
})();

/** Sync warm-path check. Backed by real FontFace handles, so unlike
 *  document.fonts.check() it is never vacuously true before the faces exist.
 *  True once `terminalFontReady` has settled. */
export const isTerminalFontReady = (): boolean => ready;
