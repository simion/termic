// The needs-you panel (GH #468): every task waiting on you, with the
// question its agent is asking and a button per answer, in a small window
// that stays over other apps. The main window sends the list (useAttention
// Panel) and shows this only while something waits; the questions are read
// off each agent's screen here, refreshed while it is up, and an answer is
// bound to the question it answers, so a late click never answers a newer one.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { WaitingTask } from "@/lib/attentionPanel";

interface QuestionOption { label: string; keys: string; selected: boolean }
interface Question { id: string; kind: string; title: string; body: string; options: QuestionOption[] }

/** Options that open the agent's own text box: nothing to click here. */
const freeText = (label: string) => /^(type something\.?|chat about this)$/i.test(label.trim());

/** How often the questions are read again while the panel is up. */
const REFRESH_MS = 1500;

export function AttentionWindow() {
  const { t } = useTranslation("chrome");
  const [list, setList] = useState<WaitingTask[]>([]);
  const [questions, setQuestions] = useState<Record<string, Question | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const un = listen<WaitingTask[]>("attention://list", e => setList(e.payload));
    void emitTo("main", "attention://hello").catch(() => {});
    return () => { void un.then(f => f()); };
  }, []);

  const refresh = useCallback(async (tasks: WaitingTask[]) => {
    const entries = await Promise.all(tasks.map(async x =>
      [x.taskId, await invoke<Question | null>("attention_question", { taskId: x.taskId }).catch(() => null)] as const));
    setQuestions(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    if (!list.length) return;
    void refresh(list);
    const id = setInterval(() => void refresh(list), REFRESH_MS);
    return () => clearInterval(id);
  }, [list, refresh]);

  const answer = async (task: string, q: Question, o: QuestionOption) => {
    setBusy(`${task}:${o.label}`);
    const ok = await invoke("attention_answer", { taskId: task, questionId: q.id, keys: o.keys }).then(() => true, () => false);
    // Answered: the main window clears the wait as typing the answer would
    // (the keys went to the PTY directly, so no keystroke there did it).
    if (ok) void emitTo("main", "attention://answered", { taskId: task }).catch(() => {});
    setBusy(null);
    void refresh(list);
  };

  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-[var(--color-bg-1)] p-2 text-[13px] text-[var(--color-fg)]">
      {list.length === 0 && <div className="m-auto text-[var(--color-fg-dim)]">{t("attention.empty")}</div>}
      {list.map(x => {
        const q = questions[x.taskId];
        const options = q?.options.filter(o => !freeText(o.label)) ?? [];
        return (
          <div key={x.taskId} data-testid={`attention-card-${x.taskId}`} className="mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] p-2.5">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate font-medium">{x.name}</span>
              <span className="truncate text-[11px] text-[var(--color-fg-faint)]">{x.project}</span>
              <button type="button" data-testid="attention-open" onClick={() => void invoke("attention_open_task", { taskId: x.taskId })}
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-hover)]">
                {t("attention.open")}
              </button>
            </div>
            <div className="mt-1 text-[var(--color-fg-dim)]">{q?.title || t("attention.waiting")}</div>
            {q?.body && <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-bg-1)] p-1.5 font-mono text-[11.5px]">{q.body}</pre>}
            {q && options.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {options.map(o => (
                  <button key={o.label} type="button" data-testid="attention-option" disabled={busy !== null}
                    onClick={() => void answer(x.taskId, q, o)}
                    className="rounded-md border border-[var(--color-border-soft)] px-2 py-1 text-left hover:bg-[var(--color-hover)] disabled:opacity-50">
                    {o.label.split(" · ")[0]}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
