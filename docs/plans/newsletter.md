# Newsletter signup (weekly updates)

Goal: build an email subscriber list for a weekly "what's changed" update,
collected from **both** the termic.dev site and inside the termic app.

## Provider: Kit (ConvertKit)

Chosen for the larger free tier (10k subscribers) over Buttondown (100).

Key property that makes this simple: Kit's **public form-subscribe endpoint
needs no API key**, so the static site and the desktop app can both POST to
it directly. No backend, no stored secret (which we'd never want to ship in
a desktop binary anyway).

```
POST https://app.kit.com/forms/<FORM_ID>/subscriptions
Content-Type: application/json
{ "email_address": "user@example.com" }
```

### One-time setup before implementing

1. Create a Kit account.
2. Grow, Landing Pages and Forms, create an **inline form**.
3. The embed URL ends in the form id, e.g. `.../forms/8284615/subscriptions`
   → `FORM_ID = 8284615`.
4. Plug that id into the two `<FORM_ID>` placeholders below (one in the
   Rust const, one in the site form). Same id for both.

## Part 1: termic.dev site (Astro on Cloudflare Pages)

Static host, so the plain-HTML-form pattern works with zero Functions.

- Add a styled `<form action="https://app.kit.com/forms/<FORM_ID>/subscriptions"
  method="post">` with an `email_address` input.
- Best home: `src/components/Footer.astro` (alternatively the hero in
  `src/pages/index.astro`).
- Match existing CSS (`src/styles/global.css`). Inline success/error via a
  tiny `<script>` doing `fetch()` + `e.preventDefault()` so the page doesn't
  navigate to Kit's bare response.
- Optional spam hardening: pair with **Cloudflare Turnstile** (free, already
  on CF) since there's no backend to rate-limit.

Site repo lives at `~/r/termic.dev` (see memory: termic-dev-website-repo).

## Part 2: termic app (in-app subscribe)

### Decisions (from the user)

- **Placement:** the bottom-left card slot in the sidebar (same slot as the
  update / what's-new `UpdateCard`). Shown **only if the user hasn't
  subscribed** yet. It must **yield to `UpdateCard`** when a real update or
  unseen release note is live, so the two never stack.
- **Transport:** a **Rust Tauri command** (not webview `fetch`), to bypass
  WKWebView CORS and stay reliable. Async so the HTTPS call never blocks the
  WKWebView event loop (per CLAUDE.md: no synchronous IO-heavy commands).

### 2a. Rust dependency (`src-tauri/Cargo.toml`)

`reqwest` is only in the tree transitively (via `tauri-plugin-updater`), so
pin it direct. Use rustls to avoid pulling OpenSSL.

```toml
# Plain HTTPS POST for the newsletter_subscribe command (Kit public form
# endpoint). Already in the tree via tauri-plugin-updater; pinning it direct
# with rustls keeps it off OpenSSL.
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

(Insert after the `tauri-plugin-process` line.)

### 2b. Rust command (`src-tauri/src/lib.rs`)

Place after the `notify` command (~line 5933).

```rust
/// Kit (ConvertKit) public form id. The termic.dev site form posts to the
/// same id. Public endpoint, no API key needed. Fill once the Kit form
/// exists (Grow, Landing Pages and Forms, create an inline form, the embed
/// URL ends in the id).
const KIT_FORM_ID: &str = "REPLACE_WITH_KIT_FORM_ID";

/// Subscribe an email to the weekly-updates newsletter via Kit's public
/// form endpoint. Async so the HTTPS call never blocks the WKWebView event
/// loop. Returns Err(message) on invalid input or network/HTTP failure so
/// the sidebar card can surface it.
#[tauri::command]
async fn newsletter_subscribe(email: String) -> Result<(), String> {
    let email = email.trim();
    if email.is_empty() || !email.contains('@') {
        return Err("Enter a valid email address.".into());
    }
    let url = format!("https://app.kit.com/forms/{KIT_FORM_ID}/subscriptions");
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "email_address": email }))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("Subscribe failed ({}). Please try again.", resp.status().as_u16()))
    }
}
```

Register it in the `tauri::generate_handler![...]` block (~line 7169),
alongside `notify`:

```rust
notify, newsletter_subscribe, open_path, reveal_path, ...
```

### 2c. IPC wrapper (`src/lib/ipc.ts`)

Add above the `workspaces` section:

```ts
// ───────────────────────────── newsletter ─────────────────────────────

