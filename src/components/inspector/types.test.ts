import { describe, expect, it } from "vitest";
import { type ChannelConfigValue, configsEqual, DEFAULT_CONFIG } from "./types";

describe("configsEqual", () => {
  it("treats identical configs as equal", () => {
    expect(configsEqual(DEFAULT_CONFIG, { ...DEFAULT_CONFIG })).toBe(true);
  });

  it("flags a change in any single field", () => {
    const cases: Partial<ChannelConfigValue>[] = [
      { port: "/dev/tty.X" },
      { baudRate: 9600 },
      { dataBits: 7 },
      { parity: "even" },
      { stopBits: "2" },
      { framing: "fixed-size" },
      { framingOption: "64" },
      { readTimeoutMs: 100 },
    ];
    for (const patch of cases) {
      expect(configsEqual(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, ...patch })).toBe(false);
    }
  });
});
