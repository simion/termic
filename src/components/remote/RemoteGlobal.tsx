// Remote control's app-wide pieces, mounted once: the store's subscription
// to the backend and the two dialogs.

import { useEffect } from "react";
import { useApp } from "@/store/app";
import { startRemote, useRemote } from "@/lib/remote";
import { AddServerDialog } from "./AddServerDialog";
import { NewRemoteTaskDialog } from "./NewRemoteTaskDialog";

export function RemoteGlobal() {
  useEffect(() => {
    startRemote();
    // Picking a local task (or a page) leaves the remote one.
    const unsub = useApp.subscribe((s, prev) => {
      if (s.activeTaskId !== prev.activeTaskId || s.view.page !== prev.view.page) useRemote.getState().openTask(null);
    });
    return unsub;
  }, []);
  return (
    <>
      <AddServerDialog />
      <NewRemoteTaskDialog />
    </>
  );
}
