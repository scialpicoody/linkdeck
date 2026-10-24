import type { Frame } from "../components/frames/types";

let nextFrameId = 0;

/** Mint the stable identity a Frame keeps for its entire capture lifetime. */
export function createFrame(frame: Omit<Frame, "id">): Frame {
  nextFrameId += 1;
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${nextFrameId}`;
  return { id, ...frame };
}
