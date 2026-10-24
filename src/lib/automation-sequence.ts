import type {
  AutomationSequence as PersistedAutomationSequence,
  AutomationStep as PersistedAutomationStep,
  RunSpec,
  Step,
  Target,
} from "../mygo";
import type { ChannelConfig, ChannelKind } from "./channels";

const AUTOMATION_MAX_STEPS = 256;
const AUTOMATION_MAX_PAYLOAD_BYTES = 1 << 20;
const AUTOMATION_MAX_REPEAT = 1_000_000;
const AUTOMATION_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export type AutomationStepKind = "send" | "delay" | "expect";
type AutomationSendCodec = "ascii" | "hex";
export type AutomationLineEnding = "none" | "lf" | "crlf";
export type AutomationMatchMode = "prefix" | "regex" | "pattern";

interface AutomationStepBase {
  /** Stable draft identity for editing; it is never sent to the engine. */
  id: string;
  continueOnError?: boolean;
}

export interface SendStepDraft extends AutomationStepBase {
  kind: "send";
  payload: string;
  codec: AutomationSendCodec;
  lineEnding: AutomationLineEnding;
}

export interface DelayStepDraft extends AutomationStepBase {
  kind: "delay";
  delayMs: number;
}

export interface ExpectStepDraft extends AutomationStepBase {
  kind: "expect";
  mode: AutomationMatchMode;
  pattern: string;
  timeoutMs: number;
  continueOnError: boolean;
}

export type AutomationStepDraft = SendStepDraft | DelayStepDraft | ExpectStepDraft;

export interface AutomationSequenceDraft {
  name: string;
  description: string;
  steps: AutomationStepDraft[];
  repeat: number;
  intervalMs: number;
  continuous: boolean;
}

/** The subset of Channel needed to derive an automation Target. */
export interface AutomationChannelSource {
  name: string;
  backendKey: string;
  kind: ChannelKind;
  config: ChannelConfig;
}

export interface AutomationValidationIssue {
  field: "target" | "name" | "steps" | "step" | "repeat" | "interval" | "continuous";
  message: string;
  stepIndex?: number;
}

export interface AutomationSpecResult {
  spec: RunSpec | null;
  issues: AutomationValidationIssue[];
}

let draftStepSequence = 0;

function nextDraftStepId(): string {
  draftStepSequence += 1;
  return `step-${draftStepSequence}`;
}

export function createSendStep(overrides: Partial<SendStepDraft> = {}): SendStepDraft {
  return {
    id: nextDraftStepId(),
    kind: "send",
    payload: "",
    codec: "ascii",
    lineEnding: "lf",
    ...overrides,
  };
}

export function createDelayStep(overrides: Partial<DelayStepDraft> = {}): DelayStepDraft {
  return {
    id: nextDraftStepId(),
    kind: "delay",
    delayMs: 250,
    ...overrides,
  };
}

export function createExpectStep(overrides: Partial<ExpectStepDraft> = {}): ExpectStepDraft {
  return {
    id: nextDraftStepId(),
    kind: "expect",
    mode: "prefix",
    pattern: "",
    timeoutMs: 1000,
    continueOnError: false,
    ...overrides,
  };
}

export function createSequenceDraft(name = "Sequence 1"): AutomationSequenceDraft {
  return {
    name,
    description: "",
    steps: [createSendStep()],
    repeat: 1,
    intervalMs: 0,
    continuous: false,
  };
}

export function reorderSteps<T>(steps: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) {
    return [...steps];
  }
  const next = [...steps];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}

/** Map a UI Channel's transport identity to the engine's driver-neutral Target. */
export function automationTargetFromChannel(
  channel: AutomationChannelSource | null,
): Target | null {
  if (channel === null) return null;
  switch (channel.kind) {
    case "serial":
      return { channel: channel.backendKey, transport: "serial" };
    case "tcp-client":
      return { channel: channel.backendKey, transport: "tcp-client" };
    case "tcp-accepted":
      return channel.config.transport === "tcp-accepted"
        ? {
            channel: channel.backendKey,
            transport: "tcp-accepted",
            parent: channel.config.parentKey,
          }
        : null;
    case "tcp-server":
      return null;
  }
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateRegex(pattern: string): string | null {
  if (/\(\?[=!<]/.test(pattern)) {
    return "Lookarounds are not supported by the Go matcher.";
  }
  try {
    // Go accepts leading inline flags such as (?i); strip them for a
    // practical JavaScript syntax check before the host performs the final
    // RE2 validation.
    new RegExp(pattern.replace(/\(\?[imsU]+\)/g, ""));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid regular expression.";
  }
}

function validateLuaPattern(pattern: string): string | null {
  let inSet = false;
  let captures = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "%") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) return "Pattern cannot end with an escape.";
      if (escaped === "f") {
        if (pattern[index + 2] !== "[") return "%f must be followed by a character set.";
        index += 1;
        continue;
      }
      if (escaped === "b") {
        if (pattern[index + 2] === undefined || pattern[index + 3] === undefined) {
          return "%b must be followed by two boundary characters.";
        }
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (inSet) {
      if (char === "]") inSet = false;
      continue;
    }
    if (char === "[") {
      inSet = true;
    } else if (char === "(") {
      captures += 1;
      if (captures > 32) return "Lua patterns support at most 32 captures.";
    } else if (char === ")") {
      captures -= 1;
      if (captures < 0) return "Pattern has an unmatched closing capture.";
    }
  }
  if (inSet) return "Pattern has an unterminated character set.";
  if (captures !== 0) return "Pattern has an unmatched capture.";
  return null;
}

