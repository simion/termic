// Docker sandbox (experimental) — the global, image-level home for the
// Docker cage. Everything per-machine lives here: the master switch, the
// `docker` availability probe, the editable Dockerfile, and the only place
// the image is built or rebuilt. Per-task cage selection lives in the
// task sandbox dialog, not here (one image, many tasks).
//
// Build is deliberately decoupled from spawn: the image is built by an
// explicit action here and never lazily on a PTY spawn (a multi-GB build on
// the spawn path would freeze the webview). See docs/docker-sandbox.

import { useEffect, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { usePrefs, resolveTheme } from "@/store/prefs";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import {
  dockerCheck, dockerImageStatus, dockerGetDockerfile, dockerDefaultDockerfile,
  dockerSetDockerfile, dockerBuildImage, onDockerBuildLog, onDockerBuildDone, dockerAgentDirs,
  settingsSave, dockerCommandPreview,
  type DockerStatus, type DockerImageStatus, type DockerAgentDirs,
  type DockerCommandPreview,
} from "@/lib/ipc";
import type { Settings } from "@/lib/types";
import { Block, ListField, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { DockerRebuildFrequencyPicker } from "@/components/DockerRebuildFrequencyPicker";
import { describeLastBuildDate } from "@/lib/dockerDailyRebuild";
import { cn, cleanLines } from "@/lib/utils";
import { formatDockerArgv } from "@/lib/dockerArgv";
import { Loader2, CircleCheck, CircleAlert, ChevronDown, Lock, X, Container } from "lucide-react";

export function DockerSection() {
  const { t } = useTranslation("settings");
  const { settings, patch, store } = useBackendSettings();
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [image, setImage] = useState<DockerImageStatus | null>(null);
  const [agentDirs, setAgentDirs] = useState<DockerAgentDirs[]>([]);
  const [showAgentDirs, setShowAgentDirs] = useState(false);
  // Command preview (collapsed by default, same "look it up" treatment as
  // the per-agent dirs above). Rendered by Rust through the SAME
  // build_spec/render_argv the real spawn uses, against a placeholder task,
  // so it can't drift from what actually runs.
  const [showPreview, setShowPreview] = useState(false);
  // Collapsed by default: see the Dockerfile block's comment - it is the
  // one section on this page whose mere presence costs something.
  const [showDockerfile, setShowDockerfile] = useState(false);
  const [previewAgent, setPreviewAgent] = useState("");
  const [preview, setPreview] = useState<DockerCommandPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Default extra mounts: seeded into a new Docker-sandboxed task's own
  // "Extra mounts" field (Sandbox dialog / New task dialog), same
  // host_path:container_path shape, same explicit dirty/Save pattern as
  // "Global sandbox defaults" (SandboxSection) - a textarea wants an
  // explicit commit, unlike the toggles above which patch on every change.
  const [defaultMounts, setDefaultMounts] = useState("");
  const [defaultMountsOriginal, setDefaultMountsOriginal] = useState("");
  const [mountsBusy, setMountsBusy] = useState(false);
  const mountsHydrated = useRef(false);
  useEffect(() => {
    if (!settings || mountsHydrated.current) return;
    mountsHydrated.current = true;
    const v = (settings.docker_default_extra_mounts ?? []).join("\n");
    setDefaultMounts(v);
    setDefaultMountsOriginal(v);
  }, [settings]);
  const defaultMountsDirty = defaultMounts !== defaultMountsOriginal;
  async function saveDefaultMounts() {
    if (!settings) return;
    setMountsBusy(true);
    try {
      const next: Settings = { ...settings, docker_default_extra_mounts: cleanLines(defaultMounts) };
      await settingsSave(next);
      store(next);
      setDefaultMountsOriginal(defaultMounts);
    } finally { setMountsBusy(false); }
  }

  // Dockerfile editor state.
  // A callback ref backed by STATE, not a plain ref. The editor mounts in an
  // effect that needs the host div to exist, and the whole section lives
  // behind `{enabled && …}`: with Docker off at page load the div does not
  // exist yet, so the effect ran, found no host, and returned - and since it
  // was keyed on `dfLoaded` alone it never ran again once the user enabled
  // Docker and the div appeared. The result was a Dockerfile section with its
  // Save / Reset buttons and no editor at all. Making the host a state value
  // means the effect re-runs the moment it mounts, whatever order that
  // happens in. The new first-run button drives everyone through exactly this
  // path (open the page with Docker off, click enable), so it went from a
  // corner to the default.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const [dockerfile, setDockerfile] = useState("");
  const [savedDockerfile, setSavedDockerfile] = useState("");
  const [dfLoaded, setDfLoaded] = useState(false);
  const [dfBusy, setDfBusy] = useState(false);

  // Build state.
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const themeMode = usePrefs(s => s.themeMode);
  const appIsLight = resolveTheme(themeMode) === "light";
  const editorThemeIdDark = usePrefs(s => s.editorThemeIdDark);
  const editorThemeIdLight = usePrefs(s => s.editorThemeIdLight);
  const themeId = appIsLight ? editorThemeIdLight : editorThemeIdDark;
  const fontSize = usePrefs(s => s.editorFontSize);

  const enabled = !!settings?.docker_sandbox_enabled;
  const dirty = dockerfile !== savedDockerfile;

  // ── Load everything on mount ──────────────────────────────────────
  const refresh = () => {
    dockerCheck().then(setStatus).catch(() => {});
    dockerImageStatus().then(setImage).catch(() => {});
    dockerAgentDirs().then(setAgentDirs).catch(() => {});
  };
  useEffect(() => {
    dockerGetDockerfile()
      .then(df => { setDockerfile(df); setSavedDockerfile(df); })
      .catch(() => {})
      .finally(() => setDfLoaded(true));
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  // ── CodeMirror init (once, after the Dockerfile has loaded so the
  // editor is built with its real content in one shot, no throwaway
  // empty-doc instance swapped out a tick later) ──────────────────────
  useEffect(() => {
    if (!dfLoaded || !host || viewRef.current) return;
    let cancelled = false;
    // Dynamic import: @codemirror/legacy-modes is ~150 grammars and this is
    // the only place in the app that wants the Dockerfile one, so it must
    // not join the main chunk (src/lib/languageExts.ts does the same for
    // every legacy-modes grammar; enforced by mainChunkGuard.test.ts).
    import("@codemirror/legacy-modes/mode/dockerfile").then(({ dockerFile }) => {
      if (cancelled || !host || viewRef.current) return;
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
        parent: host,
      });
      viewRef.current = view;
    });
    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dfLoaded, host]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure([
        resolveEditorTheme(themeId, appIsLight),
        editorSurfaceTheme(fontSize, false),
      ]),
    });
  }, [themeId, fontSize, appIsLight]);

  // ── Build log streaming ───────────────────────────────────────────
  // Owned by `build()`, which registers these BEFORE invoking the build.
  // This used to be a `[building]` effect, so the listeners only attached
  // after React committed `building: true` and then resolved a promise - a
  // build that failed fast (Dockerfile syntax error, or the daemon stopping
  // between the status probe and the click) emitted `done` before anything
  // was listening, and the button sat on "Building…" over an empty log with
  // no way back. Cleaned up here on unmount.
  const buildUnlistenRef = useRef<Array<() => void>>([]);
  useEffect(() => () => {
    for (const u of buildUnlistenRef.current) u();
    buildUnlistenRef.current = [];
  }, []);

  // NOT scrollIntoView: it walks every scrollable ancestor to bring the
  // target into view, including the Settings pane itself, so the whole
  // page jittered up and down on every log line (build output streams in
  // several times a second). Scrolling only the log's own container keeps
  // the nudge local to the thing that's actually scrolling.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buildLog]);

  // ── Actions ───────────────────────────────────────────────────────
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
    // Deliberately NOT saved here: reset fills the editor, Save commits it,
    // same as any other edit. The status line reads "unsaved edits" until
    // then, which is the honest answer - the file on disk is still the old
    // one, and so is the image that would be built from it.
  }

  // Refetch on open and on agent change. Keyed on the agent id (a string),
  // never on an array identity, so an unrelated settings reload can't blank
  // an open panel.
  useEffect(() => {
    if (!showPreview) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewErr(null);
    dockerCommandPreview(undefined, previewAgent || undefined)
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(e => { if (!cancelled) { setPreview(null); setPreviewErr(String(e)); } })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [showPreview, previewAgent]);

  function setEditorDoc(text: string) {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }

  // What the single build button should do, from the state it can see.
  // `image.stale` means the Dockerfile's hash no longer matches the built
  // tag; `dirty` means the editor has unsaved edits. Either way a cached
  // build is the right one, because the changed layers are invalidated by the
  // change itself. Only for an image that is current AND unedited does the
  // cached build become pointless, and --no-cache the sole useful action.
  const imageNeedsBuilding = !image?.available || !!image?.stale || dirty;
  const buildNeedsNoCache = !imageNeedsBuilding;
  const buildLabel = !image?.available
    ? t("docker.buildImage")
    : imageNeedsBuilding
      ? t("docker.rebuildImage")
      : t("docker.updateAgents");

  /** First-run path: flip the switch and start the build in one click. The
   *  setting is persisted BEFORE the build starts, so a build the user
   *  abandons (or that fails) still leaves Docker enabled with the rest of
   *  the page visible, rather than reverting and looking like the click did
   *  nothing. */
  async function enableAndBuild() {
    const ok = await patch({ docker_sandbox_enabled: true });
    if (!ok) return;
    await build(false);
  }

  async function build(noCache: boolean) {
    // Persist any pending edits first so the build matches the editor.
    // Goes through the same dfBusy flag as the explicit Save button so
    // the two can't race and write the Dockerfile out of order.
    if (dirty) {
      setDfBusy(true);
      try { await dockerSetDockerfile(dockerfile); setSavedDockerfile(dockerfile); }
      finally { setDfBusy(false); }
    }
    setBuildLog([]);
    setShowLog(true);
    setBuilding(true);
    // Drop any handles from a previous build, then attach and AWAIT the
    // registration before the build can emit anything.
    for (const u of buildUnlistenRef.current) u();
    buildUnlistenRef.current = [];
    const stop = () => {
      for (const u of buildUnlistenRef.current) u();
      buildUnlistenRef.current = [];
    };
    const unlistenLog = await onDockerBuildLog(line => setBuildLog(l => [...l, line]));
    const unlistenDone = await onDockerBuildDone(({ success }) => {
      setBuilding(false);
      setBuildLog(l => [...l, success ? t("docker.buildOk") : t("docker.buildFail")]);
      refresh();
      stop();
    });
    buildUnlistenRef.current = [unlistenLog, unlistenDone];
    try {
      await dockerBuildImage(noCache);
    } catch (e) {
      // The invoke itself failed, so no `done` event is coming and nothing
      // would ever clear the spinner.
      setBuilding(false);
      setBuildLog(l => [...l, `✗ ${String(e)}`]);
      stop();
    }
  }

  if (!settings) {
    return <div className="text-[13.5px] text-[var(--color-fg-faint)]">{t("common:loading")}</div>;
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title={t("rail.docker")} badge={t("shared.experimental")} />
      <p className="text-[12.5px] text-[var(--color-fg-dim)]">
        {t("docker.intro")}
      </p>

      {/* Always visible, not a <details>: the sandbox dialog tried collapsing
          similar material once and users missed what was already answered,
          then re-litigated it in the "Extra" fields (see the comment on the
          removed <details> in TaskSandboxDialog.tsx).

          Three lines, one per thing that differs from what a reader expects.
          It was four paragraphs, and a wall nobody reads answers nothing:
          the long "Logins" explanation is the same thing the Persisted
          directories box says at greater length, and "Agent updates" now
          lives in the Rebuild frequency description, which is the control it
          is actually about. What has to survive any further trim is the
          NETWORK line - it is the one place this page admits the cage is
          weaker than Seatbelt's. */}
      <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3.5 py-3 text-[12.5px] text-[var(--color-fg-dim)]">
        <div>
          <b className="text-[var(--color-fg)]">{t("docker.fsLabel")}</b>
          {t("docker.fsBody")}
        </div>
        <div>
          <b className="text-[var(--color-fg)]"><u>{t("docker.netLabel")}</u></b>{t("docker.netBody")}
        </div>
        <div>
          <b className="text-[var(--color-fg)]">{t("docker.loginsLabel")}</b>
          <Trans
            t={t}
            i18nKey="docker.loginsBody"
            components={{ 1: <code className="font-mono" /> }}
          />
        </div>
      </div>

      {/* First run is ONE action, not a toggle plus a hunt. Flipping the
          boolean alone accomplishes nothing visible - the feature stays
          unusable until an image exists, and the button that builds one was
          far below, past four sections the user has no reason to read yet.
          Once an image exists this becomes the ordinary toggle, because from
          then on they really are separate decisions: turning Docker off
          should not throw the image away. */}
      <Block first>
        {!enabled && !image?.available ? (
          <div className="flex flex-col gap-2.5">
            <div>
              <div className="text-[14px] font-medium">{t("docker.firstRun.title")}</div>
              <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                {t("docker.firstRun.hint")}
              </div>
            </div>
            <div>
              <Button
                variant="primary"
                size="lg"
                disabled={!status?.daemon || building}
                onClick={enableAndBuild}
                data-testid="docker-enable-and-build"
              >
                {building
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> {t("docker.firstRun.building")}</>
                  : <><Container className="h-4 w-4" /> {t("docker.firstRun.enableAndBuild")}</>}
              </Button>
              {!status?.binary && (
                <div className="mt-2 text-[12.5px] text-[var(--color-warn)]">
                  {t("docker.firstRun.notInstalled")}
                </div>
              )}
              {status?.binary && !status?.daemon && (
                <div className="mt-2 text-[12.5px] text-[var(--color-warn)]">
                  {t("docker.firstRun.notRunning")}
                </div>
              )}
            </div>
          </div>
        ) : (
          <Toggle
            label={t("docker.enable.label")}
            hint={t("docker.enable.hint")}
            value={enabled}
            onChange={v => patch({ docker_sandbox_enabled: v })}
          />
        )}
      </Block>

      {enabled && (
        <>
          {/* EVERYTHING about the image, in one group: whether Docker is
              reachable and an image exists, the buttons that build it, how
              often it goes stale, the Dockerfile it is built from, and the
              command a launch will actually run. These were four separate
              groups spread down the page (Status / Configuration / Advanced /
              Verify) and answering "is my image right?" meant visiting all
              four. The two long ones collapse, so the landing view stays the
              short answer and the detail is one click away.  */}
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">{t("docker.imageHeading")}</div>
          {/* One block, two columns: both are one-line readouts of the same
              question, and stacking them made a short answer occupy a whole
              screen of vertical space. The build actions stay full width
              underneath, since they act on the image AND need Docker up -
              they belong to the row, not to either column. */}
          <Block>
            {/* Reads left to right the way the thing works: the RECIPE, the
                IMAGE built from it, and whether Docker itself is up. The
                daemon is last and smallest on purpose - it is a precondition
                you check once and then forget, not something you act on here.
                The Dockerfile is a shortcut as well as a status: whether it
                is still the shipped file is exactly the question you ask
                before opening the editor, and clicking it opens the editor
                below rather than making you go find it.

                Widths follow the content, not the count: the image tag is the
                longest string on the row and must not wrap, while "Default"
                and "Ready · 29.4.0" need almost nothing. */}
            <div className="grid grid-cols-[0.8fr_1.5fr_0.8fr] gap-x-5 gap-y-1">
              <button
                type="button"
                data-testid="docker-dockerfile-status"
                onClick={() => setShowDockerfile(v => !v)}
                title={showDockerfile ? t("docker.hideDockerfile") : t("docker.editDockerfile")}
                className="group min-w-0 text-left"
              >
                <div className="flex items-center gap-1 text-[14px] font-medium">
                  {t("docker.dockerfileHeading")}
                  <ChevronDown className={cn(
                    "h-3.5 w-3.5 shrink-0 text-[var(--color-fg-faint)] transition-transform group-hover:text-[var(--color-fg-dim)]",
                    showDockerfile && "rotate-180",
                  )} />
                </div>
                <DockerfileStatusLine isDefault={!!image?.is_default} dirty={dirty} />
              </button>
              <div className="min-w-0">
                <div className="text-[14px] font-medium">{t("docker.imageLabel")}</div>
                <ImageStatusLine image={image} />
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-medium">{t("docker.dockerLabel")}</div>
                <DockerAvailability status={status} />
              </div>
            </div>
            {/* A Dockerfile saved before gh / glab shipped has no idea they
                exist, and the mounted login dir for them is wired up either
                way, so the failure a user would otherwise hit is `gh: command
                not found` inside a container with a perfectly good login
                sitting next to it. OUTSIDE the collapse: a warning nobody can
                see until they open the thing it is warning about is not a
                warning. Keyed on the apt repo line rather than on the word
                "gh", which appears in ordinary prose all over this page. */}
            {!!savedDockerfile && !dockerfile.includes("cli.github.com") && (
              <div className="mt-3 flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--color-warn)]">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <Trans
                    t={t}
                    i18nKey="docker.cliWarn"
                    components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
                  />
                </span>
              </div>
            )}

            {/* The editor opens HERE, under the column that toggles it, rather
                than in a section of its own further down the page - which is
                where it used to live, and meant clicking "Dockerfile" scrolled
                you somewhere else to find what you just asked for.
                It stays collapsed by default because it is the one expensive
                thing on this page: CodeMirror plus a dynamic import of the
                dockerfile grammar used to mount on EVERY visit, for something
                most visits never open. Closed, the ref is null and the init
                effect's cleanup destroys the view, so the editor exists only
                while it is on screen. Its Save / Reset sit with it, and the
                image-level build button stays below: one edits the recipe,
                the other acts on it. */}
            {showDockerfile && (
              <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3">
                <div className="text-[12.5px] text-[var(--color-fg-dim)]">
                  {t("docker.editorHint")}
                </div>
                <div
                  ref={setHost}
                  className="mt-2 max-h-[420px] overflow-auto rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)]"
                />
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="primary" disabled={!dirty || dfBusy || building} onClick={saveDockerfile}>
                    {dfBusy ? t("common:saving") : t("common:save")}
                  </Button>
                  <Button variant="secondary" disabled={(image?.is_default && !dirty) || dfBusy || building} onClick={resetDockerfile}>
                    {t("docker.resetDefault")}
                  </Button>
                </div>
              </div>
            )}

            {/* ONE button, because the two were only ever one real choice.
                "Build image" was a CACHED build and "Update agents" the same
                build with --no-cache; the Dockerfile installs agents unpinned,
                so a cached build of an unchanged Dockerfile replays identical
                layers and updates nothing at all. Two buttons where one is a
                no-op is a question the user has to answer with knowledge of
                Docker's layer cache, which is not knowledge this page should
                require. The state decides instead:

                  no image        build it (cache is empty anyway)
                  Dockerfile edited / stale   rebuild, cache handles the rest
                  current + clean the only useful action is --no-cache, which
                                  is what actually picks up newer agents */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                disabled={building || dfBusy || !status?.daemon}
                onClick={() => build(buildNeedsNoCache)}
                title={buildNeedsNoCache
                  ? t("docker.buildTipNoCache")
                  : t("docker.buildTipCached")}
              >
                {building
                  ? <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("docker.building")}</span>
                  : buildLabel}
              </Button>
              {!status?.daemon && (
                <span className="text-[12px] text-[var(--color-warn)]">{t("docker.startToBuild")}</span>
              )}
              {/* The reason to press the button, beside the button. In the
                  Image column it was a three-line paragraph that pushed the
                  row out of shape to say something the button already implies
                  the moment you read it here. */}
              {(image?.stale || dirty) && image?.available && status?.daemon && (
                <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-warn)]">
                  <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                  {t("docker.staleWarn")}
                </span>
              )}
              {buildLog.length > 0 && (
                <Button variant="ghost" onClick={() => setShowLog(s => !s)}>
                  {showLog ? t("docker.hideLog") : t("docker.showLog")}
                </Button>
              )}
            </div>
            {showLog && buildLog.length > 0 && (
              <pre
                ref={logRef}
                className="mt-3 max-h-64 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]"
              >
                {buildLog.join("\n")}
              </pre>
            )}
          </Block>


          {/* Rebuild nudge frequency. Undefined reads as "daily" (matching
              the Rust-side default) since a fresh settings object may not
              carry the field yet. */}
          <Block>
            <div className="text-[14px] font-medium">{t("docker.rebuild.title")}</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              {t("docker.rebuild.hint")}
            </div>
            <div className="mt-2 max-w-xs">
              <DockerRebuildFrequencyPicker
                value={settings.docker_rebuild_frequency ?? "daily"}
                onChange={v => patch({ docker_rebuild_frequency: v })}
              />
            </div>
            {/* OUTSIDE the max-w-xs above, which exists to keep the three
                segmented buttons from stretching across the page. A sentence
                nested in it wrapped at 320px into a narrow column while the
                paragraph above ran the full width. */}
            {(settings.docker_rebuild_frequency ?? "daily") !== "off" && (
              <label className="mt-3 flex cursor-pointer items-start gap-2 select-none">
                <Checkbox
                  checked={!!settings.docker_rebuild_auto}
                  onChange={(v: boolean) => patch({ docker_rebuild_auto: v })}
                />
                <span className="text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
                  <span className="font-medium text-[var(--color-fg)]">{t("docker.rebuild.auto")}</span>{" "}
                  {t("docker.rebuild.autoBody")}
                </span>
              </label>
            )}
          </Block>

          {/* Command preview. The task sandbox dialog has one per task; this
              is the same thing before any task exists, so "what does the cage
              actually do" is answerable while you are configuring the image
              rather than only after you have switched a task onto it. The
              agent's own command is appended by render_argv, so the last line
              is literally what runs inside the container. */}
          <Block>
            <button
              type="button"
              onClick={() => setShowPreview(s => !s)}
              data-testid="docker-preview-toggle"
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <div>
                <div className="text-[14px] font-medium">{t("docker.preview.title")}</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  <Trans
                    t={t}
                    i18nKey="docker.preview.sub"
                    components={{ 1: <code className="font-mono" /> }}
                  />
                </div>
              </div>
              <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--color-fg-faint)] transition-transform", showPreview && "rotate-180")} />
            </button>
            {showPreview && (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <label className="text-[12.5px] text-[var(--color-fg-dim)]">{t("docker.preview.agentLabel")}</label>
                  <select
                    value={previewAgent}
                    onChange={(e) => setPreviewAgent(e.target.value)}
                    data-testid="docker-preview-agent"
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                  >
                    <option value="">{t("docker.preview.firstAgent")}</option>
                    {agentDirs.map(a => (
                      <option key={a.agent_id} value={a.agent_id}>{a.display_name}</option>
                    ))}
                  </select>
                </div>
                {/* The previous argv stays on screen while the next one
                    loads. Swapping it for a one-line "Loading…" collapsed the
                    panel, the page got shorter, and the browser moved the
                    scroll position - so changing the agent threw the reader
                    somewhere else on the page. Only the very first load has
                    nothing to show, and that one cannot move anything because
                    the panel was closed a moment ago. */}
                <div className="mt-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3">
                  {previewLoading && !preview && (
                    <div className="text-[12px] text-[var(--color-fg-faint)]">{t("common:loading")}</div>
                  )}
                  {previewErr && <div className="text-[12px] text-[var(--color-err)]">{previewErr}</div>}
                  {preview && (
                    <div className={cn("transition-opacity", previewLoading && "opacity-50")}>
                      <pre
                        data-testid="docker-preview-argv"
                        className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]"
                      >
                        {formatDockerArgv(preview.argv)}
                      </pre>
                      {!!preview.spec.warnings?.length && (
                        <div className="mt-2 flex flex-col gap-1 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-2.5 py-2 text-[11.5px] text-[var(--color-fg-dim)]">
                          {preview.spec.warnings!.map((w, i) => <div key={i}>{w}</div>)}
                        </div>
                      )}
                      <div className="mt-2 border-t border-[var(--color-border-soft)] pt-2 text-[11.5px] text-[var(--color-fg-faint)]">
                        {t("docker.preview.footnote")}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Block>
          {/* What a task gets, rather than what the image contains. Nothing
              here acts on the running system, which is what separates it from
              Image above. */}
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">{t("docker.configHeading")}</div>
          {/* Per-agent config dirs: the confirmed built-in list ("Logins"
              above) is read-only - it's what makes login/session sharing
              actually work - plus whatever extra dirs the user wants
              mounted alongside it (a custom skills dir, an extra MCP
              config location, etc). Collapsed by default: this is a
              "look it up when you need it" reference, not something
              every visit to this page needs to see. */}
          <Block>
            <button
              type="button"
              onClick={() => setShowAgentDirs(s => !s)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <div>
                <div className="text-[14px] font-medium">{t("docker.persisted.title")}</div>
                <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
                  {t("docker.persisted.sub")}
                </div>
              </div>
              <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--color-fg-faint)] transition-transform", showAgentDirs && "rotate-180")} />
            </button>
            {showAgentDirs && (
              <div className="mt-3 flex flex-col gap-2">
                {/* "Relative to WHAT?" answered before the list, because a
                    bare `.claude` chip reads like a path on your Mac and is
                    not one: it names a folder inside the agent's HOME in the
                    CONTAINER, backed by a termic-owned folder on the host. */}
                {/* Three facts, one line each. This was five paragraphs
                    that nobody would read: the mechanism, a worked path, a
                    "why /root" aside, a not-your-real-config warning and a
                    chip legend. What a reader needs is the unit (a container
                    path), the concrete example, and the reassurance about
                    `~/.claude`. The rest is in the commit history and the
                    code comments, which is where it belongs. */}
                <div className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
                  <div>
                    <Trans
                      t={t}
                      i18nKey="docker.persisted.fact1"
                      components={{
                        1: <b className="text-[var(--color-fg)]" />,
                        3: <code className="font-mono" />,
                        5: <code className="font-mono" />,
                        7: <code className="font-mono" />,
                      }}
                    />
                  </div>
                  <div>
                    <Trans
                      t={t}
                      i18nKey="docker.persisted.fact2"
                      components={{
                        1: <code className="font-mono" />,
                        3: <b className="text-[var(--color-fg)]" />,
                      }}
                    />
                  </div>
                  <div className="text-[var(--color-fg-faint)]">
                    <Trans
                      t={t}
                      i18nKey="docker.persisted.fact3"
                      components={{
                        1: <code className="font-mono" />,
                        3: <code className="font-mono" />,
                      }}
                    />
                  </div>
                </div>

                {/* Shared first: it is the one row that applies to everything
                    below it, and reading it after seven per-agent cards made
                    it look like an eighth agent. */}
                <SharedDirsRow
                  dirs={settings.docker_shared_config_dirs ?? []}
                  onChange={next => patch({ docker_shared_config_dirs: next })}
                />

                {agentDirs.map(d => (
                  <AgentDirsRow
                    key={d.agent_id}
                    dirs={d}
                    onChangeExtra={next => {
                      setAgentDirs(cur => cur.map(a => a.agent_id === d.agent_id ? { ...a, extra: next } : a));
                      patch({ docker_agent_extra_dirs: { ...(settings.docker_agent_extra_dirs ?? {}), [d.agent_id]: next } });
                    }}
                    onTogglePersist={next => {
                      setAgentDirs(cur => cur.map(a => a.agent_id === d.agent_id ? { ...a, persist_enabled: next } : a));
                      patch({ docker_agent_persist_enabled: { ...(settings.docker_agent_persist_enabled ?? {}), [d.agent_id]: next } });
                    }}
                    dockerEnv={settings.agents?.find(a => a.id === d.agent_id)?.docker_env ?? {}}
                    onChangeDockerEnv={next => patch({
                      agents: (settings.agents ?? []).map(a =>
                        a.id === d.agent_id ? { ...a, docker_env: next } : a),
                    })}
                  />
                ))}
              </div>
            )}
          </Block>

          {/* Default extra mounts: the Settings-level companion to a
              task's own "Extra mounts" field (Sandbox dialog / New task
              dialog). Same host_path:container_path shape - these are
              UNIONED into a new Docker-sandboxed task's mounts at
              creation, then owned by the task from then on: the user can
              edit, remove, or add to them per task with no effect back
              here. Global rather than per-agent, unlike "Per-agent config
              dirs" above: an extra mount's use case (persisting an MCP
              server's own data dir, say) isn't tied to which agent runs. */}
          <Block>
            <div className="text-[14px] font-medium">{t("docker.mounts.title")}</div>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
              <Trans
                t={t}
                i18nKey="docker.mounts.hint"
                components={{ 1: <code className="font-mono" /> }}
              />
            </div>
            <div className="mt-3">
              <ListField
                label={t("docker.mounts.label")}
                placeholder={"$HOME/mcp-data:/data/mcp"}
                value={defaultMounts}
                onChange={setDefaultMounts}
              />
            </div>
            <div className="mt-3">
              <Button variant="primary" disabled={!defaultMountsDirty || mountsBusy} onClick={saveDefaultMounts}>
                {mountsBusy ? t("common:saving") : t("common:save")}
              </Button>
            </div>
          </Block>



        </>
      )}
    </div>
  );
}

