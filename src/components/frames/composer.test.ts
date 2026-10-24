import { describe, expect, it } from "vitest";
import { base64ToBytes, toWireString } from "./types";

describe("toWireString", () => {
  it("encodes ASCII with LF as base64", () => {
    expect(toWireString({ ascii: "ascii", text: "AT", suffix: "lf" })).toEqual({
      wire: "QVQK",
      bytes: new Uint8Array([0x41, 0x54, 0x0a]),
      error: null,
    });
  });

  it("appends CRLF or nothing per suffix", () => {
    expect(toWireString({ ascii: "ascii", text: "AT", suffix: "crlf" }).wire).toBe("QVQNCg==");
    expect(toWireString({ ascii: "ascii", text: "AT", suffix: "none" }).wire).toBe("QVQ=");
  });

  it("decodes HEX pairs and returns the base64 wire value", () => {
    const { wire, bytes, error } = toWireString({
      ascii: "hex",
      text: "41 54 0D 0A",
      suffix: "lf",
    });
    expect(error).toBeNull();
    expect(wire).toBe("QVQNCg==");
    expect([...bytes]).toEqual([0x41, 0x54, 0x0d, 0x0a]);
  });

  it("rejects odd-digit and non-hex input", () => {
    expect(toWireString({ ascii: "hex", text: "4", suffix: "none" }).error).not.toBeNull();
    expect(toWireString({ ascii: "hex", text: "ZZ", suffix: "none" }).error).not.toBeNull();
  });

  it("decodes the frame-event base64 representation", () => {
    expect([...base64ToBytes("QVQNCg==")]).toEqual([0x41, 0x54, 0x0d, 0x0a]);
  });
});
