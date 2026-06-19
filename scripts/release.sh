#!/usr/bin/env bash
# Cut a release tag locally. CI (.github/workflows/release.yml) takes
# over once the tag is pushed: builds the macOS bundle, ed25519-signs
# the updater package, uploads to a GitHub Release, bumps the
# homebrew tap and the website's update manifest + changelog.
#
# Before bumping versions this script gates on CHANGELOG.md (the
# human-authored source of truth): the top entry must be the new version
# with a summary and at least one bullet. The slim changelog.json (what
# the in-app Update card reads) is regenerated from it. A stub is
# scaffolded if missing — fill it in and re-run. See the `release` skill.
#
# Usage:
#   ./scripts/release.sh patch          0.1.0 → 0.1.1
#   ./scripts/release.sh minor          0.1.0 → 0.2.0
#   ./scripts/release.sh major          0.1.0 → 1.0.0
#   ./scripts/release.sh 0.4.2-rc1      set explicit version
#
# Patch-merge mode (second arg `merge`) — fold an uncommitted working-tree
# change into a fresh patch on top of the last release, with the changelog
# bullet appended to the LAST entry (no new entry):
#   ./scripts/release.sh patch merge    0.11.0 → 0.11.1
# In this mode a dirty tree is expected (that's your change), and the top
# changelog entry must already be bumped to the new version with your
# bullet appended. Patch only. See the `release` skill.
set -euo pipefail

BUMP="${1:-patch}"
MODE="${2:-}"

if [[ -n "$MODE" && "$MODE" != "merge" ]]; then
  echo "✗ unknown mode '$MODE' (only 'merge' is supported)"
  exit 1
fi
if [[ "$MODE" == "merge" && "$BUMP" != "patch" ]]; then
  echo "✗ patch-merge mode is patch-only (got BUMP=$BUMP)"
  exit 1
fi

# ─── preflight ──────────────────────────────────────────────────────
# The CHANGELOG.md entry for the new version is authored right before the
# release (and changelog.json is regenerated from it), so both are
# expected to be uncommitted here — exempt them from the dirty check.
# release.sh commits them together with the version bump below.
#
# Patch-merge mode is the exception: the whole point is to fold an
# uncommitted working-tree change into the release, so any dirty tree is
# allowed and `git add -A` sweeps it into the release commit.
if [[ "$MODE" != "merge" ]]; then
  if [[ -n "$(git status --porcelain | grep -vE ' (CHANGELOG\.md|changelog\.json)$' || true)" ]]; then
    echo "✗ working tree dirty (other than CHANGELOG.md) — commit or stash first"
    echo "  (to fold a change into a patch on the last release, use: make release-patch)"
    exit 1
  fi
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
if [[ "$MODE" == "merge" ]]; then
  # Patch-merge: the change folds into the LAST release's notes rather
  # than getting its own entry. The top CHANGELOG.md entry must already be
  # bumped in place to $NEW (with the new bullet appended) before this runs
  # — we do NOT scaffold a new entry here. merge-gate restamps the date,
  # validates, and regenerates changelog.json.
  CL_STATUS="$(node scripts/changelog.mjs merge-gate "$NEW" "$CUR")"
  if [[ "$CL_STATUS" != "OK" ]]; then
    echo ""
    echo "✗ patch-merge needs the top CHANGELOG.md entry bumped to $NEW."
    case "$CL_STATUS" in
      NOT_BUMPED)
        echo "  The top entry is still $CUR. Bump its heading to ## [$NEW] in place,"
        echo "  append your change as a bullet under one of its ### subsections,"
        echo "  then re-run:  make release-patch" ;;
      MISMATCH:*)
        echo "  The top entry is ${CL_STATUS#MISMATCH:}, expected $NEW. Fix it and re-run." ;;
      *)
        echo "  The top entry needs a non-empty summary and at least one bullet." ;;
    esac
    exit 1
  fi
  echo "→ CHANGELOG.md top entry folded into $NEW: ok"
else
# Every release must ship a filled-in CHANGELOG.md entry for $NEW — it's
# the source the in-app Changelog dialog + termic.dev render, and the slim
# changelog.json (the Update card's summary) is regenerated from it.
# release-gate scaffolds a stub if the entry is missing, stamps today's
# date, validates, and regenerates changelog.json on success.
CL_STATUS="$(node scripts/changelog.mjs release-gate "$NEW")"
if [[ "$CL_STATUS" != "OK" ]]; then
  echo ""
  echo "✗ CHANGELOG.md needs the $NEW entry filled in."
  echo "  A stub for $NEW is now at the top of CHANGELOG.md — write its"
  echo "  short summary line (≤15 words) and at least one bullet,"
  echo "  then re-run:"
  echo "      make release BUMP=$BUMP"
  exit 1
fi
echo "→ CHANGELOG.md entry for $NEW: ok"
fi

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
# Patch-merge sweeps the whole working tree (your change is the point of
# the merge) into the release commit. The normal path stages only the
# version files + changelog, leaving anything else for a separate commit.
if [[ "$MODE" == "merge" ]]; then
  git add -A
else
  git add \
    package.json package-lock.json \
    src-tauri/Cargo.toml src-tauri/Cargo.lock \
    src-tauri/tauri.conf.json \
    CHANGELOG.md changelog.json
fi
git commit -m "release: v$NEW"
git tag "v$NEW"

echo ""
echo "✓ Tagged v$NEW. Push to trigger CI:"
echo "    git push && git push --tags"
