/**
 * Shared script workspace and runtime view types.
 */

/** One runnable script in the library list. */
export interface ScriptEntry {
  /** Stable id (workspace-relative path for scanned entries). */
  id: string;
  /** Display name (file name without directory). */
  name: string;
  /** Workspace-relative path, e.g. `at-probe.lua`. */
  path: string;
  /** Where the entry came from. */
  origin: "workspace" | "favorite";
}

/** Output row kinds. `error` rows may carry a `file.lua:<line>` reference. */
export type ScriptOutputType = "log" | "tx" | "rx" | "unmatched" | "error" | "system";

/** Frame direction from the script's point of view. */
type ScriptDirection = "in" | "out" | "local";

/**
 * One output-pane row. JSON-lines shaped: `{type, channel, direction, data, ts}`.
 * `ts` is a unix-millisecond timestamp; `channel` names the transport
 * (`serial:…`, `tcp:…`) or is empty for local log output.
 */
export interface ScriptOutputRow {
  /** Stable local row identity, generated once when the host row is normalized. */
  id: string;
  /** Stable run id; empty for session lifecycle/system output. */
  runId: string;
  /** Workspace-relative script path this row belongs to. */
  script: string;
  type: ScriptOutputType;
  channel: string;
  direction: ScriptDirection;
  data: string;
  ts: number;
  /** Explicit runtime error line, when the host supplied one. */
  line: number | null;
}

/** Parse `{...}.lua:<line>` / `line <n>` out of an error row, if present. */
export const ERROR_LINE_RE = /(?:\.lua:|:|\bline\s+)(\d+)\b/;
