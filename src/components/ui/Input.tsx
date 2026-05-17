import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className={cn(
        // h-9 (36px) is the canonical input height — matches Button size="lg"
        // so Input + Button rows (Browse, Add, etc.) line up at the same
        // baseline. Without an explicit height the input was ~36px from
        // `py-2`, but Button default md is 32px → 4px misalignment.
        "h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[13px] text-[var(--color-fg)]",
        "outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-[3px] focus:ring-[var(--color-accent-soft)]",
        className,
      )}
      {...rest}
    />
  ),
);
Input.displayName = "Input";
