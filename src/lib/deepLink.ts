// `termic://` URL scheme (GH #192): let an external system (a ticket
// tracker, an internal dashboard, a shell alias) open Termic on a New Task
// dialog that is already filled in.
//
//   termic://new?project=web&name=fix-login&prompt=Fix%20the%20login%20bug
//
// THE LINK NEVER CREATES ANYTHING. It only pre-fills the dialog; a human
// still has to press Create. That is the entire security model, and it is
// deliberate: a URL is an untrusted, cross-application channel — any web
// page can navigate to one — so `prompt` would otherwise be a way to feed
// an agent instructions the user never read. Confirming in the UI means the
// prompt is on screen, editable, and cancellable before an agent ever sees
// it. Nothing here may grow an "auto-create" or "skip confirmation" option.
//
// Rust hands the raw URL across untouched (see `queue_deep_link`); all
// parsing and validation is here, because the one check that matters —
// does this name a project the user actually registered? — needs the store.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import type { Project } from "@/lib/types";

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
  projectId: string;
  name?: string;
  prompt?: string;
  agent?: string;
  mode?: "worktree" | "repo_root";
  base?: string;
}

export type DeepLinkResult =
  | { ok: true; value: DeepLinkNew }
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

/** Parse one `termic://…` URL against the registered projects.
 *
 *  Accepted shape: `termic://new?project=<id-or-name>&…`. Unknown query
 *  params are ignored (forward compatibility), unknown ACTIONS are not —
 *  a typo'd action should say so rather than quietly open "new". */
export function parseDeepLink(url: string, projects: Project[]): DeepLinkResult {
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
  if (action !== "new") {
    return {
      ok: false,
      error: action
        ? `Unknown termic:// action "${action}" (only "new" is supported)`
        : `Missing action in ${url} (expected termic://new?…)`,
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
    mode = worktreeParam === "1" || worktreeParam === "true" ? "worktree" : "repo_root";
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

/** Apply a parsed link: open the New Task dialog, pre-filled. */
function openFromLink(v: DeepLinkNew) {
  useUI.getState().openNewTask(v.projectId, {
    namePrefix: v.name,
    baseBranch: v.base,
    prompt: v.prompt,
    agent: v.agent,
    mode: v.mode,
  });
}

/** Handle one raw URL: parse, then either open the dialog or toast why not.
 *  Exported for the e2e suite, which drives this directly (a WebDriver
 *  session cannot ask macOS to open a URL scheme). */
export function handleDeepLink(url: string) {
  const res = parseDeepLink(url, useApp.getState().projects);
  if (!res.ok) {
    // A longer TTL than the default: this is the only feedback the user
    // gets for a link that did nothing, and it usually names a fix
    // ("add the project first").
    useUI.getState().pushToast(res.error, "error", { ttlMs: 10000 });
    return;
  }
  openFromLink(res.value);
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
