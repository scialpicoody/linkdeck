import { describe, expect, it } from "vitest";
import type { Frame } from "../components/frames/types";
import { appendFrames } from "./frame-store";

function frame(payload: number[], ts: number): Frame {
  return { dir: "in", payload: new Uint8Array(payload), ts };
}

describe("appendFrames", () => {
  it("appends in order and counts payload bytes", () => {
    const out = appendFrames({ frames: [frame([1], 1)], bytes: 1 }, [frame([2, 3], 2)]);
    expect(out.frames.map((item) => item.ts)).toEqual([1, 2]);
    expect(out.bytes).toBe(3);
  });

  it("drops the oldest frames past the item cap", () => {
    const out = appendFrames(
      { frames: [frame([1], 1), frame([2], 2)], bytes: 2 },
      [frame([3], 3)],
      { maxFrames: 2, maxBytes: 100 },
    );
    expect(out.frames.map((item) => item.ts)).toEqual([2, 3]);
    expect(out.bytes).toBe(2);
  });

  it("drops oldest frames past the byte cap", () => {
    const out = appendFrames(
      { frames: [], bytes: 0 },
      [frame([1, 2], 1), frame([3, 4], 2), frame([5], 3)],
      { maxFrames: 100, maxBytes: 3 },
    );
    expect(out.frames.map((item) => item.ts)).toEqual([2, 3]);
    expect(out.bytes).toBe(3);
  });

  it("returns the existing buffer when there is no traffic", () => {
    const buffer = { frames: [], bytes: 0 };
    expect(appendFrames(buffer, [])).toBe(buffer);
  });

  it("merges late timestamped rows into one ordered contract", () => {
    const out = appendFrames({ frames: [frame([1], 20)], bytes: 1 }, [frame([2], 10)]);
    expect(out.frames.map((item) => item.ts)).toEqual([10, 20]);
    expect(out.bytes).toBe(2);
  });
});
