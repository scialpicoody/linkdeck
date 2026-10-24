import { X } from "lucide-react";
import { useEffect } from "react";
import FrameDetail from "../inspector/FrameDetail";
import type { InspectorFrame } from "../inspector/types";
import type { Frame } from "./types";

export interface FrameInspectorProps {
  /** Selected frame + its channel; null = panel hidden. */
  selection: { frame: Frame; channelName: string } | null;
  onClose: () => void;
}

const encoder = new TextEncoder();

function toInspectorFrame(frame: Frame, channelName: string): InspectorFrame {
  return {
    id: `${frame.ts}-${frame.dir}`,
    channelName,
    direction: frame.dir === "in" ? "rx" : "tx",
    timestampMs: frame.ts,
    payload: encoder.encode(frame.data),
  };
}

/**
 * Slide-over inspector (#20): renders only when a frame row is selected.
 * No selection → nothing mounted, the width returns to the frame table.
 * Escape closes; stats tab drops out (counters live in the status bar).
 */
export default function FrameInspector({ selection, onClose }: FrameInspectorProps) {
  useEffect(() => {
    if (selection === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, onClose]);

  if (selection === null) return null;

  return (
    <aside
      aria-label="Frame inspector"
      className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-background"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Frame detail
        </h2>
        <button
          type="button"
          onClick={onClose}
          title="Close inspector (Esc)"
          aria-label="Close inspector"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <FrameDetail frame={toInspectorFrame(selection.frame, selection.channelName)} />
      </div>
    </aside>
  );
}
