// Per-profile localStorage namespacing (GH #280).
//
// Every profile window is a webview on the SAME origin, so localStorage is
// shared between them whether we want it or not. Anything keyed by task UUID
// is already safe (UUIDs are disjoint across profiles); anything keyed by a
// name, a project id or nothing at all is silently global and has to be
// namespaced by hand.
//
// The namespace is the WINDOW LABEL, which is available synchronously. That
// matters more than it looks: stores read their keys at module-init time, so
// an async `invoke("profiles_list")` would be too late and every store would
// boot from the wrong profile's state for a frame.
//
// The root profile's keys are UNPREFIXED, deliberately. Its label is `main`,
// which maps to the empty namespace, so an existing install's collapse state,
// folder colors and prompt library are read from exactly the keys they are
// already in. No migration, and no user notices anything.
//
// What is NOT scoped, and must not be: preferences. Theme, fonts, terminal
// settings, editor settings and shortcut bindings are machine-level in
// docs/plans/profiles.md's scope table ("muscle memory does not change per
// identity"), so they stay on their bare keys and are shared by every window.

/// The window label, read once. Falls back to the root namespace outside a
/// Tauri window (vitest, and the `activity.html` entry).
function windowLabel(): string {
  try {
    // Imported lazily off the global Tauri bridge rather than
    // `@tauri-apps/api/window`, so this module stays importable from a plain
    // jsdom test without pulling the whole API surface in.
    const label = (globalThis as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
      .__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
    return typeof label === "string" ? label : "main";
  } catch {
    return "main";
  }
}

/// This window's label ("main" for the root profile): servers and paired
/// computers belong to one profile and are listed only in its window.
export const WINDOW_LABEL: string = windowLabel();

/// `""` for the root profile, `"profile-<slug>:"` for every other.
export const PROFILE_NS: string = (() => {
  const label = windowLabel();
  return label === "main" || !label.startsWith("profile-") ? "" : `${label}:`;
})();

/// Namespace a PROFILE-SCOPED localStorage key.
///
/// Use for anything a profile owns: project/task collapse state, folder
/// colors, the prompt library, per-profile dialog memory. Do NOT use for
/// preferences, which are shared on purpose.
export function scoped(key: string): string {
  return PROFILE_NS + key;
}

/// Remove every `profile-<slug>:` key for one profile.
///
/// Called after a profile is deleted, or a recreated profile with the same
/// slug inherits a dead one's collapse state and folder colors.
export function purgeProfileKeys(slug: string): void {
  const prefix = `profile-${slug}:`;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    // Private windows and blocked site data throw on access. A failed purge
    // leaves stale keys, which is untidy; throwing here would break the
    // delete, which is worse.
  }
}

/**
 * What the CURRENT setup holds, for the panel that asks you to name it
 * (GH #280).
 *
 * The New profile dialog asks for two names, and the first one surprises
 * people: nobody opening "New profile" expects to be asked to name something
 * that already exists. Labels alone were not enough ("This window" still reads
 * as chrome), so the panel states what is in it. Real counts the user
 * recognises are the thing that makes it unmistakably THEIR setup rather than
 * a second empty form.
 *
 * Reads as reassurance too: these are the things people are afraid a new
 * profile will move.
 */
export function currentSetupSummary(projects: number, tasks: number): string {
  const p = projects === 1 ? "1 project" : `${projects} projects`;
  const t = tasks === 1 ? "1 task" : `${tasks} tasks`;
  if (projects === 0 && tasks === 0) {
    // A brand-new install. Counting nothing would read as a bug, and the
    // reassurance is meaningless when there is nothing to reassure about.
    return "Everything you set up from now on stays in it.";
  }
  if (tasks === 0) return `Its ${p} stay exactly where they are.`;
  if (projects === 0) return `Its ${t} stay exactly where they are.`;
  return `Its ${p} and ${t} stay exactly where they are.`;
}

/**
 * Should ⌘W close this profile's WINDOW (GH #280)?
 *
 * ⌘W closes the innermost thing there is to close, and when a window has
 * nothing left in it the window itself is that thing. This is the browser
 * convention (a tab, then the last tab takes the window with it), and the
 * reason it needs a rule at all is the LAST window.
 *
 * Closing the last one is not "close a window", it is "quit", and quitting is
 * governed by the close-action setting (menu bar / quit / ask) and by ⌘Q.
 * Escalating a tab-close key into a quit is the kind of surprise that loses
 * someone's running agents, so ⌘W stays a no-op there and the red button and
 * ⌘Q keep that job.
 */
export function shouldCloseProfileWindow(args: {
  /** Is a task open in this window? ⌘W belongs to the task while there is one. */
  hasActiveTask: boolean;
  /** How many profile windows are open right now, this one included. */
  openWindows: number;
}): boolean {
  if (args.hasActiveTask) return false;
  return args.openWindows > 1;
}

/**
 * Is this profile's slug worth printing under its name?
 *
 * The slug names the folders on disk, so it is genuinely useful when it
 * DIFFERS from what you would guess: "Side Project" lives in `side-project`,
 * and a second "Work" lives in `work-2`. When it is just the name lowercased
 * it says nothing, and a row reading "Personal" above "personal" looks like a
 * bug rather than like information.
 */
export function slugWorthShowing(name: string, slug: string): boolean {
  return slug !== name.trim().toLowerCase();
}
