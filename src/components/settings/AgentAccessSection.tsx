// MCP & CLI: how agents on this computer drive Termic, one tab at a time.
// Tab ids are settings tabs ("mcp", "cli"). Phones and other computers are
// Settings > Remote control; servers, Settings > Servers.

import { useTranslation } from "react-i18next";
import { Plug, SquareTerminal } from "lucide-react";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";
import { CliSection } from "./CliSection";
import { McpSection } from "./McpSection";

export function AgentAccessSection({ tab }: { tab: "cli" | "mcp" }) {
  const { t } = useTranslation("settings");
  const openSettings = useApp(s => s.openSettings);
  const shown = tab === "cli" ? "cli" : "mcp";
  const tiles = [
    { id: "mcp", icon: Plug, label: t("access.mcp"), hint: t("access.mcpHint") },
    { id: "cli", icon: SquareTerminal, label: t("access.cli"), hint: t("access.cliHint") },
  ] as const;
  return (
    <>
      <div className="mb-10 grid grid-cols-2 gap-2 text-[13px]" role="tablist">
        {tiles.map(opt => {
          const active = shown === opt.id;
          const Ic = opt.icon;
          return (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`access-tab-${opt.id}`}
              onClick={() => openSettings(opt.id)}
              // No transition-colors: WKWebView does not repaint a themed
              // border-color through a transition (docs/gotchas.md).
              className={cn(
                "flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left",
                active
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-deep)]/15"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
              )}
            >
              <span className="flex items-center gap-1.5 font-medium text-[var(--color-fg)]">
                <Ic className={cn("h-3.5 w-3.5", active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-dim)]")} />
                {opt.label}
              </span>
              <span className="text-[12px] text-[var(--color-fg-faint)]">{opt.hint}</span>
            </button>
          );
        })}
      </div>
      {shown === "cli" && <CliSection />}
      {shown === "mcp" && <McpSection />}
    </>
  );
}