/** Subscribe an email to the weekly-updates newsletter (Kit public form).
 *  Rejects on invalid input or network/HTTP failure (message is shown). */
export const newsletterSubscribe = (email: string) => invoke<void>("newsletter_subscribe", { email });
```

### 2d. Store (`src/store/newsletter.ts`, new file)

Tiny dedicated store (app state / one-shot watermark, not a user pref, so
kept out of `prefs.ts`). localStorage-persisted so the card stays hidden
once subscribed or dismissed.

```ts
// Weekly-updates newsletter signup state. Persisted to localStorage so the
// bottom-left sidebar card stays hidden once the user subscribes (or
// dismisses it). Kept tiny and separate from prefs.ts — this is app state
// (a one-shot prompt watermark), not a user-facing preference.

import { create } from "zustand";
import { newsletterSubscribe } from "@/lib/ipc";

const LS_SUBSCRIBED = "newsletterSubscribed";
const LS_DISMISSED  = "newsletterDismissed";

function lsGet(k: string): boolean {
  try { return localStorage.getItem(k) === "1"; } catch { return false; }
}
function lsSet(k: string) {
  try { localStorage.setItem(k, "1"); } catch { /* private mode / quota */ }
}

type Status = "idle" | "sending" | "error";

interface NewsletterStore {
  subscribed: boolean;
  dismissed: boolean;
  status: Status;
  error: string | null;
  subscribe: (email: string) => Promise<void>;
  dismiss: () => void;
}

export const useNewsletter = create<NewsletterStore>((set) => ({
  subscribed: lsGet(LS_SUBSCRIBED),
  dismissed: lsGet(LS_DISMISSED),
  status: "idle",
  error: null,
  subscribe: async (email) => {
    set({ status: "sending", error: null });
    try {
      await newsletterSubscribe(email);
      lsSet(LS_SUBSCRIBED);
      set({ subscribed: true, status: "idle", error: null });
    } catch (e) {
      // Tauri rejects with the Rust Err string verbatim.
      set({ status: "error", error: String(e) });
    }
  },
  dismiss: () => {
    lsSet(LS_DISMISSED);
    set({ dismissed: true });
  },
}));
```

### 2e. Card component (`src/components/sidebar/NewsletterCard.tsx`, new file)

Mirrors `UpdateCard` styling exactly (same card shell, dismiss button,
accent eyebrow, accent-deep submit button). The update-mode resolution is
duplicated so the card yields the slot when `UpdateCard` would render.

```tsx
// "Weekly updates" signup card — shares the bottom-left sidebar slot with
// UpdateCard (just above the footer). Shown ONLY when:
//   - the sidebar is expanded (compact falls back to nothing),
//   - the user hasn't subscribed or dismissed it, and
//   - no update / what's-new card is competing for the slot (that one wins;
//     a pending update is more urgent than a newsletter nudge).
//
// Posts through the newsletter store → newsletter_subscribe Rust command
// (Kit public form). On success the store flips `subscribed` and the card
// unmounts itself.

import { useState } from "react";
import { useApp } from "@/store/app";
import { useNewsletter } from "@/store/newsletter";
import { useUpdate, entryFor, cmpVersion } from "@/store/update";
import { X, Mail, ArrowRight, RotateCw } from "lucide-react";

