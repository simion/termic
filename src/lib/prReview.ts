// Reviewing a pull request: what the Review a PR dialog, `termic review`
// and MCP `task_review` share. The task is an ordinary task on the PR's
// branch (a worktree by default, or the main checkout switched onto it);
// what makes it a review is the prompt it wakes up holding.
//
// The prompt is composed like an issue task's (lib/issuePrompt.ts): a
// generated PR half (number, title, link, the commands that show the
// thread and the diff) and an INSTRUCTION half that is a library prompt
// tagged "Code review" (store/prompts.ts). Editing that prompt in Settings
// changes every review after it, and a user's own prompt (one that tells
// the agent to run their review skill, say) is a first-class choice.

import type { ForgePr, ForgeProvider } from "@/lib/types";
import { forgeName, prNoun, prRef } from "@/lib/forge";
import { projectFetchPrBranch, projectForgePrs, projectGitCheckout } from "@/lib/ipc";

/** A pasted "123", "#123", "!123" or a PR / MR link, reduced to its number.
 *  0 for anything else, which callers report rather than guess at. */
export function parsePrRef(raw: string): number {
  const t = raw.trim();
  const fromUrl = t.match(/\/pull\/(\d+)/) ?? t.match(/\/merge_requests\/(\d+)/) ?? t.match(/\/pullrequest\/(\d+)/i);
  // "#123" is the gh spelling, "!123" the glab/ado one Termic itself renders.
  const n = Number(fromUrl ? fromUrl[1] : t.replace(/^[#!]/, ""));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** `owner/repo` (lowercased) out of a PR link or a git remote URL, for
 *  matching a pasted link to the project it belongs to. null when there is
 *  no recognisable path. Works for https and scp-style ssh remotes. */
export function repoSlug(url: string): string | null {
  const t = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  // scp form: git@host:owner/repo
  const scp = t.match(/^[^@/]+@[^:/]+:(.+)$/);
  let path = scp ? scp[1] : null;
  if (!path) {
    // a forge URL only. A local path is not a repo on any forge, and Windows
    // Chromium reads `D:\...` as `file:///D:/...`, which would name the
    // fixture's parent folder as a repo and flag every pasted link as wrong
    if (!/^(https?|ssh|git):\/\//i.test(t)) return null;
    try { path = new URL(t).pathname.replace(/^\/+/, ""); } catch { return null; }
  }
  // A PR link carries more than the repo: cut at the PR segment.
  path = path.split(/\/(?:-\/)?(?:pull|merge_requests|pullrequest)\//i)[0];
  // Azure: org/project/_git/repo
  const ado = path.match(/([^/]+)\/_git\/([^/]+)/);
  const parts = ado ? [ado[1], ado[2]] : path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
}

/** The task a review lives in. Stable per PR, so a second review of the same
 *  PR finds the first one instead of making another. */
export function reviewTaskName(n: number): string {
  return `review-pr-${n}`;
}

/** Commands that show the PR's thread and its full diff, per forge. The
 *  agent runs them itself; the thread is never inlined. */
export function prCommands(provider: ForgeProvider | null | undefined, n: number): { view: string; diff: string } {
  if (provider === "gitlab") return { view: `glab mr view ${n} --comments`, diff: `glab mr diff ${n}` };
  if (provider === "azure") return { view: `az repos pr show --id ${n}`, diff: `git diff $(git merge-base HEAD origin/HEAD)` };
  return { view: `gh pr view ${n} --comments`, diff: `gh pr diff ${n}` };
}

const BODY_MAX = 4000;

/** Control characters other than newline and tab never reach a PTY. */
function san(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** The PR half of a review prompt, then the instruction half. */
export function prReviewPrompt(
  pr: Pick<ForgePr, "provider" | "number" | "title" | "url" | "body" | "head_ref" | "author">,
  instructions: string,
): string {
  const noun = prNoun(pr.provider);
  const cmds = prCommands(pr.provider, pr.number);
  const body = san(pr.body ?? "").trim();
  const shown = body.length > BODY_MAX
    ? `${body.slice(0, BODY_MAX).trimEnd()}\n\n(Description cut here. Read all of it with \`${cmds.view}\`.)`
    : body;
  const lines = [
    `Review ${forgeName(pr.provider)} ${noun} ${prRef(pr.provider, pr.number)}: ${san(pr.title).trim()}`,
    san(pr.url),
  ];
  if (pr.author) lines.push(`Author: ${san(pr.author)}`);
  lines.push(
    `Its branch \`${san(pr.head_ref)}\` is checked out here. Review what this ${noun} changes against the branch it targets, not the working tree's history.`,
    `Full diff: \`${cmds.diff}\`. Discussion and existing review comments: \`${cmds.view}\`.`,
    "",
    shown || `(The ${noun} has no description.)`,
  );
  return `${lines.join("\n")}\n\n---\n\n${instructions.trim()}`;
}

/** Find the PR by number and fetch its head into a local branch. Throws a
 *  readable message when the forge does not know it. */
export async function fetchPrForReview(projectId: string, n: number): Promise<{ pr: ForgePr; branch: string }> {
  const found = await projectForgePrs(projectId, { number: n });
  const pr = found.prs[0];
  if (!pr) throw new Error(found.message || `no pull request ${n}`);
  const branch = await projectFetchPrBranch(projectId, pr.number, pr.head_ref, pr.cross_repository);
  return { pr, branch };
}

/** Move the project's main checkout onto the PR branch. Stash-safe on the
 *  Rust side; the result says whether local work was stashed or conflicted. */
export function checkoutPrInMain(projectId: string, branch: string) {
  return projectGitCheckout(projectId, branch);
}
