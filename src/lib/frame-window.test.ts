import { describe, expect, it } from "vitest";
import type { Frame } from "../components/frames/types";
import { createFrame } from "./frame-identity";
import {
  FRAME_ROW_HEIGHT,
  FRAME_WINDOW_OVERSCAN,
  framePageSize,
  frameWindow,
  nextFrameIndex,
  scrollTopForFrame,
} from "./frame-window";

function frame(index: number): Frame {
  return createFrame({ dir: "in", payload: new Uint8Array([index]), ts: index });
}

describe("frameWindow", () => {
  it("returns an empty window for an empty Frame set", () => {
    expect(frameWindow(0, 0, 400)).toEqual({
      startIndex: 0,
      endIndex: 0,
      topSpacer: 0,
      bottomSpacer: 0,
      totalHeight: 0,
    });
  });

  it("bounds rows for the full 5000-Frame retention window", () => {
    const window = frameWindow(5_000, 62_500, 400);
    const renderedRows = window.endIndex - window.startIndex;

    expect(renderedRows).toBeLessThanOrEqual(
      Math.ceil(400 / FRAME_ROW_HEIGHT) + FRAME_WINDOW_OVERSCAN * 2,
    );
    expect(window.totalHeight).toBe(5_000 * FRAME_ROW_HEIGHT);
    expect(window.topSpacer + renderedRows * FRAME_ROW_HEIGHT + window.bottomSpacer).toBe(
      window.totalHeight,
    );
  });

  it("covers fractional scroll positions without a blank viewport gap", () => {
    const scrollTop = FRAME_ROW_HEIGHT * 10 + 7;
    const viewportHeight = FRAME_ROW_HEIGHT * 8 + 11;
    const window = frameWindow(100, scrollTop, viewportHeight);
    const lastVisible = Math.floor((scrollTop + viewportHeight - 1) / FRAME_ROW_HEIGHT);

    expect(window.startIndex).toBeLessThanOrEqual(Math.floor(scrollTop / FRAME_ROW_HEIGHT));
    expect(window.endIndex).toBeGreaterThan(lastVisible);
  });

  it("clamps scroll beyond either edge and keeps the viewport populated", () => {
    expect(frameWindow(100, -50, 100).startIndex).toBe(0);

    const atEnd = frameWindow(100, 1_000_000, 100);
    expect(atEnd.endIndex).toBe(100);
    expect(atEnd.bottomSpacer).toBe(0);
    expect(atEnd.endIndex).toBeGreaterThan(atEnd.startIndex);
  });

  it("renders at least one row before viewport measurement completes", () => {
    const window = frameWindow(100, 0, 0);
    expect(window.endIndex).toBeGreaterThan(window.startIndex);
  });
});

describe("framePageSize", () => {
  it("uses complete viewport rows and never returns zero", () => {
    expect(framePageSize(FRAME_ROW_HEIGHT * 12 + 10)).toBe(12);
    expect(framePageSize(0)).toBe(1);
  });
});

describe("scrollTopForFrame", () => {
  it("keeps an already visible row at the current scroll offset", () => {
    expect(scrollTopForFrame(100, 200, 8)).toBe(100);
  });

  it("reveals rows above or below the viewport with minimal movement", () => {
    expect(scrollTopForFrame(100, 200, 2)).toBe(50);
    expect(scrollTopForFrame(100, 200, 14)).toBe(175);
  });

  it("keeps the last row fully visible without overscrolling", () => {
    expect(scrollTopForFrame(0, 200, 499)).toBe(12_300);
  });
});

describe("nextFrameIndex", () => {
  const frames = Array.from({ length: 50 }, (_, index) => frame(index));
  const selected = frames[10];
  if (selected === undefined) throw new Error("test setup requires a selected Frame");

  it("moves up and down by one visible Frame", () => {
    expect(nextFrameIndex(frames, selected, "ArrowDown", 8)).toBe(11);
    expect(nextFrameIndex(frames, selected, "ArrowUp", 8)).toBe(9);
  });

  it("moves to the first and last visible Frames", () => {
    expect(nextFrameIndex(frames, selected, "Home", 8)).toBe(0);
    expect(nextFrameIndex(frames, selected, "End", 8)).toBe(49);
  });

  it("moves by a viewport page and clamps at both ends", () => {
    expect(nextFrameIndex(frames, selected, "PageDown", 8)).toBe(18);
    expect(nextFrameIndex(frames, selected, "PageUp", 8)).toBe(2);
    expect(nextFrameIndex(frames, frames[48], "PageDown", 8)).toBe(49);
    expect(nextFrameIndex(frames, frames[2], "PageUp", 8)).toBe(0);
  });

  it("uses the endpoint appropriate to the key when selection is not visible", () => {
    const evicted = frame(99);
    expect(nextFrameIndex(frames, evicted, "ArrowDown", 8)).toBe(0);
    expect(nextFrameIndex(frames, evicted, "ArrowUp", 8)).toBe(49);
  });

  it("finds the selected Frame after its position changes", () => {
    const movedSelection = frames[10];
    if (movedSelection === undefined) throw new Error("test setup requires a selected Frame");
    const reordered = [frame(100), ...frames.slice(0, 10), movedSelection, ...frames.slice(11)];
    expect(reordered[11]).toBe(movedSelection);
    expect(nextFrameIndex(reordered, movedSelection, "ArrowDown", 8)).toBe(12);
  });

  it("returns null for an empty visible Frame set", () => {
    expect(nextFrameIndex([], selected, "ArrowDown", 8)).toBeNull();
  });
});
