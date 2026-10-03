import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitPullRequest, GitBranch, GitMerge, Wrench, RefreshCw, ChevronDown, ChevronRight, MoreHorizontal, MessageSquare, ArrowUpRight, CircleCheck, CircleX, CircleHelp, Clock, CircleMinus, ShieldAlert, Sparkles, X, SquareTerminal, Copy } from "lucide-react";
import { ChecksChip, ReviewChip, PR_STATE } from "./PrCard";
import { Spinner } from "@/components/ui/Spinner";
import { Tip } from "@/components/ui/Tooltip";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem } from "@/components/ui/Dropdown";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePr } from "@/store/pr";
import { useDelivery } from "@/store/delivery";
import { agentTargets, pickAgentTarget } from "@/lib/sendComments";
import { agentDisplayName, isTerminalCli } from "@/lib/agents";
import { forgeName, prRef } from "@/lib/forge";
import { deliveryPrompt, repositoryLookup } from "@/lib/delivery";
import { sendDeliveryMessage, deliveryInflight } from "@/lib/deliverySend";
import { focusTerminalTab } from "@/lib/tabFocus";
import { i18n } from "@/lib/i18n";
import * as ipc from "@/lib/ipc";
import { Input } from "@/components/ui/Input";
import type { Task, DeliveryRepo, DeliveryDetails, DeliveryPrInput, DeliveryRequest, DeliveryDraft, QueueItem, ReviewThread, TerminalTab, UpdateMode, CiNode } from "@/lib/types";

const textProps = { spellCheck: false, autoCorrect: "off", autoCapitalize: "off", autoComplete: "off" };
// Same border/focus tokens as ui/Input, sized down a step for panel density.
const field = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[12.5px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-accent)]";
const fieldLabel = "flex flex-col gap-1.5 text-[11.5px] font-medium text-[var(--color-fg-dim)]";
const alertCls = "break-words text-[11.5px] text-[var(--color-err)]";
const action = "inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-40";
const noRepos: DeliveryRepo[] = [];
const KIND: Record<string, { icon: typeof MessageSquare; color: string; label: string }> = {
  fix: { icon: Wrench, color: "var(--color-palette-orange)", label: "delivery.actions.fix" },
  replies: { icon: MessageSquare, color: "var(--color-palette-blue)", label: "delivery.actions.replies" },
  prs: { icon: GitPullRequest, color: "var(--color-palette-purple)", label: "delivery.actions.prs" },
  conflicts: { icon: GitMerge, color: "var(--color-warn)", label: "delivery.actions.conflicts" },
};
const STATUS_COLOR: Record<string, string> = {
  prepared: "var(--color-fg-faint)", queued: "var(--color-accent)", sent: "var(--color-accent)",
  drafted: "var(--color-ok)", posted: "var(--color-ok)",
  uncertain: "var(--color-warn)", retry_ready: "var(--color-warn)", failed: "var(--color-err)",
  draft: "var(--color-fg-faint)", posting: "var(--color-accent)",
};
type EvidencePool = { repo: DeliveryRepo; detail: DeliveryDetails; threads: ReviewThread[]; ci: CiNode[] };
type Preview = { request: DeliveryRequest; text: string; generated: string; target: string; purpose: string; pools: Record<string, EvidencePool>; chosen: Set<string> };
const NEW_AGENT = "__new__";
/** Spawn a fresh agent tab for a handoff when the task has none running —
 *  resolves once its PTY is up so the queue/send path can bind to it.
 *  Runs the task's configured agent (`task.cli`); terminal-kind clis
 *  (shell/custom) are filtered out by newAgentOk before this is reachable. */
async function spawnAgentTab(task: Task, title: string, focus: boolean): Promise<TerminalTab> {
  const s = useApp.getState();
  const cli = task.cli || task.persisted_tabs?.find(pt => pt.is_default)?.cli || "claude";
  const id = crypto.randomUUID();
  s.addTab(task.id, { id, type: "terminal", title: `${agentDisplayName(cli)} · ${title}`, cli,
    unattended: true } as TerminalTab, { focus });
  // A Docker-mode first launch can spend a minute rebuilding the image —
  // poll while the tab exists; a gone tab means the spawn failed or the
  // user closed it.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const tab = useApp.getState().tabs[task.id]?.find(t => t.id === id);
    if (!tab) throw new Error(i18n.t("panels:delivery.agentChanged"));
    if (tab.type === "terminal" && tab.ptyId) return tab;
    // A spawn that already failed would otherwise sit here until the full
    // deadline — TerminalPane records it on the tab.
    if (tab.type === "terminal" && tab.spawnError) throw new Error(tab.spawnError);
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(i18n.t("panels:delivery.agentStarting"));
}

