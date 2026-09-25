import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { ChevronDown, ChevronRight, Settings } from "lucide-react";
import type { Project } from "@/lib/types";
import { useCodeIntel } from "@/store/codeIntel";
import { useShallow } from "zustand/react/shallow";
import { lspOffer, type LspOffer } from "@/lib/lsp/install";
import { serverGuide, parseRaw, type ServerGuide } from "@/lib/lsp/serverSettings";
import { SERVABLE_LANGUAGES } from "@/lib/lsp/serverNames";
import { cn } from "@/lib/utils";

/** The same seven the project's own language list uses: a per-language
 *  settings panel that knows about four of them is the drift this replaced. */
const CODE_INTEL_LANGUAGES = SERVABLE_LANGUAGES;

export function CodeIntelSettings({
  project,
  onChange,
}: {
  project: Project;
  onChange: (patch: { code_intel_settings?: Record<string, unknown> }) => void;
}) {
  const { t } = useTranslation("settings");
  const activeLangs = project.code_intel_languages ?? CODE_INTEL_LANGUAGES.map((l) => l.id);

  if (activeLangs.length === 0) return null;

  return (
    <div className="mt-6 flex flex-col gap-3">
      <div className="text-[13px] font-medium text-[var(--color-fg)]">{t("codeIntel.configHeading")}</div>
      <p className="text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
        {t("codeIntel.configDesc")}
      </p>
      {activeLangs.map((lang) => (
        <LanguageServerConfig
          // Project id in the key, not just the language. Settings.tsx renders
          // <RepositorySection projectId={...}> with no key, so switching
          // project REUSES this tree, and AdvancedSettingsBlock seeds its
          // textarea from props exactly once. Without this you look at project
          // A's JSON while editing project B, and the first keystroke writes
          // A's block onto B.
          key={`${project.id}:${lang}`}
          language={lang}
          project={project}
          onChange={(newVal) => {
            const cur = project.code_intel_settings || {};
            onChange({ code_intel_settings: { ...cur, [lang]: newVal } });
          }}
        />
      ))}
    </div>
  );
}

