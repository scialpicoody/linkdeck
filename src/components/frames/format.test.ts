import { describe, expect, it } from "vitest";
import { asciiPreview, frameMatches, hexPreview } from "./format";

describe("asciiPreview", () => {
  it("collapses newlines to dots on one line", () => {
    expect(asciiPreview("AT\r\nOK\r\n")).toBe("AT··OK··");
  });

  it("truncates long payloads with an ellipsis", () => {
    expect(asciiPreview("a".repeat(100), 10)).toBe(`${"a".repeat(10)}…`);
  });
});

describe("hexPreview", () => {
  it("renders hex pairs and truncates by bytes", () => {
    expect(hexPreview("AB")).toBe("41 42");
    expect(hexPreview("a".repeat(40), 4)).toBe("61 61 61 61 …");
  });
});

describe("frameMatches", () => {
  it("matches ASCII case-insensitively", () => {
    expect(frameMatches({ data: "AT+CSQ" }, "csq")).toBe(true);
    expect(frameMatches({ data: "AT+CSQ" }, "zzz")).toBe(false);
  });

  it("matches hex bytes with or without spaces", () => {
    expect(frameMatches({ data: "AB" }, "41 42")).toBe(true);
    expect(frameMatches({ data: "AB" }, "4142")).toBe(true);
  });

  it("empty keyword matches everything", () => {
    expect(frameMatches({ data: "x" }, "  ")).toBe(true);
  });
});
