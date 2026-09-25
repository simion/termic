// Which browser opens preview URLs and terminal links (GH #245).
//
// The user configures a COMMAND TEMPLATE, not an app name. That is the whole
// point: naming an app cannot express "Chrome, but my work profile", which is
// what the issue actually asks for. The template is tokenised and spawned as
// argv in Rust (`browser_argv`) and never touches a shell, so a preview URL's
// `&` cannot be re-parsed.
//
// Two levels, and "empty" means something different at each:
//
//   Settings.preview_browser  ""        → the OS default browser
//                             "cmd …"   → use this everywhere
//   Project.preview_browser   undefined → follow the global setting
//                             ""        → force the OS default for THIS
//                                         project, even when the global
//                                         setting names a browser
//                             "cmd …"   → override for this project
//
// The project level is an optional string rather than a plain one precisely
// so that middle state exists; `tasks_path` (the other project override) has
// no meaningful "off", so it gets away with bare-empty-means-inherit.

import { openExternalUrl } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { useApp } from "@/store/app";
import type { Project } from "@/lib/types";
import { IS_MAC } from "@/lib/shortcuts";

/** The modifier that opens a terminal link, for help text. Cmd on macOS,
 *  Ctrl elsewhere - the terminal openers gate on `metaKey || ctrlKey`. */
export const LINK_CLICK_MODIFIER = IS_MAC ? "Cmd" : "Ctrl";

/** A ready-made command for the settings dropdown. `command` is written into
 *  the text field, which stays editable: the presets are a starting point, not
 *  the set of supported browsers. */
export interface BrowserPreset {
  label: string;
  command: string;
  /** Shown under the field when this preset is picked. */
  hint?: string;
  /** backend:previewBrowser key suffix for the localized label/hint,
   *  resolved at render (see presetLabel/presetHint). The English text above
   *  is the fallback, so every entry stays readable without the locale. */
  labelKey?: string;
  hintKey?: string;
}

/** macOS presets. `open` is the launcher for all of them: `-a` names the app,
 *  `-n` forces a new instance (which profile selection needs), and everything
 *  after `--args` is passed to the browser's own argv untouched (`man open`).
 *
 *  The profile presets say `Default` rather than `Profile 1` on purpose: a
 *  freshly installed Chrome/Edge/Brave has exactly one profile directory and
 *  it is called `Default`, so `Profile 1` would fail for most users, which is
 *  the silent-dead-link failure this feature exists to avoid. */
export const MAC_BROWSER_PRESETS: BrowserPreset[] = [
  { label: "System default", command: "", labelKey: "systemDefault" },
  { label: "Safari", command: "open -a Safari" },
  { label: "Google Chrome", command: 'open -a "Google Chrome"' },
  { label: "Brave Browser", command: 'open -a "Brave Browser"' },
  { label: "Microsoft Edge", command: 'open -a "Microsoft Edge"' },
  { label: "Firefox", command: "open -a Firefox" },
  { label: "Arc", command: "open -a Arc" },
  {
    label: "Chrome, specific profile",
    labelKey: "chromeProfile",
    command: 'open -na "Google Chrome" --args --profile-directory=Default',
    hint: "Find the profile name at chrome://version, under Profile Path. A fresh install has one, called Default.",
    hintKey: "chromeProfileHint",
  },
  {
    label: "Edge, specific profile",
    labelKey: "edgeProfile",
    command: 'open -na "Microsoft Edge" --args --profile-directory=Default',
    hint: "Find the profile name at edge://version, under Profile Path.",
    hintKey: "edgeProfileHint",
  },
  { label: "Chrome, incognito", labelKey: "chromeIncognito", command: 'open -na "Google Chrome" --args --incognito' },
  { label: "Edge, InPrivate", labelKey: "edgeInPrivate", command: 'open -na "Microsoft Edge" --args --inprivate' },
  { label: "Firefox, private window", labelKey: "firefoxPrivate", command: "open -na Firefox --args -private-window" },
];

/** Linux presets. The launcher is the browser binary itself, so the URL is
 *  simply appended. Chrome's deb installs `google-chrome-stable`; Flatpak
 *  builds run through `flatpak run <app-id>`. */
