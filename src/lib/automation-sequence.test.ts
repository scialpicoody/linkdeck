import { describe, expect, it } from "vitest";
import {
  type AutomationChannelSource,
  type AutomationSequenceDraft,
  automationTargetFromChannel,
  createDelayStep,
  createExpectStep,
  createSendStep,
  createSequenceDraft,
  draftToRunSpec,
  reorderSteps,
  validateSequenceDraft,
} from "./automation-sequence";

const framing = { kind: "none" } as const;

function serialChannel(overrides: Partial<AutomationChannelSource> = {}): AutomationChannelSource {
  return {
    name: "Bench serial",
    backendKey: "/dev/tty.usbserial-1",
    kind: "serial",
    config: {
      transport: "serial",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: "1",
      readTimeoutMs: 0,
      framing,
    },
    ...overrides,
  };
}

function validDraft(): AutomationSequenceDraft {
  return {
    ...createSequenceDraft("Probe"),
    steps: [
      createSendStep({ payload: "AT", lineEnding: "crlf" }),
      createDelayStep({ delayMs: 50 }),
      createExpectStep({ pattern: "OK", timeoutMs: 750 }),
    ],
  };
}

describe("automationTargetFromChannel", () => {
  it("maps serial and TCP client channels to driver-neutral targets", () => {
    expect(automationTargetFromChannel(serialChannel())).toEqual({
      channel: "/dev/tty.usbserial-1",
      transport: "serial",
    });
    expect(
      automationTargetFromChannel({
        name: "Device",
        backendKey: "device-client",
        kind: "tcp-client",
        config: {
          transport: "tcp-client",
          address: "127.0.0.1:9000",
          connectTimeoutMs: 5000,
          reconnectEnabled: true,
          reconnectInitialMs: 100,
          reconnectMaxMs: 5000,
          reconnectMaxAttempts: 0,
          heartbeatMs: 0,
          heartbeatPayload: "",
          framing,
        },
      }),
    ).toEqual({ channel: "device-client", transport: "tcp-client" });
  });

  it("includes the parent server for accepted TCP channels", () => {
    expect(
      automationTargetFromChannel({
        name: "accepted 42",
        backendKey: "peer-42",
        kind: "tcp-accepted",
        config: { transport: "tcp-accepted", parentKey: "bench-server", framing },
      }),
    ).toEqual({ channel: "peer-42", transport: "tcp-accepted", parent: "bench-server" });
  });

  it("refuses listening TCP servers and missing channels", () => {
    expect(
      automationTargetFromChannel({
        name: "Server",
        backendKey: "server",
        kind: "tcp-server",
        config: { transport: "tcp-server", address: ":9000", framing },
      }),
    ).toBeNull();
    expect(automationTargetFromChannel(null)).toBeNull();
  });
});

describe("sequence draft validation", () => {
  it("accepts a complete send/delay/expect program", () => {
    expect(
      validateSequenceDraft(validDraft(), automationTargetFromChannel(serialChannel())),
    ).toEqual([]);
  });

  it("rejects an empty program and a missing send target", () => {
    const issues = validateSequenceDraft({ ...validDraft(), steps: [] }, null);
    expect(issues.map((issue) => issue.field)).toEqual(["target", "steps"]);
  });

  it("rejects unsafe continuous execution without an interval", () => {
    const issues = validateSequenceDraft(
      { ...validDraft(), continuous: true, intervalMs: 0 },
      automationTargetFromChannel(serialChannel()),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        field: "continuous",
        message: expect.stringContaining("interval"),
      }),
    );
  });

  it("rejects incomplete and non-hex send payloads", () => {
    for (const payload of ["", "ABC", "GG"]) {
      const draft = {
        ...validDraft(),
        steps: [createSendStep({ codec: "hex", payload })],
      };
      const issues = validateSequenceDraft(draft, automationTargetFromChannel(serialChannel()));
      expect(issues.some((issue) => issue.message.startsWith("HEX"))).toBe(true);
    }
  });

  it("rejects malformed regex, Lua patterns, and wait bounds", () => {
    const target = automationTargetFromChannel(serialChannel());
    const invalidRegex = validateSequenceDraft(
      {
        ...validDraft(),
        steps: [createExpectStep({ mode: "regex", pattern: "([bad" })],
      },
      target,
    );
    const invalidPattern = validateSequenceDraft(
      {
        ...validDraft(),
        steps: [createExpectStep({ mode: "pattern", pattern: "[abc" })],
      },
      target,
    );
    const invalidWait = validateSequenceDraft(
      {
        ...validDraft(),
        steps: [createExpectStep({ pattern: "OK", timeoutMs: 0 })],
      },
      target,
    );

    expect(invalidRegex).toContainEqual(expect.objectContaining({ stepIndex: 0 }));
    expect(invalidPattern).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("character set") }),
    );
    expect(invalidWait).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("timeout") }),
    );
  });
});

