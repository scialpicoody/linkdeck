import { LoaderCircle, Play, Square, Unplug, X } from "lucide-react";
import { cn } from "../../lib/utils";
import type { RunInfo, SessionInfo } from "../../mygo";

export interface ScriptRunControlsProps {
  activeRun: RunInfo | null;
  session: SessionInfo | null;
  timeoutMs: number;
  functionName: string;
  busy: boolean;
  onTimeoutChange: (value: number) => void;
  onFunctionNameChange: (value: string) => void;
  onRunSource: () => void;
  onRunFile: () => void;
  onCancel: () => void;
  onLoadSession: () => void;
  onCallSession: () => void;
  onCloseSession: () => void;
}

const RUN_STYLE: Record<string, string> = {
  queued: "text-muted-foreground",
  running: "text-primary",
  completed: "text-rx",
  failed: "text-danger",
  "timed-out": "text-warning",
  cancelled: "text-muted-foreground",
};

export default function ScriptRunControls({
  activeRun,
  session,
  timeoutMs,
  functionName,
  busy,
  onTimeoutChange,
  onFunctionNameChange,
  onRunSource,
  onRunFile,
  onCancel,
  onLoadSession,
  onCallSession,
  onCloseSession,
}: ScriptRunControlsProps) {
  const running = activeRun?.state === "running" || activeRun?.state === "queued";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-panel-raised px-2 py-1.5">
      <button
        type="button"
        onClick={onRunSource}
        disabled={busy || running}
        className="inline-flex h-7 items-center gap-1 bg-primary px-2 font-mono text-[8px] uppercase text-primary-foreground hover:opacity-90 disabled:opacity-40"
      >
        <Play size={10} aria-hidden="true" />
        Run source
      </button>
      <button
        type="button"
        onClick={onRunFile}
        disabled={busy || running}
        className="inline-flex h-7 items-center gap-1 border border-border bg-card px-2 font-mono text-[8px] uppercase text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <Play size={10} aria-hidden="true" />
        Run saved
      </button>
      {running && (
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-7 items-center gap-1 border border-danger/45 px-2 font-mono text-[8px] uppercase text-danger hover:bg-danger/10"
        >
          <Square size={9} aria-hidden="true" />
          Cancel
        </button>
      )}
      <label className="flex items-center gap-1 font-mono text-[8px] uppercase text-muted-foreground">
        Timeout
        <input
          type="number"
          min={1}
          value={timeoutMs}
          onChange={(event) => onTimeoutChange(Number(event.target.value))}
          aria-label="Script timeout in milliseconds"
          className="h-7 w-20 border border-input bg-card px-1.5 font-mono text-[9px] text-foreground focus:border-ring focus:outline-none"
        />
        ms
      </label>

      <span className="ml-auto flex items-center gap-1.5 font-mono text-[8px] uppercase">
        <span
          className={cn("size-1.5 rounded-full bg-muted-foreground", activeRun && "bg-primary")}
        />
        <span className={activeRun ? (RUN_STYLE[activeRun.state] ?? "") : "text-muted-foreground"}>
          {activeRun?.state ?? "idle"}
        </span>
      </span>

      <span className="hidden h-4 w-px bg-border sm:block" />

      {session === null ? (
        <button
          type="button"
          onClick={onLoadSession}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1 border border-border bg-card px-2 font-mono text-[8px] uppercase text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <LoaderCircle size={10} aria-hidden="true" />
          Load session
        </button>
      ) : (
        <>
          <label className="flex items-center gap-1">
            <span className="sr-only">Session function</span>
            <input
              value={functionName}
              onChange={(event) => onFunctionNameChange(event.target.value)}
              placeholder="function()"
              autoComplete="off"
              className="h-7 w-24 border border-input bg-card px-1.5 font-mono text-[9px] placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={onCallSession}
            disabled={busy || running || functionName.trim().length === 0}
            className="inline-flex h-7 items-center gap-1 border border-border bg-card px-2 font-mono text-[8px] uppercase hover:bg-muted disabled:opacity-40"
          >
            <Play size={9} aria-hidden="true" />
            Call
          </button>
          <button
            type="button"
            onClick={onCloseSession}
            aria-label="Close script session"
            className="grid size-7 place-items-center border border-border bg-card text-muted-foreground hover:text-danger"
          >
            <X size={11} aria-hidden="true" />
          </button>
        </>
      )}
      {session !== null && (
        <span
          className="inline-flex items-center gap-1 font-mono text-[8px] uppercase text-rx"
          title={`Session for ${session.path}`}
        >
          <Unplug size={9} aria-hidden="true" />
          session
        </span>
      )}
    </div>
  );
}
