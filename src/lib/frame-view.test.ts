import { describe, expect, it } from "vitest";
import type { Frame } from "../components/frames/types";
import { createFrame } from "./frame-identity";
import { visibleFrames } from "./frame-view";

function frame(index: number, dir: "in" | "out" = "in"): Frame {
  return createFrame({ dir, ts: index, payload: new TextEncoder().encode(`frame-${index}`) });
}

describe("frame view semantics", () => {
  it("freezes the Frame snapshot while the live source continues", () => {
    const frames = [frame(1), frame(2), frame(3)];
    const snapshot = frames.slice();
    const live = [...frames.slice(1), frame(4)];
    expect(
      visibleFrames(frames, {
        snapshot,
        follow: true,
        dirFilter: "all",
        query: "",
      }).map((item) => item.ts),
    ).toEqual([1, 2, 3]);
    expect(
      visibleFrames(live, {
        snapshot: null,
        follow: true,
        dirFilter: "all",
        query: "",
      }).map((item) => item.ts),
    ).toEqual([2, 3, 4]);
  });

  it("does not move a paused window as retention rotates at the cap", () => {
    const frames = Array.from({ length: 5_000 }, (_, index) => frame(index));
    const paused = visibleFrames(frames, {
      snapshot: null,
      follow: true,
      dirFilter: "all",
      query: "",
    });
    const snapshot = paused;
    const live = [...frames.slice(1), frame(5_000)];
    const stillPaused = visibleFrames(live, {
      snapshot,
      follow: true,
      dirFilter: "all",
      query: "",
    });

    expect(stillPaused).toEqual(paused);
    expect(live[0]?.ts).toBe(1);
    expect(live.at(-1)?.ts).toBe(5_000);
  });

  it("applies direction and search after the follow cap", () => {
    const frames = Array.from({ length: 510 }, (_, index) =>
      frame(index, index % 2 === 0 ? "in" : "out"),
    );
    const entries = visibleFrames(frames, {
      snapshot: null,
      follow: true,
      dirFilter: "out",
      query: "frame-5",
    });
    expect(entries.every((entry) => entry.ts >= 10 && entry.dir === "out")).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });
});
