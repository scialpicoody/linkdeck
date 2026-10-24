import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Frame } from "../components/frames/types";
import { events, type FrameDTO, type FramingError, StreamAPI } from "../mygo";
import {
  applyDropped,
  applyFramingError,
  type CaptureSession,
  type CaptureSessions,
  captureFor,
  clearCaptureFrames,
  ingestCaptureBatch,
  markCaptureRead,
  recordSendFailure,
  recordSentFrame,
  removeCaptureSessions,
  resetCaptureCounters,
} from "./capture-session";
import type { Channel } from "./channels";
import { decodeFrameBatch } from "./frame-ingest";
import { isHostAvailable } from "./host";

export interface UseCaptureSessions {
  captures: CaptureSessions;
  activeCapture: CaptureSession | null;
  markRead: (channelId: string) => void;
  clearFrames: (channelId: string) => void;
  resetCounters: (channelId: string) => void;
  remove: (channelIds: string[]) => void;
  recordSent: (channelId: string, frame: Frame) => void;
  recordFailedSend: (channelId: string, frame: Frame) => void;
}

/** Own host RX ingestion and the in-session capture state for each Channel. */
export function useCaptureSessions(
  channels: Channel[],
  activeId: string | null,
): UseCaptureSessions {
  const [captures, setCaptures] = useState<CaptureSessions>({});
  const channelsRef = useRef(channels);
  const activeIdRef = useRef(activeId);
  channelsRef.current = channels;
  activeIdRef.current = activeId;

  useEffect(() => {
    if (!isHostAvailable()) return;
    return events.frames.on((batch: FrameDTO[]) => {
      const { byChannel, malformed } = decodeFrameBatch(batch, channelsRef.current);
      if (malformed > 0) {
        toast.error("Dropped malformed frame event", {
          description: `${malformed} payload${malformed === 1 ? "" : "s"} were not valid base64.`,
        });
      }
      if (byChannel.size === 0) return;
      setCaptures((previous) => ingestCaptureBatch(previous, byChannel, activeIdRef.current));
      for (const [channelId, entry] of byChannel) {
        void StreamAPI.dropped(entry.endpoint)
          .then((dropped) => {
            setCaptures((previous) => applyDropped(previous, channelId, dropped));
          })
          .catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    if (!isHostAvailable()) return;
    return events.streamErrors.on((error: FramingError) => {
      const channel = channelsRef.current.find((item) => item.backendKey === error.channel);
      if (channel === undefined) return;
      setCaptures((previous) => applyFramingError(previous, channel.id, error));
    });
  }, []);

  const markRead = useCallback((channelId: string) => {
    setCaptures((previous) => markCaptureRead(previous, channelId));
  }, []);
  const clearFrames = useCallback((channelId: string) => {
    setCaptures((previous) => clearCaptureFrames(previous, channelId));
  }, []);
  const resetCounters = useCallback((channelId: string) => {
    setCaptures((previous) => resetCaptureCounters(previous, channelId));
  }, []);
  const remove = useCallback((channelIds: string[]) => {
    setCaptures((previous) => removeCaptureSessions(previous, channelIds));
  }, []);
  const recordSent = useCallback((channelId: string, frame: Frame) => {
    setCaptures((previous) => recordSentFrame(previous, channelId, frame));
  }, []);
  const recordFailedSend = useCallback((channelId: string, frame: Frame) => {
    setCaptures((previous) => recordSendFailure(previous, channelId, frame));
  }, []);

  return {
    captures,
    activeCapture: captureFor(captures, activeId),
    markRead,
    clearFrames,
    resetCounters,
    remove,
    recordSent,
    recordFailedSend,
  };
}
