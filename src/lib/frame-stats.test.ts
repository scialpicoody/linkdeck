import { describe, expect, it } from "vitest";
import type { Frame } from "../components/frames/types";
import {
  EMPTY_CHANNEL_STATS,
  recordFrames,
  recordSendError,
  sessionErrors,
  throughputSeries,
} from "./frame-stats";

function frame(ts: number, size: number, dir: "in" | "out"): Frame {
  return { ts, dir, payload: new Uint8Array(size) };
}

describe("frame session statistics", () => {
  it("counts retained frames and bytes independently from retention", () => {
    const stats = recordFrames(EMPTY_CHANNEL_STATS, [
      frame(1_000, 3, "in"),
      frame(1_000, 2, "out"),
    ]);
    expect(stats).toMatchObject({ frames: 2, bytes: 5, rxBytes: 3, txBytes: 2 });
  });

  it("bounds throughput buckets to the rolling 60-second window", () => {
    let stats = EMPTY_CHANNEL_STATS;
    stats = recordFrames(stats, [frame(1_000, 1, "in")]);
    stats = recordFrames(stats, [frame(61_000, 2, "in")]);
    expect(stats.buckets.map((bucket) => bucket.sec)).toEqual([61]);
    stats = recordFrames(stats, [frame(62_000, 3, "out")]);
    expect(stats.buckets.map((bucket) => bucket.sec)).toEqual([61, 62]);
  });

  it("fills missing seconds and returns aligned RX/TX series", () => {
    const stats = recordFrames(EMPTY_CHANNEL_STATS, [
      frame(120_000, 5, "in"),
      frame(122_000, 7, "out"),
    ]);
    expect(throughputSeries(stats, 122_000, 3)).toEqual({
      rx: [5, 0, 0],
      tx: [0, 0, 7],
    });
  });

  it("counts send, framing, and drop errors in session totals", () => {
    expect(sessionErrors(recordSendError(EMPTY_CHANNEL_STATS), 4, 2)).toBe(7);
  });
});
