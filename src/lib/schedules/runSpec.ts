// What a scheduled run IS (GH #300): the settings it inherits, its name, its
// report file and the prompt that names it. Pure.

import {
  effectiveSandboxMode,
  type Project,
  type SandboxMode,
  type Task,
  type TaskSchedule,
} from "@/lib/types";

/** Everything a run is created with, passed explicitly to `taskOpenRepo`. */
export interface RunSpec {
  cli: string;
  agentArgs: string[];
  yolo: boolean;
  sandbox: { enabled: boolean; mode?: SandboxMode; rwPaths: string[]; allowedHosts: string[]; blockKeychain?: boolean };
  /** Agent id -> account name, applied with `taskSetAccount` before mount. */
  accounts: Record<string, string>;
  /** Multi-repo projects: which members to link. Undefined elsewhere. */
  memberPaths?: string[];
}

/**
 * THE inheritance rule, and the only place it lives: a run copies its
 * parent's agent, `agent_args`, YOLO, sandbox and account override.
 *
 * It is explicit on purpose. No create path falls back to a task's YOLO or
 * sandbox by itself (`task_open_repo` takes no default for either, and the
 * CLI, which passes nothing, must get nothing), and a task created through
 * the CLI or MCP does not inherit them from the task that spawned it. So a
 * run inherits only because this function says so.
 *
 * UNDER REVIEW. The design (GH #300) decided on inheriting, and the
 * maintainer reserved a say on YOLO and the sandbox (docs/data-model.md,
 * "Recurring schedules"). The alternative on the
 * table is "YOLO off and the project's sandbox unless the schedule opts in",
 * which should stay a change to this function plus one schedule field.
 * Keep every other caller reading the spec, never the parent.
 */
export function runSpecFromParent(parent: Task, project?: Pick<Project, "type"> | null): RunSpec {
  // The EFFECTIVE mode, so a Seatbelt mode stored on a machine without
  // Seatbelt (a Mac teammate's config on Linux) reads as off, exactly as it
  // would for the parent's own spawn.
  const mode = effectiveSandboxMode(parent);
  return {
    cli: parent.cli,
    agentArgs: [...(parent.agent_args ?? [])],
    yolo: !!parent.yolo,
    sandbox: mode === "off"
      ? { enabled: false, rwPaths: [], allowedHosts: [] }
      : {
          enabled: true,
          mode,
          rwPaths: [...(parent.sandbox_rw_paths ?? [])],
          allowedHosts: [...(parent.sandbox_allowed_hosts ?? [])],
          blockKeychain: !!parent.sandbox_block_keychain,
        },
    accounts: { ...(parent.accounts ?? {}) },
    memberPaths: project?.type === "multi"
      ? (parent.composition ?? []).map(m => m.repo_path ?? "").filter(p => p !== "")
      : undefined,
  };
}

/** Why `parent` cannot have a run right now, or null.
 *  - `docker`: runs never fall back from the container the user chose to the
 *    host, and Docker runs are not built yet.
 *  - `agent`: the agent has no work-done detection, so a run could never say
 *    it finished and would block every later slot (`termic wait` refuses the
 *    same agents for the same reason). `capable` is `workDoneCapable(cli)`. */
export function runRefusal(parent: Pick<Task, "docker_sandbox_enabled">, capable: boolean): "docker" | "agent" | null {
  if (parent.docker_sandbox_enabled) return "docker";
  if (!capable) return "agent";
  return null;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** A slot as local `YYYY-MM-DD` and `HH:MM`. */
export function localStamp(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
    time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
  };
}

/** A run's task name, `grafana-check 2026-09-28 09:00`. Task names are unique
 *  among a project's live tasks, so a fixed name would fail on day two. */
export function runName(scheduleName: string, slot: number): string {
  const { date, time } = localStamp(slot);
  return `${scheduleName.trim()} ${date} ${time}`;
}

/** `base`, or `base (2)`, `base (3)`... past a name already taken
 *  (case-insensitive, the uniqueness rule `createTask` applies). Two Run nows
 *  in one minute would otherwise collide. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map(n => n.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!set.has(n.toLowerCase())) return n;
  }
}

/** The report file stem for a slot, `YYYY-MM-DD_HHMM`, moved a minute later
 *  while one is already used by this schedule. The stem is a FILE NAME the
 *  cleanup matches and dates by, so it can never carry a suffix. */
export function reportStem(slot: number, used: ReadonlySet<string>): string {
  for (let t = slot; ; t += 60_000) {
    const { date, time } = localStamp(t);
    const stem = `${date}_${time.replace(":", "")}`;
    if (!used.has(stem)) return stem;
  }
}

/** The stem of a report path, or null. */
export function stemOfReport(path: string | undefined): string | null {
  if (!path) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const m = /^(\d{4}-\d{2}-\d{2}_\d{4})\.(md|html)$/.exec(name);
  return m ? m[1] : null;
}

/** The schedule's report folder, relative to the project. */
export const reportFolder = (slug: string) => `.termic/schedules/${slug}`;

/** A report's path relative to the project. */
export const reportPath = (slug: string, stem: string, ext: "md" | "html" = "md") =>
  `${reportFolder(slug)}/${stem}.${ext}`;

/** A folder name for a new schedule: lowercase ASCII letters, digits and
 *  inner hyphens (Rust's `slug_ok`), unique among `taken`. */
export function scheduleSlug(name: string, taken: Iterable<string>): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "") || "schedule";
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const s = `${base}-${i}`;
    if (!set.has(s)) return s;
  }
}

/** The library entry's body, one blank line, then the typed text: the same
 *  composition as the CLI's `-P` + `-p` (`compose_prompt` in cli_server.rs). */
export function composePrompt(body: string | undefined, text: string | undefined): string {
  const b = (body ?? "").trimEnd();
  const t = (text ?? "").trim() ? (text ?? "").trimStart() : "";
  if (b && t) return `${b}\n\n${t}`;
  return b || t;
}

/**
 * The instruction appended to every run's prompt. In the prompt, not an env
 * var: an env var is only read by an agent that goes looking for it. It names
 * the exact file, so the outcome can be checked: a run that settles done
 * without writing it is `no_report`.
 *
 * English on purpose, like the built-in prompts: it is addressed to the
 * agent, not shown in Termic's UI.
 */
export function reportInstruction(s: Pick<TaskSchedule, "name" | "slug">, stem: string): string {
  const md = reportPath(s.slug, stem, "md");
  const html = reportPath(s.slug, stem, "html");
  return [
    `[Termic scheduled run: ${s.name.trim()}]`,
    `When you are done, write a report of this run to \`${md}\` (relative to the current directory; create the folder if it is missing).`,
    `Write it in Markdown. Only if it needs charts or a layout Markdown cannot hold, write \`${html}\` instead.`,
    `Reports from earlier runs are in \`${reportFolder(s.slug)}/\`, named by date and time, if you want to compare with them. Write nothing else in that folder.`,
  ].join("\n");
}

/** The whole prompt a run receives. */
export function runPrompt(composed: string, s: Pick<TaskSchedule, "name" | "slug">, stem: string): string {
  return `${composed.trimEnd()}\n\n${reportInstruction(s, stem)}`;
}
