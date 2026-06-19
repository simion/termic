// Self-update + changelog state. One place that knows whether a newer
// Termic exists, what changed, and whether the user has seen the
// release notes for the version they're currently running.
//
// Two surfaces consume this store:
//   - UpdateCard    (sidebar, expanded)   — rich card, both modes below.
//   - UpdaterBanner (unified bar, pill)   — compact fallback shown when
//                                           the sidebar is collapsed.
//
// Two modes:
//   - "update available" — check() found a newer signed release. The
//     card's primary action downloads + installs + relaunches.
//   - "what's new"       — no pending update, but the running version
//     is newer than the last one whose notes the user dismissed. Shown
//     once after an update lands; click → Changelog dialog.
//
// Data sources:
//   - tauri-plugin-updater check() → the pending Update (Rust-side
//     fetch of termic.dev/updates/latest.json, ed25519-verified).
//   - termic.dev/updates/changelog.json → human-authored per-version
//     title / summary / highlights. Plain fetch() — the CSP allows the
//     host (tauri.conf.json connect-src) and the file is served with
//     Access-Control-Allow-Origin: *.

import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

// Two changelog artifacts served from termic.dev/updates/:
//   - changelog.json — SLIM {version,date,summary} per version. Drives the
//     sidebar UpdateCard summary line + the what's-new version compare.
//   - changelog.md   — the full human-authored CHANGELOG.md. Rendered as-is
//     by the Changelog dialog (the app already has a markdown renderer).
// CHANGELOG.md in the termic repo is the single source of truth; the .json
// is generated from it (see scripts/changelog.mjs) and both are copied here
// by CI on release.
const CHANGELOG_URL = "https://termic.dev/updates/changelog.json";
const CHANGELOG_MD_URL = "https://termic.dev/updates/changelog.md";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// localStorage keys. Kept here (not in prefs.ts) because this is app
// state, not a user-facing Settings preference.
const LS_DISMISSED = "updateDismissedVersion"; // update-card dismissal
const LS_LAST_SEEN = "updateLastSeenVersion";  // what's-new watermark

/** One category block inside a changelog entry. */
export interface ChangelogSection {
  /** Display label: "Features", "Bug fixes", "Sponsors", etc. */
  label: string;
  /** Plain-text bullet items (no markdown). */
  items: string[];
}

/** One per-version entry in changelog.json. Authored at release time;
 *  see RELEASING.md for the schema.
 *  - `summary` (≤15 words): single-sentence headline, rendered on the
 *    sidebar UpdateCard and as each version's heading line in the
 *    Changelog dialog.
 *  - `sections`: categorized change list. Each section has a label
 *    ("Features", "Bug fixes", "Sponsors", etc.) and a list of items.
 *  - `notes`: legacy flat bullet list, kept for back-compat with entries
 *    authored before the sections schema. Rendered without a category
 *    header when sections is absent. */
export interface ChangelogEntry {
  version: string;
  /** ISO date (YYYY-MM-DD), auto-stamped by release.sh. */
  date: string;
  /** One short sentence (≤15 words). */
  summary: string;
  /** Categorized change list (current schema). */
  sections?: ChangelogSection[];
  /** Legacy flat bullet list. Still rendered for old entries. */
  notes?: string[];
}

/** Numeric x.y.z compare. Returns >0 when `a` is newer than `b`.
 *  parseInt stops at a `-rcN` suffix, so prereleases compare by their
 *  numeric core (good enough — the worst case is a what's-new card not
 *  showing for an rc build). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i] ?? "0", 10) || 0) - (parseInt(pb[i] ?? "0", 10) || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Changelog entry for a version, if present. */
export function entryFor(
  changelog: ChangelogEntry[] | null,
  version: string,
): ChangelogEntry | null {
  return changelog?.find(e => e.version === version) ?? null;
}

const lsGet = (k: string): string => {
  try { return localStorage.getItem(k) ?? ""; } catch { return ""; }
};
const lsSet = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* private mode / quota */ }
};

type Installing = "downloading" | "installing" | null;

interface UpdateState {
  /** Running app version (getVersion()). Empty until resolved. */
  currentVersion: string;
  /** Pending update, or null. The raw Tauri object — it carries
   *  downloadAndInstall(), so we keep it rather than a copy. */
  update: Update | null;
  /** Per-version changelog (slim: version/date/summary), newest first. Drives
   *  the UpdateCard summary + what's-new compare. null until fetched. */
  changelog: ChangelogEntry[] | null;
  changelogStatus: "idle" | "loading" | "ready" | "error";
  /** Full CHANGELOG.md text, rendered by the Changelog dialog. null until
   *  fetched (or if the .md fetch failed but the .json succeeded). */
  changelogMarkdown: string | null;
  /** Non-null while an install is in flight. */
  installing: Installing;
  /** Version whose update card the user dismissed (× ). */
  dismissedVersion: string;
  /** Newest version whose "what's new" the user has acknowledged. */
  lastSeenVersion: string;

