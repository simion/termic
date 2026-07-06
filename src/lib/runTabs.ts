// Shared Run-tab launching (GH #54). Runs NEVER stream into the footer:
// every run is a real terminal tab (RunPane) with pill controls, for every
// project type. This module is the single launch path, used by the
// UnifiedBar RunControls, the RightPanel run request, and the spotlight
// handoff in lib/spotlight.ts.
//
// Spotlight-enabled projects: while a workspace is SPOTLIGHTED its host Run
// tab executes at the repo root (the root serves the synced changes). That
// cwd decision happens at spawn time in TerminalPane, not here, so the same
// tab runs in the worktree when the workspace isn't spotlighted.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { repoConfigLoad, repoConfigLoadAt } from "@/lib/ipc";
import type { Project, Workspace, TerminalTab } from "@/lib/types";

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

/** Whether this project uses the spotlight run model (spotlighted workspace
 *  runs at the repository root). */
export function runsAtRepoRoot(project: Project | null | undefined): boolean {
  return !!project?.spotlight_enabled
    && project?.type !== "multi"
    && !project?.non_git;
}

/** Expand `$VAR` / `${VAR}` in a preview-URL template for the variables we
 *  set in the run script's env. Includes legacy `$CONDUCTOR_*` aliases so
 *  templates saved under the old name keep working after the rename. */
export function expandPreviewUrl(project: Project | null, ws: Workspace, yamlUrl = ""): string | null {
  const tmpl = project?.preview_url?.trim() || yamlUrl.trim();
  // No preview URL configured → no Open/Copy buttons. We deliberately don't
  // guess `http://localhost:<port>`: many projects have no web server, and a
  // dead Open button is worse than none.
  if (!tmpl) return null;
  const port = String(ws.port);
  return tmpl
    .replaceAll("${TERMIC_PORT}",            port)
    .replaceAll("$TERMIC_PORT",              port)
    .replaceAll("${CONDUCTOR_PORT}",         port)
    .replaceAll("$CONDUCTOR_PORT",           port)
    .replaceAll("${PORT}",                   port)
    .replaceAll("$PORT",                     port)
    .replaceAll("${TERMIC_WORKSPACE_NAME}",  ws.name)
    .replaceAll("$TERMIC_WORKSPACE_NAME",    ws.name)
    .replaceAll("${CONDUCTOR_WORKSPACE_NAME}", ws.name)
    .replaceAll("$CONDUCTOR_WORKSPACE_NAME",   ws.name);
}

/** All run-kind tabs of a workspace ("run", not "setup"). */
export function runTabsOf(wsId: string | undefined): TerminalTab[] {
  return (wsId ? useApp.getState().tabs[wsId] ?? [] : []).filter(
    (t): t is TerminalTab =>
      t.type === "terminal"
      && (t as TerminalTab).runTab != null
      && ((t as TerminalTab).runTab!.kind ?? "run") === "run",
  );
}

/** Resolve configured run targets for a workspace. Only returns targets that
 *  actually have a run script, including `.termic.yaml` fallbacks. */
export async function resolveRunTargets(wsId: string): Promise<RunTarget[]> {
  const st = useApp.getState();
  const ws = st.workspaces.find(w => w.id === wsId);
  if (!ws) return [];
  const project = st.projects.find(p => p.id === ws.project_id) ?? null;
  const yaml = await repoConfigLoad(ws.project_id).catch(() => null);
  const targets: RunTarget[] = [];

  const hostScript = (project?.run_script || yaml?.scripts?.run || "").trim();
  if (hostScript) {
    targets.push({
      member: "",
      label: project?.name || ws.name,
      title: "Run",
      script: hostScript,
      previewUrl: expandPreviewUrl(project, ws, yaml?.scripts?.preview_url ?? ""),
    });
  }

  for (const m of ws.composition ?? []) {
    let script = (m.run_script || "").trim();
    if (!script && m.repo_path) {
      const mYaml = await repoConfigLoadAt(m.repo_path).catch(() => null);
      script = (mYaml?.scripts?.run || "").trim();
    }
    if (script) {
      targets.push({
        member: m.dir_name,
        label: m.dir_name,
        title: `Run · ${m.dir_name}`,
        script,
        previewUrl: null,
      });
    }
  }

  return targets;
}

/** Launch (or restart) the Run tab(s) for a workspace: one per target, host
 *  plus every composition member with a run script. Existing tabs are
 *  restarted in place instead of duplicated. Resolves `.termic.yaml`
 *  fallbacks itself so callers outside RightPanel (spotlight handoff,
 *  UnifiedBar) get identical behavior. Toasts when nothing is configured. */
export async function launchRunTabs(wsId: string, member?: string): Promise<void> {
  const st = useApp.getState();
  const ws = st.workspaces.find(w => w.id === wsId);
  if (!ws) return;

  const targets = (await resolveRunTargets(wsId))
    .filter(t => member === undefined || t.member === member);
  if (targets.length === 0) {
    useUI.getState().pushToast("No run script configured. Set one in Settings, Repositories.", "error");
    return;
  }

  const esc = (p: string) => p.replace(/"/g, '\\"');
  for (const target of targets) {
    const existing = (useApp.getState().tabs[wsId] ?? []).find(
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
      ? `cd "${esc(ws.path)}/${target.member}"\n${target.script}`
      : target.script;
    useApp.getState().addTabToActivePane(wsId, {
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
