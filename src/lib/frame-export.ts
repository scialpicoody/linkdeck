import { toHex } from "../components/frames/format";
import type { Frame } from "../components/frames/types";

export type FrameCopyFormat = "ascii" | "hex" | "json";
export type FrameExportFormat = "csv" | "jsonl";

export interface FrameTextSource {
  id: string;
  channelName: string;
  direction: "rx" | "tx";
  timestampMs: number;
  payload: Uint8Array;
  error?: string;
}

interface FrameExportRow {
  id: string;
  timestamp: string;
  direction: "rx" | "tx";
  byteCount: number;
  payloadHex: string;
  error: string | null;
}

const HEX_CHARS = "0123456789abcdef";

function byteToHex(byte: number): string {
  return HEX_CHARS.charAt((byte >> 4) & 0xf) + HEX_CHARS.charAt(byte & 0xf);
}

function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

function asciiText(payload: Uint8Array): string {
  let out = "";
  for (const byte of payload) out += isPrintable(byte) ? String.fromCharCode(byte) : "\u00b7";
  return out;
}

function hexText(payload: Uint8Array): string {
  const rows: string[] = [];
  for (let offset = 0; offset < payload.length; offset += 16) {
    const slice = payload.slice(offset, offset + 16);
    const hex: string[] = [];
    let ascii = "";
    for (let index = 0; index < 16; index++) {
      const byte = slice[index];
      if (byte === undefined) {
        hex.push("  ");
      } else {
        hex.push(byteToHex(byte));
        ascii += isPrintable(byte) ? String.fromCharCode(byte) : ".";
      }
      if (index === 7) hex.push("");
    }
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex.join(" ")}  |${ascii}|`);
  }
  return rows.join("\n");
}

function decodedText(payload: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(payload);
}

function jsonText(frame: FrameTextSource): string {
  const meta: Record<string, unknown> = {
    id: frame.id,
    channel: frame.channelName,
    direction: frame.direction,
    timestamp: timestampText(frame.timestampMs),
    length: frame.payload.length,
  };
  if (frame.error !== undefined) meta.error = frame.error;

  const text = decodedText(frame.payload);
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    try {
      const payload: unknown = JSON.parse(trimmed);
      return JSON.stringify({ meta, payload }, null, 2);
    } catch {
      // Not JSON; expose the decoded text with the Frame metadata.
    }
  }
  return JSON.stringify({ meta, text }, null, 2);
}

/** Serialize one selected Frame in the same forms shown by the Inspector tabs. */
export function frameCopyText(frame: FrameTextSource, format: FrameCopyFormat): string {
  switch (format) {
    case "hex":
      return hexText(frame.payload);
    case "ascii":
      return asciiText(frame.payload);
    case "json":
      return jsonText(frame);
  }
}

function timestampText(timestampMs: number): string {
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function exportRow(frame: Frame): FrameExportRow {
  return {
    id: frame.id,
    timestamp: timestampText(frame.ts),
    direction: frame.dir === "in" ? "rx" : "tx",
    byteCount: frame.payload.length,
    payloadHex: toHex(frame.payload),
    error: frame.error ?? null,
  };
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Serialize the retained Frame window without consulting its array positions. */
export function serializeFrameExport(frames: readonly Frame[], format: FrameExportFormat): string {
  if (frames.length === 0) return "";
  const rows = frames.map(exportRow);
  if (format === "jsonl") {
    return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  }

  const header = ["id", "timestamp", "direction", "byteCount", "payloadHex", "error"];
  const body = rows.map((row) =>
    [
      csvCell(row.id),
      csvCell(row.timestamp),
      csvCell(row.direction),
      csvCell(row.byteCount),
      csvCell(row.payloadHex),
      csvCell(row.error),
    ].join(","),
  );
  return `${[header.join(","), ...body].join("\n")}\n`;
}

export function frameExportFilename(format: FrameExportFormat, now = Date.now()): string {
  const timestamp = new Date(now).toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `linkdeck-frames-${timestamp}.${format}`;
}
