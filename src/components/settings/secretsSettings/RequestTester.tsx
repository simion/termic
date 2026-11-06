// "Try a request" above a role's rule blocks: pick a (secret, host), type a
// request, and the broker's own rule walk (secrets_test_request) says what
// would happen and which line decided it.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Role, SecretDef } from "@/lib/types";
import { secretsTestRequest, type TestRequestResult } from "@/lib/ipc";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { type BlockKind, splitRequest } from "./model";
import { Eyebrow, InfoTip } from "./parts";

export type TesterHit = { key: string; at: number | "fallback" };
export const blockKey = (secret: string, host: string) => `${secret}@${host}`;

export function RequestTester({ role, blocks, onHit }: {
  role: Role; blocks: { secret: SecretDef; host: string; kind: BlockKind }[];
  onHit: (h: TesterHit | null) => void;
}) {
  const { t } = useTranslation("secrets");
  const [picked, setPicked] = useState("");
  const [q, setQ] = useState("");
  const [out, setOut] = useState<{ res: TestRequestResult } | { error: string } | null>(null);
  const block = blocks.find(b => blockKey(b.secret.id, b.host) === picked) ?? blocks[0];
  const key = block ? blockKey(block.secret.id, block.host) : "";

  // re-judged on every role change too, so an edit below shows at once.
  useEffect(() => {
    const { method, target } = splitRequest(q);
    if (!block || !method) { setOut(null); onHit(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      secretsTestRequest(role, block.secret.id, block.host, method, target).then(
        res => {
          if (!live) return;
          setOut({ res });
          onHit(res.rule_index !== null ? { key, at: res.rule_index } : res.from_fallback ? { key, at: "fallback" } : null);
        },
        e => { if (live) { setOut({ error: String(e) }); onHit(null); } },
      );
    }, 200);
    return () => { live = false; clearTimeout(timer); };
    // onHit is the parent's state setter; block is derived from key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, key, q]);

  if (!block) return null;
  const res = out && "res" in out ? out.res : null;
  const rule = res?.rule_index != null ? ruleAt(role, block.secret.id, block.host, res.rule_index) : null;
  return (
    <div data-testid="rule-tester" className="flex flex-col gap-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3">
      <span className="flex items-center gap-1.5">
        <Eyebrow>{t("manage.editor.tester.title")}</Eyebrow>
        <InfoTip text={t("manage.editor.tester.tip")} />
      </span>
      <div className="flex gap-2">
        <select
          data-testid="rule-tester-block"
          aria-label={t("manage.editor.tester.block")}
          value={key}
          onChange={e => setPicked(e.target.value)}
          className="h-9 max-w-[40%] shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[13px]"
        >
          {blocks.map(b => {
            const k = blockKey(b.secret.id, b.host);
            return <option key={k} value={k}>{`${b.secret.name} → ${b.host}`}</option>;
          })}
        </select>
        <Input
          data-testid="rule-tester-input"
          aria-label={t("manage.editor.tester.request")}
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={block.kind === "git" ? "push acme/widget" : block.kind === "api" ? "POST /repos/acme/widget/pulls/7/reviews" : "GET /v1/models"}
          className="h-9 min-w-0 flex-1 font-mono text-[12.5px]"
        />
      </div>
      <div data-testid="rule-tester-verdict" data-effect={res?.effect} className="flex flex-wrap items-baseline gap-2 text-[13px]">
        {!out && <span className="text-[12.5px] text-[var(--color-fg-faint)]">{t("manage.editor.tester.idle")}</span>}
        {out && "error" in out && <span className="text-[12.5px] text-[var(--color-err)]">{out.error}</span>}
        {res && (
          <>
            <b className={cn(res.effect === "allow" ? "text-[var(--color-ok)]" : "text-[var(--color-err)]")}>
              {res.effect === "allow" ? t("manage.editor.tester.allowed") : t("manage.editor.tester.refused")}
            </b>
            <span className="text-[var(--color-fg-dim)]">
              {res.rule_index !== null
                ? (rule?.note.trim()
                  ? t("manage.editor.tester.byRuleNote", { n: res.rule_index + 1, host: block.host, note: rule.note.trim() })
                  : t("manage.editor.tester.byRule", { n: res.rule_index + 1, host: block.host }))
                : res.from_fallback ? t("manage.editor.tester.fallback", { host: block.host }) : res.detail}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function ruleAt(role: Role, secret: string, host: string, i: number) {
  return role.rule_sets.find(s => s.secret === secret && s.host.toLowerCase() === host.toLowerCase())?.rules[i] ?? null;
}
