import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNEL_FORM,
  framingFormFromPreset,
  framingFormFromSpec,
  toFramingSpec,
  validateChannelForm,
} from "./types";

describe("channel framing form", () => {
  it("converts delimiter hex and omits whitespace", () => {
    const spec = toFramingSpec({
      ...DEFAULT_CHANNEL_FORM,
      framing: "delimiter",
      delimiterHex: "0D 0A",
    });
    expect(spec).toEqual({ kind: "delimiter", delimiterHex: "0D0A", maxFrameSize: undefined });
  });

  it("converts header-checksum fields", () => {
    const spec = toFramingSpec({
      ...DEFAULT_CHANNEL_FORM,
      framing: "header-checksum",
      headerHex: "AA 55",
      lengthOffset: 2,
      lengthWidth: 2,
      lengthEndian: "little",
      checksum: "crc8",
      maxFrameSize: 4096,
    });
    expect(spec).toEqual({
      kind: "header-checksum",
      headerHex: "AA55",
      lengthOffset: 2,
      lengthWidth: 2,
      lengthEndian: "little",
      checksum: "crc8",
      maxFrameSize: 4096,
    });
  });

  it("rejects incomplete framing values locally", () => {
    expect(
      validateChannelForm({ ...DEFAULT_CHANNEL_FORM, port: "x", delimiterHex: "0" }),
    ).toContain("Delimiter");
    expect(
      validateChannelForm({
        ...DEFAULT_CHANNEL_FORM,
        port: "x",
        framing: "fixed-size",
        fixedSize: 0,
      }),
    ).toContain("size");
  });

  it("maps legacy delimiter presets to the dialog shape", () => {
    expect(
      framingFormFromPreset({
        Name: "delimiter",
        Opts: { delimiter: "\r\n" },
        Spec: null,
      }),
    ).toMatchObject({ framing: "delimiter", delimiterHex: "0d0a" });
  });

  it("prefers a typed framing spec over legacy preset opts", () => {
    expect(
      framingFormFromPreset({
        Name: "delimiter",
        Opts: { delimiter: "\n" },
        Spec: {
          kind: "fixed-size",
          fixedSize: 128,
          maxFrameSize: 256,
        },
      }),
    ).toMatchObject({ framing: "fixed-size", fixedSize: 128, maxFrameSize: 256 });
    expect(framingFormFromSpec({ kind: "length-prefix", lengthWidth: 4 }).lengthWidth).toBe(4);
  });
});
