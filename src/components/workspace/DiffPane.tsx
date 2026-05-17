// Simple unified-diff renderer (line coloring). Future: side-by-side.

import { useEffect, useState } from "react";
import type { DiffTab, Workspace } from "@/lib/types";
import { workspaceFileDiff, openPath } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { FolderOpen, Eye } from "lucide-react";
import { useApp } from "@/store/app";
import { cn } from "@/lib/utils";

export function DiffPane({ ws, tab }: { ws: Workspace; tab: DiffTab }) {
  const [text, setText] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const addTab = useApp(s => s.addTab);

  useEffect(() => {
    let alive = true;
    workspaceFileDiff(ws.id, tab.path)
      .then(t => alive && setText(t))
      .catch(e => alive && setErr(String(e)));
    return () => { alive = false; };
  }, [ws.id, tab.path]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3">
        <span className="font-mono text-[12.5px] text-[var(--color-fg-dim)] truncate">{tab.path}</span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() =>
            addTab(ws.id, { id: crypto.randomUUID(), type: "edit", path: tab.path, title: tab.path.split("/").pop() || tab.path })
          }><Eye className="h-4 w-4" /> View</Button>
          <Button size="sm" variant="ghost" onClick={() => openPath(`${ws.path}/${tab.path}`).catch(() => {})}>
            <FolderOpen className="h-4 w-4" /> Open
          </Button>
        </div>
      </div>
      <div data-selectable className="min-h-0 flex-1 overflow-auto font-mono text-[12.5px] leading-[1.5]">
        {err && <div className="p-4 text-[var(--color-err)]">Error: {err}</div>}
        {!err && text.split("\n").map((line, i) => {
          const cls = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
            ? "text-[var(--color-fg-faint)] bg-[var(--color-bg-1)]"
            : line.startsWith("+")
              ? "text-[#a7f3a0] bg-[rgba(76,175,80,0.08)]"
              : line.startsWith("-")
                ? "text-[#fbb4b1] bg-[rgba(239,83,80,0.08)]"
                : "text-[var(--color-fg-dim)]";
          return <div key={i} className={cn("whitespace-pre px-3", cls)}>{line || " "}</div>;
        })}
      </div>
    </div>
  );
}
