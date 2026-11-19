// The OS window title follows the active task and tab (GH #462), so a time
// tracker that reads window titles (ActivityWatch) can tell projects apart.
// Nothing in the app draws this title: termic paints its own chrome, so it
// shows only in the taskbar, Alt-Tab, the Window menu and such trackers.

import { useEffect } from "react";
import { useApp } from "@/store/app";
import { useProfiles } from "@/store/profiles";

/** `Termic[ - profile] - project / task - tab`. The tab's static title, never
 *  its live OSC one: an agent rewrites that on every spinner frame, and each
 *  change would be an IPC call. */
export function windowTitle(base: string, project?: string, task?: string, tab?: string): string {
  if (!task) return base;
  return `${base} - ${project ? `${project} / ` : ""}${task}${tab ? ` - ${tab}` : ""}`;
}

export function useWindowTitle() {
  // The same base Rust gives the window at creation and on a profile rename.
  // `null` until the registry is read, so a profile window never flashes the
  // root's bare "Termic".
  const base = useProfiles(s => {
    if (!s.loaded) return null;
    const p = s.profiles.find(x => x.slug === s.current);
    return p && !p.is_root ? `Termic - ${p.name}` : "Termic";
  });
  // A string, so an unrelated store write re-runs this and re-renders nothing.
  const title = useApp(s => {
    if (base === null) return null;
    const task = s.tasks.find(t => t.id === s.activeTaskId);
    if (!task) return base;
    const project = s.projects.find(p => p.id === task.project_id)?.name;
    const tabId = s.activeTab[task.id];
    const tab = tabId ? s.tabs[task.id]?.find(t => t.id === tabId)?.title : undefined;
    return windowTitle(base, project, task.name, tab);
  });
  useEffect(() => {
    if (title === null) return;
    latest = title;
    // One at a time, newest wins: a task switch changes the title two or
    // three times in a burst, and independent async calls can land out of
    // order. Seen once on Windows CI as a title stuck on the old task;
    // that ordering was the cause is not established.
    queue = queue.then(async () => {
      if (title !== latest) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setTitle(title);
    }).catch(() => { /* no window: tests */ });
  }, [title]);
}

let queue: Promise<void> = Promise.resolve();
let latest = "";
