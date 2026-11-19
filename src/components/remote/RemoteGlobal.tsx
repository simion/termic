// Remote control's app-wide pieces, mounted once: the store's subscription
// to the backend, the three dialogs, and the "a phone was paired" notice.
// The notice fires on every new pairing, dialog open or not, as an OS
// notification: a photographed QR code is the threat, and a pairing the
// person did not make has to be visible after the fact.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { i18n } from "@/lib/i18n";
import { notify } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { PHONE_PAIRED_EVENT, startRemote, useRemote } from "@/lib/remote";
import { ConnectPhoneDialog } from "./ConnectPhoneDialog";
import { AddServerDialog } from "./AddServerDialog";
import { NewRemoteTaskDialog } from "./NewRemoteTaskDialog";

export function RemoteGlobal() {
  useEffect(() => {
    startRemote();
    let un: (() => void) | undefined;
    let gone = false;
    void listen<{ id: string; name: string }>(PHONE_PAIRED_EVENT, e => {
      const name = e.payload.name;
      // The dialog shows its own success state; a toast covers the case
      // where it was closed meanwhile.
      if (!useRemote.getState().phoneDialog) useUI.getState().pushToast(i18n.t("remote:phones.paired", { name }), "success");
      void notify(i18n.t("remote:phones.pairedNotifyTitle"), i18n.t("remote:phones.pairedNotifyBody", { name }));
    }).then(f => { if (gone) f(); else un = f; }).catch(() => {});
    // Picking a local task (or a page) leaves the remote one.
    const unsub = useApp.subscribe((s, prev) => {
      if (s.activeTaskId !== prev.activeTaskId || s.view.page !== prev.view.page) useRemote.getState().openTask(null);
    });
    return () => { gone = true; un?.(); unsub(); };
  }, []);
  return (
    <>
      <ConnectPhoneDialog />
      <AddServerDialog />
      <NewRemoteTaskDialog />
    </>
  );
}