/** The Dockerfile's own one-line state, next to the image and the daemon:
 *  shipped default, edited, or edited-and-not-yet-saved. Three states rather
 *  than two because "modified" and "modified but not written to disk" build
 *  different images, and the second one is the reason a rebuild can look like
 *  it ignored your change. */
function DockerfileStatusLine({ isDefault, dirty }: { isDefault: boolean; dirty: boolean }) {
  const { t } = useTranslation("settings");
  if (dirty) {
    return (
      <div className="mt-1 flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--color-warn)]">
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{t("docker.unsaved")}</span>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--color-fg-faint)]">
      <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-ok)]" />
      <span>{isDefault ? t("docker.dfDefault") : t("docker.dfCustomized")}</span>
    </div>
  );
}

/** "Docker version 29.4.0, build 9d7ad9f" -> "29.4.0". The build hash is
 *  noise in a column whose whole job is to say yes or no; the full string
 *  stays as the title, so nothing is actually lost. */
function shortDockerVersion(v: string): string {
  return v.replace(/^Docker version /i, "").replace(/,\s*build.*$/i, "").trim() || v;
}

function DockerAvailability({ status }: { status: DockerStatus | null }) {
  const { t } = useTranslation("settings");
  if (!status) return <div className="mt-1 text-[12.5px] text-[var(--color-fg-faint)]">{t("docker.availability.checking")}</div>;
  if (!status.binary) {
    return (
      <div className="mt-1 flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--color-warn)]">
        <CircleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {t("docker.availability.notFound")}
      </div>
    );
  }
  if (!status.daemon) {
    return (
      <div className="mt-1 flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--color-warn)]">
        <CircleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {t("docker.availability.daemonDown")}
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
      <CircleCheck className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[var(--color-ok)]" />
      <span title={status.version ?? undefined}>{t("docker.availability.ready")}{status.version ? ` · ${shortDockerVersion(status.version)}` : ""}</span>
    </div>
  );
}

/** What EXISTS: the built tag and when. Deliberately not the "rebuild to
 *  apply your edits" warning, which is an instruction rather than a state and
 *  now sits next to the button that carries it out. */
function ImageStatusLine({ image }: { image: DockerImageStatus | null }) {
  const { t } = useTranslation("settings");
  if (!image) return null;
  return (
    <div className="mt-1 flex flex-col gap-1 text-[12.5px]">
      {image.available ? (
        <span className="flex items-start gap-1.5 leading-snug text-[var(--color-fg-dim)]">
          <CircleCheck className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[var(--color-ok)]" />
          <span>{t("docker.builtPrefix")}<code className="font-mono">{image.last_built_tag ?? image.current_tag}</code></span>
        </span>
      ) : (
        <span className="flex items-start gap-1.5 leading-snug text-[var(--color-fg-faint)]">
          <CircleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" /> <span>{t("docker.notBuilt")}</span>
        </span>
      )}
      {image.available && (
        <span className="flex items-start gap-1.5 leading-snug text-[var(--color-fg-faint)]">
          {describeLastBuildDate(image.last_built_date)}
        </span>
      )}
    </div>
  );
}

/** One agent's row in "Per-agent config dirs": name, its built-in dirs as
 *  locked chips, its extra dirs as removable chips, and a "+ add" affordance
 *  that becomes a one-line input. For an agent OUTSIDE the known-safe
 *  built-in set, an opt-in "Persist config in Docker mode" checkbox gates
 *  whether `extra` is mounted at all - see docker.rs's `agent_config`. */
/** `KEY=VALUE` lines to a map. Blank lines and `#` comments dropped; a line
 *  with no `=` is ignored rather than becoming an empty-valued key, so a
 *  half-typed line does not silently set something. */
function parseDockerEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** The chip list every persisted-dirs row uses: a name, any locked built-in
 *  dirs, the editable ones as removable chips, and a "+ add" that becomes a
 *  one-line input. Shared by the per-agent rows and the all-agents row so the
 *  two cannot drift into looking like different features - which is exactly
 *  what a separate "Shared config dirs" section did. */
function DirChips({ label, sub, locked = [], dirs, onChange, canAdd = true, placeholder }: {
  label: string;
  sub?: string;
  locked?: string[];
  dirs: string[];
  onChange: (next: string[]) => void;
  canAdd?: boolean;
  placeholder?: string;
}) {
  const { t } = useTranslation("settings");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  function commit() {
    const v = draft.trim();
    if (v && !dirs.includes(v)) onChange([...dirs, v]);
    setDraft("");
    setAdding(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-[13px] font-medium">{label}</span>
      {sub && <span className="mr-0.5 text-[11px] text-[var(--color-fg-faint)]">{sub}</span>}
      {locked.map(d => (
        <span
          key={d}
          title={t("docker.persisted.lockTip")}
          className="flex items-center gap-1 rounded bg-[var(--color-bg-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-fg-dim)]"
        >
          <Lock className="h-2.5 w-2.5 text-[var(--color-fg-faint)]" />
          {d}
        </span>
      ))}
      {dirs.map(d => (
        <span
          key={d}
          className="flex items-center gap-1 rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-fg-dim)]"
        >
          {d}
          <button
            type="button"
            onClick={() => onChange(dirs.filter(x => x !== d))}
            aria-label={t("docker.persisted.removeDir", { dir: d })}
            className="text-[var(--color-fg-faint)] hover:text-[var(--color-err)]"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(""); setAdding(false); }
          }}
          placeholder={placeholder ?? t("docker.persisted.dirPlaceholder")}
          spellCheck={false}
          className="w-24 rounded border border-[var(--color-accent-soft)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-fg)] outline-none"
        />
      ) : canAdd ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded border border-dashed border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-fg-faint)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
        >
          {t("docker.persisted.addDir")}
        </button>
      ) : null}
    </div>
  );
}

