// New task on another machine (docs/remote.md): the machine's own projects
// and agents, fetched live from it, a prompt, and Start. The task, its
// worktree and its agent are created THERE; this computer only asks.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderPlus } from "lucide-react";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { cn } from "@/lib/utils";
import { nameFromPrompt, remoteCall, req, useMachine, useRemote } from "@/lib/remote";
import { agentName } from "./RemoteTaskView";

interface Project { id: string; name: string; root_path: string; tasks: number; default_agent: string }
interface Agent { id: string; kind: string; enabled: boolean; installed?: boolean | null; usable: boolean }


export function NewRemoteTaskDialog() {
  const machineId = useRemote(s => s.newTaskOn);
  const setDialog = useRemote(s => s.setDialog);
  return machineId ? <Body machineId={machineId} onClose={() => setDialog({ newTaskOn: null })} /> : null;
}

function Body({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const { t } = useTranslation("remote");
  const machine = useMachine(machineId);
  const openTask = useRemote(s => s.openTask);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Adding a project is its own wait: Start must not read "Starting..." then.
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingPath, setAddingPath] = useState<string | null>(null);
  const machineName = machine?.name ?? "";

  async function load() {
    try {
      const [p, a] = await Promise.all([remoteCall(machineId, req("project_list")), remoteCall(machineId, req("agents"))]);
      const list: Project[] = p.ok ? p.data?.projects ?? [] : [];
      setProjects(list);
      setProject(cur => cur || list[0]?.name || "");
      const usable: Agent[] = a.ok ? (a.data?.agents ?? []).filter((x: Agent) => x.kind === "agent" && x.enabled) : [];
      setAgents(usable);
      const def = list[0]?.default_agent;
      setAgent(cur => cur || (usable.find(x => x.id === def && x.usable)?.id ?? usable.find(x => x.usable)?.id ?? ""));
      if (!p.ok) setError(p.error?.message ?? null);
    } catch (e) {
      setProjects([]);
      setError(String(e));
    }
  }
  useEffect(() => { void load(); }, [machineId]); // eslint-disable-line react-hooks/exhaustive-deps

  const derived = useMemo(() => nameFromPrompt(prompt), [prompt]);

  async function addProject() {
    const path = (addingPath ?? "").trim();
    if (!path) return;
    setAdding(true);
    setError(null);
    try {
      const r = await remoteCall(machineId, req("project_add", { path }));
      if (!r.ok) throw new Error(r.error?.message ?? "could not add the project");
      setAddingPath(null);
      await load();
      const added = r.data?.project?.name ?? r.data?.name;
      if (added) setProject(added);
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function start() {
    if (!project || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await remoteCall(
        machineId,
        req("new", { name: (name.trim() || derived), project, agent: agent || undefined, prompt: prompt.trim(), open: true }),
        330_000,
      );
      if (!r.ok) throw new Error(r.error?.message ?? "could not start the task");
      onClose();
      const id = r.data?.task?.id;
      if (id) openTask({ machine: machineId, task: id });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppDialog open onOpenChange={v => { if (!v) onClose(); }} title={t("newTask.title", { name: machineName })} className="max-w-[560px]">
      <div className="flex flex-col gap-4">
        {projects === null ? (
          <p className="text-[13px] text-[var(--color-fg-faint)]">...</p>
        ) : projects.length === 0 && addingPath === null ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-[var(--color-fg-dim)]">{t("newTask.noProjects", { name: machineName })}</p>
            <div><Button size="sm" variant="primary" data-testid="remote-add-project" onClick={() => setAddingPath("")}><FolderPlus className="h-3.5 w-3.5" />{t("newTask.addProject")}</Button></div>
          </div>
        ) : (
          <label className="flex flex-col gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("newTask.project")}
            <div className="flex gap-2">
              <select
                data-testid="remote-new-project"
                value={project}
                onChange={e => setProject(e.target.value)}
                className="h-9 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
              >
                {projects.map(p => <option key={p.id} value={p.name}>{p.name}  ({p.root_path})</option>)}
              </select>
              <Button size="md" variant="secondary" aria-label={t("newTask.addProject")} onClick={() => setAddingPath("")}><FolderPlus className="h-3.5 w-3.5" /></Button>
            </div>
          </label>
        )}

        {addingPath !== null && (
          <label className="flex flex-col gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("newTask.projectPath", { name: machineName })}
            <div className="flex gap-2">
              <Input
                data-testid="remote-project-path"
                autoFocus
                value={addingPath}
                placeholder={t("newTask.projectPathPlaceholder")}
                onChange={e => setAddingPath(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void addProject(); }}
                className="flex-1 font-mono"
              />
              <Button size="md" variant="primary" data-testid="remote-project-add" disabled={adding || !addingPath.trim()} onClick={() => void addProject()}>{t("newTask.add")}</Button>
            </div>
          </label>
        )}

        {agents.length > 0 && (
          <div className="flex flex-col gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("newTask.agent")}
            <div className="flex flex-wrap gap-1.5">
              {agents.map(a => {
                const icon = resolveIconId(a.id, []);
                return (
                  <button
                    key={a.id}
                    type="button"
                    data-testid={`remote-agent-${a.id}`}
                    disabled={!a.usable}
                    onClick={() => setAgent(a.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12.5px]",
                      agent === a.id ? "border-[var(--color-accent)] bg-[var(--color-accent-deep)]/15 text-[var(--color-fg)]" : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)]",
                      !a.usable && "opacity-40",
                    )}
                  >
                    <span className={CLI_BRAND_COLOR[icon]}><CliIcon cli={icon} className="h-3.5 w-3.5" /></span>
                    {agentName(a.id)}
                    {!a.usable && <span className="text-[11px]">({t("newTask.notInstalled")})</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <label className="flex flex-col gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("newTask.prompt")}
          <textarea
            data-testid="remote-new-prompt"
            value={prompt}
            rows={4}
            autoFocus={!!projects?.length}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t("newTask.promptPlaceholder")}
            onChange={e => setPrompt(e.target.value)}
            className="resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("newTask.name")}
          <Input data-testid="remote-new-name" value={name} placeholder={prompt ? derived : t("newTask.namePlaceholder")} onChange={e => setName(e.target.value)} className="font-mono" />
        </label>

        {error && <p data-testid="remote-new-error" className="text-[12.5px] text-[var(--color-err)]">{error}</p>}

        <div className="flex justify-end">
          <Button variant="primary" data-testid="remote-new-start" disabled={busy || adding || !project || !prompt.trim()} onClick={() => void start()}>
            {busy ? t("newTask.starting") : t("newTask.start")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
