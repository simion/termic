// The accent picker: the palette as round dots, plus a custom colour.
//
// Deliberately the SAME affordance the sidebar uses for group folder colours
// (Sidebar.tsx's Finder-tag row): a 16px round dot, the colour carried by an
// inline background, and selection shown with a ring rather than by growing
// the dot. Filled rounded squares read as badges and shouted over the form
// they sit in.
//
// One component rather than a copy in each dialog, because the New Profile
// wizard and Settings both render this row and a drift between them would be
// two pickers that look like different features.

import { useTranslation } from "react-i18next";
import { ACCENTS, ACCENT_NONE, isHexAccent, profileAccentCss } from "@/lib/accents";
import { cn } from "@/lib/utils";

/** A sensible starting point when the user opens the custom picker having
 *  never chosen a hex: their current palette colour would be ideal, but it is
 *  a `var()` the native input cannot parse, so start from a neutral. */
const CUSTOM_SEED = "#7c8aa0";

export function AccentDots({ value, onChange, idPrefix }: {
  /** A palette key, or a literal hex the user picked. */
  value: string;
  onChange: (next: string) => void;
  /** Scopes the test ids. Two pickers can share a screen (the wizard names
   *  the existing profile and the new one at once), and identical ids meant a
   *  spec silently drove the first and coloured the wrong profile. */
  idPrefix: string;
}) {
  const { t } = useTranslation("chrome");
  const custom = isHexAccent(value);
  return (
    <div className="flex items-center gap-1">
      {/* NO COLOUR, first in the row. A real choice rather than the absence of
          one: a single-profile install, or anyone who finds the title-bar wash
          noisy, needs a way to say so. Drawn as an outlined dot, so it reads
          as an option in the same row rather than as a missing swatch. */}
      <button
        type="button"
        aria-label={t("accentDots.noColour")}
        aria-pressed={value === ACCENT_NONE}
        data-testid={`${idPrefix}-accent-none`}
        onClick={() => onChange(ACCENT_NONE)}
        className="rounded-full p-1 hover:bg-[var(--color-bg-2)]"
        title={t("accentDots.noColour")}
      >
        <span
          className={cn(
            "block h-4 w-4 rounded-full border border-dashed border-[var(--color-fg-faint)]",
            value === ACCENT_NONE
              && "ring-1 ring-[var(--color-fg)] ring-offset-1 ring-offset-[var(--color-bg-1)]",
          )}
        />
      </button>
      {ACCENTS.map(a => (
        <button
          key={a.key}
          type="button"
          aria-label={a.label}
          aria-pressed={value === a.key}
          data-testid={`${idPrefix}-accent-${a.key}`}
          onClick={() => onChange(a.key)}
          className="rounded-full p-1 hover:bg-[var(--color-bg-2)]"
        >
          <span
            className={cn(
              "block h-4 w-4 rounded-full",
              value === a.key
                && "ring-1 ring-[var(--color-fg)] ring-offset-1 ring-offset-[var(--color-bg-1)]",
            )}
            style={{ backgroundColor: a.css }}
          />
        </button>
      ))}

      {/* Custom colour. A native input so the OS picker does the work; it is
          styled down to the same dot so it reads as one more choice in the
          row rather than a different kind of control. */}
      <label
        className="relative rounded-full p-1 hover:bg-[var(--color-bg-2)]"
        title={t("accentDots.customColour")}
      >
        <span
          className={cn(
            "block h-4 w-4 rounded-full",
            custom
              ? "ring-1 ring-[var(--color-fg)] ring-offset-1 ring-offset-[var(--color-bg-1)]"
              // Unset: a conic wheel says "anything else" without claiming a
              // colour the profile does not have.
              : "",
          )}
          style={custom
            ? { backgroundColor: value }
            : { background: "conic-gradient(from 0deg, #d97757, #c9a227, #5e9c76, #4b8bbe, #8b6bb1, #d97757)" }}
        />
        <input
          type="color"
          aria-label={t("accentDots.customColour")}
          data-testid={`${idPrefix}-accent-custom`}
          value={custom ? value : CUSTOM_SEED}
          onChange={e => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

/** One profile's colour, as a dot.
 *
 *  Replaced a square tile carrying the name's first letter. The letter was
 *  redundant everywhere it appeared: the full name is always right next to it,
 *  and a monogram of a one-word name is just that word's first character. It
 *  also read as an avatar, which invited the question of whose account it was.
 *  The dot is the same shape the accent PICKER uses, so the thing you choose
 *  and the thing you then see are visibly the same object.
 */
export function ProfileDot({ accent, className }: { accent: string | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("h-2.5 w-2.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: profileAccentCss(accent) }}
    />
  );
}
