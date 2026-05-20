#!/usr/bin/env bash
# Cut a release tag locally. CI (.github/workflows/release.yml) takes
# over once the tag is pushed: builds the macOS bundle, ed25519-signs
# the updater package, uploads to a GitHub Release, bumps the
# homebrew tap and the website's update manifest + changelog.
#
# Before bumping versions this script gates on changelog.json: the
# entry for the new version must exist with a title + summary (it's
# what the in-app Update card and Changelog dialog render). A stub is
# scaffolded if missing — fill it in and re-run. See RELEASING.md.
#
# Usage:
#   ./scripts/release.sh patch          0.1.0 → 0.1.1
#   ./scripts/release.sh minor          0.1.0 → 0.2.0
#   ./scripts/release.sh major          0.1.0 → 1.0.0
#   ./scripts/release.sh 0.4.2-rc1      set explicit version
set -euo pipefail

BUMP="${1:-patch}"

# ─── preflight ──────────────────────────────────────────────────────
# The changelog.json entry for the new version is authored right before
# the release (it feeds the in-app Update card), so it's expected to be
# uncommitted here — exempt it from the dirty check. release.sh commits
# it together with the version bump below.
if [[ -n "$(git status --porcelain | grep -v ' changelog\.json$' || true)" ]]; then
  echo "✗ working tree dirty (other than changelog.json) — commit or stash first"
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

# ─── changelog gate ─────────────────────────────────────────────────
# Every release must ship a filled-in changelog.json entry for $NEW —
# it's the source the in-app Update card + Changelog dialog render, and
# CI copies it verbatim to termic.dev. Scaffold a stub if the entry is
# missing, stamp today's date onto it, and refuse to proceed until its
# summary is written.
CL_STATUS="$(node -e '
  const fs = require("fs");
  const f = "changelog.json";
  const v = process.argv[1];
  let j;
  try {
    j = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") {
      j = { versions: [] };
    } else {
      console.error("✗ Failed to parse changelog.json. Please check for syntax errors:");
      throw e;
    }
  }
  if (!Array.isArray(j.versions)) j.versions = [];
  let top = j.versions[0];
  if (!top || top.version !== v) {
    top = { version: v, date: "", summary: "" };
    j.versions.unshift(top);
  }
  top.date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  process.stdout.write(top.summary ? "OK" : "INCOMPLETE");
' "$NEW")"
if [[ "$CL_STATUS" != "OK" ]]; then
  echo ""
  echo "✗ changelog.json needs the $NEW entry filled in."
  echo "  A stub for $NEW is now at the top of changelog.json — write its"
  echo "  one-line \"summary\", then re-run:"
  echo "      make release BUMP=$BUMP"
  exit 1
fi
echo "→ changelog.json entry for $NEW: ok"

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
  src-tauri/tauri.conf.json \
  changelog.json
git commit -m "release: v$NEW"
git tag "v$NEW"

echo ""
echo "✓ Tagged v$NEW. Push to trigger CI:"
echo "    git push && git push --tags"
