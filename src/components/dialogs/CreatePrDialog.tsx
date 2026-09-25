// Create a PR (GitHub) / MR (GitLab) for the active task's branch.
//
// Two paths out of this dialog (the Conductor-inspired split):
//   - Create: termic pushes the branch and shells out to `gh pr create` /
//     `glab mr create` directly. Fast, no agent involved.
//   - Draft with agent: types a prompt into the task's agent tab
//     asking IT to write the title/description and run the create command
//     itself (same flow as ReviewDialog's auto-typed prompt). Best when
//     the user wants a thoughtful description of a large branch.
//
// Title prefills from the last commit subject (the 80% case: one commit
// per worktree branch); base from the task's base branch.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePr } from "@/store/pr";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { ptyWrite, taskGitStatus, taskPrCreate, openPath } from "@/lib/ipc";
import { agentDisplayName } from "@/lib/agents";
import type { TerminalTab } from "@/lib/types";
import { Sparkles } from "lucide-react";

export function CreatePrDialog() {
  const { t } = useTranslation("dialogs");
  const taskId = useUI(s => s.createPrForTaskId);
  const close = useUI(s => s.closeCreatePr);
  const task = useApp(s => taskId ? s.tasks.find(w => w.id === taskId) : null);
  const pushToast = useUI(s => s.pushToast);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const lookup = usePr(s => taskId ? s.byTask[taskId]?.lookup ?? null : null);
  const provider = lookup?.provider ?? task?.pr_provider ?? "github";
  const noun = provider === "gitlab" ? t("createPr.nounMr") : t("createPr.nounPr");
  // The prompt typed into the agent's terminal is an instruction for the CLI,
  // not UI copy, so it stays English regardless of the UI language.
  const promptNoun = provider === "gitlab" ? "merge request" : "pull request";
  const cliName = provider === "gitlab" ? "glab" : "gh";

  // (Re-)seed the form whenever the dialog opens: title from the last
  // commit subject, base from the task (sans remote prefix).
  useEffect(() => {
    if (!taskId || !task) return;
    setErr(null); setBusy(false); setDraft(false); setBody("");
    setBase((task.base_branch || "main").replace(/^origin\//, ""));
    setTitle(task.name);
    taskGitStatus(taskId).then(st => {
      const subject = st.repos[0]?.last_commit_message.split("\n")[0]?.trim();
      if (subject) setTitle(subject);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function create() {
    if (!task || !title.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const fresh = await taskPrCreate(task.id, title, body, base, draft);
      usePr.getState().setLookup(task.id, fresh);
      const url = fresh.pr?.url ?? "";
      pushToast(
        t("createPr.created", {
          kind: provider === "gitlab" ? "MR" : "PR",
          ref: fresh.pr ? `: ${provider === "gitlab" ? "!" : "#"}${fresh.pr.number}` : "",
        }),
        "success",
        url ? { action: { label: t("common:open"), onClick: () => { openPath(url).catch(() => {}); } } } : undefined,
      );
      close();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  /** Hand the job to the task's agent: type a prompt into its live
   *  terminal asking it to draft the description and run the create
   *  command itself. Prefers the active tab when that's an agent;
   *  otherwise the first live agent tab. */
  function draftWithAgent() {
    if (!task) return;
    const tabs = (useApp.getState().tabs[task.id] || []).filter(
      (t): t is TerminalTab => t.type === "terminal" && t.cli !== "shell" && t.cli !== "custom" && !!t.ptyId,
    );
    const activeId = useApp.getState().activeTab[task.id];
    const target = tabs.find(t => t.id === activeId) ?? tabs[0];
    if (!target?.ptyId) {
      setErr(t("createPr.errNoAgent"));
      return;
    }
    const createCmd = provider === "gitlab"
      ? `glab mr create --target-branch ${base} --title <title> --description <description>${draft ? " --draft" : ""}`
      : `gh pr create --base ${base} --title <title> --body <body>${draft ? " --draft" : ""}`;
    const prompt =
      `Create a ${promptNoun} for the current branch. ` +
      `First review everything the branch changes (e.g. \`git diff $(git merge-base ${base} HEAD)\` plus untracked files), ` +
      `commit anything that should ship, and push. ` +
      `Then create it with \`${createCmd}\`, writing a concise title and a reviewer-friendly description: what changed, why, and how to verify. ` +
      `Do not merge anything.`;
    const bytes = new TextEncoder().encode(prompt + "\r");
    ptyWrite(target.ptyId, Array.from(bytes)).catch(() => {});
    pushToast(t("createPr.toastSent", { agent: agentDisplayName(target.cli, useApp.getState().agents), noun }), "success");
    close();
  }

  return (
    <AppDialog
      open={!!taskId}
      onOpenChange={(v) => (v ? null : close())}
      title={provider === "gitlab" ? t("createPr.titleGitlab") : t("createPr.titleGithub")}
      description={t("createPr.description", { noun, cli: cliName })}
    >
      <div className="mt-2 flex flex-col gap-2">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={t("createPr.titlePlaceholder")}
          autoFocus
          spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
          className="h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[13px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
        />
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder={t("createPr.bodyPlaceholder")}
          rows={5}
          spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
          className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[12.5px] leading-snug text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-faint)] focus:border-[var(--color-accent)]"
        />
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            {t("createPr.base")}
            <input
              value={base}
              onChange={e => setBase(e.target.value)}
              spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
              className="h-7 w-36 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 font-mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
            <input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} />
            {t("createPr.draft")}
          </label>
        </div>
        {err && <p className="break-words text-[12.5px] text-[var(--color-err)]">{err}</p>}
        <div className="mt-1 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={draftWithAgent} disabled={busy}
            title={t("createPr.draftWithAgentTitle")}>
            <Sparkles className="h-4 w-4" /> {t("createPr.draftWithAgent")}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={busy}>{t("common:cancel")}</Button>
            <Button variant="primary" size="sm" onClick={create} disabled={busy || !title.trim()}>
              {busy ? t("createPr.creating") : t("common:create")}
            </Button>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
