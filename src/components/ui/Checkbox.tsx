// Themed checkbox. Built from a styled button + lucide Check so we
// don't drag in a Radix dep just for this AND so the visual matches
// the rest of the toolkit (accent fill when on, dim border when off,
// hover-brighten). Controlled-only — pair with React state.
//
// The native <input type="checkbox"> with `accent-…` looks crusty
// in dark mode (system-painted square, OS-specific) and ignored most
// of our palette. This component renders as a proper accent-tinted
// chip that matches the theme.

import { Check } from "lucide-react";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onChange?: (next: boolean) => void;
  /** Sets a slightly muted look — use when the row itself is disabled. */
  disabled?: boolean;
}

export const Checkbox = forwardRef<HTMLButtonElement, Props>(
  ({ checked, onChange, disabled, className, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange?.(!checked); }}
      className={cn(
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-soft)]",
        checked
          ? "border-[var(--color-accent-deep)] bg-[var(--color-accent-deep)] text-white hover:brightness-110"
          : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-accent-soft)]",
        disabled && "opacity-40 cursor-not-allowed",
        className,
      )}
      {...rest}
    >
      {checked && <Check className="h-3 w-3 stroke-[3]" />}
    </button>
  ),
);
Checkbox.displayName = "Checkbox";
