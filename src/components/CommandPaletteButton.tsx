// Top-bar button that opens the command palette. The palette was keyboard-only
// (⇧⌘P), which is invisible to anyone who never reads a shortcut list, so the
// bar now carries a visible entry point. The glyph belongs in the tooltip,
// not on the face of the button: a bordered "⇧⌘P" chip sat wrong next to a
// row of bare icons, so this is the same icon button as its neighbours and
// the tooltip does the teaching.
//
// Always rendered, task or not: the palette's global commands (new task,
// project picker, settings, theme) work with nothing selected.

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { SquareChevronRight } from "lucide-react";
import { Tip } from "@/components/ui/Tooltip";
import { Button } from "@/components/ui/Button";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { bindingGlyphs } from "@/lib/shortcuts";

export function CommandPaletteButton() {
  const { t } = useTranslation("chrome");
  // Read the live binding, not the default: the shortcut is rebindable in
  // settings, and a tooltip naming a key that no longer opens anything is
  // worse than a tooltip with no key at all.
  const binding = usePrefs(s => s.shortcuts["command-palette"]);
  const glyphs = binding ? bindingGlyphs(binding).join("") : "";
  const label = `${t("commandPalette.label")}${glyphs ? ` (${glyphs})` : ""}`;

  // Radix's dismissable layer closes the open palette on document pointerdown,
  // BEFORE our click ever fires, so a click handler that reads
  // `commandPaletteOpen` always sees false and reopens what the user just
  // dismissed: the button could never close the palette. Toggling on pointerdown
  // instead runs while the state is still true. Radix registers its outside
  // listener in a setTimeout, so the open case can't be eaten by the same
  // event. onClick stays as the keyboard path (Enter / Space fire no pointer
  // event) and no-ops when pointerdown already handled the press.
  const handledRef = useRef(false);
  const toggle = () => {
    const ui = useUI.getState();
    if (ui.commandPaletteOpen) ui.closeCommandPalette();
    else ui.openCommandPalette();
  };

  return (
    <Tip content={label} side="bottom">
      <Button
        size="icon"
        variant="icon"
        data-no-drag
        data-testid="command-palette-button"
        aria-label={label}
        onPointerDown={(e) => { if (e.button !== 0) return; handledRef.current = true; toggle(); }}
        onClick={() => {
          if (handledRef.current) { handledRef.current = false; return; }
          toggle();
        }}
      >
        <SquareChevronRight className="h-4 w-4" />
      </Button>
    </Tip>
  );
}
