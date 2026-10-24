import { describe, expect, it } from "vitest";
import type { Frame } from "../components/frames/types";
import {
  type FrameTextSource,
  frameCopyText,
  frameExportFilename,
  serializeFrameExport,
} from "./frame-export";

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    id: "frame-1",
    dir: "in",
    payload: new Uint8Array([0x41, 0x42, 0x0a]),
    ts: Date.UTC(2026, 9, 24, 9, 30, 0, 123),
    ...overrides,
  };
}

function textFrame(overrides: Partial<FrameTextSource> = {}): FrameTextSource {
  return {
    id: "frame-1",
    channelName: "serial-1",
    direction: "rx",
    timestampMs: Date.UTC(2026, 9, 24, 9, 30, 0, 123),
    payload: new Uint8Array([0x41, 0x42, 0x0a]),
    ...overrides,
  };
}

describe("frameCopyText", () => {
  it("renders a complete lowercase hex dump", () => {
    expect(frameCopyText(textFrame(), "hex")).toBe(
      "00000000  41 42 0a                                          |AB.|",
    );
  });

  it("renders printable ASCII and marks binary bytes", () => {
    expect(frameCopyText(textFrame(), "ascii")).toBe("AB\u00b7");
  });

  it("pretty-prints decoded JSON with Frame metadata", () => {
    const decoded = JSON.parse(
      frameCopyText(textFrame({ payload: new TextEncoder().encode('{"ok":true}') }), "json"),
    );
    expect(decoded.meta).toMatchObject({
      id: "frame-1",
      channel: "serial-1",
      direction: "rx",
      length: 11,
    });
    expect(decoded.payload).toEqual({ ok: true });
  });

  it("falls back to decoded text for non-JSON payloads", () => {
    const decoded = JSON.parse(
      frameCopyText(textFrame({ payload: new TextEncoder().encode("AT+CSQ") }), "json"),
    );
    expect(decoded.text).toBe("AT+CSQ");
  });
});

describe("serializeFrameExport", () => {
  const frames = [
    frame(),
    frame({
      id: "frame-2",
      dir: "out",
      payload: new Uint8Array([0x4f, 0x4b]),
      ts: Date.UTC(2026, 9, 24, 9, 30, 1, 456),
      error: 'send failed, port "gone"\nretry later',
    }),
  ];

  it("writes one JSON object per Frame with stable export fields", () => {
    const rows = serializeFrameExport(frames, "jsonl")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(rows).toEqual([
      {
        id: "frame-1",
        timestamp: "2026-10-24T09:30:00.123Z",
        direction: "rx",
        byteCount: 3,
        payloadHex: "41 42 0a",
        error: null,
      },
      {
        id: "frame-2",
        timestamp: "2026-10-24T09:30:01.456Z",
        direction: "tx",
        byteCount: 2,
        payloadHex: "4f 4b",
        error: 'send failed, port "gone"\nretry later',
      },
    ]);
  });

  it("quotes CSV cells and retains failed TX error text", () => {
    const csv = serializeFrameExport(frames, "csv");
    expect(csv).toContain("id,timestamp,direction,byteCount,payloadHex,error\n");
    expect(csv).toContain('frame-2,2026-10-24T09:30:01.456Z,tx,2,4f 4b,"send failed');
    expect(csv).toContain('"send failed, port ""gone""\nretry later"');
  });

  it("returns an empty document for no retained Frames", () => {
    expect(serializeFrameExport([], "jsonl")).toBe("");
    expect(serializeFrameExport([], "csv")).toBe("");
  });
});

describe("frameExportFilename", () => {
  it("uses an ISO-safe timestamp and the chosen extension", () => {
    expect(frameExportFilename("jsonl", Date.UTC(2026, 9, 24, 9, 30, 0, 123))).toBe(
      "linkdeck-frames-2026-10-24T09-30-00-123Z.jsonl",
    );
  });
});
