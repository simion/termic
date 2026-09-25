// Docker sandbox image rebuild nudge, on a user-configurable frequency
// (Settings.docker_rebuild_frequency: off/daily/weekly, defaults daily).
// Agent CLIs in the image are intentionally unpinned (always-latest per
// Dockerfile.default's own comment), which means an image that isn't
// rebuilt WITHOUT cache can run an indefinitely stale binary even though
// nothing about the Dockerfile itself changed. This runs right before a
// Docker-mode task's agent launches, not on a timer - "due" is evaluated
// whenever the user next spawns one. Unlike a silent auto-rebuild, this
// PROMPTS (DockerRebuildPromptDialog) so someone in a hurry can skip it for
// that one launch with a single click.

import { dockerImageStatus, dockerBuildImage, onDockerBuildDone, onDockerBuildLog, settingsLoad, settingsSave } from "./ipc";
import type { Task } from "./types";
import { useUI } from "@/store/ui";
import { useDockerBuild } from "@/store/dockerBuild";
import { i18n } from "@/lib/i18n";

export type DockerRebuildFrequency = "off" | "daily" | "weekly";

/** Is a rebuild due, given the configured frequency and the last build's
 *  LOCAL calendar date (`YYYY-MM-DD`, as recorded by the Rust side)? Pure
 *  and exported so the day-boundary math is unit-testable without faking
 *  IPC. `null` (never built) is always due - callers gate on image
 *  availability separately, since "never built" also means "nothing to
 *  launch with" and is handled upstream of this check. */
/** Whole CALENDAR days between two local dates.
 *
 *  Not a millisecond subtraction: the stored value is a date with no time,
 *  so the only meaningful unit is days-on-the-calendar. Normalising each
 *  side to a UTC midnight makes the difference exact across a DST boundary,
 *  where a local day is 23 or 25 hours and dividing by 86_400_000 rounds to
 *  the wrong day. */
function calendarDaysBetween(from: Date, to: Date): number {
  const dayIndex = (d: Date) =>
    Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  return dayIndex(to) - dayIndex(from);
}

export function isRebuildDue(frequency: "daily" | "weekly", lastBuiltDateIso: string | null, now: Date = new Date()): boolean {
  if (!lastBuiltDateIso) return true;
  const last = new Date(`${lastBuiltDateIso}T00:00:00`);
  if (Number.isNaN(last.getTime())) return true;
  const daysSince = calendarDaysBetween(last, now);
  return frequency === "daily" ? daysSince >= 1 : daysSince >= 7;
}

/** Human-readable "when was this last built" line, shared by Settings →
 *  Docker and the rebuild prompt dialog. */
export function describeLastBuildDate(lastBuiltDateIso: string | null, now: Date = new Date()): string {
  if (!lastBuiltDateIso) return i18n.t("backend:dockerRebuild.lastBuiltNever");
  const last = new Date(`${lastBuiltDateIso}T00:00:00`);
  if (Number.isNaN(last.getTime())) return i18n.t("backend:dockerRebuild.lastBuiltNever");
  // Calendar days, like isRebuildDue - NOT `now - last` rounded. Measuring
  // from the current time meant an image built at 09:00 TODAY read as "last
  // built yesterday" from about midday onward (0.6 of a day, rounded up),
  // and one built yesterday became "2 days ago" after ~36 hours. The two
  // functions disagreeing is the real bug: the prompt said the image was a
  // day older than the check that decided a rebuild was due.
  const days = Math.max(0, calendarDaysBetween(last, now));
  if (days <= 0) return i18n.t("backend:dockerRebuild.lastBuiltToday");
  if (days === 1) return i18n.t("backend:dockerRebuild.lastBuiltYesterday");
  return i18n.t("backend:dockerRebuild.lastBuiltDaysAgo", { days });
}

// Single-flight: two Docker-mode tasks launched close together must not
// each prompt separately / each kick off their own `docker build
// --no-cache`. A second call while one is already in flight (prompt still
// open, or a build running) just awaits the same outcome - same prompt
// answer applies to both launches.
let inFlight: Promise<void> | null = null;

/** Before spawning a Docker-mode agent, prompt for (and on "rebuild",
 *  await) a rebuild if one is due. Resolves immediately (no-op) for
 *  anything the feature doesn't apply to: task not in Docker mode, the
 *  global switch off, frequency set to "off", no image has EVER been built
 *  (the spawn's own "Docker image not built" error already covers that),
 *  or nothing is due yet per the configured frequency. Never throws - a
 *  skipped or failed rebuild just means the caller proceeds to spawn with
 *  whatever image already exists. */
