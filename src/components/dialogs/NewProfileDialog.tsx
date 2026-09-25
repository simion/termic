// The New Profile wizard (GH #280).
//
// NOT WelcomeDialog. `welcomed` is a one-time onboarding flag and stays
// global, so first-run setup must never replay just because someone made a
// second profile. Two of Welcome's four steps are already answered for a
// profile and are dropped deliberately:
//
//   CLI detection  binary paths are machine facts, and a new profile's agent
//                  registry is SEEDED from the profile that already ran the
//                  detection pass (Rust: profile_create).
//   Agent hooks    installed into the agent's own config dir, which every
//                  profile shares in phase 1.
//   Theme          global. Only the ACCENT is per profile.
//
// Leaving three: identity, tasks path, and (later) projects. Projects are
// added from the new window itself rather than here, because the picker needs
// discovery against the new tasks path and a profile with no projects is a
// legitimate end state.

import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useUI } from "@/store/ui";
import { useProfiles } from "@/store/profiles";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { profileCreate, profileOpen, profileSeededTasksPath } from "@/lib/ipc";
import { profileAccentCss } from "@/lib/accents";
import { AccentDots, ProfileDot } from "@/components/ui/AccentDots";
import { profileWashCss } from "@/lib/accents";
import { currentSetupSummary } from "@/lib/profileScope";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";


