// Which language servers termic has downloaded, and whether newer ones exist
// (GH #174).
//
// Versions are not pinned to the termic release. `lsp_install` resolves the
// LATEST release of a hardcoded upstream repo and verifies the bytes against
// the digest that release's API record carries, because a pinned server ages
// in a way the user pays for: a stale rust-analyzer stops understanding the
// language its own compiler moved on to, and re-pinning four servers across
// four platforms by hand is a chore that quietly stops happening.
//
// Which leaves upgrading, and this is where it lives. Two rules:
//
//  - **On demand, never on a timer.** A background version check is a network
//    call the user did not ask for, in an app whose claim is that it talks to
//    nothing but termic.dev.
//  - **Never a swap.** An upgrade installs alongside; the new build is used at
//    the next spawn. Replacing the binary under a live session would change
//    its answers mid-read, and the running process is holding the old index
//    anyway. The version it replaces is kept, so a bad upgrade is undone by
//    deleting a directory rather than by another download.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Download } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";

interface LspUpdate {
  language: string;
  label: string;
  installed: string | null;
  latest: string | null;
  upgradable: boolean;
}

/** The languages termic can install a server for. Everything else is
 *  PATH-only: gopls publishes no binaries, sourcekit-lsp ships with Xcode. */
const LANGUAGES = ["typescript", "python", "rust"] as const;

interface CatalogServer {
  name: string;
  source: "downloaded" | "path" | "installable";
  exe: string | null;
  version: string | null;
  note: string;
}
interface CatalogEntry { language: string; label: string; servers: CatalogServer[] }

/** A real command for that language, so the field is never a blank prompt.
 *  Named servers we do NOT ship, which is what this box is for. */
function placeholderFor(language: string): string {
  return {
    python: "pyright-langserver --stdio",
    typescript: "deno lsp",
    rust: "rust-analyzer",
    go: "gopls -remote=auto",
    cpp: "clangd --header-insertion=never",
    swift: "sourcekit-lsp",
    ruby: "solargraph stdio",
  }[language] ?? "my-language-server --stdio";
}

/**
 * @param project When set, the picks and commands are written to THIS project
 *   rather than to the machine, and each row says what the machine would do so
 *   the reader can see what they are overriding. The catalog itself (which
 *   servers exist, which are installed) is machine-wide either way.
 */