/** The all-agents row: the same persisted dirs, mounted into EVERY container
 *  instead of one agent's. It sits at the top of the same list rather than in
 *  a section of its own, because "shared config dirs" and "persisted
 *  directories" were two names for one idea and the reader had to work out
 *  that they were the same mechanism on a different axis.
 *
 *  No environment column: env is per agent by definition. The right half
 *  explains WHY this row is shared, which is the question the row raises. */
function SharedDirsRow({ dirs, onChange }: { dirs: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation("settings");
  return (
    <div className="grid grid-cols-2 items-stretch gap-x-4 gap-y-1.5 rounded-md border border-[var(--color-accent-soft)] bg-[var(--color-accent)]/[0.04] px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        <DirChips
          label={t("docker.persisted.allAgents")}
          dirs={dirs}
          onChange={onChange}
          placeholder=".config/gh"
        />
        {dirs.length === 0 && (
          <span className="text-[11px] text-[var(--color-fg-faint)]">
            <Trans
              t={t}
              i18nKey="docker.persisted.sharedEmpty"
              components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
            />
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col justify-center text-[11px] leading-relaxed text-[var(--color-fg-faint)]">
        <span>
          <Trans
            t={t}
            i18nKey="docker.persisted.sharedWhy"
            components={{ 1: <code className="font-mono" />, 3: <code className="font-mono" /> }}
          />
        </span>
      </div>
    </div>
  );
}

function AgentDirsRow({ dirs, onChangeExtra, onTogglePersist, dockerEnv, onChangeDockerEnv }: {
  dirs: DockerAgentDirs;
  onChangeExtra: (next: string[]) => void;
  onTogglePersist: (next: boolean) => void;
  /** The agent's Docker-only environment (`Agent.docker_env`), editable here
   *  as well as in Agents & Terminals: this page is where someone is already
   *  thinking about what a container gets, and a value naming a path on the
   *  Mac is the single most common way to break Docker persistence. */
  dockerEnv: Record<string, string>;
  onChangeDockerEnv: (next: Record<string, string>) => void;
}) {
  const { t } = useTranslation("settings");
  const canAdd = dirs.is_builtin || dirs.persist_enabled;

  // Two columns of equal height: what is KEPT on the left, what the container
  // RUNS WITH on the right. Stacked, the env box read as an afterthought
  // below the chips and needed a disclosure to stay out of the way; side by
  // side both are answerable at a glance for every agent. `items-stretch` is
  // what makes the textarea match the left column rather than each row
  // setting its own height.
  return (
    <div className="grid grid-cols-2 items-stretch gap-x-4 gap-y-1.5 rounded-md border border-[var(--color-border-soft)] px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1.5">
      <DirChips
        label={dirs.display_name}
        locked={dirs.builtin}
        dirs={dirs.extra}
        onChange={onChangeExtra}
        canAdd={canAdd}
      />
      {!dirs.is_builtin && dirs.persist_offerable && (
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-faint)]">
          <input
            type="checkbox"
            checked={dirs.persist_enabled}
            onChange={e => onTogglePersist(e.target.checked)}
          />
          {t("docker.persisted.persist")}
          {dirs.persist_enabled && dirs.extra.length === 0 && (
            <span className="text-[var(--color-warn)]">{t("docker.persisted.persistWarn")}</span>
          )}
        </label>
      )}
      {!dirs.is_builtin && !dirs.persist_offerable && (
        <span className="text-[11px] text-[var(--color-fg-faint)]">
          {t("docker.persisted.persistUnsupported")}
        </span>
      )}
      </div>

      {/* Right column: the Docker-only environment, always visible. A
          SEPARATE list from the agent's normal one, not a patch on top of
          it - empty means the normal one is used unchanged. */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-[11px] text-[var(--color-fg-faint)]">
          {t("docker.persisted.envLabel")}
          {Object.keys(dockerEnv).length > 0 && (
            <span className="text-[var(--color-fg-dim)]"> · {t("docker.persisted.envCount", { count: Object.keys(dockerEnv).length })}</span>
          )}
        </div>
        <textarea
          value={Object.entries(dockerEnv).map(([k, v]) => `${k}=${v}`).join("\n")}
          onChange={e => onChangeDockerEnv(parseDockerEnvLines(e.target.value))}
          rows={2}
          spellCheck={false}
          data-testid={`docker-agent-env-${dirs.agent_id}`}
          placeholder={t("docker.persisted.envPlaceholder")}
          // flex-1 (not field-sizing) so it fills the column and both sides
          // end level, which is the point of the two-column layout.
          className="min-h-[3.25rem] w-full flex-1 resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 font-mono text-[11.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>
    </div>
  );
}
