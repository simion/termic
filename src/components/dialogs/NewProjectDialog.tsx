// Add Project dialog with discovered-repos shortcut.

import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { bulkAddSummary, pathsToAdd, type BulkAddResult } from "@/lib/bulkAdd";
import { Checkbox } from "@/components/ui/Checkbox";
import { projectAdd, projectAddMulti, discoverRepos, discoveryDismiss, settingsLoad, pathIsGitRepo, pathExists, cachedHomeDir } from "@/lib/ipc";
import { repoNameFromUrl } from "@/lib/cloneUrl";
import { expandTilde } from "@/lib/pathMatch";
import { AuxTerminal } from "@/components/task/AuxTerminal";
import type { DiscoveredRepo, Project, ProjectMember } from "@/lib/types";
import { Folder, FolderPlus, Layers, RotateCcw, X, Download } from "lucide-react";
import { cn } from "@/lib/utils";

// Where a non-git folder is being added — drives the confirm copy. We no
// longer ask the user to pre-declare "not a git repo" with a checkbox;
// instead we detect it after they pick a directory and confirm intent.
type ConfirmKind = "project" | "host" | "member";
const CONFIRM_COPY: Record<ConfirmKind, { titleKey: string; bodyKey: string }> = {
  project: {
    titleKey: "newProject.confirmProjectTitle",
    bodyKey: "newProject.confirmProjectBody",
  },
  host: {
    titleKey: "newProject.confirmHostTitle",
    bodyKey: "newProject.confirmHostBody",
  },
  member: {
    titleKey: "newProject.confirmMemberTitle",
    bodyKey: "newProject.confirmMemberBody",
  },
};

