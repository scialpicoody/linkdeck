import type { Event as AutomationEvent, AutomationRunInfo, StepKind } from "../mygo";

export const AUTOMATION_TIMELINE_LIMIT = 120;
const AUTOMATION_RUN_LIMIT = 100;

const ACTIVE_AUTOMATION_STATES = new Set(["queued", "running", "paused"]);

interface AutomationTimelineEntry {
  id: string;
  event: AutomationEvent;
}

/** Renderer-owned reduction of immutable host events into bounded run state. */
export interface AutomationProjection {
  runs: Record<string, AutomationRunInfo>;
  order: string[];
  eventsByRun: Record<string, AutomationTimelineEntry[]>;
  rxBytesByRun: Record<string, number>;
  nextEventSequence: number;
}

export interface AutomationRunView {
  run: AutomationRunInfo;
  timeline: AutomationTimelineEntry[];
  txCount: number;
  txBytes: number;
  rxCount: number;
  rxBytes: number;
  active: boolean;
  lastAction: StepKind | null;
}

export const EMPTY_AUTOMATION_PROJECTION: AutomationProjection = {
  runs: {},
  order: [],
  eventsByRun: {},
  rxBytesByRun: {},
  nextEventSequence: 1,
};

export function isAutomationRunActive(run: AutomationRunInfo | null | undefined): boolean {
  return run !== undefined && run !== null && ACTIVE_AUTOMATION_STATES.has(run.state);
}

function decodedBase64Length(value: string | undefined): number {
  if (!value) return 0;
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0) return 0;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function insertRun(projection: AutomationProjection, run: AutomationRunInfo): AutomationProjection {
  const runs = { ...projection.runs, [run.id]: run };
  const order = projection.order.includes(run.id)
    ? projection.order
    : [...projection.order, run.id];
  order.sort((leftId, rightId) => {
    const left = runs[leftId];
    const right = runs[rightId];
    if (left === undefined || right === undefined) return 0;
    return left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id);
  });
  const retained = order.slice(-AUTOMATION_RUN_LIMIT);
  if (retained.length === order.length) {
    return { ...projection, runs, order };
  }
  const retainedSet = new Set(retained);
  const eventsByRun = Object.fromEntries(
    Object.entries(projection.eventsByRun).filter(([runId]) => retainedSet.has(runId)),
  );
  const rxBytesByRun = Object.fromEntries(
    Object.entries(projection.rxBytesByRun).filter(([runId]) => retainedSet.has(runId)),
  );
  return {
    runs: Object.fromEntries(Object.entries(runs).filter(([runId]) => retainedSet.has(runId))),
    order: retained,
    eventsByRun,
    rxBytesByRun,
    nextEventSequence: projection.nextEventSequence,
  };
}

/** Merge a List/Status snapshot without discarding already reduced telemetry. */
export function mergeAutomationRuns(
  projection: AutomationProjection,
  snapshots: readonly AutomationRunInfo[],
): AutomationProjection {
  return snapshots.reduce(insertRun, projection);
}

/** Apply one ordered event, keeping per-Run timelines bounded. */
export function applyAutomationEvent(
  projection: AutomationProjection,
  event: AutomationEvent,
): AutomationProjection {
  const runId = event.run.id;
  if (!runId) return projection;

  let next = insertRun(projection, event.run);
  const entry: AutomationTimelineEntry = {
    id: `event-${next.nextEventSequence}`,
    event,
  };
  const timeline = [...(next.eventsByRun[runId] ?? []), entry].slice(-AUTOMATION_TIMELINE_LIMIT);
  const rxBytes =
    event.kind === "io" && event.direction === "rx"
      ? (next.rxBytesByRun[runId] ?? 0) + decodedBase64Length(event.payload)
      : (next.rxBytesByRun[runId] ?? 0);
  next = {
    ...next,
    eventsByRun: { ...next.eventsByRun, [runId]: timeline },
    rxBytesByRun: { ...next.rxBytesByRun, [runId]: rxBytes },
    nextEventSequence: next.nextEventSequence + 1,
  };
  return next;
}

export function automationRunViews(
  projection: AutomationProjection,
  channel?: string,
): AutomationRunView[] {
  return projection.order
    .map((runId) => projection.runs[runId])
    .filter((run): run is AutomationRunInfo => run !== undefined)
    .filter((run) => channel === undefined || run.channel === channel)
    .sort((left, right) => right.createdAtMs - left.createdAtMs || right.id.localeCompare(left.id))
    .map((run) => {
      const timeline = projection.eventsByRun[run.id] ?? [];
      const lastStep = [...timeline]
        .reverse()
        .find((entry) => entry.event.kind === "step" && entry.event.action);
      return {
        run,
        timeline,
        txCount: run.sent,
        txBytes: run.bytesSent,
        rxCount: run.matched,
        rxBytes: projection.rxBytesByRun[run.id] ?? 0,
        active: isAutomationRunActive(run),
        lastAction: lastStep?.event.action ?? null,
      };
    });
}

export function activeAutomationRun(
  projection: AutomationProjection,
  channel?: string,
): AutomationRunView | null {
  return automationRunViews(projection, channel).find((run) => run.active) ?? null;
}
