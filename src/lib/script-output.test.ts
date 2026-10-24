import { describe, expect, it } from "vitest";
import type { ScriptOutputRow } from "../components/scripts";
import type { OutputRow } from "../mygo";
import {
  appendScriptOutput,
  filterScriptOutput,
  formatScriptOutputForCopy,
  outputForScript,
  scriptOutputFromHost,
  scriptOutputRunIds,
} from "./script-output";

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
    id: `row-${id}`,
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

  it("assigns stable local ids during normalization and preserves them through retention", () => {
    const first = scriptOutputFromHost(hostRow({ data: "first" }));
    const second = scriptOutputFromHost(hostRow({ data: "second" }));
    if (first === null || second === null) throw new Error("expected valid rows");

    expect(first.id).toEqual(expect.any(String));
    expect(first.id).not.toBe(second.id);

    const retained = appendScriptOutput([first], [second], 2);
    expect(retained.map((item) => item.id)).toEqual([first.id, second.id]);
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

  it("composes type and run filters, including system rows", () => {
    const rows = [
      row(1),
      { ...row(2), type: "tx" as const, runId: "run-1" },
      { ...row(3), type: "tx" as const, runId: "run-2" },
      { ...row(4), type: "system" as const, runId: "" },
    ];

    expect(
      filterScriptOutput(rows, { type: "tx", runId: "run-1" }).map((item) => item.data),
    ).toEqual(["2"]);
    expect(filterScriptOutput(rows, { type: "all", runId: "" }).map((item) => item.data)).toEqual([
      "4",
    ]);
    expect(scriptOutputRunIds(rows)).toEqual(["run-1", "run-2", ""]);
  });

  it("formats filtered rows as clipboard-ready text with complete metadata", () => {
    const text = formatScriptOutputForCopy([
      {
        ...row(1),
        type: "error",
        channel: "serial:ttyUSB0",
        direction: "in",
        data: "probe failed",
        ts: 42,
      },
    ]);

    expect(text).toBe(
      [
        "Time\tType\tRun\tScript\tChannel\tDirection\tData",
        "1970-01-01T00:00:00.042Z\terror\trun-1\tprobe.lua\tserial:ttyUSB0\tin\tprobe failed",
      ].join("\n"),
    );
  });
});