function LanguageServerConfig({
  language,
  project,
  onChange,
}: {
  language: string;
  project: Project;
  onChange: (val: Record<string, unknown> | null) => void;
}) {
  const { t } = useTranslation("settings");
  const [offer, setOffer] = useState<LspOffer | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    lspOffer(project.root_path, language)
      .then((o) => {
        if (alive) setOffer(o);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project.root_path, language]);

  if (!offer || (!offer.exe && !offer.installLabel)) return null;

  const guide = serverGuide(offer.exe);
  if (!guide) return null;

  const serverName = guide.name;
  
  return (
    <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[var(--color-hover)]"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-[var(--color-fg-dim)]" />
          ) : (
            <ChevronRight className="h-4 w-4 text-[var(--color-fg-dim)]" />
          )}
          <span className="text-[13px] font-medium text-[var(--color-fg)]">{serverName}</span>
          <span className="text-[12px] text-[var(--color-fg-dim)]">({language})</span>
        </div>
        <Settings className="h-4 w-4 text-[var(--color-fg-faint)]" />
      </button>

      {open && (
        <div className="border-t border-[var(--color-border-soft)] p-4 text-[12.5px] text-[var(--color-fg-dim)] flex flex-col gap-4">
          <div>
            <p className="mb-3 leading-relaxed text-[var(--color-fg)]">{guide.summary}</p>
            {guide.configFiles.length > 0 && (
              <div className="mb-3">
                <strong className="text-[var(--color-fg)]">{t("codeIntel.configFiles")}</strong>
                <ul className="mt-1.5 list-disc pl-4 marker:text-[var(--color-border)] flex flex-col gap-1">
                  {guide.configFiles.map((f, i) => (
                    <li key={i}>
                      <code className="font-mono text-[var(--color-fg)]">{f.path}</code>
                      {f.section && <span> ({f.section})</span>}
                      {f.note && <span> — {f.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {guide.excludes && (
              <div className="mb-3">
                <strong className="text-[var(--color-fg)]">{t("codeIntel.ignoring")}</strong>{" "}
                <span>{guide.excludes}</span>
              </div>
            )}
            {guide.env.length > 0 && (
              <div className="mb-3">
                <strong className="text-[var(--color-fg)]">{t("codeIntel.envVars")}</strong>
                <ul className="mt-1.5 list-disc pl-4 marker:text-[var(--color-border)] flex flex-col gap-1">
                  {guide.env.map((e, i) => (
                    <li key={i}>
                      <code className="font-mono text-[var(--color-fg)]">{e.name}</code> — {e.note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <a
                href={guide.docs}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--color-accent)] hover:underline"
              >
                {t("codeIntel.readDocs", { name: guide.name })}
              </a>
            </div>
          </div>

          <AdvancedSettingsBlock
            language={language}
            project={project}
            guide={guide}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

function AdvancedSettingsBlock({
  language,
  project,
  guide,
  onChange,
}: {
  language: string;
  project: Project;
  guide: ServerGuide;
  onChange: (val: Record<string, unknown> | null) => void;
}) {
  const { t } = useTranslation("settings");
  const currentVal = project.code_intel_settings?.[language];
  const [text, setText] = useState(
    currentVal ? JSON.stringify(currentVal, null, 2) : ""
  );

  const parsed = parseRaw(text);

  return (
    <div className="mt-2 border-t border-[var(--color-border-soft)] pt-4">
      <div className="mb-1 text-[13px] font-medium text-[var(--color-fg)]">
        {t("codeIntel.advanced")}
      </div>
      <p className="mb-3 leading-relaxed">
        <Trans
          t={t}
          i18nKey="codeIntel.advancedHint"
          values={{ channel: guide.rawChannel === "init" ? "initializationOptions" : "workspace/configuration" }}
          components={{ 1: <code /> }}
        />
      </p>
      
      <RestartNote language={language} />

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const res = parseRaw(e.target.value);
          if (!res.error) {
            onChange(res.value);
          }
        }}
        placeholder={guide.rawExample}
        rows={6}
        className={cn(
          "w-full rounded border bg-[var(--color-bg)] p-2 font-mono text-[12.5px] text-[var(--color-fg)] outline-none transition-colors",
          parsed.error ? "border-[var(--color-err)] focus:border-[var(--color-err)]" : "border-[var(--color-border)] focus:border-[var(--color-accent)]"
        )}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {parsed.error && (
        <div className="mt-1 text-[11.5px] text-[var(--color-err)]">
          {parsed.error}
        </div>
      )}
    </div>
  );
}


/**
 * Settings are read once, when the server starts.
 *
 * `initializationOptions` is part of `initialize` and a pulled configuration
 * is answered from what the process was spawned with, so editing this box
 * changes NOTHING about a server that is already running. Left unsaid, that
 * reads as "termic ignored my setting" rather than "the process predates it",
 * and the natural next move is to type something else, which also does
 * nothing.
 *
 * Restart is a button rather than automatic: the box saves on a 500ms
 * debounce while you are still typing, and a server that respawned on every
 * pause would reindex the repo several times per sentence.
 */
function RestartNote({ language }: { language: string }) {
  // `useShallow` is load-bearing, not tidiness: this selector BUILDS an
  // array, so it returns a new reference on every call. Zustand compares
  // snapshots with Object.is, so without it every store read looks like a
  // change, and `useSyncExternalStore` treats a snapshot that never settles
  // as an infinite loop - React #185, "Maximum update depth exceeded", the
  // moment this row is expanded. Comparing element-wise makes the snapshot
  // stable while the roots are unchanged.
  const { t } = useTranslation("settings");
  const armedRoots = useCodeIntel(useShallow(s =>
    Object.entries(s.grants)
      .filter(([key, tasks]) => key.split("\u0000")[1] === language && tasks.length > 0)
      .map(([key]) => key.split("\u0000")[0])));
  const [restarting, setRestarting] = useState(false);

  if (!armedRoots.length) {
    return (
      <p className="mb-3 text-[11.5px] text-[var(--color-fg-faint)]">
        {t("codeIntel.appliedNext")}
      </p>
    );
  }

  const restart = async () => {
    setRestarting(true);
    try {
      // Dynamic, and it has to stay that way: lib/lsp/host pulls
      // @codemirror/lsp-client, which mainChunkGuard.test.ts forbids from the
      // app-start graph, and Settings is in it.
      const { stopClient } = await import("@/lib/lsp/host");
      await Promise.all(armedRoots.map(root => stopClient(root, language)));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="mb-3 flex items-center gap-2 text-[11.5px] text-[var(--color-fg-dim)]">
      <span>
        {armedRoots.length === 1
          ? t("codeIntel.runningOne")
          : t("codeIntel.runningMany", { count: armedRoots.length })}
      </span>
      <button
        type="button"
        onClick={restart}
        disabled={restarting}
        className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-fg)] hover:bg-[var(--color-hover)] disabled:opacity-50"
      >
        {restarting ? t("codeIntel.restarting") : t("codeIntel.restart")}
      </button>
    </div>
  );
}
