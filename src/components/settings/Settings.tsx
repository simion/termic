// Full-page settings takeover, mirroring Termic's design: a left rail
// with sections + a per-repo list, a right content pane that swaps based on
// the selected section. Reached via the gear icon in the sidebar or ⌘,.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { Button } from "@/components/ui/Button";
import { X, Palette, FolderGit2, Settings as SettingsIcon, Keyboard, Terminal, Layers, Library, ListTodo, Bell, ShieldCheck, SquareTerminal, Container, UsersRound, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppearanceSection } from "./AppearanceSection";
import { RepositorySection } from "./RepositorySection";
import { GeneralSection } from "./GeneralSection";
import { TasksSection } from "./TasksSection";
import { NotificationsSection } from "./NotificationsSection";
import { SandboxSection } from "./SandboxSection";
import { CliSection } from "./CliSection";
import { McpSection } from "./McpSection";
import { ProfilesSection } from "@/components/settings/ProfilesSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { AgentsSection } from "./AgentsSection";
import { PromptLibrarySection } from "./PromptLibrarySection";
import { DockerSection } from "./DockerSection";

export function Settings() {
  const { t } = useTranslation("settings");
  const view = useApp(s => s.view);
  const closeSettings = useApp(s => s.closeSettings);
  const openSettings = useApp(s => s.openSettings);
  const projects = useApp(s => s.projects);

  const tab = view.settingsTab ?? "general";
  const repoId = view.settingsRepoId;
  const isRepoSelected = tab === "repositories" && !!repoId;

  // Two-step Esc to close: the first press "arms" (the Close button relabels to
  // a confirmation), a second press within 2s closes. Guards against an Esc
  // muscle-memory dismiss losing unsaved input in a section's text fields.
  const [escArmed, setEscArmed] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (escArmed) closeSettings();
      else setEscArmed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escArmed, closeSettings]);
  useEffect(() => {
    if (!escArmed) return;
    const t = setTimeout(() => setEscArmed(false), 2000);
    return () => clearTimeout(t);
  }, [escArmed]);

  return (
    <div className="grid h-full" style={{ gridTemplateColumns: "240px 1fr", gridTemplateRows: "minmax(0, 1fr)" }}>
      {/* Left rail */}
      {/* data-testid: the app's own sidebar is an <aside> too and stays in the
          DOM behind this overlay, so e2e needs an unambiguous handle. */}
      <aside data-testid="settings-rail" className="flex h-full flex-col overflow-hidden border-r border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 py-3">
        <div className="mb-2 border-b border-[var(--color-border-soft)] pb-2">
          <Button
            variant="ghost"
            className={cn(
              "h-10 w-full justify-start gap-2.5 px-3 text-[14px]",
              escArmed && "text-[var(--color-accent)] hover:text-[var(--color-accent)]",
            )}
            onClick={closeSettings}
          >
            <X className="h-[18px] w-[18px]" />
            {escArmed ? t("rail.closeArmed") : t("rail.close")}
          </Button>
        </div>

        {/* The rail scrolls, the version footer does not. Without this the
            footer is the first thing pushed off the bottom, and a machine with
            a dozen projects is exactly where you want to read a version
            number off the screen. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Rail order is: the pages you open by choice, then the ones you set
            once, then the perimeter. Hairlines mark the three bands; they get
            no uppercase labels (PROJECTS earns one only because it is a
            dynamic list with an empty state). */}
        <RailItem icon={<SettingsIcon className="h-4 w-4" />} label={t("rail.general")} tabId="general"
          active={tab === "general"} onClick={() => openSettings("general")} />
        <RailItem icon={<Palette className="h-4 w-4" />} label={t("rail.appearance")} tabId="appearance"
          active={tab === "appearance"} onClick={() => openSettings("appearance")} />
        <RailItem icon={<Terminal className="h-4 w-4" />} label={t("rail.agents")} tabId="agents"
          active={tab === "agents"} onClick={() => openSettings("agents")} />

        <RailDivider />

        <RailItem icon={<ListTodo className="h-4 w-4" />} label={t("rail.tasks")} tabId="tasks"
          active={tab === "tasks"} onClick={() => openSettings("tasks")} />
        <RailItem icon={<Bell className="h-4 w-4" />} label={t("rail.notifications")} tabId="notifications"
          active={tab === "notifications"} onClick={() => openSettings("notifications")} />
        <RailItem icon={<Library className="h-4 w-4" />} label={t("rail.prompts")} tabId="prompts"
          active={tab === "prompts"} onClick={() => openSettings("prompts")} />
        <RailItem icon={<Keyboard className="h-4 w-4" />} label={t("rail.shortcuts")} tabId="shortcuts"
          active={tab === "shortcuts"} onClick={() => openSettings("shortcuts")} />
        {/* Experimental in the sense docs/ui.md defines: off by default because
            we are not yet confident in it, with a stated way out (Profiles
            can be turned off, keeping every byte of data). Both halves of
            this release qualify, and both are dormant until you opt in. */}
        <RailItem icon={<UsersRound className="h-4 w-4" />} label={t("rail.profiles")} badge={t("rail.badgeExp")} tabId="profiles"
          active={tab === "profiles"} onClick={() => openSettings("profiles")} />

        <RailDivider />

        {/* The perimeter: the two pages that change what the app is allowed to
            do. The Experimental badge is a badge, not a separate "Experimental"
            page: the CLI is the only feature that qualifies today, and exiling
            the release's headline feature to a Labs page costs more
            discoverability than the label is worth. See docs/ui.md. */}
        <RailItem icon={<ShieldCheck className="h-4 w-4" />} label={t("rail.sandbox")} tabId="sandbox"
          active={tab === "sandbox"} onClick={() => openSettings("sandbox")} />
        <RailItem icon={<Container className="h-4 w-4" />} label={t("rail.docker")} badge={t("rail.badgeExp")} tabId="docker"
          active={tab === "docker"} onClick={() => openSettings("docker")} />
        <RailItem icon={<SquareTerminal className="h-4 w-4" />} label={t("rail.cli")} tabId="cli"
          active={tab === "cli"} onClick={() => openSettings("cli")} />

        <div className="mt-5 px-2 pb-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
          {t("rail.projects")}
        </div>
        {projects.length === 0 && (
          <div className="px-3 py-2 text-[12.5px] text-[var(--color-fg-faint)]">{t("rail.noProjects")}</div>
        )}
        {projects.map(p => {
          const isMulti = (p.type ?? "single") === "multi";
          return (
            <RailItem
              key={p.id}
              // Multi-repo projects get the same Layers icon used in
              // the main sidebar / breadcrumb, accent-tinted so it
              // pops next to the muted RailItem label.
              icon={isMulti
                ? <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                : undefined}
              label={p.name}
              active={tab === "repositories" && repoId === p.id}
              onClick={() => openSettings("repositories", p.id)}
            />
          );
        })}
        </div>

        <RailFooterVersion />
      </aside>

      {/* Right pane */}
      <section data-testid="settings-pane" className="min-h-0 overflow-auto">
        <div className="mx-auto max-w-5xl p-8">
          {tab === "general"     && <GeneralSection />}
          {tab === "tasks"       && <TasksSection />}
          {tab === "notifications" && <NotificationsSection />}
          {tab === "sandbox"     && <SandboxSection />}
          {tab === "docker"      && <DockerSection />}
          {/* MCP shares the CLI page: one "control plane" surface, two
              presentations of the same verbs (docs/ideas/mcp.md). */}
          {tab === "cli"         && <><CliSection /><div className="mt-10"><McpSection /></div></>}
          {tab === "appearance"  && <AppearanceSection />}
          {tab === "agents"      && <AgentsSection />}
          {tab === "prompts"     && <PromptLibrarySection />}
          {tab === "shortcuts"   && <ShortcutsSection />}
          {tab === "profiles"    && <ProfilesSection />}
          {tab === "repositories" && (
            isRepoSelected
              ? <RepositorySection projectId={repoId!} />
              : <div className="text-[13.5px] text-[var(--color-fg-faint)]">{t("rail.pickProject")}</div>
          )}
        </div>
      </section>
    </div>
  );
}

