import { Braces, Hexagon, ScanSearch, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "../../lib/utils";
import FrameDetail from "../inspector/FrameDetail";
import ThroughputChart from "../inspector/ThroughputChart";
import type { InspectorFrame } from "../inspector/types";
import { formatBytes } from "./format";
import type { Frame } from "./types";

export interface FrameInspectorProps {
  /** Selected frame + its channel; null renders the inspector empty state. */
  selection: { frame: Frame; channelName: string } | null;
  onClose: () => void;
  stats?: {
    frames: number;
    bytes: number;
    errors: number;
    rx: number[];
    tx: number[];
  };
}

function toInspectorFrame(frame: Frame, channelName: string): InspectorFrame {
  return {
    id: `${frame.ts}-${frame.dir}`,
    channelName,
    direction: frame.dir === "in" ? "rx" : "tx",
    timestampMs: frame.ts,
    payload: frame.payload,
  };
}

/**
 * Inspector content for the persistent operations dock. Selection is owned by
 * the frame table; closing clears it and leaves the dock ready for another row.
 */
export default function FrameInspector({ selection, onClose, stats }: FrameInspectorProps) {
  useEffect(() => {
    if (selection === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, onClose]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-panel-raised px-3">
        <div className="min-w-0">
          <span className="eyebrow text-muted-foreground">Frame inspector</span>
          <span className="ml-2 font-mono text-[9px] text-muted-foreground">
            {selection === null ? "session" : selection.frame.dir === "in" ? "RX" : "TX"}
          </span>
        </div>
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
