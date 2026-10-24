# Send and Automation Design

Status: proposed

## Product intent

Sending is a primary bench workflow, not a utility attached to the composer.
Users need to send a command once, replay a measured sequence, poll a device,
and stop immediately when behavior is wrong. The design must make the common
case fast while keeping advanced automation deterministic and observable.

## Surfaces

### Compose

- One-shot ASCII or HEX send to the active Channel.
- Per-codec history and named quick sends remain immediate actions.
- Failed sends produce one local TX error Frame, one inline error, and one toast.

### Command library

- Named payloads with codec, line ending, description, and tags.
- Search, duplicate, edit, delete, and send without loading the composer.
- Commands are reusable across Channels when framing and transport permit it.
- Persist commands independently from the open Channel session.

### Sequence editor

A Sequence is an ordered program of explicit steps:

- `send`: payload, codec, line ending.
- `delay`: fixed duration.
- `expect`: channel-scoped matcher, mode, and timeout.
- `assert`: expected bound or pattern result.
- `repeat`: bounded or continuous loop with interval.

The editor validates the complete program before execution. Invalid HEX,
invalid matcher syntax, missing Channel targets, and unsafe unbounded programs
fail before any bytes are sent.

### Runner

- Start, pause between steps, resume, cancel, and inspect step results.
- Show current step, elapsed time, TX bytes, RX match, latency, and terminal reason.
- Keep a bounded run history and structured output.
- Making a new edit never mutates an already running Sequence.

## Deep module

The Go `automation` module hides scheduling, cancellation, matching, event
ordering, and run retention behind a small interface:

```go
Start(spec RunSpec) (RunInfo, error)
Cancel(runID string) (RunInfo, error)
Status(runID string) (RunInfo, error)
List() []RunInfo
```

React never performs timing. A renderer reload, hidden dock, or transient
dialog must not change execution. Cancellation reaches delays and pending
expectations without waiting for the full step timeout.

### Dependencies

- The module accepts a `Sender` adapter; it does not import serial or TCP drivers.
- The module accepts the shared matcher `Pool`; automation expectations are
  scoped to one backend Channel key so concurrent runs cannot steal each
  other's frames.
- The host emits immutable run-status and step-event snapshots.
- Persistence stores Sequence definitions, not live run state.

### Run semantics

- A run targets exactly one Channel.
- At most one active run owns a Channel by default.
- A second start returns a conflict; queued execution is a separate policy.
- Omitted repeat runs once. Continuous execution is an explicit opt-in.
- Step payloads are copied when the run starts and never observed through
  mutable editor state.
- A failed send stops the run unless the Sequence declares `continue`.
- An expectation timeout stops the run unless the Sequence declares `continue`.
- Cancellation is terminal and idempotent.
- Closing or removing the target Channel cancels its active runs.

### Safety limits

- Bound Sequence step count, payload size, delay, timeout, and history size.
- Require an explicit interval for continuous runs.
- Reject negative or zero intervals that would create an unbounded send loop.
- Report cumulative TX bytes and send count so floods are visible immediately.
- Keep cancellation available while a run is active, including during delays.

### Events

The engine publishes ordered events with stable run and step identities:

- `state`: queued, running, paused, completed, failed, timed-out, cancelled.
- `step`: started, sent, matched, timed-out, failed, completed.
- `io`: TX bytes and matched RX bytes with timestamps and latency.

Events are snapshots suitable for the UI. They never expose mutable engine
state.

## Frontend placement

The operations dock gains three tabs: Transmit, Sequence, and Inspect.
Transmit remains one action away. Sequence is a compact library plus runner;
detailed editing uses the same dock rather than a disconnected modal.

Narrow windows stack the dock below the frame stream. The active run must stay
visible while the user watches frames, and Stop must remain reachable.

## Delivery phases

1. Channel-scoped matcher and cancellable await primitives.
2. Native Go automation engine with send/delay/expect, one run per Channel,
   cancellation, and structured events.
3. Host bindings and adapter from Channel targets to serial/TCP sends.
4. Sequence editor, runner, run history, and output in the operations dock.
5. Persistent Command and Sequence libraries.
6. Batch assertions, imported payload files, and richer run reports.

Each phase is independently testable through the same deep interface.
