import { Cable, ChevronLeft, ChevronRight, Plus, Power, Settings2 } from "lucide-react";
import { useState } from "react";
import { type Channel, stateColor } from "../../lib/channels";
import { cn } from "../../lib/utils";

interface SidebarProps {
  channels: Channel[];
  activeId: string | null;
  loading: boolean;
  listError: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onClose: (id: string) => void;
}

export function Sidebar({
  channels,
  activeId,
  loading,
  listError,
  onSelect,
  onAdd,
  onEdit,
  onClose,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const connected = channels.filter((channel) => channel.state === "connected").length;

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col border-r border-border bg-card/92 transition-[width] duration-200 md:flex",
        collapsed ? "w-14" : "w-50",
      )}
      aria-label="Channels"
    >
      <div
        className={cn(
          "flex h-11 shrink-0 items-center border-b border-border",
          collapsed ? "justify-center px-1" : "justify-between px-3",
        )}
      >
        {!collapsed && (
          <div className="flex items-baseline gap-2">
            <h2 className="eyebrow text-muted-foreground">Channels</h2>
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {channels.length.toString().padStart(2, "0")}
            </span>
          </div>
        )}
        <div className="flex items-center gap-0.5">
          {!collapsed && (
            <button
              type="button"
              onClick={onAdd}
              title="Open a channel"
              aria-label="Open a channel"
              className="grid size-7 place-items-center text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "Expand channels" : "Collapse channels"}
            aria-label={collapsed ? "Expand channels" : "Collapse channels"}
            className="grid size-7 place-items-center text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {collapsed ? (
              <ChevronRight size={15} aria-hidden="true" />
            ) : (
              <ChevronLeft size={15} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto py-2", collapsed ? "px-1" : "px-1.5")}>
        {loading ? (
          <div className={cn("space-y-1.5", collapsed ? "px-1" : "px-2")}>
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-10 animate-pulse bg-muted/70" />
            ))}
          </div>
        ) : channels.length === 0 ? (
          <div className={cn(collapsed ? "px-0" : "px-1")}>
            {!collapsed && (
              <div className="border border-dashed border-border bg-background/45 px-3 py-4">
                <Cable size={18} className="text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  No channels open. Open a serial port to start capturing frames.
                </p>
                {listError !== null && (
                  <p className="mt-2 text-[11px] leading-snug text-danger">{listError}</p>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={onAdd}
              title="Open a channel"
              className={cn(
                "mt-2 flex h-9 items-center justify-center gap-1.5 border border-primary/60 bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/88",
                collapsed ? "w-9" : "w-full",
              )}
            >
              <Plus size={14} aria-hidden="true" />
              {!collapsed && "Open channel"}
            </button>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {channels.map((channel) => {
              const active = channel.id === activeId;
              return (
                <li key={channel.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(channel.id)}
                    title={collapsed ? `${channel.name} · ${channel.state}` : channel.endpoint}
                    className={cn(
                      "flex min-h-11 w-full items-center text-left transition-colors",
                      collapsed ? "justify-center px-1" : "gap-2.5 px-2.5",
                      active
                        ? "bg-secondary text-foreground"
                        : "text-card-foreground hover:bg-muted/80",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute inset-y-1.5 left-0 w-0.5",
                        active ? "bg-primary" : "bg-transparent",
                      )}
                      aria-hidden="true"
                    />
                    <span
                      className="grid size-6 shrink-0 place-items-center border border-border bg-background/60"
                      aria-hidden="true"
                    >
                      <Cable size={12} />
                    </span>
                    {!collapsed && (
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium">
                            {channel.name}
                          </span>
                          <span
                            className="size-1.5 shrink-0 rounded-full"
                            style={{ backgroundColor: stateColor(channel.state) }}
                          />
                        </span>
                        <span className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[8px] text-muted-foreground uppercase">
                          <span className="truncate">{channel.state}</span>
                          <span className="flex items-center gap-1">
                            {channel.unread > 0 && (
                              <span className="text-primary">
                                {channel.unread > 99 ? "99+" : channel.unread}
                              </span>
                            )}
                            <span>{channel.rxBytes + channel.txBytes} B</span>
                          </span>
                        </span>
                      </span>
                    )}
                  </button>
                  {!collapsed && (
                    <div className="absolute top-1/2 right-1 flex -translate-y-1/2 bg-card/95 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => onEdit(channel.id)}
                        title={`Settings for ${channel.name}`}
                        aria-label={`Settings for ${channel.name}`}
                        className="grid size-6 place-items-center text-muted-foreground hover:text-foreground"
                      >
                        <Settings2 size={12} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onClose(channel.id)}
                        title={`Close ${channel.name}`}
                        aria-label={`Close ${channel.name}`}
                        className="grid size-6 place-items-center text-muted-foreground hover:text-danger"
                      >
                        <Power size={12} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!collapsed && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="flex items-center justify-between font-mono text-[9px] text-muted-foreground uppercase">
            <span>Active links</span>
            <span className="text-foreground">
              {connected}/{channels.length}
            </span>
          </div>
          {listError !== null && channels.length > 0 && (
            <p className="mt-1.5 line-clamp-2 text-[10px] leading-snug text-danger">
              Refresh: {listError}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
