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

const CHANGELOG_URL = "https://termic.dev/updates/changelog.json";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// localStorage keys. Kept here (not in prefs.ts) because this is app
// state, not a user-facing Settings preference.
const LS_DISMISSED = "updateDismissedVersion"; // update-card dismissal
const LS_LAST_SEEN = "updateLastSeenVersion";  // what's-new watermark

/** One per-version entry in changelog.json. Authored at release time;
 *  see RELEASING.md for the schema.
 *  - `summary` (≤15 words): single-sentence headline, rendered on the
 *    sidebar UpdateCard and as each version's heading line in the
 *    Changelog dialog.
 *  - `notes`: bulleted detail, rendered as a list under the summary in
 *    the Changelog dialog only. Optional for back-compat with older
 *    entries that pre-date the split. */
export interface ChangelogEntry {
  version: string;
  /** ISO date (YYYY-MM-DD), auto-stamped by release.sh. */
  date: string;
  /** One short sentence (≤15 words). */
  summary: string;
  /** Bullet list of changes. Plain strings — no markdown. */
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
  /** Per-version changelog, newest first. null until fetched. */
  changelog: ChangelogEntry[] | null;
  changelogStatus: "idle" | "loading" | "ready" | "error";
  /** Non-null while an install is in flight. */
  installing: Installing;
  /** Version whose update card the user dismissed (× ). */
  dismissedVersion: string;
  /** Newest version whose "what's new" the user has acknowledged. */
  lastSeenVersion: string;

  /** Idempotent. Call once from App. */
  init: () => void;
  fetchChangelog: () => Promise<void>;
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
        set({ update: await check() });
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
    try {
      const res = await fetch(CHANGELOG_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const versions: ChangelogEntry[] = Array.isArray(json?.versions) ? json.versions : [];
      set({ changelog: versions, changelogStatus: "ready" });
    } catch (e) {
      console.warn("[updater] changelog fetch failed:", e);
      set({ changelogStatus: "error" });
    }
  },

  install: async () => {
    const u = get().update;
    if (!u || get().installing) return;
    set({ installing: "downloading" });
    try {
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
    notes: [
      "Configure Spotlight testing per repository",
      "Preview HTML files right inside your workspace",
      "Faster cold-start when opening large repos",
    ],
  },
  {
    version: "9.9.8",
    date: "2026-05-18",
    summary: "A prior version so the Changelog dialog has history to scroll.",
    notes: [
      "Sample bullet one",
      "Sample bullet two",
    ],
  },
];

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
      changelogStatus: "ready",
    };
  }
  // "available" (or any other truthy value)
  return {
    currentVersion: "0.4.0",
    lastSeenVersion: "0.4.0",
    update: makeMockUpdate(MOCK_CHANGELOG[0].version),
    changelog: MOCK_CHANGELOG,
    changelogStatus: "ready",
  };
}
