import type { FramingConfig, Parity, Spec, StopBits } from "../../mygo";
import type { FramingKind } from "../inspector/types";

/**
 * Channel form value for the open/edit dialog (#18).
 *
 * Mirrors OpenRequest for the transport fields plus every framing option.
 * Keeping the fields flat makes the form stable while switching framing kinds.
 */
export interface ChannelFormValue {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: Parity;
  stopBits: StopBits;
  framing: FramingKind;
  delimiterHex: string;
  fixedSize: number;
  lengthOffset: number;
  lengthWidth: number;
  lengthEndian: "big" | "little";
  headerHex: string;
  checksum: "xor" | "sum8" | "crc8";
  maxFrameSize: number;
  readTimeoutMs: number;
}

export const DEFAULT_CHANNEL_FORM: ChannelFormValue = {
  port: "",
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: "1",
  framing: "delimiter",
  delimiterHex: "0A",
  fixedSize: 64,
  lengthOffset: 0,
  lengthWidth: 1,
  lengthEndian: "big",
  headerHex: "AA55",
  checksum: "xor",
  maxFrameSize: 0,
  readTimeoutMs: 0,
};

const HEX_RE = /^[0-9a-fA-F]+$/;

function validHex(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  return compact.length > 0 && compact.length % 2 === 0 && HEX_RE.test(compact);
}

/** Convert the flat dialog state to the bindings-safe Go framing.Spec. */
export function toFramingSpec(value: ChannelFormValue): Spec {
  const base: Spec = {
    kind: value.framing,
    maxFrameSize: value.maxFrameSize > 0 ? value.maxFrameSize : undefined,
  };
  switch (value.framing) {
    case "delimiter":
      return { ...base, delimiterHex: value.delimiterHex.replace(/\s+/g, "") };
    case "fixed-size":
      return { ...base, fixedSize: value.fixedSize };
    case "length-prefix":
      return {
        ...base,
        lengthOffset: value.lengthOffset,
        lengthWidth: value.lengthWidth,
        lengthEndian: value.lengthEndian,
      };
    case "header-checksum":
      return {
        ...base,
        headerHex: value.headerHex.replace(/\s+/g, ""),
        lengthOffset: value.lengthOffset,
        lengthWidth: value.lengthWidth,
        lengthEndian: value.lengthEndian,
        checksum: value.checksum,
      };
  }
}

/** Validate fields locally before crossing the bindings boundary. */
export function validateChannelForm(value: ChannelFormValue): string | null {
  if (value.port.trim().length === 0) return "Port is required.";
  if (value.maxFrameSize < 0) return "Max frame size cannot be negative.";
  if (value.framing === "delimiter" && !validHex(value.delimiterHex)) {
    return "Delimiter must be a complete, non-empty hex byte sequence.";
  }
  if (value.framing === "fixed-size" && value.fixedSize <= 0) {
    return "Fixed frame size must be greater than zero.";
  }
  if (value.framing === "header-checksum" && !validHex(value.headerHex)) {
    return "Header must be a complete, non-empty hex byte sequence.";
  }
  if (
    (value.framing === "length-prefix" || value.framing === "header-checksum") &&
    value.lengthOffset < 0
  ) {
    return "Length offset cannot be negative.";
  }
  if (
    (value.framing === "length-prefix" || value.framing === "header-checksum") &&
    ![1, 2, 4].includes(value.lengthWidth)
  ) {
    return "Length width must be 1, 2, or 4 bytes.";
  }
  return null;
}

function encodeLegacyText(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Convert a generated Go framing.Spec into editable dialog values. */
export function framingFormFromSpec(spec: Spec): Partial<ChannelFormValue> {
  const kind = spec.kind as FramingKind;
  if (!["delimiter", "fixed-size", "length-prefix", "header-checksum"].includes(kind)) {
    return {};
  }
  return {
    framing: kind,
    delimiterHex: spec.delimiterHex ?? DEFAULT_CHANNEL_FORM.delimiterHex,
    fixedSize: spec.fixedSize ?? DEFAULT_CHANNEL_FORM.fixedSize,
    lengthOffset: spec.lengthOffset ?? DEFAULT_CHANNEL_FORM.lengthOffset,
    lengthWidth: spec.lengthWidth ?? DEFAULT_CHANNEL_FORM.lengthWidth,
    lengthEndian: spec.lengthEndian === "little" ? "little" : "big",
    headerHex: spec.headerHex ?? DEFAULT_CHANNEL_FORM.headerHex,
    checksum: spec.checksum === "sum8" || spec.checksum === "crc8" ? spec.checksum : "xor",
    maxFrameSize: spec.maxFrameSize ?? 0,
  };
}

/**
 * Convert config v1 presets (`name` + string `opts`) into the dialog shape.
 * Unknown/missing values fall back to safe defaults for the selected kind.
 */
export function framingFormFromPreset(config: FramingConfig): Partial<ChannelFormValue> {
  if (config.Spec !== undefined && config.Spec !== null) return framingFormFromSpec(config.Spec);
  const kind = config.Name as FramingKind;
  if (!["delimiter", "fixed-size", "length-prefix", "header-checksum"].includes(kind)) {
    return {};
  }
  const opts = config.Opts ?? {};
  const width = Number(opts.width ?? opts.lengthWidth ?? 1);
  return {
    framing: kind,
    delimiterHex:
      opts.delimiterHex ??
      (opts.delimiter !== undefined
        ? encodeLegacyText(opts.delimiter)
        : DEFAULT_CHANNEL_FORM.delimiterHex),
    fixedSize: Number(opts.size ?? opts.fixedSize ?? DEFAULT_CHANNEL_FORM.fixedSize),
    lengthOffset: Number(opts.offset ?? opts.lengthOffset ?? DEFAULT_CHANNEL_FORM.lengthOffset),
    lengthWidth: [1, 2, 4].includes(width) ? width : 1,
    lengthEndian: opts.endian === "little" ? "little" : "big",
    headerHex: opts.headerHex ?? opts.header ?? DEFAULT_CHANNEL_FORM.headerHex,
    checksum: opts.checksum === "sum8" || opts.checksum === "crc8" ? opts.checksum : "xor",
    maxFrameSize: Number(opts.maxFrameSize ?? 0),
  };
}
