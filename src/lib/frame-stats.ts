import type { Frame } from "../components/frames/types";

/** One second of session traffic; the array is bounded to 60 buckets. */
interface ThroughputBucket {
  sec: number;
  rxBytes: number;
  txBytes: number;
}

/** Session-only totals and a rolling 60-second throughput window. */
export interface ChannelStats {
  frames: number;
  bytes: number;
  rxBytes: number;
  txBytes: number;
  sendErrors: number;
  buckets: ThroughputBucket[];
}

export const EMPTY_CHANNEL_STATS: ChannelStats = {
  frames: 0,
  bytes: 0,
  rxBytes: 0,
  txBytes: 0,
  sendErrors: 0,
  buckets: [],
};

const WINDOW_SECONDS = 60;

function addToBuckets(
  buckets: ThroughputBucket[],
  sec: number,
  dir: "in" | "out",
  bytes: number,
): ThroughputBucket[] {
  const cutoff = sec - (WINDOW_SECONDS - 1);
  const next = buckets.filter((bucket) => bucket.sec >= cutoff).map((bucket) => ({ ...bucket }));
  let bucket = next.find((item) => item.sec === sec);
  if (bucket === undefined) {
    bucket = { sec, rxBytes: 0, txBytes: 0 };
    next.push(bucket);
    next.sort((a, b) => a.sec - b.sec);
  }
  if (dir === "in") bucket.rxBytes += bytes;
  else bucket.txBytes += bytes;
  return next;
}

export function recordFrames(stats: ChannelStats, frames: Frame[]): ChannelStats {
  if (frames.length === 0) return stats;
  let framesCount = stats.frames;
  let bytes = stats.bytes;
  let rxBytes = stats.rxBytes;
  let txBytes = stats.txBytes;
  let buckets = stats.buckets;
  for (const frame of frames) {
    const size = frame.payload.length;
    framesCount++;
    bytes += size;
    if (frame.dir === "in") rxBytes += size;
    else txBytes += size;
    const sec = Math.floor(frame.ts / 1000);
    buckets = addToBuckets(buckets, sec, frame.dir, size);
  }
  return { ...stats, frames: framesCount, bytes, rxBytes, txBytes, buckets };
}

export function recordSendError(stats: ChannelStats): ChannelStats {
  return { ...stats, sendErrors: stats.sendErrors + 1 };
}

/** Fill the rolling window so charts keep a stable 60-second x-axis. */
export function throughputSeries(
  stats: ChannelStats,
  nowMs = Date.now(),
  seconds = WINDOW_SECONDS,
): { rx: number[]; tx: number[] } {
  const current = Math.floor(nowMs / 1000);
  const first = current - (seconds - 1);
  const bySec = new Map(stats.buckets.map((bucket) => [bucket.sec, bucket]));
  const rx: number[] = [];
  const tx: number[] = [];
  for (let sec = first; sec <= current; sec++) {
    const bucket = bySec.get(sec);
    rx.push(bucket?.rxBytes ?? 0);
    tx.push(bucket?.txBytes ?? 0);
  }
  return { rx, tx };
}

export function sessionErrors(stats: ChannelStats, framingErrors: number, dropped: number): number {
  return stats.sendErrors + Math.max(0, framingErrors) + Math.max(0, dropped);
}
