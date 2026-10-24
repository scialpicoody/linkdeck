import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Clock,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type AutomationController,
  type AutomationIoCapture,
  useAutomationController,
} from "../../lib/automation-controller";
import {
  type AutomationRunView,
  activeAutomationRun,
  automationRunViews,
} from "../../lib/automation-projection";
import {
  type AutomationChannelSource,
  type AutomationLineEnding,
  type AutomationMatchMode,
  type AutomationSequenceDraft,
  type AutomationStepDraft,
  type AutomationStepKind,
  automationTargetFromChannel,
  createDelayStep,
  createExpectStep,
  createSendStep,
  createSequenceDraft,
  draftToRunSpec,
  reorderSteps,
  validateSequenceDraft,
} from "../../lib/automation-sequence";
import { cn } from "../../lib/utils";
import type { Event as AutomationEvent, Target } from "../../mygo";
import { Hint } from "../ui/Hint";

export interface SequencePanelProps {
  /** Active workbench Channel, or null when no target is available. */
  channel: AutomationChannelSource | null;
  /** Hook for recording successful automation TX and matched RX locally. */
  onIoCapture: (io: AutomationIoCapture) => void;
}

export interface SequencePanelViewProps extends SequencePanelProps {
  controller: AutomationController;
}

const INPUT =
  "h-7 min-w-0 border border-input bg-card px-1.5 font-mono text-[10px] text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none disabled:opacity-45";
const NUMBER_INPUT = `${INPUT} w-20 tabular-nums`;
const CHECKBOX =
  "size-3 rounded-none border-input bg-card text-primary accent-[var(--primary)] focus:ring-1 focus:ring-ring";

const RUN_STYLE: Record<string, string> = {
  queued: "text-muted-foreground",
  running: "text-primary",
  paused: "text-warning",
  completed: "text-rx",
  failed: "text-danger",
  "timed-out": "text-warning",
  cancelled: "text-muted-foreground",
};

const STEP_META: Record<AutomationStepKind, { label: string; icon: typeof Send; hint: string }> = {
  send: { label: "Send", icon: Send, hint: "Transmit a payload" },
  delay: { label: "Delay", icon: Clock, hint: "Wait before the next step" },
  expect: { label: "Expect", icon: Radio, hint: "Wait for matching RX" },
};

