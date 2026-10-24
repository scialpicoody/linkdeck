import type { ScriptOutputRow, ScriptOutputType } from "../components/scripts";
import type { OutputRow } from "../mygo";

export const SCRIPT_OUTPUT_TYPES: readonly ScriptOutputType[] = [
  "log",
  "tx",
  "rx",
  "unmatched",
  "error",
  "system",
];

const OUTPUT_TYPES = new Set<ScriptOutputType>(SCRIPT_OUTPUT_TYPES);
const DIRECTIONS = new Set<ScriptOutputRow["direction"]>(["in", "out", "local"]);

export type ScriptOutputTypeFilter = "all" | ScriptOutputType;

export interface ScriptOutputFilters {
  type: ScriptOutputTypeFilter;
  /** A specific run id, or null for all runs. An empty string selects system rows. */
  runId: string | null;
}

let outputRowSequence = 0;

function nextOutputRowId(): string {
  outputRowSequence += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid === undefined
    ? `script-output-${Date.now().toString(36)}-${outputRowSequence.toString(36)}`
    : `script-output-${uuid}`;
}

/** Validate and normalize one host row; unknown shapes are dropped. */
export function scriptOutputFromHost(row: OutputRow): ScriptOutputRow | null {
  if (
    !OUTPUT_TYPES.has(row.type as ScriptOutputType) ||
    !DIRECTIONS.has(row.direction as ScriptOutputRow["direction"])
  ) {
    return null;
  }
  return {
    id: nextOutputRowId(),
    runId: typeof row.runId === "string" ? row.runId : "",
    script: typeof row.script === "string" ? row.script : "",
    type: row.type as ScriptOutputType,
    channel: typeof row.channel === "string" ? row.channel : "",
    direction: row.direction as ScriptOutputRow["direction"],
    data: typeof row.data === "string" ? row.data : "",
    line: Number.isFinite(row.line) && row.line > 0 ? Math.floor(row.line) : null,
    ts: Number.isFinite(row.tsMillis) ? row.tsMillis : Date.now(),
  };
}

/** Retain only the newest rows for the current workbench session. */
export function appendScriptOutput(
  previous: ScriptOutputRow[],
  incoming: ScriptOutputRow[],
  cap = 1000,
): ScriptOutputRow[] {
  if (incoming.length === 0) return previous;
  const next = [...previous, ...incoming];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function outputForScript(rows: ScriptOutputRow[], script: string): ScriptOutputRow[] {
  if (script === "") return [];
  return rows.filter((row) => row.script === script);
}

/** Apply pane filters to rows already scoped to the active script. */
export function filterScriptOutput(
  rows: ScriptOutputRow[],
  { type, runId }: ScriptOutputFilters,
): ScriptOutputRow[] {
  return rows.filter(
    (row) => (type === "all" || row.type === type) && (runId === null || row.runId === runId),
  );
}

/** Unique run ids in first-seen order, including the empty system/session id. */
export function scriptOutputRunIds(rows: ScriptOutputRow[]): string[] {
  return [...new Set(rows.map((row) => row.runId))];
}

/**
 * Format filtered rows as readable TSV for clipboard use. Data stays the final
 * column so multi-line script output remains intact and easy to inspect.
 */
export function formatScriptOutputForCopy(rows: ScriptOutputRow[]): string {
  const header = ["Time", "Type", "Run", "Script", "Channel", "Direction", "Data"].join("\t");
  const body = rows.map((row) =>
    [
      new Date(row.ts).toISOString(),
      row.type,
      row.runId || "-",
      row.script || "-",
      row.channel || "-",
      row.direction,
      row.data,
    ].join("\t"),
  );
  return [header, ...body].join("\n");
}
