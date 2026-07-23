// Custom run commands (GH #124). A curated, per-repo list of extra run
// commands — `python run.py`, `./build.sh`, `npm run build:prod` — surfaced
// in the RunControls dropdown and added quickly by right-clicking a file in
// the tree. Distinct from the single primary `run_script` (the Run button).
//
// Two storage layers, merged at read time:
//   - Personal → `Project.run_scripts` (projects.json, local only)
//   - Shared   → `.termic.yaml` `scripts.run_scripts` (committed, team-shared)
//
// The launcher lives in runTabs.ts (`launchCustomRun`) alongside the other
// run-tab launchers; this module owns resolution + persistence.

import { useApp } from "@/store/app";
import { projectUpdate, repoConfigLoad, repoConfigSave } from "@/lib/ipc";
import type { RepoConfig, RunCommand } from "@/lib/types";

export type CommandSource = "personal" | "yaml";

export interface ResolvedCommand extends RunCommand {
  source: CommandSource;
}

/** The command a right-click "Add to Run scripts" seeds for a file: run it
 *  relative to the repo/worktree root. Editable afterward in settings. */
export function defaultCommandFor(rel: string): string {
  return `./${rel}`;
}

/** An empty `.termic.yaml` shape, used when a repo has none yet. Mirrors the
 *  default RepositorySection builds. */
function emptyRepoConfig(): RepoConfig {
  return {
    version: 1,
    scripts: { setup: "", run: "", archive: "", preview_url: "", files_to_copy: [], run_scripts: [] },
    sandbox: { enabled_by_default: false, allowed_hosts: [], allowed_paths: [] },
    exclude: [],
  };
}

/** Merge a project's personal + committed custom run commands. Personal
 *  first, then the committed `.termic.yaml` list. Never throws — a malformed
 *  `.termic.yaml` just yields the personal list. */
export async function resolveCustomCommands(projectId: string): Promise<ResolvedCommand[]> {
  const project = useApp.getState().projects.find(p => p.id === projectId);
  const personal: ResolvedCommand[] = (project?.run_scripts ?? [])
    .filter(c => c.command.trim())
    .map(c => ({ ...c, source: "personal" as const }));
  const yaml = await repoConfigLoad(projectId).catch(() => null);
  const shared: ResolvedCommand[] = (yaml?.scripts.run_scripts ?? [])
    .filter(c => c.command.trim())
    .map(c => ({ ...c, source: "yaml" as const }));
  return [...personal, ...shared];
}

/** Append a command to the personal (projects.json) list and persist. */
export async function addPersonalCommand(projectId: string, cmd: RunCommand): Promise<void> {
  const project = useApp.getState().projects.find(p => p.id === projectId);
  if (!project) return;
  const list = [...(project.run_scripts ?? []), cmd];
  await projectUpdate({ ...project, run_scripts: list });
  await useApp.getState().loadAll();
}

/** Append a command to the committed `.termic.yaml` list and persist. */
export async function addSharedCommand(projectId: string, cmd: RunCommand): Promise<void> {
  const cfg = (await repoConfigLoad(projectId).catch(() => null)) ?? emptyRepoConfig();
  const list = [...(cfg.scripts.run_scripts ?? []), cmd];
  await repoConfigSave(projectId, { ...cfg, scripts: { ...cfg.scripts, run_scripts: list } });
}

/** Remove every entry whose command matches, from whichever store holds it.
 *  Used by the file-tree "Remove from Run scripts" toggle, which knows the
 *  command string but not the source. */
export async function removeCommandByCommand(projectId: string, command: string): Promise<void> {
  const project = useApp.getState().projects.find(p => p.id === projectId);
  if (project && (project.run_scripts ?? []).some(c => c.command === command)) {
    const list = (project.run_scripts ?? []).filter(c => c.command !== command);
    await projectUpdate({ ...project, run_scripts: list });
    await useApp.getState().loadAll();
  }
  const cfg = await repoConfigLoad(projectId).catch(() => null);
  if (cfg && (cfg.scripts.run_scripts ?? []).some(c => c.command === command)) {
    const list = (cfg.scripts.run_scripts ?? []).filter(c => c.command !== command);
    await repoConfigSave(projectId, { ...cfg, scripts: { ...cfg.scripts, run_scripts: list } });
  }
}
