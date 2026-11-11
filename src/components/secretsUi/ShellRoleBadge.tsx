// The role a shell runs, on its own tab (docs/sandbox.md "Shells"): key
// glyph, role name in the role's colour, `· N` blocked. Amber when gh sent
// its own token (an rc file set GH_TOKEN), red on anything else suspicious.
// A plain shell renders none of this. The status bar never shows a shell's
// role; it stays the agent's. A click opens the cage's Activity dialog,
// filtered to this shell; its role switches from the tab's menu.

import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { shellBrokerKey } from "@/lib/ipc";
import { roleColour } from "@/lib/secretsUi";
import { useShellCounts } from "@/lib/shellCounts";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useSecrets } from "@/store/secrets";

export function ShellRoleBadge({ taskId, tabId, roleId, active }: { taskId: string; tabId: string; roleId: string; active: boolean }) {
  const { t } = useTranslation("secrets");
  const role = useSecrets(s => s.roles.find(r => r.id === roleId) ?? null);
  // counts only for the shell someone can see: the active tab of the active
  // task.
  const visible = useApp(s => s.activeTaskId === taskId) && active;
  const key = shellBrokerKey(taskId, tabId);
  const counts = useShellCounts(visible ? key : null);
  const foreign = counts?.foreign_token ?? 0;
  const suspicious = (counts?.suspicious ?? 0) - foreign > 0;
  const name = role?.name ?? roleId;
  const colour = suspicious ? "var(--color-err)" : foreign ? "var(--color-warn)" : roleColour(role?.colour);
  const blocked = counts?.blocked ?? 0;
  const tip = suspicious ? "shell.badgeSuspiciousTip" : foreign ? "shell.badgeForeignTip" : "shell.badgeTip";
  return (
    <button
      type="button"
      data-testid="shell-role-badge"
      data-role={roleId}
      data-state-kind={suspicious ? "suspicious" : foreign ? "foreign" : "ok"}
      title={t(tip, { role: name })}
      // the pill selects / drags on these; the badge only opens Activity.
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); useUI.getState().openCageActivity(taskId, key); }}
      onDoubleClick={e => e.stopPropagation()}
      className="flex shrink-0 items-center gap-1 rounded px-1 text-[11px] font-medium hover:bg-[var(--color-hover)]"
      style={{ color: colour }}
    >
      <KeyRound className="h-3 w-3" />
      <span className="max-w-[80px] truncate">{name}</span>
      {blocked > 0 && <span data-testid="shell-role-blocked" className="text-[var(--color-fg-dim)]">· {blocked}</span>}
    </button>
  );
}