export function NewProfileDialog() {
  const { t } = useTranslation("dialogs");
  const open = useUI(s => s.newProfileOpen);
  const setOpen = useUI(s => s.setNewProfileOpen);
  const profiles = useProfiles(s => s.profiles);
  const refresh = useProfiles(s => s.refresh);

  // Creating the FIRST profile turns the current install into "a profile", so
  // it needs a name and a color at that moment or the strip reads "Default"
  // forever. Chrome asks the same question on its first split.
  const isFirst = profiles.length === 0;

  const [name, setName] = useState("");
  const [accent, setAccent] = useState("blue");
  const [existingName, setExistingName] = useState("Personal");
  const [existingAccent, setExistingAccent] = useState("teal");
  const [tasksPath, setTasksPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(""); setAccent("blue");
    setExistingName("Personal"); setExistingAccent("teal");
    setTasksPath(""); setErr(null); setBusy(false);
  }, [open]);

  // Asked, never derived. The dialog states this path as a fact ("Leave empty
  // for ..."), and a second copy of slugify plus a hardcoded app dir made it
  // wrong in dev builds and liable to drift in release ones.
  // What the current setup holds, named in the panel that asks you to name it.
  const projectCount = useApp(s => s.projects.length);
  const taskCount = useApp(s => s.tasks.filter(t => !t.archived).length);
  const [seededPath, setSeededPath] = useState("");
  useEffect(() => {
    let live = true;
    // Asked with the PLACEHOLDER before anything is typed, so the field states
    // its default from the moment the dialog opens rather than staying blank
    // until the user happens to fill the name above it. Still asked, never
    // derived: a second copy of slugify plus a hardcoded app dir is what made
    // this wrong in dev builds before.
    void profileSeededTasksPath(name.trim() || "Work")
      .then(([, path]) => { if (live) setSeededPath(path); })
      .catch(() => { /* preview only: an empty placeholder beats a wrong one */ });
    return () => { live = false; };
  }, [name]);
  const canCreate = name.trim().length > 0 && (!isFirst || existingName.trim().length > 0) && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true); setErr(null);
    try {
      const p = await profileCreate({
        name: name.trim(),
        accent,
        tasksPath: tasksPath.trim(),
        existingName: isFirst ? existingName.trim() : undefined,
        existingAccent: isFirst ? existingAccent : undefined,
      });
      await refresh();
      setOpen(false);
      // A profile opens in a window. Creating one without showing it would
      // leave the user looking at the profile they were already in, wondering
      // whether anything happened.
      await profileOpen(p.slug);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={setOpen}
      title={t("newProfile.title")}
      // No description on the FIRST run: the panel below already explains what
      // is about to happen, and a header that repeats it reads as crowded
      // before the user has read either.
      description={isFirst ? undefined : t("newProfile.description")}
      className="max-w-lg"
      // Radix restores focus to the trigger when a dialog closes, and the
      // trigger is in the window we are about to navigate AWAY from. Left
      // alone, that restore lands after `profile_open` has focused the new
      // window and quietly pulls the user back to the old one.
      onCloseAutoFocus={e => e.preventDefault()}
    >
      <div className="flex flex-col gap-4" data-testid="new-profile-dialog">
        {isFirst && (
          <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] p-3">
            {/* Labelled, and labelled the SAME WAY as the new profile below,
                because the two inputs are a pair and the top one is the
                surprise: nobody opening "New profile" expects to be asked to
                name something that already exists. */}
            <div className="mb-1.5 flex items-center gap-2">
              <label className="text-[12.5px] font-medium">{t("newProfile.yourCurrentSetup")}</label>
              {/* The badge does the work a sentence could not: "this window"
                  in prose reads as chrome, in a pill it reads as a label ON
                  the thing in front of you. */}
              <span className="rounded-[4px] bg-[var(--color-accent-deep)]/20 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">
                {t("newProfile.thisWindow")}
              </span>
            </div>
            <div className="mb-2 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
              {/* Real counts, because they are what makes this unmistakably
                  the user's OWN setup rather than a second empty form. They
                  are also exactly the things people fear a new profile will
                  move. */}
              {currentSetupSummary(projectCount, taskCount)} {t("newProfile.setupNameHint")}
            </div>
            <div className="flex items-center gap-2">
              <ProfileDot accent={existingAccent} />
              <Input
                value={existingName}
                onChange={e => setExistingName(e.target.value)}
                placeholder={t("newProfile.existingPlaceholder")}
                data-testid="existing-profile-name"
                className="flex-1"
              />
            </div>
              <div className="mt-2"><AccentDots value={existingAccent} onChange={setExistingAccent} idPrefix="existing" /></div>
            <TitleBarPreview name={existingName} accent={existingAccent} />
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium">
            {isFirst ? t("newProfile.newLabel") : t("newProfile.nameLabel")}
          </label>
          <div className="flex items-center gap-2">
            <ProfileDot accent={accent} />
            <Input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t("newProfile.namePlaceholder")}
              data-testid="new-profile-name"
              onKeyDown={e => { if (e.key === "Enter" && canCreate) void create(); }}
              className="flex-1"
            />
          </div>
          <div className="mt-2"><AccentDots value={accent} onChange={setAccent} idPrefix="new" /></div>
          <TitleBarPreview name={name} accent={accent} />
        </div>

        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium">{t("newProfile.tasksFolderLabel")}</label>
          <Input
            value={tasksPath}
            onChange={e => setTasksPath(e.target.value)}
            placeholder={seededPath}
            data-testid="new-profile-tasks-path"
          />
          <p className="mt-1 text-[11.5px] text-[var(--color-fg-faint)]">
            {t("newProfile.tasksFolderHint")}{" "}
            {seededPath
              ? <Trans t={t} i18nKey="newProfile.leaveEmptyFor" values={{ path: seededPath }} components={{ code: <code className="mono" /> }} />
              : t("newProfile.leaveEmptyDefault")}
          </p>
        </div>

        {err && (
          <div className="rounded-md border border-[var(--color-danger)] px-3 py-2 text-[12.5px] text-[var(--color-danger)]">
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>{t("common:cancel")}</Button>
          <Button onClick={() => void create()} disabled={!canCreate} data-testid="new-profile-create">
            {busy ? t("newProfile.creating") : t("newProfile.createProfile")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}

/** What the title bar will look like, painted by the SAME function that paints
 *  the real one (`profileWashCss`).
 *
 *  Reused rather than approximated on purpose: a mock drawn with its own
 *  gradient would drift from the bar the moment either changed, and then the
 *  dialog would be quietly lying about the thing it is previewing. Picking an
 *  accent is otherwise a guess, because the wash is deliberately faint and the
 *  dots show the colour at full strength. */
function TitleBarPreview({ name, accent }: { name: string; accent: string }) {
  const { t } = useTranslation("dialogs");
  return (
    <div
      aria-hidden
      className="mt-2 flex h-8 items-center gap-2 overflow-hidden rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2"
      style={{ backgroundImage: profileWashCss(accent, true) }}
    >
      {/* The traffic lights, so the strip reads as a window rather than as a
          coloured box. Grey, not the real red/amber/green: this is about the
          accent, and three saturated dots beside it would be the loudest thing
          in the dialog. */}
      <span className="flex shrink-0 gap-1">
        {[0, 1, 2].map(i => (
          <span key={i} className="h-2 w-2 rounded-full bg-[var(--color-fg-faint)] opacity-40" />
        ))}
      </span>
      <ProfileDot accent={accent} />
      <span className="min-w-0 truncate text-[12px] font-medium text-[var(--color-fg)]">
        {name.trim() || t("newProfile.untitled")}
      </span>
    </div>
  );
}