export function NewsletterCard() {
  const compact = useApp(s => s.compactSidebar);

  const subscribed = useNewsletter(s => s.subscribed);
  const dismissed  = useNewsletter(s => s.dismissed);
  const status     = useNewsletter(s => s.status);
  const error      = useNewsletter(s => s.error);
  const subscribe  = useNewsletter(s => s.subscribe);
  const dismiss    = useNewsletter(s => s.dismiss);

  // Mirror UpdateCard's mode resolution so the two never stack: if an update
  // or an unseen release note is live, this card yields the slot.
  const update           = useUpdate(s => s.update);
  const currentVersion   = useUpdate(s => s.currentVersion);
  const dismissedVersion = useUpdate(s => s.dismissedVersion);
  const lastSeenVersion  = useUpdate(s => s.lastSeenVersion);
  const changelog        = useUpdate(s => s.changelog);

  const [email, setEmail] = useState("");

  if (compact) return null;
  if (subscribed || dismissed) return null;

  const updateAvailable = !!update && update.version !== dismissedVersion;
  const whatsNew =
    !update && !!currentVersion && cmpVersion(currentVersion, lastSeenVersion) > 0 &&
    !!entryFor(changelog, currentVersion);
  if (updateAvailable || whatsNew) return null;

  const sending = status === "sending";

  return (
    <div className="relative mx-2 mb-2 shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] p-3">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="mb-1.5 flex items-center gap-1 text-[var(--color-accent)]">
        <Mail className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[11px] font-semibold">Weekly updates</span>
      </div>

      <p className="pr-5 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        Get a short email when new features ship.
      </p>

      <form
        className="mt-2 flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!sending && email.trim()) void subscribe(email);
        }}
      >
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          disabled={sending}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-70"
        />
        {error && <p className="text-[11px] text-[var(--color-warn)]">{error}</p>}
        <button
          type="submit"
          disabled={sending || !email.trim()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent-deep)] px-2 py-1.5 text-[12px] font-medium text-white hover:bg-[#8a3a1c] disabled:opacity-70"
        >
          {sending ? (
            <>
              <RotateCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
              <span>Subscribing…</span>
            </>
          ) : (
            <>
              <span>Subscribe</span>
              <ArrowRight className="h-3 w-3 shrink-0" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
```

### 2f. Wire into the Sidebar (`src/components/sidebar/Sidebar.tsx`)

The remaining step (not yet written). Render `NewsletterCard` in the same
absolute bottom-left container that holds `UpdateCard` (~line 693):

```tsx
import { NewsletterCard } from "./NewsletterCard";
// ...
<div className="pointer-events-none absolute inset-x-0 bottom-[var(--bottom-bar-h)] z-20">
  <div className="pointer-events-auto">
    <UpdateCard />
    <NewsletterCard />
  </div>
</div>
```

Both cards self-hide via internal returns; `NewsletterCard` additionally
yields when `UpdateCard` is live (2e), so at most one renders.

## Notes / conventions

- **Copy rule:** no em dashes in user-visible strings (CLAUDE.md). All
  visible copy above complies; em dashes appear only in code comments.
- Theme vars used all exist: `--color-warn` is the error/danger color
  (there is no `--color-danger`).
- Verified theme vars: `--color-accent-deep`, `--color-bg`, `--color-bg-2`,
  `--color-fg-faint` all present in `src/index.css`.
- After Rust changes: quit + relaunch (Rust signature change), not just HMR.
- Do not run e2e proactively (CLAUDE.md) — verify the card manually if
  needed.

## Future upgrade (optional)

Auto-send the weekly email from `make release` via Kit's authenticated v4
API (needs an API key kept server-side / in CI secrets, not in the app).
That would turn the changelog entry into the newsletter body automatically.
If that path is taken, **Resend Broadcasts** is the more API-friendly
alternative to Kit for programmatic sends.

## Status

Implemented once, then fully reverted at the user's request (another agent
was working on the repo concurrently). This doc is the complete record to
re-apply later. Only step 2f (Sidebar wiring) and Part 1 (site form) were
never written; everything else is reproduced verbatim above.
