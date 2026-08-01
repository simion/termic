// Diff body for files CodeMirror can't render: images show Before/After
// pictures side by side, every other binary shows a one-line summary. Before
// this, `git show HEAD:shot.png` was decoded lossily and painted a screenful
// of U+FFFD on the deleted-line wash. Fed by the same taskFileDiffSides call
// the text diff uses (kind !== "text"); images arrive as base64 and render
// through a data: URL, same channel as PreviewPane.

import { useState } from "react";
import type { DiffSides } from "@/lib/ipc";
import { cn, formatBytes } from "@/lib/utils";

// The per-line washes DiffPane paints on removed/added lines, reused here so
// an image diff reads with the same red/green vocabulary as a text one.
const REMOVED = "rgba(239,83,80,0.12)";
const ADDED = "rgba(64,160,90,0.13)";

// Transparent PNGs are invisible on a flat dark surface; a checkerboard is the
// convention for "nothing here" in image tools.
const CHECKER = {
  backgroundImage:
    "repeating-conic-gradient(var(--color-bg-2) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
};

function ImageSide({ label, data, mime, bytes, wash, className }: {
  label: string;
  data: string;
  mime: string;
  bytes: number;
  wash: string;
  className?: string;
}) {
  const [dims, setDims] = useState<string | null>(null);
  return (
    <div
      className={cn("flex min-w-0 flex-1 flex-col items-center gap-2 p-4", className)}
      style={{ background: wash }}
    >
      <div className="text-[11.5px] uppercase tracking-wide text-[var(--color-fg-dim)]">{label}</div>
      <div className="flex min-h-0 flex-1 items-center justify-center" style={CHECKER}>
        <img
          src={`data:${mime};base64,${data}`}
          alt={label}
          className="max-h-full max-w-full object-contain"
          onLoad={e => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
        />
      </div>
      <div className="font-mono text-[11.5px] text-[var(--color-fg-dim)]">
        {dims ? `${dims} · ${formatBytes(bytes)}` : formatBytes(bytes)}
      </div>
    </div>
  );
}

export function BinaryDiffBody({ sides }: { sides: DiffSides }) {
  const both = sides.original_exists && sides.modified_exists;
  // A one-sided diff is an add or a delete: label it as such rather than
  // showing an empty "Before" panel next to the real one.
  const beforeLabel = both ? "Before" : "Deleted";
  const afterLabel = both ? "After" : "Added";

  if (sides.kind !== "image" || !sides.mime) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="font-mono text-[12.5px] text-[var(--color-fg-dim)]">
          {both
            ? `Binary file · ${formatBytes(sides.original_bytes)} → ${formatBytes(sides.modified_bytes)}`
            : sides.modified_exists
              ? `Binary file · added · ${formatBytes(sides.modified_bytes)}`
              : `Binary file · deleted · ${formatBytes(sides.original_bytes)}`}
        </div>
      </div>
    );
  }

  const mime = sides.mime;
  return (
    <div className="flex h-full">
      {sides.original_data !== undefined && (
        <ImageSide
          label={beforeLabel}
          data={sides.original_data}
          mime={mime}
          bytes={sides.original_bytes}
          wash={REMOVED}
        />
      )}
      {sides.modified_data !== undefined && (
        <ImageSide
          label={afterLabel}
          data={sides.modified_data}
          mime={mime}
          bytes={sides.modified_bytes}
          wash={ADDED}
          className={sides.original_data !== undefined ? "border-l border-[var(--color-border-soft)]" : undefined}
        />
      )}
    </div>
  );
}
