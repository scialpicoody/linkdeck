import { X } from "lucide-react";
import { type Channel, type ChannelTab, stateColor } from "../../lib/channels";
import { cn } from "../../lib/utils";
import { Hint } from "../ui/Hint";

interface TabStripProps {
  tabs: ChannelTab[];
  channels: Channel[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabStrip({ tabs, channels, activeId, onSelect, onClose }: TabStripProps) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  if (tabs.length === 0) {
    return (
      <div className="flex items-center border-b border-border bg-background px-3 py-2 text-sm text-muted-foreground">
        No open channels
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-1 overflow-x-auto border-b border-border bg-background px-2 py-1.5"
      role="tablist"
    >
      {tabs.map((t) => {
        const ch = byId.get(t.channelId);
        const label = ch?.name ?? t.channelId;
        const state = ch?.state ?? "disconnected";
        const unread = ch?.unread ?? 0;
        const isActive = t.channelId === activeId;
        return (
          <div
            key={t.channelId}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(t.channelId);
              }
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-[var(--radius)] border px-2 py-1 text-sm whitespace-nowrap",
              isActive ? "border-border bg-card" : "border-transparent hover:bg-muted",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(t.channelId)}
              className="flex items-center gap-1.5"
            >
              <span
                role="img"
                aria-label={`state: ${state}`}
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: stateColor(state) }}
              />
              <span className="font-mono text-xs">{label}</span>
              {unread > 0 && (
                <span className="rounded-full bg-secondary px-1.5 font-mono text-[11px] text-secondary-foreground">
                  {unread}
                </span>
              )}
            </button>
            <Hint label={`Close ${label}`}>
              <button
                type="button"
                onClick={() => onClose(t.channelId)}
                aria-label={`Close ${label}`}
                className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </Hint>
          </div>
        );
      })}
    </div>
  );
}