export function NewProjectDialog() {
  const { t } = useTranslation("dialogs");
  const open = useUI(s => s.newProjectOpen);
  const close = useUI(s => s.closeNewProject);
  const pushToast = useUI(s => s.pushToast);
  const loadAll = useApp(s => s.loadAll);
  const projects = useApp(s => s.projects);
  const setProjectCollapsed = useApp(s => s.setProjectCollapsed);
  // Project type picker — defaults to "repo" (today's single-repo
  // flow). Switching to "multi" swaps the body to the host-picker +
  // member-multi-select form. Both flows reuse the same Add button.
  const [mode, setMode] = useState<"repo" | "multi" | "clone">("repo");
  const [path, setPath] = useState("");
  // ── Clone from a git URL (GH #285) ───────────────────────────────────
  const [cloneUrl, setCloneUrl] = useState("");
  // The PARENT the clone lands in, not the repo directory. Proposed from
  // `repos_dir` when the user has one and left EMPTY when they do not:
  // inventing `~/termic/...` here would create a directory somewhere they
  // never chose, and the clone command would carry that guess into a shell.
  const [cloneParent, setCloneParent] = useState("");
  // Set once the user commits, which is what mounts the terminal. Held
  // separately from the field so editing the URL afterwards cannot re-point a
  // clone that is already running.
  const [cloneStarted, setCloneStarted] = useState<{ parent: string; dest: string; input: string } | null>(null);
  // Does a git repo exist at the destination yet? Polled while the terminal is
  // up, because the only other completion signal we have is the user, and they
  // are watching the terminal. See the comment on the poll effect.
  const [cloneLanded, setCloneLanded] = useState(false);
  // Resolved once so `~` can be expanded while the user types, rather than
  // only at submit: the destination line is a promise about where the repo
  // will land, and showing them a `~` we have not resolved is how it landed
  // somewhere else entirely.
  const [homePath, setHomePath] = useState("");
  useEffect(() => { void cachedHomeDir().then(setHomePath); }, []);
  // Issue #4: add a plain folder (not a git repo). In repo mode the
  // folder becomes a repo-root-only project (agent runs at the folder).
  // In multi mode it becomes a non-git HOST for the member repos.
  // No longer toggled by the user — set automatically once we detect the
  // picked directory isn't a git repo (and they confirm via the dialog).
  const [nonGit, setNonGit] = useState(false);
  // Pending non-git confirmation. We surface it as a Promise so the
  // browse / add flows can `await` the user's decision inline.
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; resolve: (ok: boolean) => void } | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredRepo[]>([]);
  // Checked rows in the discovered list. A set of PATHS, which is the only
  // stable identity a discovered repo has: the list is refetched after every
  // add, so an index or an object reference would go stale under the user.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reposDir, setReposDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Filter for the discovered-repos list. Shows when >5 repos so the
  // dialog stays uncluttered for small repos folders. Case-insensitive
  // substring match against name + path.
  const [filter, setFilter] = useState("");
  // Reveal the dismissed-repos section (repos the user hid from discovery).
  const [showHidden, setShowHidden] = useState(false);
  // Multi-repo: self-contained inline member rows (order = display order),
  // keyed by root_path. No project registration — a member is just a path
  // plus its per-project scripts.
  const [memberRows, setMemberRows] = useState<ProjectMember[]>([]);
  // Multi-repo: user-visible project name. Required (drives the
  // auto-created host dir name when no host path is given, and the
  // sidebar label always).
  const [multiName, setMultiName] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("repo");
    setPath(""); setErr(null); setFilter(""); setShowHidden(false);
    setNonGit(false);
    setConfirm(null);
    setMemberRows([]);
    setMultiName("");
    // Clone flow: cleared on every open so a previous URL, or a terminal from
    // a clone the user walked away from, never reappears against a new one.
    setCloneUrl(""); setCloneStarted(null); setCloneLanded(false);
    setCloneParent("");
    (async () => {
      try {
        const s = await settingsLoad();
        setReposDir(s.repos_dir || "");
        // PROPOSE the repos folder when there is one, and leave the field
        // empty when there is not. Nothing is invented here: a default the
        // user never chose would be carried straight into a shell command and
        // create a directory somewhere they did not ask for.
        setCloneParent(s.repos_dir || "");
        if (s.repos_dir) {
          const repos = await discoverRepos(s.repos_dir);
          setDiscovered(repos.filter(r => !r.already_added));
        } else { setDiscovered([]); }
      } catch { setDiscovered([]); }
    })();
  }, [open]);

  // Resolve the pending confirm dialog with the user's decision.
  function resolveConfirm(ok: boolean) {
    confirm?.resolve(ok);
    setConfirm(null);
  }
  // Open the non-git confirm dialog and resolve once the user decides.
  function confirmNonGit(kind: ConfirmKind): Promise<boolean> {
    return new Promise(resolve => setConfirm({ kind, resolve }));
  }
  // Decide how to treat a picked directory: a real git repo proceeds
  // straight through; a plain folder pops the confirm. Returns the
  // resolved non-git flag, or null if the user backed out.
  async function classify(p: string, kind: ConfirmKind): Promise<boolean | null> {
    const isGit = await pathIsGitRepo(p).catch(() => false);
    if (isGit) return false;
    return (await confirmNonGit(kind)) ? true : null;
  }

  // The directory `git clone` will create. `null` when the URL carries no
  // name, which leaves the field empty rather than proposing a wrong one.
  const cloneName = repoNameFromUrl(cloneUrl);
  // EXPANDED, not as typed. `~/r` is not a directory: handed to the spawn it
  // silently fell back to the home directory, so the clone landed in `~` while
  // the Add gate polled `~/r/<name>` and never lit. Shown expanded too, since
  // the whole job of this line is to say where the repo is about to go.
  const cloneParentAbs = expandTilde(cloneParent.trim().replace(/\/+$/, ""), homePath);
  const cloneDest = cloneParentAbs && cloneName ? `${cloneParentAbs}/${cloneName}` : "";

  // Poll the destination while the terminal is up.
  //
  // This gates the Add button; it is NOT a completion signal, and it cannot
  // be one. Measured against a real clone: `rev-parse --git-dir` (what
  // `path_is_git_repo` runs) succeeds 6ms in, while the clone still has
  // seconds to run, and a repo cloned from an EMPTY remote is indistinguishable
  // from one still downloading: both have an empty `refs/` and no packs. So
  // the honest completion signal is the user, who is watching the terminal
  // output that is the whole reason this runs in a terminal. What the poll
  // buys is the opposite guarantee: a typo'd URL never creates a directory,
  // so Add stays disabled and cannot register a project that is not there.
  useEffect(() => {
    if (!cloneStarted) { setCloneLanded(false); return; }
    let cancelled = false;
    const tick = () => {
      pathIsGitRepo(cloneStarted.dest)
        .then(ok => { if (!cancelled) setCloneLanded(ok); })
        .catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [cloneStarted]);

  async function browseCloneParent() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setCloneParent(sel);
  }

  async function startClone() {
    const parent = cloneParentAbs;
    const name = cloneName;
    if (!parent || !name) return;
    setErr(null);
    // A cwd that does not exist does not fail the spawn: it starts the shell
    // in the home directory instead, and the clone lands somewhere the user
    // never chose while this dialog waits for a repo that will never appear
    // where it is looking. Refuse here, where it can still be said out loud.
    if (!(await pathExists(parent))) {
      setErr(t("newProject.cloneParentMissing", { path: parent }));
      return;
    }
    // Single-quoted, because a URL can legally carry characters the shell
    // splits on and this string is about to be typed at a real prompt. The
    // name is `repoNameFromUrl`'s output, which already refuses anything with
    // a separator in it.
    const url = cloneUrl.trim().replaceAll("'", `'\\''`);
    setCloneStarted({
      parent,
      dest: `${parent}/${name}`,
      // Trailing CR: the command RUNS on its own. Clicking Clone is the
      // decision to clone, and making the user press Enter at a prompt they
      // did not ask to be at was friction for no safety, since the button
      // above already said what it was about to do.
      //
      // The terminal is still the point: a credential prompt, a host-key
      // confirmation or an error all land here and are answerable. Ctrl-C then
      // editing the line is the escape hatch for flags (--depth, --branch,
      // --recurse-submodules), which is why the command is still typed out in
      // full rather than run out of sight.
      input: `git clone '${url}' ${name}\r`,
    });
  }

  /** Add one path as a project.
   *
   *  `closeAfter` defaults to "this is the path the repo-mode field holds",
   *  which is what it has always inferred: the discovered-list sweep adds
   *  several and must stay open, the single typed path is done. The clone flow
   *  passes it explicitly, because its destination is never the `path` field
   *  and inferring would leave the dialog open on a finished one-shot. */
  async function add(p: string, asNonGit: boolean, closeAfter?: boolean) {
    setBusy(true); setErr(null);
    try {
      const proj = await projectAdd(p, asNonGit);
      // Newly-added projects start expanded so the "+ Get started"
      // CTA is visible without an extra click — the empty-defaults-
      // to-collapsed fallback in Sidebar would otherwise hide it.
      setProjectCollapsed(proj.id, false);
      await loadAll();
      pushToast(t("newProject.toastAdded", { name: proj.name }), "success");
      // Refresh discovery in case the same repos_dir has more candidates.
      if (reposDir) {
        const repos = await discoverRepos(reposDir).catch(() => []);
        const nextDiscovered = repos.filter(r => !r.already_added);
        setDiscovered(nextDiscovered);
        // If the current filter would leave the list empty after the
        // add (e.g. user typed the repo name to find it, ticked it,
        // and now nothing else matches), drop the filter so they see
        // the full list again. If something still matches, keep it -
        // probably mid-multi-add for similar names.
        const q = filter.trim().toLowerCase();
        if (q) {
          const stillVisible = nextDiscovered.some(r =>
            r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
          );
          if (!stillVisible) setFilter("");
        }
      }
      if (closeAfter ?? (p === path)) close();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  /** Add every checked repo, in one sweep.
   *
   *  Sequential rather than parallel: each add writes `projects.json`, and a
   *  concurrent burst would have several writers racing over one file. Ten
   *  repos is a second of work, and the ordering also makes the result list
   *  read in the order the user sees the rows.
   *
   *  One failure never stops the rest. "Already added" is the likely one and
   *  it says nothing about the other nine; the summary names what landed and
   *  what did not, and the failures stay checked so a retry is one click.
   */
  async function addSelected() {
    const paths = pathsToAdd(selected, discovered.filter(r => !r.dismissed));
    if (paths.length === 0) return;
    setBusy(true); setErr(null);
    const results: BulkAddResult[] = [];
    for (const p of paths) {
      const name = discovered.find(r => r.path === p)?.name ?? p;
      try {
        const proj = await projectAdd(p, false);
        setProjectCollapsed(proj.id, false);
        results.push({ path: p, name: proj.name });
      } catch (e) {
        results.push({ path: p, name, error: String(e).replace(/^Error:\s*/, "") });
      }
    }
    await loadAll();
    const summary = bulkAddSummary(results);
    pushToast(summary.text, summary.ok ? "success" : "error");
    // Keep the ones that failed checked: they are the retry, and unchecking
    // them would make the user find them again in a list that just shrank.
    const stillFailing = new Set(results.filter(r => r.error).map(r => r.path));
    setSelected(stillFailing);
    if (reposDir) {
      const repos = await discoverRepos(reposDir).catch(() => []);
      setDiscovered(repos.filter(r => !r.already_added));
    }
    setBusy(false);
    if (summary.ok) close();
  }

  // Hide a discovered repo from the picker (or restore it). Optimistic:
  // flip the local flag now, revert if the IPC fails. Clear the selection
  // if the repo being hidden was the picked one.
  async function dismissRepo(p: string, dismissed: boolean) {
    setDiscovered(prev => prev.map(r => (r.path === p ? { ...r, dismissed } : r)));
    if (dismissed && path === p) setPath("");
    try {
      await discoveryDismiss(p, dismissed);
    } catch (e) {
      setDiscovered(prev => prev.map(r => (r.path === p ? { ...r, dismissed: !dismissed } : r)));
      setErr(String(e));
    }
  }

  // Single-repo Add: detect git, confirm if it's a plain folder, then add.
  async function handleAdd() {
    const p = path.trim();
    if (!p) return;
    const ng = await classify(p, "project");
    if (ng === null) return;
    await add(path, ng);
  }

  /** What the multi-repo Add button needs: a name and at least one member.
   *  Shared with the Enter handlers so the key and the button can never
   *  disagree about when the dialog is ready. */
  const canAddMulti = !!multiName.trim() && memberRows.length > 0 && !busy;

  /** Enter in a text field runs the dialog's primary action, the same as
   *  clicking Add. Guarded by the same condition that enables the button, so
   *  Enter is inert exactly when the button is disabled (and `busy` keeps a
   *  held key from firing a second add while the first is in flight). The
   *  member picker's "Add repo from disk" field already worked this way; the
   *  fields that create the project itself did not. */
  function submitOnEnter(enabled: boolean, run: () => void) {
    return (e: React.KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (enabled) run();
    };
  }

  async function addMulti(asNonGit: boolean) {
    setBusy(true); setErr(null);
    try {
      // Empty path tells Rust to auto-create + git-init the host
      // under ~/termic/projects/<slug>/. Name is required either way.
      const proj = await projectAddMulti(path.trim(), multiName.trim(), memberRows, asNonGit);
      setProjectCollapsed(proj.id, false);
      await loadAll();
      pushToast(t("newProject.toastAddedMulti", { name: proj.name, count: memberRows.length }), "success");
      close();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  // Multi-repo Add: a host path is optional. When given, detect git and
  // confirm if it's a plain folder; an auto-created host is always git.
  async function handleAddMulti() {
    const host = path.trim();
    let ng = false;
    if (host) {
      const res = await classify(host, "host");
      if (res === null) return;
      ng = res;
    }
    await addMulti(ng);
  }

  // Add an inline member from an existing project — copies its path /
  // git status / base / scripts / sandbox lists into a self-contained
  // member. The source project is NOT referenced; nothing is registered.
  function addMemberFromProject(p: Project) {
    setMemberRows(prev => prev.some(m => m.root_path === p.root_path) ? prev : [...prev, {
      root_path: p.root_path,
      name: p.name,
      non_git: p.non_git,
      base_branch: p.base_branch,
      setup_script:   p.setup_script   ?? "",
      run_script:     p.run_script     ?? "",
      archive_script: p.archive_script ?? "",
      sandbox_rw_paths:      p.sandbox_rw_paths,
      sandbox_allowed_hosts: p.sandbox_allowed_hosts,
    }]);
  }
  // Add an inline member straight from a disk path (no project record).
  // Rust canonicalizes + detects git on submit; these are provisional.
  function addMemberFromDisk(path: string, asNonGit: boolean) {
    const name = path.split("/").filter(Boolean).pop() || "repo";
    setMemberRows(prev => prev.some(m => m.root_path === path) ? prev : [...prev, {
      root_path: path, name, non_git: asNonGit,
      base_branch: "", setup_script: "", run_script: "", archive_script: "",
    }]);
  }
  function removeMember(rootPath: string) {
    setMemberRows(prev => prev.filter(m => m.root_path !== rootPath));
  }
  function updateMember(rootPath: string, patch: Partial<ProjectMember>) {
    setMemberRows(prev => prev.map(m => m.root_path === rootPath ? { ...m, ...patch } : m));
  }

  async function browse() {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel !== "string") return;
    // Detect git right after the pick so the form reflects reality (and
    // the "Folder" vs "Repository" label updates). A plain folder pops the
    // confirm; backing out leaves the field untouched.
    const ng = await classify(sel, mode === "multi" ? "host" : "project");
    if (ng === null) return;
    setPath(sel);
    setNonGit(ng);
  }

  // List of projects eligible to be members (any already-added single
  // project; multi projects are excluded — nesting multi inside multi
  // is out of scope for v1).
  const memberCandidates: Project[] = projects.filter(
    p => (p.type ?? "single") === "single",
  );

  return (
    <>
    <AppDialog
      open={open}
      onOpenChange={(v) => (v ? null : close())}
      title={t("newProject.title")}
      // Fixed width across both modes so toggling between Repository
      // and Multi-repo doesn't resize the dialog mid-decision. Sized
      // for multi-repo: per-member rows each have three script
      // textareas + a checkbox row, so the dialog needs real width
      // and benefits from the dialog-level vertical scrolling that
      // AppDialog provides by default.
      className="max-w-3xl"
    >
      {/* Segmented switch: Repository (default) vs Multi-repo.
          Sits at the very top so the user's first decision is the type
          of project they're adding — the body below swaps to match.
          Full-width 50/50 so both options carry the same visual weight
          and the user reads "choose one of two", not "primary CTA +
          afterthought". Two-line tiles (icon + name + descriptor) make
          the difference obvious before committing. */}
      <div className="mb-5 grid grid-cols-3 gap-2 text-[13px]">
        {([
          { id: "repo",  icon: Folder, label: t("newProject.modeRepo"),  hint: t("newProject.modeRepoHint") },
          { id: "clone", icon: Download, label: t("newProject.modeClone"), hint: t("newProject.modeCloneHint") },
          { id: "multi", icon: Layers, label: t("newProject.modeMulti"), hint: t("newProject.modeMultiHint") },
        ] as const).map(opt => {
          const active = mode === opt.id;
          const Ic = opt.icon;
          return (
            <button
              key={opt.id}
              type="button"
              data-testid={`project-mode-${opt.id}`}
              onClick={() => setMode(opt.id)}
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-deep)]/15"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
              )}
            >
              <span className="flex items-center gap-1.5 font-medium text-[var(--color-fg)]">
                <Ic className={cn("h-3.5 w-3.5", active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]")} />
                {opt.label}
              </span>
              <span className="text-[11.5px] leading-snug text-[var(--color-fg-dim)]">{opt.hint}</span>
            </button>
          );
        })}
      </div>

      {mode === "clone" ? (
        <>
          <p className="mb-3 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
            {t("newProject.cloneIntro")}
          </p>

          <label className="block">
            <span className="mb-1.5 block text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">{t("newProject.repoUrlLabel")}</span>
            <Input
              value={cloneUrl}
              onChange={e => setCloneUrl(e.target.value)}
              placeholder="git@github.com:owner/repo.git"
              disabled={!!cloneStarted}
              data-testid="clone-url"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">{t("newProject.cloneIntoLabel")}</span>
            <div className="flex gap-2">
              <Input
                value={cloneParent}
                onChange={e => setCloneParent(e.target.value)}
                placeholder="/path/to/your/repos"
                disabled={!!cloneStarted}
                className="flex-1"
                data-testid="clone-parent"
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
              <Button variant="secondary" size="lg" onClick={browseCloneParent} disabled={!!cloneStarted}>{t("common:browse")}</Button>
            </div>
            <span className="mt-1 block text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
              {cloneDest
                ? <Trans i18nKey="newProject.clonesInto" values={{ dest: cloneDest }} components={{ code: <code className="mono" data-testid="clone-dest" /> }} />
                : reposDir
                  ? t("newProject.cloneIntoHintRepos")
                  : t("newProject.cloneIntoHintNone")}
            </span>
          </label>

          {cloneStarted && (
            <div className="mt-4">
              <div className="mb-1.5 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">{t("newProject.terminalLabel")}</div>
              {/* The command is TYPED, not run: `initialInput` carries no
                  newline, so it sits at the prompt for the user to edit
                  (--depth, --branch, a different remote) and run themselves.
                  A form field per flag is the alternative, and the shell is
                  already a better editor than that. */}
              <div className="h-64 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]" data-testid="clone-terminal">
                <AuxTerminal
                  taskPath={cloneStarted.parent}
                  active={true}
                  autoFocus
                  initialInput={cloneStarted.input}
                />
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
                {t("newProject.cloneNote")}
              </p>
            </div>
          )}

          {err && <p className="mt-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}

          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>{t("common:cancel")}</Button>
            {!cloneStarted ? (
              <Button
                variant="primary"
                disabled={!cloneDest || busy}
                onClick={() => void startClone()}
                data-testid="clone-start"
              >
                <Download className="h-4 w-4" /> {t("newProject.clone")}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!cloneLanded || busy}
                onClick={() => void add(cloneStarted.dest, false, true)}
                data-testid="clone-add"
              >
                <FolderPlus className="h-4 w-4" /> {busy ? t("newProject.adding") : t("newProject.addProject")}
              </Button>
            )}
          </div>
        </>
      ) : mode === "multi" ? (
        <>
          <p className="mb-3 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
            <Trans i18nKey="newProject.multiIntro" components={{ code: <code className="mono" /> }} />
          </p>

          <label className="block text-[13.5px]">
            {t("newProject.nameLabel")}
            <Input
              value={multiName}
              onChange={e => setMultiName(e.target.value)}
              onKeyDown={submitOnEnter(canAddMulti, handleAddMulti)}
              placeholder={t("newProject.namePlaceholder")}
              className="mt-1.5"
              autoFocus
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
            <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
              {t("newProject.nameHint")}
            </span>
          </label>

          <label className="mt-4 block text-[13.5px]">
            {t("newProject.hostLabel")} <span className="text-[var(--color-fg-faint)]">{t("newProject.hostOptional")}</span>
            <div className="mt-1.5 flex gap-2">
              <Input
                value={path}
                onChange={e => { setPath(e.target.value); setNonGit(false); }}
                onKeyDown={submitOnEnter(canAddMulti, handleAddMulti)}
                placeholder="~/Notes/team-knowledge"
              />
              <Button variant="secondary" size="lg" onClick={browse}>{t("common:browse")}</Button>
            </div>
            <span className="mt-1 block text-[11.5px] text-[var(--color-fg-faint)]">
              <Trans i18nKey="newProject.hostHint" components={{ code: <code className="mono" /> }} />
            </span>
          </label>

          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
              <span>{t("newProject.membersLabel")}</span>
              <span className="font-mono normal-case text-[11.5px] text-[var(--color-fg-faint)]">
                {t("newProject.membersCount", { count: memberRows.length, total: memberCandidates.length })}
              </span>
            </div>
            <>
                {memberRows.length === 0 ? (
                  <div className="rounded-md border border-dashed border-[var(--color-border-soft)] bg-[var(--color-bg)] px-3 py-6 text-center text-[12.5px] text-[var(--color-fg-faint)]">
                    {t("newProject.membersEmpty")}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {memberRows.map(row => (
                      <div key={row.root_path} className="overflow-hidden rounded-md border border-l-2 border-[var(--color-accent-soft)] border-l-[var(--color-accent)] bg-[var(--color-accent-deep)]/[0.07]">
                        <div className="flex items-center gap-3 px-3 py-2">
                          <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{row.name}</span>
                              {row.non_git && (
                                <span className="shrink-0 rounded bg-[var(--color-bg-1)] px-1 text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">{t("newProject.folderBadge")}</span>
                              )}
                            </div>
                            <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{row.root_path}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeMember(row.root_path)}
                            title={t("newProject.removeMemberTitle")}
                            className="rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-err)]/10 hover:text-[var(--color-err)]"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="flex flex-col gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/40 px-3 py-2">
                          <ScriptInput
                            label={t("newProject.scriptSetup")}
                            value={row.setup_script}
                            onChange={v => updateMember(row.root_path, { setup_script: v })}
                            placeholder="docker compose up -d"
                          />
                          <ScriptInput
                            label={t("newProject.scriptRun")}
                            value={row.run_script}
                            onChange={v => updateMember(row.root_path, { run_script: v })}
                            placeholder="PORT=$TERMIC_PORT npm run dev"
                          />
                          <ScriptInput
                            label={t("newProject.scriptArchive")}
                            value={row.archive_script}
                            onChange={v => updateMember(row.root_path, { archive_script: v })}
                            placeholder="docker compose down"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <AvailableMembersPicker
                  candidates={memberCandidates.filter(c => !memberRows.some(r => r.root_path === c.root_path))}
                  onAdd={addMemberFromProject}
                  onQuickAdd={async (path) => {
                    const asNonGit = await classify(path, "member");
                    if (asNonGit === null) return;
                    addMemberFromDisk(path, asNonGit);
                  }}
                />
              </>
          </div>

          {err && <p className="mt-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>{t("common:cancel")}</Button>
            <Button
              variant="primary"
              disabled={!canAddMulti}
              onClick={handleAddMulti}
            >
              <Layers className="h-4 w-4" /> {t("newProject.addMulti")}
            </Button>
          </div>
        </>
      ) : (
      <>
      {(() => {
        // Dismissed repos (Rust flags them via settings.discovery_dismissed)
        // are still discovered but hidden from the main list — a dormant local
        // clone can stop cluttering the picker without being deleted.
        const visible = discovered.filter(r => !r.dismissed);
        const hidden = discovered.filter(r => r.dismissed);
        if (visible.length === 0 && hidden.length === 0) return null;
        const q = filter.trim().toLowerCase();
        const filtered = q
          ? visible.filter(r =>
              r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
            )
          : visible;
        return (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
            <span className="flex items-center gap-2">
              {/* Select-all over the FILTERED rows, not every discovered repo:
                  the filter is how you narrow to the set you want, so ticking
                  this must mean "these", not "all fifty". */}
              <Checkbox
                checked={filtered.length > 0 && filtered.every(r => selected.has(r.path))}
                onChange={next => setSelected(prev => {
                  const s = new Set(prev);
                  for (const r of filtered) next ? s.add(r.path) : s.delete(r.path);
                  return s;
                })}
                aria-label={t("newProject.selectAllAria")}
                data-testid="discovered-select-all"
              />
              <span>{t("newProject.discoveredRepos")}</span>
            </span>
            <span className="font-mono normal-case text-[11.5px] text-[var(--color-fg-faint)]">
              {q
                ? t("newProject.discoveredIn", { shown: t("newProject.filteredOf", { filtered: filtered.length, total: visible.length }), dir: reposDir })
                : t("newProject.discoveredIn", { shown: visible.length, dir: reposDir })}
            </span>
          </div>
          {visible.length > 5 && (
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t("newProject.filterPlaceholder")}
              className="mb-1.5"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
          {visible.length > 0 && (
          <div className="max-h-[220px] overflow-auto rounded-md border border-[var(--color-border-soft)]">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-[12.5px] text-[var(--color-fg-faint)]">
                {t("newProject.noReposMatch", { filter })}
              </div>
            ) : filtered.map(r => (
              // The ROW is the surface: tint and hover live here, not on the
              // label button, so the checkbox sits INSIDE the selected
              // background instead of beside a highlight that starts hard
              // against it.
              <div
                key={r.path}
                className={cn(
                  "group flex w-full items-center gap-2.5 px-3",
                  selected.has(r.path) && "bg-[var(--color-accent-deep)]/10",
                  !busy && "hover:bg-[var(--color-hover)]",
                )}
              >
                <span className="shrink-0">
                  <Checkbox
                    checked={selected.has(r.path)}
                    onChange={next => setSelected(prev => {
                      const s = new Set(prev);
                      next ? s.add(r.path) : s.delete(r.path);
                      return s;
                    })}
                    aria-label={t("newProject.selectRepoAria", { name: r.name })}
                    data-testid={`discovered-check-${r.name}`}
                  />
                </span>
                {/* The row body TICKS the box rather than filling in the path
                    field below. One list, one meaning: with checkboxes on
                    screen, a click that did something else would be a second
                    selection model in the same three inches. The manual field
                    is still there for a path that was never discovered. */}
                <button
                  onClick={() => setSelected(prev => {
                    const s = new Set(prev);
                    s.has(r.path) ? s.delete(r.path) : s.add(r.path);
                    return s;
                  })}
                  disabled={busy}
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-[14px] disabled:opacity-50"
                  title={r.path}
                >
                  <Folder className={cn("h-4 w-4 shrink-0", selected.has(r.path) ? "text-[var(--color-accent)]" : "text-[var(--color-fg-faint)]")} />
                  <span className="shrink-0 truncate">{r.name}</span>
                  {/* Full path, faded, right-aligned. dir=rtl truncates from the
                      LEFT so the meaningful tail (…/repo) stays readable. */}
                  <span
                    dir="rtl"
                    className="min-w-0 flex-1 truncate text-right text-[11px] text-[var(--color-fg-faint)] opacity-50"
                  >
                    {r.path}
                  </span>
                </button>
                <button
                  onClick={() => dismissRepo(r.path, true)}
                  title={t("newProject.hideFromDiscovery")}
                  aria-label={t("newProject.hideAria", { name: r.name })}
                  className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] opacity-0 hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          )}
          {hidden.length > 0 && (
            <div className="mt-1.5">
              <button
                onClick={() => setShowHidden(v => !v)}
                className="text-[11.5px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg-dim)]"
              >
                {showHidden ? t("newProject.hideHidden", { count: hidden.length }) : t("newProject.showHidden", { count: hidden.length })}
              </button>
              {showHidden && (
                <div className="mt-1 max-h-[140px] overflow-auto rounded-md border border-[var(--color-border-soft)]">
                  {hidden.map(r => (
                    <div key={r.path} className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px]">
                      <Folder className="h-4 w-4 shrink-0 text-[var(--color-fg-faint)] opacity-50" />
                      <span className="shrink-0 truncate text-[var(--color-fg-dim)]">{r.name}</span>
                      <span dir="rtl" className="min-w-0 flex-1 truncate text-right text-[11px] text-[var(--color-fg-faint)] opacity-50">{r.path}</span>
                      <button
                        onClick={() => dismissRepo(r.path, false)}
                        title={t("newProject.restoreTitle")}
                        aria-label={t("newProject.restoreAria", { name: r.name })}
                        className="shrink-0 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="relative my-3 text-center">
            <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--color-border-soft)]" />
            <span className="relative bg-[var(--color-bg-1)] px-2 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">{t("newProject.orAddManually")}</span>
          </div>
        </div>
        );
      })()}

      <label className="block text-[13.5px]">
        {nonGit ? t("newProject.pathLabelFolder") : t("newProject.pathLabelRepo")}
        <div className="mt-1.5 flex gap-2">
          <Input
            data-testid="new-project-path"
            value={path}
            onChange={e => { setPath(e.target.value); setNonGit(false); }}
            onKeyDown={submitOnEnter(!!path.trim() && !busy, handleAdd)}
            placeholder="/path/to/repo"
          />
          <Button variant="secondary" size="lg" onClick={browse}>{t("common:browse")}</Button>
        </div>
        {/* Issue #4: a plain folder (e.g. a parent dir of several repos)
            works too — it becomes a repo-root-only project (agents run at
            the folder, no worktrees). We detect git after you pick the dir
            and confirm before adding, so there's no checkbox to set. */}
        <span className="mt-1 block text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
          {t("newProject.pathHint")}
        </span>
      </label>

      {err && <p className="mt-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}

      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>{t("common:cancel")}</Button>
        {/* One button, two jobs, and the label says which: ticked rows are the
            sweep, and the manual field is the fallback for a path discovery
            never offered. Showing both at once would leave the user guessing
            which one their click uses. */}
        {selected.size > 0 ? (
          <Button variant="primary" disabled={busy} onClick={() => void addSelected()}
                  data-testid="add-selected-projects">
            <FolderPlus className="h-4 w-4" />
            {busy ? t("newProject.addingDots") : t(selected.size === 1 ? "newProject.addProjectsOne" : "newProject.addProjectsMany", { count: selected.size })}
          </Button>
        ) : (
          <Button variant="primary" disabled={!path || busy} onClick={handleAdd}>
            <FolderPlus className="h-4 w-4" /> {t("common:add")}
          </Button>
        )}
      </div>
      </>
      )}
    </AppDialog>

    {/* Non-git confirm. Replaces the old "Not a git repository" checkboxes:
        we detect a plain folder after the user picks it, then ask here. */}
    <AppDialog
      open={!!confirm}
      onOpenChange={(v) => { if (!v) resolveConfirm(false); }}
      title={confirm ? t(CONFIRM_COPY[confirm.kind].titleKey) : ""}
      className="max-w-md"
    >
      {confirm && (
        <>
          <p className="text-[13.5px] leading-snug text-[var(--color-fg-dim)]">
            {t(CONFIRM_COPY[confirm.kind].bodyKey)}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => resolveConfirm(false)}>{t("common:cancel")}</Button>
            <Button variant="primary" onClick={() => resolveConfirm(true)}>
              <FolderPlus className="h-4 w-4" /> {t("newProject.addAsFolder")}
            </Button>
          </div>
        </>
      )}
    </AppDialog>
    </>
  );
}

/** Compact mono input for per-member script entries. Label on the
 *  left, single-row textarea on the right. Empty value = skip that
 *  script for the member. Placeholder shows the member project's
 *  standalone default so the user knows what gets inherited if they
 *  leave it blank (but they have to explicitly type it to opt in —
 *  empty means skip). */
function ScriptInput({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 shrink-0 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
        {label}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-1)] px-2 py-1 font-mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
      />
    </div>
  );
}

/** Collapsible "+ Add member" picker — same pattern as the
 *  RepositorySection editor. Default = single dashed button;
 *  click → list of available candidates; clicking a row copies that
 *  project's path/config into a self-contained member. `onQuickAdd`
 *  adds any folder from disk as a member (no project registration). */
function AvailableMembersPicker({ candidates, onAdd, onQuickAdd }: {
  candidates: Project[];
  onAdd: (p: Project) => void;
  onQuickAdd?: (path: string) => Promise<void>;
}) {
  const { t } = useTranslation("dialogs");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Path for the inline "Add repo from disk" row — same path + Browse
  // shape as the host field above, just rendered as a member row. Git
  // detection (and the non-git confirm) happens in onQuickAdd.
  const [diskPath, setDiskPath] = useState("");
  useEffect(() => {
    if (candidates.length === 0 && !onQuickAdd) setOpen(false);
  }, [candidates.length, onQuickAdd]);
  if (candidates.length === 0 && !onQuickAdd && !open) {
    return (
      <div className="mt-3 text-[11.5px] text-[var(--color-fg-faint)]">
        {t("newProject.everyOtherMember")}
      </div>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[13px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
      >
        + {t("newProject.addMember")}
      </button>
    );
  }
  const browseDisk = async () => {
    const sel = await openDialog({ directory: true, multiple: false });
    if (typeof sel === "string") setDiskPath(sel);
  };
  const addDisk = async () => {
    if (!onQuickAdd || busy) return;
    const p = diskPath.trim();
    if (!p) return;
    setBusy(true);
    try { await onQuickAdd(p); setDiskPath(""); } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 rounded-md border border-[var(--color-border-soft)]">
      <div className="flex items-center justify-between px-3 py-1.5 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
        <span>{t("newProject.availableRepos")}</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-0.5 hover:text-[var(--color-fg)]"
          aria-label={t("common:close")}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="border-t border-[var(--color-border-soft)] px-3 py-2 text-[11.5px] leading-snug text-[var(--color-fg-dim)]">
        {t("newProject.pickerIntro")}
      </div>
      {candidates.map(c => (
        <button
          key={c.id}
          type="button"
          onClick={() => onAdd(c)}
          className="flex w-full items-center gap-3 border-t border-[var(--color-border-soft)] px-3 py-2 text-left hover:bg-[var(--color-hover)]"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-[var(--color-fg)]">{c.name}</div>
            <div className="truncate font-mono text-[11.5px] text-[var(--color-fg-faint)]">{c.root_path}</div>
          </div>
          <span className="shrink-0 text-[11.5px] uppercase tracking-wider text-[var(--color-accent)] opacity-70">{t("common:add")}</span>
        </button>
      ))}
      {onQuickAdd && (
        <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)]/40 px-3 py-2.5">
          <div className="mb-1.5 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
            {t("newProject.addFromDisk")}
          </div>
          <div className="flex gap-2">
            <Input
              value={diskPath}
              onChange={e => setDiskPath(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addDisk(); } }}
              placeholder="/path/to/repo"
              className="flex-1"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
            <Button variant="secondary" size="lg" onClick={browseDisk} disabled={busy}>{t("common:browse")}</Button>
            <Button variant="primary" size="lg" onClick={addDisk} disabled={busy || !diskPath.trim()}>
              {busy ? t("newProject.adding") : t("common:add")}
            </Button>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--color-fg-faint)]">
            {t("newProject.diskHint")}
          </p>
        </div>
      )}
    </div>
  );
}
