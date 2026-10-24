import {
  ArrowDownToLine,
  Cable,
  CircleSlash2,
  Pause,
  Play,
  Radio,
  Search,
  SearchX,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Hint } from "../ui/Hint";
import { asciiPreview, formatTs, frameByteLength, frameMatches, hexPreview } from "./format";
import type { DirectionFilter, FrameCodec, FramePanelProps } from "./types";

const TAIL_CAP = 500;
const ROW_GRID =
  "grid-cols-[88px_44px_44px_minmax(0,1fr)] sm:grid-cols-[100px_48px_52px_minmax(0,1fr)]";

/**
 * The frame monitor owns the center of the workbench. Controls live in its
 * compact header; transmit and inspection live in the persistent right dock.
 */
export default function FramePanel({
  channelName,
  frames,
  onSelectFrame,
  onClear,
}: FramePanelProps) {
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [codec, setCodec] = useState<FrameCodec>("ascii");
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const endRef = useRef<HTMLLIElement>(null);

  const visible = useMemo(() => {
    const tail = follow ? frames.slice(-TAIL_CAP) : frames;
    const base = follow ? frames.length - tail.length : 0;
    return tail
      .map((frame, index) => ({ frame, index: base + index }))
      .filter(
        ({ frame }) =>
          (dirFilter === "all" || frame.dir === dirFilter) && frameMatches(frame, query),
      );
  }, [frames, follow, dirFilter, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new visible tail is the scroll trigger.
  useEffect(() => {
    if (follow && !paused) endRef.current?.scrollIntoView({ block: "end" });
  }, [visible.length, follow, paused]);

  function handleSelect(index: number) {
    setSelected(index);
    const frame = frames[index];
    if (frame) onSelectFrame?.(frame, index);
  }

  return (
    <section
      aria-label="Frames"
      className="panel-shadow flex min-h-0 min-w-0 flex-1 flex-col border-x border-border bg-card"
    >
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel-raised px-2.5 py-1.5 sm:px-3">
        <div className="mr-auto flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center border border-border bg-card text-muted-foreground">
            <Radio size={14} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-mono text-[12px] font-medium">
              {channelName ?? "No channel"}
            </h2>
            <p className="mt-0.5 font-mono text-[8px] tracking-[0.12em] text-muted-foreground uppercase">
              {frames.length} frames · live capture
            </p>
          </div>
        </div>

        <div className="flex items-center border border-border bg-card p-0.5">
          {(["all", "in", "out"] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              aria-pressed={dirFilter === direction}
              onClick={() => setDirFilter(direction)}
              className={cn(
                "min-w-7 px-1.5 py-1 font-mono text-[9px] uppercase transition-colors",
                dirFilter === direction
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {direction === "all" ? "All" : direction === "in" ? "RX" : "TX"}
            </button>
          ))}
        </div>

        <div className="flex items-center border border-border bg-card p-0.5">
          {(["ascii", "hex"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={codec === item}
              onClick={() => setCodec(item)}
              className={cn(
                "px-1.5 py-1 font-mono text-[9px] uppercase transition-colors",
                codec === item
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item}
            </button>
          ))}
        </div>

        <label className="relative hidden min-w-0 sm:block">
          <span className="sr-only">Filter frames</span>
          <Search
            size={12}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find bytes…"
            autoComplete="off"
            className="h-7 w-28 border border-input bg-card pr-2 pl-7 font-mono text-[10px] placeholder:text-muted-foreground/75 focus:border-ring focus:outline-none lg:w-36"
          />
        </label>

        <div className="flex items-center gap-0.5">
          <Hint label={paused ? "Resume rendering" : "Pause rendering"}>
            <button
              type="button"
              aria-pressed={paused}
              onClick={() => setPaused((value) => !value)}
              aria-label={paused ? "Resume rendering" : "Pause rendering"}
              className={cn(
                "grid size-7 place-items-center border border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
                paused && "border-border bg-card text-warning",
              )}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}
            </button>
          </Hint>
          <Hint label={follow ? "Stop following tail" : "Follow newest frame"}>
            <button
              type="button"
              aria-pressed={follow}
              onClick={() => setFollow((value) => !value)}
              aria-label={follow ? "Stop following tail" : "Follow newest frame"}
              className={cn(
                "grid size-7 place-items-center border border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
                follow && "border-border bg-card text-accent-foreground",
              )}
            >
              <ArrowDownToLine size={13} />
            </button>
          </Hint>
          <Hint label="Clear captured frames">
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                onClear?.();
              }}
              aria-label="Clear captured frames"
              className="grid size-7 place-items-center border border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          </Hint>
        </div>
      </header>

      <div
        className={cn(
          "grid shrink-0 items-center gap-2 border-b border-border bg-muted/55 px-3 py-1 font-mono text-[8px] tracking-[0.12em] text-muted-foreground uppercase",
          ROW_GRID,
        )}
      >
        <span>Time</span>
        <span>Dir</span>
        <span className="text-right">Bytes</span>
        <span>Payload · {codec}</span>
      </div>

      <ol
        aria-label="Frame rows"
        className="min-h-0 flex-1 overflow-y-auto bg-card font-mono text-[10px] leading-none"
      >
        {visible.length === 0 ? (
          <li className="signal-grid grid min-h-full place-items-center p-5">
            <div className="max-w-xs text-center">
              <span className="mx-auto grid size-12 place-items-center border border-border bg-panel-raised text-muted-foreground">
                {query.length > 0 || dirFilter !== "all" ? (
                  <SearchX size={22} aria-hidden="true" />
                ) : channelName === null ? (
                  <Cable size={22} aria-hidden="true" />
                ) : (
                  <CircleSlash2 size={22} aria-hidden="true" />
                )}
              </span>
              <p className="mt-4 text-[13px] font-medium text-foreground">
                {frames.length === 0
                  ? channelName === null
                    ? "No channel selected"
                    : "Listening for the first frame"
                  : "No frames match this filter"}
              </p>
              <p className="mt-1.5 font-sans text-[11px] leading-relaxed text-muted-foreground">
                {frames.length === 0
                  ? channelName === null
                    ? "Open a serial or TCP channel to start a capture."
                    : "Traffic on this channel will appear here as complete frames."
                  : "Change the direction filter or search query to widen the result."}
              </p>
              {channelName === null && (
                <p className="eyebrow mt-5 text-muted-foreground/65">Awaiting signal path</p>
              )}
            </div>
          </li>
        ) : paused ? (
          <li className="grid min-h-32 place-items-center px-4 text-center">
            <div>
              <Pause size={18} className="mx-auto text-warning" aria-hidden="true" />
              <p className="mt-3 text-[11px] text-muted-foreground">
                Rendering paused · {frames.length} frames retained
              </p>
            </div>
          </li>
        ) : (
          visible.map(({ frame, index }) => {
            const selectedRow = selected === index;
            const inbound = frame.dir === "in";
            return (
              <li key={`${frame.ts}-${index}`}>
                <button
                  type="button"
                  onClick={() => handleSelect(index)}
                  aria-current={selectedRow ? "true" : undefined}
                  className={cn(
                    "grid w-full items-center gap-2 border-b border-border/55 px-3 py-[7px] text-left transition-colors",
                    ROW_GRID,
                    selectedRow ? "bg-secondary/75" : "hover:bg-muted/60",
                  )}
                >
                  <span className="text-muted-foreground">{formatTs(frame.ts)}</span>
                  <span
                    className={cn(
                      "flex items-center gap-1 text-[9px] font-medium",
                      inbound ? "text-rx" : "text-tx",
                    )}
                  >
                    <span className={cn("h-3 w-0.5", inbound ? "bg-rx" : "bg-tx")} />
                    {inbound ? "RX" : "TX"}
                  </span>
                  <span className="text-right text-muted-foreground/85">
                    {frameByteLength(frame.payload)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      frame.error !== undefined
                        ? "text-danger"
                        : inbound
                          ? "text-foreground"
                          : "text-tx",
                    )}
                  >
                    {frame.error ??
                      (codec === "ascii" ? asciiPreview(frame.payload) : hexPreview(frame.payload))}
                  </span>
                </button>
              </li>
            );
          })
        )}
        <li ref={endRef} aria-hidden="true" />
      </ol>
    </section>
  );
}
