// Settings -> Secrets: the credential broker's management page
// (spec/credential-broker/plan.md, mocks M1/M2). Secrets and roles are two
// Settings fields, saved together through the shared read-modify-write patch
// so this page can never revert another section's save.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Role, SecretDef } from "@/lib/types";
import { settingsLoad } from "@/lib/ipc";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { useSecrets } from "@/store/secrets";
import { SectionTitle, useBackendSettings } from "../Controls";
import { TabStrip } from "./parts";
import { SecretsTab } from "./SecretsTab";
import { RolesTab } from "./RolesTab";
import { ActivityTab } from "./ActivityTab";

type Tab = "secrets" | "roles" | "activity";

export interface SecretsModel {
  secrets: SecretDef[];
  roles: Role[];
  /** Persist both lists. Resolves false when the save failed (already toasted). */
  save: (next: { secrets?: SecretDef[]; roles?: Role[] }) => Promise<boolean>;
}

export function SecretsSection() {
  const { t } = useTranslation("secrets");
  const { settings, patchOrError } = useBackendSettings();
  // the footer's role link opens Settings with "role:<id>": land on that role.
  // Sections mount on open, so reading it once as initial state is enough.
  const [focusRole] = useState(() => {
    const h = useApp.getState().view.settingsHighlight;
    return h?.startsWith("role:") ? h.slice(5) : null;
  });
  useEffect(() => { if (focusRole) useApp.getState().clearSettingsHighlight(); }, [focusRole]);
  const [tab, setTab] = useState<Tab>(focusRole ? "roles" : "secrets");
  // "Show activity" on a secret row lands here with that secret picked.
  const [activityFilter, setActivityFilter] = useState<string | null>(null);

  // The page edits a local copy, updated synchronously on every save, and
  // persists in the background. The backend copy lags by a settings round
  // trip, and a blur-commit followed by a click (rename, then pick a colour)
  // would otherwise build the second save from the pre-rename role and undo
  // the first. Seeded once; re-seeded only when a save fails.
  const [local, setLocal] = useState<{ secrets: SecretDef[]; roles: Role[] } | null>(null);
  const localRef = useRef(local);
  const seed = useCallback((s: { secrets?: SecretDef[]; roles?: Role[] }) => {
    const v = { secrets: s.secrets ?? [], roles: s.roles ?? [] };
    localRef.current = v;
    setLocal(v);
  }, []);
  useEffect(() => { if (settings && !localRef.current) seed(settings); }, [settings, seed]);

  const save = useCallback(async (next: { secrets?: SecretDef[]; roles?: Role[] }) => {
    if (!localRef.current) return false;
    const merged = { ...localRef.current, ...next };
    localRef.current = merged;
    setLocal(merged);
    const err = await patchOrError(next);
    if (err !== null) {
      // Rust's refusal says which secret or rule is wrong; a bare "save
      // failed" left the user guessing.
      useUI.getState().pushToast(t("manage.secrets.saveFailedWhy", { why: err }), "error");
      const s = await settingsLoad().catch(() => null);
      if (s) seed(s);
      return false;
    }
    useSecrets.getState().put(next);
    return true;
  }, [patchOrError, t, seed]);

  const secrets = local?.secrets ?? [];
  const roles = local?.roles ?? [];

  const model: SecretsModel = { secrets, roles, save };

  return (
    <div className="flex flex-col gap-6" data-testid="secrets-section">
      <SectionTitle title={t("manage.title")} badge={t("task.experimental")} />
      <TabStrip
        attr="data-secrets-tab"
        value={tab}
        onChange={v => { setTab(v); if (v !== "activity") setActivityFilter(null); }}
        tabs={[
          { id: "secrets", label: t("manage.tabs.secrets") },
          { id: "roles", label: t("manage.tabs.roles") },
          { id: "activity", label: t("manage.tabs.activity") },
        ]}
      />
      {/* Nothing renders until settings load: an empty table for a frame
          would read as "your secrets are gone". */}
      {local && tab === "secrets" && (
        <SecretsTab model={model} onShowActivity={id => { setActivityFilter(id); setTab("activity"); }} />
      )}
      {local && tab === "roles" && <RolesTab model={model} initialRole={focusRole} />}
      {local && tab === "activity" && (
        <ActivityTab secrets={secrets} filter={activityFilter} onClearFilter={() => setActivityFilter(null)} />
      )}
    </div>
  );
}
