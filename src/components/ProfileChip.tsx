// The profile's identity in the TITLE BAR, and every profile action behind it
// (GH #280).
//
// It lives up here rather than in the sidebar footer, where it started, for
// three reasons that all point the same way:
//
//   - the title bar already carries the profile's accent as a wash from the
//     left edge (`profileWashCss`), so the name sits INSIDE its own colour
//     instead of being a second, disconnected use of it;
//   - the top-left is where the eye lands on a window, which is the whole job
//     of a thing that answers "which profile am I in";
//   - it is the one strip present in every window regardless of what else is
//     open, and the sidebar can be collapsed away entirely.
//
// The prior art is JetBrains, which puts the project name in exactly this
// position over exactly this tint.
//
// DORMANT UNTIL THERE ARE SEVERAL. With no profiles it renders nothing at all:
// naming the one setup you have is an invented distinction, and a permanent
// chip saying "Default" is the trap the whole feature avoids by not existing
// yet. Creating the first profile always creates two (yours gets named too),
// so "profiles exist" and "there are several" are the same condition.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Settings2, UsersRound } from "lucide-react";
import { useProfiles } from "@/store/profiles";
import { useApp } from "@/store/app";
import { profileOpen } from "@/lib/ipc";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { ProfileDot } from "@/components/ui/AccentDots";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";

export function ProfileChip() {
  const { t } = useTranslation("chrome");
  const profiles = useProfiles(s => s.profiles);
  const current  = useProfiles(s => s.current);
  const refresh  = useProfiles(s => s.refresh);
  const openSettings = useApp(s => s.openSettings);
  const [open, setOpen] = useState(false);
  // The row for the profile this window IS, so opening the menu lands on it.
  const currentRowRef = useRef<HTMLButtonElement | null>(null);

  // DORMANT: an icon, not a name. There is nothing to name yet, and calling
  // the one setup you have "Default" is the trap the whole feature avoids by
  // not existing yet, so this is the way IN to profiles rather than a display
  // of one. It replaced the sidebar footer's button, which was the same
  // affordance in the place the identity no longer lives.
  if (profiles.length === 0) {
    return (
      <Tip content={t("profileChip.profiles")} side="bottom">
        <Button
          size="icon"
          variant="icon"
          data-testid="footer-profiles"
          data-no-drag
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={() => openSettings("profiles")}
        >
          <UsersRound className="h-[18px] w-[18px]" />
        </Button>
      </Tip>
    );
  }

  const me = profiles.find(p => p.slug === current);
  // A window whose profile is not in the registry (deleted from another
  // window, mid-refresh) still has to render something rather than vanish.
  const name = me?.name ?? "Termic";

  const switchTo = async (slug: string) => {
    setOpen(false);
    try { await profileOpen(slug); } catch { /* the window may have just closed */ }
    void refresh();
  };

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="profile-chip"
          data-no-drag
          title={t("profileChip.switchTitle", { name })}
          // No background of its own: the bar's accent wash is already behind
          // it, and a second tinted surface inside a tinted one reads as a
          // rendering fault. Hover is the only fill.
          className={cn(
            "flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1",
            "text-left hover:bg-[var(--color-bg-2)]",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {/* A DOT, not a lettered tile. The name is right beside it in full,
              so the letter said nothing the word did not, and a square avatar
              invited the question of whose account it was. */}
          <span data-testid="profile-tile" className="flex shrink-0 items-center">
            <ProfileDot accent={me?.accent} />
          </span>
          <span className="min-w-0 truncate text-[13px] font-medium">{name}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="bottom"
        align="start"
        className="w-60 p-1.5"
        // Radix focuses the FIRST focusable child on open, which is whichever
        // profile happens to sort first rather than the one you are in. The
        // focus ring then sits on "Personal" while the tick sits on "Work",
        // which reads as two different answers to "where am I", and Enter
        // would switch away from the profile the user is looking at.
        onOpenAutoFocus={e => {
          e.preventDefault();
          currentRowRef.current?.focus();
        }}
      >
        <div className="px-2 pb-1.5 pt-1 text-[11px] uppercase tracking-wide opacity-50">{t("profileChip.profiles")}</div>
        {profiles.map(p => (
          <button
            key={p.slug}
            type="button"
            data-testid={`profile-row-${p.slug}`}
            ref={p.slug === current ? currentRowRef : undefined}
            onClick={() => void switchTo(p.slug)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
              "hover:bg-[var(--color-bg-2)]",
            )}
          >
            <ProfileDot accent={p.accent} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {/* Only the CURRENT profile is marked. An "open" tag was here
                too and came out: clicking a row opens or focuses that profile
                either way, so the tag named a distinction the user cannot
                act on differently. */}
            {p.slug === current && <Check className="h-3.5 w-3.5 shrink-0 opacity-70" />}
          </button>
        ))}
        <div className="my-1 h-px bg-[var(--color-border-soft)]" />
        {/* No "New profile..." here. This menu is opened to SWITCH, which
            happens daily; creating one happens once or twice ever, and a
            permanent row for it sits exactly where the next profile row
            would go. Manage profiles leads to the page that creates them,
            which is one click further for the rare action and none for the
            common one. */}
        <button
          type="button"
          data-testid="profile-manage"
          onClick={() => { setOpen(false); openSettings("profiles"); }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--color-bg-2)]"
        >
          <Settings2 className="h-4 w-4 opacity-60" /> {t("profileChip.manageProfiles")}
        </button>
      </PopoverContent>
    </PopoverRoot>
  );
}

/** Keeps this window's registry view fresh. Mounted once, in the sidebar. */
export function useProfilesSync() {
  const refresh = useProfiles(s => s.refresh);
  useEffect(() => {
    void refresh();
    // Any window can create, rename or delete a profile, so every window
    // listens. Rust broadcasts this one deliberately: it is genuinely global.
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("termic://profiles-changed", () => { void refresh(); }).then(f => { un = f; })
    );
    return () => un?.();
  }, [refresh]);
}
