import { Plus, Settings2 } from "lucide-react";
import { type Channel, stateColor } from "../../lib/channels";

interface SidebarProps {
  channels: Channel[];
  activeId: string | null;
  loading: boolean;
  listError: string | null;
  onOpen: (id: string) => void;
  onSelect: (id: string) => void;
  /** Open the channel dialog in create mode. */
  onAdd: () => void;
  /** Open the channel dialog in edit mode for this channel. */
  onEdit: (id: string) => void;
}

export function Sidebar({
  channels,
  activeId,
  loading,
  listError,
  onOpen,
  onSelect,
  onAdd,
  onEdit,
}: SidebarProps) {
  return (
    <nav
      className="flex w-60 flex-col border-r border-border bg-card"
      aria-label="Workbench sidebar"
    >
      <section className="flex-1 overflow-auto p-2">
        <div className="flex items-center justify-between px-2 pt-1">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Channels
          </h2>
          <button
            type="button"
            onClick={onAdd}
            title="Open a channel…"
            aria-label="Open a channel"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        {loading ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">Scanning ports…</p>
        ) : channels.length === 0 ? (
          <div className="px-2 py-3">
            <p className="text-sm text-muted-foreground">
              {listError ?? "No channels — plug in a serial device."}
            </p>
            <button
              type="button"
              onClick={onAdd}
              className="mt-2 min-h-9 w-full rounded-[var(--radius)] bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Open a channel…
            </button>
          </div>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {channels.map((ch) => (
              <li
                key={ch.id}
                className={`group flex w-full items-center gap-1 rounded-[var(--radius)] px-1 py-0.5 hover:bg-muted ${
                  ch.id === activeId ? "bg-muted" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onOpen(ch.id);
                    onSelect(ch.id);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left text-sm"
                  title={ch.endpoint}
                >
                  <span
                    role="img"
                    aria-label={`state: ${ch.state}`}
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: stateColor(ch.state) }}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{ch.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(ch.id)}
                  title={`Settings for ${ch.name}`}
                  aria-label={`Settings for ${ch.name}`}
                  className="rounded p-1 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-secondary hover:text-foreground"
                >
                  <Settings2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {listError !== null && channels.length > 0 && (
          <p className="px-2 py-2 text-xs text-red-500">Port refresh failed: {listError}</p>
        )}
      </section>
    </nav>
  );
}
