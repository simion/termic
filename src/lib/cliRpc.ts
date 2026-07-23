// Production RPC bridge for the `termic` CLI control socket.
//
// Work-state (working / waiting / done / idle) lives ONLY in the webview
// (store/app.ts tab.workState + tab.unread), and selecting a task is a UI
// action. The Rust socket server (src-tauri/src/cli_server.rs) reaches
// those by emitting `cli-rpc://request` with a correlation id; this module
// runs the handler against the SAME store the GUI uses and replies via the
// `cli_rpc_result` command. It is NEW hardened code that only borrows the
// dev automation bridge's correlation-id pattern (automation.rs) - the
// debug bridge itself is never armed or reused here, and unlike it, this
// listener runs in RELEASE builds (the whole feature is dead otherwise).
//
// Only these two typed handlers exist; there is no eval. An unknown method
// replies with an error, and the server ignores replies whose id is not
// waiting, so nothing can be injected into an in-flight request.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useApp } from "@/store/app";
import type { TerminalTab } from "@/lib/types";

interface RpcRequest {
  id: string;
  method: string;
  params: unknown;
}

type Handler = (params: unknown) => Promise<unknown> | unknown;

/** Aggregate a task's terminal tabs into one work state, matching the
 *  sidebar's own signal (see lib/waitingAgents.ts): working wins, then a
 *  tab blocked on the user (attention), then a finished turn (done),
 *  else idle. A task with NO live terminal tabs reports "inactive" (it
 *  exists on disk but no agent is running in the app) rather than being
 *  omitted, so the CLI can say "no agent open" instead of the misleading
 *  "UI did not answer" (which now means only a genuine timeout). */
export function workStateHandler(params: unknown): { states: Record<string, { state: string; tabs: number }> } {
  const taskIds = Array.isArray((params as { taskIds?: unknown })?.taskIds)
    ? ((params as { taskIds: unknown[] }).taskIds.filter((x): x is string => typeof x === "string"))
    : [];
  const s = useApp.getState();
  const states: Record<string, { state: string; tabs: number }> = {};
  for (const id of taskIds) {
    const term = (s.tabs[id] ?? []).filter((t): t is TerminalTab => t.type === "terminal");
    if (term.length === 0) {
      states[id] = { state: "inactive", tabs: 0 };
      continue;
    }
    let state = "idle";
    if (term.some(t => t.workState === "working")) state = "working";
    else if (term.some(t => t.unread?.reason === "attention")) state = "waiting";
    else if (term.some(t => t.workState === "done")) state = "done";
    states[id] = { state, tabs: term.length };
  }
  return { states };
}

/** Select a task in the UI (window raise is done Rust-side). Loads the
 *  task set first if the store has not seen this id yet (a task created
 *  in another way since the last refresh). */
async function openTaskHandler(params: unknown): Promise<null> {
  const taskId = (params as { taskId?: unknown })?.taskId;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("open_task requires a taskId");
  }
  const app = useApp.getState();
  if (!app.tasks.some(t => t.id === taskId)) {
    await app.loadAll();
  }
  const fresh = useApp.getState();
  if (!fresh.tasks.some(t => t.id === taskId)) {
    throw new Error("no such task");
  }
  fresh.setActiveTask(taskId);
  return null;
}

const handlers: Record<string, Handler> = {
  work_state: workStateHandler,
  open_task: openTaskHandler,
};

async function dispatch(req: RpcRequest): Promise<void> {
  let payload: string;
  try {
    const handler = handlers[req.method];
    if (!handler) throw new Error(`unknown method "${req.method}"`);
    const value = await handler(req.params);
    payload = JSON.stringify({ ok: true, value: value ?? null });
  } catch (e) {
    payload = JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) });
  }
  // Fire-and-forget: if the server already timed out and dropped the id,
  // the result is discarded harmlessly.
  invoke("cli_rpc_result", { id: req.id, payload }).catch(() => {});
}

let started = false;

/** Register the control-socket RPC listener. Idempotent; safe to call on
 *  every mount. Returns an unlisten for teardown. The returned unlisten
 *  clears the latch, so a teardown-then-remount (or a re-run mount effect)
 *  re-registers instead of silently leaving the RPC channel dead. */
export function initCliRpc(): Promise<UnlistenFn> {
  if (started) return Promise.resolve(() => {});
  started = true;
  return listen<RpcRequest>("cli-rpc://request", ev => {
    void dispatch(ev.payload);
  })
    .then(unlisten => () => {
      started = false;
      unlisten();
    })
    .catch(err => {
      // A failed registration must not wedge the latch on forever.
      started = false;
      throw err;
    });
}
