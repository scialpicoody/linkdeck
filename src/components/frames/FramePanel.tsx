import { useMemo, useState } from "react";
import Composer from "./Composer";
import { asciiPreview, formatTs, frameByteLength, frameMatches, hexPreview } from "./format";
import type { DirectionFilter, FrameCodec, FramePanelProps } from "./types";

/**
 * Frame table: the workbench's primary view (#17).
 *
 * One row per frame (time / direction / length / payload preview), newest at
 * the bottom with follow-tail. The toolbar owns the debugging loop: pause,
 * follow, codec, direction filter, search, clear. Floods reuse the terminal
 * slice's counters until its removal; selection/clear/send callbacks are
 * owned by the parent (inspector in #20, send upgrades in #19).
 */

const TAIL_CAP = 500;

export default function FramePanel({
  channelName,
  frames,
  onSelectFrame,
  onClear,
  onSend,
  canSend = false,
  sending = false,
  sendError = null,
}: FramePanelProps) {
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [codec, setCodec] = useState<FrameCodec>("ascii");
  const [dirFilter, setDirFilter] = useState<DirectionFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const visible = useMemo(() => {
    const tail = follow ? frames.slice(-TAIL_CAP) : frames;
    const base = follow ? frames.length - tail.length : 0;
    return tail
      .map((frame, i) => ({ frame, index: base + i }))
      .filter(
        ({ frame }) =>
          (dirFilter === "all" || frame.dir === dirFilter) && frameMatches(frame, query),
      );
  }, [frames, follow, dirFilter, query]);

  function handleSelect(index: number) {
    setSelected(index);
    const frame = frames[index];
    if (frame) onSelectFrame?.(frame, index);
  }

  return (
    <section aria-label="Frames" className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="mr-auto min-w-0 truncate font-mono text-sm font-medium">
          {channelName ?? "No channel"}
        </h2>
        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">Direction filter</legend>
          {(["all", "in", "out"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={dirFilter === d}
              onClick={() => setDirFilter(d)}
              className={
                dirFilter === d
                  ? "rounded-md bg-secondary px-2 py-1 text-xs font-medium"
                  : "rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              }
            >
              {d === "all" ? "All" : d === "in" ? "RX" : "TX"}
            </button>
          ))}
        </fieldset>
        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">Payload codec</legend>
          {(["ascii", "hex"] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={codec === c}
              onClick={() => setCodec(c)}
              className={
                codec === c
                  ? "rounded-md bg-secondary px-2 py-1 font-mono text-xs font-medium"
                  : "rounded-md px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-muted"
              }
            >
              {c.toUpperCase()}
            </button>
          ))}
        </fieldset>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter frames…"
          aria-label="Filter frames"
          autoComplete="off"
          className="min-h-8 w-40 rounded-md border border-input bg-card px-2 font-mono text-xs focus:outline-2 focus:outline-ring"
        />
        <button
          type="button"
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
          title={paused ? "Resume" : "Pause"}
          className="rounded-md border border-input px-2 py-1 text-xs hover:bg-muted"
        >
          {paused ? "▶" : "⏸"}
        </button>
        <button
          type="button"
          aria-pressed={follow}
          onClick={() => setFollow((f) => !f)}
          title={follow ? "Unfollow tail" : "Follow tail"}
          className={
            follow
              ? "rounded-md bg-secondary px-2 py-1 text-xs font-medium"
              : "rounded-md border border-input px-2 py-1 text-xs hover:bg-muted"
          }
        >
          Follow
        </button>
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            onClear?.();
          }}
          className="rounded-md border border-input px-2 py-1 text-xs hover:bg-muted"
        >
          Clear
        </button>
      </header>

      <div className="grid shrink-0 grid-cols-[110px_44px_64px_1fr] gap-2 border-b border-border bg-muted/40 px-3 py-1 font-mono text-[11px] text-muted-foreground">
        <span>Time</span>
        <span>Dir</span>
        <span className="text-right">Len</span>
        <span>Payload ({codec})</span>
      </div>

      <ol aria-label="Frame rows" className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {visible.length === 0 && (
          <li className="px-3 py-6 text-center text-muted-foreground">
            {frames.length === 0
              ? (channelName ?? "No channel") === "No channel" && channelName === null
                ? "Open a channel to start capturing frames."
                : "No frames yet — traffic on this channel will appear here."
              : "No frames match the current filter."}
          </li>
        )}
        {!paused &&
          visible.map(({ frame, index }) => (
            <li key={index}>
              <button
                type="button"
                onClick={() => handleSelect(index)}
                aria-current={selected === index}
                className={`grid w-full grid-cols-[110px_44px_64px_1fr] items-baseline gap-2 border-b border-border/50 px-3 py-1 text-left hover:bg-muted/60 ${
                  selected === index ? "bg-secondary/60" : ""
                }`}
              >
                <span className="text-muted-foreground">{formatTs(frame.ts)}</span>
                <span
                  className={
                    frame.dir === "in"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-sky-600 dark:text-sky-400"
                  }
                >
                  {frame.dir === "in" ? "← RX" : "→ TX"}
                </span>
                <span className="text-right text-muted-foreground">
                  {frameByteLength(frame.data)}
                </span>
                <span className="min-w-0 truncate">
                  {codec === "ascii" ? asciiPreview(frame.data) : hexPreview(frame.data)}
                </span>
              </button>
            </li>
          ))}
        {paused && (
          <li className="px-3 py-6 text-center text-muted-foreground">
            Paused — {frames.length} frames held. Resume to render.
          </li>
        )}
      </ol>

      <Composer
        channelName={channelName}
        canSend={canSend}
        sending={sending}
        error={sendError}
        onSend={(payload) => onSend?.(payload)}
      />
    </section>
  );
}
