import type { Parity, StopBits } from "../../mygo";

/** Framing kinds from CONTEXT.md (delimiter, length-prefix, fixed-size, header-length-checksum). */
export type FramingKind =
  | "delimiter"
  | "length-prefix"
  | "fixed-size"
  | "header-checksum";

export type FrameDirection = "rx" | "tx";

/**
 * One complete message cut from a byte stream by a framing implementation.
 * Duck-typed locally so the inspector stays mock-prop driven and decoupled
 * from the future channel/frame store shape.
 */
export interface InspectorFrame {
  id: string;
  channelName: string;
  direction: FrameDirection;
  /** Epoch millis when the frame was captured. */
  timestampMs: number;
  payload: Uint8Array;
}

/** Serial + framing settings edited in the config tab (local state only). */
export interface ChannelConfigValue {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: Parity;
  stopBits: StopBits;
  framing: FramingKind;
  /**
   * Framing parameter: delimiter hex (e.g. "0A"), length-field size, fixed
   * size, or checksum name — interpreted per `framing`. Free text keeps the
   * panel duck-typed until the framing store lands.
   */
  framingOption: string;
  /**
   * Read timeout in ms. 0 = library default, negative = disabled (mirrors
   * OpenRequest.readTimeoutMs semantics in src/mygo.ts).
   */
  readTimeoutMs: number;
}

/** One throughput bucket for the rolling curve. */
export interface ThroughputSample {
  /** Epoch millis of the bucket start. */
  t: number;
  rxBytes: number;
  txBytes: number;
}

/** Session-wide counters plus recent per-second buckets. */
export interface SessionStatsValue {
  startedAtMs: number;
  rxBytes: number;
  txBytes: number;
  rxFrames: number;
  txFrames: number;
  framingErrors: number;
  checksumErrors: number;
  /** Ascending by t; panel clips to the trailing 60 s window. */
  samples: ThroughputSample[];
}

export const DEFAULT_CONFIG: ChannelConfigValue = {
  port: "",
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: "1",
  framing: "delimiter",
  framingOption: "0A",
  readTimeoutMs: 0,
};

export function emptyStats(nowMs = Date.now()): SessionStatsValue {
  return {
    startedAtMs: nowMs,
    rxBytes: 0,
    txBytes: 0,
    rxFrames: 0,
    txFrames: 0,
    framingErrors: 0,
    checksumErrors: 0,
    samples: [],
  };
}
