// Top-bar "GitHub paused" pill. Renders ONLY while background GitHub
// polling is paused (a rate limit, the account under the floor, or termic
// over its own share), so the normal case costs one selector and nothing
// on screen. Click opens Settings > General, where the forge budget block
// has the numbers.

import { useTranslation } from "react-i18next";
import { Gauge } from "lucide-react";
import { useApp } from "@/store/app";
import { activePause, clockAt, useForgeRate } from "@/store/forgeRate";
import { Tip } from "@/components/ui/Tooltip";

export function ForgeRatePill() {
  const { t } = useTranslation("chrome");
  // A string key, so unrelated ledger updates (spend ticking up) do not
  // re-render the bar.
  const key = useForgeRate(s => {
    const p = activePause(s.hosts);
    return p ? `${p.host}|${p.kind}|${p.until}` : "";
  });
  const openSettings = useApp(s => s.openSettings);
  if (!key) return null;
  const [host, kind, until] = key.split("|");
  const time = clockAt(Number(until));
  return (
    <Tip content={t("forgeRatePill.tip", { host, reason: t(`forgeRatePill.kind.${kind}`) })} side="bottom">
      <button
        type="button"
        data-no-drag
        data-testid="forge-rate-pill"
        data-kind={kind}
        onClick={() => openSettings("general")}
        className="flex select-none items-center gap-1.5 rounded-full border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/15 px-2 py-0.5 text-[12px] font-medium text-[var(--color-warn)] hover:bg-[var(--color-warn)]/25"
      >
        <Gauge className="h-3 w-3" />
        <span className="leading-none">{t("forgeRatePill.label", { time })}</span>
      </button>
    </Tip>
  );
}
