/**
 * Frame-table domain types (new UI map #16, tickets #17/#19).
 *
 * The frame table is the workbench's primary view: one row per Frame, newest
 * at the bottom. Payloads stay JS strings here to match the App-level frame
 * store; the inspector adapts to Uint8Array when a row is selected.
 */

/** Direction of a captured frame: inbound from the device, or outbound echo. */
type FrameDirection = "in" | "out";

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

/** Send codec selected in the composer. */
export type SendCodec = "ascii" | "hex";

/** Line ending appended to ASCII sends (HEX sends go verbatim). */
export type NewlineSuffix = "none" | "lf" | "crlf";

/** Normalized composer submission. */
export interface SendPayload {
  ascii: SendCodec;
  text: string;
  suffix: NewlineSuffix;
}

/**
 * Convert a composer submission to the wire string for SerialService.send.
 * HEX text is `AA BB …` → raw bytes; ASCII appends the suffix. Returns the
 * string plus a hex-decode error (null when valid).
 */
export function toWireString(p: SendPayload): { wire: string; error: string | null } {
  if (p.ascii === "hex") {
    const compact = p.text.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(compact)) return { wire: "", error: "HEX: only 0-9 A-F." };
    if (compact.length % 2 !== 0) return { wire: "", error: "HEX: odd digits." };
    let wire = "";
    for (let i = 0; i < compact.length; i += 2) {
      wire += String.fromCharCode(Number.parseInt(compact.slice(i, i + 2), 16));
    }
    return { wire, error: null };
  }
  const tail = p.suffix === "lf" ? "\n" : p.suffix === "crlf" ? "\r\n" : "";
  return { wire: p.text + tail, error: null };
}

export interface FramePanelProps {
  /** Channel display name, or null when nothing is selected. */
  channelName: string | null;
  /** Full frame history for the channel; the panel renders the tail. */
  frames: Frame[];
  /** Row click; the owner wires it to the inspector slide-over (ticket #20). */
  onSelectFrame?: (frame: Frame, index: number) => void;
  /** Clear history for this channel. */
  onClear?: () => void;
}
