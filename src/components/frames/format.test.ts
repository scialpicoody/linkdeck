import { describe, expect, it } from "vitest";
import {
  asciiPreview,
  formatBytes,
  formatTs,
  frameBytes,
  frameMatches,
  hexPreview,
  toHex,
} from "./format";

describe("toHex", () => {
  it("renders ASCII as lowercase hex pairs", () => {
    expect(toHex(new Uint8Array([0x41, 0x42]))).toBe("41 42");
  });

  it("renders empty payload as empty string", () => {
    expect(toHex(new Uint8Array())).toBe("");
  });

  it("encodes multibyte characters as UTF-8 bytes", () => {
    expect(toHex(new TextEncoder().encode("é"))).toBe("c3 a9");
  });
});

describe("frameBytes", () => {
  it("counts ASCII bytes one-to-one", () => {
    expect(frameBytes(new TextEncoder().encode("hello"))).toBe(5);
  });

  it("counts multibyte characters as UTF-8 length", () => {
    expect(frameBytes(new TextEncoder().encode("é"))).toBe(2);
    expect(frameBytes(new Uint8Array())).toBe(0);
  });
});

describe("formatBytes", () => {
  it("renders byte, KB, and MB bands", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
  });
});

describe("formatTs", () => {
  it("renders HH:MM:SS.mmm shape", () => {
    expect(formatTs(0)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe("asciiPreview", () => {
  it("collapses newlines to dots on one line", () => {
    expect(asciiPreview(new TextEncoder().encode("AT\r\nOK\r\n"))).toBe("AT..OK..");
  });

  it("truncates long payloads with an ellipsis", () => {
    expect(asciiPreview(new TextEncoder().encode("a".repeat(100)), 10)).toBe(
      `${"a".repeat(10)}...`,
    );
  });
});

describe("hexPreview", () => {
  it("renders hex pairs and truncates by bytes", () => {
    expect(hexPreview(new TextEncoder().encode("AB"))).toBe("41 42");
    expect(hexPreview(new TextEncoder().encode("a".repeat(40)), 4)).toBe("61 61 61 61 ...");
  });
});

describe("frameMatches", () => {
  it("matches ASCII case-insensitively", () => {
    const payload = new TextEncoder().encode("AT+CSQ");
    expect(frameMatches({ payload }, "csq")).toBe(true);
    expect(frameMatches({ payload }, "zzz")).toBe(false);
  });

  it("matches hex bytes with or without spaces", () => {
    const payload = new TextEncoder().encode("AB");
    expect(frameMatches({ payload }, "41 42")).toBe(true);
    expect(frameMatches({ payload }, "4142")).toBe(true);
  });

  it("empty keyword matches everything", () => {
    expect(frameMatches({ payload: new Uint8Array([0x78]) }, "  ")).toBe(true);
  });
});
