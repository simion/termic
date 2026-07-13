#!/usr/bin/env bash
#
# gen-icon.sh — render src-tauri/icons/icon.svg into every size + format
# Tauri (and the OS) needs. Edit the SVG, run this, commit the regenerated
# rasters.
#
# Generates (all under src-tauri/icons/):
#   icon.png             — 1024×1024 master raster (input to tauri icon)
#   32x32.png            — small dock / legacy
#   128x128.png          — Finder / About
#   128x128@2x.png       — Retina Finder / About
#   Square*Logo.png      — Windows Store sizes (created by `tauri icon`)
#   icon.icns            — macOS bundle icon
#   icon.ico             — Windows bundle icon
#
# Requires: rsvg-convert (brew install librsvg) + the Tauri CLI from devDeps.
# Falls back to `magick` (ImageMagick) if rsvg-convert isn't installed.

set -euo pipefail

cd "$(dirname "$0")/.."

SVG="src-tauri/icons/icon.svg"
OUT_DIR="src-tauri/icons"
MASTER="$OUT_DIR/icon.png"

if [[ ! -f "$SVG" ]]; then
  echo "error: $SVG not found"
  exit 1
fi

echo "→ Rendering $SVG @ 1024×1024 → $MASTER"
if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 "$SVG" -o "$MASTER"
elif command -v magick >/dev/null 2>&1; then
  # Background must be transparent so the squircle in the SVG isn't filled in.
  magick -background none -density 384 "$SVG" -resize 1024x1024 "$MASTER"
else
  echo "error: need either rsvg-convert (brew install librsvg) or magick (brew install imagemagick)"
  exit 1
fi

echo "→ Running tauri icon to fan out to all platform sizes"
# `tauri icon` reads the master PNG and writes:
#   - 32x32.png / 128x128.png / 128x128@2x.png (macOS Finder)
#   - icon.icns (macOS bundle)
#   - icon.ico (Windows bundle)
#   - StoreLogo / Square*x*Logo (Windows Store)
#   - Android / iOS sizes (skipped — we're desktop only)
# We point it at the master so the source-of-truth stays the SVG.
npx --yes @tauri-apps/cli icon "$MASTER" -o "$OUT_DIR"

# Variant icon sets. Same geometry as the shipped icon, different T color, so
# the three Termics that can be running at once are told apart in the dock:
#
#   beta/  blue T  (--color-info)  → `make beta`, bundled into Termic Beta.app
#                                     via tauri.beta.conf.json
#   dev/   amber T (--color-warn)  → `make dev`, which has no .app at all, so
#                                     lib.rs paints icons/dev/icon.png onto
#                                     NSApplication at launch (debug only)
#
# `tauri icon` reads the SVG directly here, so no rsvg needed for these. Mobile
# sizes are dropped: these are local macOS builds, nothing more.
for variant in beta dev; do
  VARIANT_SVG="$OUT_DIR/icon-$variant.svg"
  VARIANT_DIR="$OUT_DIR/$variant"
  [[ -f "$VARIANT_SVG" ]] || continue
  echo "→ Rendering $VARIANT_SVG → $VARIANT_DIR/"
  npx --yes @tauri-apps/cli icon "$VARIANT_SVG" -o "$VARIANT_DIR"
  rm -rf "$VARIANT_DIR/android" "$VARIANT_DIR/ios"
done

echo "✓ Done. Regenerated icons in $OUT_DIR/ (+ beta/, dev/)"
