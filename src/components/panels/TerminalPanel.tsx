// Props-stable placeholder for the wave-2 terminal panel (xterm.js).
// Contract: <TerminalPanel channel />. The real panel keeps this signature.
import type { Channel } from "../../lib/channels";

export default function TerminalPanel({ channel }: { channel: Channel | null }) {
  if (channel === null) {
    return (
      <div className="grid flex-1 place-items-center bg-card text-sm text-muted-foreground">
        <div className="text-center">
          <p className="font-medium text-card-foreground">No channel open</p>
          <p className="mt-1">Open a channel from the sidebar to start a terminal session.</p>
        </div>
      </div>
    );
  }
  if (channel.state === "disconnected") {
    return (
      <div className="grid flex-1 place-items-center bg-card text-sm text-muted-foreground">
        <div className="text-center">
          <p className="font-medium text-card-foreground">{channel.name} is disconnected</p>
          <p className="mt-1">Connect to begin streaming frames.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto bg-card p-4 font-mono text-sm text-card-foreground">
      <p className="text-muted-foreground">
        Terminal for {channel.name} — wave-2 xterm.js panel plugs in here.
      </p>
    </div>
  );
}
