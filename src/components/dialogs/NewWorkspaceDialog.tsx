// New workspace dialog: name + CLI segmented pills + branch prefix pills +
// branch name + branch-from. Calls workspace_create on submit.

import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { visibleCliIds } from "@/lib/agents";
import { workspaceCreate, workspaceCreateMulti, settingsLoad } from "@/lib/ipc";
import { slugify, cn } from "@/lib/utils";
import { Check, Loader2, AlertTriangle, Shield, Layers, GitBranch, Link2 } from "lucide-react";
import { SANDBOX_PRESETS } from "@/lib/sandboxPresets";
import type { MemberMode } from "@/lib/types";

const CLIS = ["claude", "gemini", "codex", "agy"] as const;
const PREFIXES = ["feature", "hotfix", "__custom__"] as const;

export function NewWorkspaceDialog() {
  const projectId = useUI(s => s.newWorkspaceProjectId);
  const close = useUI(s => s.closeNewWorkspace);
  const project = useApp(s => projectId ? s.projects.find(p => p.id === projectId) : null);
  const setActive = useApp(s => s.setActiveWorkspace);
  const loadAll = useApp(s => s.loadAll);
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  // CLI choices: the registry (custom agents included), or the built-in
  // list before it loads — minus any disabled / not-installed agents.
  const cliChoices = (() => {
    const list = agents.length
      ? agents
      : CLIS.map(id => ({ id, display_name: id, color: "" } as any));
    const visible = visibleCliIds(list.map(a => a.id), agents, detectedClis);
    return list.filter(a => visible.has(a.id));
  })();

  const [name, setName] = useState("");
  const [cli, setCli] = useState<string>("claude");
  const [prefix, setPrefix] = useState<typeof PREFIXES[number]>("feature");
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [base, setBase] = useState("");
  // Sandbox pin captured at creation. Defaults from project, can be
  // overridden for this one workspace, then is permanent post-create.
  const [sandbox, setSandbox] = useState(false);
  // The sandbox lists. Initialized from the
  // project's defaults whenever projectId changes; the user edits
  // freely until Create. Stored as multi-line text - we convert to
  // arrays at submit time. Using raw text in state lets the textareas
  // behave normally (blank lines while typing don't fight the split).
  const [sbRw,    setSbRw]    = useState("");
  const [sbHosts, setSbHosts] = useState("");
  // Multi-repo: per-member spec, indexed by member project id. Seeded
  // when the dialog opens for a multi project from project.members.
  // Per-member spec. Scripts are not per-workspace — they live on
  // the multi-repo project itself and apply to every workspace under
  // it. The dialog only collects mode + branch overrides here.
  type MemberSpec = {
    project_id: string;
    mode: MemberMode;
    branch: string;
    base_branch: string;
  };
  const [members, setMembers] = useState<MemberSpec[]>([]);
  const isMulti = (project?.type ?? "single") === "multi";
  const [busy, setBusy] = useState(false);
  // Ref guard against double-submit. React batches setBusy(true) so the
  // button's `disabled` only updates on the next render — but during a
  // burst of Enter/click events, multiple submit() calls can already be
  // queued before that render lands. Without this guard, mashing Create
  // produces multiple worktrees on disk (the user's "hanged a lot of new
  // workspace" bug). The ref is checked + flipped synchronously inside
  // submit() so concurrent calls see the truth immediately.
  const submittingRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  // Progress phase: form (default) → creating (worktree+copy in flight) →
  // setup (running setup script with live output) → done (success, 2s flash) → error.
  const [phase, setPhase] = useState<"form" | "creating" | "setup" | "done" | "error">("form");
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [createdWsId, setCreatedWsId] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Reset the form ONLY when the dialog opens for a different project —
  // never on re-fetches of the same project's data. Window-focus events fire
  // `loadAll()` (App.tsx) which replaces the projects array → `project`
  // object identity changes → an effect depending on `project` would wipe
  // every field the user just typed. Depending on `projectId` (a stable
  // string) avoids that. We seed CLI/base from the project but read them
  // imperatively at effect-time via getState so we don't need them in deps.
  useEffect(() => {
    if (!projectId) return;
    const p = useApp.getState().projects.find(x => x.id === projectId);
    setName(""); setBranch(""); setBranchEdited(false); setErr(null);
    setBase(p?.base_branch || "");
    setCli(p?.default_cli || "claude");
    setPrefix("feature");
    // Sandbox toggle defaults to project's preference OR the global
    // default (Settings → General). Either being true checks the box.
    // The user can still flip for THIS workspace - but once Create
    // fires, the pin is permanent on the Workspace record. The
    // three lists are seeded from the project's defaults; user
    // edits in this dialog land on the workspace ONLY, never on
    // the project.
    const globalDefault = usePrefs.getState().globalDefaultSandbox;
    setSandbox(!!p?.default_sandbox || globalDefault);
    // Seed with project's lists immediately; once Settings loads,
    // merge global defaults on top (dedupe-preserving order).
    setSbRw((p?.sandbox_rw_paths ?? []).join("\n"));
    setSbHosts((p?.sandbox_allowed_hosts ?? []).join("\n"));
    // Seed the per-member spec (multi-repo only). Each member starts
    // in Worktree mode on its own default branch — the simplest +
    // safest default. User can flip per-member to Repo root or change
    // branches before submit.
    if ((p?.type ?? "single") === "multi") {
      const all = useApp.getState().projects;
      const seeded: MemberSpec[] = (p?.members ?? []).flatMap(pm => {
        const m = all.find(x => x.id === pm.project_id);
        if (!m) return [];
        return [{
          project_id: pm.project_id,
          mode: "worktree" as MemberMode,
          branch: "",
          base_branch: m.base_branch || "",
        }];
      });
      setMembers(seeded);
    } else {
      setMembers([]);
    }
    settingsLoad().then(s => {
      const merge = (...lists: (string[] | undefined)[]) => {
        const seen = new Set<string>(); const out: string[] = [];
        for (const list of lists) {
          for (const v of list ?? []) {
            if (v && !seen.has(v)) { seen.add(v); out.push(v); }
          }
        }
        return out.join("\n");
      };
      // For multi-repo: union globals + host + every member project's
      // sandbox lists. Same dedupe-preserving order as single-repo,
      // just N+1 inputs instead of 2.
      if ((p?.type ?? "single") === "multi") {
        const all = useApp.getState().projects;
        const memberLists = (p?.members ?? [])
          .map(pm => all.find(x => x.id === pm.project_id))
          .filter((x): x is NonNullable<typeof x> => !!x);
        setSbRw(merge(
          s.sandbox_default_rw_paths,
          p?.sandbox_rw_paths,
          ...memberLists.map(m => m.sandbox_rw_paths),
        ));
        setSbHosts(merge(
          s.sandbox_default_allowed_hosts,
          p?.sandbox_allowed_hosts,
          ...memberLists.map(m => m.sandbox_allowed_hosts),
        ));
      } else {
        setSbRw(merge(s.sandbox_default_rw_paths,      p?.sandbox_rw_paths));
        setSbHosts(merge(s.sandbox_default_allowed_hosts, p?.sandbox_allowed_hosts));
      }
    }).catch(() => {});
    setPhase("form"); setSetupLog([]); setCreatedWsId(null);
    // CRITICAL: also reset `busy`. On a successful prior creation we
    // intentionally leave busy=true (so the form can't be re-submitted
    // during the streaming-setup phase). Without this reset, the NEXT
    // time the dialog opens, busy is still true → Create button stays
    // disabled even with all fields filled.
    setBusy(false);
    submittingRef.current = false;
  }, [projectId]);

  // Tauri event unlisten handles. Owned by submit() (which registers them
  // imperatively BEFORE invoking workspaceCreate — guaranteed ordering vs
  // the old useEffect-based subscription that races against fast/empty
  // setup scripts). Cleaned up on unmount + before each new submission.
  const unlistenRef = useRef<Array<() => void>>([]);
  useEffect(() => () => {
    for (const u of unlistenRef.current) u();
    unlistenRef.current = [];
  }, []);

  // Auto-scroll setup output as new lines arrive.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [setupLog]);

  // Auto-derive branch from name + prefix unless user has edited the field.
  const derived = useMemo(() => {
    const slug = slugify(name);
    if (prefix === "__custom__") return slug;
    return slug ? `${prefix}/${slug}` : "";
  }, [name, prefix]);
  useEffect(() => { if (!branchEdited) setBranch(derived); }, [derived, branchEdited]);

  async function submit() {
    if (!projectId || !name.trim() || !branch.trim()) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true); setErr(null); setPhase("creating"); setSetupLog([]);
    // Pre-generate the workspace ID then `await listen(...)` for BOTH
    // setup-output and setup-done BEFORE invoking workspaceCreate. The
    // earlier useEffect-based subscription wasn't guaranteed to attach in
    // time — for empty setup scripts Rust emits setup-done synchronously
    // inside workspace_create_sync, so the done event could fire while
    // React was still scheduling the effect → dialog hung forever on
    // "Waiting for output…". `await listen()` returns once the
    // subscription is confirmed by the Tauri backend, eliminating the
    // race entirely.
    const wsId = crypto.randomUUID();
    setCreatedWsId(wsId);
    // Clean up any prior unlisteners from a previous (errored) submission
    // before registering new ones.
    for (const u of unlistenRef.current) u();
    unlistenRef.current = [];
    const uOut = await listen<{ line: string }>(`setup-output://${wsId}`, ev => {
      setSetupLog(log => [...log, ev.payload.line]);
    });
    const uDone = await listen<{ code: number | null; success: boolean }>(`setup-done://${wsId}`, ev => {
      if (ev.payload.success) {
        setPhase("done");
        window.setTimeout(() => { setActive(wsId); close(); }, 2000);
      } else {
        setPhase("error");
        setErr(`Setup script exited with code ${ev.payload.code ?? "?"}.`);
      }
    });
    unlistenRef.current = [uOut, uDone];
    try {
      // Snap textareas → string[]. Done at submit so blank lines
      // during typing don't roundtrip through the array state.
      const splitLines = (s: string) =>
        s.split("\n").map(l => l.trim()).filter(Boolean);
      if (isMulti) {
        await workspaceCreateMulti({
          id: wsId,
          project_id: projectId,
          name: name.trim(),
          cli,
          base_branch: base.trim() || undefined,
          branch: branch.trim(),
          members: members.map(m => ({
            project_id: m.project_id,
            mode: m.mode,
            // Worktree mode: blank branch falls back to the workspace's
            // top-level branch on the Rust side. base falls back to
            // the member project's own base. RepoRoot mode ignores both.
            branch: m.mode === "worktree" ? (m.branch.trim() || undefined) : undefined,
            base_branch: m.mode === "worktree" ? (m.base_branch.trim() || undefined) : undefined,
          })),
          sandbox_enabled: sandbox,
          sandbox_rw_paths:       sandbox ? splitLines(sbRw)    : undefined,
          sandbox_allowed_hosts:  sandbox ? splitLines(sbHosts) : undefined,
        });
      } else {
        await workspaceCreate({
          id: wsId,
          project_id: projectId,
          name: name.trim(),
          cli,
          base_branch: base.trim() || null,
          branch: branch.trim(),
          sandbox_enabled: sandbox,
          // Only send lists when sandbox is on - keeps the JSON tidy
          // for unsandboxed workspaces (they don't need these saved).
          sandbox_rw_paths:       sandbox ? splitLines(sbRw)    : undefined,
          sandbox_allowed_hosts:  sandbox ? splitLines(sbHosts) : undefined,
        });
      }
      await loadAll();
      setPhase("setup");
    } catch (e) {
      setErr(String(e)); setBusy(false); setPhase("error");
      submittingRef.current = false;
    }
    // On success, submittingRef stays true until the dialog closes — guards
    // against any re-submit during the streaming-setup phase.
  }

  return (
    <AppDialog
      // Lock dialog while creating — clicking outside or Escape would leave
      // the user staring at no feedback while the worktree/file-copy chugs
      // for several seconds on big repos.
      open={!!projectId}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title={isMulti ? "New multi-repo workspace" : "New worktree"}
      description={project ? `in ${project.name}` : undefined}
      // Widen the dialog based on what's actually inside:
      //   - sandbox ON     → 4xl (the sandbox form needs a 2nd column)
      //   - multi-repo     → 3xl (per-member row = name + Worktree/Repo
      //                      toggle + branch input — max-w-md overflows)
      //   - plain worktree → md (anything wider looks empty)
      className={sandbox ? "max-w-4xl" : isMulti ? "max-w-3xl" : "max-w-md"}
    >
      {/* Phase-aware body: form on start, then progress view while creating
          + running setup. Form stays unmounted in non-form phases so its
          state doesn't fight the progress UI. */}
      {phase !== "form" && (
        <ProgressBody
          phase={phase}
          err={err}
          setupLog={setupLog}
          outputRef={outputRef}
          onClose={() => { if (!busy || phase === "error") { setPhase("form"); setBusy(false); close(); } }}
        />
      )}
      {phase === "form" && (
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className={cn(
          "gap-5",
          sandbox ? "grid grid-cols-2 gap-x-6" : "flex flex-col",
        )}
      >
      <div className="flex flex-col gap-5">
        {/* Every field uses the same structure: label on its own line, optional
            hint underneath, control on a new line. Previous version inlined
            the segmented controls next to the label and put hints on the same
            line as the label — both caused the spacing weirdness + wrapped
            hint text. */}
        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="fix login bug" autoFocus required />
        </Field>

        <Field label="CLI">
          {/* Pulled from the editable agent registry (Settings → Agent
              CLIs), not hard-coded — custom agents show up here. Disabled
              and not-installed agents are filtered out (see cliChoices). */}
          <div className="inline-flex flex-wrap items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
            {cliChoices.map(a => (
              <button
                key={a.id} type="button" onClick={() => setCli(a.id)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors",
                  cli === a.id
                    ? "bg-[var(--color-accent-deep)] text-white"
                    : cn("text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]", CLI_BRAND_COLOR[a.id]),
                )}
                style={cli === a.id ? undefined : (a.color ? { color: a.color } : undefined)}
              >
                <CliIcon cli={a.id} className="h-3.5 w-3.5" />{a.display_name}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Branch prefix">
          <div className="inline-flex items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
            {PREFIXES.map(pf => (
              <button
                key={pf} type="button"
                onClick={() => { setPrefix(pf); if (pf === "__custom__") setBranchEdited(true); else setBranchEdited(false); }}
                className={cn(
                  "flex h-7 items-center rounded-[5px] px-2.5 text-[12.5px] transition-colors",
                  prefix === pf ? "bg-[var(--color-accent-deep)] text-white" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                )}
              >{pf === "__custom__" ? "custom" : `${pf}/`}</button>
            ))}
          </div>
        </Field>

        {/* Branch name is derived from the name + prefix and locked
            read-only — there's no ambiguity to resolve. Picking the
            "custom" prefix is the explicit opt-in to type a full
            branch name yourself. */}
        <Field
          label="Branch name"
          hint={prefix === "__custom__"
            ? "Type the full branch name."
            : "Auto-generated from the name + prefix — pick “custom” to edit it."}
        >
          <Input
            value={branch}
            onChange={e => { setBranch(e.target.value); setBranchEdited(true); }}
            placeholder="feature/fix-login-bug"
            required
            readOnly={prefix !== "__custom__"}
            className={cn(prefix !== "__custom__" && "cursor-default text-[var(--color-fg-dim)]")}
          />
        </Field>

        <Field label={isMulti ? "Host branch from" : "Branch from"} hint={isMulti ? "Blank = host repo default. Members fall back to their own defaults below." : "Blank = repo default."}>
          <Input value={base} onChange={e => setBase(e.target.value)} placeholder="origin/master" />
        </Field>

        {/* Multi-repo: per-member mode + branch picker. Each member
            row renders a small toggle (Worktree | Repo root) and, when
            in Worktree mode, a branch + base override. RepoRoot mode
            collapses to a single warning line. */}
        {isMulti && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-[13px] font-medium text-[var(--color-fg)]">
                Members ({members.length})
              </label>
              <span className="text-[11.5px] text-[var(--color-fg-faint)]">
                Per-repo mode + branch
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {members.map((m, idx) => {
                const proj = useApp.getState().projects.find(p => p.id === m.project_id);
                if (!proj) return null;
                const update = (patch: Partial<MemberSpec>) =>
                  setMembers(prev => prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                return (
                  <div
                    key={m.project_id}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-[var(--color-fg)]">{proj.name}</div>
                        <div className="truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{proj.root_path}</div>
                      </div>
                      <div className="inline-flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg-1)] p-[2px] text-[11.5px]">
                        <button
                          type="button"
                          onClick={() => update({ mode: "worktree" })}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-[4px] px-2 transition-colors",
                            m.mode === "worktree"
                              ? "bg-[var(--color-accent-deep)] text-white"
                              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                          )}
                        >
                          <GitBranch className="h-3 w-3" /> Worktree
                        </button>
                        <button
                          type="button"
                          onClick={() => update({ mode: "repo_root" })}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-[4px] px-2 transition-colors",
                            m.mode === "repo_root"
                              ? "bg-[var(--color-warn)] text-black"
                              : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                          )}
                        >
                          <Link2 className="h-3 w-3" /> Repo root
                        </button>
                      </div>
                    </div>
                    {m.mode === "worktree" ? (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Input
                          value={m.branch}
                          onChange={e => update({ branch: e.target.value })}
                          placeholder={branch || "(same as host branch)"}
                        />
                        <Input
                          value={m.base_branch}
                          onChange={e => update({ base_branch: e.target.value })}
                          placeholder={proj.base_branch || "branch from…"}
                        />
                      </div>
                    ) : (
                      <div className="mt-2 text-[11.5px] text-[var(--color-warn)]">
                        Live symlink — agent edits land directly on your real checkout.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {members.some(m => m.mode === "repo_root") && (
              <div className="rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2 text-[12px] text-[var(--color-warn)]">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                One or more members are linked to live checkouts. The agent
                can directly modify those repos — no worktree isolation.
              </div>
            )}
          </div>
        )}

        {/* Sandbox panel - same shape as the Edit Sandbox dialog so
            users see one consistent control. Clickable whole-panel
            toggle. Label stays "Enable sandbox" - the state reads
            from the color band + Shield fill + status text, not from
            a verb flip on the button. Pinned at creation - lists
            below freeze onto the workspace and can't be edited after
            (archive + recreate to change). */}
        <button
          type="button"
          onClick={() => setSandbox(!sandbox)}
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
            sandbox
              ? "border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 hover:bg-[var(--color-ok)]/15"
              : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
          )}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Shield
              className={cn("h-4 w-4 shrink-0", sandbox ? "text-[var(--color-ok)]" : "text-[var(--color-fg-faint)]")}
              fill={sandbox ? "currentColor" : "none"}
            />
            <div className="flex flex-col min-w-0">
              <span className="text-[13.5px] font-medium text-[var(--color-fg)]">Enable sandbox</span>
              <span className="text-[12px] text-[var(--color-fg-dim)] truncate">
                {sandbox
                  ? "Agent runs caged + traffic through allowlist proxy. Pinned at creation."
                  : "Restrict filesystem + network. Pinned at creation."}
              </span>
            </div>
          </div>
          <Checkbox checked={sandbox} onChange={setSandbox} />
        </button>
      </div>

      {/* Right column: sandbox config form, only when enabled.
          Otherwise the form is single-column and this branch renders
          nothing. */}
      {sandbox && (
        <div className="flex flex-col gap-3 border-l border-[var(--color-border-soft)] pl-6">
          <div className="text-[11.5px] uppercase tracking-[0.1em] text-[var(--color-fg-faint)]">
            Sandbox config for this workspace
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-[var(--color-fg-faint)]">Preset:</span>
            {SANDBOX_PRESETS.map(p => (
              <button
                key={p.id} type="button"
                title={p.hint}
                onClick={() => {
                  setSbRw(p.rwPaths.join("\n"));
                  setSbHosts(p.allowedHosts.join("\n"));
                }}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[12px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
              >
                {p.label}
              </button>
            ))}
          </div>
          <Field label="Allowed paths" hint="One per line. Workspace + agent state + caches + TMPDIR are always allowed. Add extras here.">
            <textarea
              value={sbRw}
              onChange={e => setSbRw(e.target.value)}
              rows={3}
              placeholder={"$HOME/Work/other-project\n$HOME/Notes"}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
          </Field>
          <Field label="Allowed hosts" hint="One per line. Use * as a wildcard. Per-CLI vendor + github + npm/pypi/crates are always allowed; these are extras.">
            <textarea
              value={sbHosts}
              onChange={e => setSbHosts(e.target.value)}
              rows={3}
              placeholder={"*.mycompany.com\nbitbucket.org"}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
            />
          </Field>
        </div>
      )}

      {/* Error + actions row spans both columns when sandbox is on. */}
      <div className={cn(sandbox && "col-span-2")}>
        {err && <p className="mb-2 text-[13.5px] text-[var(--color-err)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim() || !branch.trim()}>Create</Button>
        </div>
      </div>
      </form>
      )}
    </AppDialog>
  );
}

/** Progress view shown while creating a workspace. Three sub-states:
 *  - creating: worktree + file-copy in flight (workspace_create has not yet returned)
 *  - setup: setup script running; stream stdout/stderr line by line
 *  - done: success flash, dialog auto-closes 2s later
 *  - error: surfaces the failure + lets the user dismiss and try again
 */
function ProgressBody({ phase, err, setupLog, outputRef, onClose }: {
  phase: "creating" | "setup" | "done" | "error";
  err: string | null;
  setupLog: string[];
  outputRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const status =
    phase === "creating" ? { icon: <Loader2 className="h-5 w-5 animate-spin" />, label: "Creating worktree & copying files…" } :
    phase === "setup"    ? { icon: <Loader2 className="h-5 w-5 animate-spin" />, label: "Running setup script…" } :
    phase === "done"     ? { icon: <Check className="h-5 w-5" />, label: "Done." } :
                           { icon: <AlertTriangle className="h-5 w-5" />, label: "Setup failed." };
  const tone =
    phase === "done"  ? "text-[var(--color-ok)]" :
    phase === "error" ? "text-[var(--color-err)]" :
                        "text-[var(--color-fg-dim)]";
  return (
    // min-w-0 is required because the parent is a CSS grid (`Dialog.Content`
    // uses `grid`) — grid items default to `min-width: auto` which means
    // their column refuses to shrink below the intrinsic width of their
    // content. Long monospace lines (pip dep dumps, etc.) then push the
    // whole dialog wider than `max-w-md`. min-w-0 lets the column hit zero
    // and our inner `overflow-auto` actually clip + scroll.
    <div className="flex min-w-0 flex-col gap-3">
      <div className={cn("flex items-center gap-2 text-[13px] font-medium", tone)}>
        {status.icon}
        <span>{status.label}</span>
      </div>
      {(phase === "setup" || phase === "done" || (phase === "error" && setupLog.length > 0)) && (
        <div
          ref={outputRef}
          data-selectable
          // max-w-full + overflow-x-hidden belt-and-braces against any single
          // unbreakable token (urls, base64, long hashes) that `break-words`
          // can't split — those would otherwise stretch the box past the
          // dialog edge again.
          className="h-[220px] max-w-full overflow-auto overflow-x-hidden rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-2.5 font-mono text-[11.5px] leading-snug text-[var(--color-fg-dim)]"
        >
          {setupLog.length === 0
            ? <span className="text-[var(--color-fg-faint)]">Waiting for output…</span>
            : setupLog.map((line, i) => <div key={i} className="whitespace-pre-wrap break-words">{line}</div>)
          }
        </div>
      )}
      {phase === "error" && err && (
        <p className="text-[12.5px] text-[var(--color-err)]">{err}</p>
      )}
      {(phase === "error" || phase === "done") && (
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            {phase === "done" ? "Open now" : "Close"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Form field layout: label / optional hint / control, each on its own line.
 *  Keeps spacing consistent and prevents hint text from wrapping next to the
 *  label (which produced the previous "Branch name (auto-generated from
 *  name; edit to..." 2-line mess). */
function Field({ label, hint, children }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium text-[var(--color-fg)]">{label}</label>
      {hint && <div className="text-[12px] text-[var(--color-fg-faint)] -mt-1">{hint}</div>}
      {children}
    </div>
  );
}

// Per-member script editor moved to NewProjectDialog / RepositorySection
// — scripts are project-scoped, not workspace-scoped.
