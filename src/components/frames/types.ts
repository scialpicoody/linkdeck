/** Frame-table domain types and byte-safe wire conversion helpers. */

/** Direction of a captured frame: inbound from the device, or outbound echo. */
type FrameDirection = "in" | "out";

/** One captured chunk of channel traffic. `ts` is epoch millis. */
export interface Frame {
  /** Stable local identity; never derived from the Frame's array position. */
  readonly id: string;
  dir: FrameDirection;
  /** Raw frame bytes. Never decode this for storage; codecs are view-only. */
  payload: Uint8Array;
  ts: number;
  /** Present when a locally generated TX row represents a failed send. */
  error?: string;
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

const encoder = new TextEncoder();

/**
 * Convert a composer submission to the base64 string expected by mygo for a
 * Go []byte argument. HEX text is `AA BB ...`; ASCII appends the suffix.
 */
export function toWireString(p: SendPayload): {
  wire: string;
  bytes: Uint8Array;
  error: string | null;
} {
  let bytes: Uint8Array;
  if (p.ascii === "hex") {
    const compact = p.text.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(compact)) {
      return { wire: "", bytes: new Uint8Array(), error: "HEX: only 0-9 A-F." };
    }
    if (compact.length % 2 !== 0) {
      return { wire: "", bytes: new Uint8Array(), error: "HEX: odd digits." };
    }
    bytes = new Uint8Array(compact.length / 2);
    for (let i = 0; i < compact.length; i += 2) {
      bytes[i / 2] = Number.parseInt(compact.slice(i, i + 2), 16);
    }
  } else {
    const tail = p.suffix === "lf" ? "\n" : p.suffix === "crlf" ? "\r\n" : "";
    bytes = encoder.encode(p.text + tail);
  }
  return { wire: bytesToBase64(bytes), bytes, error: null };
}

/** Encode bytes as standard base64 without spreading large arrays. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode a base64 payload from the Go frame event. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface FramePanelProps {
  /** Channel display name, or null when nothing is selected. */
  channelName: string | null;
  /** Full frame history for the channel; the panel renders the tail. */
  frames: Frame[];
  /** The Frame selected in the inspector, or null when selection is clear. */
  selectedFrame?: Frame | null;
  /** Row click; the owner wires it to the inspector slide-over (ticket #20). */
  onSelectFrame?: (frame: Frame) => void;
  /** Clear history for this channel. */
  onClear?: () => void;
}
