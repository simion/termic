// `termic://` URL scheme (GH #192): let an external system (a ticket
// tracker, an internal dashboard, a shell alias) drive Termic from a link.
//
//   termic://new?project=web&name=fix-login&prompt=Fix%20the%20login%20bug
//   termic://open?project=web&task=fix-login
//
// The two actions sit on opposite sides of one rule:
//
//   NAVIGATION IS IMMEDIATE, STATE CHANGE IS A MODAL.
//
// `open` only selects a task that already exists, so it just happens.
// `new` NEVER CREATES ANYTHING — it pre-fills the dialog and a human presses
// Create. That is the entire security model for `new`, and it is deliberate:
// links are authored in the ticket tracker, so whoever can file or edit an
// issue (in many orgs that includes external reporters) controls `prompt`.
// Confirming in the UI means the prompt is on screen, editable, and
// cancellable before an agent ever sees it. Nothing here may grow an
// "auto-create" or "skip confirmation" option, and any action added later
// that CHANGES something has to go through a dialog too.
//
// The confirm step pays off a second way, for a mistake rather than an
// attack. A tracker that expands `{{issue.summary}}` without a URL-encode
// filter silently truncates at the first `&` or `#` (both common in ticket
// titles), turning "Fix login & signup" into "Fix login ". The user sees
// the mangled text in the textarea instead of an agent acting on half a
// sentence. Template authors: apply the tracker's encode filter (Jira
// automation's `.urlEncode()`, and equivalents elsewhere).
//
// Rust hands the raw URL across untouched (see `queue_deep_link`); all
// parsing and validation is here, because the checks that matter — does
// this name a project the user actually registered, and a task that
// actually exists? — need the store.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import type { Project, Task } from "@/lib/types";

/** Prompt cap. Long enough for the intended use (a summarized ticket, per
 *  the issue thread), short enough that a hostile link cannot wedge the
 *  dialog behind a multi-megabyte textarea. A prompt over the cap is
 *  REJECTED, not silently truncated: half a prompt is worse than none,
 *  because the user would have to spot the missing tail themselves. */
export const MAX_PROMPT_CHARS = 8000;

/** Cap on the name field too, for the same reason. Task names feed branch
 *  derivation, so an absurd one fails deeper in the stack with a worse
 *  message than this one. */
export const MAX_NAME_CHARS = 200;

/** A parsed, validated `termic://new` link, in the shape the New Task
 *  dialog seeds from. `projectId` is a real registered project's id. */
export interface DeepLinkNew {
  action: "new";
  projectId: string;
  name?: string;
  prompt?: string;
  agent?: string;
  mode?: "worktree" | "repo_root";
  base?: string;
}

/** A parsed `termic://open` link. `taskId` is a live (non-archived) task. */
export interface DeepLinkOpen {
  action: "open";
  taskId: string;
}

export type DeepLinkAction = DeepLinkNew | DeepLinkOpen;

export type DeepLinkResult =
  | { ok: true; value: DeepLinkAction }
  | { ok: false; error: string };

/** Match `selector` against the registered projects by id first, then by
 *  name (case-insensitive), mirroring the CLI's `find_project`. Returns
 *  undefined for anything not registered — an unknown project is an
 *  ERROR, never a fallback to "the first one" or a silent project add:
 *  a link must not be able to point Termic at a repo the user never
 *  opened, and a wrong-project create is destructive to trust. */
function findProject(projects: Project[], selector: string): Project | undefined {
  const want = selector.trim();
  if (!want) return undefined;
  return (
    projects.find(p => p.id === want)
    ?? projects.find(p => p.name.toLowerCase() === want.toLowerCase())
  );
}

/** `termic://open?task=<id-or-name>[&project=<id-or-name>]`.
 *
 *  Navigation only, so there is no dialog: it selects a task that already
 *  exists or it fails. `project` scopes the lookup; without it a bare name
 *  that matches in two projects is AMBIGUOUS rather than a coin flip,
 *  because silently opening the wrong repo's task is the same class of
 *  mistake `new` refuses to make.
 *
 *  Archived tasks don't match: "open" means resume work, and a link that
 *  silently surfaced something the user archived would be a surprise. */
