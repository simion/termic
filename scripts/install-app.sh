#!/usr/bin/env bash
# Swap a freshly-built Termic.app into /Applications and launch it.
#
# Shared by `make install` (plain release build of the current tree) and
# `make install-beta` (same build, stamped with a BETA pill). Both produce
# the SAME bundle id, so the copy replaces whatever is installed and keeps
# the user's data, window state and updater watermark.
#
# Usage: scripts/install-app.sh [path/to/Termic.app]
set -euo pipefail

APP_NAME="Termic"
BUNDLE_ID="com.simion.termic"
SRC="${1:-src-tauri/target/release/bundle/macos/$APP_NAME.app}"
DEST="/Applications/$APP_NAME.app"

if [ ! -d "$SRC" ]; then
  echo "✗ build artifact missing: $SRC"
  exit 1
fi

echo "→ Quitting any running $APP_NAME instance (by bundle id $BUNDLE_ID)"
osascript -e "tell application id \"$BUNDLE_ID\" to quit" 2>/dev/null || true
sleep 1

echo "→ Removing $DEST (if present)"
rm -rf "$DEST"

echo "→ Copying $SRC → $DEST"
cp -R "$SRC" "$DEST"

echo "→ Refreshing icon cache"
touch "$DEST"
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$DEST" 2>/dev/null || true
killall Finder 2>/dev/null || true

echo "→ Launching $DEST"
open "$DEST"
echo "✓ Installed."
