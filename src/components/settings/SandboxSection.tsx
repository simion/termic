// Sandbox settings. Its own page because this is the one area of settings
// where a wrong value has a security consequence, and because the three
// controls used to sit scattered between "Completion sound" and "Hidden
// files" in General. See docs/sandbox.md for what the cage actually does.

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { settingsSave, sandboxAvailable, dockerImageStatus, type DockerImageStatus } from "@/lib/ipc";
import type { Settings } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { usePrefs } from "@/store/prefs";
import { Block, ListField, SectionTitle, Toggle, useBackendSettings } from "./Controls";
import { SandboxPicker, DockerEngineNote } from "@/components/SandboxPicker";
import { cleanLines } from "@/lib/utils";

export function SandboxSection() {
  const { t } = useTranslation("settings");
  const { settings, store } = useBackendSettings();
  const [busy, setBusy] = useState(false);
  // Global sandbox defaults. Stored line-by-line as strings so the
  // user can edit mid-line without the array round-trip dropping
  // their cursor.
  const [sbRw, setSbRw]       = useState("");
  const [sbHosts, setSbHosts] = useState("");
  const [sbOriginal, setSbOriginal] = useState({ rw: "", hosts: "" });

  const globalDefaultSandboxKind = usePrefs(s => s.globalDefaultSandboxKind);
  const setGlobalDefaultSandboxKind = usePrefs(s => s.setGlobalDefaultSandboxKind);
  const sandboxBypassPermissions = usePrefs(s => s.sandboxBypassPermissions);
  const setSandboxBypassPermissions = usePrefs(s => s.setSandboxBypassPermissions);
  const defaultYolo = usePrefs(s => s.defaultYolo);
  const setDefaultYolo = usePrefs(s => s.setDefaultYolo);

  // Same two gates the picker needs everywhere else it appears: Seatbelt
  // is macOS-only, Docker needs the global switch on AND an image built.
  const [osSandboxOk, setOsSandboxOk] = useState<boolean | null>(null);
  const [dockerImage, setDockerImage] = useState<DockerImageStatus | null>(null);
  useEffect(() => {
    sandboxAvailable().then(setOsSandboxOk).catch(() => setOsSandboxOk(false));
    dockerImageStatus().then(setDockerImage).catch(() => {});
  }, []);
  const dockerOffered = !!settings?.docker_sandbox_enabled && !!dockerImage?.available;

  const hydrated = useRef(false);
  useEffect(() => {
    if (!settings || hydrated.current) return;
    hydrated.current = true;
    const rw    = (settings.sandbox_default_rw_paths      ?? []).join("\n");
    const hosts = (settings.sandbox_default_allowed_hosts ?? []).join("\n");
    setSbRw(rw); setSbHosts(hosts);
    setSbOriginal({ rw, hosts });
  }, [settings]);

  const sbDirty = sbRw !== sbOriginal.rw || sbHosts !== sbOriginal.hosts;

  async function saveSb() {
    if (!settings) return;
    setBusy(true);
    try {
      const next: Settings = {
        ...settings,
        sandbox_default_rw_paths:      cleanLines(sbRw),
        sandbox_default_allowed_hosts: cleanLines(sbHosts),
      };
      await settingsSave(next);
      store(next);
      setSbOriginal({ rw: sbRw, hosts: sbHosts });
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionTitle title={t("rail.sandbox")} />

      {/* Global sandbox default. The New task dialog's picker starts here
          whenever neither the user's own last-used habit nor the
          project's own default_sandbox_mode is in effect - one app-wide
          pick (including Docker) instead of per-project bookkeeping.
          Already-created tasks aren't affected: the pin is captured at
          creation. */}
      <Block first>
        <div className="text-[14px] font-medium">{t("sandbox.defaultKind.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          {t("sandbox.defaultKind.hint")}
        </div>
        <div className="mt-3">
          <SandboxPicker
          onEnableDocker={() => { useApp.getState().openSettings("docker"); }}
            value={globalDefaultSandboxKind}
            onChange={setGlobalDefaultSandboxKind}
            seatbeltUnavailable={osSandboxOk === false}
            dockerOffered={dockerOffered}
            dockerUnavailableReason={t("sandbox.defaultKind.dockerUnavailable")}
          />
          {globalDefaultSandboxKind === "docker" && (
            <div className="mt-2">
              <DockerEngineNote />
            </div>
          )}
        </div>
      </Block>

      {/* YOLO default for NEW tasks, for a machine that is itself the
          sandbox. It only seeds Task.yolo: the New Task dialog shows it as a
          ticked checkbox before Create, the Race dialog and the sidebar
          quick-create apply it, and the red ⚡ marks the task afterwards.
          The CLI and MCP still need an explicit --yolo, so an agent asking
          to create a task cannot inherit it. Existing tasks keep their own
          flag. */}
      <Block id="default-yolo">
        <Toggle
          label={t("sandbox.yoloDefault.label")}
          hint={
            <Trans
              t={t}
              i18nKey="sandbox.yoloDefault.hint"
              components={{ 1: <code className="font-mono" /> }}
            />
          }
          value={defaultYolo}
          onChange={setDefaultYolo}
        />
      </Block>

      {/* Bypass-permissions default for sandboxed agents. When on, a
          sandboxed agent spawns with its "auto-approve everything" flag
          regardless of the YOLO toggle — the seatbelt is the real
          boundary, the agent's own prompts are just friction. Affects
          new PTY spawns; respawn (⌘R / new tab) to pick up a change. */}
      <Block>
        <Toggle
          label={t("sandbox.bypass.label")}
          hint={t("sandbox.bypass.hint")}
          value={sandboxBypassPermissions}
          onChange={setSandboxBypassPermissions}
        />
      </Block>

      {/* Global sandbox lists. Joined with each project's per-repo
          lists when a task gets created with sandbox enabled,
          and pre-filled into the Edit Sandbox dialog when the user
          enables the cage from scratch. Editing these only affects
          NEW tasks — existing ones froze a copy at creation. */}
      <Block>
        <div className="text-[14px] font-medium">{t("sandbox.global.title")}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">
          <Trans
            t={t}
            i18nKey="sandbox.global.hint"
            components={{ 1: <code />, 3: <code />, 5: <code /> }}
          />
        </div>
        <div className="mt-3 flex flex-col gap-4">
          <ListField label={t("sandbox.global.allowedPaths")} placeholder={"~/Documents/notes\n~/scratch"} value={sbRw} onChange={setSbRw} />
          <ListField label={t("sandbox.global.allowedHosts")} placeholder={"*.example.com\nbitbucket.org"} value={sbHosts} onChange={setSbHosts} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={!sbDirty || busy} onClick={saveSb}>
            {busy ? t("common:saving") : t("sandbox.global.save")}
          </Button>
        </div>
      </Block>
    </div>
  );
}
