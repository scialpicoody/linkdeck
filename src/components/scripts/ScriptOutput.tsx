import { useEffect, useMemo, useRef } from "react";
import type { ScriptOutputRow } from "./types";
import { ERROR_LINE_RE } from "./types";

export interface ScriptOutputProps {
  /** JSON-lines shaped rows to render, oldest first. */
  rows: ScriptOutputRow[];
  /**
   * Error-line jump stub: fired with the 1-based line number when the user
   * clicks an error row's line reference. The layout wires this to the
   * editor; runtime errors carry line numbers per spec #9.
   */
  onErrorLine?: (line: number) => void;
}

const TYPE_STYLE: Record<ScriptOutputRow["type"], string> = {
  log: "text-foreground",
  tx: "text-accent-foreground",
  rx: "text-foreground",
  error: "text-red-500 dark:text-red-400",
  system: "text-muted-foreground",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

export default function ScriptOutput({ rows, onErrorLine }: ScriptOutputProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // Pin to the newest row as output streams in. rows.length is the signal on
  // purpose: the body only touches the stable endRef, so the rule's "extra
  // dependency" report is a false positive for this pin-to-bottom pattern.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows.length is the intentional retrigger signal.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [rows.length]);

  const parsed = useMemo(
    () =>
      rows.map((r) => ({
        row: r,
        line: r.type === "error" ? (r.data.match(ERROR_LINE_RE)?.[1] ?? null) : null,
      })),
    [rows],
  );

  return (
    <div
      role="log"
      aria-label="Script output"
      className="flex h-full flex-col gap-0.5 overflow-y-auto bg-card p-2 font-mono text-xs"
    >
      {parsed.length === 0 ? (
        <p className="font-sans text-sm text-muted-foreground">
          No output yet — run a script to see linked output here.
        </p>
      ) : (
        parsed.map(({ row: r, line }, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only rows carry no stable id; ts collides so index completes the identity.
          <div key={`${r.ts}-${i}`} className={`flex gap-2 ${TYPE_STYLE[r.type]}`}>
            <span className="shrink-0 text-muted-foreground">{formatTime(r.ts)}</span>
            <span className="shrink-0 uppercase text-muted-foreground">
              {r.type}
              {r.direction === "local" ? "" : r.direction === "in" ? " ←" : " →"}
            </span>
            {r.channel && (
              <span className="max-w-40 shrink-0 truncate text-muted-foreground">{r.channel}</span>
            )}
            {line !== null && onErrorLine ? (
              <button
                type="button"
                title={`Jump to line ${line}`}
                onClick={() => onErrorLine(Number(line))}
                className="min-w-0 flex-1 cursor-pointer truncate rounded bg-muted px-1 text-left underline decoration-dotted underline-offset-2 hover:bg-accent"
              >
                {r.data}
              </button>
            ) : (
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{r.data}</span>
            )}
          </div>
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}