function parseOpen(u: URL, projects: Project[], tasks: Task[]): DeepLinkResult {
  const q = u.searchParams;
  const selector = q.get("task")?.trim();
  if (!selector) {
    return { ok: false, error: "termic://open needs a task: termic://open?task=<name>" };
  }

  // Optional project scope. Present but unknown is an error, not a silent
  // widening of the search — same gate as `new`.
  const projectSel = q.get("project")?.trim();
  let project: Project | undefined;
  if (projectSel) {
    project = findProject(projects, projectSel);
    if (!project) {
      return {
        ok: false,
        error: `No project named "${projectSel}" is open in Termic. Add it first, then retry the link.`,
      };
    }
  }

  const live = tasks.filter(t => !t.archived && (!project || t.project_id === project.id));
  // Id first (globally unique), then name within the scope.
  const byId = live.find(t => t.id === selector);
  if (byId) return { ok: true, value: { action: "open", taskId: byId.id } };

  const byName = live.filter(t => t.name.toLowerCase() === selector.toLowerCase());
  if (byName.length === 1) {
    return { ok: true, value: { action: "open", taskId: byName[0].id } };
  }
  if (byName.length > 1) {
    const where = byName
      .map(t => projects.find(p => p.id === t.project_id)?.name ?? t.project_id)
      .join(", ");
    return {
      ok: false,
      error: `More than one task is named "${selector}" (${where}). Add project= to say which.`,
    };
  }
  return {
    ok: false,
    error: project
      ? `No open task named "${selector}" in ${project.name}.`
      : `No open task named "${selector}".`,
  };
}

/** Parse one `termic://…` URL against the current store contents.
 *
 *  Accepted shapes: `termic://new?project=<id-or-name>&…` and
 *  `termic://open?task=<id-or-name>&…`. Unknown query params are ignored
 *  (forward compatibility), unknown ACTIONS are not — a typo'd action
 *  should say so rather than quietly falling through to "new". */
export function parseDeepLink(url: string, projects: Project[], tasks: Task[] = []): DeepLinkResult {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: `Not a valid URL: ${url}` };
  }
  if (u.protocol !== "termic:") {
    return { ok: false, error: `Unsupported scheme "${u.protocol}" (expected termic:)` };
  }
  // `termic://new?x=1` parses with host "new" and empty pathname, but
  // `termic:new?x=1` (no slashes) lands in pathname instead. Accept both
  // so a hand-written link works either way.
  const action = (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase();
  if (action === "open") return parseOpen(u, projects, tasks);
  if (action !== "new") {
    return {
      ok: false,
      error: action
        ? `Unknown termic:// action "${action}" (supported: new, open)`
        : `Missing action in ${url} (expected termic://new?… or termic://open?…)`,
    };
  }

  const q = u.searchParams;
  const selector = q.get("project");
  if (!selector?.trim()) {
    return { ok: false, error: "termic://new needs a project: termic://new?project=<name>" };
  }
  const project = findProject(projects, selector);
  if (!project) {
    return {
      ok: false,
      error: `No project named "${selector}" is open in Termic. Add it first, then retry the link.`,
    };
  }

  const name = q.get("name")?.trim() || undefined;
  if (name && name.length > MAX_NAME_CHARS) {
    return { ok: false, error: `Task name is too long (${name.length} chars, max ${MAX_NAME_CHARS}).` };
  }

  // `prompt` and `p` both work — `p` is what the CLI's own flag is called,
  // and the issue's example URL used it.
  const prompt = (q.get("prompt") ?? q.get("p"))?.trim() || undefined;
  if (prompt && prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      error: `Prompt is too long (${prompt.length} chars, max ${MAX_PROMPT_CHARS}). Shorten it or paste it in directly.`,
    };
  }

  // Mode: `worktree=1` (the issue's shape) or `mode=worktree|main`. A
  // non-git project has no branches, so a worktree ask there is a clean
  // error rather than a dialog that cannot be submitted.
  let mode: "worktree" | "repo_root" | undefined;
  const modeParam = q.get("mode")?.trim().toLowerCase();
  const worktreeParam = q.get("worktree")?.trim().toLowerCase();
  if (modeParam) {
    if (modeParam === "worktree") mode = "worktree";
    else if (modeParam === "main" || modeParam === "repo_root") mode = "repo_root";
    else return { ok: false, error: `Unknown mode "${modeParam}" (worktree or main).` };
  } else if (worktreeParam) {
    // Symmetric with `mode` above: a value we don't understand is an ERROR,
    // never a silent default. `worktree=yes` reading as repo_root would hand
    // back the opposite task shape from the one the link asked for, with
    // nothing on screen saying so — and a typo here is invisible in a URL.
    const TRUE = ["1", "true", "yes", "on"];
    const FALSE = ["0", "false", "no", "off"];
    if (TRUE.includes(worktreeParam)) mode = "worktree";
    else if (FALSE.includes(worktreeParam)) mode = "repo_root";
    else {
      return {
        ok: false,
        error: `Unknown worktree value "${worktreeParam}" (1/0, true/false, yes/no).`,
      };
    }
  }
  if (mode === "worktree" && project.non_git) {
    return {
      ok: false,
      error: `Project "${project.name}" is a plain folder (non-git); worktree tasks need git.`,
    };
  }

  return {
    ok: true,
    value: {
      action: "new",
      projectId: project.id,
      name,
      prompt,
      // The agent id is NOT validated here: the dialog only offers
      // installed agents, so an unknown id simply leaves its current pick
      // standing rather than failing the whole link.
      agent: q.get("agent")?.trim() || q.get("cli")?.trim() || undefined,
      mode,
      base: q.get("base")?.trim() || undefined,
    },
  };
}

