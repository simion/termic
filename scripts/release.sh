#!/usr/bin/env bash
# Cut a release tag locally. CI (.github/workflows/release.yml) takes
# over once the tag is pushed: builds the macOS bundle, ed25519-signs
# the updater package, uploads to a GitHub Release, bumps the
# homebrew tap and the website's update manifest.
#
# Usage:
#   ./scripts/release.sh patch          0.1.0 → 0.1.1
#   ./scripts/release.sh minor          0.1.0 → 0.2.0
#   ./scripts/release.sh major          0.1.0 → 1.0.0
#   ./scripts/release.sh 0.4.2-rc1      set explicit version
set -euo pipefail

BUMP="${1:-patch}"

# ─── preflight ──────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ working tree dirty — commit or stash first"
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "✗ releases cut from main only (currently on $BRANCH)"
  exit 1
fi

# ─── compute new version ────────────────────────────────────────────
CUR="$(node -p 'require("./package.json").version')"
case "$BUMP" in
  patch)
    NEW=$(awk -F. -v OFS=. '{$3++; print}' <<<"$CUR")
    ;;
  minor)
    NEW=$(awk -F. -v OFS=. '{$2++; $3=0; print}' <<<"$CUR")
    ;;
  major)
    NEW=$(awk -F. -v OFS=. '{$1++; $2=0; $3=0; print}' <<<"$CUR")
    ;;
  *)
    NEW="$BUMP"
    ;;
esac

echo "→ Bumping $CUR → $NEW"

# ─── bump the three version files in lockstep ──────────────────────
# package.json (npm version)
npm version --no-git-tag-version "$NEW" >/dev/null

# src-tauri/Cargo.toml (top-level [package] version)
sed -i.bak -E "s/^version = \".*\"/version = \"$NEW\"/" src-tauri/Cargo.toml
rm src-tauri/Cargo.toml.bak

# src-tauri/tauri.conf.json
node -e "
  const fs = require('fs');
  const f = 'src-tauri/tauri.conf.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = process.argv[1];
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
" "$NEW"

# Keep Cargo.lock in sync so it doesn't drift in CI.
( cd src-tauri && cargo update -p termic >/dev/null 2>&1 || true )

# ─── commit + tag ──────────────────────────────────────────────────
git add \
  package.json package-lock.json \
  src-tauri/Cargo.toml src-tauri/Cargo.lock \
  src-tauri/tauri.conf.json
git commit -m "release: v$NEW"
git tag "v$NEW"

echo ""
echo "✓ Tagged v$NEW. Push to trigger CI:"
echo "    git push && git push --tags"
