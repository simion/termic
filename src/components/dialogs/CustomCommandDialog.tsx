// "Run a command" dialog. Creates a task whose default tab launches a
// user-supplied command in a login shell instead of an agent CLI (ssh, a dev
// server, a REPL, anything). Both a name and a command are required. The
// sidebar `+` menu opens it in either worktree or main-checkout mode; in
// worktree mode it also shows the auto-derived (editable) branch.

import { useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { createQuickTask, derivedBranch } from "@/lib/quickTask";
import { GitBranch, SquareChevronRight } from "lucide-react";

export function CustomCommandDialog() {
  const { t } = useTranslation("dialogs");
  const projectId = useUI(s => s.customCommandProjectId);
  const mode = useUI(s => s.customCommandMode);
  const close = useUI(s => s.closeCustomCommand);
  const branchPrefix = usePrefs(s => s.branchPrefix);

  const open = projectId !== null;
  const isWorktree = mode === "worktree";
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cmdRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(""); setCommand(""); setBranch(""); setBranchEdited(false);
    setErr(null); setBusy(false);
  }, [open]);

  // Keep the branch in lock-step with the name until the user takes it over.
  function onNameChange(v: string) {
    setName(v);
    if (isWorktree && !branchEdited) setBranch(derivedBranch(v, branchPrefix));
  }

  async function submit() {
    const n = name.trim();
    const c = command.trim();
    if (!projectId || !n || !c || busy) return;
    setBusy(true); setErr(null);
    try {
      await createQuickTask({
        projectId,
        mode,
        cli: "custom",
        name: n,
        command: c,
        branch: isWorktree ? branch.trim() : undefined,
      });
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title={isWorktree ? t("customCommand.titleWorktree") : t("customCommand.titleTask")}
      className="max-w-md"
    >
      <p className="mb-4 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
        {isWorktree
          ? t("customCommand.bodyWorktree")
          : t("customCommand.bodyTask")}
      </p>

      <label className="block text-[13.5px]">
        {t("customCommand.nameLabel")}
        <Input
          value={name}
          onChange={e => onNameChange(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); cmdRef.current?.focus(); } }}
          placeholder={t("customCommand.namePlaceholder")}
          className="mt-1.5"
          autoFocus
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
          {t("customCommand.nameHint")}
        </span>
      </label>

      {isWorktree && (
        <label className="mt-4 block text-[13.5px]">
          {t("customCommand.branchLabel")}
          <div className="mt-1.5 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 focus-within:border-[var(--color-accent)]">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)]" />
            <input
              value={branch}
              onChange={e => { setBranch(e.target.value); setBranchEdited(true); }}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); cmdRef.current?.focus(); } }}
              placeholder={t("customCommand.branchPlaceholder")}
              className="min-w-0 flex-1 border-0 bg-transparent py-[7px] font-mono text-[13px] text-[var(--color-fg)] outline-none"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
          </div>
          <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
            {t("customCommand.branchHint")}
          </span>
        </label>
      )}

      <label className="mt-4 block text-[13.5px]">
        {t("customCommand.commandLabel")}
        <textarea
          ref={cmdRef}
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            // ⌘/Ctrl+Enter launches; a bare Enter inserts a newline so a
            // multiline bash script stays freely editable.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}
          placeholder={"npm run dev\n# or any multiline bash script"}
          rows={5}
          className="mt-1.5 box-border min-h-[120px] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[13px] leading-snug text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
          {isWorktree ? t("customCommand.runsWorktree") : t("customCommand.runsMain")},{" "}
          {t("customCommand.commandHintExamples")}{" "}
          <code className="mono">ssh box</code>, <code className="mono">npm run dev</code>,{" "}
          <code className="mono">python</code>. {t("customCommand.commandHintMultiline")}{" "}
          <Trans
            t={t}
            i18nKey="customCommand.commandHintLaunch"
            components={{ kbd: <kbd className="font-mono" /> }}
          />
        </span>
      </label>

      {err && <p className="mt-3 text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>{t("common:cancel")}</Button>
        <Button variant="primary" disabled={!name.trim() || !command.trim() || busy} onClick={submit}>
          <SquareChevronRight className="h-4 w-4" /> {t("customCommand.launch")}
        </Button>
      </div>
    </AppDialog>
  );
}
