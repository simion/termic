// Shared Run-tab launching (GH #54). Runs NEVER stream into the footer:
// every run is a real terminal tab (RunPane) with pill controls, for every
// project type. This module is the single launch path, used by the
// UnifiedBar RunControls, the RightPanel run request, and the spotlight
// handoff in lib/spotlight.ts.
//
// Spotlight-enabled projects: while a task is SPOTLIGHTED its host Run
// tab executes at the repo root (the root serves the synced changes). That
// cwd decision happens at spawn time in TerminalPane, not here, so the same
// tab runs in the worktree when the task isn't spotlighted.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { repoConfigLoad, repoConfigLoadAt } from "@/lib/ipc";
import { runCommandLabel } from "@/lib/runCommands";
import type { Project, RunCommand, Task, TerminalTab } from "@/lib/types";

export interface RunTarget {
  /** "" = host project; otherwise composition dir_name. */
  member: string;
  /** Human label for menus. */
  label: string;
  /** Tab title. */
  title: string;
  script: string;
  previewUrl: string | null;
}

/** Whether this project uses the spotlight run model (spotlighted task
 *  runs at the repository root). */
export function runsAtRepoRoot(project: Project | null | undefined): boolean {
  return !!project?.spotlight_enabled
    && project?.type !== "multi"
    && !project?.non_git;
}

/** Expand `$VAR` / `${VAR}` in a preview-URL template for the variables we
 *  set in the run script's env. Includes legacy `$CONDUCTOR_*` aliases so
 *  templates saved under the old name keep working after the rename. */
export function expandPreviewUrl(project: Project | null, task: Task, yamlUrl = ""): string | null {
  const tmpl = project?.preview_url?.trim() || yamlUrl.trim();
  // No preview URL configured → no Open/Copy buttons. We deliberately don't
  // guess `http://localhost:<port>`: many projects have no web server, and a
  // dead Open button is worse than none.
  if (!tmpl) return null;
  const port = String(task.port);
  // Built-ins + extra named ports (GH #196) as one token list, replaced
  // longest name FIRST so no token can eat the front of a longer one
  // ($TERMIC_PORT vs $TERMIC_WORKSPACE_NAME_2, $API_PORT vs
  // $API_PORT_EXT). Reserved-name validation keeps extras from ever
  // EQUALING a built-in, but prefix overlaps are legal and must be
  // resolved by ordering.
  const tokens: Array<{ name: string; value: string }> = [
    { name: "TERMIC_PORT",              value: port },
    { name: "CONDUCTOR_PORT",           value: port },
    { name: "PORT",                     value: port },
    { name: "TERMIC_WORKSPACE_NAME",    value: task.name },
    { name: "CONDUCTOR_WORKSPACE_NAME", value: task.name },
    ...(task.extra_named_ports ?? []).map(np => ({ name: np.name, value: String(np.port) })),
  ].sort((a, b) => b.name.length - a.name.length);
  let out = tmpl;
  for (const t of tokens) {
    out = out
      .replaceAll("${" + t.name + "}", t.value)
      .replaceAll("$" + t.name,        t.value);
  }
  return out;
}

/** All run-kind tabs of a task ("run", not "setup"). */
export function runTabsOf(taskId: string | undefined): TerminalTab[] {
  return (taskId ? useApp.getState().tabs[taskId] ?? [] : []).filter(
    (t): t is TerminalTab =>
      t.type === "terminal"
      && (t as TerminalTab).runTab != null
      && ((t as TerminalTab).runTab!.kind ?? "run") === "run",
  );
}

/** Resolve configured run targets for a task. Only returns targets that
 *  actually have a run script, including `.termic.yaml` fallbacks. */
export async function resolveRunTargets(taskId: string): Promise<RunTarget[]> {
  const st = useApp.getState();
  const task = st.tasks.find(w => w.id === taskId);
  if (!task) return [];
  const project = st.projects.find(p => p.id === task.project_id) ?? null;
  const yaml = await repoConfigLoad(task.project_id).catch(() => null);
  const targets: RunTarget[] = [];

  const hostScript = (project?.run_script || yaml?.scripts?.run || "").trim();
  if (hostScript) {
    targets.push({
      member: "",
      label: project?.name || task.name,
      title: i18n.t("backend:runTabs.run"),
      script: hostScript,
      previewUrl: expandPreviewUrl(project, task, yaml?.scripts?.preview_url ?? ""),
    });
  }

  for (const m of task.composition ?? []) {
    let script = (m.run_script || "").trim();
    if (!script && m.repo_path) {
      const mYaml = await repoConfigLoadAt(m.repo_path).catch(() => null);
      script = (mYaml?.scripts?.run || "").trim();
    }
    if (script) {
      targets.push({
        member: m.dir_name,
        label: m.dir_name,
        title: i18n.t("backend:runTabs.runMember", { member: m.dir_name }),
        script,
        previewUrl: null,
      });
    }
  }

  return targets;
}

/** Resolve the effective setup script for a task's HOST project only
 *  (project override, else `.termic.yaml`). Mirrors the host-script half of
 *  `resolveRunTargets`. Multi-repo per-member setup still runs the old way
 *  (sequential, backend-orchestrated, inside `task_create_multi`) — this is
 *  scoped to the single-repo "New worktree" flow. */
async function resolveSetupScript(taskId: string): Promise<string> {
  const st = useApp.getState();
  const task = st.tasks.find(w => w.id === taskId);
  if (!task) return "";
  const project = st.projects.find(p => p.id === task.project_id) ?? null;
  const yaml = await repoConfigLoad(task.project_id).catch(() => null);
  return (project?.setup_script || yaml?.scripts?.setup || "").trim();
}

