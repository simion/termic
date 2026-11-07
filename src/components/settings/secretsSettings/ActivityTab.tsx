// Activity tab: what the broker did across every running task (mock delta 6:
// not drawn, so it is the popover's Used / Blocked / Suspicious lists, one
// level up). Polls only while mounted and the window is visible.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { brokerAllEvents } from "@/lib/ipc";
import type { BrokerEvents, SecretDef } from "@/lib/types";
import { useApp } from "@/store/app";
import { suspiciousKey } from "@/lib/secretsUi";
import { Eyebrow } from "./parts";

/** Same cadence as the sandbox footer's deny poll. */
const POLL_MS = 2000;

export function ActivityTab({ secrets, filter, onClearFilter }: {
  secrets: SecretDef[]; filter: string | null; onClearFilter: () => void;
}) {
  const { t } = useTranslation("secrets");
  const [events, setEvents] = useState<[string, BrokerEvents][] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      // A hidden window (another Space, minimised) has nobody reading this.
      if (document.hidden) return;
      brokerAllEvents()
        .then(e => { if (alive) { setEvents(e); setError(null); } })
        .catch(e => { if (alive) setError(String(e)); });
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { alive = false; window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, []);

  const tasks = useApp(s => s.tasks);
  const taskName = (id: string) => tasks.find(x => x.id === id)?.name ?? t("manage.activity.unknownTask");
  // the broker records the secret's id (broker/mod.rs record_*).
  const secretName = (id: string) => secrets.find(s => s.id === id)?.name ?? id;
  const matches = (id: string) => !filter || id === filter;
  const filterName = filter ? secrets.find(s => s.id === filter)?.name ?? filter : null;
  const times = (n: number) => n === 1 ? t("manage.activity.times_one", { count: n }) : t("manage.activity.times_other", { count: n });

  const all = events ?? [];
  const used = all.flatMap(([id, e]) => e.used.filter(u => matches(u.secret)).map(u => ({ id, u })))
    .sort((a, b) => b.u.last_seen_unix_ms - a.u.last_seen_unix_ms);
  const blocked = all.flatMap(([id, e]) => e.blocked.filter(b => matches(b.secret)).map(b => ({ id, b })))
    .sort((a, b) => b.b.last_seen_unix_ms - a.b.last_seen_unix_ms);
  // A missing secret belongs to no secret, so a filter hides it; suspicious
  // events never hide, a filter must not be a way to miss an alarm.
  const noSecret = filter ? [] : all.flatMap(([id, e]) => e.no_secret.map(n => ({ id, n })));
  const suspicious = all.flatMap(([id, e]) => e.suspicious.map(s => ({ id, s })));
  const empty = used.length + blocked.length + noSecret.length + suspicious.length === 0;

  return (
    <div className="flex flex-col gap-6" data-testid="secrets-activity">
      <p className="text-[13px] text-[var(--color-fg-dim)]">{t("manage.activity.intro")}</p>
      {filterName && (
        <div className="flex items-center gap-2 text-[12.5px]" data-testid="activity-filter">
          <span>{t("manage.activity.filtered", { name: filterName })}</span>
          <button type="button" onClick={onClearFilter} className="text-[var(--color-accent)] hover:underline">{t("manage.activity.clearFilter")}</button>
        </div>
      )}
      {error && <div className="text-[12.5px] text-[var(--color-fg-faint)]">{t("manage.activity.unavailable", { error })}</div>}
      {!error && events && empty && <div className="text-[12.5px] text-[var(--color-fg-dim)]">{t("manage.activity.empty")}</div>}

      {suspicious.length > 0 && (
        <Group title={t("manage.activity.suspicious")} tone="err">
          {suspicious.map(({ id, s }, i) => (
            <Row key={`${id}-${i}`} task={taskName(id)} main={[t(suspiciousKey(s.kind)), s.host].filter(Boolean).join(" · ")} sub={s.detail} count={times(s.count)} />
          ))}
        </Group>
      )}
      {(blocked.length > 0 || noSecret.length > 0) && (
        <Group title={t("manage.activity.blocked")}>
          {blocked.map(({ id, b }, i) => (
            <Row key={`b-${id}-${i}`} task={taskName(id)}
              main={t("manage.activity.blockedRow", { method: b.method, path: b.path })}
              sub={t("manage.activity.blockedBy", { secret: secretName(b.secret), host: b.host, rule: b.rule })}
              count={times(b.count)} />
          ))}
          {noSecret.map(({ id, n }, i) => (
            <Row key={`n-${id}-${i}`} task={taskName(id)} main={n.host} sub={t("manage.activity.noSecret")} count={times(n.count)} />
          ))}
        </Group>
      )}
      {used.length > 0 && (
        <Group title={t("manage.activity.used")}>
          {used.map(({ id, u }, i) => (
            <Row key={`${id}-${i}`} task={taskName(id)}
              main={t("manage.activity.usedRow", { secret: secretName(u.secret), host: u.host })}
              sub={u.methods.map(([m, n]) => `${m} ${n}`).join(" · ")} />
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({ title, tone, children }: { title: string; tone?: "err"; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow className={tone === "err" ? "text-[var(--color-err)]" : undefined}>{title}</Eyebrow>
      <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">{children}</div>
    </div>
  );
}

function Row({ task, main, sub, count }: { task: string; main: string; sub?: string; count?: string }) {
  return (
    <div className="flex items-baseline gap-3 border-t border-[var(--color-border-soft)] px-3 py-2 text-[13px] first:border-t-0">
      <span className="w-40 shrink-0 truncate font-medium">{task}</span>
      <span className="min-w-0 flex-1">
        <span className="font-mono text-[12.5px]">{main}</span>
        {sub && <span className="ml-2 text-[12px] text-[var(--color-fg-dim)]">{sub}</span>}
      </span>
      {count && <span className="shrink-0 text-[12px] text-[var(--color-fg-faint)]">{count}</span>}
    </div>
  );
}