  /** Idempotent. Call once from App. */
  init: () => void;
  fetchChangelog: () => Promise<void>;
  /** Manual "check for updates" (command palette). Re-probes the updater
   *  and refetches the changelog. Resolves with the outcome so the caller
   *  can toast. In dev (no signed release) always resolves "uptodate". */
  checkNow: () => Promise<"available" | "uptodate" | "error">;
  install: () => Promise<void>;
  dismissUpdate: () => void;
  dismissWhatsNew: () => void;
}

let _initialized = false;

export const useUpdate = create<UpdateState>((set, get) => ({
  currentVersion: "",
  update: null,
  changelog: null,
  changelogStatus: "idle",
  changelogMarkdown: null,
  installing: null,
  dismissedVersion: lsGet(LS_DISMISSED),
  lastSeenVersion: lsGet(LS_LAST_SEEN),

  init: () => {
    if (_initialized) return;
    _initialized = true;

    // Dev: check() can't return a real update (no signed release to
    // verify against). VITE_MOCK_UPDATE fabricates fully self-contained
    // state so the card / pill / dialog are developable. See RELEASING.md.
    if (import.meta.env.DEV && import.meta.env.VITE_MOCK_UPDATE) {
      set(devMockState(String(import.meta.env.VITE_MOCK_UPDATE)));
      return;
    }

    // Resolve the running version, then settle the what's-new
    // watermark. First run (no stored watermark) silently adopts the
    // current version — a user updating INTO the first build with this
    // feature shouldn't get a spurious "what's new" for it.
    getVersion()
      .then(v => {
        set({ currentVersion: v });
        if (!get().lastSeenVersion) {
          lsSet(LS_LAST_SEEN, v);
          set({ lastSeenVersion: v });
        }
      })
      .catch(() => { /* getVersion only fails outside Tauri */ });

    get().fetchChangelog();

    // check() is meaningless in dev — stop here.
    if (import.meta.env.DEV) return;

    const probe = async () => {
      try {
        const u = await check();
        set({ update: u });
        // A release that landed AFTER startup won't be in the changelog we
        // fetched at init(), so entryFor() returns null and the card falls
        // back to a generic, summary-less line (GH #41). Refetch so the real
        // release notes resolve for the newly-surfaced version.
        if (u && !entryFor(get().changelog, u.version)) await get().fetchChangelog();
      } catch (e) {
        // Network down / malformed manifest — no card, no harm.
        console.warn("[updater] check failed:", e);
      }
    };
    probe();
    window.setInterval(probe, CHECK_INTERVAL_MS);
  },

  fetchChangelog: async () => {
    if (get().changelogStatus === "loading") return;
    set({ changelogStatus: "loading" });
    // Fetch the slim JSON (drives the card + what's-new) and the full markdown
    // (rendered by the dialog) together. The JSON is the one that gates status:
    // the card must have a summary. The markdown is best-effort — if only it
    // fails the dialog falls back to the JSON summaries.
    const [jsonRes, mdRes] = await Promise.allSettled([
      fetch(CHANGELOG_URL, { cache: "no-cache" }),
      fetch(CHANGELOG_MD_URL, { cache: "no-cache" }),
    ]);
    try {
      if (jsonRes.status !== "fulfilled" || !jsonRes.value.ok) {
        throw new Error(jsonRes.status === "fulfilled" ? `HTTP ${jsonRes.value.status}` : String(jsonRes.reason));
      }
      const json = await jsonRes.value.json();
      const versions: ChangelogEntry[] = Array.isArray(json?.versions) ? json.versions : [];
      let markdown: string | null = null;
      if (mdRes.status === "fulfilled" && mdRes.value.ok) {
        markdown = await mdRes.value.text();
      } else {
        console.warn("[updater] changelog.md fetch failed (falling back to summaries)");
      }
      set({ changelog: versions, changelogMarkdown: markdown, changelogStatus: "ready" });
    } catch (e) {
      console.warn("[updater] changelog fetch failed:", e);
      set({ changelogStatus: "error" });
    }
  },

  checkNow: async () => {
    get().fetchChangelog();
    if (import.meta.env.DEV) return "uptodate";
    try {
      const u = await check();
      set({ update: u });
      return u ? "available" : "uptodate";
    } catch (e) {
      console.warn("[updater] manual check failed:", e);
      return "error";
    }
  },

  install: async () => {
    if (!get().update || get().installing) return;
    set({ installing: "downloading" });
    try {
      // Re-probe before installing. The pending `update` may have been
      // captured by a periodic check hours ago; meanwhile an even newer
      // release could have shipped. Installing the stale one would land the
      // user a version behind and immediately re-prompt them (GH #41). A
      // fresh check() returns whatever the manifest points at right now.
      let u = get().update!;
      try {
        const fresh = await check();
        if (fresh && cmpVersion(fresh.version, u.version) > 0) {
          u = fresh;
          set({ update: fresh });
          if (!entryFor(get().changelog, fresh.version)) await get().fetchChangelog();
        }
      } catch (e) {
        // Network blip — fall back to the update we already hold.
        console.warn("[updater] pre-install re-check failed:", e);
      }
      // Progress callback ignored for v1 — banner just says "Downloading".
      await u.downloadAndInstall();
      set({ installing: "installing" });
      // relaunch() spawns the freshly-installed .app and exits this one.
      await relaunch();
    } catch (e) {
      console.error("[updater] install failed:", e);
      set({ installing: null });
    }
  },

  dismissUpdate: () => {
    const u = get().update;
    if (!u) return;
    lsSet(LS_DISMISSED, u.version);
    set({ dismissedVersion: u.version });
  },

  dismissWhatsNew: () => {
    const v = get().currentVersion;
    if (!v) return;
    lsSet(LS_LAST_SEEN, v);
    set({ lastSeenVersion: v });
  },
}));

