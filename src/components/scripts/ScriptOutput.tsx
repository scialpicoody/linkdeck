import { ArrowDownToLine, Copy, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  filterScriptOutput,
  formatScriptOutputForCopy,
  SCRIPT_OUTPUT_TYPES,
  type ScriptOutputTypeFilter,
  scriptOutputRunIds,
} from "../../lib/script-output";
import { cn } from "../../lib/utils";
import { Hint } from "../ui/Hint";
import type { ScriptOutputRow, ScriptOutputType } from "./types";
import { ERROR_LINE_RE } from "./types";

export interface ScriptOutputProps {
  /** JSON-lines shaped rows to render, oldest first. */
  rows: ScriptOutputRow[];
  /** Fired with the 1-based line when the user clicks an error reference. */
  onErrorLine?: (line: number) => void;
}

const TYPE_STYLE: Record<ScriptOutputRow["type"], string> = {
  log: "text-foreground",
  tx: "text-accent-foreground",
  rx: "text-foreground",
  unmatched: "text-warning",
  error: "text-red-500 dark:text-red-400",
  system: "text-muted-foreground",
};

const TYPE_LABEL: Record<ScriptOutputType, string> = {
  log: "Log",
  tx: "TX",
  rx: "RX",
  unmatched: "Unmatched",
  error: "Error",
  system: "System",
};

const ALL_RUNS = "__script-output-all-runs__";
const SYSTEM_RUN = "__script-output-system-run__";
const RUN_PREFIX = "run:";

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

function formatRun(runId: string): string {
  if (runId === "") return "Session / system";
  return runId.length > 18 ? `${runId.slice(0, 17)}…` : runId;
}

function runFilterValue(runId: string | null): string {
  if (runId === null) return ALL_RUNS;
  return runId === "" ? SYSTEM_RUN : `${RUN_PREFIX}${runId}`;
}

function runIdFromFilter(value: string): string | null {
  if (value === ALL_RUNS) return null;
  if (value === SYSTEM_RUN) return "";
  return value.startsWith(RUN_PREFIX) ? value.slice(RUN_PREFIX.length) : null;
}

function errorLine(row: ScriptOutputRow): number | null {
  if (row.type !== "error") return null;
  if (row.line !== null) return row.line;
  const match = ERROR_LINE_RE.exec(row.data);
  return match?.[1] ? Number(match[1]) : null;
}

