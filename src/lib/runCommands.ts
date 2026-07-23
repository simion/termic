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

/** The per-store run configuration edited by the Run configuration dialog:
 *  the primary run script, the setup script, the preview URL, and the extra
 *  run-command list. Personal lives on the Project (projects.json); shared
 *  lives in `.termic.yaml`. */
export interface RunConfig {
  run: string;
  setup: string;
  preview: string;
  commands: RunCommand[];
}

/** Read the personal (projects.json) run config from the store. */
export function loadPersonalRunConfig(projectId: string): RunConfig {
  const p = useApp.getState().projects.find(pr => pr.id === projectId);
  return {
    run: p?.run_script ?? "",
    setup: p?.setup_script ?? "",
    preview: p?.preview_url ?? "",
    commands: p?.run_scripts ?? [],
  };
}

/** Read the committed (`.termic.yaml`) run config. Empty on missing config. */
export async function loadSharedRunConfig(projectId: string): Promise<RunConfig> {
  const yaml = await repoConfigLoad(projectId).catch(() => null);
  const s = yaml?.scripts;
  return {
    run: s?.run ?? "",
    setup: s?.setup ?? "",
    preview: s?.preview_url ?? "",
    commands: s?.run_scripts ?? [],
  };
}

/** Persist the personal run config (projects.json) and refresh the store. */
export async function savePersonalRunConfig(projectId: string, cfg: RunConfig): Promise<void> {
  const project = useApp.getState().projects.find(p => p.id === projectId);
  if (!project) return;
  await projectUpdate({
    ...project,
    run_script: cfg.run,
    setup_script: cfg.setup,
    preview_url: cfg.preview,
    run_scripts: cfg.commands,
  });
  await useApp.getState().loadAll();
}

/** Persist the committed run config (`.termic.yaml`), preserving the other
 *  `scripts` fields (archive, files_to_copy) and the rest of the config. */
export async function saveSharedRunConfig(projectId: string, cfg: RunConfig): Promise<void> {
  const base = (await repoConfigLoad(projectId).catch(() => null)) ?? emptyRepoConfig();
  await repoConfigSave(projectId, {
    ...base,
    scripts: { ...base.scripts, run: cfg.run, setup: cfg.setup, preview_url: cfg.preview, run_scripts: cfg.commands },
  });
}

/** The personal (projects.json) run-command list, read from the store. */
export function loadPersonalCommands(projectId: string): RunCommand[] {
  return useApp.getState().projects.find(p => p.id === projectId)?.run_scripts ?? [];
}

/** The committed (`.termic.yaml`) run-command list. Empty on missing /
 *  malformed config. */
export async function loadSharedCommands(projectId: string): Promise<RunCommand[]> {
  const yaml = await repoConfigLoad(projectId).catch(() => null);
  return yaml?.scripts.run_scripts ?? [];
}

/** Persist the whole personal list (projects.json) and refresh the store. */
export async function savePersonalCommands(projectId: string, list: RunCommand[]): Promise<void> {
  const project = useApp.getState().projects.find(p => p.id === projectId);
  if (!project) return;
  await projectUpdate({ ...project, run_scripts: list });
  await useApp.getState().loadAll();
}

/** Persist the whole committed list (`.termic.yaml`). */
export async function saveSharedCommands(projectId: string, list: RunCommand[]): Promise<void> {
  const cfg = (await repoConfigLoad(projectId).catch(() => null)) ?? emptyRepoConfig();
  await repoConfigSave(projectId, { ...cfg, scripts: { ...cfg.scripts, run_scripts: list } });
}

/** Merge a project's personal + committed custom run commands. Personal
 *  first, then the committed `.termic.yaml` list. Never throws — a malformed
 *  `.termic.yaml` just yields the personal list. */
export async function resolveCustomCommands(projectId: string): Promise<ResolvedCommand[]> {
  const personal: ResolvedCommand[] = loadPersonalCommands(projectId)
    .filter(c => c.command.trim())
    .map(c => ({ ...c, source: "personal" as const }));
  const shared: ResolvedCommand[] = (await loadSharedCommands(projectId))
    .filter(c => c.command.trim())
    .map(c => ({ ...c, source: "yaml" as const }));
  return [...personal, ...shared];
}

/** Append a command to the personal (projects.json) list and persist. */
export async function addPersonalCommand(projectId: string, cmd: RunCommand): Promise<void> {
  await savePersonalCommands(projectId, [...loadPersonalCommands(projectId), cmd]);
}

/** Append a command to the committed `.termic.yaml` list and persist. */
export async function addSharedCommand(projectId: string, cmd: RunCommand): Promise<void> {
  await saveSharedCommands(projectId, [...(await loadSharedCommands(projectId)), cmd]);
}

/** Remove every entry whose command matches, from whichever store holds it.
 *  Used by the file-tree "Remove from Run scripts" toggle, which knows the
 *  command string but not the source. */
export async function removeCommandByCommand(projectId: string, command: string): Promise<void> {
  const personal = loadPersonalCommands(projectId);
  if (personal.some(c => c.command === command)) {
    await savePersonalCommands(projectId, personal.filter(c => c.command !== command));
  }
  const shared = await loadSharedCommands(projectId);
  if (shared.some(c => c.command === command)) {
    await saveSharedCommands(projectId, shared.filter(c => c.command !== command));
  }
}