/** The running version, bottom left.
 *
 *  Reads `useUpdate`, which `App` initialises at boot, so it is already
 *  resolved by the time anyone opens settings. It stays empty outside Tauri
 *  (`getVersion()` is the only source), and an empty footer is better than one
 *  reading "Termic". Clicking opens the changelog: the number and the notes
 *  for it are the same question, and the dialog renders at z-50 over this
 *  overlay's z-40. */
function RailFooterVersion() {
  const { t } = useTranslation("settings");
  const version = useUpdate(s => s.currentVersion);
  // Only while a check is in flight. The RESULT goes to a toast, matching the
  // command palette's "Check for updates" exactly: two surfaces for one action
  // that reported differently would read as two different actions.
  const [checking, setChecking] = useState(false);
  if (!version) return null;
  async function checkForUpdates() {
    if (checking) return;
    setChecking(true);
    try {
      const r = await useUpdate.getState().checkNow();
      useUI.getState().pushToast(
        r === "available" ? t("rail.updateAvailable") : r === "error" ? t("rail.updateCheckFailed") : t("rail.upToDate"),
        r === "error" ? "error" : "success",
      );
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="mt-2 flex shrink-0 items-center gap-1 border-t border-[var(--color-border-soft)] pt-2">
      <button
        data-testid="settings-version"
        onClick={() => useUI.getState().openChangelog()}
        title={t("rail.viewChangelog")}
        className="min-w-0 flex-1 rounded-md px-2.5 py-1.5 text-left text-[11.5px] tabular-nums text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg-dim)]"
      >
        Termic {version}
      </button>
      {/* Icon only: the row is the version line, and a labelled button here
          would compete with it for a rail this narrow. The title carries the
          name for anyone hovering or using a screen reader. */}
      <button
        data-testid="settings-check-updates"
        onClick={() => void checkForUpdates()}
        disabled={checking}
        title={t("rail.checkUpdates")}
        aria-label={t("rail.checkUpdates")}
        className="shrink-0 rounded-md p-1.5 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg-dim)] disabled:opacity-60"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
      </button>
    </div>
  );
}

/** Band separator. Same hairline as the one under "Close settings", inset to
 *  the rail items' text column so it reads as a group break rather than a
 *  second header rule. */
function RailDivider() {
  return <div className="mx-2.5 my-2 h-px bg-[var(--color-border-soft)]" />;
}

function RailItem({ icon, label, badge, tabId, active, onClick }: {
  icon?: React.ReactNode; label: string; badge?: string; tabId?: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      // data-rail-item marks the fixed section rows (not the per-project ones)
      // so e2e can walk the rail in DOM order and prove every entry routes to
      // a rendered page. See e2e/specs/settings.e2e.ts.
      data-rail-item={tabId}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-medium",
        active ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      <FolderGit2 className="hidden" /> {/* keep lucide tree-shake happy when we later add per-section icons */}
      {icon}
      <span className="truncate">{label}</span>
      {badge && (
        <span className="ml-auto shrink-0 rounded bg-[var(--color-bg-3)] px-1 py-px text-[10px] uppercase tracking-wider text-[var(--color-fg-faint)]">
          {badge}
        </span>
      )}
    </button>
  );
}
