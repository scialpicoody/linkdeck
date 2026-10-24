import { useCallback, useEffect, useRef, useState } from "react";
import {
  AutomationAPI,
  type Event as AutomationEvent,
  type AutomationRunInfo,
  events,
  type RunSpec,
} from "../mygo";
import {
  type AutomationProjection,
  applyAutomationEvent,
  EMPTY_AUTOMATION_PROJECTION,
  mergeAutomationRuns,
} from "./automation-projection";
import { isHostAvailable } from "./host";

export interface AutomationIoCapture {
  runId: string;
  channel: string;
  direction: "tx" | "rx";
  /** Engine event phase: `sent` for TX or `matched` for RX. */
  phase: string;
  stepId?: string;
  payload: Uint8Array;
  tsMillis: number;
  latencyMs?: number;
}

export interface UseAutomationControllerOptions {
  /** Receives successful TX and matched RX events for local Frame capture. */
  onIoCapture: (io: AutomationIoCapture) => void;
}

export interface AutomationController {
  available: boolean;
  projection: AutomationProjection;
  selectedRunId: string | null;
  loading: boolean;
  starting: boolean;
  cancelling: boolean;
  pausing: boolean;
  resuming: boolean;
  error: string | null;
  start: (spec: RunSpec) => Promise<AutomationRunInfo>;
  cancel: (runId: string) => Promise<AutomationRunInfo>;
  pause: (runId: string) => Promise<AutomationRunInfo>;
  resume: (runId: string) => Promise<AutomationRunInfo>;
  refresh: () => Promise<void>;
  selectRun: (runId: string | null) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(value: string | undefined): Uint8Array {
  if (!value) return new Uint8Array();
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

/**
 * Owns AutomationAPI calls and event reduction for a mounted renderer.
 * Timing remains in Go; this hook only mirrors immutable snapshots.
 */
export function useAutomationController({
  onIoCapture,
}: UseAutomationControllerOptions): AutomationController {
  const available = isHostAvailable();
  const [projection, setProjection] = useState<AutomationProjection>(EMPTY_AUTOMATION_PROJECTION);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(available);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ioCaptureRef = useRef(onIoCapture);
  ioCaptureRef.current = onIoCapture;

  const refresh = useCallback(async () => {
    if (!available) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const snapshots = await AutomationAPI.list();
      setProjection((current) => mergeAutomationRuns(current, snapshots));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [available]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!available) return;
    return events.automationEvent.on((event: AutomationEvent) => {
      setProjection((current) => applyAutomationEvent(current, event));
      if (event.run.id) {
        setSelectedRunId((current) => {
          if (current === null || event.run.state === "queued" || event.run.state === "running") {
            return event.run.id;
          }
          return current;
        });
      }
      if (event.kind === "io" && (event.direction === "tx" || event.direction === "rx")) {
        ioCaptureRef.current({
          runId: event.run.id,
          channel: event.run.channel,
          direction: event.direction,
          phase: event.phase ?? (event.direction === "tx" ? "sent" : "matched"),
          stepId: event.stepId,
          payload: decodeBase64(event.payload),
          tsMillis: event.tsMillis,
          latencyMs: event.latencyMs,
        });
      }
    });
  }, [available]);

  const start = useCallback(async (spec: RunSpec): Promise<AutomationRunInfo> => {
    if (!isHostAvailable()) {
      const message = "No Go host: automation is unavailable in browser mode.";
      setError(message);
      throw new Error(message);
    }
    setStarting(true);
    setError(null);
    try {
      const info = await AutomationAPI.start(spec);
      setProjection((current) => mergeAutomationRuns(current, [info]));
      setSelectedRunId(info.id);
      return info;
    } catch (caught) {
      setError(messageOf(caught));
      throw caught;
    } finally {
      setStarting(false);
    }
  }, []);

  const cancel = useCallback(async (runId: string): Promise<AutomationRunInfo> => {
    if (!isHostAvailable()) {
      const message = "No Go host: automation is unavailable in browser mode.";
      setError(message);
      throw new Error(message);
    }
    setCancelling(true);
    setError(null);
    try {
      const info = await AutomationAPI.cancel(runId);
      setProjection((current) => mergeAutomationRuns(current, [info]));
      return info;
    } catch (caught) {
      setError(messageOf(caught));
      throw caught;
    } finally {
      setCancelling(false);
    }
  }, []);

  const pause = useCallback(async (runId: string): Promise<AutomationRunInfo> => {
    if (!isHostAvailable()) {
      const message = "No Go host: automation is unavailable in browser mode.";
      setError(message);
      throw new Error(message);
    }
    setPausing(true);
    setError(null);
    try {
      const info = await AutomationAPI.pause(runId);
      setProjection((current) => mergeAutomationRuns(current, [info]));
      return info;
    } catch (caught) {
      setError(messageOf(caught));
      throw caught;
    } finally {
      setPausing(false);
    }
  }, []);

  const resume = useCallback(async (runId: string): Promise<AutomationRunInfo> => {
    if (!isHostAvailable()) {
      const message = "No Go host: automation is unavailable in browser mode.";
      setError(message);
      throw new Error(message);
    }
    setResuming(true);
    setError(null);
    try {
      const info = await AutomationAPI.resume(runId);
      setProjection((current) => mergeAutomationRuns(current, [info]));
      return info;
    } catch (caught) {
      setError(messageOf(caught));
      throw caught;
    } finally {
      setResuming(false);
    }
  }, []);

  const selectRun = useCallback((runId: string | null) => {
    setSelectedRunId(runId);
  }, []);

  return {
    available,
    projection,
    selectedRunId,
    loading,
    starting,
    cancelling,
    pausing,
    resuming,
    error,
    start,
    cancel,
    pause,
    resume,
    refresh,
    selectRun,
  };
}
