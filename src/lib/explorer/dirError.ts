// Turn a rejected `task_dir_list` into something a user can act on (GH #250).
//
// #159 gave a failed directory read a retry row instead of a "Loading…" that
// never resolved, but the row said "Couldn't read this folder" and nothing
// else, so the follow-up report had no more information in it than the bug it
// replaced. The raw error is a Rust `io::Error` string ("Permission denied
// (os error 13)") or one of the containment checks in `safe_task_path`, both
// of which name the actual cause once you can see them.
//
// `short` is the headline the row shows; `detail` is the raw message, shown
// underneath and in the title, because the errno and the resolved path are
// what make a report like #250 diagnosable.

import { i18n } from "@/lib/i18n";

export interface DirError {
  /** Human headline, no trailing period (the row adds its own separator). */
  short: string;
  /** The raw error, kept verbatim for the tooltip and the second line. */
  detail: string;
}

// Values are backend:dirError KEYS, resolved at call time so a language
// switch applies to the next failed read. The regexes match the raw Rust
// error text, which never localizes.
const RULES: Array<[RegExp, string]> = [
  // A symlinked folder pointing outside the task. It always fails, and no
  // amount of retrying changes that, so say so instead of offering hope.
  [/path escapes task/i, "escapesTask"],
  [/`\.\.` segments not allowed|absolute paths not allowed/i, "pathNotAllowed"],
  [/os error 2\b|no such file or directory/i, "gone"],
  [/os error 13\b|permission denied/i, "permissionDenied"],
  [/os error 20\b|not a directory/i, "notADirectory"],
  [/os error 62\b|too many levels of symbolic links/i, "symlinkLoop"],
  [/os error 24\b|too many open files/i, "tooManyOpenFiles"],
  [/^no task\b/i, "taskGone"],
];

/** Classify a `task_dir_list` rejection. `e` is whatever the promise rejected
 *  with: Tauri hands back the Rust `Err(String)`, but an exception from the
 *  bridge itself is possible too, so everything goes through `String()`. */
export function explainDirError(e: unknown): DirError {
  const detail = (typeof e === "string" ? e : e instanceof Error ? e.message : String(e)).trim();
  for (const [re, key] of RULES) if (re.test(detail)) return { short: i18n.t(`backend:dirError.${key}`), detail };
  // Unrecognised: the raw message IS the headline. Better a cryptic errno on
  // screen than the generic sentence that made #250 unactionable.
  return { short: detail || i18n.t("backend:dirError.unknown"), detail };
}
