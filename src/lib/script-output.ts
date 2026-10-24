import type { ScriptOutputRow, ScriptOutputType } from "../components/scripts";
import type { OutputRow } from "../mygo";

const OUTPUT_TYPES = new Set<ScriptOutputType>(["log", "tx", "rx", "unmatched", "error", "system"]);
const DIRECTIONS = new Set<ScriptOutputRow["direction"]>(["in", "out", "local"]);

/** Validate and normalize one host row; unknown shapes are dropped. */
export function scriptOutputFromHost(row: OutputRow): ScriptOutputRow | null {
  if (
    !OUTPUT_TYPES.has(row.type as ScriptOutputType) ||
    !DIRECTIONS.has(row.direction as ScriptOutputRow["direction"])
  ) {
    return null;
  }
  return {
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
