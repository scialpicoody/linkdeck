import { Braces, FileJson2, Hexagon, ScanSearch, Table2, X } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  type FrameExportFormat,
  frameExportFilename,
  serializeFrameExport,
} from "../../lib/frame-export";
import { cn } from "../../lib/utils";
import FrameDetail from "../inspector/FrameDetail";
import ThroughputChart from "../inspector/ThroughputChart";
import type { InspectorFrame } from "../inspector/types";
import { Hint } from "../ui/Hint";
import { formatBytes } from "./format";
import type { Frame } from "./types";

export interface FrameInspectorProps {
  /** Selected frame + its channel; null renders the inspector empty state. */
  selection: { frame: Frame; channelName: string } | null;
  onClose: () => void;
  /** Active Channel's current retained Frame window. */
  frames?: readonly Frame[];
  stats?: {
    frames: number;
    bytes: number;
    errors: number;
    rx: number[];
    tx: number[];
  };
}

function toInspectorFrame(frame: Frame, channelName: string): InspectorFrame & { error?: string } {
  const inspected: InspectorFrame & { error?: string } = {
    id: frame.id,
    channelName,
    direction: frame.dir === "in" ? "rx" : "tx",
    timestampMs: frame.ts,
    payload: frame.payload,
  };
  if (frame.error !== undefined) inspected.error = frame.error;
  return inspected;
}

/**
 * Inspector content for the persistent operations dock. Selection is owned by
 * the frame table; closing clears it and leaves the dock ready for another row.
 */
export default function FrameInspector({
  selection,
  onClose,
  frames = [],
  stats,
}: FrameInspectorProps) {
  useEffect(() => {
    if (selection === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, onClose]);

  function exportFrames(format: FrameExportFormat): void {
    if (frames.length === 0) {
      toast.info("Nothing to export", {
        description: "The active Channel has no retained Frames.",
      });
      return;
    }

    try {
      const content = serializeFrameExport(frames, format);
      const type = format === "jsonl" ? "application/x-ndjson" : "text/csv";
      const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = frameExportFilename(format);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(`Exported ${frames.length} Frames as ${format.toUpperCase()}`);
    } catch (error) {
      toast.error(`Export ${format.toUpperCase()} failed`, {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-panel-raised px-3">
        <div className="min-w-0">
          <span className="eyebrow text-muted-foreground">Frame inspector</span>
          <span className="ml-2 font-mono text-[9px] text-muted-foreground">
            {selection === null ? "session" : selection.frame.dir === "in" ? "RX" : "TX"}
          </span>
        </div>
        <div className="flex items-center">
          <Hint label="Export retained Frames as JSONL">
            <button
              type="button"
              onClick={() => exportFrames("jsonl")}
              title="Export retained Frames as JSONL"
              aria-label="Export retained Frames as JSONL"
              className="grid size-7 place-items-center text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <FileJson2 size={13} aria-hidden="true" />
            </button>
          </Hint>
          <Hint label="Export retained Frames as CSV">
            <button
              type="button"
              onClick={() => exportFrames("csv")}
              title="Export retained Frames as CSV"
              aria-label="Export retained Frames as CSV"
              className="grid size-7 place-items-center text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Table2 size={13} aria-hidden="true" />
            </button>
          </Hint>
          <button
            type="button"
            onClick={onClose}
            title="Close inspector (Esc)"
            aria-label="Close inspector"
            className="grid size-7 place-items-center text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {stats !== undefined && (
        <>
          <dl className="grid grid-cols-3 border-b border-border bg-panel-raised/55">
            <div className="border-r border-border px-2 py-2">
              <dt className="eyebrow text-muted-foreground">Frames</dt>
              <dd className="mt-1 font-mono text-[11px]">{stats.frames}</dd>
            </div>
            <div className="border-r border-border px-2 py-2">
              <dt className="eyebrow text-muted-foreground">Bytes</dt>
              <dd className="mt-1 font-mono text-[11px]">{formatBytes(stats.bytes)}</dd>
            </div>
            <div className="px-2 py-2">
              <dt className="eyebrow text-muted-foreground">Errors</dt>
              <dd className={cn("mt-1 font-mono text-[11px]", stats.errors > 0 && "text-danger")}>
                {stats.errors}
              </dd>
            </div>
          </dl>
          <ThroughputChart rx={stats.rx} tx={stats.tx} />
        </>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {selection === null ? (
          <div className="signal-grid grid min-h-0 flex-1 place-items-center bg-card p-5">
            <div className="max-w-56 text-center">
              <span className="mx-auto grid size-12 place-items-center border border-border bg-panel-raised text-muted-foreground">
                <ScanSearch size={22} aria-hidden="true" />
              </span>
              <p className="mt-4 text-xs font-medium">No frame selected</p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                Select a frame in the monitor to inspect its bytes, text, and decoded JSON.
              </p>
              <div className="mt-5 flex justify-center gap-3 text-muted-foreground/65">
                <Hexagon size={13} aria-label="Hex view" />
                <Braces size={13} aria-label="JSON view" />
              </div>
            </div>
          </div>
        ) : (
          <FrameDetail frame={toInspectorFrame(selection.frame, selection.channelName)} />
        )}
      </div>
    </div>
  );
}
