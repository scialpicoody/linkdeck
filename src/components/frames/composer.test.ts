import { describe, expect, it } from "vitest";
import { toWireString } from "./types";

describe("toWireString", () => {
  it("passes ASCII through with LF suffix by default", () => {
    expect(toWireString({ ascii: "ascii", text: "AT", suffix: "lf" })).toEqual({
      wire: "AT\n",
      error: null,
    });
  });

  it("appends CRLF or nothing per suffix", () => {
    expect(toWireString({ ascii: "ascii", text: "AT", suffix: "crlf" }).wire).toBe("AT\r\n");
    expect(toWireString({ ascii: "ascii", text: "AT", suffix: "none" }).wire).toBe("AT");
  });

  it("decodes HEX pairs to raw bytes", () => {
    const { wire, error } = toWireString({ ascii: "hex", text: "41 54 0D 0A", suffix: "lf" });
    expect(error).toBeNull();
    expect([...wire].map((c) => c.charCodeAt(0))).toEqual([0x41, 0x54, 0x0d, 0x0a]);
  });

  it("rejects odd-digit and non-hex input", () => {
    expect(toWireString({ ascii: "hex", text: "4", suffix: "none" }).error).not.toBeNull();
    expect(toWireString({ ascii: "hex", text: "ZZ", suffix: "none" }).error).not.toBeNull();
  });
});
