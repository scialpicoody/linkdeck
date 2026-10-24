import { base64ToBytes, type Frame } from "../components/frames";
import type { FrameDTO } from "../mygo";
import type { Channel } from "./channels";
import { createFrame } from "./frame-identity";

export interface IngestedFrames {
  byChannel: Map<string, { endpoint: string; frames: Frame[] }>;
  malformed: number;
}

/**
 * Decode one host batch once, dropping malformed payloads and events for
 * channels that are no longer part of the shared Channel model.
 */
export function decodeFrameBatch(batch: FrameDTO[], channels: Channel[]): IngestedFrames {
  const byBackendKey = new Map(channels.map((channel) => [channel.backendKey, channel]));
  const byChannel = new Map<string, { endpoint: string; frames: Frame[] }>();
  let malformed = 0;
  for (const dto of batch) {
    if (dto.dir !== "rx" && dto.dir !== "tx") continue;
    const channel = byBackendKey.get(dto.channel);
    if (channel === undefined) continue;
    try {
      const frame: Frame = createFrame({
        dir: dto.dir === "rx" ? "in" : "out",
        payload: base64ToBytes(dto.payload),
        ts: dto.tsMillis,
      });
      const entry = byChannel.get(channel.id) ?? { endpoint: channel.backendKey, frames: [] };
      entry.frames.push(frame);
      byChannel.set(channel.id, entry);
    } catch {
      malformed++;
    }
  }
  return { byChannel, malformed };
}