export const LINUX_BROWSER_PRESETS: BrowserPreset[] = [
  { label: "System default", command: "", labelKey: "systemDefault" },
  { label: "Google Chrome", command: "google-chrome-stable" },
  { label: "Chromium", command: "chromium" },
  { label: "Firefox", command: "firefox" },
  { label: "Brave Browser", command: "brave-browser" },
  { label: "Microsoft Edge", command: "microsoft-edge-stable" },
  {
    label: "Chrome, specific profile",
    labelKey: "chromeProfile",
    command: "google-chrome-stable --profile-directory=Default",
    hint: "Find the profile name at chrome://version, under Profile Path.",
    hintKey: "chromeProfileHintShort",
  },
  { label: "Firefox, named profile", labelKey: "firefoxNamed", command: "firefox -P work" },
  { label: "Firefox, private window", labelKey: "firefoxPrivate", command: "firefox --private-window" },
  { label: "Chrome (Flatpak)", command: "flatpak run com.google.Chrome" },
  { label: "Firefox (Flatpak)", command: "flatpak run org.mozilla.firefox" },
];

/** Localized view of a preset, resolved at render so a language switch
 *  applies without a reload. Falls back to the preset's own English text. */
export function presetLabel(p: BrowserPreset): string {
  return p.labelKey ? i18n.t(`backend:previewBrowser.${p.labelKey}`) : p.label;
}

/** Localized hint for the picked preset, or undefined when it has none. */
export function presetHint(p: BrowserPreset | undefined): string | undefined {
  if (!p) return undefined;
  return p.hintKey ? i18n.t(`backend:previewBrowser.${p.hintKey}`) : p.hint;
}

/** Presets for the platform the app is running on. Windows is not a shipped
 *  target, so it falls through to the Linux list, whose "system default" entry
 *  is the only one that would work there anyway. */
export function browserPresets(platform: string = navigator.platform): BrowserPreset[] {
  return /mac/i.test(platform) ? MAC_BROWSER_PRESETS : LINUX_BROWSER_PRESETS;
}

/** The command that should open a link for `project`, or "" for the OS
 *  default. Pure, so the precedence table above is testable without a store. */
export function resolveBrowserCommand(
  globalCmd: string | undefined,
  projectCmd: string | undefined,
): string {
  // `undefined` on the project = inherit. An empty STRING is a real choice
  // ("use the OS default here"), so it must not fall through to the global.
  if (projectCmd !== undefined) return projectCmd;
  return globalCmd ?? "";
}

/** Open `url` in the configured browser, falling back to the OS default.
 *
 *  Never throws and never leaves a click silently dead: a bad command falls
 *  back to the system browser and says so. That is deliberate — a link that
 *  does nothing is the exact complaint this feature is meant to fix, and a
 *  misconfigured command must not recreate it.
 *
 *  When nothing is configured the backend takes the pre-#245 default path, so
 *  the common case is behaviourally unchanged. */
export async function openWebUrl(url: string, browser: string): Promise<void> {
  try {
    const res = await openExternalUrl(url, browser);
    if (res.used === "fallback") {
      useUI.getState().pushToast(
        i18n.t("backend:previewBrowser.fallbackFailed", { reason: res.reason ?? i18n.t("backend:previewBrowser.unknownError") }),
        "error",
      );
    }
  } catch (e) {
    useUI.getState().pushToast(i18n.t("backend:previewBrowser.openFailed", { url, error: String(e) }), "error");
  }
}

/** `openWebUrl` for a link belonging to a project, resolving precedence. */
export function openWebUrlForProject(
  url: string,
  globalCmd: string | undefined,
  project: Pick<Project, "preview_browser"> | null | undefined,
): Promise<void> {
  return openWebUrl(url, resolveBrowserCommand(globalCmd, project?.preview_browser));
}

/** The browser command for whatever task a terminal belongs to.
 *
 *  Reads the store at CLICK time rather than closing over a render-time value:
 *  terminal effects are long-lived (they own the PTY), so a captured value
 *  would go stale the moment the user changed the setting, and they would have
 *  to restart the tab for it to take. */
export function browserCommandForTask(taskId: string | undefined): string {
  const st = useApp.getState();
  const task = taskId ? st.tasks.find(t => t.id === taskId) : undefined;
  const project = task ? st.projects.find(p => p.id === task.project_id) : undefined;
  return resolveBrowserCommand(st.previewBrowser, project?.preview_browser);
}
