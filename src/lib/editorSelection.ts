// The selected lines of each open editor, by tab, for menus outside the
// editor that act on them (a permalink to the selection, GH #467). An editor
// registers a reader when its view mounts and drops it when it goes; nothing
// is copied until a menu asks.

const readers = new Map<string, () => [number, number] | null>();

export function registerEditorSelection(tabId: string, read: () => [number, number] | null): () => void {
  readers.set(tabId, read);
  return () => { if (readers.get(tabId) === read) readers.delete(tabId); };
}

/** 1-based first and last selected line of a tab's editor; null with no
 *  selection or no editor. */
export function editorSelectionLines(tabId: string | null | undefined): [number, number] | null {
  return tabId ? readers.get(tabId)?.() ?? null : null;
}
