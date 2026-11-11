// The agent picker of the New Task dialog: one segmented row of agent
// pills, each in its brand colour, the picked one filled. Shared with Review
// a PR so the two dialogs pick an agent the same way and cannot drift.

import { useTranslation } from "react-i18next";
import { CliIcon, CLI_BRAND_COLOR } from "@/icons/cli";
import { cn } from "@/lib/utils";

/** What a pill needs from an agent registry entry. `shell` is the plain
 *  terminal choice New Task appends; it is labelled "Terminal". */
export interface AgentPillChoice {
  id: string;
  display_name: string;
  icon_id?: string;
  color?: string;
}

export function AgentPills({ choices, value, onChange, testId, layout = "pills" }: {
  choices: AgentPillChoice[];
  value: string;
  onChange: (id: string) => void;
  testId?: string;
  /** "list": one agent per row, like Settings > Agents, for a pane with room
   *  beside it (the New Task dialog's agent section). */
  layout?: "pills" | "list";
}) {
  const { t } = useTranslation("dialogs");
  if (layout === "list") return (
    <div data-testid={testId} role="radiogroup" className="flex flex-col gap-0.5">
      {choices.map(a => {
        const icon = a.icon_id ?? a.id;
        const on = value === a.id;
        return (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-cli={a.id}
            onClick={() => onChange(a.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]",
              on ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
            )}
          >
            <span className={cn("flex shrink-0", CLI_BRAND_COLOR[icon])} style={CLI_BRAND_COLOR[icon] || !a.color ? undefined : { color: a.color }}>
              <CliIcon cli={icon} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 truncate">{a.id === "shell" ? t("newTask.terminal") : a.display_name}</span>
          </button>
        );
      })}
    </div>
  );
  return (
    <div data-testid={testId} role="radiogroup" className="inline-flex flex-wrap items-stretch gap-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]">
      {choices.map(a => {
        const icon = a.icon_id ?? a.id;
        return (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={value === a.id}
            data-cli={a.id}
            onClick={() => onChange(a.id)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[12.5px] transition-colors",
              value === a.id
                ? "bg-[var(--color-accent-deep)] text-white"
                : cn("text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]", CLI_BRAND_COLOR[icon]),
            )}
            // The theme's brand colour wins where there is one: a registry
            // colour is a single hex (pi's is near-black), unreadable on the
            // other theme. Custom agents, which have no brand class, keep theirs.
            style={value === a.id || CLI_BRAND_COLOR[icon] ? undefined : (a.color ? { color: a.color } : undefined)}
          >
            {/* Local label override: shorten Antigravity → Agy so the
                segmented control fits more comfortably on one row. The global
                display_name stays untouched (used elsewhere in the app). */}
            <CliIcon cli={icon} className="h-3.5 w-3.5" />
            {a.id === "shell" ? t("newTask.terminal") : a.id === "agy" ? "Agy" : a.display_name}
          </button>
        );
      })}
    </div>
  );
}
