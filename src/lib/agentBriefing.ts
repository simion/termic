// The "Copy agent CLI briefing" block: a paste-ready fragment that links one
// Termic task to another agent, so the two can hand each other work.
//
// It is a FRAGMENT, not a document: the user pastes it INSIDE a larger prompt
// they are writing for agent B, to point B at task A. It is wrapped in a
// <termic-task> tag carrying A's id, name, project, agent and path, so the
// paste stays one clearly attributed block inside whatever surrounds it. So it carries only what
// B cannot derive - A's id, its directory, and the command shape - and leaves
// the protocol to the CLI's own help. `$TERMIC_CLI_HELP` is injected into
// every task PTY (lib.rs) and `termic send --help` carries the long version,
// so a Termic agent has already been told to prompt rather than `--wait`
// before it ever reads this paste. Re-teaching it here is what made an
// earlier draft 35 lines that nobody could read.
//
// The one load-bearing detail is the QUOTING. The reply address is
// `$TERMIC_TASK_ID` inside DOUBLE quotes, so the SENDER's shell expands it to
// the sender's own id at send time and the receiving agent is handed a literal
// address it can just run.
//
// That trick is self-executing for a SHELL, and the reader is not a shell: it
// is an agent that will rewrite the line to slot its own prompt in, and while
// rewriting it flips the outer quotes to single (near-inevitable once its text
// contains an apostrophe) or "resolves" $TERMIC_TASK_ID to something invented.
// Either one fails SILENTLY - the reply goes nowhere and the sender waits for
// a report that cannot arrive - so the last line spends its one sentence
// telling the reader to leave both alone. It is the only thing in the block
// that is not already in the CLI's own help; everything else was cut for
// exactly that reason.

import { copyToClipboard } from "@/lib/clipboard";
import { cliInstallStatus, peerStatus } from "@/lib/ipc";
import { effectiveSandboxMode, isSandboxEnforced } from "@/lib/types";
import type { Task } from "@/lib/types";

/** What the snippet should put after `${TERMIC_CLI:-...}` as the fallback
 *  for an agent running OUTSIDE Termic, where $TERMIC_CLI is unset.
 *
 *  An installed link that is on the login PATH is the nicest thing to read
 *  (`termic`); installed but off-PATH has to be the absolute path or the
 *  paste silently doesn't work; not installed at all still yields the bare
 *  command name, which is right the moment the user enables the CLI. */
export function cliFallbackCommand(
  status: { path: string | null; name: string; on_path: boolean } | null,
): string {
  if (!status) return "termic";
  if (status.path && !status.on_path) return status.path;
  return status.name || "termic";
}

/** Resolve the fallback by asking the backend; never rejects. */
export async function resolveCliFallback(): Promise<string> {
  return cliFallbackCommand(await cliInstallStatus().catch(() => null));
}

/** Build the paste-ready fragment for one task.
 *
 *  `cli` is the command name/path to call (see cliFallbackCommand). Pure and
 *  synchronous so the copy path stays testable without touching IPC. */
