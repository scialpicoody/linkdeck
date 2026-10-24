import { describe, expect, it } from "vitest";
import type { ScriptOutputRow } from "../components/scripts";
import type { OutputRow } from "../mygo";
import { appendScriptOutput, outputForScript, scriptOutputFromHost } from "./script-output";

function hostRow(overrides: Partial<OutputRow> = {}): OutputRow {
  return {
    runId: "run-1",
    script: "probe.lua",
    type: "log",
    channel: "",
    direction: "local",
    data: "hello",
    line: 0,
    tsMillis: 42,
    ...overrides,
  };
}

function row(id: number): ScriptOutputRow {
  return {
    runId: `run-${id}`,
    script: "probe.lua",
    type: "log",
    channel: "",
    direction: "local",
    data: String(id),
    line: null,
    ts: id,
  };
}

describe("script output", () => {
  it("normalizes valid host rows and drops malformed kinds", () => {
    expect(scriptOutputFromHost(hostRow())).toMatchObject({ type: "log", ts: 42, line: null });
    expect(
      scriptOutputFromHost(hostRow({ type: "error", direction: "in", line: 3.8, tsMillis: 0 })),
    ).toMatchObject({ type: "error", line: 3 });
    expect(scriptOutputFromHost(hostRow({ type: "bogus" }))).toBeNull();
    expect(scriptOutputFromHost(hostRow({ direction: "sideways" }))).toBeNull();
  });

  it("bounds retained output by dropping the oldest rows", () => {
    const out = appendScriptOutput([row(1), row(2)], [row(3), row(4)], 3);
    expect(out.map((item) => item.data)).toEqual(["2", "3", "4"]);
  });

  it("keeps output scoped to the active script", () => {
    const rows = [row(1), { ...row(2), script: "other.lua" }];
    expect(outputForScript(rows, "probe.lua").map((item) => item.data)).toEqual(["1"]);
    expect(outputForScript(rows, "")).toEqual([]);
  });
});
