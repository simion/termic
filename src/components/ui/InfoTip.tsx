import { Info } from "lucide-react";
import { Tip } from "@/components/ui/Tooltip";

/** An (i) that holds explanatory text a form does not need on screen. The
 *  text is its aria-label too, so a screen reader (and a spec) gets it
 *  without hovering. It takes focus, and focus opens it, so if it can be a
 *  dialog's first tabbable, point the dialog's `onOpenAutoFocus` at a field,
 *  or the open tooltip eats the first Escape (docs/gotchas.md).
 *
 *  A focusable span, not a button: a button is labelable, so inside a
 *  `<label>` with no `for` it would become the labelled control instead of
 *  the input. The click is swallowed for the same reason, or it would reach
 *  the label and toggle its control. Newlines in `text` are kept. */
export function InfoTip({ text, side }: { text: string; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <Tip side={side} content={<span className="block max-w-[340px] whitespace-pre-line">{text}</span>}>
      <span
        tabIndex={0}
        role="img"
        aria-label={text}
        data-info-tip
        onClick={e => e.preventDefault()}
        className="inline-flex shrink-0 cursor-help items-center rounded-full align-middle text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]"
      >
        <Info className="h-3.5 w-3.5" />
      </span>
    </Tip>
  );
}
