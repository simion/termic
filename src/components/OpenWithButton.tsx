// The title bar's folder button: a split control, not one action.
//
// Left half launches the app picked last (the file manager until something
// else is picked), right half opens the menu of everything detected. It was a
// single hard-coded "Open in Finder", which is rarely where you want a git
// worktree: the tools you want on one are an editor or a terminal.
//
// Two things here are load-bearing and look like they could be simplified:
//
//   1. The app list is fetched on FIRST MENU OPEN, never during render. It is
//      a Rust call that stats /Applications (and on Linux walks the login
//      shell's PATH, which can block), so a render-path fetch would be
//      docs/performance.md bear trap 5 in the one component that repaints
//      whenever the active task changes.
//   2. Which means the button cannot know whether the remembered app is still
//      installed, so it does not try. It renders from the pref alone and
//      recovers on failure instead (see `launch`), which is also the only
//      honest answer for an app deleted while the menu was open.

import { Fragment, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Tip } from "@/components/ui/Tooltip";
import {
  DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator,
} from "@/components/ui/Dropdown";
import { openWithApp, openWithApps } from "@/lib/ipc";
import {
  FILE_MANAGER_PICK, groupApps, openWithIcon, openWithLabel, pickFromApp,
} from "@/lib/openWith";
import { usePrefs } from "@/store/prefs";
import { useUI } from "@/store/ui";
import type { ExternalAppInfo, Task } from "@/lib/types";

export function OpenWithButton({ task }: { task: Task }) {
  const { t } = useTranslation("chrome");
  const pick = usePrefs(s => s.openWithApp);
  const setPick = usePrefs(s => s.setOpenWithApp);
  const [apps, setApps] = useState<ExternalAppInfo[] | null>(null);

  const label = openWithLabel(pick);
  const Icon = openWithIcon(pick.kind);

  const launch = useCallback((key: string, name: string) => {
    openWithApp(key, task.id).catch((e: unknown) => {
      useUI.getState().pushToast(t("openWith.openFailed", { name, error: String(e) }), "error");
      // The app is gone (uninstalled since it was picked, or since the menu
      // listed it). Revert to the file manager, which needs no detection, so
      // the next click does something instead of failing again.
      setPick(FILE_MANAGER_PICK);
    });
  }, [task.id, setPick, t]);

  const loadApps = useCallback((open: boolean) => {
    if (!open || apps) return;
    openWithApps().then(setApps).catch(() => setApps([]));
  }, [apps]);

  return (
    // One rounded shell with a shared hover, so two hit targets read as one
    // control. `data-no-drag` on both halves: the bar has three independent
    // drag mechanisms (docs/ui.md "Window chrome / drag") and the group's
    // wrapper only opts out of two of them.
    <div className="flex items-center overflow-hidden rounded-md">
      <Tip content={t("openWith.openIn", { label })} side="bottom">
        <Button
          size="icon" variant="icon"
          className="w-6 rounded-r-none"
          onClick={() => launch(pick.key, label)}
          data-no-drag
          data-testid="open-with-launch"
          data-app={pick.key}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </Tip>
      <DropdownRoot onOpenChange={loadApps}>
        <Tip content={t("openWith.openWith")} side="bottom">
          <DropdownTrigger asChild>
            <Button
              size="icon" variant="icon"
              className="w-3.5 rounded-l-none"
              data-no-drag
              data-testid="open-with-menu"
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownTrigger>
        </Tip>
        {/* preventDefault on close keeps focus off the trigger, which would
            otherwise re-fire its focus-triggered tooltip and leave it stuck
            open after a pick (the same fix as the Prompts menu). */}
        <DropdownMenu align="end" className="min-w-[180px]" onCloseAutoFocus={(e) => e.preventDefault()}>
          {apps === null && (
            <div className="px-2 py-1.5 text-[13px] text-[var(--color-fg-faint)]">{t("openWith.looking")}</div>
          )}
          {apps !== null && groupApps(apps).map((group, i) => (
            // Fragment, not a div: Radix finds menu items through its own
            // collection rather than by direct children, so grouping needs no
            // DOM box and a box would only add a layout node to size.
            <Fragment key={group[0].kind}>
              {i > 0 && <DropdownSeparator />}
              {group.map(app => {
                const p = pickFromApp(app);
                const ItemIcon = openWithIcon(p.kind);
                return (
                  <DropdownItem
                    key={p.key}
                    onSelect={() => { setPick(p); launch(p.key, openWithLabel(p)); }}
                    data-testid={`open-with-${p.key}`}
                  >
                    <ItemIcon className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate">{openWithLabel(p)}</span>
                  </DropdownItem>
                );
              })}
            </Fragment>
          ))}
          {/* Windows, and any Mac with no editor installed. Saying so beats a
              menu that looks like it failed to load. */}
          {apps !== null && apps.length <= 1 && (
            <div className="px-2 py-1.5 text-[12px] text-[var(--color-fg-faint)]">
              {t("openWith.noOtherApps")}
            </div>
          )}
        </DropdownMenu>
      </DropdownRoot>
    </div>
  );
}
