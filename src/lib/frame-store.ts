import type { Frame } from "../components/frames/types";

const DEFAULT_MAX_FRAMES_PER_CHANNEL = 5000;
const DEFAULT_MAX_BYTES_PER_CHANNEL = 8 * 1024 * 1024;

export interface FrameBuffer {
  frames: Frame[];
  bytes: number;
}

export interface RetentionLimits {
  maxFrames: number;
  maxBytes: number;
}

const DEFAULT_LIMITS: RetentionLimits = {
  maxFrames: DEFAULT_MAX_FRAMES_PER_CHANNEL,
  maxBytes: DEFAULT_MAX_BYTES_PER_CHANNEL,
};

export const EMPTY_FRAME_BUFFER: FrameBuffer = { frames: [], bytes: 0 };

/**
 * Append frames while enforcing both an item and a byte cap. Frames are
 * dropped oldest-first, matching the monitor's follow-the-tail behavior.
 */
export function appendFrames(
  buffer: FrameBuffer,
  incoming: Frame[],
  limits: RetentionLimits = DEFAULT_LIMITS,
): FrameBuffer {
  if (incoming.length === 0) return buffer;

  const frames = mergeOrdered(buffer.frames, incoming);
  let bytes = buffer.bytes;
  for (const frame of incoming) bytes += frame.payload.length;

  let start = 0;
  while (
    start < frames.length &&
    (frames.length - start > limits.maxFrames || bytes > limits.maxBytes)
  ) {
    bytes -= (frames[start] as Frame).payload.length;
    start++;
  }

  if (start === 0) return { frames, bytes };
  return { frames: frames.slice(start), bytes };
}

function mergeOrdered(existing: Frame[], incoming: Frame[]): Frame[] {
  if (existing.length === 0) return [...incoming];
  if (incoming.length === 0) return [...existing];
  const out: Frame[] = [];
  let left = 0;
  let right = 0;
  while (left < existing.length && right < incoming.length) {
    if ((existing[left] as Frame).ts <= (incoming[right] as Frame).ts) {
      out.push(existing[left] as Frame);
      left++;
    } else {
      out.push(incoming[right] as Frame);
      right++;
    }
  }
  while (left < existing.length) out.push(existing[left++] as Frame);
  while (right < incoming.length) out.push(incoming[right++] as Frame);
  return out;
}
