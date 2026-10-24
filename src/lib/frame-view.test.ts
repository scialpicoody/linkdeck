import { describe, expect, it } from "vitest";
import type { Frame } from "../components/frames/types";
import { visibleFrameEntries } from "./frame-view";

function frame(index: number, dir: "in" | "out" = "in"): Frame {
  return { dir, ts: index, payload: new TextEncoder().encode(`frame-${index}`) };
}

describe("frame view semantics", () => {
  it("freezes the existing rows while paused and keeps new rows retained", () => {
    const frames = [frame(1), frame(2), frame(3)];
    expect(
      visibleFrameEntries(frames, {
        pausedAt: 2,
        follow: true,
        dirFilter: "all",
        query: "",
      }).map((item) => item.frame.ts),
    ).toEqual([1, 2]);
  });

  it("applies direction and search after the follow cap", () => {
    const frames = Array.from({ length: 510 }, (_, index) =>
      frame(index, index % 2 === 0 ? "in" : "out"),
    );
    const entries = visibleFrameEntries(frames, {
      pausedAt: null,
      follow: true,
      dirFilter: "out",
      query: "frame-5",
    });
    expect(entries.every((entry) => entry.index >= 10 && entry.frame.dir === "out")).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });
});
