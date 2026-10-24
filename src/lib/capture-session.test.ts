import { describe, expect, it } from "vitest";
import type { Frame } from "../components/frames/types";
import type { FramingError } from "../mygo";
import {
  applyDropped,
  applyFramingError,
  captureFor,
  clearCaptureFrames,
  EMPTY_CAPTURE_SESSION,
  ingestCaptureBatch,
  markCaptureRead,
  recordSendFailure,
  recordSentFrame,
  removeCaptureSessions,
  resetCaptureCounters,
} from "./capture-session";
import { createFrame } from "./frame-identity";

function frame(ts: number, size: number, dir: "in" | "out"): Frame {
  return createFrame({ ts, dir, payload: new Uint8Array(size) });
}

const framingError: FramingError = {
  channel: "/dev/ttyUSB0",
  kind: "checksum",
  message: "bad checksum",
  oversize: 0,
  checksum: 1,
  other: 0,
  tsMillis: 10,
};

describe("Capture Session", () => {
  it("applies RX frames, statistics, bytes, and unread in one transition", () => {
    const sessions = ingestCaptureBatch(
      {},
      new Map([
        [
          "serial-1",
          {
            endpoint: "/dev/ttyUSB0",
            frames: [frame(1_000, 3, "in"), frame(1_001, 2, "out")],
          },
        ],
      ]),
      null,
    );
    expect(sessions["serial-1"]).toMatchObject({
      unread: 1,
      rxBytes: 3,
      txBytes: 2,
      stats: { frames: 2, bytes: 5, rxBytes: 3, txBytes: 2 },
    });
    expect(sessions["serial-1"]?.frames.frames).toHaveLength(2);
  });

  it("does not mark the active Channel as unread", () => {
    const sessions = ingestCaptureBatch(
      {},
      new Map([["serial-1", { endpoint: "/dev/ttyUSB0", frames: [frame(1, 0, "in")] }]]),
      "serial-1",
    );
    expect(sessions["serial-1"]).toMatchObject({ unread: 0, rxBytes: 0 });
    expect(sessions["serial-1"]?.stats.frames).toBe(1);
  });

  it("keeps Framing errors and backpressure telemetry in the same session", () => {
    let sessions = applyFramingError({}, "serial-1", framingError);
    sessions = applyDropped(sessions, "serial-1", 4);
    expect(sessions["serial-1"]).toMatchObject({
      dropped: 4,
      framingError: { checksum: 1 },
    });
  });

  it("records successful and failed TX without changing unread", () => {
    let sessions = recordSentFrame({}, "serial-1", frame(2_000, 5, "out"));
    sessions = recordSendFailure(
      sessions,
      "serial-1",
      createFrame({
        ts: 2_001,
        dir: "out",
        payload: new Uint8Array(),
        error: "send failed",
      }),
    );
    expect(sessions["serial-1"]).toMatchObject({
      unread: 0,
      txBytes: 5,
      stats: { frames: 1, sendErrors: 1 },
    });
    expect(sessions["serial-1"]?.frames.frames.at(-1)?.error).toBe("send failed");
  });

  it("keeps clear and counter reset independent", () => {
    const sessions = ingestCaptureBatch(
      {},
      new Map([["serial-1", { endpoint: "/dev/ttyUSB0", frames: [frame(1, 3, "in")] }]]),
      null,
    );
    const cleared = clearCaptureFrames(sessions, "serial-1");
    expect(cleared["serial-1"]?.frames.frames).toHaveLength(0);
    expect(cleared["serial-1"]?.stats.frames).toBe(1);

    const reset = resetCaptureCounters(cleared, "serial-1");
    expect(reset["serial-1"]?.frames.frames).toHaveLength(0);
    expect(reset["serial-1"]?.stats).toEqual(EMPTY_CAPTURE_SESSION.stats);
    expect(reset["serial-1"]).toMatchObject({ rxBytes: 0, txBytes: 0 });
  });

  it("marks read and removes capture state by Channel identity", () => {
    let sessions = ingestCaptureBatch(
      {},
      new Map([["serial-1", { endpoint: "/dev/ttyUSB0", frames: [frame(1, 1, "in")] }]]),
      null,
    );
    sessions = markCaptureRead(sessions, "serial-1");
    expect(captureFor(sessions, "serial-1")?.unread).toBe(0);
    expect(captureFor(removeCaptureSessions(sessions, ["serial-1"]), "serial-1")).toBeNull();
  });

  it("keeps retention behind the same capture interface", () => {
    const frames = Array.from({ length: 5_001 }, (_, index) => frame(index, 1, "in"));
    const sessions = ingestCaptureBatch(
      {},
      new Map([["serial-1", { endpoint: "/dev/ttyUSB0", frames }]]),
      "serial-1",
    );
    expect(sessions["serial-1"]?.frames.frames).toHaveLength(5_000);
    expect(sessions["serial-1"]?.frames.frames[0]?.ts).toBe(1);
  });

  it("supports the complete feed-send-clear-reset-remove lifecycle", () => {
    let sessions = ingestCaptureBatch(
      {},
      new Map([["serial-1", { endpoint: "/dev/ttyUSB0", frames: [frame(1, 3, "in")] }]]),
      null,
    );
    sessions = recordSentFrame(sessions, "serial-1", frame(2, 2, "out"));
    sessions = clearCaptureFrames(sessions, "serial-1");
    sessions = resetCaptureCounters(sessions, "serial-1");
    expect(sessions["serial-1"]).toMatchObject({
      unread: 1,
      rxBytes: 0,
      txBytes: 0,
      frames: { frames: [], bytes: 0 },
      stats: { frames: 0, bytes: 0 },
    });
    expect(removeCaptureSessions(sessions, ["serial-1"])).toEqual({});
  });
});
