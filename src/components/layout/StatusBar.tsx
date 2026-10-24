import { type Channel, stateColor } from "../../lib/channels";
import { Hint } from "../ui/Hint";

interface StatusBarProps {
  channel: Channel | null;
  clock: string;
  onResetCounters: (id: string) => void;
}

export function StatusBar({ channel, clock, onResetCounters }: StatusBarProps) {
  return (
    <footer className="flex items-center gap-4 border-t border-border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground">
      {channel === null ? (
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground" />
          no channel
        </span>
      ) : (
        <>
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
          {channel.error !== undefined && (
            <span className="text-red-500" role="alert">
              {channel.error}
            </span>
          )}
        </>
      )}
      <span className="ml-auto">{clock}</span>
    </footer>
  );
}
