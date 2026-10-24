import { describe, expect, it } from "vitest";
import { type ChannelState, stateColor } from "./channels";

const STATES: ChannelState[] = ["connected", "connecting", "disconnected", "error"];

describe("stateColor", () => {
  it("returns a hex fill for every channel state", () => {
    for (const state of STATES) {
      expect(stateColor(state)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps every state visually distinct", () => {
    const fills = new Set(STATES.map(stateColor));
    expect(fills.size).toBe(STATES.length);
  });

  it("is deterministic per state", () => {
    expect(stateColor("connected")).toBe(stateColor("connected"));
  });
});
