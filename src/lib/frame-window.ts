import type { Frame } from "../components/frames/types";

/** Frame rows have a fixed height so virtualization never measures individual rows. */
export const FRAME_ROW_HEIGHT = 25;
export const FRAME_WINDOW_OVERSCAN = 4;

export interface FrameWindow {
  startIndex: number;
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
  totalHeight: number;
}

export interface FrameWindowOptions {
  rowHeight?: number;
  overscan?: number;
}

const NAVIGATION_KEYS = new Set<FrameNavigationKey>([
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export type FrameNavigationKey = "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";

/** Return the bounded Frame slice needed to cover the viewport and overscan. */
export function frameWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  options: FrameWindowOptions = {},
): FrameWindow {
  const count = Math.max(0, Math.floor(itemCount));
  const rowHeight = positive(options.rowHeight, FRAME_ROW_HEIGHT);
  const overscan = Math.max(0, Math.floor(options.overscan ?? FRAME_WINDOW_OVERSCAN));

  if (count === 0) {
    return { startIndex: 0, endIndex: 0, topSpacer: 0, bottomSpacer: 0, totalHeight: 0 };
  }

  const totalHeight = count * rowHeight;
  const height = Math.max(0, viewportHeight);
  const top = clamp(scrollTop, 0, Math.max(0, totalHeight - height));
  const firstVisible = Math.min(count - 1, Math.floor(top / rowHeight));
  const visibleRows = Math.max(1, Math.ceil(height / rowHeight));
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(count, firstVisible + visibleRows + overscan);

  return {
    startIndex,
    endIndex,
    topSpacer: startIndex * rowHeight,
    bottomSpacer: (count - endIndex) * rowHeight,
    totalHeight,
  };
}

/** Number of complete rows in one viewport page, with a safe one-row floor. */
export function framePageSize(viewportHeight: number, rowHeight = FRAME_ROW_HEIGHT): number {
  return Math.max(
    1,
    Math.floor(Math.max(0, viewportHeight) / positive(rowHeight, FRAME_ROW_HEIGHT)),
  );
}

/** Minimal scroll adjustment needed to reveal one Frame row in the viewport. */
export function scrollTopForFrame(
  scrollTop: number,
  viewportHeight: number,
  index: number,
  rowHeight = FRAME_ROW_HEIGHT,
): number {
  const height = positive(rowHeight, FRAME_ROW_HEIGHT);
  const top = Math.max(0, Math.floor(index)) * height;
  const bottom = top + height;
  const current = Math.max(0, scrollTop);
  const viewport = Math.max(0, viewportHeight);

  if (top < current) return top;
  if (bottom > current + viewport) return bottom - viewport;
  return current;
}

export function isFrameNavigationKey(value: string): value is FrameNavigationKey {
  return NAVIGATION_KEYS.has(value as FrameNavigationKey);
}

/**
 * Resolve keyboard navigation against the current visible Frame set. Selection
 * follows stable Frame ids rather than array positions.
 */
export function nextFrameIndex(
  frames: readonly Pick<Frame, "id">[],
  selectedFrame: Frame | null | undefined,
  key: FrameNavigationKey,
  pageSize: number,
): number | null {
  const count = frames.length;
  if (count === 0) return null;

  const last = count - 1;
  const current = selectedFrame ? frames.findIndex((frame) => frame.id === selectedFrame.id) : -1;

  if (key === "Home") return 0;
  if (key === "End") return last;

  const page = Math.max(1, Math.floor(pageSize));
  if (current < 0) return key === "ArrowUp" || key === "PageUp" ? last : 0;

  if (key === "ArrowDown") return Math.min(last, current + 1);
  if (key === "ArrowUp") return Math.max(0, current - 1);
  if (key === "PageDown") return Math.min(last, current + page);
  return Math.max(0, current - page);
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