function validateMatcher(mode: AutomationMatchMode, pattern: string): string | null {
  if (pattern.length === 0) return "Pattern is required.";
  if (mode === "regex") return validateRegex(pattern);
  if (mode === "pattern") return validateLuaPattern(pattern);
  return null;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function encodeSendPayload(step: SendStepDraft): { payload: string; bytes: number } | string {
  if (step.codec === "hex") {
    const compact = step.payload.replace(/\s+/g, "");
    if (compact.length === 0) return "HEX payload is empty.";
    if (!/^[0-9a-fA-F]+$/.test(compact)) return "HEX accepts only 0-9 A-F and whitespace.";
    if (compact.length % 2 !== 0) return "HEX payload needs complete byte pairs.";
    const bytes = new Uint8Array(compact.length / 2);
    for (let index = 0; index < compact.length; index += 2) {
      bytes[index / 2] = Number.parseInt(compact.slice(index, index + 2), 16);
    }
    if (bytes.length > AUTOMATION_MAX_PAYLOAD_BYTES) {
      return `Payload exceeds ${AUTOMATION_MAX_PAYLOAD_BYTES} bytes.`;
    }
    return { payload: base64FromBytes(bytes), bytes: bytes.length };
  }

  if (step.payload.length === 0) return "ASCII payload is empty.";
  const ending = step.lineEnding === "lf" ? "\n" : step.lineEnding === "crlf" ? "\r\n" : "";
  const bytes = new TextEncoder().encode(step.payload + ending);
  if (bytes.length > AUTOMATION_MAX_PAYLOAD_BYTES) {
    return `Payload exceeds ${AUTOMATION_MAX_PAYLOAD_BYTES} bytes.`;
  }
  return { payload: base64FromBytes(bytes), bytes: bytes.length };
}

/** Validate the complete draft before any bytes can reach a transport. */
export function validateSequenceDraft(
  draft: AutomationSequenceDraft,
  target: Target | null,
): AutomationValidationIssue[] {
  const issues: AutomationValidationIssue[] = [];
  if (target === null) {
    issues.push({
      field: "target",
      message: "Select a connected serial or TCP channel that can transmit.",
    });
  } else if (target.transport === "tcp-accepted" && !target.parent) {
    issues.push({ field: "target", message: "Accepted TCP target is missing its parent server." });
  }

  if (draft.name.trim().length === 0) {
    issues.push({ field: "name", message: "Sequence name is required." });
  }
  if (draft.steps.length === 0) {
    issues.push({ field: "steps", message: "Add at least one step." });
  }
  if (draft.steps.length > AUTOMATION_MAX_STEPS) {
    issues.push({
      field: "steps",
      message: `A Sequence can contain at most ${AUTOMATION_MAX_STEPS} steps.`,
    });
  }

  for (const [index, step] of draft.steps.entries()) {
    if (step.kind === "send") {
      const encoded = encodeSendPayload(step);
      if (typeof encoded === "string") {
        issues.push({ field: "step", stepIndex: index, message: encoded });
      }
    } else if (step.kind === "delay") {
      if (!isIntegerInRange(step.delayMs, 0, AUTOMATION_MAX_WAIT_MS)) {
        issues.push({
          field: "step",
          stepIndex: index,
          message: `Delay must be a whole number from 0 to ${AUTOMATION_MAX_WAIT_MS} ms.`,
        });
      }
    } else {
      const matcherError = validateMatcher(step.mode, step.pattern);
      if (matcherError !== null) {
        issues.push({ field: "step", stepIndex: index, message: matcherError });
      }
      if (!isIntegerInRange(step.timeoutMs, 1, AUTOMATION_MAX_WAIT_MS)) {
        issues.push({
          field: "step",
          stepIndex: index,
          message: `Expect timeout must be a whole number from 1 to ${AUTOMATION_MAX_WAIT_MS} ms.`,
        });
      }
    }
  }

  if (!isIntegerInRange(draft.repeat, 1, AUTOMATION_MAX_REPEAT)) {
    issues.push({
      field: "repeat",
      message: `Repeat must be a whole number from 1 to ${AUTOMATION_MAX_REPEAT}.`,
    });
  }
  if (!isIntegerInRange(draft.intervalMs, 0, AUTOMATION_MAX_WAIT_MS)) {
    issues.push({
      field: "interval",
      message: `Interval must be a whole number from 0 to ${AUTOMATION_MAX_WAIT_MS} ms.`,
    });
  }
  if (draft.continuous && draft.intervalMs <= 0) {
    issues.push({
      field: "continuous",
      message: "Continuous runs require an explicit positive interval.",
    });
  }

  return issues;
}

function toRunStep(step: AutomationStepDraft): Step | null {
  if (step.kind === "send") {
    const encoded = encodeSendPayload(step);
    if (typeof encoded === "string") return null;
    return {
      kind: "send",
      payload: encoded.payload,
      continueOnError: step.continueOnError === true,
    };
  }
  if (step.kind === "delay") {
    return {
      kind: "delay",
      delayMs: step.delayMs,
      continueOnError: step.continueOnError === true,
    };
  }
  return {
    kind: "expect",
    mode: step.mode,
    pattern: step.pattern,
    timeoutMs: step.timeoutMs,
    continueOnError: step.continueOnError,
  };
}

/**
 * Validate and freeze a draft into the generated RunSpec shape. The returned
 * spec is a fresh value; later editor mutations cannot change a running Run.
 */
export function draftToRunSpec(
  draft: AutomationSequenceDraft,
  target: Target | null,
): AutomationSpecResult {
  const issues = validateSequenceDraft(draft, target);
  if (issues.length > 0 || target === null) return { spec: null, issues };

  const steps: Step[] = [];
  for (const step of draft.steps) {
    const converted = toRunStep(step);
    if (converted === null) {
      return {
        spec: null,
        issues: [{ field: "steps", message: "One or more steps could not be converted." }],
      };
    }
    steps.push(converted);
  }

  return {
    spec: {
      name: draft.name.trim(),
      target,
      steps,
      repeat: draft.repeat,
      intervalMs: draft.intervalMs,
      continuous: draft.continuous,
    },
    issues: [],
  };
}

function draftStepFromPersisted(step: PersistedAutomationStep): AutomationStepDraft {
  const base = {
    id: nextDraftStepId(),
    continueOnError: step.continueOnError === true,
  };
  if (step.kind === "delay") {
    return {
      ...base,
      kind: "delay",
      delayMs: Number.isFinite(step.delayMs) ? (step.delayMs ?? 0) : 0,
    };
  }
  if (step.kind === "expect") {
    const mode = step.mode === "regex" || step.mode === "pattern" ? step.mode : ("prefix" as const);
    return {
      ...base,
      kind: "expect",
      mode,
      pattern: step.pattern ?? "",
      timeoutMs: Number.isFinite(step.timeoutMs) ? (step.timeoutMs ?? 1000) : 1000,
      continueOnError: step.continueOnError === true,
    };
  }
  const codec = step.codec === "hex" ? "hex" : "ascii";
  const lineEnding =
    step.lineEnding === "none" || step.lineEnding === "crlf" ? step.lineEnding : "lf";
  return {
    ...base,
    kind: "send",
    payload: step.payload ?? "",
    codec,
    lineEnding,
  };
}

/** Load a persisted Sequence into a fresh editor draft. */
export function draftFromPersistedSequence(
  sequence: PersistedAutomationSequence,
): AutomationSequenceDraft {
  return {
    name: sequence.name,
    description: sequence.description ?? "",
    steps: sequence.steps.map(draftStepFromPersisted),
    repeat: sequence.repeat > 0 ? sequence.repeat : 1,
    intervalMs: sequence.intervalMs ?? 0,
    continuous: sequence.continuous === true,
  };
}

export interface PersistedSequenceResult {
  sequence: PersistedAutomationSequence | null;
  issues: AutomationValidationIssue[];
}

/** Validate and freeze a draft into the persisted editor shape. */
export function draftToPersistedSequence(draft: AutomationSequenceDraft): PersistedSequenceResult {
  const issues = validateSequenceDraft(draft, null).filter((issue) => issue.field !== "target");
  if (issues.length > 0) return { sequence: null, issues };

  const steps: PersistedAutomationStep[] = draft.steps.map((step) => {
    if (step.kind === "send") {
      return {
        kind: "send",
        payload: step.payload,
        codec: step.codec,
        lineEnding: step.lineEnding,
        continueOnError: step.continueOnError === true,
      };
    }
    if (step.kind === "delay") {
      return {
        kind: "delay",
        delayMs: step.delayMs,
        continueOnError: step.continueOnError === true,
      };
    }
    return {
      kind: "expect",
      mode: step.mode,
      pattern: step.pattern,
      timeoutMs: step.timeoutMs,
      continueOnError: step.continueOnError,
    };
  });
  return {
    sequence: {
      name: draft.name.trim(),
      description: draft.description.trim(),
      steps,
      repeat: draft.repeat,
      intervalMs: draft.intervalMs,
      continuous: draft.continuous,
    },
    issues: [],
  };
}
