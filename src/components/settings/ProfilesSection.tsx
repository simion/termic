// Settings -> Profiles (GH #280). Where profiles are created, renamed,
// recolored and deleted.
//
// This page exists even while the feature is dormant: the sidebar footer's
// profile button lands here, and it is where the first profile is made. That
// is the whole surface until one exists, which is what keeps someone who never
// uses profiles from ever seeing a strip, a name or a color.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Check } from "lucide-react";
import { useProfiles } from "@/store/profiles";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AccentDots, ProfileDot } from "@/components/ui/AccentDots";
import { slugWorthShowing } from "@/lib/profileScope";
import { profileWashCss } from "@/lib/accents";
import { profileOpen, profileUpdate, profilesDisable } from "@/lib/ipc";
import { cn } from "@/lib/utils";

export function ProfilesSection() {
  const { t } = useTranslation("settings");
  const profiles = useProfiles(s => s.profiles);
  const current = useProfiles(s => s.current);
  const refresh = useProfiles(s => s.refresh);
  const openNewProfile = useUI(s => s.openNewProfile);
  const setDeleteSlug = useUI(s => s.setDeleteProfileSlug);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center gap-2.5">
          <h2 className="text-[15px] font-semibold">{t("rail.profiles")}</h2>
          {/* Same badge as the rail item, same meaning: off by default because
              we are not confident in it yet, and it can be turned off keeping
              every byte of data. See docs/ui.md. */}
          <span className="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] uppercase tracking-wider text-[var(--color-accent)]">
            {t("shared.experimental")}
          </span>
        </div>
        {/* Two paragraphs, not one block. Three sentences run together read as
            a wall at this size, and the second one answers a different
            question (what is shared) than the first (what a profile is). */}
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
          {t("profiles.desc1")}
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-fg-faint)]">
          {t("profiles.desc2")}
        </p>
      </div>

      {profiles.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-7 text-center">
          <p className="text-[13px] text-[var(--color-fg-dim)]">
            {t("profiles.emptyTitle")}
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg-faint)]">
            {t("profiles.empty1")}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-faint)]">
            {t("profiles.empty2")}
          </p>
          <Button className="mt-4" onClick={openNewProfile} data-testid="profiles-create-first">
            <Plus className="mr-1.5 h-4 w-4" /> {t("profiles.createFirst")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {profiles.map(p => (
            <ProfileRow
              key={p.slug}
              slug={p.slug}
              name={p.name}
              accent={p.accent}
              isCurrent={p.slug === current}
              isOpen={p.open}
              onChanged={() => void refresh()}
              onDelete={() => setDeleteSlug(p.slug)}
              onSwitch={() => { void profileOpen(p.slug).then(() => refresh()).catch(() => {}); }}
            />
          ))}
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={openNewProfile} data-testid="profiles-create">
              <Plus className="mr-1.5 h-4 w-4" /> {t("profiles.newProfile")}
            </Button>
            {/* Backing out of the feature is its own door, and it has to be:
                deleting a profile is refused while its window is open, and the
                last remaining profile is always the one you are looking at.
                This keeps every byte of data; it only stops naming it. */}
            {profiles.length === 1 && (
              <Button
                variant="ghost"
                data-testid="profiles-disable"
                onClick={() => void profilesDisable().then(() => refresh()).catch(() => {})}
              >
                {t("profiles.disable")}
              </Button>
            )}
          </div>
        </div>
      )}

      {profiles.length === 1 && (
        <p className="text-[11.5px] text-[var(--color-fg-faint)]">
          {t("profiles.disableNote")}
        </p>
      )}

    </div>
  );
}

function ProfileRow({ slug, name, accent, isCurrent, isOpen, onChanged, onDelete, onSwitch }: {
  slug: string; name: string; accent: string;
  isCurrent: boolean; isOpen: boolean;
  onChanged: () => void; onDelete: () => void; onSwitch: () => void;
}) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState(name);
  // Re-seed when the store changes underneath (another window renamed it).
  useEffect(() => { setDraft(name); }, [name]);

  const commitName = () => {
    const next = draft.trim();
    if (!next || next === name) { setDraft(name); return; }
    void profileUpdate(slug, next).then(onChanged).catch(() => setDraft(name));
  };

  return (
    <div
      data-testid={`profile-settings-row-${slug}`}
      className="flex items-center gap-3 rounded-lg border border-[var(--color-border-soft)] p-3"
      // The SAME wash the title bar carries, from the same function. A row
      // here and the bar in that profile's window are the same object seen
      // twice, so they are painted by one rule: approximating it with a second
      // gradient would drift the moment either changed.
      style={{ backgroundImage: profileWashCss(accent, true) }}
    >
      <div className="min-w-0 flex-1">
        {/* The dot sits on the NAME's line. Beside the block it centred itself
            against the whole three-row stack and landed next to the accent
            picker, reading as a tenth swatch rather than as this profile's
            colour. */}
        {/* Dot, name and colours on ONE line. The input is sized to a profile
            name rather than stretched to the row: a full-width field promises
            a paragraph and got two words, and it pushed the colours onto a
            line of their own where they read as unrelated to the name. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex items-center gap-2">
            <ProfileDot accent={accent} />
            <Input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={e => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") { setDraft(name); (e.target as HTMLInputElement).blur(); }
              }}
              data-testid={`profile-name-${slug}`}
              className="h-7 w-44"
            />
          </div>
          <AccentDots
            value={accent}
            idPrefix={`profile-${slug}`}
            onChange={next => void profileUpdate(slug, undefined, next).then(onChanged).catch(() => {})}
          />
        </div>
        {/* The slug is frozen and names the folders on disk, so it is shown
            when it differs from the name and hidden when it is just the name
            lowercased: "Personal" above "personal" reads as a bug rather than
            as information. */}
        {slugWorthShowing(name, slug) && (
          <div className="mt-1 pl-[18px] text-[11px] text-[var(--color-fg-faint)]">
            <code className="mono">{slug}</code>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {isCurrent ? (
          <span className="flex items-center gap-1 text-[11.5px] text-[var(--color-fg-dim)]">
            <Check className="h-3.5 w-3.5" /> {t("profiles.thisWindow")}
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={onSwitch} data-testid={`profile-switch-${slug}`}>
            {isOpen ? t("profiles.focus") : t("common:open")}
          </Button>
        )}
        {/* Deleting the profile you are IN is refused by Rust (its window is
            open), so the button is disabled here rather than failing later. */}
        <Button
          size="icon"
          variant="icon"
          title={isCurrent ? t("profiles.closeFirst") : t("profiles.deleteProfile")}
          disabled={isCurrent}
          onClick={onDelete}
          data-testid={`profile-delete-${slug}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
