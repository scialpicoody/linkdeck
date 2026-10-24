import { Braces, Hexagon, ScanSearch, X } from "lucide-react";
import { useEffect } from "react";
import FrameDetail from "../inspector/FrameDetail";
import type { InspectorFrame } from "../inspector/types";
import type { Frame } from "./types";

export interface FrameInspectorProps {
  /** Selected frame + its channel; null renders the inspector empty state. */
  selection: { frame: Frame; channelName: string } | null;
  onClose: () => void;
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
export default function FrameInspector({ selection, onClose }: FrameInspectorProps) {
  useEffect(() => {
    if (selection === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, onClose]);

  if (selection === null) {
    return (
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
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-panel-raised px-3">
        <div className="min-w-0">
          <span className="eyebrow text-muted-foreground">Frame inspector</span>
          <span className="ml-2 font-mono text-[9px] text-muted-foreground">
            {selection.frame.dir === "in" ? "RX" : "TX"}
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
      <div className="flex min-h-0 flex-1 flex-col">
        <FrameDetail frame={toInspectorFrame(selection.frame, selection.channelName)} />
      </div>
    </div>
  );
}
