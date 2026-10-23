/**
 * Minimal prop types for the terminal panel.
 *
 * The panel duck-types sibling channel shapes instead of importing them:
 * the integrator aligns these to `lib/channels.ts` when it lands. Any object
 * with a string `name` (or `port`) field is treated as a serial-capable
 * channel; everything else renders with a no-op send stub.
 */

/** Direction of a captured frame: inbound from the device, or outbound echo. */
export type FrameDirection = "in" | "out";

/**
 * One captured chunk of channel traffic. `data` is a JS string of the raw
 * payload; `ts` is epoch millis. Array-shaped so mocks can hand-feed frames.
 */
export interface Frame {
  dir: FrameDirection;
  data: string;
  ts: number;
}

/**
 * Local stand-in for the sibling channel union. Structural on purpose:
 * anything with a string `name`/`port` quacks like a serial channel.
 */
export interface TerminalChannel {
  kind?: string;
  name?: string;
  port?: string;
  id?: string;
  [key: string]: unknown;
}

export interface TerminalPanelProps {
  /** Active channel, or null when nothing is selected. */
  channel: TerminalChannel | null;
  /** Full frame history; the panel incrementally renders the tail. */
  frames: Frame[];
  /**
   * Send seam. When provided it owns the send path (tests/mock parents).
   * When omitted the panel falls back to `SerialService.send` for serial
   * channels and a documented no-op otherwise.
   */
  onSend?: (data: string) => void;
}

/**
 * Duck-type a serial port name out of an unknown sibling channel shape.
 * Returns null when the channel is not serial-capable.
 */
export function serialPortName(channel: TerminalChannel | null): string | null {
  if (channel == null) return null;
  if (typeof channel.name === "string" && channel.name.length > 0) return channel.name;
  if (typeof channel.port === "string" && channel.port.length > 0) return channel.port;
  return null;
}
