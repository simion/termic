// Docker sandbox (experimental) — the global, image-level home for the
// Docker cage. Everything per-machine lives here: the master switch, the
// `docker` availability probe, the editable Dockerfile, and the only place
// the image is built or rebuilt. Per-workspace cage selection lives in the
// workspace sandbox dialog, not here (one image, many workspaces).
//
// Build is deliberately decoupled from spawn: the image is built by an
// explicit action here and never lazily on a PTY spawn (a 2.8GB build on
// the spawn path would freeze the webview). See docs/plans/docker-sandbox.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import {
  settingsLoad, settingsSave,
  dockerCheck, dockerImageStatus, dockerGetDockerfile, dockerDefaultDockerfile,
  dockerSetDockerfile, dockerBuildImage, onDockerBuildLog, onDockerBuildDone,
  type DockerStatus, type DockerImageStatus,
} from "@/lib/ipc";
import type { Settings } from "@/lib/types";
import { Loader2, CircleCheck, CircleAlert, Container } from "lucide-react";

export function DockerSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [image, setImage] = useState<DockerImageStatus | null>(null);

  // Dockerfile editor state.
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const [dockerfile, setDockerfile] = useState("");
  const [savedDockerfile, setSavedDockerfile] = useState("");
  const [dfBusy, setDfBusy] = useState(false);

  // Build state.
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const themeId = usePrefs(s => s.editorThemeId);
  const fontSize = usePrefs(s => s.editorFontSize);
  const themeMode = usePrefs(s => s.themeMode);
  const appIsLight = resolveTheme(themeMode) === "light";

  const enabled = !!settings?.docker_sandbox_enabled;
  const dirty = dockerfile !== savedDockerfile;

  // ── Load everything on mount ──────────────────────────────────────
  const refresh = () => {
    dockerCheck().then(setStatus).catch(() => {});
    dockerImageStatus().then(setImage).catch(() => {});
  };
  useEffect(() => {
    settingsLoad().then(setSettings).catch(() => {});
    dockerGetDockerfile().then(df => { setDockerfile(df); setSavedDockerfile(df); }).catch(() => {});
    refresh();
  }, []);

  // ── CodeMirror init (once) ────────────────────────────────────────
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: dockerfile,
        extensions: [
          history(),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          StreamLanguage.define(dockerFile),
          EditorView.lineWrapping,
          themeComp.current.of([
            resolveEditorTheme(themeId, appIsLight),
            editorSurfaceTheme(fontSize, false),
          ]),
          EditorView.updateListener.of(u => {
            if (u.docChanged) setDockerfile(u.state.doc.toString());
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockerfile.length > 0]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure([
        resolveEditorTheme(themeId, appIsLight),
        editorSurfaceTheme(fontSize, false),
      ]),
    });
  }, [themeId, fontSize, appIsLight]);

  // ── Build log streaming ───────────────────────────────────────────
  useEffect(() => {
    if (!building) return;
    let unlistenLog: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    onDockerBuildLog(line => setBuildLog(l => [...l, line])).then(u => (unlistenLog = u));
    onDockerBuildDone(({ success }) => {
      setBuilding(false);
      setBuildLog(l => [...l, success ? "✓ Build finished." : "✗ Build failed."]);
      refresh();
    }).then(u => (unlistenDone = u));
    return () => { unlistenLog?.(); unlistenDone?.(); };
  }, [building]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ block: "end" }); }, [buildLog]);

  // ── Actions ───────────────────────────────────────────────────────
  async function toggleMaster(next: boolean) {
    if (!settings) return;
    const updated = { ...settings, docker_sandbox_enabled: next };
    setSettings(updated);
    await settingsSave(updated);
  }

  async function saveDockerfile() {
    setDfBusy(true);
    try {
      await dockerSetDockerfile(dockerfile);
      setSavedDockerfile(dockerfile);
      refresh();
    } finally { setDfBusy(false); }
  }

  async function resetDockerfile() {
    const def = await dockerDefaultDockerfile();
    setEditorDoc(def);
    setDockerfile(def);
  }

  function setEditorDoc(text: string) {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }

  async function build(noCache: boolean) {
    // Persist any pending edits first so the build matches the editor.
    if (dirty) { await dockerSetDockerfile(dockerfile); setSavedDockerfile(dockerfile); }
    setBuildLog([]);
    setShowLog(true);
    setBuilding(true);
    await dockerBuildImage(noCache);
  }

  if (!settings) {
    return <div className="text-[13.5px] text-[var(--color-fg-faint)]">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-7">
      <div>
        <h1 className="flex items-center gap-2 text-[20px] font-medium">
          <Container className="h-5 w-5 text-[var(--color-accent)]" />
          Docker sandbox
          <span className="rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--color-fg-dim)]">experimental</span>
        </h1>
        <p className="mt-1 max-w-2xl text-[12.5px] text-[var(--color-fg-dim)]">
          A stronger cage than Seatbelt: the agent runs inside a Docker container and can only touch the
          folders termic mounts (the worktree and its git metadata). Everything else on your Mac is invisible
          to it. One image is shared by every Docker workspace; pick Docker per workspace from its sandbox dialog.
        </p>
      </div>

      {/* Master toggle */}
      <label className="flex items-start gap-3 border-t border-[var(--color-border-soft)] pt-6">
        <Checkbox checked={enabled} onChange={toggleMaster} />
        <div className="min-w-0">
          <div className="text-[14px] font-medium">Enable Docker sandbox</div>
          <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
            While off, no Docker UI appears anywhere and Docker is never invoked. Turn it on, then build the
            image below. Once built, "Docker" becomes selectable in each workspace's sandbox dialog.
          </div>
        </div>
      </label>

      {enabled && (
        <>
          {/* Docker availability */}
          <div className="border-t border-[var(--color-border-soft)] pt-6">
            <div className="text-[14px] font-medium">Docker status</div>
            <DockerAvailability status={status} />
          </div>

          {/* Dockerfile editor */}
          <div className="border-t border-[var(--color-border-soft)] pt-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-medium">Dockerfile</div>
                <div className="mt-0.5 max-w-2xl text-[12.5px] text-[var(--color-fg-dim)]">
                  One generic image for all agents. Edit the commented regions to add MCP servers, CLI tools, or
                  baked skills. Personal logins (agent auth, MCP OAuth) are NOT set up here, just run the agent and
                  log in once inside Docker; those persist via your mounted config directory.
                </div>
              </div>
            </div>
            <div
              ref={hostRef}
              className="mt-2 max-h-[420px] overflow-auto rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)]"
            />
            <div className="mt-3 flex items-center gap-2">
              <Button variant="primary" disabled={!dirty || dfBusy} onClick={saveDockerfile}>
                {dfBusy ? "Saving…" : "Save"}
              </Button>
              <Button variant="secondary" disabled={image?.is_default && !dirty} onClick={resetDockerfile}>
                Reset to default
              </Button>
              {dirty && <span className="text-[12px] text-[var(--color-fg-faint)]">Unsaved edits</span>}
            </div>
          </div>

          {/* Image build */}
          <div className="border-t border-[var(--color-border-soft)] pt-6">
            <div className="text-[14px] font-medium">Image</div>
            <ImageStatusLine image={image} dirty={dirty} />
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="primary"
                disabled={building || !status?.daemon}
                onClick={() => build(false)}
              >
                {building ? <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Building…</span> : "Build image"}
              </Button>
              <Button variant="secondary" disabled={building || !status?.daemon} onClick={() => build(true)}>
                Update agents (rebuild)
              </Button>
              {!status?.daemon && (
                <span className="text-[12px] text-[var(--color-warn,#d08b3a)]">Start Docker to build.</span>
              )}
              {buildLog.length > 0 && (
                <Button variant="ghost" onClick={() => setShowLog(s => !s)}>
                  {showLog ? "Hide log" : "Show log"}
                </Button>
              )}
            </div>
            {showLog && buildLog.length > 0 && (
              <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]">
                {buildLog.join("\n")}
                <div ref={logEndRef} />
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DockerAvailability({ status }: { status: DockerStatus | null }) {
  if (!status) return <div className="mt-1 text-[12.5px] text-[var(--color-fg-faint)]">Checking…</div>;
  if (!status.binary) {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[var(--color-warn,#d08b3a)]">
        <CircleAlert className="h-3.5 w-3.5" /> `docker` not found on PATH. Install Docker Desktop, OrbStack, or colima.
      </div>
    );
  }
  if (!status.daemon) {
    return (
      <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[var(--color-warn,#d08b3a)]">
        <CircleAlert className="h-3.5 w-3.5" /> Docker is installed but the daemon is not running. Start it to build / run.
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[var(--color-fg-dim)]">
      <CircleCheck className="h-3.5 w-3.5 text-[var(--color-ok,#4caf50)]" /> Ready{status.version ? ` · ${status.version}` : ""}
    </div>
  );
}

function ImageStatusLine({ image, dirty }: { image: DockerImageStatus | null; dirty: boolean }) {
  if (!image) return null;
  return (
    <div className="mt-1 flex flex-col gap-1 text-[12.5px]">
      {image.available ? (
        <span className="flex items-center gap-1.5 text-[var(--color-fg-dim)]">
          <CircleCheck className="h-3.5 w-3.5 text-[var(--color-ok,#4caf50)]" />
          Built · <code className="font-mono">{image.last_built_tag ?? image.current_tag}</code>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[var(--color-fg-faint)]">
          <CircleAlert className="h-3.5 w-3.5" /> Not built yet. Build it to use Docker mode in a workspace.
        </span>
      )}
      {(image.stale || dirty) && image.available && (
        <span className="flex items-center gap-1.5 text-[var(--color-warn,#d08b3a)]">
          <CircleAlert className="h-3.5 w-3.5" />
          Dockerfile edited since the last build. Rebuild to apply your changes (workspaces keep using the last built image until then).
        </span>
      )}
    </div>
  );
}
