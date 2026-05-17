// New workspace dialog: name + CLI segmented pills + branch prefix pills +
// branch name + branch-from. Calls workspace_create on submit.

import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { workspaceCreate } from "@/lib/ipc";
import { slugify, cn } from "@/lib/utils";
import { Check, Loader2, AlertTriangle } from "lucide-react";

const CLIS = ["claude", "gemini", "codex"] as const;
const PREFIXES = ["feature", "hotfix", "__custom__"] as const;

export function NewWorkspaceDialog() {
  const projectId = useUI(s => s.newWorkspaceProjectId);
  const close = useUI(s => s.closeNewWorkspace);
  const project = useApp(s => projectId ? s.projects.find(p => p.id === projectId) : null);
  const setActive = useApp(s => s.setActiveWorkspace);
  const loadAll = useApp(s => s.loadAll);
  const agents = useApp(s => s.agents);

  const [name, setName] = useState("");
  const [cli, setCli] = useState<string>("claude");
  const [prefix, setPrefix] = useState<typeof PREFIXES[number]>("feature");
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [base, setBase] = useState("");
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
      await workspaceCreate({
        id: wsId,
        project_id: projectId,
        name: name.trim(),
        cli,
        base_branch: base.trim() || null,
        branch: branch.trim(),
      });
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
      title="New worktree"
      description={project ? `in ${project.name}` : undefined}
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
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-5">
        {/* Every field uses the same structure: label on its own line, optional
            hint underneath, control on a new line. Previous version inlined
            the segmented controls next to the label and put hints on the same
            line as the label — both caused the spacing weirdness + wrapped
            hint text. */}
        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Montreal" autoFocus required />
        </Field>

        <Field label="CLI">
          {/* Pulled from the editable agent registry (Settings → Agents),
              not hard-coded — custom agents the user added show up here
              alongside the three built-ins. Falls back to the built-in
              list if the registry hasn't loaded yet. */}
          <div className="inline-flex flex-wrap items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
            {(agents.length ? agents : CLIS.map(id => ({ id, display_name: id, color: "" } as any))).map(a => (
              <button
                key={a.id} type="button" onClick={() => setCli(a.id)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors",
                  cli === a.id
                    ? "bg-[var(--color-accent)] text-white"
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
                  prefix === pf ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                )}
              >{pf === "__custom__" ? "custom" : `${pf}/`}</button>
            ))}
          </div>
        </Field>

        <Field label="Branch name" hint="Auto-generated from name; edit to override.">
          <Input value={branch} onChange={e => { setBranch(e.target.value); setBranchEdited(true); }} placeholder="feature/montreal" required />
        </Field>

        <Field label="Branch from" hint="Blank = repo default.">
          <Input value={base} onChange={e => setBase(e.target.value)} placeholder="origin/master" />
        </Field>

        {err && <p className="text-[13.5px] text-[var(--color-err)]">{err}</p>}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim() || !branch.trim()}>Create</Button>
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
