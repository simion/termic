// The credentials half of the footer's agent panel (GH #278).
//
// A SECTION, not a popover. It used to be its own chip beside the usage chip,
// with its own trigger and its own panel, and that split was wrong in a way
// the code kept admitting: the pill's own header said it "forms one unit" with
// the usage chip, because the numbers there are THIS account's numbers. Two
// controls that form one unit are one control.
//
// The duplication was not free either. The auto-switch checkbox lived in both
// panels, and toggling it in one left the other stale until something
// remounted it, which took a shared hook and a Rust broadcast to paper over.
// There is one copy now.

import { useTranslation, Trans } from "react-i18next";
import { Check, ArrowRightLeft, Plus } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { useApp } from "@/store/app";
import { pillOrder } from "@/lib/accountPill";
import { SWITCH_AT_PERCENT } from "@/lib/autoSwitch";
import type { AgentAccountsView } from "@/lib/types";
import type { AccountSwitching } from "@/hooks/useAccountSwitching";

export function AccountSwitcher({ agentId, view, sw, onNavigate }: {
  agentId: string;
  view: AgentAccountsView;
  sw: AccountSwitching;
  /** Close the panel: a row that navigates away must not leave it hanging
   *  over the page it just opened. */
  onNavigate: () => void;
}) {
  const { t } = useTranslation("task");
  const { candidate, offering, auto, notice, label, pick, toggleAuto } = sw;
  return (
    <div className="border-t border-[var(--color-border-soft)] p-1.5">
      {/* What just happened, when it happened without being asked. Shown
          here rather than as a toast: a switch that only applies on the next
          start is not urgent, and a toast for it would interrupt the turn
          the user is watching. */}
      {notice && (
        <p
          data-testid="account-auto-notice"
          className="mb-1 rounded-md bg-[var(--color-bg-2)] px-2 py-1.5 text-[12px] leading-snug text-[var(--color-warn)]"
        >
          {notice}
        </p>
      )}
      {/* The offer. One click, at the moment of need, naming the account it
          would move to so nobody has to open the list to find out. */}
      {offering && (
        <button
          type="button"
          data-testid="account-switch-offer"
          onClick={() => void pick(candidate!).then(onNavigate)}
          className="mb-1 flex w-full items-center gap-2 rounded-md bg-[var(--color-bg-2)] px-2 py-1.5 text-left text-[12.5px] hover:brightness-110"
        >
          <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <span className="min-w-0 flex-1">
            <Trans
              t={t}
              i18nKey="accounts.switchOffer"
              values={{ percent: SWITCH_AT_PERCENT, candidate }}
              components={{ b: <span className="font-medium" /> }}
            />
          </span>
        </button>
      )}
      <div className="px-2 pb-1.5 pt-1 text-[11px] uppercase tracking-wide opacity-50">
        {t("accounts.credentials")}
      </div>
      {pillOrder(view!).map(a => (
        <button
          key={a.name}
          type="button"
          data-testid={`account-pick-${a.name}`}
          onClick={() => { onNavigate(); void pick(a.name); }}
          title={a.signedIn ? undefined
            : t("accounts.noLoginTitle", { name: a.name })}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--color-bg-2)]"
        >
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          {/* The ACTION, not the state. "not signed in" described a condition
              and left the row looking inert, which is exactly how someone
              concludes the account is broken. Clicking it now opens the tab
              where the login can actually happen, so the label says so. */}
          {!a.signedIn && <span className="shrink-0 text-[10.5px] opacity-55">{t("accounts.signIn")}</span>}
          {a.name === label && <Check className="h-3.5 w-3.5 shrink-0 opacity-70" />}
        </button>
      ))}
      {/* One account is not yet a choice, so the menu's job there is to get
          you to the second one. Same destination as the usage popover's
          row, and it names the AGENT so Settings lands on the right card
          with the control focused. */}
      {view.accounts.length < 2 && (
        <button
          type="button"
          data-testid="account-add-another"
          onClick={() => {
            onNavigate();
            useApp.getState().openSettings("agents", undefined, `${agentId}:accounts`);
          }}
          className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-[var(--color-border-soft)] px-2 pb-1 pt-2 text-left text-[12.5px] text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
        >
          <Plus className="h-3.5 w-3.5 shrink-0 opacity-70" />
          {t("accounts.addAnother")}
        </button>
      )}
      {/* The opt-in, in the menu the user is already in when they switch by
          hand. Offered ONLY where the agent reports usage: an automatic
          switch needs a number to act on, and a toggle that could never fire
          is worse than an absent one because it reads as covered. */}
      {view.reportsUsage && (
        <label
          data-testid="account-auto-toggle"
          data-on={auto ? "1" : "0"}
          className="mt-1 flex cursor-pointer items-start gap-2 rounded-md border-t border-[var(--color-border-soft)] px-2 pb-1 pt-2 text-[12.5px] hover:bg-[var(--color-bg-2)]"
        >
          <Checkbox checked={auto} onChange={next => void toggleAuto(next)} className="mt-0.5" />
          <span className="min-w-0 flex-1 leading-snug">
            {t("accounts.autoSwitch")}
            {/* One line, and it is about the CONSEQUENCE: "switch" does not
                sound like "restarts your agent", and that is the thing worth
                knowing before ticking the box rather than after. */}
            <span className="block text-[11px] text-[var(--color-fg-faint)]">
              {t("accounts.autoSwitchHint")}
            </span>
          </span>
        </label>
      )}
    </div>
  );
}
