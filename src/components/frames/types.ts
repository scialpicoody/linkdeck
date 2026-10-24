/**
 * Frame-table domain types (new UI map #16, ticket #17).
 *
 * The frame table is the workbench's primary view: one row per Frame, newest
 * at the bottom, replacing the old xterm terminal. Payloads stay JS strings
 * here to match the App-level frame store; the inspector adapts to
 * Uint8Array when a row is selected.
 */

/** Direction of a captured frame: inbound from the device, or outbound echo. */
export type FrameDirection = "in" | "out";

/** One captured chunk of channel traffic. `ts` is epoch millis. */
export interface Frame {
  dir: FrameDirection;
  data: string;
  ts: number;
}

/** Payload codec for the preview column and search. */
export type FrameCodec = "ascii" | "hex";

/** Direction filter in the toolbar. */
export type DirectionFilter = "all" | FrameDirection;

export interface FramePanelProps {
  /** Channel display name, or null when nothing is selected. */
  channelName: string | null;
  /** Full frame history for the channel; the panel renders the tail. */
  frames: Frame[];
  /** Row click; the owner wires it to the inspector slide-over (ticket #20). */
  onSelectFrame?: (frame: Frame, index: number) => void;
  /** Clear history for this channel. */
  onClear?: () => void;
  /** Send seam, owned by the parent (enhanced with hex/history in #19). */
  onSend?: (data: string) => void;
  /** Whether the send box is usable (false when no sendable channel). */
  canSend?: boolean;
}