export function CodeIntelServers({ project, onProjectChange }: {
  project?: Project;
  onProjectChange?: (patch: Partial<Project>) => void;
} = {}) {
  const { t } = useTranslation("settings");
  // The whole supported set, shown WITHOUT being asked for. The old panel
  // listed only the three termic can download, and only after you pressed a
  // button, so "which languages does this work for" had no answer on screen
  // and "ty not installed" read as the app being out of date on a machine
  // where zuban was the one actually running.
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<CatalogEntry[]>("lsp_catalog")
      .then(c => { if (alive) setCatalog(c); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const [rows, setRows] = useState<LspUpdate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pushToast = useUI(s => s.pushToast);
  const machinePicked = usePrefs(s => s.codeIntelServers);
  const machineCommands = usePrefs(s => s.codeIntelCommands);
  const setCodeIntelServer = usePrefs(s => s.setCodeIntelServer);
  const setCodeIntelCommand = usePrefs(s => s.setCodeIntelCommand);

  // Which record this panel edits. A project's absent entry means "whatever
  // the machine says", which is why the fallback is read separately below
  // rather than merged into one value: the reader has to be able to see the
  // difference between "this project chose ty" and "the machine did".
  const picked = project ? (project.code_intel_servers ?? {}) : machinePicked;
  const commands = project ? (project.code_intel_commands ?? {}) : machineCommands;

  /**
   * Choose the server for a language, and make it true NOW.
   *
   * Stopping what is running is the whole point: the old process is still the
   * one answering, so without this the setting appears to do nothing until the
   * app is relaunched. Grants survive, so the next editor open starts the new
   * binary without asking for consent a second time.
   */
  const pick = (language: string, server: string | null) => {
    if (project && onProjectChange) {
      const next = { ...(project.code_intel_servers ?? {}) };
      if (server) next[language] = server;
      else delete next[language];
      onProjectChange({ code_intel_servers: next });
    } else {
      setCodeIntelServer(language, server);
    }
    restart(language);
  };

  /** Run a command of the reader's own for this language, or stop doing so. */
  const setCommand = (language: string, command: string | null) => {
    const value = command?.trim() || null;
    if (project && onProjectChange) {
      const next = { ...(project.code_intel_commands ?? {}) };
      if (value) next[language] = value;
      else delete next[language];
      onProjectChange({ code_intel_commands: next });
    } else {
      setCodeIntelCommand(language, value);
    }
    restart(language);
  };

  /** Stop what is running for a language, so the change is true NOW rather
   *  than at the next relaunch. Grants survive, so the next editor open starts
   *  the new binary without asking for consent again. */
  const restart = (language: string) => {
    void (async () => {
      const { stopClientsForLanguage } = await import("@/lib/lsp/host");
      await stopClientsForLanguage(language);
    })();
  };

  const check = async () => {
    setBusy("check");
    try {
      const out: LspUpdate[] = [];
      for (const language of LANGUAGES) {
        try {
          out.push(await invoke<LspUpdate>("lsp_check_update", { language }));
        } catch { /* not installable on this platform */ }
      }
      setRows(out);
      // And re-read what is on the machine: a check that found a new version
      // leaves the row's "termic downloads it" stale the moment it is applied.
      invoke<CatalogEntry[]>("lsp_catalog").then(setCatalog).catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  /** zuban is a Python package, so this is a virtualenv termic owns rather
   *  than a binary it unpacks. Same promise as every other install here:
   *  nothing touches the project's environment or the user's PATH. */
  const installZuban = async () => {
    setBusy("zuban");
    try {
      await invoke<string>("lsp_install_zuban");
      const fresh = await invoke<CatalogEntry[]>("lsp_catalog");
      setCatalog(fresh);
      pushToast(t("codeIntel.zubanToast"), "success");
    } catch (e) {
      pushToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const update = async (language: string) => {
    setBusy(language);
    try {
      const res = await invoke<LspUpdate>("lsp_update", { language });
      setRows(rs => (rs ?? []).map(r => (r.language === language ? res : r)));
      invoke<CatalogEntry[]>("lsp_catalog").then(setCatalog).catch(() => {});
      pushToast(t("codeIntel.updateToast", { label: res.label, version: res.installed }), "success");
    } catch (e) {
      pushToast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* ONE table, not a stack of cards.
          Each server used to be its own bordered, filled box with the note
          right-aligned inside it, so nine boxes made nine ragged edges down
          the middle of the panel and nothing lined up with anything. A table
          is what this data is: a name, a state, a sentence. Three columns, one
          border around the lot, rows separated by a hairline. */}
      {catalog && (
        <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
          {catalog.map((entry, gi) => (
            <div key={entry.language} data-testid={`lsp-catalog-${entry.language}`}>
              {/* The language, as a band across the table rather than a
                  free-floating heading above a group of boxes. */}
              <div className={cn(
                "bg-[var(--color-bg-2)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--color-fg-dim)]",
                gi > 0 && "border-t border-[var(--color-border)]",
              )}>
                  {entry.label}
                {/* Back to termic's own order. A row rather than a "clear"
                    button, so the default is a choice you can point at
                    instead of the absence of one. */}
                {entry.servers.length > 1 && (
                  <label className="ml-3 inline-flex cursor-pointer items-baseline gap-1.5 font-normal">
                    <input
                      type="radio"
                      name={`lsp-server-${entry.language}`}
                      data-testid={`lsp-pick-${entry.language}-auto`}
                      checked={!picked[entry.language]}
                      onChange={() => pick(entry.language, null)}
                      className="accent-[var(--color-accent)]"
                    />
                    {t("codeIntel.automatic")}
                  </label>
                )}
              </div>
              {entry.servers.map(sv => (
                <div
                  key={sv.name}
                  data-testid={`lsp-server-${entry.language}-${sv.name}`}
                  className="grid grid-cols-[minmax(150px,auto)_minmax(130px,auto)_1fr] items-start gap-x-3 border-t border-[var(--color-border-soft)] px-3 py-2"
                >
                  {/* Pick THIS one. Only where there is a choice: a language
                      with a single server would be a radio group of one,
                      which asks the reader to decide something already
                      decided. The Django afternoon is the argument for it
                      (docs/ideas/lsp-tuning.md): the fix for a server
                      answering badly was not a setting, it was a different
                      process, and there was no way to say so. */}
                  {entry.servers.length > 1 ? (
                    <label className="flex cursor-pointer items-baseline gap-2 text-[12.5px] text-[var(--color-fg)]">
                      <input
                        type="radio"
                        name={`lsp-server-${entry.language}`}
                        data-testid={`lsp-pick-${entry.language}-${sv.name}`}
                        checked={picked[entry.language] === sv.name}
                        onChange={() => pick(entry.language, sv.name)}
                        className="accent-[var(--color-accent)]"
                      />
                      {sv.name}
                    </label>
                  ) : (
                    <span className="text-[12.5px] text-[var(--color-fg)]">{sv.name}</span>
                  )}
                  {/* The state, in the reader's terms: what is here, what
                      termic would fetch, and what they would have to install
                      themselves. Its own column, so the eye can run down it. */}
                  <span className="flex items-center gap-2">
                    <span className={cn(
                      "text-[11.5px]",
                      sv.exe ? "text-[var(--color-ok)]" : "text-[var(--color-fg-faint)]",
                    )}>
                      {sv.exe
                        ? t("codeIntel.onThisMachine")
                        : sv.source === "downloaded"
                          ? `${t("codeIntel.downloads")}${sv.version ? ` (${sv.version})` : ""}`
                          : t("codeIntel.notInstalled")}
                    </span>
                    {/* The update check writes INTO this row rather than
                        printing a second list underneath it. Two lists both
                        naming "ty", one of them stale, is how the panel came
                        to read as out of date on a machine where zuban was
                        the server actually running. */}
                    {sv.source === "installable" && !sv.exe && (
                      <button
                        type="button"
                        data-testid="lsp-install-zuban"
                        onClick={() => installZuban()}
                        disabled={busy !== null}
                        className="flex items-center gap-1.5 rounded bg-[var(--color-accent-deep)] px-2 py-0.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        <Download className="h-3 w-3" />
                        {busy === "zuban" ? t("codeIntel.installing") : t("codeIntel.install")}
                      </button>
                    )}
                    {(() => {
                      const upd = sv.source === "downloaded"
                        ? rows?.find(r => r.language === entry.language)
                        : undefined;
                      if (!upd?.upgradable) return null;
                      return (
                        <button
                          type="button"
                          onClick={() => update(entry.language)}
                          disabled={busy !== null}
                          className="flex items-center gap-1.5 rounded bg-[var(--color-accent-deep)] px-2 py-0.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                        >
                          <Download className="h-3 w-3" />
                          {busy === entry.language ? t("codeIntel.downloading") : t("codeIntel.updateTo", { version: upd.latest })}
                        </button>
                      );
                    })()}
                  </span>
                  {/* LEFT aligned. Right-aligned prose ragged on its left edge
                      is the single thing that made this look imported from
                      somewhere else. */}
                  <span className="text-[11.5px] leading-snug text-[var(--color-fg-faint)]">
                    {sv.note}
                  </span>
                </div>
              ))}
              {/* Run something else entirely. The escape hatch for a server
                  termic does not ship (pylsp, jedi, a wrapper script in the
                  repo), and the reason the list above can stay a closed set.
                  It beats the radios, so it says so. */}
              <div className="grid grid-cols-[minmax(150px,auto)_1fr] items-baseline gap-x-3 border-t border-[var(--color-border-soft)] px-3 py-2">
                <span className="text-[12.5px] text-[var(--color-fg-dim)]">{t("codeIntel.customCommand")}</span>
                <div className="flex flex-col gap-1">
                  <input
                    type="text"
                    data-testid={`lsp-command-${entry.language}`}
                    defaultValue={commands[entry.language] ?? ""}
                    // On BLUR and on Enter, not on every keystroke: each write
                    // stops the running server for this language, and doing
                    // that per character would restart it a dozen times while
                    // somebody types a path.
                    onBlur={e => setCommand(entry.language, e.currentTarget.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        e.currentTarget.value = commands[entry.language] ?? "";
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder={placeholderFor(entry.language)}
                    spellCheck={false}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
                  />
                  <span className="text-[11.5px] text-[var(--color-fg-faint)]">
                    {commands[entry.language]
                      ? t("codeIntel.customSet")
                      : project && (machineCommands[entry.language] || machinePicked[entry.language])
                        ? t("codeIntel.machineOverride", {
                            value: machineCommands[entry.language]
                              ?? machinePicked[entry.language],
                          })
                        : t("codeIntel.customHint")}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Downloads are machine-wide, so this belongs to the machine panel
          only: a per-project copy would suggest the project has its own. */}
      <div className={cn("flex items-center gap-3", project && "hidden")}>
        <button
          type="button"
          onClick={check}
          disabled={busy !== null}
          data-testid="lsp-check-updates"
          className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[12.5px] bg-[var(--color-bg-3)] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)] disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", busy === "check" && "animate-spin")} />
          {busy === "check" ? t("codeIntel.checking") : t("codeIntel.check")}
        </button>
        <span className="text-[12px] text-[var(--color-fg-faint)]">
          {t("codeIntel.checkNote")}
        </span>
      </div>

      {rows && rows.length === 0 && (
        <p className="text-[12.5px] text-[var(--color-fg-faint)]">
          {t("codeIntel.noneInstallable")}
        </p>
      )}
    </div>
  );
}
