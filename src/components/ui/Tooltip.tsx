import * as RT from "@radix-ui/react-tooltip";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props { content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left"; delay?: number; }

export function Tip({ content, children, side = "top", delay = 0 }: Props) {
  if (!content) return <>{children}</>;
  return (
    // delayDuration: 0 makes the tooltip open the instant the cursor lands
    // on the trigger — no 200ms wait that Radix defaults to. skipDelayDuration
    // also kept at 0 so hopping between adjacent tooltipped buttons doesn't
    // re-introduce a delay. disableHoverableContent skips the bridge logic
    // that holds the tooltip open while the cursor enters the tooltip itself
    // (we never want users hovering into a tooltip — they're labels only).
    <RT.Provider delayDuration={delay} skipDelayDuration={0} disableHoverableContent>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content
            side={side}
            align="center"
            sideOffset={6}
            className={cn(
              // Body-sized 13.5px text (no more squinty tooltips), generous
              // padding so the label isn't crammed against the border.
              "z-[100] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2.5 py-1.5 text-[13.5px] text-[var(--color-fg)] shadow-lg",
              "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
            )}
          >
            {content}
            <RT.Arrow className="fill-[var(--color-bg-2)]" />
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
