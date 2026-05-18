// Full-page settings takeover, mirroring Termic's design: a left rail
// with sections + a per-repo list, a right content pane that swaps based on
// the selected section. Reached via the gear icon in the sidebar or ⌘,.

import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { ArrowLeft, Palette, FolderGit2, Settings as SettingsIcon, Keyboard, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppearanceSection } from "./AppearanceSection";
import { RepositorySection } from "./RepositorySection";
import { GeneralSection } from "./GeneralSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { AgentsSection } from "./AgentsSection";

export function Settings() {
  const view = useApp(s => s.view);
  const closeSettings = useApp(s => s.closeSettings);
  const openSettings = useApp(s => s.openSettings);
  const projects = useApp(s => s.projects);

  const tab = view.settingsTab ?? "general";
  const repoId = view.settingsRepoId;
  const isRepoSelected = tab === "repositories" && !!repoId;

  return (
    <div className="relative grid h-full" style={{ gridTemplateColumns: "240px 1fr", gridTemplateRows: "minmax(0, 1fr)" }}>
      {/* Transparent drag strip across the top so the user can move the window
          from the settings view, and so the macOS traffic lights don't overlap
          interactive UI below. Height matches the overlay title-bar area. */}
      <div
        data-tauri-drag-region
        className="absolute left-0 right-0 top-0 z-10 h-10"
        style={{ WebkitAppRegion: "drag" } as any}
      />

      {/* Left rail */}
      <aside className="flex h-full flex-col overflow-hidden border-r border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 pb-3 pt-12">
        <Button variant="ghost" className="mb-3 justify-start gap-2 px-2" onClick={closeSettings}>
          <ArrowLeft className="h-4 w-4" /> Back to app
        </Button>

        <RailItem icon={<SettingsIcon className="h-4 w-4" />} label="General"
          active={tab === "general"} onClick={() => openSettings("general")} />
        <RailItem icon={<Palette className="h-4 w-4" />} label="Appearance"
          active={tab === "appearance"} onClick={() => openSettings("appearance")} />
        <RailItem icon={<Terminal className="h-4 w-4" />} label="Agents"
          active={tab === "agents"} onClick={() => openSettings("agents")} />
        <RailItem icon={<Keyboard className="h-4 w-4" />} label="Shortcuts"
          active={tab === "shortcuts"} onClick={() => openSettings("shortcuts")} />

        <div className="mt-5 px-2 pb-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
          Repositories
        </div>
        {projects.length === 0 && (
          <div className="px-3 py-2 text-[12.5px] text-[var(--color-fg-faint)]">No repositories yet.</div>
        )}
        {projects.map(p => (
          <RailItem
            key={p.id}
            label={p.name}
            active={tab === "repositories" && repoId === p.id}
            onClick={() => openSettings("repositories", p.id)}
          />
        ))}
      </aside>

      {/* Right pane */}
      <section className="min-h-0 overflow-auto">
        <div className="mx-auto max-w-3xl p-8 pt-14">
          {tab === "general"     && <GeneralSection />}
          {tab === "appearance"  && <AppearanceSection />}
          {tab === "agents"      && <AgentsSection />}
          {tab === "shortcuts"   && <ShortcutsSection />}
          {tab === "repositories" && (
            isRepoSelected
              ? <RepositorySection projectId={repoId!} />
              : <div className="text-[13.5px] text-[var(--color-fg-faint)]">Pick a repository on the left to edit its settings.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function RailItem({ icon, label, active, onClick }: {
  icon?: React.ReactNode; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13.5px]",
        active ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      <FolderGit2 className="hidden" /> {/* keep lucide tree-shake happy when we later add per-section icons */}
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
