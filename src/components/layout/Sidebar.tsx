import { stateColor, type Channel } from "../../lib/channels";

interface SidebarProps {
  channels: Channel[];
  activeId: string | null;
  loading: boolean;
  listError: string | null;
  onOpen: (id: string) => void;
  onSelect: (id: string) => void;
}

const PRESETS: Array<{ name: string; detail: string }> = [
  { name: "115200 8N1", detail: "Default serial preset" },
  { name: "9600 8N1", detail: "Legacy device preset" },
];

export function Sidebar({ channels, activeId, loading, listError, onOpen, onSelect }: SidebarProps) {
  return (
    <nav className="flex w-60 flex-col border-r border-border bg-card" aria-label="Workbench sidebar">
      <section className="flex-1 overflow-auto p-2">
        <h2 className="px-2 pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Channels
        </h2>
        {loading ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Scanning ports…</p>
        ) : channels.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            {listError ?? "No channels — plug in a serial device."}
          </p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {channels.map((ch) => (
              <li key={ch.id}>
                <button
                  type="button"
                  onClick={() => {
                    onOpen(ch.id);
                    onSelect(ch.id);
                  }}
                  className={`flex w-full items-center gap-2 rounded-[var(--radius)] px-2 py-1.5 text-left text-sm hover:bg-muted ${
                    ch.id === activeId ? "bg-muted" : ""
                  }`}
                  title={ch.endpoint}
                >
                  <span
                    aria-label={`state: ${ch.state}`}
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: stateColor(ch.state) }}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{ch.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {listError !== null && channels.length > 0 && (
          <p className="px-2 py-2 text-xs text-red-500">Port refresh failed: {listError}</p>
        )}

        <h2 className="px-2 pt-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Presets
        </h2>
        <ul className="mt-1 space-y-0.5">
          {PRESETS.map((p) => (
            <li
              key={p.name}
              className="rounded-[var(--radius)] px-2 py-1.5 text-sm text-muted-foreground"
              title={p.detail}
            >
              <span className="font-mono text-xs">{p.name}</span>
            </li>
          ))}
        </ul>

        <h2 className="px-2 pt-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Scripts
        </h2>
        <button
          type="button"
          className="mt-1 w-full rounded-[var(--radius)] px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
          title="Wave-2 script library plugs in here"
        >
          Script library
        </button>
      </section>
      <footer className="border-t border-border p-2 font-mono text-[11px] text-muted-foreground">
        wave-2: run output dock
      </footer>
    </nav>
  );
}
