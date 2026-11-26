// Drives the needs-you panel (GH #468) from the main window: which tasks
// are waiting, sent to the panel when that changes, and the panel shown only
// while something waits. Nothing runs while the pref is off, and nothing is
// polled: it follows the store.
import { useEffect, useRef } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { WINDOW_LABEL } from "@/lib/profileScope";
import { sameList, waitingTasks, type WaitingTask } from "@/lib/attentionPanel";

export function useAttentionPanel() {
  const on = usePrefs(s => s.attentionPanel);
  const last = useRef<WaitingTask[]>([]);
  useEffect(() => {
    // The root window owns it; a profile window's tasks are its own.
    if (!on || WINDOW_LABEL !== "main") return;
    const send = (list: WaitingTask[]) => {
      void emitTo("attention", "attention://list", list).catch(() => {});
      void invoke("attention_window", { show: list.length > 0 }).catch((e: unknown) => {
        // Kept where a spec can read why the panel did not show.
        (window as unknown as { __termicAttentionError?: string }).__termicAttentionError = String(e);
        console.warn("[attention] window:", e);
      });
    };
    const compute = () => {
      const s = useApp.getState();
      const names = new Map(s.projects.map(p => [p.id, p.name]));
      return waitingTasks(s.tasks, s.tabs, id => names.get(id) ?? "");
    };
    last.current = compute();
    send(last.current);
    const unsub = useApp.subscribe((s, prev) => {
      if (s.tasks === prev.tasks && s.tabs === prev.tabs) return;
      const next = compute();
      if (sameList(next, last.current)) return;
      last.current = next;
      send(next);
    });
    // The panel asks for the list when it opens (it may open after a change).
    const hello = listen("attention://hello", () => send(last.current));
    // "Open" on a card: select that task here.
    const open = listen<{ taskId: string }>("attention://open", e => {
      useApp.getState().setActiveTask(e.payload.taskId);
    });
    // Answered from the panel: the keys went straight to the agent's PTY, so
    // nothing typed here cleared the wait. Clear it as typing would.
    const answered = listen<{ taskId: string }>("attention://answered", e => {
      const s = useApp.getState();
      for (const t of s.tabs[e.payload.taskId] ?? []) {
        if (t.type === "terminal" && t.unread?.reason === "attention") s.clearAttention(e.payload.taskId, t.id);
      }
    });
    return () => {
      unsub();
      void hello.then(f => f());
      void open.then(f => f());
      void answered.then(f => f());
      void invoke("attention_window", { show: false }).catch(() => {});
    };
  }, [on]);
}
