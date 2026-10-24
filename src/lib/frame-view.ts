import { frameMatches } from "../components/frames/format";
import type { DirectionFilter, Frame } from "../components/frames/types";

const FOLLOW_CAP = 500;

export interface FrameViewOptions {
  /** Fixed Frame set captured at pause; null follows the live retained Frames. */
  snapshot: Frame[] | null;
  follow: boolean;
  dirFilter: DirectionFilter;
  query: string;
}

/** Apply snapshot, follow cap, direction, and search in one tested order. */
export function visibleFrames(frames: Frame[], options: FrameViewOptions): Frame[] {
  const source = options.snapshot ?? frames;
  const tail = options.follow ? source.slice(-FOLLOW_CAP) : source;
  return tail.filter(
    (frame) =>
      (options.dirFilter === "all" || frame.dir === options.dirFilter) &&
      frameMatches(frame, options.query),
  );
}
