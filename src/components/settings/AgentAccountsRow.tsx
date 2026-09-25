// Credential sets for one agent (GH #278), at the TOP of that agent's card.
//
// "Who is this signed in as" reads before "how does it run", and there is no
// separate Accounts page to find: adding a second login is a per-agent
// decision, so it lives on the agent.
//
// The list and the default are profile-scoped for free (they sit on the agent
// entry, and `settings.agents` already is). The STORES are global and keyed by
// the account's NAME, so two profiles using "Work" share one login rather than
// each signing in. That is why removing an account here never deletes the
// store: another profile may still be using it.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Plus, Check, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import * as ipc from "@/lib/ipc";
import type { AgentAccountsView } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AgentAccountsRow({ agentId, onEmptied, adding, onDoneAdding, nonce }: {
  agentId: string;
  /** Bumped by the card when the OTHER accounts component changed something.
   *  A prop, not a `key`: remounting on every add unmounted this row, which
   *  then rendered nothing until its refetch landed, and that gap is the
   *  flicker. Refetching in place keeps the old rows on screen meanwhile. */
  nonce?: number;
  /** Removing the LAST set has to bring the header affordance back, and that
   *  component fetches on mount, so the card is told to re-mount both. */
  onEmptied?: () => void;
  /** The header's "Second account" button was pressed. The form lives HERE,
   *  in the body, not up there: the header is a single line holding the id,
   *  the badges and the Enable switch, and an input in it pushed "BUILT-IN"
   *  onto two lines and made the whole strip look broken. */
  adding?: boolean;
  onDoneAdding?: () => void;
}) {
  // One card renders at a time (the section has an agent tab strip above it),
  // so this is one call per card shown, not one per agent.
  const { t } = useTranslation("settings");
  const [view, setView] = useState<AgentAccountsView | null>(null);
  // Local for the "add another" button on an agent that already has sets; the
  // FIRST one is driven from the header, through `adding`.
  const [addingLocal, setAddingLocal] = useState(false);
  const isAdding = !!adding || addingLocal;
  const stopAdding = () => { setAddingLocal(false); onDoneAdding?.(); };
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submitting = useRef(false);
  /** The SECOND name, asked for only the first time (see `submit`). */
  const [second, setSecond] = useState("");

  const refresh = useCallback(() => {
    void ipc.agentAccounts(agentId, false).then(setView).catch(() => setView(null));
  }, [agentId]);
  useEffect(refresh, [refresh, nonce]);

  // Nothing to show until the user has actually named a credential set. The
  // dormant and unsupported states live in the card HEADER instead
  // (`AgentAccountsAction`): a full row is a lot of vertical space for the
  // case almost every install stays in forever, and this row sits above the
  // fields people came here to edit.
  // ...unless the header just asked for one, which is when this row becomes
  // the place that form appears.
  if (!view || (view.accounts.length === 0 && !adding)) return null;

  /** Is this the first time? Then the form asks for TWO names. */
  const first = view.accounts.length === 0;

  const submit = async () => {
    // Enter and blur BOTH fire: committing unmounts the input, which blurs it.
    // Without this the second call ran with an empty draft, bumped the card's
    // nonce again and cost a second refetch.
    if (submitting.current) return;
    const name = draft.trim();
    if (!name) { stopAdding(); return; }
    // FIRST TIME: two names in one step, because the first name does not
    // create an account, it NAMES THE LOGIN THE AGENT ALREADY HAS. Asking for
    // one name behind a button that says "Second account" ended with the
    // user's existing login renamed and still no second account, which is
    // exactly the confusion this removes. Same shape as the New profile
    // dialog, which names the current setup and the new one together.
    if (first && !second.trim()) { setErr(t("agents.accounts.errSecond")); return; }
    submitting.current = true;
    try {
      await ipc.accountAdd(agentId, name);
      if (first) await ipc.accountAdd(agentId, second.trim());
      // Read the new list BEFORE leaving the adding state. Leaving it first
      // put this row back on "no accounts and not adding", which is the branch
      // that renders nothing, so the whole row vanished for a frame and came
      // back with the chip in it. That is the flicker.
      const next = await ipc.agentAccounts(agentId, false).catch(() => null);
      if (next) setView(next);
      setDraft(""); setSecond(""); setErr(null); stopAdding();
    } catch (e) {
      setErr(String(e));
    } finally {
      submitting.current = false;
    }
  };

  return (
    <div className="mb-3" data-testid={`agent-accounts-${agentId}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--color-fg-faint)]">
          {first ? t("agents.accounts.firstLabel") : t("agents.accounts.label")}
        </span>

        {view.accounts.map(a => (
          <span
            key={a.name}
            data-testid={`account-chip-${agentId}-${a.name}`}
            className={cn(
              "group inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[12px]",
              a.isDefault
                ? "border-[var(--color-accent)] text-[var(--color-fg)]"
                : "border-[var(--color-border-soft)] text-[var(--color-fg-dim)]",
            )}
          >
            <button
              type="button"
              title={a.isDefault ? t("agents.accounts.defaultTip") : t("agents.accounts.useTip")}
              onClick={() => void ipc.accountSetDefault(agentId, a.name).then(refresh)}
              className="inline-flex items-center gap-1.5"
            >
              {a.isDefault && <Check className="h-3 w-3 text-[var(--color-accent)]" />}
              {a.name}
              {a.isDefault && (
                <span className="text-[9px] uppercase tracking-wider opacity-50">{t("agents.accounts.defaultBadge")}</span>
              )}
              {/* "Named but never signed in" is a real state, not an error: it
                  is what this account looks like on a second machine. */}
              {!a.signedIn && <span className="text-[10.5px] opacity-55">{t("agents.accounts.notSignedIn")}</span>}
            </button>
            <button
              type="button"
              aria-label={t("agents.accounts.removeAria", { name: a.name })}
              data-testid={`account-remove-${agentId}-${a.name}`}
              onClick={() => void ipc.accountRemove(agentId, a.name).then(async () => {
                // Fire onEmptied only on the TRANSITION to empty, from the
                // action that caused it. Doing it inside `refresh` looped:
                // the parent re-mounts this component on the signal, which
                // refreshes, which signals again.
                const next = await ipc.agentAccounts(agentId, false).catch(() => null);
                if (next && next.accounts.length === 0) onEmptied?.(); else setView(next);
              })}
              // Dimmed, not hidden. A hover-only control is unreachable by
              // keyboard and invisible to a test, and this one REMOVES a
              // credential set: discoverability matters more than tidiness.
              className="opacity-45 transition-opacity hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}

        {isAdding ? (
          <>
            <Input
              autoFocus
              value={draft}
              // Naming the login the agent ALREADY has, when this is the first
              // one: the placeholder has to be a name for that, not for a new
              // account the user has not created.
              placeholder={first ? t("agents.accounts.placeholderPersonal") : t("agents.accounts.placeholderWork")}
              data-testid={`account-name-${agentId}`}
              onChange={e => setDraft(e.target.value)}
              // No blur-to-submit while there are two fields: tabbing from the
              // first to the second would commit a half-finished form.
              onBlur={first ? undefined : () => void submit()}
              onKeyDown={e => {
                if (e.key === "Enter") void submit();
                if (e.key === "Escape") { setDraft(""); setSecond(""); stopAdding(); setErr(null); }
              }}
              className="h-6 w-32 text-[12px]"
            />
            {first && (
              <>
                <span className="text-[11px] uppercase tracking-wide text-[var(--color-fg-faint)]">
                  {t("agents.accounts.andAdd")}
                </span>
                <Input
                  value={second}
                  placeholder={t("agents.accounts.placeholderWork")}
                  data-testid={`account-second-${agentId}`}
                  onChange={e => setSecond(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") void submit();
                    if (e.key === "Escape") { setDraft(""); setSecond(""); stopAdding(); setErr(null); }
                  }}
                  className="h-6 w-32 text-[12px]"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`account-add-confirm-${agentId}`}
                  disabled={!draft.trim() || !second.trim()}
                  onClick={() => void submit()}
                >{t("common:add")}</Button>
              </>
            )}
          </>
        ) : (
          <button
            type="button"
            data-testid={`account-add-${agentId}`}
            onClick={() => { setAddingLocal(true); setErr(null); }}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            <Plus className="h-3 w-3" />
            {view.accounts.length === 0 ? t("agents.accounts.addLogin") : t("common:add")}
          </button>
        )}
      </div>

      {/* What the tick MEANS, and how to move it. The accent border and the
          check mark say "this one is special" without saying which special,
          and nothing on screen suggested the chips were clickable at all. */}
      {view.accounts.length > 0 && !isAdding && (
        <p className="mt-1.5 text-[11.5px] text-[var(--color-fg-faint)]">
          <Trans
            t={t}
            i18nKey="agents.accounts.defaultNote"
            values={{ name: view.accounts.find(a => a.isDefault)?.name ?? t("agents.accounts.ordinaryLogin") }}
            components={{ 1: <span className="text-[var(--color-fg-dim)]" /> }}
          />
        </p>
      )}

      {/* opencode and muse ride a GENERIC variable other tools in the same
          shell read. Saying so beats pretending it is agent-local. */}
      {view.envIsSharedRoot && view.accounts.length > 0 && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-[var(--color-fg-faint)]">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            <Trans
              t={t}
              i18nKey="agents.accounts.sharedEnv"
              values={{ var: view.envVar }}
              components={{ 1: <code className="mono" /> }}
            />
          </span>
        </p>
      )}

      {err && <p className="mt-1.5 text-[11.5px] text-[var(--color-danger)]">{err}</p>}
    </div>
  );
}


/** The dormant and unsupported states, in the card HEADER beside Enable.
 *
 *  Split from the row deliberately. Almost every install has one login for
 *  ever, so giving that case a full row costs vertical space above the fields
 *  people actually came to edit. The header has room and is where the card's
 *  other status already lives.
 *
 *  It says what it DOES, not what it is: "Second account" is the outcome, and
 *  the tooltip spells out the whole feature in one sentence. An icon alone
 *  would fail the only test that matters here, which is whether someone who
 *  has never heard of this understands it at a glance. */
export function AgentAccountsAction({ agentId, onStartAdd, nonce }: {
  agentId: string;
  /** See `AgentAccountsRow`'s: a refetch signal, not a remount. */
  nonce?: number;
  /** Open the add form. It renders in the card BODY, not here: the header is
   *  one line holding the id, the badges and the Enable switch, and putting an
   *  input in it pushed "BUILT-IN" onto two lines and made the strip look
   *  broken. The header stays a trigger. */
  onStartAdd?: () => void;
}) {
  const { t } = useTranslation("settings");
  const [view, setView] = useState<AgentAccountsView | null>(null);


  const load = useCallback(() => {
    void ipc.agentAccounts(agentId, false).then(setView).catch(() => setView(null));
  }, [agentId]);
  useEffect(load, [load, nonce]);

  // Once a set exists the ROW below carries everything, so this would be a
  // second way to do the same thing in the same card.
  if (!view || view.accounts.length > 0) return null;

  // An agent that cannot hold a second set gets NOTHING here, not a label
  // saying so. It sat in the card header of six agents forever, stating a
  // limitation almost nobody was looking for, with the actual reason hidden
  // in a tooltip. Absence is the signal, the same way the profile chip does
  // not exist until there is a profile. The reasons live in
  // docs/agent-accounts.md, where someone asking the question will look.
  if (!view.supported) return null;

  return (
    <button
      type="button"
      data-testid={`agent-accounts-${agentId}`}
      onClick={() => onStartAdd?.()}
      title={t("agents.accounts.secondAccountTip")}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[var(--color-fg-dim)] hover:border-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
    >
      <Plus className="h-3 w-3" /> {t("agents.accounts.secondAccount")}
    </button>
  );
}
