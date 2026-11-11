import * as RT from "@radix-ui/react-tooltip";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left"; delay?: number;
  /** Where the content sits along the trigger. `start` for a tall tooltip
   *  beside a small trigger, so its first line is level with the trigger
   *  rather than the whole box centred on it. */
  align?: "start" | "center" | "end";
  /** Draw the arrow in the border colour so it reads against a dark rail.
   *  The default arrow is filled with the tooltip's own background, which is
   *  right for a one-line label and invisible beside a tall panel. */
  pointer?: boolean;
  /** Keep the trigger in the same tree while `content` is empty, for one
   *  whose tooltip comes and goes. Otherwise every flip swaps the wrapper and
   *  remounts the trigger. */
  stable?: boolean;
}

export function Tip({ content, children, side = "top", delay = 0, align = "center", pointer = false, stable = false }: Props) {
  if (!content && !stable) return <>{children}</>;
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
        {content && <RT.Portal>
          <RT.Content
            side={side}
            align={align}
            sideOffset={6}
            className={cn(
              // Body-sized 13.5px text (no more squinty tooltips), generous
              // padding so the label isn't crammed against the border.
              // max-width keeps long content (e.g. a task-create error)
              // wrapped inside the viewport instead of one clipped line;
              // break-words covers the unbroken tokens paths contain;
              // max-h + overflow stops a multi-line error growing past
              // the viewport top/bottom with no way to read it; pre-wrap
              // keeps git stderr's line structure instead of collapsing
              // it into one paragraph.
              "z-[100] max-w-[min(640px,calc(100vw-2rem))] max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2.5 py-1.5 text-[13.5px] text-[var(--color-fg)] shadow-lg",
              "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
            )}
          >
            {content}
            {pointer
              ? <RT.Arrow width={12} height={7} className="fill-[var(--color-border)]" />
              : <RT.Arrow className="fill-[var(--color-bg-2)]" />}
          </RT.Content>
        </RT.Portal>}
      </RT.Root>
    </RT.Provider>
  );
}
