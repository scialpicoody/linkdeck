import { useMemo, useState } from "react";
import { toast } from "sonner";
import { type FrameCopyFormat, frameCopyText } from "../../lib/frame-export";
import type { InspectorFrame } from "./types";

type DetailView = "hex" | "ascii" | "json";

const VIEW_TABS: { id: DetailView; label: string }[] = [
  { id: "hex", label: "Hex" },
  { id: "ascii", label: "ASCII" },
  { id: "json", label: "JSON" },
];

const COPY_FORMATS: { id: FrameCopyFormat; label: string }[] = [
  { id: "hex", label: "HEX" },
  { id: "ascii", label: "ASCII" },
  { id: "json", label: "JSON" },
];

type DetailFrame = InspectorFrame & { error?: string };

export interface FrameDetailProps {
  /** Selected frame; null renders the empty state. */
  frame: DetailFrame | null;
}

export default function FrameDetail({ frame }: FrameDetailProps) {
  const [view, setView] = useState<DetailView>("hex");

  const body = useMemo(() => {
    if (!frame) return "";
    return frameCopyText(frame, view);
  }, [frame, view]);

  async function copyFrame(format: FrameCopyFormat): Promise<void> {
    if (frame === null) return;
    if (frame.payload.length === 0) {
      toast.info("Nothing to copy", { description: "This Frame has an empty payload." });
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(frameCopyText(frame, format));
      toast.success(`Copied Frame as ${format.toUpperCase()}`);
    } catch (error) {
      toast.error(`Copy ${format.toUpperCase()} failed`, {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!frame) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        <p className="text-sm text-muted-foreground">
          No frame selected. Click a row in the frame monitor to inspect it here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-xs">
        <dt className="text-muted-foreground">Channel</dt>
        <dd className="truncate font-mono text-right text-card-foreground">{frame.channelName}</dd>
        <dt className="text-muted-foreground">Direction</dt>
        <dd className="font-mono text-right text-card-foreground">
          {frame.direction.toUpperCase()}
        </dd>
        <dt className="text-muted-foreground">Time</dt>
        <dd className="truncate font-mono text-right text-card-foreground">
          {new Date(frame.timestampMs).toLocaleTimeString()}
        </dd>
        <dt className="text-muted-foreground">Length</dt>
        <dd className="font-mono text-right text-card-foreground">{frame.payload.length} B</dd>
        {frame.error !== undefined && (
          <>
            <dt className="text-danger">TX error</dt>
            <dd className="text-right font-mono text-danger">{frame.error}</dd>
          </>
        )}
      </dl>

      <div
        role="tablist"
        aria-label="Frame views"
        className="flex gap-1 border-b border-border px-3 py-2"
      >
        {VIEW_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={view === t.id}
            type="button"
            onClick={() => setView(t.id)}
            className={
              view === t.id
                ? "rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
                : "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="eyebrow text-muted-foreground">Copy as</span>
        <div className="flex border border-border bg-card">
          {COPY_FORMATS.map((format) => (
            <button
              key={format.id}
              type="button"
              onClick={() => void copyFrame(format.id)}
              title={`Copy Frame as ${format.label}`}
              className="border-r border-border px-2 py-1 font-mono text-[9px] text-muted-foreground last:border-r-0 hover:bg-secondary hover:text-foreground"
            >
              {format.label}
            </button>
          ))}
        </div>
      </div>

      <pre className="min-h-0 flex-1 overflow-auto bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-card-foreground">
        {body || "(empty payload)"}
      </pre>
    </div>
  );
}
