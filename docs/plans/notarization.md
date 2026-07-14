# Apple signing and notarization (done + what's left)

Status: **shipped in v0.22.0** (2026-07-14). Everything below was verified against
real artifacts, not inferred from docs. Written up because the traps here are
silent ones: every failure mode we hit produced a green pipeline and a broken
download.

Team ID `BHMSK92RJG`. Enrolled as an Individual, so the signature carries a legal
name, not a company name. Only an Organization account (D-U-N-S, weeks) can show
"Termic".

## What users get

A downloaded `.dmg` opens on first launch. No "unidentified developer", no
right-click to Open, no `xattr -dr com.apple.quarantine`. On macOS 15+ this
matters more than it used to: the right-click bypass is gone, and an unsigned app
sends the user into System Settings.

Second, quieter win: a stable signing identity means macOS stops treating each
update as a new app, so the **microphone grant survives updates** instead of being
re-prompted on every release.

Homebrew is only the *first* install. After that the Tauri updater takes over, and
`Termic.app.tar.gz` is built from the app *after* notarization + stapling, so every
self-update lands a notarized, stapled, hardened-runtime bundle. Verified.

## The two traps

**1. Tauri does not notarize the `.dmg`.** It signs, notarizes and staples the
`.app`, then wraps it in a disk image it never submits. Gatekeeper assesses the
disk image in its own right, so the published DMG came out:

```
source=Unnotarized Developer ID     ← rejected
```

while the app inside it was fine. Homebrew users would never have noticed; everyone
downloading from the Releases page would have hit the exact wall we paid to remove.
The workflow now submits the DMG to `notarytool` separately and staples it.

**Ordering is load-bearing:** that step must run *before* "Compute SHA256", because
stapling **rewrites** the DMG. Reversed, the Homebrew cask carries a pre-staple hash
and every `brew install` fails checksum verification.

**2. Xcode issues certs under the G1 sub-CA.** Apple caps a leaf certificate at its
issuing CA's expiry. The G1 "Developer ID Certification Authority" expires
`2027-02-01`, so a certificate freshly minted by Xcode's Manage Certificates came out
with **203 days** of life, not five years. The tell was that the leaf's `notAfter`
matched the G1 CA's `notAfter` to the second.

**When reissuing (before 2031-07-14): use the web portal and pick the G2 Sub-CA.**
G2 runs to 2031. Xcode gives no choice.

## What the pipeline does now

`.github/workflows/release.yml`, `build-mac`:

1. **Configure signing.** All six Apple secrets or zero. Anything between is a hard
   failure. This matters because tauri **soft-skips** notarization when the auth
   triple is incomplete (a log line, not an error), so a missing `APPLE_API_ISSUER`
   alone yields a signed-but-unnotarized DMG that Gatekeeper rejects just as hard as
   an unsigned one, through a green pipeline.
2. **Build + notarize the app.** Retries 3x, but only on notary/network failures
   (grepped from the log). A compile error still fails on attempt 1.
3. **Notarize + staple the DMG.** Retries 3x on transients, fails immediately on
   `status: Invalid` (Apple's verdict on the artifact; asking again won't change it).
4. **Verify before publish.** `codesign --verify`, the hardened-runtime flag, `spctl`
   reporting `source=Notarized Developer ID`, and a stapled ticket, on **both** the
   app and the DMG. A build that isn't genuinely notarized cannot reach a user.
5. Install footer in the release notes follows the artifact, so it can't advertise a
   Gatekeeper workaround for a build that doesn't need one.

`REQUIRE_NOTARIZATION=true` (repo **variable**, not a secret, so it can't vanish with
them) makes a missing certificate fail the release rather than silently falling back
to ad-hoc. That fallback used to be harmless because the Homebrew cask stripped
quarantine in a `postflight`; once that postflight was removed, an ad-hoc release
would be a build nobody can open.

Cost: ~4 to 6 extra minutes per release (two notary round-trips to Apple). The Mac
job is now the critical path; it used to finish before Linux.

## Hardened runtime

Notarization requires it. Verified working on a notarized build: **PTY spawn,
`sandbox-exec`, the CONNECT egress proxy, and the microphone (voice input)**. Nothing
broke, which is what the analysis predicted (no `dlopen`, no JIT in-process since
WKWebView's JS runs in Apple's out-of-process `WebContent`, and every sandboxed thing
we spawn is a separate `exec`, which library validation doesn't touch).

The `Entitlements.plist` mic entitlement (`com.apple.security.device.audio-input`)
survives signing. Confirmed in the signature.

## Keys

The `.p12` and the App Store Connect `.p8` live in Simion's password manager and in
the GitHub secrets. Nothing else. The signing identity is also in the login keychain.

Losing either is recoverable (new cert, or new API key; five minutes each). Leaking
the `.p12` is not: whoever holds it can ship software as Simion, and macOS will trust
it until 2031.

Note: a dead G1 cert still exists in the portal. Its private key was deleted, and
Apple does not allow revoking Developer ID certs from the portal (revocation would
invalidate everything ever signed with them). Ignore it; it expires 2027-02-01.

Duplicate common names are a real footgun: G1 and G2 both read
`Developer ID Application: Simion Agavriloaei (BHMSK92RJG)`, and `codesign -s` by
name refuses an ambiguous match. Tauri also rejects a SHA-1 hash as the identity (it
cross-checks the name against `APPLE_CERTIFICATE`), so there is no way around it.
Keep exactly one Developer ID identity in the login keychain.

## What's left

**[homebrew/cask#274896](https://github.com/Homebrew/homebrew-cask/pull/274896)** is
open, awaiting review. Only possible because we're notarized: upstream will not take
a cask that disables Gatekeeper, and ours used to. It has a `livecheck`, so it should
be autobump-eligible and track releases without a PR each time.

If it merges:
1. Deprecate `simion/homebrew-termic`. Two taps make `brew install --cask termic`
   ambiguous.
2. Retire the `bump-tap` job in `release.yml`. Upstream autobump replaces it.
3. Change the documented install to `brew install --cask termic` (no tap prefix) in
   `README.md` and on termic.dev.

The tap is only worth keeping for a `termic-beta` cask off `make beta`, which upstream
would never accept.

If it's rejected, nothing breaks. The tap still works and is still the documented path.

**Known doc bug, unfixed:** `README.md` and termic.dev both suggest
`brew upgrade --cask termic`, which is a no-op while the cask sets `auto_updates true`
(it needs `--greedy`). Harmless, since the in-app updater is the real path, but wrong.

**Dead code, left as a guard:** the `else` branch of the install footer in
`release.yml` (the one printing `xattr` instructions) is now unreachable, since
`REQUIRE_NOTARIZATION` hard-fails a secretless build.
