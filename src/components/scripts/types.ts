/**
 * Shared types for the script-library panel (ticket #9).
 *
 * The Go scripting engine lands later: running, workspace scanning, and
 * favorites persistence are all prop stubs here. Output rows are shaped as
 * JSON-lines records so the future engine can stream `JSON.stringify(row)`
 * per line without changing this contract.
 */

/** One runnable script in the library list. */
export interface ScriptEntry {
  /** Stable id (workspace-relative path for scanned entries). */
  id: string;
  /** Display name (file name without directory). */
  name: string;
  /** Workspace-relative path, e.g. `scripts/at-probe.lua`. */
  path: string;
  /** Where the entry came from. */
  origin: "workspace" | "favorite";
}

/** Output row kinds. `error` rows may carry a `file.lua:<line>` reference. */
export type ScriptOutputType = "log" | "tx" | "rx" | "error" | "system";

/** Frame direction from the script's point of view. */
export type ScriptDirection = "in" | "out" | "local";

/**
 * One output-pane row. JSON-lines shaped: `{type, channel, direction, data, ts}`.
 * `ts` is a unix-millisecond timestamp; `channel` names the transport
 * (`serial:…`, `tcp:…`) or is empty for local log output.
 */
export interface ScriptOutputRow {
  type: ScriptOutputType;
  channel: string;
  direction: ScriptDirection;
  data: string;
  ts: number;
}

/** Parse `{...}.lua:<line>` / `line <n>` out of an error row, if present. */
export const ERROR_LINE_RE = /(?:\.lua:|:|\bline\s+)(\d+)\b/;