export function DeliveryPanel({ task }: { task: Task }) {
  const { t } = useTranslation("panels");
  const entry = useDelivery(s => s.byTask[task.id]);
  const pr = usePr(s => s.byTask[task.id]);
  // Re-render when the fields agentTargets()/pickAgentTarget() read change —
  // extend the string if those selectors start using more of the tab.
  useApp(s => (s.tabs[task.id] ?? []).map(tab => tab.type === "terminal" ? [tab.id, tab.ptyId, tab.title, tab.cli, tab.runTab, tab.is_default, tab.liveTitle, tab.customTitle, tab.workState].join(":") : "").join("|"));
  useApp(s => s.agents);
  const repos = entry?.repos ?? noRepos;
  const [expanded, setExpanded] = useState<string[]>([]);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [prInputs, setPrInputs] = useState<DeliveryPrInput[] | null>(null);
  // The update dialog's scope is fixed when it opens — repos come from the
  // control that launched it (per-repo menu or the all-repos action).
  const [update, setUpdate] = useState<{ mode: UpdateMode; repos: DeliveryRepo[] } | null>(null);
  const targets = agentTargets(task.id);
  // A task whose cli resolves to terminal-kind (shell/custom) can never host
  // an agent — don't offer a spawn that sendDeliveryMessage can't address.
  const newAgentOk = !isTerminalCli(task.cli || task.persisted_tabs?.find(pt => pt.is_default)?.cli || "claude", useApp.getState().agents);
  const identityRepos = repos.filter(r => r.identity);
  // Split a `${dir}:${kind}:${id}` evidence key: match the LONGEST repo
  // prefix — dir names may contain ':' on unix, so overlapping prefixes
  // ("a", "a:b") must resolve to "a:b", not the first-listed "a".
  const parseKey = (k: string) => {
    const repo = repos.filter(r => k.startsWith(r.dir_name + ":")).sort((a, b) => b.dir_name.length - a.dir_name.length)[0];
    return repo ? { repo, rest: k.slice(repo.dir_name.length + 1) } : null;
  };
  /** Owning repo dir_name for an evidence key — use this instead of
   *  `k.startsWith(dir + ":")`, which mis-assigns keys when one dir_name
   *  prefixes another ("a" vs "a:b"). */
  const keyRepo = (k: string) => parseKey(k)?.repo.dir_name;
  // Durable 'queued' requests need a live queue item to ever send; queue
  // entries die with the app, so a restart leaves zombies. Two consecutive
  // refreshes without the item marks it failed (send() writes the status a
  // beat before the queue item, so one sighting is not proof) — and the
  // fail-write re-reads the request first: a stale snapshot must not flip a
  // request the drain just marked 'sent'.
  const orphanQueued = useRef<Set<string>>(new Set());
  // Overlapping refreshes (interval + button + post-action) would each count
  // an orphan miss against the same store snapshot — serialize them.
  const refreshing = useRef<Promise<void> | null>(null);
  const refresh = (force = false) => refreshing.current ??= (async () => {
    // IPC errors surface through the store's entry.error — don't also let
    // them become unhandled rejections in every `void refresh()` caller.
    try {
      await Promise.all([useDelivery.getState().refresh(task.id), usePr.getState().refresh(task.id, force)]);
      const reqs = useDelivery.getState().byTask[task.id]?.requests ?? [];
      const live = new Set((useApp.getState().tabs[task.id] ?? [])
        .flatMap(tab => tab.type === "terminal" ? (tab.queue ?? []).map(q => q.delivery?.requestId ?? "") : []).filter(Boolean));
      let stale = false;
      for (const r of reqs) {
        if (r.status !== "queued" || live.has(r.id)) { orphanQueued.current.delete(r.id); continue; }
        // A send-now in flight holds the request at 'queued' with no queue
        // item — that's a slow provider check, not an orphan.
        if (deliveryInflight(r.id)) continue;
        if (!orphanQueued.current.has(r.id)) { orphanQueued.current.add(r.id); continue; }
        const current = (await ipc.taskDeliveryRequests(task.id)).find(x => x.id === r.id)?.status;
        orphanQueued.current.delete(r.id);
        if (current !== "queued") continue;
        stale = true;
        await ipc.taskDeliveryRequestStatus(task.id, r.id, "failed", "Queue was cleared").catch(() => {});
      }
      if (stale) await useDelivery.getState().refresh(task.id);
    } finally {
      refreshing.current = null;
    }
  })().catch(() => {});
  // Poll faster while a sent request is still waiting on its report — the
  // agent usually lands it within seconds and the card shouldn't sit on the
  // minute cadence. 'uncertain' too: its send may have landed.
  const awaitingReport = !!entry?.requests.some(r => (r.status === "sent" || r.status === "uncertain") && !r.error);
  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), awaitingReport ? 10_000 : 60_000);
    return () => window.clearInterval(timer);
    // Only the mounted Delivery panel polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, awaitingReport]);
  const same = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  // Details are pruned on refresh when an identity changes; log excerpts and
  // expansion that reference them must go too or they'd act on data the
  // store already discarded.
  useEffect(() => {
    const live = Object.keys(entry?.details ?? {});
    // Keys are `${dir}:${kind}:${id}`; dir names may contain ':', so the
    // owning repo resolves by longest prefix, not first-prefix match.
    const alive = (k: string) => { const dir = keyRepo(k); return dir !== undefined && live.includes(dir); };
    setLogs(prev => {
      const next = Object.fromEntries(Object.entries(prev).filter(([k]) => alive(k)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setExpanded(prev => { const next = prev.filter(dir => live.includes(dir)); return same(prev, next) ? prev : next; });
  }, [entry?.details]);

  const toggle = (values: string[], key: string) => values.includes(key) ? values.filter(v => v !== key) : [...values, key];
  const busyRef = useRef(false);
  // Shared failure surface: the error paragraph lives at the top of a
  // scrollable panel — actions triggered deep in the details fail invisibly
  // without a toast. Dialogs render the same error inline, so skip the
  // toast while one is open.
  const attempt = async (work: () => Promise<void>) => {
    try { await work(); } catch (e) {
      const msg = String(e);
      setError(msg);
      if (!preview && !prInputs && !update) useUI.getState().pushToast(msg, "error");
    }
  };
  // busy is render-state: two activations before the first re-render would
  // both run (double-click → two durable 'prepared' requests). The ref is
  // the synchronous gate.
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError("");
    try { await attempt(work); } finally { busyRef.current = false; setBusy(false); }
  };
  // Read-only probes (details expand, log excerpt, per-repo refresh) keep
  // the panel usable: they disable only their own control and spin inline
  // instead of holding the panel-wide busy gate for a multi-second call.
  const [probing, setProbing] = useState<Set<string>>(new Set());
  const probe = async (key: string, work: () => Promise<void>) => {
    setProbing(s => new Set(s).add(key));
    try { await attempt(work); } finally { setProbing(s => { const n = new Set(s); n.delete(key); return n; }); }
  };
  const applied = useRef<Record<string, { title: string; body: string }>>({});
  const showPrs = (scope: DeliveryRepo[]) => {
    if (!scope.length) return;
    applied.current = {};
    setPrInputs(scope.map(r => {
      const proposed = entry?.requests.flatMap(q => q.prs).findLast(p => p.dir_name === r.dir_name);
      const title = proposed?.title ?? task.name, body = proposed?.body ?? "";
      applied.current[r.dir_name] = { title, body };
      return { identity: r.identity!, title, body, base: r.base, draft: true };
    }));
  };
  // A draft report that lands while the dialog is open fills only fields the
  // user has not touched since the last applied draft.
  useEffect(() => {
    if (!prInputs) return;
    const latest = new Map<string, { title: string; body: string }>();
    for (const req of entry?.requests ?? []) for (const p of req.prs) latest.set(p.dir_name, { title: p.title, body: p.body });
    setPrInputs(list => {
      if (!list) return list;
      let dirty = false;
      const next = list.map(inp => {
        const p = latest.get(inp.identity.dir_name);
        const ap = applied.current[inp.identity.dir_name];
        if (!p || !ap) return inp;
        // Fill only fields still equal to the last applied draft — a field the
        // user typed into keeps its value even when a newer report arrives.
        const patch: Partial<DeliveryPrInput> = {};
        if (inp.title === ap.title && inp.title !== p.title) patch.title = p.title;
        if (inp.body === ap.body && inp.body !== p.body) patch.body = p.body;
        if (patch.title === undefined && patch.body === undefined) return inp;
        dirty = true;
        applied.current[inp.identity.dir_name] = { title: patch.title ?? ap.title, body: patch.body ?? ap.body };
        return { ...inp, ...patch };
      });
      return dirty ? next : list;
    });
  }, [entry?.requests]); // eslint-disable-line react-hooks/exhaustive-deps
  const prepare = async (purpose: "fix" | "replies" | "prs" | "conflicts", scope: DeliveryRepo[], keys: string[] = []) => {
    const drafts: DeliveryDraft[] = [];
    const evidence: string[] = [];
    const scopeBits: string[] = [];
    const evidenceKeys: string[] = [];
    // Evidence pools ride along to the send dialog so its item picker can
    // re-scope drafts/keys/prompt without a fresh provider probe.
    const pools: Record<string, { repo: DeliveryRepo; detail: DeliveryDetails; threads: ReviewThread[]; ci: CiNode[] }> = {};
    let picked = 0;
    const scoped = scope.filter(repo => repo.identity && (purpose === "prs" || purpose === "conflicts" || keys.some(k => keyRepo(k) === repo.dir_name))).map(repo => {
      const detail = entry?.details[repo.dir_name];
      if (purpose === "prs" || purpose === "conflicts") scopeBits.push(repo.name);
      if (purpose === "prs") return repo;
      if (purpose === "conflicts") {
        // A repo can hold both an update row and a pr_create row — the
        // conflict evidence lives on the update one, so discriminate on
        // `result`, not just the directory.
        const outcome = entry?.results.find(r => r.dir_name === repo.dir_name && (r.result?.conflicted || r.result?.stash_conflicted));
        if (!outcome) throw new Error(t("delivery.noConflict"));
        evidence.push(JSON.stringify(outcome));
        return repo;
      }
      if (!detail) throw new Error(t("delivery.loadFirst"));
      const repoKeys = keys.filter(k => keyRepo(k) === repo.dir_name).map(k => parseKey(k)!.rest);
      if (detail.ci_error && repoKeys.some(rest => rest.startsWith("ci:"))) throw new Error(detail.ci_error);
      if (detail.threads_error && repoKeys.some(rest => rest.startsWith("review:"))) throw new Error(detail.threads_error);
      // Fixable evidence is a failed CI node or an unresolved thread; replies
      // may target any thread and keep selected CI as prompt context.
      const threads = detail.threads.filter(thread => keys.includes(repo.dir_name + ":review:" + thread.id) && (purpose !== "fix" || thread.resolved !== true));
      const ci = detail.ci.filter(node => keys.includes(repo.dir_name + ":ci:" + node.id) && (purpose !== "fix" || node.status === "failed"));
      picked += threads.length + ci.length;
      pools[repo.dir_name] = { repo, detail, threads, ci };
      evidenceKeys.push(...ci.map(n => repo.dir_name + ":ci:" + n.id), ...threads.map(th => repo.dir_name + ":review:" + th.id));
      const names = [...ci.map(n => n.name), ...threads.map(th => th.path ? `${th.path}${th.line ? ":" + th.line : ""}` : t("delivery.discussion"))];
      if (names.length) scopeBits.push(`${repo.name}: ${names.join(", ")}`);
      evidence.push(evidenceBlob(repo, detail, threads, ci));
      // Fix prompts ask the agent to propose replies for the thread keys it
      // touched — register the drafts so import doesn't reject them as
      // unrequested.
      if (purpose === "replies" || purpose === "fix") for (const thread of threads) drafts.push(replyDraft(repo.dir_name, detail, thread));
      return { ...repo, identity: { ...repo.identity!, pr_number: detail.pr.number, pr_revision: detail.revision } };
    });
    if ((purpose === "fix" && !picked) || (purpose === "replies" && !drafts.length)) throw new Error(t("delivery.selectEvidence"));
    const request = await ipc.taskDeliveryRequest(task.id, scoped.map(r => r.identity!), drafts, purpose, scopeBits.join(" · "), evidenceKeys);
    const text = deliveryPrompt(scoped, evidence.join("\n\n") + "\nRequested draft keys: " + drafts.map(d => d.key).join(", "),
      request.report, t(`delivery.purpose.${purpose}`));
    if (preview) retirePrepared(preview.request.id); // replaced preview: retire its request too
    setPreview({ request, text, generated: text, purpose, target: pickAgentTarget(task.id)?.id ?? (newAgentOk ? NEW_AGENT : ""), pools, chosen: new Set(evidenceKeys) });
    await useDelivery.getState().refresh(task.id);
  };
  const evidenceBlob = (repo: DeliveryRepo, detail: DeliveryDetails, threads: ReviewThread[], ci: CiNode[]) =>
    JSON.stringify({ repository: repo.name, provider: detail.pr.provider, pr: detail.pr.url, revision: detail.revision, threads, ci,
      logs: ci.map(n => ({ id: n.id, excerpt: logs[repo.dir_name + ":ci:" + n.id] ?? null })) });
  const replyDraft = (dir: string, detail: DeliveryDetails, thread: ReviewThread): DeliveryDraft => ({ key: dir + ":review:" + thread.id, dir_name: dir, pr_number: detail.pr.number,
    thread_id: thread.id, reply_id: thread.reply_id, body: "", status: "draft", error: null });
  /** Send-dialog item picker: toggle one evidence key, re-derive drafts,
   *  scope and prompt, and rewrite the still-prepared request to match. */
  const retune = async (key: string) => {
    const p = preview;
    if (!p || !Object.keys(p.pools).length) return;
    const chosenKeys = new Set(p.chosen);
    if (chosenKeys.has(key)) chosenKeys.delete(key); else chosenKeys.add(key);
    const evidence: string[] = [];
    const drafts: DeliveryDraft[] = [];
    const scopeBits: string[] = [];
    for (const [dir, pool] of Object.entries(p.pools)) {
      const threads = pool.threads.filter(th => chosenKeys.has(dir + ":review:" + th.id));
      const ci = pool.ci.filter(n => chosenKeys.has(dir + ":ci:" + n.id));
      if (!threads.length && !ci.length) continue;
      evidence.push(evidenceBlob(pool.repo, pool.detail, threads, ci));
      if (p.purpose === "replies" || p.purpose === "fix") for (const th of threads) drafts.push(replyDraft(dir, pool.detail, th));
      scopeBits.push(`${pool.repo.name}: ${[...ci.map(n => n.name), ...threads.map(th => th.path ? `${th.path}${th.line ? ":" + th.line : ""}` : t("delivery.discussion"))].join(", ")}`);
    }
    const amended = await ipc.taskDeliveryRequestAmend(task.id, p.request.id, drafts, [...chosenKeys], scopeBits.join(" · "));
    // A repo stripped of all its items leaves the prompt's authorized list —
    // the request keeps its identities (send re-validates them) but the text
    // must not claim a repository the evidence no longer covers.
    const covered = new Set([...chosenKeys].map(k => parseKey(k)?.repo.dir_name).filter((d): d is string => d !== undefined));
    const scoped = p.request.identities.filter(i => covered.has(i.dir_name)).map(i => p.pools[i.dir_name]?.repo).filter(Boolean) as DeliveryRepo[];
    const fresh = deliveryPrompt(scoped, evidence.join("\n\n") + "\nRequested draft keys: " + drafts.map(d => d.key).join(", "),
      amended.report, t(`delivery.purpose.${p.purpose}`));
    // Edited text wins over regeneration: toggling an item must not
    // silently discard what the user typed. The amend rotated the request
    // id, hence the report path — swap it inside edited text too or the
    // agent's report would land at a path nothing reads.
    setPreview({ ...p, request: amended, text: p.text === p.generated ? fresh : p.text.replaceAll(p.request.report, amended.report), generated: fresh, chosen: chosenKeys });
  };
  const send = async (queue: boolean) => {
    if (!preview) return;
    const target = preview.target === NEW_AGENT
      ? await spawnAgentTab(task, t(`delivery.actions.${preview.purpose}`, { defaultValue: preview.purpose }), !queue)
      : agentTargets(task.id).find(tab => tab.id === preview.target);
    if (!target?.ptyId) throw new Error(t("delivery.agentChanged"));
    if (preview.target === NEW_AGENT) setPreview(p => p ? { ...p, target: target.id } : p); // a retry reuses the spawned tab instead of stacking another
    const item: QueueItem = { id: crypto.randomUUID(), text: preview.text, repeat: 1, remaining: 1,
      delivery: { requestId: preview.request.id, identities: preview.request.identities, ptyId: target.ptyId } };
    await ipc.taskDeliveryValidate(task.id, preview.request.identities);
    if (queue) {
      // The mark must land on the still-prepared request: a dismiss or a
      // parallel send landing in the IPC window owns it now.
      const prev = await ipc.taskDeliveryRequestStatus(task.id, preview.request.id, "queued", null, target.id).then(p => p, () => null);
      if (prev !== "prepared") {
        // failed → queued is legal (stale-queue retry): if the mark just
        // resurrected a dismissed/failed request, put it back rather than
        // leaving an orphan the next refresh has to clean up.
        if (prev === "failed") await ipc.taskDeliveryRequestStatus(task.id, preview.request.id, "failed").catch(() => {});
        throw new Error(t("delivery.agentChanged"));
      }
      // Re-read AFTER the status write — a queue drain removing a sent item
      // (or a user edit) landing in the IPC window would otherwise be lost
      // or resurrected by patching from the pre-await snapshot.
      const current = agentTargets(task.id).find(tab => tab.id === target.id && tab.ptyId === target.ptyId);
      if (!current) throw new Error(t("delivery.agentChanged"));
      // A double-queue of the same request is one entry: the drain would
      // otherwise deliver it, see "sent", and still burn a send pass.
      const rest = (current.queue ?? []).filter(q => q.delivery?.requestId !== item.delivery!.requestId);
      useApp.getState().patchTab(task.id, target.id, { queue: [...rest, item], queueActive: true, queueKick: (current.queueKick ?? 0) + 1 });
      useUI.getState().pushToast(t("delivery.queued"));
    } else if (await sendDeliveryMessage(task.id, target.id, item)) {
      // Surface the agent the prompt landed in so the user can follow along.
      useApp.getState().setActiveTabId(task.id, target.id);
      focusTerminalTab(target.id);
    } else {
      await useDelivery.getState().refresh(task.id);
      return;
    }
    setPreview(null);
    await useDelivery.getState().refresh(task.id);
  };
  // Closing without sending retires the 'prepared' request — otherwise every
  // abandoned handoff leaks a durable row in delivery.json forever. Re-read
  // the status first: a request already sent/queued elsewhere must be left
  // alone.
  const retirePrepared = (requestId: string) => {
    void ipc.taskDeliveryRequests(task.id).then(list => {
      const cur = list.find(r => r.id === requestId);
      if (cur?.status === "prepared") return ipc.taskDeliveryRequestStatus(task.id, cur.id, "failed");
    }).then(() => useDelivery.getState().refresh(task.id)).catch(() => {});
    orphanQueued.current.delete(requestId);
  };
  // Unmount (tab/task switch, panel close) abandons the dialog without
  // running cancelPreview — retire its prepared request the same way.
  const previewRef = useRef<Preview | null>(null);
  previewRef.current = preview;
  useEffect(() => () => { const p = previewRef.current; if (p) retirePrepared(p.request.id); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.id]);
  const cancelPreview = () => {
    const p = preview;
    setPreview(null);
    if (p) retirePrepared(p.request.id);
  };
  const changePr = (i: number, patch: Partial<DeliveryPrInput>) => setPrInputs(list => list!.map((p, n) => n === i ? { ...p, ...patch } : p));
  const failed = repos.filter(repo => entry?.results.some(r => r.dir_name === repo.dir_name && (r.result?.conflicted || r.result?.stash_conflicted)));
  // 'prepared' lives in the send dialog; dismissed ('failed' with no error)
  // is hidden. Queued, in-flight, drafted, and wedged requests stay visible
  // so a send never silently disappears.
  const shown = entry?.requests.filter(r => r.status !== "prepared" && (r.status !== "failed" || r.error)) ?? [];
  return <section data-testid="delivery-panel" className="relative flex min-h-0 flex-1 flex-col overflow-auto text-xs">
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-2">
      <span className="min-w-0 flex-1 text-[12px] font-medium">{t("delivery.panelTitle")}</span>
      <Tip content={t("delivery.refresh")}><button aria-label={t("delivery.refresh")} className={action} disabled={busy || entry?.loading} onClick={() => void run(refresh)}>{busy || entry?.loading ? <Spinner size={13} /> : <RefreshCw className="h-3.5 w-3.5" />}</button></Tip>
      <DropdownRoot><DropdownTrigger asChild><button data-testid="delivery-actions" className={action} disabled={busy || !identityRepos.length}>{t("delivery.allRepos")}<ChevronDown className="h-3 w-3" /></button></DropdownTrigger>
        <DropdownMenu>
          <DropdownItem onSelect={() => showPrs(identityRepos)}><GitPullRequest className="h-4 w-4" />{t("delivery.createPrs")}</DropdownItem>
          <DropdownItem onSelect={() => setUpdate({ mode: "merge", repos: identityRepos })}><GitBranch className="h-4 w-4" />{t("delivery.update")}</DropdownItem>
        </DropdownMenu>
      </DropdownRoot>
    </div>
    <div className="space-y-3 p-3">
    {(error || entry?.error || pr?.error) && <p role="alert" className="text-[var(--color-err)]">{error || entry?.error || pr?.error}{(entry?.fetchedAt ?? 0) > 0 ? " " + t("delivery.stale") : ""}</p>}
    {entry?.loading && !entry.fetchedAt && <p>{t("shared.loading")}</p>}
    {repos.map(repo => {
      const detail = entry?.details[repo.dir_name];
      const sharedHost = !!task.is_main_checkout && !repo.dir_name;
      const lookup = sharedHost && detail ? { status: "ok", message: "", pr: detail.pr } : repositoryLookup(pr, repo.dir_name);
      const state = lookup?.pr ? PR_STATE[lookup.pr.state] : null;
      // Fixable evidence on this repo — leaf CI failures plus unresolved
      // threads. Feeds the card menu's "Fix all with agent" item and the
      // per-section bulk buttons below.
      const failedCi = detail?.ci.filter(n => n.status === "failed" && !detail.ci.some(other => other.parent === n.id)) ?? [];
      const unresolved = detail?.threads.filter(th => th.resolved !== true) ?? [];
      const fixableCount = failedCi.length + unresolved.length;
      return <article key={repo.dir_name} data-testid="delivery-repo" className="overflow-hidden rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] transition-colors">
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <strong className="min-w-0 flex-1 truncate text-[12px]" title={repo.name}>{repo.name}</strong>
            {repo.mode === "repo_root" && <span className="rounded bg-[var(--color-bg-3)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-faint)]">{t("delivery.sharedCheckout")}</span>}
            <DropdownRoot><DropdownTrigger asChild><button aria-label={t("delivery.repoActions", { name: repo.name })} className={action + " -mr-1.5 -my-1 px-1.5 py-0.5"} disabled={busy || !repo.identity}><MoreHorizontal className="h-3.5 w-3.5" /></button></DropdownTrigger>
              <DropdownMenu>
                <DropdownItem onSelect={() => showPrs([repo])}><GitPullRequest className="h-4 w-4" />{t("delivery.createPr")}</DropdownItem>
                <DropdownItem onSelect={() => setUpdate({ mode: "merge", repos: [repo] })}><GitBranch className="h-4 w-4" />{t("delivery.updateBranch")}</DropdownItem>
                {fixableCount > 1 && <DropdownItem onSelect={() => void run(() => prepare("fix", [repo],
                  [...failedCi.map(n => repo.dir_name + ":ci:" + n.id), ...unresolved.map(th => repo.dir_name + ":review:" + th.id)]))}>
                  <Wrench className="h-4 w-4" />{t("delivery.fixAllIssues", { count: fixableCount })}</DropdownItem>}
              </DropdownMenu>
            </DropdownRoot>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-faint)]" title={repo.identity ? `${repo.identity.branch} · ${repo.identity.path}` : undefined}>
            <GitBranch className="h-3 w-3 shrink-0" /><span className="min-w-0 truncate font-mono">{repo.identity?.branch || t("delivery.unknown")}</span>
            <span className="ml-auto shrink-0" style={{ color: repo.dirty ? "var(--color-warn)" : undefined }}>{repo.dirty ? t("delivery.uncommitted") : repo.changed ? t("delivery.branchChanges") : repo.changed === false ? t("delivery.clean") : t("delivery.unknown")}</span>
          </div>
          {lookup?.pr && state ? <>
            <div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1 text-[11px]" style={{ color: state.color }}><state.Icon className="h-3.5 w-3.5" />{t(state.labelKey)}</span><ChecksChip checks={lookup.pr.checks} /><ReviewChip review={lookup.pr.review} /></div>
            <button className="block w-full min-w-0 text-left text-[12px] leading-5 hover:underline" title={lookup.pr.url} onClick={() => void ipc.openPath(lookup.pr!.url)}>
              <span className="mr-1.5 text-[var(--color-fg-faint)]">{forgeName(lookup.pr.provider)} {prRef(lookup.pr.provider, lookup.pr.number)}</span>{lookup.pr.title}
            </button>
          </> : <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-fg-dim)]">{lookup?.message || t("delivery.noPr")}
            {repo.identity && <button className={action + " -my-1 py-0.5"} disabled={busy} onClick={() => showPrs([repo])}><GitPullRequest className="h-3 w-3" />{t("delivery.createPr")}</button>}</p>}
          {repo.error && <p role="alert" className="text-[var(--color-err)]">{repo.error}</p>}
        </div>
        <button data-testid="delivery-repo-details" aria-expanded={expanded.includes(repo.dir_name)} className="flex w-full items-center gap-1.5 border-t border-[var(--color-border-soft)] px-3 py-2 text-left text-[11px] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] disabled:opacity-40" disabled={busy || !repo.identity || probing.has("detail:" + repo.dir_name) || (!detail && !lookup?.pr && !sharedHost)} onClick={() => void probe("detail:" + repo.dir_name, async () => {
          if (expanded.includes(repo.dir_name)) { setExpanded(toggle(expanded, repo.dir_name)); return; }
          if (!detail) await useDelivery.getState().details(task.id, repo.identity!);
          setExpanded(toggle(expanded, repo.dir_name));
        })}>
          {expanded.includes(repo.dir_name) ? <ChevronDown className="h-3 w-3" /> : probing.has("detail:" + repo.dir_name) ? <Spinner size={12} /> : <ChevronRight className="h-3 w-3" />}
          {t("delivery.viewDetails")}
          {detail && <span className="ml-auto text-[var(--color-fg-faint)]">{t("delivery.detailCounts", { ci: detail.ci.filter(n => n.kind === "job" || n.kind === "check").length, threads: detail.threads.filter(t => t.resolved !== true).length })}</span>}
        </button>
        {detail && expanded.includes(repo.dir_name) && <div className="space-y-3 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-3">
          <div className="flex items-center gap-2 text-[10px] text-[var(--color-fg-faint)]"><span title={detail.revision}>{t("delivery.revision")}: <code>{detail.revision.slice(0, 8)}</code></span>
            {/* Re-probing this repo drops its detail record — prune only THIS
                repo's log excerpts; other repos' state stays. */}
            <Tip content={t("delivery.refresh")}><button className={action + " ml-auto p-1"} aria-label={t("delivery.refresh")} disabled={busy || probing.has("repo:" + repo.dir_name)} onClick={() => void probe("repo:" + repo.dir_name, async () => {
              await useDelivery.getState().details(task.id, repo.identity!);
              setLogs(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => keyRepo(k) !== repo.dir_name)));
            })}>{probing.has("repo:" + repo.dir_name) ? <Spinner size={12} /> : <RefreshCw className="h-3 w-3" />}</button></Tip>
          </div>
          {(entry.detailsAt[repo.dir_name] ?? 0) > 0 && Date.now() - entry.detailsAt[repo.dir_name] > 90_000 && <p role="status" className="text-[11px] text-[var(--color-warn)]">{t("delivery.staleEvidence")}</p>}
          <details open className="group"><summary className="cursor-pointer text-[11px] font-medium">{t("delivery.ciStatus")}{failedCi.length > 0 && <span className="ml-1.5 font-normal" style={{ color: "var(--color-err)" }}>· {t("delivery.failedCount", { count: failedCi.length })}</span>}</summary>
            {detail.ci_error && <p role="alert" className={alertCls}>{detail.ci_error}</p>}
            {!detail.ci.length && !detail.ci_error && <p className="text-[var(--color-fg-faint)]">{t("delivery.noCi")}</p>}
            {failedCi.length > 0 && <div className="mt-1 mb-1.5 flex justify-end"><button className={action + " py-0.5"} disabled={busy || !repo.identity} onClick={() => void run(() => prepare("fix", [repo], failedCi.map(n => repo.dir_name + ":ci:" + n.id)))}><Wrench className="h-3 w-3" />{t("delivery.fixAll", { count: failedCi.length })}</button></div>}
            <CiTree nodes={detail.ci} parent={null} seen={[]} render={node => {
              const key = repo.dir_name + ":ci:" + node.id;
              const failed = node.status === "failed";
              return <div className="w-full space-y-1"><div className="flex items-center gap-1"><div className="flex min-w-0 flex-1 items-center gap-1.5 py-1"><CiState status={node.status} /><span className="min-w-0 flex-1 break-words">{node.name}</span><span className="shrink-0 text-[10px] text-[var(--color-fg-faint)]">{t(`delivery.ciStates.${node.status}`, { defaultValue: node.status })}{node.duration != null ? " · " + Math.round(node.duration) + "s" : ""}</span></div>
                {failed && <button className={action + " p-1"} disabled={busy} title={t("delivery.fixCi")} aria-label={`${t("delivery.fixCi")}: ${node.name}`} onClick={() => void run(() => prepare("fix", [repo], [key]))}><Wrench className="h-3 w-3" /></button>}
                {node.url && <button className={action + " p-1"} aria-label={`${t("delivery.openProvider")}: ${node.name}`} title={node.url} onClick={() => void ipc.openPath(node.url)}><ArrowUpRight className="h-3 w-3" /></button>}</div>
                {node.log_id && failed && <button className={action + " ml-5 py-0.5"} disabled={busy || probing.has("log:" + key)} onClick={() => void probe("log:" + key, async () => {
                  const expected = { ...detail.identity, pr_number: detail.pr.number, pr_revision: detail.revision };
                  const excerpt = await ipc.taskDeliveryLog(task.id, expected, node.log_id!);
                  setLogs(s => ({ ...s, [key]: excerpt }));
                })}>{probing.has("log:" + key) ? <Spinner size={11} /> : null}{t("delivery.loadLog")}</button>}
                {logs[key] && <pre className="max-h-48 overflow-auto rounded bg-[var(--color-bg-2)] p-2 font-mono text-[10.5px] leading-4 whitespace-pre-wrap break-all">{logs[key]}</pre>}
              </div>;
            }} />
          </details>
          <details open><summary className="cursor-pointer text-[11px] font-medium">{t("delivery.reviewStatus")}{unresolved.length > 0 && <span className="ml-1.5 font-normal" style={{ color: "var(--color-palette-blue)" }}>· {t("delivery.unresolvedCount", { count: unresolved.length })}</span>}</summary>
            {detail.threads_error && <p role="alert" className={alertCls}>{detail.threads_error}</p>}
            {!detail.threads.length && !detail.threads_error && <p className="text-[var(--color-fg-faint)]">{t("delivery.noThreads")}</p>}
            {unresolved.length > 0 && <div className="mt-1 mb-1.5 flex justify-end gap-1.5">
              <button className={action + " py-0.5"} disabled={busy || !repo.identity} onClick={() => void run(() => prepare("replies", [repo], unresolved.map(th => repo.dir_name + ":review:" + th.id)))}><MessageSquare className="h-3 w-3" />{t("delivery.replyAll", { count: unresolved.length })}</button>
              <button className={action + " py-0.5"} disabled={busy || !repo.identity} onClick={() => void run(() => prepare("fix", [repo], unresolved.map(th => repo.dir_name + ":review:" + th.id)))}><Wrench className="h-3 w-3" />{t("delivery.addressAll", { count: unresolved.length })}</button>
            </div>}
            {detail.threads.map(thread => {
              const key = repo.dir_name + ":review:" + thread.id;
              return <div key={key} className={`my-2 space-y-2 rounded-md border border-[var(--color-border-soft)] p-2 ${thread.resolved === true ? "opacity-60" : ""}`}>
                <p className="text-[11px] font-medium">{thread.path ? `${thread.path}${thread.line ? ":" + thread.line : ""}` : t("delivery.discussion")}{thread.resolved === true ? " · " + t("delivery.resolved") : thread.resolved === false ? " · " + t("delivery.unresolved") : ""}</p>
                <div className="max-h-56 space-y-3 overflow-auto">{thread.comments.map(c => <div key={c.id}><p className="mb-1 text-[10.5px] font-medium text-[var(--color-fg-faint)]">{c.author}</p><p className="whitespace-pre-wrap break-words text-[11.5px] leading-5">{c.body}</p></div>)}</div>
                <div className="flex items-center gap-1">
                  <button className={action + " -ml-2 py-0.5"} onClick={() => void ipc.openPath(thread.url || detail.pr.url)}><ArrowUpRight className="h-3 w-3" />{t("delivery.openProvider")}</button>
                  <span className="ml-auto flex items-center gap-1">
                    <button className={action + " py-0.5"} disabled={busy || !repo.identity} onClick={() => void run(() => prepare("replies", [repo], [key]))}><MessageSquare className="h-3 w-3" />{t("delivery.replyThread")}</button>
                    {thread.resolved !== true && <button className={action + " py-0.5"} disabled={busy || !repo.identity} onClick={() => void run(() => prepare("fix", [repo], [key]))}><Wrench className="h-3 w-3" />{t("delivery.fixThread")}</button>}
                  </span>
                </div>
              </div>;
            })}
          </details>
        </div>}
      </article>;
    })}
    {!!entry?.results.length && <div data-testid="delivery-results" className="space-y-2">
      <div className="flex items-center gap-2"><strong className="flex-1">{t("delivery.results")}</strong>{failed.length > 0 && <button className={action} disabled={busy} onClick={() => void run(() => prepare("conflicts", failed))}><GitMerge className="h-3 w-3" />{t("delivery.actions.conflicts")}</button>}</div>
      {entry.results.map(result => {
        const Icon = result.error ? CircleX : result.result?.conflicted || result.result?.stash_conflicted ? ShieldAlert : CircleCheck;
        const color = result.error ? "var(--color-err)" : result.result?.conflicted || result.result?.stash_conflicted ? "var(--color-warn)" : "var(--color-ok)";
        return <p key={result.dir_name + ":" + (result.action ?? "")} role={result.error ? "alert" : undefined} className="flex items-start gap-1.5">
          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color }} />
          <span className={`min-w-0 flex-1 break-words ${result.error ? "text-[var(--color-err)]" : ""}`}><strong className="font-medium">{result.name}</strong>{result.action === "pr" ? " · " + t("delivery.createPrs") : result.action === "update" ? " · " + t("delivery.update") : ""} · {result.error || (result.result?.conflicted ? t("delivery.conflict") : result.result?.stash_conflicted ? t("delivery.stashConflict") : t("delivery.success"))}
            {result.result?.stashed && " · " + t("delivery.autostash")}
            {result.result?.target && " · " + result.result.target}
            {result.url && <button className="ml-1.5 underline" onClick={() => void ipc.openPath(result.url!)}>{t("delivery.openProvider")}</button>}
          </span>
        </p>;
      })}
    </div>}
    {entry && !entry.loading && !shown.length && !entry.results.length && <p className="rounded-md border border-dashed border-[var(--color-border-soft)] px-3 py-2.5 text-[11px] leading-5 text-[var(--color-fg-faint)]">{t("delivery.hint")}</p>}
    {!!shown.length && <div data-testid="delivery-requests" className="space-y-2">
      <strong>{t("delivery.requests")}</strong>
      {shown.map(request => {
        const kind = KIND[request.kind];
        const KindIcon = kind?.icon ?? CircleHelp;
        // Mirror import_report's completion rule: 'prs' waits for a PR
        // draft, 'replies' waits for all reply drafts, and any other kind
        // (fix/conflicts — reply drafts there are optional extras) waits
        // for ANY report.
        const waiting = request.status === "sent" && !request.error &&
          (request.kind === "prs" ? !request.prs.length
            : request.kind === "replies" ? request.drafts.some(d => !d.body)
            : true);
        // Every visible request is dismissable; active ones confirm first —
        // a dismissed request stops importing its report, so a still-running
        // agent's output would be discarded.
        const live = ["queued", "sent", "uncertain"].includes(request.status);
        // Requests saved before `scope` existed fall back to repo names.
        const scopeLabel = request.scope || request.identities.map(i => repos.find(r => r.dir_name === i.dir_name)?.name ?? i.dir_name).join(", ");
        return <div key={request.id} data-testid="delivery-request" className="space-y-2 rounded-lg border border-[var(--color-border-soft)] border-l-2 bg-[var(--color-bg-2)] p-2.5" style={{ borderLeftColor: `color-mix(in srgb, ${kind?.color ?? "var(--color-fg-faint)"} 60%, transparent)` }}>
          <div className="flex items-center gap-1.5">
            <KindIcon className="h-3.5 w-3.5 shrink-0 self-start mt-px" style={{ color: kind?.color ?? "var(--color-fg-faint)" }} />
            <div className="min-w-0 flex-1">
              <span className="text-[11.5px] font-medium">{kind ? t(kind.label) : request.kind}</span>
              {scopeLabel && <p className="truncate text-[10.5px] text-[var(--color-fg-faint)]" title={scopeLabel}>{scopeLabel}</p>}
            </div>
            <StatusChip status={request.status} kind="requestStates" />
            {(() => {
              // The tab the prompt went to — jump straight to the working
              // agent instead of hunting tabs. Gone tab → no button.
              const tab = request.agent ? (useApp.getState().tabs[task.id] ?? []).find(tb => tb.id === request.agent) : undefined;
              return tab ? <button className={action + " px-1.5 py-0.5"} title={tab.title} onClick={() => { useApp.getState().setActiveTabId(task.id, tab.id); focusTerminalTab(tab.id); }}><SquareTerminal className="h-3 w-3" />{t("delivery.openAgent")}</button> : null;
            })()}
            <button className={action + " -mr-1.5 px-1.5 py-0.5"} disabled={busy} onClick={() => void run(async () => {
              const res = live ? await useUI.getState().askConfirm({
                title: t("delivery.dismissTitle"),
                message: t("delivery.dismissActive"),
                confirmLabel: t("delivery.dismiss"),
                destructive: true,
              }) : true;
              if (!(typeof res === "boolean" ? res : res.confirmed)) return;
              await ipc.taskDeliveryRequestStatus(task.id, request.id, "failed");
              // Dismiss also kills undelivered queue copies — 'failed' still
              // passes the send gate so a queued item would type anyway.
              const app = useApp.getState();
              for (const tab of app.tabs[task.id] ?? [])
                if (tab.type === "terminal" && tab.queue?.some(q => q.delivery?.requestId === request.id))
                  app.patchTab(task.id, tab.id, { queue: tab.queue!.filter(q => q.delivery?.requestId !== request.id) });
              await useDelivery.getState().refresh(task.id);
            })}>{t("delivery.dismiss")}</button>
          </div>
          {request.error && <p role="alert" className={alertCls}>{request.error}</p>}
          {waiting && <p className="text-[11px] text-[var(--color-fg-faint)]">{t("delivery.waitingReport")}</p>}
          {request.prs.map(p => {
            const repo = repos.find(r => r.dir_name === p.dir_name);
            return <div key={p.dir_name} className="space-y-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-2">
              <div className="flex items-center gap-1.5">
                <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-[var(--color-palette-purple)]" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" title={p.title}>{repo?.name ?? p.dir_name} · {p.title}</span>
                {repo?.identity && <button className={action + " -mr-1 px-1.5 py-0.5"} disabled={busy} onClick={() => { applied.current[p.dir_name] = { title: p.title, body: p.body }; setPrInputs([{ identity: repo.identity!, title: p.title, body: p.body, base: repo.base, draft: true }]); }}>{t("delivery.createPr")}</button>}
              </div>
              {p.body && <details><summary className="cursor-pointer text-[10.5px] text-[var(--color-fg-faint)]">{t("delivery.body")}</summary><p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-5">{p.body}</p></details>}
            </div>;
          })}
          {/* replies requests show every draft (empty ones are fill-in
              slots); fix/conflicts drafts are optional agent extras — hide
              the untouched placeholders. */}
          {request.drafts.filter(d => d.body || d.error || d.status !== "draft" || (request.kind === "replies" && request.status === "drafted")).map(draft => <ReplyDraft key={draft.key} taskId={task.id} request={request} draft={draft} repo={repos.find(r => r.dir_name === draft.dir_name)} />)}
        </div>;
      })}
    </div>}
    </div>
    {/* Scope is declared where each action is launched (per-item, per-section
        bulk, per-repo menu) and narrowed in the send dialog — no persistent
        selection state, so there's no bottom bar to get out of sync. */}
    <AppDialog open={!!preview} onOpenChange={open => { if (!open && !busy) cancelPreview(); }} className="max-w-2xl" title={t("delivery.reviewSend")} description={t("delivery.scopeNotice")}
      stickyFooter={preview && <>
        {error && <p role="alert" className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-[12.5px] text-[var(--color-err)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={cancelPreview}>{t("common:cancel")}</Button>
          <Button variant="secondary" size="sm" disabled={busy || !preview.target || !preview.text.trim() || !preview.chosen.size && !!Object.keys(preview.pools).length} onClick={() => void run(() => send(true))}>{t("delivery.queue")}</Button>
          <Button variant="primary" size="sm" data-testid="delivery-send" disabled={busy || !preview.target || !preview.text.trim() || !preview.chosen.size && !!Object.keys(preview.pools).length} onClick={() => void run(() => send(false))}>{t("delivery.send")}</Button>
        </div>
      </>}>
      {preview && <div className="space-y-3">
        <label className={fieldLabel}>{t("delivery.agent")}<select className={field} disabled={busy} value={preview.target} onChange={e => setPreview({ ...preview, target: e.target.value })}><option value="">{t("delivery.selectAgent")}</option>{targets.map(tab => <option key={tab.id} value={tab.id}>{tab.title || agentDisplayName(tab.cli)}{tab.workState === "working" ? " · " + t("delivery.agentWorking") : ""}</option>)}{newAgentOk && <option value={NEW_AGENT}>{t("delivery.newAgent")}</option>}</select></label>
        {!targets.length && !newAgentOk && <p className="text-[11.5px] text-[var(--color-warn)]">{t("reviewBar.noAgent")}</p>}
        {preview.target === NEW_AGENT && busy && <p role="status" className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-fg-dim)]"><Spinner size={12} />{t("delivery.spawning")}</p>}
        <div className="space-y-1 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-faint)]">{t("delivery.scope")}</p>
          {preview.request.identities.map(i => {
            const repo = repos.find(r => r.dir_name === i.dir_name);
            return <p className="flex items-baseline gap-1.5 text-[11.5px]" key={i.dir_name} title={i.path}>
              <span className="shrink-0 font-medium">{repo?.name ?? i.dir_name}</span>
              <span className="min-w-0 break-all font-mono text-[10.5px] text-[var(--color-fg-faint)]">{i.branch} · {i.head.slice(0, 8)}{i.pr_number != null ? " · " + prRef(repositoryLookup(pr, i.dir_name)?.provider, i.pr_number) + (i.pr_revision ? " · " + i.pr_revision.slice(0, 8) : "") : ""}</span>
            </p>;
          })}
        </div>
        {!!Object.keys(preview.pools).length && <div className="space-y-1.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-faint)]">{t("delivery.evidenceTitle")}</p>
          {Object.entries(preview.pools).map(([dir, pool]) => <div key={dir} className="space-y-1">
            {Object.keys(preview.pools).length > 1 && <p className="text-[10.5px] font-medium text-[var(--color-fg-dim)]">{pool.repo.name}</p>}
            {[...pool.ci.map(n => ({ key: dir + ":ci:" + n.id, label: n.name, ci: true })), ...pool.threads.map(th => ({ key: dir + ":review:" + th.id, label: th.path ? `${th.path}${th.line ? ":" + th.line : ""}` : t("delivery.discussion"), ci: false }))].map(item =>
              <label key={item.key} className="flex items-center gap-2 text-[11.5px] text-[var(--color-fg-dim)]">
                <input type="checkbox" disabled={busy} checked={preview.chosen.has(item.key)} onChange={() => void run(() => retune(item.key))} />
                {item.ci ? <Wrench className="h-3 w-3 shrink-0 text-[var(--color-palette-orange)]" /> : <MessageSquare className="h-3 w-3 shrink-0 text-[var(--color-palette-blue)]" />}
                <span className="min-w-0 truncate" title={item.label}>{item.label}</span>
              </label>)}
          </div>)}
        </div>}
        <label className={fieldLabel}>{t("delivery.prompt")}<textarea {...textProps} disabled={busy} className={field + " min-h-72 resize-y font-mono text-[11.5px] leading-5"} value={preview.text} onChange={e => setPreview({ ...preview, text: e.target.value })} /></label>
      </div>}
    </AppDialog>
    <AppDialog open={!!prInputs} onOpenChange={open => { if (!open && !busy) setPrInputs(null); }} className="max-w-2xl" title={t("delivery.createPrs")} description={t("delivery.prNotice")}
      stickyFooter={prInputs && <>
        {error && <p role="alert" className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-[12.5px] text-[var(--color-err)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => prepare("prs", repos.filter(r => prInputs?.some(p => p.identity.dir_name === r.dir_name))))}>{t("delivery.draftAll")}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPrInputs(null)}>{t("common:cancel")}</Button>
          <Button variant="primary" size="sm" disabled={busy || !prInputs.length} onClick={() => void run(async () => {
            useDelivery.getState().results(task.id, await ipc.taskDeliveryPrCreate(task.id, prInputs)); setPrInputs(null); await refresh();
          })}>{t("delivery.createSelected")}</Button>
        </div>
      </>}>
      {prInputs?.map((input, i) => {
        const existing = repositoryLookup(pr, input.identity.dir_name)?.pr;
        const reused = existing && (existing.state === "open" || existing.state === "draft") ? existing : null;
        const repo = repos.find(r => r.dir_name === input.identity.dir_name);
        return <fieldset key={input.identity.dir_name} className="min-w-0 space-y-2.5 rounded-md border border-[var(--color-border-soft)] px-3 pb-3 pt-1"><legend className="flex items-center gap-2 px-1 text-[11.5px] font-medium"><span>{repo?.name}</span>{repo && <button type="button" className={action + " -my-0.5 py-0.5"} disabled={busy} title={t("delivery.draftWithAgent")} onClick={() => void run(() => prepare("prs", [repo]))}><Sparkles className="h-3 w-3" />{t("delivery.draftWithAgent")}</button>}{prInputs.length > 1 && <button type="button" className={action + " -my-0.5 ml-auto px-1 py-0.5"} disabled={busy} aria-label={t("delivery.removeRepo", { name: repo?.name ?? input.identity.dir_name })} onClick={() => setPrInputs(list => list && list.length > 1 ? list.filter(p => p.identity.dir_name !== input.identity.dir_name) : null)}><X className="h-3 w-3" /></button>}</legend><p className="truncate font-mono text-[10.5px] text-[var(--color-fg-faint)]" title={input.identity.path}>{input.identity.branch} · {input.identity.remote}</p>
        {reused && <p className="text-[11.5px] text-[var(--color-warn)]">{t("delivery.reusePr", { ref: prRef(reused.provider, reused.number) })}</p>}
        <label className={fieldLabel}>{t("delivery.title")}<Input value={input.title} onChange={e => changePr(i, { title: e.target.value })} /></label>
        <div className="flex items-end gap-3">
          <label className={fieldLabel + " min-w-0 flex-1"}>{t("delivery.base")}<Input value={input.base} onChange={e => changePr(i, { base: e.target.value })} /></label>
          <label className="flex shrink-0 items-center gap-1.5 pb-2 text-[12px] text-[var(--color-fg-dim)]"><input type="checkbox" checked={input.draft} onChange={e => changePr(i, { draft: e.target.checked })} /> {t("delivery.draft")}</label>
        </div>
        <label className={fieldLabel}>{t("delivery.body")}<textarea {...textProps} rows={5} className={field + " resize-y font-mono text-[11.5px] leading-5"} value={input.body} onChange={e => changePr(i, { body: e.target.value })} /></label>
      </fieldset>;
      })}
    </AppDialog>
    <AppDialog open={!!update} onOpenChange={open => { if (!open && !busy) setUpdate(null); }} className="max-w-lg" title={t("delivery.update")} description={t("delivery.updateNotice")}
      stickyFooter={update && <>
        {error && <p role="alert" className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap text-[12.5px] text-[var(--color-err)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setUpdate(null)}>{t("common:cancel")}</Button>
          <Button variant="primary" size="sm" disabled={busy || !update.repos.length} onClick={() => void run(async () => {
            useDelivery.getState().results(task.id, await ipc.taskDeliveryUpdate(task.id, update.repos.map(r => r.identity!), update.mode)); setUpdate(null); await refresh();
          })}>{t("delivery.updateSelected")}</Button>
        </div>
      </>}>
      {update && <>{update.repos.map(r => <p className="flex items-baseline gap-1.5 text-[11.5px]" key={r.dir_name} title={r.identity!.path}>
        <span className="shrink-0 font-medium">{r.name}</span>
        <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--color-fg-faint)]">{r.base} → {r.identity!.branch}</span>
        <span className="ml-auto shrink-0 text-[10.5px]" style={{ color: r.dirty ? "var(--color-warn)" : "var(--color-fg-faint)" }}>{r.dirty ? t("delivery.autostash") : t("delivery.clean")}</span>
      </p>)}
      <label className={fieldLabel}>{t("delivery.method")}<select className={field} value={update.mode} onChange={e => setUpdate({ ...update, mode: e.target.value as UpdateMode })}>{(["pull", "merge", "rebase"] as const).map(mode => <option value={mode} key={mode}>{t(`delivery.methods.${mode}`)}</option>)}</select></label></>}
    </AppDialog>
  </section>;
}

