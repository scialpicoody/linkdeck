import { describe, expect, it } from "vitest";
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  dockBounds,
  dockIsStacked,
  parseStoredDockWidth,
  widthFromKey,
  widthFromPointer,
} from "./dock-layout";

describe("operations dock layout", () => {
  it("clamps pointer and keyboard resizing to useful bounds", () => {
    expect(dockBounds(1600)).toEqual({ min: DOCK_MIN_WIDTH, max: DOCK_MAX_WIDTH });
    expect(widthFromPointer(320, 1000, 900, 1600)).toBe(420);
    expect(widthFromPointer(320, 1000, 100, 1600)).toBe(DOCK_MAX_WIDTH);
    expect(widthFromPointer(320, 1000, 1200, 1600)).toBe(DOCK_MIN_WIDTH);
    expect(widthFromKey(320, "ArrowLeft", 1600)).toBe(336);
    expect(widthFromKey(320, "ArrowRight", 1600)).toBe(304);
    expect(widthFromKey(320, "End", 1600)).toBe(DOCK_MAX_WIDTH);
    expect(widthFromKey(320, "0", 1600)).toBe(DOCK_DEFAULT_WIDTH);
  });

  it("falls back safely for corrupted persistence", () => {
    expect(parseStoredDockWidth("not-a-number", 1600)).toBe(DOCK_DEFAULT_WIDTH);
    expect(parseStoredDockWidth("-20", 1600)).toBe(DOCK_DEFAULT_WIDTH);
    expect(parseStoredDockWidth("9999", 1600)).toBe(DOCK_MAX_WIDTH);
    expect(parseStoredDockWidth("350", 1600)).toBe(350);
  });

  it("uses the documented xl breakpoint for stacked layout", () => {
    expect(dockIsStacked(1279)).toBe(true);
    expect(dockIsStacked(1280)).toBe(false);
  });
});