/** Launch the one-shot setup-script tab for a task (GH #54 kind:"setup").
 *  Reuses the same PTY-terminal-tab mechanism as `launchRunTabs` — the
 *  script runs as a normal "custom" command tab with `runTab.kind ===
 *  "setup"`, which TabPill/TerminalPane render with pill controls + the
 *  exit-code failed indicator instead of resume logic. No-ops (returns
 *  false) if the task has no setup script configured. If a setup tab
 *  already exists, restarts it in place rather than adding a duplicate.
 *
 *  `opts.focus` (default true): pass false to fire setup in the background
 *  without switching the active tab — used right after creating a task, so
 *  the newly-opened task lands on the main agent instead of the setup log. */
export async function launchSetupTab(taskId: string, opts?: { focus?: boolean }): Promise<boolean> {
  const script = await resolveSetupScript(taskId);
  if (!script) return false;

  const existing = (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.type === "terminal" && (t as TerminalTab).runTab?.kind === "setup",
  );
  if (existing) {
    window.dispatchEvent(new CustomEvent("termic-run-tab-restart", { detail: { tabId: existing.id } }));
    return true;
  }

  useApp.getState().addTabToActivePane(taskId, {
    id: crypto.randomUUID(),
    type: "terminal",
    title: i18n.t("backend:runTabs.setup"),
    cli: "custom",
    command: script,
    runTab: { member: "", kind: "setup", previewUrl: null },
  }, opts);
  return true;
}

/** The `runTab.member` value for an ad-hoc custom run command (GH #124).
 *  Prefixed so RunControls can tell these apart from the primary host/member
 *  run tabs — the primary Run/Stop button ignores custom members entirely.
 *  Labeled commands key off the label (`label:*`), unlabeled ones off the
 *  command (`cmd:*`); the two prefixes keep a label from colliding with
 *  another command's raw text. Takes the whole command, not a bare string,
 *  so no caller can pick the wrong field. */
export function customRunMember(cmd: RunCommand): string {
  const label = cmd.label.trim();
  return label ? `label:${label}` : `cmd:${cmd.command.trim()}`;
}

/** Whether a `runTab.member` belongs to a custom run command rather than the
 *  primary host/composition run. Both custom prefixes live here so a new one
 *  can never be missed at a call site. */
export function isCustomRunMember(member: string | undefined | null): boolean {
  return !!member && (member.startsWith("cmd:") || member.startsWith("label:"));
}

/** Launch (or restart) a run tab for a user-configured custom command
 *  (GH #124). Behaves exactly like a Run tab (RunPane, pill controls,
 *  persistence) but is keyed by `customRunMember` so it never collides with
 *  another custom command, the primary host run (`member: ""`), or a
 *  composition member. `customTitle` is set so the label survives a
 *  persistence round-trip (restore otherwise rebuilds run-tab titles from
 *  `member`). Runs in the task's worktree — the PTY's spawn cwd; no
 *  spotlight repo-root redirect (that's host-only). */
export function launchCustomRun(taskId: string, cmd: RunCommand): void {
  const member = customRunMember(cmd);
  const existing = (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.type === "terminal" && (t as TerminalTab).runTab?.member === member,
  );
  if (existing) {
    window.dispatchEvent(new CustomEvent("termic-run-tab-restart", { detail: { tabId: existing.id } }));
    return;
  }
  useApp.getState().addTabToActivePane(taskId, {
    id: crypto.randomUUID(),
    type: "terminal",
    title: runCommandLabel(cmd),
    customTitle: true,
    cli: "custom",
    command: cmd.command,
    runTab: { member, previewUrl: null },
  });
}

/** Launch (or restart) the Run tab(s) for a task: one per target, host
 *  plus every composition member with a run script. Existing tabs are
 *  restarted in place instead of duplicated. Resolves `.termic.yaml`
 *  fallbacks itself so callers outside RightPanel (spotlight handoff,
 *  UnifiedBar) get identical behavior. Toasts when nothing is configured. */
export async function launchRunTabs(taskId: string, member?: string): Promise<void> {
  const st = useApp.getState();
  const task = st.tasks.find(w => w.id === taskId);
  if (!task) return;

  const targets = (await resolveRunTargets(taskId))
    .filter(t => member === undefined || t.member === member);
  if (targets.length === 0) {
    useUI.getState().pushToast("No run script configured. Set one in Settings, Repositories.", "error");
    return;
  }

  const esc = (p: string) => p.replace(/"/g, '\\"');
  for (const target of targets) {
    const existing = (useApp.getState().tabs[taskId] ?? []).find(
      (t): t is TerminalTab => t.type === "terminal"
        && (t as TerminalTab).runTab?.member === target.member
        && ((t as TerminalTab).runTab?.kind ?? "run") === "run",
    );
    if (existing) {
      window.dispatchEvent(new CustomEvent("termic-run-tab-restart", { detail: { tabId: existing.id } }));
      continue;
    }
    // Members cd into their dir; hosts run in the worktree (the PTY's spawn
    // cwd). Spotlighted hosts get their repo-root cd at SPAWN time in
    // TerminalPane, so nothing spotlight-specific is baked in here.
    const command = target.member
      ? `cd "${esc(task.path)}/${target.member}"\n${target.script}`
      : target.script;
    useApp.getState().addTabToActivePane(taskId, {
      id: crypto.randomUUID(),
      type: "terminal",
      title: target.title,
      cli: "custom",
      command,
      runTab: {
        member: target.member,
        previewUrl: target.previewUrl,
      },
    });
  }
}
