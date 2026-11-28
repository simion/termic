// A paired phone hears about a task the same way whether or not the task is
// "watched" on this computer: watching is a desktop idea (the selected task
// in a focused window), and a window left frontmost while you walk away
// would otherwise keep the phone silent forever. Whether you are actually
// here is Rust's call (push.rs, the idle delay), not this file's.
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { pushPhones } from "@/lib/ipc";
import { taskLabel } from "@/lib/taskLabel";
import { unreadPhrase } from "@/lib/attentionNotify";
import { i18n } from "@/lib/i18n";

/** The line a desktop banner would carry ("project · task" over the agent's
 *  words or a generic phrase), sent to phones that are away. */
export function pushPhonesForTask(taskId: string, attention: boolean, message?: string): void {
  const s = useApp.getState();
  const w = s.tasks.find(t => t.id === taskId);
  const proj = w ? s.projects.find(p => p.id === w.project_id) : undefined;
  const label = w ? taskLabel(w, usePrefs.getState().useBranchAsTaskName) : "";
  const fallback = i18n.t("backend:attentionNotify.taskFallback");
  const title = proj?.name ? `${proj.name} · ${label || fallback}` : (label || fallback);
  const body = message?.trim() || i18n.t("backend:attentionNotify.agentBody", { phrase: unreadPhrase(attention ? "attention" : "done") });
  pushPhones(title, body, taskId, attention);
}