export default function ScriptOutput({ rows, onErrorLine }: ScriptOutputProps) {
  const [pausedRows, setPausedRows] = useState<ScriptOutputRow[] | null>(null);
  const [follow, setFollow] = useState(true);
  const [typeFilter, setTypeFilter] = useState<ScriptOutputTypeFilter>("all");
  const [runFilter, setRunFilter] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Clear and active-script switches must not leave an unrelated paused view.
  useEffect(() => {
    if (rows.length === 0) setPausedRows(null);
  }, [rows.length]);

  const liveScript = rows[0]?.script ?? null;
  const pausedScript = pausedRows?.[0]?.script ?? null;
  useEffect(() => {
    if (pausedRows !== null && liveScript !== null && liveScript !== pausedScript) {
      setPausedRows(null);
    }
  }, [liveScript, pausedRows, pausedScript]);

  const baseRows = pausedRows ?? rows;
  const paused = pausedRows !== null;
  const visible = useMemo(
    () => filterScriptOutput(baseRows, { type: typeFilter, runId: runFilter }),
    [baseRows, typeFilter, runFilter],
  );
  const runIds = useMemo(() => scriptOutputRunIds(baseRows), [baseRows]);
  const availableRunIds =
    runFilter !== null && !runIds.includes(runFilter) ? [...runIds, runFilter] : runIds;
  const filtered = typeFilter !== "all" || runFilter !== null;
  const newWhilePaused = useMemo(() => {
    if (pausedRows === null) return 0;
    const pausedIds = new Set(pausedRows.map((row) => row.id));
    return rows.reduce((count, row) => count + (pausedIds.has(row.id) ? 0 : 1), 0);
  }, [pausedRows, rows]);
  const tailId = visible[visible.length - 1]?.id ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new visible tail is the scroll trigger.
  useEffect(() => {
    if (follow && !paused) endRef.current?.scrollIntoView({ block: "end" });
  }, [tailId, follow, paused]);

  async function copyFilteredRows(): Promise<void> {
    if (visible.length === 0) return;
    try {
      await navigator.clipboard.writeText(formatScriptOutputForCopy(visible));
      toast.success(`${visible.length} output ${visible.length === 1 ? "row" : "rows"} copied`);
    } catch (error) {
      toast.error("Copy script output failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-panel-raised px-2 py-1">
        <label>
          <span className="sr-only">Filter by output type</span>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as ScriptOutputTypeFilter)}
            className="h-6 max-w-28 border border-border bg-card px-1 font-mono text-[8px] uppercase text-muted-foreground focus:border-ring focus:outline-none"
          >
            <option value="all">All types</option>
            {SCRIPT_OUTPUT_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="sr-only">Filter by script run</span>
          <select
            value={runFilterValue(runFilter)}
            onChange={(event) => setRunFilter(runIdFromFilter(event.target.value))}
            className="h-6 max-w-36 border border-border bg-card px-1 font-mono text-[8px] text-muted-foreground focus:border-ring focus:outline-none"
          >
            <option value={ALL_RUNS}>All runs</option>
            {availableRunIds.map((runId) => (
              <option key={runId || SYSTEM_RUN} value={runFilterValue(runId)}>
                {formatRun(runId)}
              </option>
            ))}
          </select>
        </label>

        <span aria-live="polite" className="font-mono text-[8px] uppercase text-muted-foreground">
          {visible.length}/{baseRows.length} rows
          {paused && ` · paused${newWhilePaused > 0 ? ` · +${newWhilePaused}` : ""}`}
        </span>

        <div className="ml-auto flex items-center gap-0.5">
          <Hint label={paused ? "Resume live output" : "Pause output view"}>
            <button
              type="button"
              aria-pressed={paused}
              aria-label={paused ? "Resume live output" : "Pause output view"}
              onClick={() => setPausedRows((current) => (current === null ? rows : null))}
              className={cn(
                "grid size-6 place-items-center border border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
                paused && "border-border bg-card text-warning",
              )}
            >
              {paused ? <Play size={11} /> : <Pause size={11} />}
            </button>
          </Hint>
          <Hint label={follow ? "Stop following newest output" : "Follow newest output"}>
            <button
              type="button"
              aria-pressed={follow}
              aria-label={follow ? "Stop following newest output" : "Follow newest output"}
              onClick={() => setFollow((value) => !value)}
              className={cn(
                "grid size-6 place-items-center border border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
                follow && "border-border bg-card text-accent-foreground",
              )}
            >
              <ArrowDownToLine size={11} />
            </button>
          </Hint>
          <Hint label={`Copy ${visible.length} filtered ${visible.length === 1 ? "row" : "rows"}`}>
            <button
              type="button"
              disabled={visible.length === 0}
              onClick={() => void copyFilteredRows()}
              aria-label={`Copy ${visible.length} filtered ${visible.length === 1 ? "row" : "rows"}`}
              className="inline-flex h-6 items-center gap-1 border border-border bg-card px-1.5 font-mono text-[8px] uppercase text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Copy size={10} aria-hidden="true" />
              Copy
            </button>
          </Hint>
        </div>
      </div>

      <div
        role="log"
        aria-label="Script output"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2 font-mono text-xs focus:outline-none"
      >
        {visible.length === 0 ? (
          <div className="font-sans text-sm text-muted-foreground">
            {baseRows.length === 0 ? (
              <p>No output yet — run a script to see linked output here.</p>
            ) : (
              <>
                <p>No output matches these filters.</p>
                {filtered && (
                  <button
                    type="button"
                    onClick={() => {
                      setTypeFilter("all");
                      setRunFilter(null);
                    }}
                    className="mt-1 font-mono text-[9px] uppercase underline decoration-dotted underline-offset-2 hover:text-foreground"
                  >
                    Reset filters
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          visible.map((row) => {
            const line = errorLine(row);
            return (
              <div key={row.id} className={`flex gap-2 ${TYPE_STYLE[row.type]}`}>
                <span className="shrink-0 text-muted-foreground">{formatTime(row.ts)}</span>
                <span className="shrink-0 uppercase text-muted-foreground">
                  {row.type}
                  {row.direction === "local" ? "" : row.direction === "in" ? " ←" : " →"}
                </span>
                {row.channel && (
                  <span className="max-w-40 shrink-0 truncate text-muted-foreground">
                    {row.channel}
                  </span>
                )}
                {line !== null && onErrorLine ? (
                  <button
                    type="button"
                    title={`Jump to line ${line}`}
                    onClick={() => onErrorLine(line)}
                    className="min-w-0 flex-1 cursor-pointer truncate rounded bg-muted px-1 text-left underline decoration-dotted underline-offset-2 hover:bg-accent"
                  >
                    {row.data}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{row.data}</span>
                )}
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
