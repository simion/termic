// Full-page settings takeover, mirroring Termic's design: a left rail
// with sections + a per-repo list, a right content pane that swaps based on
// the selected section. Reached via the gear icon in the sidebar or ⌘,.

import { useEffect, useState } from "react";
import { useApp } from "@/store/app";
import { Button } from "@/components/ui/Button";
import { X, Palette, FolderGit2, Settings as SettingsIcon, Keyboard, Terminal, Layers, Library, ListTodo, Bell, ShieldCheck, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppearanceSection } from "./AppearanceSection";
import { RepositorySection } from "./RepositorySection";
import { GeneralSection } from "./GeneralSection";
import { TasksSection } from "./TasksSection";
import { NotificationsSection } from "./NotificationsSection";
import { SandboxSection } from "./SandboxSection";
import { CliSection } from "./CliSection";
import { McpSection } from "./McpSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { AgentsSection } from "./AgentsSection";
import { PromptLibrarySection } from "./PromptLibrarySection";

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
            {escArmed ? "Esc again to close" : "Close settings"}
          </Button>
        </div>

        {/* Rail order is: the pages you open by choice, then the ones you set
            once, then the perimeter. Hairlines mark the three bands; they get
            no uppercase labels (PROJECTS earns one only because it is a
            dynamic list with an empty state). */}
        <RailItem icon={<SettingsIcon className="h-4 w-4" />} label="General" tabId="general"
          active={tab === "general"} onClick={() => openSettings("general")} />
        <RailItem icon={<Palette className="h-4 w-4" />} label="Appearance" tabId="appearance"
          active={tab === "appearance"} onClick={() => openSettings("appearance")} />
        <RailItem icon={<Terminal className="h-4 w-4" />} label="Agents & Terminals" tabId="agents"
          active={tab === "agents"} onClick={() => openSettings("agents")} />

        <RailDivider />

        <RailItem icon={<ListTodo className="h-4 w-4" />} label="Tasks" tabId="tasks"
          active={tab === "tasks"} onClick={() => openSettings("tasks")} />
        <RailItem icon={<Bell className="h-4 w-4" />} label="Notifications" tabId="notifications"
          active={tab === "notifications"} onClick={() => openSettings("notifications")} />
        <RailItem icon={<Library className="h-4 w-4" />} label="Prompts" tabId="prompts"
          active={tab === "prompts"} onClick={() => openSettings("prompts")} />
        <RailItem icon={<Keyboard className="h-4 w-4" />} label="Shortcuts" tabId="shortcuts"
          active={tab === "shortcuts"} onClick={() => openSettings("shortcuts")} />

        <RailDivider />

        {/* The perimeter: the two pages that change what the app is allowed to
            do. The Experimental badge is a badge, not a separate "Experimental"
            page: the CLI is the only feature that qualifies today, and exiling
            the release's headline feature to a Labs page costs more
            discoverability than the label is worth. See docs/ui.md. */}
        <RailItem icon={<ShieldCheck className="h-4 w-4" />} label="Sandbox" tabId="sandbox"
          active={tab === "sandbox"} onClick={() => openSettings("sandbox")} />
        <RailItem icon={<SquareTerminal className="h-4 w-4" />} label="CLI & MCP" tabId="cli"
          active={tab === "cli"} onClick={() => openSettings("cli")} />

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
      <section data-testid="settings-pane" className="min-h-0 overflow-auto">
        <div className="mx-auto max-w-5xl p-8">
          {tab === "general"     && <GeneralSection />}
          {tab === "tasks"       && <TasksSection />}
          {tab === "notifications" && <NotificationsSection />}
          {tab === "sandbox"     && <SandboxSection />}
          {/* MCP shares the CLI page: one "control plane" surface, two
              presentations of the same verbs (docs/plans/mcp.md). */}
          {tab === "cli"         && <><CliSection /><div className="mt-10"><McpSection /></div></>}
          {tab === "appearance"  && <AppearanceSection />}
          {tab === "agents"      && <AgentsSection />}
          {tab === "prompts"     && <PromptLibrarySection />}
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
