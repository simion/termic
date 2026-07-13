#!/usr/bin/env bash
# Swap a freshly-built .app into /Applications and launch it.
#
# Shared by `make install` (the shipped app: Termic.app, com.simion.termic)
# and `make beta` (Termic Beta.app, com.simion.termic.beta — a parallel
# install that shares the production data dir, see src-tauri/tauri.beta.conf.json).
#
# Usage: scripts/install-app.sh [APP_NAME] [BUNDLE_ID]
#   APP_NAME  bundle basename without .app  (default: Termic)
#   BUNDLE_ID used to quit a running copy   (default: com.simion.termic)
set -euo pipefail

APP_NAME="${1:-Termic}"
BUNDLE_ID="${2:-com.simion.termic}"
SRC="src-tauri/target/release/bundle/macos/$APP_NAME.app"
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
echo "✓ Installed $DEST"
