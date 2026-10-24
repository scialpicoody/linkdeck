import type { Frame } from "../components/frames/types";
import type { FramingError } from "../mygo";
import {
  type ChannelStats,
  EMPTY_CHANNEL_STATS,
  recordFrames,
  recordSendError,
} from "./frame-stats";
import { appendFrames, EMPTY_FRAME_BUFFER, type FrameBuffer } from "./frame-store";

/** Session-owned capture state for one Channel. */
export interface CaptureSession {
  frames: FrameBuffer;
  stats: ChannelStats;
  dropped: number;
  framingError?: FramingError;
  unread: number;
  rxBytes: number;
  txBytes: number;
}

export type CaptureSessions = Record<string, CaptureSession>;

export interface CaptureBatch {
  endpoint: string;
  frames: Frame[];
}

export const EMPTY_CAPTURE_SESSION: CaptureSession = {
  frames: EMPTY_FRAME_BUFFER,
  stats: EMPTY_CHANNEL_STATS,
  dropped: 0,
  unread: 0,
  rxBytes: 0,
  txBytes: 0,
};

export function captureFor(
  sessions: CaptureSessions,
  channelId: string | null,
): CaptureSession | null {
  return channelId === null ? null : (sessions[channelId] ?? null);
}

function sessionFor(sessions: CaptureSessions, channelId: string): CaptureSession {
  return sessions[channelId] ?? EMPTY_CAPTURE_SESSION;
}

function withSession(
  sessions: CaptureSessions,
  channelId: string,
  session: CaptureSession,
): CaptureSessions {
  return { ...sessions, [channelId]: session };
}

function directionBytes(frames: Frame[], direction: Frame["dir"]): number {
  let bytes = 0;
  for (const frame of frames) {
    if (frame.dir === direction) bytes += frame.payload.length;
  }
  return bytes;
}

/** Apply one decoded host batch as one state transition per Channel. */
export function ingestCaptureBatch(
  sessions: CaptureSessions,
  byChannel: Map<string, CaptureBatch>,
  activeId: string | null,
): CaptureSessions {
  if (byChannel.size === 0) return sessions;
  let next = sessions;
  for (const [channelId, entry] of byChannel) {
    if (entry.frames.length === 0) continue;
    const current = sessionFor(next, channelId);
    const inboundFrames = entry.frames.filter((frame) => frame.dir === "in").length;
    next = withSession(next, channelId, {
      ...current,
      frames: appendFrames(current.frames, entry.frames),
      stats: recordFrames(current.stats, entry.frames),
      unread: current.unread + (channelId === activeId ? 0 : inboundFrames),
      rxBytes: current.rxBytes + directionBytes(entry.frames, "in"),
      txBytes: current.txBytes + directionBytes(entry.frames, "out"),
    });
  }
  return next;
}

export function applyFramingError(
  sessions: CaptureSessions,
  channelId: string,
  framingError: FramingError,
): CaptureSessions {
  return withSession(sessions, channelId, {
    ...sessionFor(sessions, channelId),
    framingError,
  });
}

export function applyDropped(
  sessions: CaptureSessions,
  channelId: string,
  dropped: number,
): CaptureSessions {
  const current = sessions[channelId];
  if (current === undefined || current.dropped === dropped) return sessions;
  return withSession(sessions, channelId, { ...current, dropped });
}

export function recordSentFrame(
  sessions: CaptureSessions,
  channelId: string,
  frame: Frame,
): CaptureSessions {
  const current = sessionFor(sessions, channelId);
  return withSession(sessions, channelId, {
    ...current,
    frames: appendFrames(current.frames, [frame]),
    stats: recordFrames(current.stats, [frame]),
    txBytes: current.txBytes + frame.payload.length,
  });
}

export function recordSendFailure(
  sessions: CaptureSessions,
  channelId: string,
  frame: Frame,
): CaptureSessions {
  const current = sessionFor(sessions, channelId);
  return withSession(sessions, channelId, {
    ...current,
    frames: appendFrames(current.frames, [frame]),
    stats: recordSendError(current.stats),
  });
}

export function markCaptureRead(sessions: CaptureSessions, channelId: string): CaptureSessions {
  const current = sessions[channelId];
  if (current === undefined || current.unread === 0) return sessions;
  return withSession(sessions, channelId, { ...current, unread: 0 });
}

export function clearCaptureFrames(sessions: CaptureSessions, channelId: string): CaptureSessions {
  const current = sessions[channelId];
  if (current === undefined || current.frames.frames.length === 0) return sessions;
  return withSession(sessions, channelId, { ...current, frames: EMPTY_FRAME_BUFFER });
}

export function resetCaptureCounters(
  sessions: CaptureSessions,
  channelId: string,
): CaptureSessions {
  const current = sessions[channelId];
  if (current === undefined) return sessions;
  return withSession(sessions, channelId, {
    ...current,
    stats: EMPTY_CHANNEL_STATS,
    rxBytes: 0,
    txBytes: 0,
  });
}

export function removeCaptureSessions(
  sessions: CaptureSessions,
  channelIds: string[],
): CaptureSessions {
  if (channelIds.length === 0) return sessions;
  const next = { ...sessions };
  for (const channelId of channelIds) delete next[channelId];
  return next;
}