describe("draftToRunSpec", () => {
  it("converts codecs, step options, repeat, and interval to the generated contract", () => {
    const target = automationTargetFromChannel(serialChannel());
    const draft: AutomationSequenceDraft = {
      ...validDraft(),
      steps: [
        createSendStep({
          payload: "PING",
          codec: "ascii",
          lineEnding: "lf",
          continueOnError: true,
        }),
        createSendStep({ payload: "AA 55 0d", codec: "hex", lineEnding: "crlf" }),
        createDelayStep({ delayMs: 125 }),
        createExpectStep({
          mode: "regex",
          pattern: "^OK$",
          timeoutMs: 900,
          continueOnError: true,
        }),
      ],
      repeat: 3,
      intervalMs: 250,
    };

    const result = draftToRunSpec(draft, target);
    expect(result.issues).toEqual([]);
    expect(result.spec).toEqual({
      name: "Probe",
      target,
      repeat: 3,
      intervalMs: 250,
      continuous: false,
      steps: [
        { kind: "send", payload: "UElORwo=", continueOnError: true },
        { kind: "send", payload: "qlUN", continueOnError: false },
        { kind: "delay", delayMs: 125, continueOnError: false },
        {
          kind: "expect",
          mode: "regex",
          pattern: "^OK$",
          timeoutMs: 900,
          continueOnError: true,
        },
      ],
    });
  });

  it("returns no spec when validation fails", () => {
    const result = draftToRunSpec(
      {
        ...validDraft(),
        continuous: true,
        intervalMs: 0,
      },
      automationTargetFromChannel(serialChannel()),
    );
    expect(result.spec).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("freezes converted values against later draft edits", () => {
    const draft = validDraft();
    const result = draftToRunSpec(draft, automationTargetFromChannel(serialChannel()));
    if (result.spec === null) throw new Error("test setup requires a valid RunSpec");

    draft.name = "Changed";
    const send = draft.steps[0];
    if (send?.kind !== "send") throw new Error("test setup requires a send step");
    send.payload = "MUTATED";
    draft.steps.reverse();

    expect(result.spec.name).toBe("Probe");
    expect(result.spec.steps[0]).toEqual({
      kind: "send",
      payload: "QVQNCg==",
      continueOnError: false,
    });
    expect(result.spec.steps).toHaveLength(3);
  });
});

describe("reorderSteps", () => {
  it("moves a step without mutating the source draft", () => {
    const source = ["send", "delay", "expect"];
    expect(reorderSteps(source, 2, 0)).toEqual(["expect", "send", "delay"]);
    expect(source).toEqual(["send", "delay", "expect"]);
  });

  it("returns a copy for invalid move boundaries", () => {
    const source = ["send"];
    const next = reorderSteps(source, -1, 0);
    expect(next).toEqual(source);
    expect(next).not.toBe(source);
  });
});