function byteCount(payload: string | undefined): number {
  if (!payload) return 0;
  const compact = payload.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function formatClock(tsMillis: number): string {
  const date = new Date(tsMillis);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

function eventSummary(event: AutomationEvent): string {
  if (event.kind === "io") {
    const direction = event.direction === "rx" ? "RX" : "TX";
    return `${direction} ${event.phase ?? "io"} · ${byteCount(event.payload)} B${
      event.latencyMs !== undefined ? ` · ${event.latencyMs} ms` : ""
    }`;
  }
  if (event.kind === "step") {
    const action = event.action === undefined ? "" : ` · ${event.action}`;
    return `Step ${event.step ?? "?"} ${event.phase ?? "update"}${action}`;
  }
  return event.message ?? event.phase ?? event.kind;
}

function stepIssue(
  draft: AutomationSequenceDraft,
  stepIndex: number,
  target: Target | null,
): string | null {
  return (
    validateSequenceDraft(draft, target).find((issue) => issue.stepIndex === stepIndex)?.message ??
    null
  );
}

function AddStepButton({
  kind,
  onAdd,
}: {
  kind: AutomationStepKind;
  onAdd: (kind: AutomationStepKind) => void;
}) {
  const meta = STEP_META[kind];
  const Icon = meta.icon;
  return (
    <Hint label={meta.hint}>
      <button
        type="button"
        onClick={() => onAdd(kind)}
        className="inline-flex h-7 flex-1 items-center justify-center gap-1 border border-border bg-card px-1.5 font-mono text-[8px] uppercase text-muted-foreground hover:border-border-strong hover:text-foreground"
      >
        <Icon size={10} aria-hidden="true" />
        {meta.label}
      </button>
    </Hint>
  );
}

function RunStrip({
  controller,
  targetChannel,
  activeRun,
  selectedRun,
  runs,
  onStart,
  onCancel,
  onPause,
  onResume,
}: {
  controller: AutomationController;
  targetChannel: string | null;
  activeRun: AutomationRunView | null;
  selectedRun: AutomationRunView | null;
  runs: AutomationRunView[];
  onStart: () => void;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const visible = selectedRun ?? activeRun;
  const canPause = activeRun?.run.state === "running";
  const canResume = activeRun?.run.state === "paused";
  return (
    <div className="shrink-0 border-b border-border bg-panel-raised px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span
          className={cn(
            "inline-flex items-center gap-1 font-mono text-[8px] uppercase",
            visible === null ? "text-muted-foreground" : RUN_STYLE[visible.run.state],
          )}
          aria-live="polite"
        >
          <span
            className={cn(
              "size-1.5 rounded-full bg-muted-foreground",
              visible?.active && "animate-pulse bg-primary",
              visible?.run.state === "completed" && "bg-rx",
              visible?.run.state === "failed" && "bg-danger",
            )}
          />
          {visible?.run.state ?? "ready"}
        </span>

        {runs.length > 0 && (
          <select
            aria-label="Automation run history"
            value={visible?.run.id ?? ""}
            onChange={(event) => controller.selectRun(event.target.value || null)}
            className={cn(INPUT, "ml-auto max-w-40 text-[9px]")}
          >
            {runs.slice(0, 20).map((view) => (
              <option key={view.run.id} value={view.run.id}>
                {view.run.name || view.run.id} · {view.run.state}
              </option>
            ))}
          </select>
        )}

        {canPause && (
          <Hint label="Pause after the current step">
            <button
              type="button"
              onClick={onPause}
              disabled={controller.pausing}
              aria-label="Pause Sequence after the current step"
              className="inline-flex h-7 items-center gap-1 border border-warning/45 bg-card px-2 font-mono text-[8px] uppercase text-warning hover:bg-warning/10 disabled:opacity-45"
            >
              {controller.pausing ? (
                <LoaderCircle size={10} className="animate-spin" aria-hidden="true" />
              ) : (
                <Pause size={9} aria-hidden="true" />
              )}
              Pause
            </button>
          </Hint>
        )}
        {canResume && (
          <Hint label="Resume Sequence">
            <button
              type="button"
              onClick={onResume}
              disabled={controller.resuming}
              aria-label="Resume Sequence"
              className="inline-flex h-7 items-center gap-1 border border-rx/45 bg-card px-2 font-mono text-[8px] uppercase text-rx hover:bg-rx/10 disabled:opacity-45"
            >
              {controller.resuming ? (
                <LoaderCircle size={10} className="animate-spin" aria-hidden="true" />
              ) : (
                <Play size={9} aria-hidden="true" />
              )}
              Resume
            </button>
          </Hint>
        )}
        <Hint label={activeRun === null ? "Start Sequence" : "Cancel active Sequence"}>
          <button
            type="button"
            onClick={activeRun === null ? onStart : onCancel}
            disabled={activeRun === null ? controller.starting : controller.cancelling}
            className={cn(
              "inline-flex h-7 items-center gap-1 px-2 font-mono text-[8px] font-medium uppercase disabled:opacity-45",
              activeRun === null
                ? "bg-primary text-primary-foreground hover:bg-primary/88"
                : "border border-danger/50 bg-card text-danger hover:bg-danger/10",
            )}
          >
            {activeRun === null ? (
              controller.starting ? (
                <LoaderCircle size={10} className="animate-spin" aria-hidden="true" />
              ) : (
                <Play size={10} aria-hidden="true" />
              )
            ) : controller.cancelling ? (
              <LoaderCircle size={10} className="animate-spin" aria-hidden="true" />
            ) : (
              <Square size={9} aria-hidden="true" />
            )}
            {activeRun === null ? "Start" : "Stop"}
          </button>
        </Hint>
        <Hint label="Refresh run history">
          <button
            type="button"
            onClick={() => void controller.refresh()}
            disabled={controller.loading || !controller.available}
            aria-label="Refresh automation run history"
            className="grid size-7 place-items-center border border-border bg-card text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw
              size={10}
              className={controller.loading ? "animate-spin" : ""}
              aria-hidden="true"
            />
          </button>
        </Hint>
      </div>

      {visible !== null ? (
        <>
          <div className="mt-1.5 grid grid-cols-3 gap-px overflow-hidden border border-border bg-border font-mono">
            <div className="bg-card px-1.5 py-1">
              <div className="text-[7px] uppercase tracking-wider text-muted-foreground">Step</div>
              <div className="truncate text-[10px] text-foreground">
                {visible.run.currentStep > 0
                  ? `${visible.run.currentStep} · ${visible.lastAction ?? "working"}`
                  : "—"}
              </div>
            </div>
            <div className="bg-card px-1.5 py-1">
              <div className="text-[7px] uppercase tracking-wider text-muted-foreground">TX</div>
              <div className="truncate text-[10px] text-tx">
                {visible.txCount} / {visible.txBytes} B
              </div>
            </div>
            <div className="bg-card px-1.5 py-1">
              <div className="text-[7px] uppercase tracking-wider text-muted-foreground">RX</div>
              <div className="truncate text-[10px] text-rx">
                {visible.rxCount} / {visible.rxBytes} B
              </div>
            </div>
          </div>
          {visible.run.error && (
            <p
              role="alert"
              className="mt-1 max-h-12 overflow-y-auto border-l-2 border-danger pl-1.5 font-mono text-[9px] leading-snug text-danger"
            >
              {visible.run.error}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 font-mono text-[8px] uppercase text-muted-foreground">
          {targetChannel ?? "No channel"} · no retained runs
        </p>
      )}

      {controller.error && (
        <p
          role="alert"
          className="mt-1 border-l-2 border-danger pl-1.5 font-mono text-[9px] leading-snug text-danger"
        >
          {controller.error}
        </p>
      )}
    </div>
  );
}

function StepHeader({
  draft,
  index,
  target,
  onMove,
  onRemove,
  onChange,
}: {
  draft: AutomationSequenceDraft;
  index: number;
  target: Target | null;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onChange: (step: AutomationStepDraft) => void;
}) {
  const step = draft.steps[index];
  if (step === undefined) return null;
  const issue = stepIssue(draft, index, target);
  return (
    <div className="flex items-center gap-1 border-b border-border bg-panel-raised px-1.5 py-1">
      <span
        className={cn(
          "grid size-5 shrink-0 place-items-center border border-border bg-card font-mono text-[8px] text-muted-foreground",
          issue !== null && "border-danger/50 text-danger",
        )}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <select
        aria-label={`Step ${index + 1} action`}
        value={step.kind}
        onChange={(event) => {
          const kind = event.target.value as AutomationStepKind;
          const next =
            kind === "send"
              ? createSendStep({ id: step.id })
              : kind === "delay"
                ? createDelayStep({ id: step.id })
                : createExpectStep({ id: step.id });
          onChange(next);
        }}
        className={cn(INPUT, "w-20 text-[9px] uppercase")}
      >
        {(["send", "delay", "expect"] as const).map((kind) => (
          <option key={kind} value={kind}>
            {STEP_META[kind].label}
          </option>
        ))}
      </select>
      <span className="min-w-0 flex-1 truncate font-mono text-[8px] text-muted-foreground">
        {STEP_META[step.kind].hint}
      </span>
      <Hint label="Move step up">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={`Move step ${index + 1} up`}
          className="grid size-6 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"
        >
          <ArrowUp size={10} aria-hidden="true" />
        </button>
      </Hint>
      <Hint label="Move step down">
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === draft.steps.length - 1}
          aria-label={`Move step ${index + 1} down`}
          className="grid size-6 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"
        >
          <ArrowDown size={10} aria-hidden="true" />
        </button>
      </Hint>
      <Hint label="Remove step">
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove step ${index + 1}`}
          className="grid size-6 place-items-center text-muted-foreground hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={10} aria-hidden="true" />
        </button>
      </Hint>
    </div>
  );
}

function StepEditor({
  draft,
  index,
  target,
  showIssues,
  onMove,
  onRemove,
  onChange,
}: {
  draft: AutomationSequenceDraft;
  index: number;
  target: Target | null;
  showIssues: boolean;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onChange: (step: AutomationStepDraft) => void;
}) {
  const step = draft.steps[index];
  if (step === undefined) return null;
  const issue = showIssues ? stepIssue(draft, index, target) : null;

  return (
    <li className="border border-border bg-card">
      <StepHeader
        draft={draft}
        index={index}
        target={target}
        onMove={onMove}
        onRemove={onRemove}
        onChange={onChange}
      />
      <div className="grid gap-1.5 p-1.5">
        {step.kind === "send" && (
          <>
            <textarea
              value={step.payload}
              onChange={(event) => onChange({ ...step, payload: event.target.value })}
              rows={2}
              aria-label={`Step ${index + 1} payload`}
              aria-invalid={issue !== null}
              placeholder={step.codec === "ascii" ? "AT+CSQ" : "AA 55 01 0D 0A"}
              spellCheck={false}
              className="min-h-12 resize-y border border-input bg-card p-1.5 font-mono text-[10px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-1">
              <div className="flex border border-border bg-panel-raised p-0.5">
                {(["ascii", "hex"] as const).map((codec) => (
                  <button
                    key={codec}
                    type="button"
                    aria-pressed={step.codec === codec}
                    onClick={() => onChange({ ...step, codec })}
                    className={cn(
                      "px-1.5 py-0.5 font-mono text-[8px] uppercase",
                      step.codec === codec
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {codec}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1 font-mono text-[8px] uppercase text-muted-foreground">
                End
                <select
                  value={step.lineEnding}
                  onChange={(event) =>
                    onChange({
                      ...step,
                      lineEnding: event.target.value as AutomationLineEnding,
                    })
                  }
                  disabled={step.codec === "hex"}
                  aria-label={`Step ${index + 1} line ending`}
                  className={cn(INPUT, "w-16 text-[8px]")}
                >
                  <option value="none">None</option>
                  <option value="lf">LF</option>
                  <option value="crlf">CRLF</option>
                </select>
              </label>
              <label className="ml-auto flex items-center gap-1 font-mono text-[8px] uppercase text-muted-foreground">
                <input
                  type="checkbox"
                  checked={step.continueOnError === true}
                  onChange={(event) => onChange({ ...step, continueOnError: event.target.checked })}
                  className={CHECKBOX}
                />
                Continue on error
              </label>
            </div>
          </>
        )}

        {step.kind === "delay" && (
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="flex items-center gap-1 font-mono text-[8px] uppercase text-muted-foreground">
              Delay
              <input
                type="number"
                min={0}
                max={86_400_000}
                step={1}
                value={step.delayMs}
                onChange={(event) => onChange({ ...step, delayMs: Number(event.target.value) })}
                aria-label={`Step ${index + 1} delay in milliseconds`}
                aria-invalid={issue !== null}
                className={NUMBER_INPUT}
              />
              ms
            </label>
            <span className="font-mono text-[8px] text-muted-foreground">
              Cancellation interrupts the wait immediately.
            </span>
            <label className="ml-auto flex items-center gap-1 font-mono text-[8px] uppercase text-muted-foreground">
              <input
                type="checkbox"
                checked={step.continueOnError === true}
                onChange={(event) => onChange({ ...step, continueOnError: event.target.checked })}
                className={CHECKBOX}
              />
              Continue
            </label>
          </div>
        )}

        {step.kind === "expect" && (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <label className="flex items-center gap-1 font-mono text-[8px] uppercase text-muted-foreground">
                Match
                <select
                  value={step.mode}
                  onChange={(event) =>
                    onChange({ ...step, mode: event.target.value as AutomationMatchMode })
                  }
                  aria-label={`Step ${index + 1} match mode`}
                  className={cn(INPUT, "w-20 text-[8px]")}
                >
                  <option value="prefix">Prefix</option>
                  <option value="regex">Regex</option>
                  <option value="pattern">Pattern</option>
                </select>
              </label>
              <label className="flex items-center gap-1 font-mono text-[8px] uppercase text-muted-foreground">
                Timeout
                <input
                  type="number"
                  min={1}
                  max={86_400_000}
                  step={1}
                  value={step.timeoutMs}
                  onChange={(event) => onChange({ ...step, timeoutMs: Number(event.target.value) })}
                  aria-label={`Step ${index + 1} timeout in milliseconds`}
                  aria-invalid={issue !== null}
                  className={NUMBER_INPUT}
                />
                ms
              </label>
              <label className="ml-auto flex items-center gap-1 font-mono text-[8px] uppercase text-muted-foreground">
                <input
                  type="checkbox"
                  checked={step.continueOnError}
                  onChange={(event) => onChange({ ...step, continueOnError: event.target.checked })}
                  className={CHECKBOX}
                />
                Continue
              </label>
            </div>
            <input
              value={step.pattern}
              onChange={(event) => onChange({ ...step, pattern: event.target.value })}
              aria-label={`Step ${index + 1} match pattern`}
              aria-invalid={issue !== null}
              placeholder={
                step.mode === "regex" ? "^OK(?:\\r?\\n)?$" : step.mode === "pattern" ? "OK%d" : "OK"
              }
              autoComplete="off"
              spellCheck={false}
              className={cn(INPUT, "w-full")}
            />
          </>
        )}

        {issue !== null && (
          <p role="alert" className="font-mono text-[9px] leading-snug text-danger">
            {issue}
          </p>
        )}
      </div>
    </li>
  );
}

export function SequencePanelView({ channel, controller }: SequencePanelViewProps) {
  const [draft, setDraft] = useState<AutomationSequenceDraft>(() => createSequenceDraft());
  const [showIssues, setShowIssues] = useState(false);

  const target = useMemo(() => automationTargetFromChannel(channel), [channel]);
  const conversion = useMemo(() => draftToRunSpec(draft, target), [draft, target]);
  const activeRun = activeAutomationRun(controller.projection, target?.channel);
  const runs = automationRunViews(controller.projection, target?.channel);
  const selectedRun =
    runs.find((view) => view.run.id === controller.selectedRunId) ?? activeRun ?? runs[0] ?? null;

  function updateDraft(updater: (current: AutomationSequenceDraft) => AutomationSequenceDraft) {
    setDraft(updater);
  }

  function addStep(kind: AutomationStepKind) {
    const step =
      kind === "send"
        ? createSendStep()
        : kind === "delay"
          ? createDelayStep()
          : createExpectStep();
    updateDraft((current) => ({ ...current, steps: [...current.steps, step] }));
  }

  function replaceStep(index: number, step: AutomationStepDraft) {
    updateDraft((current) => ({
      ...current,
      steps: current.steps.map((item, itemIndex) => (itemIndex === index ? step : item)),
    }));
  }

  function moveStep(index: number, direction: -1 | 1) {
    updateDraft((current) => ({
      ...current,
      steps: reorderSteps(current.steps, index, index + direction),
    }));
  }

  function removeStep(index: number) {
    updateDraft((current) => ({
      ...current,
      steps: current.steps.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  async function startSequence() {
    setShowIssues(true);
    const result = draftToRunSpec(draft, target);
    if (result.spec === null) {
      toast.error("Sequence is not ready", {
        description: result.issues[0]?.message ?? "Fix the highlighted steps.",
      });
      return;
    }
    try {
      const info = await controller.start(result.spec);
      toast.success("Sequence started", {
        description: `${info.name} · ${info.channel}`,
      });
    } catch (caught) {
      toast.error("Start Sequence failed", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  async function cancelSequence() {
    if (activeRun === null) return;
    try {
      await controller.cancel(activeRun.run.id);
      toast.info("Cancelling Sequence");
    } catch (caught) {
      toast.error("Cancel Sequence failed", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  async function pauseSequence() {
    if (activeRun === null) return;
    try {
      await controller.pause(activeRun.run.id);
      toast.info("Sequence paused after the current step");
    } catch (caught) {
      toast.error("Pause Sequence failed", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  async function resumeSequence() {
    if (activeRun === null) return;
    try {
      await controller.resume(activeRun.run.id);
      toast.success("Sequence resumed");
    } catch (caught) {
      toast.error("Resume Sequence failed", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  const blockingIssues = showIssues ? conversion.issues : [];
  const sequenceIssues = blockingIssues.filter((issue) => issue.stepIndex === undefined);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel-raised">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="eyebrow text-muted-foreground">Sequence</span>
        <span className="h-3 w-px bg-border" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground">
          {channel?.name ?? "no transmit target"}
        </span>
        {draft.continuous && (
          <span className="font-mono text-[8px] uppercase text-warning">continuous</span>
        )}
      </div>

      <RunStrip
        controller={controller}
        targetChannel={target?.channel ?? null}
        activeRun={activeRun}
        selectedRun={selectedRun}
        runs={runs}
        onStart={() => void startSequence()}
        onCancel={() => void cancelSequence()}
        onPause={() => void pauseSequence()}
        onResume={() => void resumeSequence()}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-border p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="eyebrow text-muted-foreground">Program</span>
            <span className="font-mono text-[8px] text-muted-foreground">
              {draft.steps.length} steps
            </span>
          </div>

          <label className="mb-1.5 block">
            <span className="mb-0.5 block font-mono text-[8px] uppercase text-muted-foreground">
              Name
            </span>
            <input
              value={draft.name}
              onChange={(event) =>
                updateDraft((current) => ({ ...current, name: event.target.value }))
              }
              aria-invalid={showIssues && draft.name.trim().length === 0}
              autoComplete="off"
              className={cn(INPUT, "w-full")}
            />
          </label>

          <div className="grid grid-cols-2 gap-1.5">
            <label>
              <span className="mb-0.5 block font-mono text-[8px] uppercase text-muted-foreground">
                Repeat
              </span>
              <input
                type="number"
                min={1}
                max={1_000_000}
                step={1}
                value={draft.repeat}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    repeat: Number(event.target.value),
                  }))
                }
                disabled={draft.continuous}
                aria-label="Sequence repeat count"
                aria-invalid={
                  showIssues && conversion.issues.some((issue) => issue.field === "repeat")
                }
                className={cn(NUMBER_INPUT, "w-full")}
              />
            </label>
            <label>
              <span className="mb-0.5 block font-mono text-[8px] uppercase text-muted-foreground">
                Interval (ms)
              </span>
              <input
                type="number"
                min={0}
                max={86_400_000}
                step={1}
                value={draft.intervalMs}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    intervalMs: Number(event.target.value),
                  }))
                }
                aria-label="Interval between repeats in milliseconds"
                aria-invalid={showIssues && draft.continuous && draft.intervalMs <= 0}
                className={cn(NUMBER_INPUT, "w-full")}
              />
            </label>
          </div>

          <label
            className={cn(
              "mt-1.5 flex items-start gap-1.5 border-l-2 border-border px-1.5 py-1",
              draft.continuous && "border-warning bg-warning/5",
            )}
          >
            <input
              type="checkbox"
              checked={draft.continuous}
              onChange={(event) =>
                updateDraft((current) => ({ ...current, continuous: event.target.checked }))
              }
              className={cn(CHECKBOX, "mt-0.5")}
            />
            <span>
              <span className="block font-mono text-[8px] uppercase text-muted-foreground">
                Run continuously
              </span>
              <span className="block text-[9px] leading-snug text-muted-foreground">
                Explicit loop. A positive interval is required and Stop is always reachable.
              </span>
            </span>
          </label>

          {sequenceIssues.length > 0 && (
            <div role="alert" className="mt-1.5 border-l-2 border-danger bg-danger/5 px-1.5 py-1">
              {sequenceIssues.map((issue) => (
                <p
                  key={`${issue.field}:${issue.message}`}
                  className="font-mono text-[9px] leading-snug text-danger"
                >
                  {issue.message}
                </p>
              ))}
            </div>
          )}
        </section>

        <section className="border-b border-border p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="eyebrow text-muted-foreground">Steps</span>
            <span className="font-mono text-[8px] text-muted-foreground">
              ordered top to bottom
            </span>
          </div>

          {draft.steps.length === 0 ? (
            <div className="grid min-h-20 place-items-center border border-dashed border-border-strong px-3 text-center">
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Add a send, delay, or expect step to build the program.
              </p>
            </div>
          ) : (
            <ol className="grid gap-1.5">
              {draft.steps.map((step, index) => (
                <StepEditor
                  key={step.id}
                  draft={draft}
                  index={index}
                  target={target}
                  showIssues={showIssues}
                  onMove={(direction) => moveStep(index, direction)}
                  onRemove={() => removeStep(index)}
                  onChange={(next) => replaceStep(index, next)}
                />
              ))}
            </ol>
          )}

          <div className="mt-1.5 flex gap-1">
            <AddStepButton kind="send" onAdd={addStep} />
            <AddStepButton kind="delay" onAdd={addStep} />
            <AddStepButton kind="expect" onAdd={addStep} />
          </div>
        </section>

        <section className="p-2">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Activity size={10} className="text-muted-foreground" aria-hidden="true" />
            <span className="eyebrow text-muted-foreground">Run timeline</span>
            <span className="ml-auto font-mono text-[8px] text-muted-foreground">
              {selectedRun?.timeline.length ?? 0} events
            </span>
          </div>

          {selectedRun === null ? (
            <div className="border border-dashed border-border px-2 py-3 text-center">
              <p className="text-[10px] text-muted-foreground">
                Start a Sequence to see ordered state, step, and I/O events.
              </p>
            </div>
          ) : selectedRun.timeline.length === 0 ? (
            <p className="border border-border bg-card px-2 py-2 text-[10px] text-muted-foreground">
              Waiting for the first engine event.
            </p>
          ) : (
            <div
              role="log"
              aria-label="Automation event timeline"
              className="max-h-44 overflow-y-auto border border-border bg-card py-0.5 font-mono"
            >
              {selectedRun.timeline.map((entry) => {
                const failed =
                  entry.event.phase === "failed" ||
                  entry.event.phase === "timed-out" ||
                  entry.event.run.state === "failed" ||
                  entry.event.run.state === "timed-out";
                const io = entry.event.kind === "io";
                return (
                  <div
                    key={entry.id}
                    className="flex min-h-5 items-start gap-1.5 border-b border-border/40 px-1.5 py-0.5 last:border-0"
                  >
                    <span className="shrink-0 text-[8px] tabular-nums text-muted-foreground">
                      {formatClock(entry.event.tsMillis)}
                    </span>
                    <span
                      className={cn(
                        "w-10 shrink-0 text-[8px] uppercase",
                        failed
                          ? "text-danger"
                          : io
                            ? entry.event.direction === "rx"
                              ? "text-rx"
                              : "text-tx"
                            : "text-muted-foreground",
                      )}
                    >
                      {entry.event.kind}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 text-[9px] leading-snug",
                        failed ? "text-danger" : "text-foreground",
                      )}
                    >
                      {eventSummary(entry.event)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {!controller.available && (
            <p className="mt-1.5 flex items-start gap-1 border-l-2 border-warning pl-1.5 font-mono text-[9px] leading-snug text-warning">
              <AlertTriangle size={10} className="mt-0.5 shrink-0" aria-hidden="true" />
              Browser mode has no automation host. Draft validation remains available.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Compact Sequence surface for the operations dock. Mounting it subscribes to
 * host automation events; App only needs to pass the active Channel and a TX
 * capture callback.
 */
export default function SequencePanel({ channel, onIoCapture }: SequencePanelProps) {
  const controller = useAutomationController({
    onIoCapture: (io) => {
      // Runs can finish while the user switches Channels; only the panel's
      // current backend target contributes local Frame capture.
      if (channel !== null && io.channel === channel.backendKey) onIoCapture(io);
    },
  });
  return <SequencePanelView channel={channel} controller={controller} onIoCapture={onIoCapture} />;
}
