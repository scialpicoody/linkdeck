import { frameMatches } from "../components/frames/format";
import type { DirectionFilter, Frame } from "../components/frames/types";

const FOLLOW_CAP = 500;

export interface FrameViewOptions {
  pausedAt: number | null;
  follow: boolean;
  dirFilter: DirectionFilter;
  query: string;
}

/** Apply pause, follow cap, direction, and search in one tested order. */
export function visibleFrameEntries(
  frames: Frame[],
  options: FrameViewOptions,
): { frame: Frame; index: number }[] {
  const paused = options.pausedAt === null ? frames : frames.slice(0, options.pausedAt);
  const tail = options.follow ? paused.slice(-FOLLOW_CAP) : paused;
  const base = options.follow ? paused.length - tail.length : 0;
  return tail
    .map((frame, index) => ({ frame, index: base + index }))
    .filter(
      ({ frame }) =>
        (options.dirFilter === "all" || frame.dir === options.dirFilter) &&
        frameMatches(frame, options.query),
    );
}