export function buildAgentBriefing(opts: {
  task: Task;
  projectName?: string | null;
  cli: string;
}): string {
  const { task, cli } = opts;
  const project = opts.projectName || "unknown project";
  const agent = task.cli || "claude";
  // An ENFORCING cage denies the control-plane socket outright (termic-cli's
  // cage_refused), so this agent cannot run the CLI to reply at all. One line,
  // and only on the tasks it applies to: without it the reader wires up a
  // report-back that can never arrive. Monitor mode reaches the CLI by
  // contract and needs no warning.
  //
  // This line is correct behaviour, NOT a gap to close by handing caged
  // agents a channel: a cage with a text channel to something uncaged is not
  // a cage. docs/sandbox.md ("Settled") has the argument, including why the
  // narrow versions of the idea fail too.
  const caged = isSandboxEnforced(effectiveSandboxMode(task))
    ? `\nIt is sandboxed (enforcing), so it cannot run the CLI to reply: ask it to write a file under its path and read that yourself.`
    : "";
  // The receiving task's identity, as its reply signs it. Literal: the
  // reader knows exactly which task this block is about.
  const them = `agent:${agent} task:${task.name} id:${task.id}`;
  // The sender's, filled in by the SENDER's shell (hence the double quotes).
  // `TERMIC_TAB_ID` expands only when set (omitted outside an agent tab).
  const you = "agent:<you> task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID}";

  // Wrapped in a tag carrying the task's identity, so a paste reads as one
  // self-contained block about ONE task, however much prompt surrounds it,
  // and two pasted briefings can never blur together.
  return `<termic-task id="${attr(task.id)}" name="${attr(task.name)}" project="${attr(project)}" agent="${attr(agent)}" path="${attr(task.path)}">
Another coding agent working alongside you in Termic. Prompt it, and it prompts you back when done:
  ${cli} send ${task.id} -p "[message from ${you}] <your prompt here: what you want it to do>. When done, reply: ${cli} send $TERMIC_TASK_ID \${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }-p '[message from ${them}] done: <what you did> -- ${them}' -- ${you}"
Keep the outer double quotes and the $TERMIC_ variables as written (your shell fills in your own task name and address), and replace <you> with your agent name.${caged}
</termic-task>`;
}

/** Escape a value for a double-quoted XML attribute. Task names are free
 *  text, and an unescaped quote would end the attribute early. */
function attr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Copy the briefing for `task` to the clipboard, resolving the CLI command
 *  first. Shared by the sidebar task menu and the command palette so the two
 *  can't drift. */
export async function copyAgentBriefing(task: Task, projectName?: string | null) {
  const cli = await resolveCliFallback();
  return copyToClipboard(buildAgentBriefing({ task, projectName, cli }), "agent CLI briefing");
}

/** The briefing for a task on a PAIRED computer: the same block, addressed
 *  through this machine's peer link. The agent it is pasted into runs here,
 *  so it reaches the task with `--peer <that machine>`; the task replies
 *  with `--peer <this machine>`. Both by peer id, which a rename on either
 *  side does not change. No path: the task's folder is on the other machine. */
export function buildRemoteAgentBriefing(opts: {
  task: { id: string; name: string; agent: string; project: string };
  machine: { id: string; name: string };
  us: string;
  cli: string;
}): string {
  const { task, machine, us, cli } = opts;
  const agent = task.agent || "claude";
  const them = `agent:${agent} task:${task.name} id:${task.id}`;
  const you = "agent:<you> task:$TERMIC_TASK id:$TERMIC_TASK_ID${TERMIC_TAB_ID:+ tab:$TERMIC_TAB_ID}";
  return `<termic-task id="${attr(task.id)}" name="${attr(task.name)}" project="${attr(task.project)}" agent="${attr(agent)}" computer="${attr(machine.name)}">
Another coding agent, working in Termic on the paired computer ${machine.name}. Prompt it, and it prompts you back when done:
  ${cli} --peer ${machine.id} send ${task.id} -p "[message from ${you}] <your prompt here: what you want it to do>. When done, reply: ${cli} --peer ${us} send $TERMIC_TASK_ID \${TERMIC_TAB_ID:+--tab $TERMIC_TAB_ID }-p '[message from ${them}] done: <what you did> -- ${them}' -- ${you}"
Keep the outer double quotes and the $TERMIC_ variables as written (your shell fills in your own task name and address), and replace <you> with your agent name.
</termic-task>`;
}

/** Copy a paired computer's task briefing, resolving the CLI and this
 *  machine's peer id first. */
export async function copyRemoteAgentBriefing(task: { id: string; name: string; agent: string; project: string }, machine: { id: string; name: string }) {
  const [cli, status] = await Promise.all([resolveCliFallback(), peerStatus()]);
  return copyToClipboard(buildRemoteAgentBriefing({ task, machine, us: status.self_id, cli }), "agent CLI briefing");
}
