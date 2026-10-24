/** Framing kinds from CONTEXT.md (delimiter, length-prefix, fixed-size, header-length-checksum). */
export type FramingKind = "delimiter" | "length-prefix" | "fixed-size" | "header-checksum";

/**
 * One complete message cut from a byte stream by a framing implementation.
 * Duck-typed locally so the inspector stays decoupled from the channel and
 * frame-store shapes.
 */
export interface InspectorFrame {
  id: string;
  channelName: string;
  direction: "rx" | "tx";
  /** Epoch millis when the frame was captured. */
  timestampMs: number;
  payload: Uint8Array;
}
