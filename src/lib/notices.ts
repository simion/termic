// In-app notices a user can turn off, from the notice itself (Dismiss >
// "Don't show this again") or from Settings > Notifications. A toast opts in
// by passing `notice: <key>` to pushToast; one without a key always shows.
// Keys are persisted (prefs `mutedNotices`), so never rename one.
export const NOTICES = ["prMergedAsk", "prMergedAuto", "prOpened"] as const;
export type NoticeKey = typeof NOTICES[number];

/** localStorage key of the muted list (prefs `mutedNotices` owns writes). */
export const LS_MUTED_NOTICES = "mutedNotices";

/** Read straight from storage, not the prefs store, so the UI store can ask
 *  without importing prefs (which touches the DOM at import time). */
export function isNoticeMuted(key: NoticeKey): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(LS_MUTED_NOTICES) ?? "[]");
    return Array.isArray(v) && v.includes(key);
  } catch { return false; }
}