// ─── dev mock ─────────────────────────────────────────────────────────

const MOCK_CHANGELOG: ChangelogEntry[] = [
  {
    version: "9.9.9",
    date: "2026-05-21",
    summary: "Per-repository Spotlight testing and in-workspace HTML preview.",
    sections: [
      { label: "Features", items: [
        "Configure Spotlight testing per repository.",
        "Preview HTML files right inside your workspace.",
      ]},
      { label: "Bug fixes", items: [
        "Faster cold-start when opening large repos.",
      ]},
    ],
  },
  {
    version: "9.9.8",
    date: "2026-05-18",
    summary: "A prior version so the Changelog dialog has history to scroll.",
    sections: [
      { label: "Features", items: ["Sample feature one.", "Sample feature two."] },
    ],
  },
];

// Markdown counterpart of MOCK_CHANGELOG, so VITE_MOCK_UPDATE exercises the
// dialog's markdown rendering offline (mirrors the real changelog.md shape).
const MOCK_CHANGELOG_MD = `# Changelog

## [9.9.9] - 2026-05-21

Per-repository Spotlight testing and in-workspace HTML preview.

### Features
- Configure Spotlight testing per repository.
- Preview HTML files right inside your workspace.

### Bug fixes
- Faster cold-start when opening large repos.

## [9.9.8] - 2026-05-18

A prior version so the Changelog dialog has history to scroll.

### Features
- Sample feature one.
- Sample feature two.
`;

/** Dev-only fake Update — cast through unknown; the app only ever
 *  touches version / currentVersion / downloadAndInstall(). */
function makeMockUpdate(version: string): Update {
  return {
    version,
    currentVersion: "0.4.0",
    downloadAndInstall: async () => { console.log("[updater] mock install, no-op in dev"); },
  } as unknown as Update;
}

/** Fully self-contained mock state (no network) for `npm run tauri dev`
 *  with VITE_MOCK_UPDATE=available | whatsnew. */
function devMockState(mode: string): Partial<UpdateState> {
  if (mode === "whatsnew") {
    return {
      currentVersion: MOCK_CHANGELOG[0].version,
      lastSeenVersion: "0.0.0",
      changelog: MOCK_CHANGELOG,
      changelogMarkdown: MOCK_CHANGELOG_MD,
      changelogStatus: "ready",
    };
  }
  // "available" (or any other truthy value)
  return {
    currentVersion: "0.4.0",
    lastSeenVersion: "0.4.0",
    update: makeMockUpdate(MOCK_CHANGELOG[0].version),
    changelog: MOCK_CHANGELOG,
    changelogMarkdown: MOCK_CHANGELOG_MD,
    changelogStatus: "ready",
  };
}