function StatusChip({ status, kind }: { status: string; kind: "requestStates" | "replyStates" }) {
  const { t } = useTranslation("panels");
  const color = STATUS_COLOR[status] ?? "var(--color-fg-faint)";
  return <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ color, background: `color-mix(in srgb, ${color} 14%, var(--color-bg-3))` }}>
    <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
    {t(`delivery.${kind}.${status}`, { defaultValue: status })}
  </span>;
}

// ponytail: bounded provider lists make this scan cheap; index children if thousands of jobs become common.
function CiTree({ nodes, parent, seen, render }: { nodes: CiNode[]; parent: string | null; seen: string[]; render: (node: CiNode) => React.ReactNode }) {
  // Not <details>/<summary>: a click anywhere in a summary toggles it, and the
  // rendered row holds buttons and a checkbox — clicking "Open provider" on a
  // pipeline node collapsed it, and ticking its checkbox did both.
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  return <ul className="mt-2 space-y-1">{nodes.filter(n => n.parent === parent && !seen.includes(n.id)).map(node => {
    const hasChildren = nodes.some(n => n.parent === node.id);
    const open = openMap[node.id] ?? ["failed", "running", "pending", "approval"].includes(node.status);
    return <li key={node.id}>{hasChildren ? <>
      <div className="flex items-start gap-1">
        <button type="button" aria-label={node.name} aria-expanded={open} className="mt-1 shrink-0 text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]" onClick={() => setOpenMap(s => ({ ...s, [node.id]: !open }))}><ChevronRight className={`h-3 w-3 ${open ? "rotate-90" : ""}`} /></button>
        <div className="min-w-0 flex-1">{render(node)}</div>
      </div>
      {open && <div className="ml-1.5 border-l border-[var(--color-border-soft)] pl-3"><CiTree nodes={nodes} parent={node.id} seen={[...seen, node.id]} render={render} /></div>}
    </> : render(node)}</li>;
  })}</ul>;
}

