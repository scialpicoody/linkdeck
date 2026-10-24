import { describe, expect, it } from "vitest";
import { createFrame } from "./frame-identity";
import { appendFrames } from "./frame-store";

describe("Frame identity", () => {
  it("does not drift when a late TX merge changes the Frame's position", () => {
    const selected = createFrame({ dir: "out", payload: new Uint8Array([2]), ts: 20 });
    const before = appendFrames(
      { frames: [createFrame({ dir: "in", payload: new Uint8Array([1]), ts: 10 })], bytes: 1 },
      [selected],
      { maxFrames: 10, maxBytes: 100 },
    );
    const beforeIndex = before.frames.indexOf(selected);

    const after = appendFrames(
      before,
      [createFrame({ dir: "in", payload: new Uint8Array([3]), ts: 15 })],
      { maxFrames: 10, maxBytes: 100 },
    );

    expect(after.frames.indexOf(selected)).not.toBe(beforeIndex);
    expect(after.frames.find((frame) => frame.id === selected.id)).toBe(selected);
  });

  it("keeps the selected Frame inspectable after retention evicts it", () => {
    const frames = Array.from({ length: 3 }, (_, index) =>
      createFrame({ dir: "in", payload: new Uint8Array([index]), ts: index }),
    );
    const selected = frames[1];
    expect(selected).toBeDefined();
    if (selected === undefined) return;

    const after = appendFrames(
      { frames, bytes: 3 },
      [createFrame({ dir: "in", payload: new Uint8Array([4]), ts: 4 })],
      { maxFrames: 2, maxBytes: 100 },
    );
    const firstVisible = after.frames[0];

    expect(after.frames).not.toContain(selected);
    expect(firstVisible).not.toBe(selected);
    expect(selected.id).toBe(frames[1]?.id);
    expect(selected.payload).toEqual(new Uint8Array([1]));
  });

  it("mints distinct identities for identical payloads and timestamps", () => {
    const input = { dir: "in" as const, payload: new Uint8Array([1]), ts: 10 };
    expect(createFrame(input).id).not.toBe(createFrame(input).id);
  });
});
