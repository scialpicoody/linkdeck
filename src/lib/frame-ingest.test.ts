import { describe, expect, it } from "vitest";
import type { Channel } from "./channels";
import { decodeFrameBatch } from "./frame-ingest";

const channel: Channel = {
  id: "serial-1",
  name: "ttyUSB0",
  kind: "serial",
  state: "connected",
  endpoint: "/dev/ttyUSB0",
  backendKey: "/dev/ttyUSB0",
  config: {
    transport: "serial",
    baudRate: 115200,
    dataBits: 8,
    parity: "none",
    stopBits: "1",
    readTimeoutMs: 0,
    framing: { kind: "delimiter", delimiterHex: "0A" },
  },
};

describe("frame event ingestion", () => {
  it("decodes RX and TX into one ordering model", () => {
    const result = decodeFrameBatch(
      [
        { channel: "/dev/ttyUSB0", dir: "rx", payload: "QUI=", tsMillis: 10 },
        { channel: "/dev/ttyUSB0", dir: "tx", payload: "Q0Q=", tsMillis: 11 },
      ],
      [channel],
    );
    expect(result.malformed).toBe(0);
    expect(result.byChannel.get("serial-1")?.frames.map((frame) => frame.dir)).toEqual([
      "in",
      "out",
    ]);
    const ids = result.byChannel.get("serial-1")?.frames.map((frame) => frame.id) ?? [];
    expect(new Set(ids).size).toBe(2);
  });

  it("drops malformed and unknown-channel events without phantom state", () => {
    const result = decodeFrameBatch(
      [
        { channel: "/dev/ttyUSB0", dir: "rx", payload: "!!!", tsMillis: 10 },
        { channel: "gone", dir: "rx", payload: "QUI=", tsMillis: 11 },
        { channel: "/dev/ttyUSB0", dir: "sideways", payload: "QUI=", tsMillis: 12 },
      ],
      [channel],
    );
    expect(result.malformed).toBe(1);
    expect(result.byChannel.size).toBe(0);
  });
});