function ReplyDraft({ taskId, request, draft, repo }: { taskId: string; request: DeliveryRequest; draft: DeliveryDraft; repo?: DeliveryRepo }) {
  const { t } = useTranslation("panels");
  const provider = repositoryLookup(usePr(s => s.byTask[taskId]), draft.dir_name)?.provider ?? null;
  const cacheKey = taskId + ":" + request.id + ":" + draft.key;
  const [body, setBody] = useState(() => useDelivery.getState().edits[cacheKey] ?? draft.body);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (useDelivery.getState().edits[cacheKey] === undefined) setBody(draft.body); }, [draft.body, cacheKey]);
  // Once a draft leaves "draft" the textarea locks — an orphaned local edit
  // would otherwise pin "Unsaved edits" forever on a posted reply.
  useEffect(() => {
    if (draft.status !== "draft") { useDelivery.getState().edit(cacheKey, undefined); setBody(draft.body); }
  }, [draft.status, draft.body, cacheKey]);
  const perform = async (post: boolean) => {
    setBusy(true); setError("");
    try {
      if (draft.status === "draft") {
        await ipc.taskDeliveryDraftSave(taskId, request.id, draft.key, body);
        useDelivery.getState().edit(cacheKey, undefined);
      }
      if (post) {
        if (!repo?.identity) throw new Error(t("delivery.loadFirst"));
        // Posting is a public provider write — confirm once per click so a
        // stray tap doesn't publish a reply the user hasn't reviewed.
        const res = await useUI.getState().askConfirm({
          title: t("delivery.postReply"),
          message: t("delivery.postConfirm", { repo: repo.name, pr: prRef(provider, draft.pr_number) }),
          confirmLabel: t("delivery.postReply"),
        });
        if (!(typeof res === "boolean" ? res : res.confirmed)) return;
        await ipc.taskDeliveryReplyPost(taskId, request.id, draft.key, repo.identity);
      }
      await useDelivery.getState().refresh(taskId);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] p-2 space-y-2">
    <p className="flex items-center gap-1.5 text-[11px]"><MessageSquare className="h-3 w-3 shrink-0 text-[var(--color-palette-blue)]" /><span className="min-w-0 flex-1 truncate font-medium">{repo?.name ?? draft.dir_name} · {prRef(provider, draft.pr_number)}</span><StatusChip status={draft.status} kind="replyStates" /></p>
    <textarea {...textProps} maxLength={32_000} aria-label={t("delivery.reply")} placeholder={t("delivery.replyPlaceholder")} className={field + " resize-y"} value={body} disabled={draft.status !== "draft" || busy} onChange={e => { setBody(e.target.value); useDelivery.getState().edit(cacheKey, e.target.value); }} />
    {body !== draft.body && <p className="text-[var(--color-warn)]">{t("delivery.unsaved")}</p>}
    {(error || draft.error) && <p role="alert" className={alertCls}>{error || draft.error}</p>}
    <div className="flex gap-2"><button className={action} disabled={busy || draft.status !== "draft"} onClick={() => void perform(false)}>{t("delivery.save")}</button>
      <button className={action} disabled={!body.trim()} onClick={() => void navigator.clipboard.writeText(body).catch(e => setError(String(e)))}><Copy className="h-3 w-3" />{t("delivery.copyReply")}</button>
      <button className={action} disabled={busy || draft.status === "posted" || !body.trim() || !repo?.identity} onClick={() => void perform(true)}>{draft.status === "uncertain" || draft.status === "posting" ? t("delivery.verifyPost") : draft.status === "retry_ready" ? t("delivery.retryReply") : t("delivery.postReply")}</button></div>
  </div>;
}

function CiState({ status }: { status: string }) {
  const { t } = useTranslation("panels");
  const Icon = status === "passed" ? CircleCheck : status === "failed" ? CircleX : status === "approval" ? ShieldAlert : status === "pending" || status === "running" ? Clock : status === "skipped" || status === "canceled" ? CircleMinus : CircleHelp;
  const color = status === "passed" ? "var(--color-ok)" : status === "failed" ? "var(--color-err)" : status === "approval" || status === "pending" || status === "running" ? "var(--color-warn)" : "var(--color-fg-faint)";
  return <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} role="img" aria-label={t(`delivery.ciStates.${status}`, { defaultValue: status })} />;
}