export async function maybeRebuildDockerImageForLaunch(task: Task): Promise<void> {
  if (!task.docker_sandbox_enabled) return;

  let settings, status;
  try {
    [settings, status] = await Promise.all([settingsLoad(), dockerImageStatus()]);
  } catch {
    return; // can't tell - don't block launch on a probe failure
  }
  if (!settings.docker_sandbox_enabled) return;
  const frequency = settings.docker_rebuild_frequency ?? "daily";
  if (frequency === "off") return;
  if (!status.available) return;
  if (!isRebuildDue(frequency, status.last_built_date)) return;

  if (inFlight) return inFlight;
  // `docker_rebuild_auto` means the user already answered this question with
  // "Always rebuild"; asking again is the annoyance, not the safeguard.
  const ask = !settings.docker_rebuild_auto;
  inFlight = promptAndRebuild(task, status.last_built_date, ask)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** How long to wait for `docker-build://done` before giving up on it. Long
 *  enough that a real no-cache build of a multi-GB image finishes first;
 *  short enough that a lost event does not strand the launch. */
const REBUILD_EVENT_TIMEOUT_MS = 15 * 60 * 1000;

async function promptAndRebuild(task: Task, lastBuiltDate: string | null, ask: boolean): Promise<void> {
  // Automatic ALWAYS means background: someone who turned the prompt off said
  // "stop interrupting me", and silently blocking their first launch of the
  // day would be that same interruption without the dialog.
  let background = !ask;
  if (ask) {
    const choice = await useUI.getState().askDockerRebuild(task.name, lastBuiltDate);
    if (choice === "skip") return;
    background = choice === "always" || choice === "background";
    if (choice === "always") {
      // Persist BEFORE the build so the answer survives even if the rebuild
      // fails or the app is closed while it runs.
      try {
        const cur = await settingsLoad();
        await settingsSave({ ...cur, docker_rebuild_auto: true });
      } catch { /* not worth failing the launch over */ }
    }
  }

  if (background) {
    // Start it and get out of the way. This launch proceeds on the CURRENT
    // image, so the pane is not taken over and nothing is awaited - the whole
    // point of the choice is that the agent starts now. `inFlight` still
    // single-flights it, so a second launch will not kick off a rival build.
    useUI.getState().pushToast(
      i18n.t("backend:dockerRebuild.backgroundStarted"),
      "info",
      { ttlMs: 8000 },
    );
    void dockerBuildImage(true).catch(() => {
      useUI.getState().pushToast(
        i18n.t("backend:dockerRebuild.failedSettings"),
        "error",
        { ttlMs: 8000 },
      );
    });
    return;
  }

  useUI.getState().pushToast(
    i18n.t("backend:dockerRebuild.beforeLaunch"),
    "info",
    { ttlMs: 15000 },
  );
  // Stream the build into the task's own pane. A toast alone left the pane
  // empty for minutes with no way to tell a slow build from a wedged one.
  useDockerBuild.getState().start(task.id);
  const unlistenLog = await onDockerBuildLog((line: string) => useDockerBuild.getState().append(line));
  // Register the listener BEFORE starting the build, and await the
  // registration. Three things were wrong with doing it the other way:
  // `unlisten` was assigned inside a `.then()`, so a build that rejected
  // immediately called finish() before it existed and leaked the listener
  // for the rest of the session; a build that FAILED fast (bad Dockerfile,
  // daemon stopped since the check) could emit `done` before any listener
  // was attached; and there was no timeout at all, so a lost event blocked
  // the agent launch that awaits this, forever, with no way out.
  let settle!: (ok: boolean) => void;
  const done = new Promise<boolean>(resolve => { settle = resolve; });
  const unlisten = await onDockerBuildDone(({ success }) => settle(success));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let success: boolean;
  try {
    // WITHOUT cache: a cached build would just replay the old `RUN npm
    // install -g ...` layers unchanged and accomplish nothing (same as
    // the manual "Update agents" button - see Dockerfile.default).
    dockerBuildImage(true).catch(() => settle(false));
    success = await Promise.race([
      done,
      // A backstop, not a deadline: a no-cache build of a multi-GB image is
      // legitimately slow, so this only catches a `done` that never arrives.
      // Timing out reports failure, and the documented fallback for a failed
      // rebuild is to launch with the existing image - which beats an agent
      // that never starts.
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), REBUILD_EVENT_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unlisten();
    unlistenLog();
  }
  useDockerBuild.getState().finish(success);
  // Leave a failed build on screen: the log is the only explanation the user
  // gets, and the agent is about to launch on the old image anyway. A clean
  // build clears itself, since the terminal is what should be there.
  if (success) useDockerBuild.getState().clear();
  if (success) {
    useUI.getState().pushToast(i18n.t("backend:dockerRebuild.rebuilt"), "success", { ttlMs: 4000 });
  } else {
    useUI.getState().pushToast(
      i18n.t("backend:dockerRebuild.failedExisting"),
      "error",
      { ttlMs: 8000 },
    );
  }
}
