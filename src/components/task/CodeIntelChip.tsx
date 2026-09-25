// The one place code intelligence is turned on (GH #174), and the one place its
// cost is disclosed.
//
// It sits on the editor's path bar rather than in Settings because discovery
// should not depend on browsing Settings: the moment it would help is when you
// are looking at code you want to follow a symbol through.
//
// What it must say, and why each part is not optional:
//
//  1. **A number, per language.** "May use significant memory" is not consent.
//     rust-analyzer holds ~3 GB on this repo's own `src-tauri` and gopls has
//     been measured at 6.8 GB; those are the figures, from the manifest.
//  2. **That the unit is the CHECKOUT.** Every IDE the reader has used runs
//     one server per project, so this is the part they will not guess: the
//     main repo is one checkout and every worktree is another. The reassuring
//     half goes in the same breath — tasks sharing a checkout share the
//     server, so a second task on the main checkout is free.
//  3. **That it lapses.** The grant ends with the checkout's last task, which
//     is a feature (an enablement can never outlive its reason) and should
//     read as one rather than as the setting forgetting itself.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import type { Project, Task } from "@/lib/types";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { useCodeIntel, checkoutRoot, grantKey, autoArms, type CodeIntelAuto } from "@/store/codeIntel";
import { useLspStatus, statusKey, statusDetail, isBusy } from "@/store/lspStatus";
import { lspServerFor } from "@/lib/lsp/languages";
import { lspOffer, type LspOffer } from "@/lib/lsp/install";
import { confirmAndInstall } from "@/lib/lsp/installFlow";
import { cn } from "@/lib/utils";
import { memoryNote, serverFor } from "@/lib/lsp/serverNames";
import { codeIntelName, codeIntelNameLower } from "@/lib/lsp/featureName";
import { PopoverRoot, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { CodeIntelActions } from "./CodeIntelActions";
import { useUI } from "@/store/ui";

export function CodeIntelChip({ task, registryName, path }: {
  task: Task;
  /** CodeMirror registry name for the buffer being edited. */
  registryName: string;
  path: string;
}) {
  const { t } = useTranslation("panels");
  const offered = usePrefs(s => s.codeIntelligence);
  const askFirst = usePrefs(s => s.confirmBeforeCodeIntel);
  // The feature's NAME follows the type-checking switch: with it off, all of
  // this is navigation, and the chip says so.
  const typeChecking = usePrefs(s => s.codeIntelDiagnostics);
  const featureName = codeIntelName(typeChecking);
  const setAskFirst = usePrefs(s => s.setConfirmBeforeCodeIntel);
  const project = useApp(s => s.projects.find(p => p.id === task.project_id)) as Project | undefined;
  const root = checkoutRoot(task, project);
  const server = lspServerFor(registryName, path);
  // This checkout AND this language: a Django repo's Python and JavaScript are
  // two separate decisions, because they are two separate processes with two
  // separate memory bills.
  const key = server ? grantKey(root, server) : "";
  const armed = useCodeIntel(s => (s.grants[key]?.length ?? 0) > 0);
  const arm = useCodeIntel(s => s.arm);
  const release = useCodeIntel(s => s.release);
  const askConfirm = useUI(s => s.askConfirm);
  const pushToast = useUI(s => s.pushToast);
  // What the server is doing, so an armed checkout that is still reading the
  // repo says so. Silence during a multi-minute index is indistinguishable
  // from the feature not working.
  const status = useLspStatus(s => (server ? s.byKey[statusKey(root, server)] : undefined));
  // What this machine can actually do for this language: drive something it
  // already has, download termic's pinned build, or nothing. Asked of Rust,
  // because the answer depends on the checkout's own toolchain, the user's
  // real login-shell PATH, and what termic has already installed.
  const [offer, setOffer] = useState<LspOffer | null>(null);
  const [installing, setInstalling] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!offered || !server) { setOffer(null); return; }
    let alive = true;
    lspOffer(root, server).then(o => { if (alive) setOffer(o); }).catch(() => {});
    return () => { alive = false; };
  }, [offered, server, root, installing]);

  // A project can standing-instruct termic to arm its checkouts. It grants,
  // it does not persist: the grant still lapses with the checkout's last task,
  // and turning the project setting back off stops future arming without
  // hunting down what is already running.
  const auto = (project?.code_intel_auto ?? "off") as CodeIntelAuto;
  useEffect(() => {
    if (!offered || !server || armed) return;
    // A standing instruction to arm is not a standing instruction to DOWNLOAD:
    // fetching 14 MB and spending gigabytes of memory on a machine nobody is
    // sitting at is not what "arm my checkouts" asked for.
    if (!offer?.exe) return;
    if (!autoArms(auto, !!task.is_main_checkout)) return;
    arm(key, task.id);
  }, [offered, server, armed, auto, offer?.exe, task.is_main_checkout, task.id, key, arm]);

  // Nothing to offer: the feature is off app-wide, no server answers for this
  // language, or nothing is installed and termic has nothing pinned for it
  // (gopls, say, which upstream publishes no binary for). An absence, not a
  // dead toggle.
  //
  // The project's language list is deliberately NOT consulted: it says what
  // starts by itself, not what may be started. Asking for a server on the file
  // in front of you is always allowed, and the button discloses its cost.
  if (!offered || !server) return null;
  if (offer && !offer.exe && !offer.installLabel) return null;

  const isMain = !!task.is_main_checkout;
  const needsInstall = !!offer && !offer.exe && !!offer.installLabel;
  const mb = offer?.installBytes ? Math.round(offer.installBytes / 1_000_000) : 0;

  // Nothing on this machine can serve the language, but termic has a build
  // pinned for it. Download it (verified against a checksum this release
  // shipped, into a termic-owned directory, never onto the user's PATH), then
  // arm the checkout in the same gesture.
  const install = async () => {
    setInstalling(true);
    try {
      // Shared with Search Everywhere's offer row (`lib/lsp/installFlow.ts`),
      // which had its own copy of this and got it wrong: it armed without
      // downloading. One disclosure, one download, one place to fix.
      const ready = await confirmAndInstall({
        server,
        label: offer!.installLabel!,
        bytes: offer!.installBytes,
        language: registryName,
      });
      if (ready) arm(key, task.id);
    } finally {
      setInstalling(false);
    }
  };

  // One click, and the first one explains what it costs.
  //
  // The disclosure is a `dontAskAgain` confirm rather than a permanent gate:
  // the cost is per CHECKOUT and unusual enough that nobody should meet it by
  // surprise, but someone who has read it once and turns navigation on in
  // every repo should not read it again. Same pattern as archiving a task.
  // Turning it off is a decision, not a tab bounce: stop the process now
  // instead of leaving it in its idle grace. The usual reason someone toggles
  // this is that they changed the environment under it (installing
  // django-stubs, say), and handing them back the same server with the same
  // stale module graph makes the feature look broken.
  const turnOff = async () => {
    release(key, task.id);
    // A sibling task on this checkout may still be using it, in which case
    // stopping would take navigation away from a task nobody touched.
    if ((useCodeIntel.getState().grants[key] ?? []).length > 0) return;
    const { stopClient } = await import("@/lib/lsp/host");
    await stopClient(root, server);
  };

  const ask = async () => {
    if (!askFirst) { arm(key, task.id); return; }
    const res = await askConfirm({
      title: t("codeIntel.turnOnTitle", { feature: codeIntelNameLower(typeChecking) }),
      message: [
        memoryNote(serverFor(offer?.exe ?? null, server))
          || t("codeIntel.memoryFallback"),
        isMain
          ? t("codeIntel.mainNote")
          : t("codeIntel.worktreeNoteChip"),
        t("codeIntel.stopsNote"),
      ].join("\n\n"),
      confirmLabel: t("codeIntel.turnOn"),
      dontAskAgain: true,
      // Keyed: the pane can be closed (or the task archived) while the prompt
      // stands, and an un-withdrawn confirm blocks the whole window.
      key: `code-intel:${key}`,
    });
    // Persist the opt-out only if they went through with it: the dialog
    // reports the checkbox at dismissal, so ticking it and pressing Escape
    // would otherwise silently disable every future disclosure.
    if (res.confirmed && res.dontAskAgain) setAskFirst(false);
    if (res.confirmed) arm(key, task.id);
  };
  // One control, three states, and the ICON carries the busy one: a pulsing
  // dot in place of the compass while the server is starting or reading the
  // repo. The label stays put ("Code intelligence") so the bar does not reflow
  // under the reader every time a percentage ticks, and the detail lives in
  // the tooltip, which is where someone who wants to know why an answer is
  // missing will go looking.
  const busy = armed && isBusy(status);
  const detail = armed ? statusDetail(status) : "";
  const serverName = serverFor(offer?.exe ?? null, server);
  // ONE surface, opened by clicking. There used to be a hover tooltip saying
  // all of this AND a click popover holding the buttons, which is two things
  // to read for one decision, and the tooltip could cover the code it was
  // talking about. Everything worth saying is short enough to sit above the
  // actions it applies to.
  const panel = (
    <div data-testid="code-intel-panel" className="flex w-[280px] flex-col gap-2">
      <div>
        <div className="text-[12.5px] font-medium text-[var(--color-fg)]">
          {registryName} · {serverName}
        </div>
        {/* WHAT it is, then what it costs or what it is doing. Merging the
            hover tooltip into this panel is not the same as deleting it: the
            first line is the only place that says what the feature does, and
            without it the panel opened with a memory figure for something the
            reader had not been told the purpose of. */}
        <div className="mt-1 text-[11.5px] leading-snug text-[var(--color-fg-dim)]">
          {t("codeIntel.description", { server: serverName })}
        </div>
        <div className="mt-1 text-[11.5px] leading-snug text-[var(--color-fg-dim)]">
          {armed
            ? detail || t("codeIntel.runningShared")
            : memoryNote(serverName) || t("codeIntel.memoryFallbackShort")}
        </div>
      </div>

      {/* The environment, not the server: worth its length, and rare. */}
      {offer?.caveat && (
        <div className="text-[11.5px] leading-snug text-[var(--color-warn)]">
          {offer.caveat}
        </div>
      )}

      {!armed && needsInstall && (
        <div className="text-[11.5px] leading-snug text-[var(--color-fg-dim)]">
          {t("codeIntel.notInstalled", { mb })}
        </div>
      )}

      <CodeIntelActions taskId={task.id} server={server} onDone={() => setMenuOpen(false)} />

      {/* Which binary is running, for the moment someone doubts it. Last,
          faint, and truncated: it is a debugging fact, not a headline. */}
      {offer?.exe && (
        <div className="truncate font-mono text-[10.5px] text-[var(--color-fg-faint)]" title={offer.exe}>
          {offer.exe}
        </div>
      )}
    </div>
  );

  // A download is still a straight action: there is nothing to choose between
  // until the server exists. Everything else opens the shared popover, so the
  // chip and Search Everywhere ask the same question the same way.
  return (
    <PopoverRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
      <button
        data-testid="code-intel-chip"
        onClick={(e) => {
          if (needsInstall) { e.preventDefault(); void install(); }
        }}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] hover:bg-[var(--color-hover)]",
          armed
            ? "text-[var(--color-accent)]"
            : "text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]",
        )}
      >
        {busy ? (
          <span
            data-testid="code-intel-busy"
            aria-hidden
            className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-current"
          />
        ) : (
          <Compass className="h-3 w-3 shrink-0" />
        )}
        {installing
          ? t("codeIntel.downloading")
          : armed
            ? featureName
            : needsInstall
              ? t("codeIntel.install", { label: offer!.installLabel })
              : featureName}
      </button>
      </PopoverTrigger>
      {!needsInstall && (
        <PopoverContent side="bottom" align="start" sideOffset={6} className="p-2.5">
          {panel}
        </PopoverContent>
      )}
    </PopoverRoot>
  );
}