/** Apply a parsed link. `new` pre-fills the dialog and stops; `open` just
 *  selects the task, because navigation changes nothing to confirm. */
function applyDeepLink(v: DeepLinkAction) {
  if (v.action === "open") {
    // Leaving whatever dialog is up would strand the user behind it on a
    // task they can't see. The window itself is raised on the Rust side.
    useUI.getState().closeNewTask();
    useApp.getState().setActiveTask(v.taskId);
    return;
  }
  useUI.getState().openNewTask(v.projectId, {
    namePrefix: v.name,
    baseBranch: v.base,
    prompt: v.prompt,
    agent: v.agent,
    mode: v.mode,
  });
}

/** Handle one raw URL: parse, then either act on it or toast why not.
 *  Exported for the e2e suite, which drives this directly (a WebDriver
 *  session cannot ask macOS to open a URL scheme). */
export function handleDeepLink(url: string) {
  const s = useApp.getState();
  const res = parseDeepLink(url, s.projects, s.tasks);
  if (!res.ok) {
    // A longer TTL than the default: this is the only feedback the user
    // gets for a link that did nothing, and it usually names a fix
    // ("add the project first").
    useUI.getState().pushToast(res.error, "error", { ttlMs: 10000 });
    return;
  }
  applyDeepLink(res.value);
}

/** Drain whatever Rust has queued. Rust's nudge event carries no payload,
 *  so this drain is the ONLY reader and a link can never be handled twice
 *  (see the queue's comment in lib.rs). */
async function drain() {
  const urls = await invoke<string[]>("deep_link_take_pending").catch(() => [] as string[]);
  for (const url of urls) handleDeepLink(url);
}

/** Wire up deep links. Call once at boot, AFTER projects have loaded (the
 *  parse resolves the project name against the store, so draining early
 *  would reject a perfectly good link as "no such project"). */
export async function initDeepLinks(): Promise<() => void> {
  const unlisten = await listen("termic://deep-link", () => { void drain(); });
  // Boot drain: a link that LAUNCHED the app was queued long before this
  // listener existed, so the nudge for it is already gone.
  await drain();
  return unlisten;
}
