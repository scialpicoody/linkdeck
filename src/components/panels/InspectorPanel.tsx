// Props-stable placeholder for the wave-2 inspector panel
// (detail/config/stats). Contract: <InspectorPanel channel />.
import type { Channel } from "../../lib/channels";

export default function InspectorPanel({ channel }: { channel: Channel | null }) {
  return (
    <aside className="flex w-72 flex-col border-l border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Inspector
      </div>
      <div className="flex-1 overflow-auto p-3 text-sm">
        {channel === null ? (
          <p className="text-muted-foreground">
            No channel selected. Frame detail, config, and stats appear here.
          </p>
        ) : (
          <div className="space-y-3">
            <section>
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Detail
              </h3>
              <p className="mt-1 font-mono text-xs break-all">{channel.endpoint}</p>
            </section>
            <section>
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Config
              </h3>
              <p className="mt-1 text-muted-foreground">
                Baud {channel.baudRate ?? "—"} · wave-2 channel config plugs in here.
              </p>
            </section>
            <section>
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Stats
              </h3>
              <p className="mt-1 font-mono text-xs">
                RX {channel.rxBytes} B · TX {channel.txBytes} B
              </p>
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}
