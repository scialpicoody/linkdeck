import { describe, expect, it } from "vitest";
import type { Event as AutomationEvent, AutomationRunInfo, StepKind } from "../mygo";
import {
  AUTOMATION_TIMELINE_LIMIT,
  activeAutomationRun,
  applyAutomationEvent,
  automationRunViews,
  EMPTY_AUTOMATION_PROJECTION,
  mergeAutomationRuns,
} from "./automation-projection";

function run(overrides: Partial<AutomationRunInfo> = {}): AutomationRunInfo {
  return {
    id: "automation-1",
    name: "Probe",
    channel: "bench-1",
    state: "running",
    currentStep: 1,
    createdAtMs: 1000,
    sent: 0,
    bytesSent: 0,
    matched: 0,
    ...overrides,
  };
}

function event(overrides: Partial<AutomationEvent> = {}): AutomationEvent {
  return {
    run: run(),
    kind: "state",
    phase: "running",
    tsMillis: 1100,
    ...overrides,
  };
}

function stepEvent(
  phase: string,
  step: number,
  action: StepKind,
  overrides: Partial<AutomationEvent> = {},
): AutomationEvent {
  return event({
    kind: "step",
    phase,
    step,
    stepId: `automation-1:1:${step}`,
    action,
    ...overrides,
  });
}

describe("automation run projection", () => {
  it("merges ordered snapshots and projects active plus recent runs", () => {
    let projection = mergeAutomationRuns(EMPTY_AUTOMATION_PROJECTION, [
      run({ id: "older", state: "completed", createdAtMs: 100 }),
      run({ id: "active", state: "running", createdAtMs: 200 }),
    ]);
    projection = applyAutomationEvent(
      projection,
      stepEvent("started", 2, "expect", {
        run: run({ id: "active", currentStep: 2, sent: 2, bytesSent: 14, matched: 1 }),
      }),
    );

    const views = automationRunViews(projection, "bench-1");
    expect(views.map((view) => view.run.id)).toEqual(["active", "older"]);
    expect(views[0]).toMatchObject({
      active: true,
      txCount: 2,
      txBytes: 14,
      rxCount: 1,
      lastAction: "expect",
    });
    expect(activeAutomationRun(projection, "bench-1")?.run.id).toBe("active");
  });

  it("updates terminal state from the event snapshot", () => {
    let projection = applyAutomationEvent(
      EMPTY_AUTOMATION_PROJECTION,
      stepEvent("failed", 3, "send"),
    );
    projection = applyAutomationEvent(
      projection,
      event({
        run: run({
          state: "failed",
          error: "port closed",
          currentStep: 3,
          finishedAtMs: 1200,
        }),
        phase: "failed",
        message: "port closed",
        tsMillis: 1200,
      }),
    );

    const view = automationRunViews(projection)[0];
    expect(view?.active).toBe(false);
    expect(view?.run.error).toBe("port closed");
    expect(activeAutomationRun(projection)).toBeNull();
  });

  it("keeps a paused run active so Stop and Resume remain available", () => {
    const projection = applyAutomationEvent(
      EMPTY_AUTOMATION_PROJECTION,
      event({ run: run({ state: "paused" }), phase: "paused" }),
    );
    expect(activeAutomationRun(projection)?.run.state).toBe("paused");
  });

  it("accumulates RX bytes independently of the bounded event timeline", () => {
    let projection = EMPTY_AUTOMATION_PROJECTION;
    for (let index = 0; index < AUTOMATION_TIMELINE_LIMIT + 5; index += 1) {
      projection = applyAutomationEvent(
        projection,
        event({
          kind: "io",
          phase: "matched",
          step: 1,
          stepId: `automation-1:1:${index + 1}`,
          direction: "rx",
          payload: "AQI=",
          tsMillis: 1200 + index,
        }),
      );
    }

    const view = automationRunViews(projection)[0];
    expect(view?.timeline).toHaveLength(AUTOMATION_TIMELINE_LIMIT);
    expect(view?.timeline[0]?.id).not.toBe("event-1");
    expect(view?.rxBytes).toBe((AUTOMATION_TIMELINE_LIMIT + 5) * 2);
  });

  it("filters run history by backend channel identity", () => {
    const projection = mergeAutomationRuns(EMPTY_AUTOMATION_PROJECTION, [
      run({ id: "a", channel: "serial-a" }),
      run({ id: "b", channel: "serial-b" }),
    ]);
    expect(automationRunViews(projection, "serial-a").map((view) => view.run.id)).toEqual(["a"]);
  });
});
