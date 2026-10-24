import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import { type Channel, stateColor } from "../../lib/channels";
import type { FramingError } from "../../mygo";
import { Hint } from "../ui/Hint";

interface StatusBarProps {
  channel: Channel | null;
  onResetCounters: (id: string) => void;
  /** Frames dropped by outbound-queue backpressure (per channel). */
  dropped?: number;
  /** Latest cumulative framing failure for the active channel. */
  framingError?: FramingError;
}

export function StatusBar({ channel, onResetCounters, dropped = 0, framingError }: StatusBarProps) {
  const framingErrorCount = framingError
    ? framingError.oversize + framingError.checksum + framingError.other
    : 0;
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-black/45 bg-chrome px-3 font-mono text-[9px] text-chrome-muted">
      {channel === null ? (
        <>
          <span className="size-1.5 rounded-full bg-chrome-muted/55" />
          <span className="uppercase">No channel</span>
          <span className="ml-auto uppercase">LinkDeck v0.1</span>
        </>
      ) : (
        <>
          <span className="flex items-center gap-1.5 text-chrome-foreground">
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: stateColor(channel.state) }}
              aria-hidden="true"
            />
            {channel.state.toUpperCase()}
          </span>
          <span className="truncate text-chrome-foreground/80">{channel.endpoint}</span>
          {channel.baudRate !== undefined && (
            <span className="hidden sm:inline">{channel.baudRate} BAUD</span>
          )}
          <Hint label="Reset RX/TX counters">
            <button
              type="button"
              onClick={() => onResetCounters(channel.id)}
              className="group flex items-center gap-2 border-l border-white/10 pl-3 hover:text-chrome-foreground"
            >
              <span className="flex items-center gap-1">
                <ArrowDown size={9} aria-hidden="true" />
                {channel.rxBytes} B
              </span>
              <span className="flex items-center gap-1">
                <ArrowUp size={9} aria-hidden="true" />
                {channel.txBytes} B
              </span>
              <RotateCcw
                size={9}
                className="opacity-0 group-hover:opacity-100"
                aria-hidden="true"
              />
            </button>
          </Hint>
          {dropped > 0 && <span className="text-warning">DROP {dropped}</span>}
          {framingErrorCount > 0 && (
            <span
              className="text-warning"
              title={`${framingError?.kind ?? "framing"}: ${framingError?.message ?? ""}`}
            >
              FRAME ERR {framingErrorCount}
            </span>
          )}
          {channel.error !== undefined && (
            <span className="ml-auto truncate text-danger" role="alert">
              {channel.error}
            </span>
          )}
        </>
      )}
    </footer>
  );
}
