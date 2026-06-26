// The Docker view inside the workspace sandbox dialog. Three load-bearing
// ideas are stated outright + always visible (not behind a tooltip):
//   1. only the mounted paths are visible to the agent,
//   2. the Docker agent is a SEPARATE identity from the OS agent,
//   3. one login is saved and shared across all Docker workspaces.
// Paired with the annotated mount list + the literal command preview, the
// user can always answer "what can this container see, and why?".
//
// See docs/plans/docker-sandbox/design.md ("How it works, explained IN the
// dialog" + "Mount transparency" + "Command preview formatting").

import { useEffect, useState } from "react";
import { Container, Lock, FolderGit2, KeyRound, Terminal as TerminalIcon } from "lucide-react";
import { dockerPreviewCommand, type DockerPreview, type DockerMount } from "@/lib/ipc";

export function WorkspaceDockerPanel({
  workspaceId,
  agentId,
  agentName,
  extraArgs,
  onExtraArgsChange,
}: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  extraArgs: string;
  onExtraArgsChange: (next: string) => void;
}) {
  const [preview, setPreview] = useState<DockerPreview | null>(null);

  // Re-render the preview whenever the workspace, agent, or extra args
  // change — the preview is produced by the SAME render_argv the spawn
  // uses, so what you see is what runs.
  useEffect(() => {
    let alive = true;
    dockerPreviewCommand(workspaceId, agentId)
      .then(p => { if (alive) setPreview(p); })
      .catch(() => {});
    return () => { alive = false; };
  }, [workspaceId, agentId, extraArgs]);

  return (
    <div className="flex flex-col gap-4">
      {/* How it works — always visible explainer. */}
      <div className="rounded-lg border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/[0.06] p-3.5 text-[13px] leading-relaxed text-[var(--color-fg-dim)]">
        <div className="mb-1.5 flex items-center gap-1.5 text-[var(--color-fg)]">
          <Container className="h-4 w-4 text-[var(--color-accent)]" />
          <b>Docker sandbox</b>
        </div>
        <p>
          This agent runs inside a Docker container. It can only touch the files listed below.
          Everything else on your Mac is invisible to it.
        </p>
        <p className="mt-1.5">
          <b className="text-[var(--color-fg)]">It is a separate agent from your normal one.</b>{" "}
          Your Docker {agentName} has its own login, MCP servers, settings, and chat history, kept apart
          from the {agentName} you run outside Docker.
        </p>
        <p className="mt-1.5">
          <b className="text-[var(--color-fg)]">Log in once.</b>{" "}
          The first time, run <code className="mono">/login</code> inside the agent. Your login, MCP servers,
          and history are saved and shared across all your Docker workspaces for this agent, so you set it up
          only once.
        </p>
        <p className="mt-1.5">Your conversations resume the same way they do today.</p>
      </div>

      {/* Mount transparency — every mount, with rw/ro + why + provenance. */}
      <div>
        <div className="mb-1 text-[13px] font-medium text-[var(--color-fg)]">What the container can see</div>
        <div className="flex flex-col gap-1.5">
          {(preview?.mounts ?? []).map((m, i) => <MountRow key={i} mount={m} />)}
          {preview && preview.mounts.length === 0 && (
            <div className="text-[12.5px] text-[var(--color-fg-faint)]">No mounts computed.</div>
          )}
        </div>
      </div>

      {/* Extra args. */}
      <div>
        <div className="text-[13px] font-medium text-[var(--color-fg)]">Extra <code className="mono">docker run</code> args</div>
        <div className="mt-0.5 text-[12px] text-[var(--color-fg-faint)]">
          Appended to the command below (e.g. <code className="mono">--memory 4g</code>, <code className="mono">-e FOO=bar</code>, an extra <code className="mono">-v</code>).
          One token per space, as you'd type them in a shell.
        </div>
        <input
          value={extraArgs}
          onChange={e => onExtraArgsChange(e.target.value)}
          placeholder="--memory 4g"
          className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      {/* Command preview — the literal argv, multi-line. */}
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg)]">
          <TerminalIcon className="h-3.5 w-3.5 text-[var(--color-fg-dim)]" />
          Command preview
          {preview && !preview.image_built && (
            <span className="rounded bg-[var(--color-warn)]/15 px-1.5 py-0.5 text-[11px] font-normal text-[var(--color-warn)]">
              image not built
            </span>
          )}
        </div>
        <pre className="max-h-56 overflow-auto rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]">
          {preview?.preview ?? "…"}
        </pre>
        <div className="mt-1 text-[11.5px] text-[var(--color-fg-faint)]">
          This is exactly what termic runs. The <code className="mono"># comments</code> are display-only.
        </div>
      </div>
    </div>
  );
}

function mountIcon(m: DockerMount) {
  if (m.why.startsWith("git metadata")) return <FolderGit2 className="h-3.5 w-3.5" />;
  if (m.why.includes("login")) return <KeyRound className="h-3.5 w-3.5" />;
  return <Lock className="h-3.5 w-3.5" />;
}

function MountRow({ mount: m }: { mount: DockerMount }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-2.5 py-2">
      <div className="mt-0.5 text-[var(--color-fg-faint)]">{mountIcon(m)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="mono break-all text-[12px] text-[var(--color-fg)]">{m.host}</code>
          <span className="text-[var(--color-fg-faint)]">→</span>
          <code className="mono break-all text-[12px] text-[var(--color-fg-dim)]">{m.container}</code>
          <span className={
            "rounded px-1 py-px text-[10px] " +
            (m.read_only
              ? "bg-[var(--color-bg-2)] text-[var(--color-fg-faint)]"
              : "bg-[var(--color-accent)]/15 text-[var(--color-accent)]")
          }>
            {m.read_only ? "read-only" : "read-write"}
          </span>
          {m.provenance === "implicit" && (
            <span className="rounded bg-[var(--color-bg-2)] px-1 py-px text-[10px] text-[var(--color-fg-faint)]">auto</span>
          )}
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--color-fg-dim)]">{m.why}</div>
      </div>
    </div>
  );
}
