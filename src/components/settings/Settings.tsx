// Full-page settings takeover, mirroring Termic's design: a left rail
// with sections + a per-repo list, a right content pane that swaps based on
// the selected section. Reached via the gear icon in the sidebar or ⌘,.

import { useEffect, useState } from "react";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { X, Palette, FolderGit2, Settings as SettingsIcon, Keyboard, Terminal, Layers } from "lucide-react";
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
      <aside className="flex h-full flex-col overflow-hidden border-r border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-2 py-3">
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
            {escArmed ? "Esc again to close" : "Close settings"}
          </Button>
        </div>

        <RailItem icon={<SettingsIcon className="h-4 w-4" />} label="General"
          active={tab === "general"} onClick={() => openSettings("general")} />
        <RailItem icon={<Palette className="h-4 w-4" />} label="Appearance"
          active={tab === "appearance"} onClick={() => openSettings("appearance")} />
        <RailItem icon={<Terminal className="h-4 w-4" />} label="Agent CLIs"
          active={tab === "agents"} onClick={() => openSettings("agents")} />
        <RailItem icon={<Keyboard className="h-4 w-4" />} label="Shortcuts"
          active={tab === "shortcuts"} onClick={() => openSettings("shortcuts")} />

        <div className="mt-5 px-2 pb-1 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-faint)]">
          Projects
        </div>
        {projects.length === 0 && (
          <div className="px-3 py-2 text-[12.5px] text-[var(--color-fg-faint)]">No projects yet.</div>
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
      </aside>

      {/* Right pane */}
      <section className="min-h-0 overflow-auto">
        <div className="mx-auto max-w-5xl p-8">
          {tab === "general"     && <GeneralSection />}
          {tab === "appearance"  && <AppearanceSection />}
          {tab === "agents"      && <AgentsSection />}
          {tab === "shortcuts"   && <ShortcutsSection />}
          {tab === "repositories" && (
            isRepoSelected
              ? <RepositorySection projectId={repoId!} />
              : <div className="text-[13.5px] text-[var(--color-fg-faint)]">Pick a project on the left to edit its settings.</div>
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
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-medium",
        active ? "bg-[var(--color-sel)] text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      <FolderGit2 className="hidden" /> {/* keep lucide tree-shake happy when we later add per-section icons */}
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
