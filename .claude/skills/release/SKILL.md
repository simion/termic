---
name: release
description: Cut a termic release from main, or fold a small change into a patch on the last release. Use whenever the user wants to release, ship a version, cut a tag, bump the version, publish an update, or push a quick patch/hotfix. Covers the changelog entry, make release / make release-patch, what CI does, and developing the update UI.
---

# Releasing termic

Releases are cut from a single Mac, on `main`. CI does everything else once the
tag is pushed. There are two paths:

- **Normal release** (`make release`) — a fresh version with its own changelog
  entry. Patch, minor, major, or explicit. Requires a clean tree.
- **Patch-merge** (`make release-patch`) — fold an uncommitted working-tree
  change into a *patch on top of the last release*, appending the bullet to the
  **last** changelog entry (no new entry). Patch only. Dirty tree expected.

Both bump `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
and `Cargo.lock` in lockstep, commit `release: vX`, and tag `vX`. The push of
the tag triggers `.github/workflows/release.yml`.

`changelog.json` (repo root) is the **single source of truth** for release
notes — the in-app Update card (sidebar, latest `summary` only) and the
Changelog dialog (every version's `summary` + `sections`, dated) render from it,
and CI copies it verbatim to `termic.dev`.

## When invoked — what to confirm, what to infer

Don't interrogate. There are only two things you can't read off the repo, so
confirm them in a single question and then proceed:

1. **Which path** — normal release (Path A, its own changelog entry) or
   patch-merge (Path B, fold into the last release). If the user already said
   ("cut a release" → A; "quick patch", "hotfix", "ride along with the last
   release" → B), don't ask — just state which you're taking.
2. **Bump level** (Path A only) — patch / minor / major / explicit. Don't
   default silently; ask if unstated. Path B is always patch, so no question.

Infer everything else yourself, don't ask:
- current version (`package.json`), the computed new version, today's date
  (the script stamps it);
- the changelog `summary` + `sections` — draft them from the diff / commits and
  show the user the entry for a quick yes before running. Obey the copy rule
  (no em dashes) and keep `summary` ≤15 words.

After cutting the tag, push it: `git push && git push --tags`. This kicks off
the CI publish (build, sign, GitHub Release, tap + website bump) — it's the
point of the release, so don't stop short of it. Then report the pushed tag and
that CI is running.

---

## Path A — normal release (`make release`)

```sh
# 1. Author the changelog entry for the new version (see "Changelog entry").
#    Add a new object at the TOP of `versions` in changelog.json.
# 2. Cut the release:
make release                 # patch bump (0.4.4 → 0.4.5)
make release BUMP=minor      # 0.4.4 → 0.5.0
make release BUMP=major      # 0.4.4 → 1.0.0
make release BUMP=0.5.0-rc1  # explicit version
# 3. Push to trigger CI:
git push && git push --tags
```

`scripts/release.sh`:

1. Refuses to run on a dirty tree (a dirty `changelog.json` is allowed — that's
   the entry you just wrote) or off `main`.
2. Gates on `changelog.json`: scaffolds a stub if the entry is missing, stamps
   today's date, and aborts if `summary` is empty. (If you forget step 1, this
   is what scaffolds the stub and stops — write its `summary`, then re-run.)
3. Bumps the four version files in lockstep.
4. Commits the version files **+ `changelog.json`** as `release: vX` and tags
   `vX`.

---

## Path B — patch-merge (`make release-patch`)

For when you have a small uncommitted change sitting in the working tree and
want to ship it as a patch *riding along with the last release* — no separate
feature commit, no new changelog block. **Patch only.**

What it does: bumps patch on top of the last release (0.11.0 → 0.11.1), folds
your working change + the version bumps into one new `release: v0.11.1` commit,
tags it. The previous release commit and tag are left untouched (new commit on
top, nothing rewritten).

```sh
# 1. In changelog.json, edit the TOP (latest) entry in place:
#      - bump its "version"  (e.g. 0.11.0 → 0.11.1)
#      - append your change as a bullet to one of its existing "sections"
#        (do NOT add a new top entry — the change merges into the last release)
# 2. Fold + cut:
make release-patch
# 3. Push:
git push && git push --tags
```

`scripts/release.sh patch merge`:

1. Requires `main`. **Allows a dirty tree** — that change is the whole point.
2. Gates on `changelog.json`: the top entry must already be bumped to the new
   patch version with a non-empty summary and at least one section item. If it's
   still on the previous version, it tells you to bump-in-place + append, then
   re-run. It restamps the date but never scaffolds a new entry.
3. Bumps the four version files.
4. `git add -A` (sweeps your working change in too), commits `release: vX`, tags.

Guardrails: non-patch bumps are rejected in this mode; an unknown second arg is
rejected. If you actually want a distinct release with its own notes, use Path A.

---

## Changelog entry (Path A)

Add a new object to the **top** of the `versions` array:

```jsonc
{
  "version": "0.4.5",   // must match the version you're releasing
  "date": "",           // leave empty — release.sh stamps it
  "summary": "Short headline (≤15 words).",
  "sections": [
    { "label": "Features",  "items": ["First new thing.", "Second new thing."] },
    { "label": "Bug fixes", "items": ["Something broken that is now fixed."] }
  ]
}
```

Common `label` values: `"Features"`, `"Bug fixes"`, `"Improvements"`,
`"Sponsors"`. Use whatever fits — the renderer shows it as-is. Omit sections
with no items.

Field notes:

- **`version`** — must equal the version being released. `make release` gates on
  this: the top entry's `version` must match the computed new version.
- **`date`** — leave empty; `release.sh` stamps today's date automatically.
- **`summary`** — required, ≤15 words. Renders in a narrow sidebar card —
  `release.sh` warns if it exceeds 15 words.
- **`sections`** — required, at least one section with at least one item. Plain
  strings, no markdown. Each item becomes a `<li>` under its section label.

Newest entry first. Never reorder or delete old entries — the dialog shows the
whole history.

**Copy rule:** no em dashes (—) anywhere in user-visible text, including
`changelog.json`. Use a comma, period, parentheses, or colon.

---

## What CI does (after `git push --tags`)

`.github/workflows/release.yml`:

1. **validate** — frontend type-check.
2. **build-mac** — universal (arm64 + x86_64) build, ad-hoc codesigned and
   ed25519-signed for the updater.
3. **release** — creates the GitHub Release with the signed `.dmg` + updater
   `.tar.gz`.
4. **bump-tap** — bumps the Homebrew cask in `simion/homebrew-termic`.
5. **bump-website** — commits two files to `simion/termic.dev`:
   - `public/updates/latest.json` — the Tauri updater manifest (version,
     signature, download URLs).
   - `public/updates/changelog.json` — copied verbatim from this repo.

## How updates reach users

- **Tauri updater** fetches `termic.dev/updates/latest.json` (Rust-side,
  ed25519-verified). Running apps see a new release within ~5 min (the CF Pages
  cache TTL). The in-app Update card / pill surfaces it.
- **Homebrew** users get it via `brew upgrade --cask`.
- The **Update card** and **Changelog dialog** fetch
  `termic.dev/updates/changelog.json` (WebView `fetch()` — the host is
  allowlisted in `tauri.conf.json`'s CSP `connect-src`, served with
  `Access-Control-Allow-Origin: *`).

`changelog.json` is also seeded directly in the `termic.dev` repo so the feature
works before the first release that runs the updated CI.

## Developing the update UI

`check()` never returns an update in a `tauri dev` build (no signed release to
verify against). Mock it with an env var:

```sh
VITE_MOCK_UPDATE=available npm run tauri dev   # update-available card + pill
VITE_MOCK_UPDATE=whatsnew  npm run tauri dev   # post-update "what's new" card
```

The mock is fully self-contained (no network) — see `src/store/update.ts`.
