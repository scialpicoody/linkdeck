/** Framing kinds from CONTEXT.md (delimiter, length-prefix, fixed-size, header-length-checksum). */
export type FramingKind = "delimiter" | "length-prefix" | "fixed-size" | "header-checksum";

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
