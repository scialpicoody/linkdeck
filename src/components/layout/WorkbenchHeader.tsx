import { Activity, Cable, Code2, Plus, Radio } from "lucide-react";
import { type Channel, stateColor } from "../../lib/channels";
import { cn } from "../../lib/utils";
import { Hint } from "../ui/Hint";

export type MainView = "monitor" | "scripts";

interface WorkbenchHeaderProps {
  view: MainView;
  onViewChange: (view: MainView) => void;
  channel: Channel | null;
  onAddChannel: () => void;
}

const VIEWS: { id: MainView; label: string; icon: typeof Activity }[] = [
  { id: "monitor", label: "Monitor", icon: Activity },
  { id: "scripts", label: "Scripts", icon: Code2 },
];

export function WorkbenchHeader({
  view,
  onViewChange,
  channel,
  onAddChannel,
}: WorkbenchHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center border-b border-black/40 bg-chrome px-2.5 text-chrome-foreground sm:px-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center border border-primary/55 bg-primary/15 text-primary">
            <Radio size={15} strokeWidth={2.2} aria-hidden="true" />
          </span>
          <div className="hidden leading-none sm:block">
            <div className="text-[15px] font-semibold tracking-[-0.02em]">LinkDeck</div>
            <div className="mt-1 font-mono text-[8px] tracking-[0.18em] text-chrome-muted uppercase">
              Signal workbench
            </div>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Main view"
          className="ml-2 flex h-8 items-stretch border border-white/12 bg-black/25 p-0.5 sm:ml-5"
        >
          {VIEWS.map((item) => {
            const Icon = item.icon;
            const selected = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onViewChange(item.id)}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 font-mono text-[10px] tracking-wide uppercase transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-chrome-muted hover:bg-white/8 hover:text-chrome-foreground",
                )}
              >
                <Icon size={12} aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2 pl-3">
        {channel !== null ? (
          <div className="hidden min-w-0 items-center gap-2 border-r border-white/12 pr-3 md:flex">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: stateColor(channel.state) }}
              aria-hidden="true"
            />
            <span className="max-w-40 truncate font-mono text-[11px] text-chrome-foreground">
              {channel.name}
            </span>
            <span className="font-mono text-[9px] text-chrome-muted uppercase">
              {channel.state}
            </span>
          </div>
        ) : (
          <span className="hidden font-mono text-[9px] tracking-wide text-chrome-muted uppercase md:inline">
            No channel selected
          </span>
        )}

        <Hint label="Open or configure a channel">
          <button
            type="button"
            onClick={onAddChannel}
            className="flex h-8 items-center gap-1.5 border border-primary/60 bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/88"
          >
            <Plus size={14} aria-hidden="true" />
            Connect
          </button>
        </Hint>

        <span className="hidden items-center gap-1.5 border border-white/12 px-2 py-1.5 font-mono text-[9px] text-chrome-muted uppercase xl:flex">
          <Cable size={12} aria-hidden="true" />
          Serial / TCP
        </span>
      </div>
    </header>
  );
}
