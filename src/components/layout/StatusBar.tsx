import { type Channel, stateColor } from "../../lib/channels";
import { Hint } from "../ui/Hint";

interface StatusBarProps {
  channel: Channel | null;
  onResetCounters: (id: string) => void;
  /** Frames dropped by outbound-queue backpressure (per channel). */
  dropped?: number;
}

/**
 * Status bar (#20): channel state + RX/TX counters only. The clock is gone —
 * wall time never belonged in a debug workbench footer.
 */
export function StatusBar({ channel, onResetCounters, dropped = 0 }: StatusBarProps) {
  if (channel === null) {
    return (
      <footer className="flex items-center gap-4 border-t border-border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground" />
          no channel
        </span>
      </footer>
    );
  }
  return (
    <footer className="flex items-center gap-4 border-t border-border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 text-card-foreground">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: stateColor(channel.state) }}
        />
        {channel.state}
      </span>
      <span>
        {channel.endpoint}
        {channel.baudRate !== undefined ? ` · ${channel.baudRate} baud` : ""}
      </span>
      <Hint label="Click to reset RX/TX counters">
        <button
          type="button"
          onClick={() => onResetCounters(channel.id)}
          className="rounded px-1 hover:bg-muted hover:text-card-foreground"
        >
          RX {channel.rxBytes} B · TX {channel.txBytes} B
        </button>
      </Hint>
      {dropped > 0 && <span className="text-amber-600 dark:text-amber-400">dropped {dropped}</span>}
      {channel.error !== undefined && (
        <span className="text-red-500" role="alert">
          {channel.error}
        </span>
      )}
    </footer>
  );
}
