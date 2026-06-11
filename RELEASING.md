# Releasing Termic

Releases are cut from a single Mac, on `main`, with `make release`. CI does
everything else once the tag is pushed.

## TL;DR

```sh
# 1. Write the changelog entry for the new version (see below).
#    Edit changelog.json — add a new object at the TOP of `versions`.
# 2. Cut the release:
make release                 # patch bump (0.4.4 → 0.4.5)
make release BUMP=minor      # 0.4.4 → 0.5.0
make release BUMP=major      # 0.4.4 → 1.0.0
make release BUMP=0.5.0-rc1  # explicit version
# 3. Push to trigger CI:
git push && git push --tags
```

If you forget step 1, `make release` scaffolds a stub entry and stops — write
its `summary`, then re-run the same command.

## Step 1 — author the changelog entry

`changelog.json` (repo root) is the **single source of truth** for release
notes. Each version carries a short `summary` and a `sections` list of
categorized changes, shown in two places:

- the in-app **Update card** (sidebar) — the latest version's `summary` only;
- the in-app **Changelog dialog** — every version's `summary` as the heading
  plus its sections, each with a label and bullet list, dated.

Add a new object to the **top** of the `versions` array:

```jsonc
{
  "version": "0.4.5",   // must match the version you're releasing
  "date": "",           // leave empty — release.sh stamps it
  "summary": "Short headline (≤15 words).",
  "sections": [
    {
      "label": "Features",
      "items": ["First new thing.", "Second new thing."]
    },
    {
      "label": "Bug fixes",
      "items": ["Something broken that is now fixed."]
    }
  ]
}
```

Common `label` values: `"Features"`, `"Bug fixes"`, `"Improvements"`, `"Sponsors"`.
Use whatever label fits — the renderer shows it as-is. Omit sections with no items.

Field notes:

- **`version`** — must equal the version being released. `make release` gates
  on this: the top entry's `version` must match the computed new version.
- **`date`** — leave empty; `release.sh` stamps today's date automatically.
- **`summary`** — required, ≤15 words. Renders in a narrow sidebar card —
  `release.sh` prints a warning if it exceeds 15 words.
- **`sections`** — required, at least one section with at least one item. Plain
  strings, no markdown. Each item becomes a `<li>` under its section label.

Newest entry first. Never reorder or delete old entries — the dialog shows the
whole history.

## Step 2 — `make release`

`scripts/release.sh`:

1. Refuses to run on a dirty tree (a dirty `changelog.json` is allowed — that's
   the entry you just wrote) or off `main`.
2. Gates on `changelog.json`: scaffolds a stub if the entry is missing, stamps
   the date, and aborts if `summary` is empty.
3. Bumps the version in lockstep across `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json`, and `Cargo.lock`.
4. Commits everything (version files **+ `changelog.json`**) as `release: vX`
   and tags `vX`.

## Step 3 — push, and what CI does

`git push && git push --tags` triggers `.github/workflows/release.yml`:

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
  allowlisted in `tauri.conf.json`'s CSP `connect-src`, and the file is served
  with `Access-Control-Allow-Origin: *`).

`changelog.json` is also seeded directly in the `termic.dev` repo so the
feature works before the first release that runs the updated CI.

## Developing the update UI

`check()` never returns an update in a `tauri dev` build (no signed release to
verify against). Mock it with an env var:

```sh
VITE_MOCK_UPDATE=available npm run tauri dev   # update-available card + pill
VITE_MOCK_UPDATE=whatsnew  npm run tauri dev   # post-update "what's new" card
```

The mock is fully self-contained (no network) — see `src/store/update.ts`.
