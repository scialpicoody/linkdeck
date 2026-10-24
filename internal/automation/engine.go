package automation

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"linkdeck/internal/script"
)

const defaultHistoryLimit = 100

// Options supplies the engine's external seams. A nil Pool creates a private
// pool; callers that receive frames from a stream must pass that shared pool.
type Options struct {
	Sender       Sender
	Pool         *script.Pool
	Emit         func(Event)
	HistoryLimit int
}

type runState struct {
	info   RunInfo
	cancel context.CancelFunc
	paused bool
	resume chan struct{}
}

// Engine owns active Runs and bounded terminal history. All methods are safe
// for concurrent use.
type Engine struct {
	sender   Sender
	pool     *script.Pool
	emit     func(Event)
	history  int
	ownsPool bool

	mu     sync.Mutex
	runs   map[string]*runState
	active map[string]string // Channel -> Run id
	nextID uint64
	closed bool
	wg     sync.WaitGroup
}

// NewEngine returns an automation engine. A nil emitter discards events.
func NewEngine(opts Options) *Engine {
	pool := opts.Pool
	ownsPool := false
	if pool == nil {
		pool = script.NewPool()
		ownsPool = true
	}
	history := opts.HistoryLimit
	if history <= 0 {
		history = defaultHistoryLimit
	}
	return &Engine{
		sender:   opts.Sender,
		pool:     pool,
		emit:     opts.Emit,
		history:  history,
		ownsPool: ownsPool,
		runs:     make(map[string]*runState),
		active:   make(map[string]string),
	}
}

// Start validates and begins one Run, returning its queued snapshot.
func (e *Engine) Start(spec RunSpec) (RunInfo, error) {
	spec, err := normalizeSpec(spec)
	if err != nil {
		return RunInfo{}, err
	}
	if e.sender == nil {
		return RunInfo{}, errors.New("automation: sender is not configured")
	}

	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return RunInfo{}, ErrClosed
	}
	if existing := e.active[spec.Target.Channel]; existing != "" {
		e.mu.Unlock()
		return RunInfo{}, fmt.Errorf("%w: %s", ErrChannelBusy, existing)
	}
	e.nextID++
	id := fmt.Sprintf("automation-%d", e.nextID)
	ctx, cancel := context.WithCancel(context.Background())
	info := RunInfo{
		ID:          id,
		Name:        spec.Name,
		Channel:     spec.Target.Channel,
		State:       StateQueued,
		CreatedAtMs: script.NowMillis(),
	}
	e.runs[id] = &runState{info: info, cancel: cancel, resume: make(chan struct{})}
	e.active[spec.Target.Channel] = id
	e.wg.Add(1)
	e.mu.Unlock()

	e.emitEvent(Event{
		Run: info, Kind: "state", Phase: string(StateQueued), TsMillis: script.NowMillis(),
	})
	go e.execute(ctx, id, spec)
	return info, nil
}

// Cancel requests terminal cancellation. Repeated or terminal calls are
// idempotent and return the current snapshot.
func (e *Engine) Cancel(id string) (RunInfo, error) {
	e.mu.Lock()
	run := e.runs[id]
	if run == nil {
		e.mu.Unlock()
		return RunInfo{}, ErrRunNotFound
	}
	info := run.info
	if !terminal(info.State) {
		run.cancel()
	}
	e.mu.Unlock()
	return info, nil
}

// Pause requests a boundary pause. The current send/delay/expect step is
// allowed to finish; subsequent steps wait for Resume or Cancel.
func (e *Engine) Pause(id string) (RunInfo, error) {
	e.mu.Lock()
	run := e.runs[id]
	if run == nil {
		e.mu.Unlock()
		return RunInfo{}, ErrRunNotFound
	}
	if terminal(run.info.State) || run.paused {
		info := run.info
		e.mu.Unlock()
		return info, nil
	}
	run.paused = true
	run.info.State = StatePaused
	info := run.info
	e.mu.Unlock()
	e.emitEvent(Event{
		Run: info, Kind: "state", Phase: string(StatePaused), TsMillis: script.NowMillis(),
	})
	return info, nil
}

// Resume releases a boundary pause and returns the Run to running.
func (e *Engine) Resume(id string) (RunInfo, error) {
	e.mu.Lock()
	run := e.runs[id]
	if run == nil {
		e.mu.Unlock()
		return RunInfo{}, ErrRunNotFound
	}
	if terminal(run.info.State) || !run.paused {
		info := run.info
		e.mu.Unlock()
		return info, nil
	}
	run.paused = false
	run.info.State = StateRunning
	close(run.resume)
	run.resume = make(chan struct{})
	info := run.info
	e.mu.Unlock()
	e.emitEvent(Event{
		Run: info, Kind: "state", Phase: string(StateRunning), TsMillis: script.NowMillis(),
	})
	return info, nil
}

// CancelChannel cancels every active Run targeting channel and returns how
// many were requested to stop. It is used by Channel close/removal paths.
func (e *Engine) CancelChannel(channel string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	id := e.active[channel]
	if id == "" {
		return 0
	}
	if run := e.runs[id]; run != nil && !terminal(run.info.State) {
		run.cancel()
		return 1
	}
	return 0
}

// Status returns one retained Run snapshot.
func (e *Engine) Status(id string) (RunInfo, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	run := e.runs[id]
	if run == nil {
		return RunInfo{}, ErrRunNotFound
	}
	return run.info, nil
}

// List returns active and retained terminal Runs in creation order.
func (e *Engine) List() []RunInfo {
	e.mu.Lock()
	out := make([]RunInfo, 0, len(e.runs))
	for _, run := range e.runs {
		out = append(out, run.info)
	}
	e.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAtMs == out[j].CreatedAtMs {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAtMs < out[j].CreatedAtMs
	})
	return out
}

// Close cancels active Runs and waits for their goroutines. It is idempotent.
func (e *Engine) Close() {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	e.closed = true
	for _, run := range e.runs {
		if !terminal(run.info.State) {
			run.cancel()
		}
	}
	e.mu.Unlock()
	e.wg.Wait()
	if e.ownsPool {
		e.pool.Close()
	}
}

func (e *Engine) execute(ctx context.Context, id string, spec RunSpec) {
	defer e.wg.Done()
	if ctx.Err() != nil {
		e.finish(id, StateCancelled, "")
		return
	}
	info, startedState, ok := e.setRunning(id)
	if !ok {
		return
	}
	e.emitEvent(Event{
		Run: info, Kind: "state", Phase: string(startedState), TsMillis: script.NowMillis(),
	})

	for iteration := 0; spec.Continuous || iteration < spec.Repeat; iteration++ {
		if !e.waitForResume(ctx, id) {
			e.finish(id, StateCancelled, "")
			return
		}
		if iteration > 0 && spec.IntervalMs > 0 {
			if !e.wait(ctx, time.Duration(spec.IntervalMs)*time.Millisecond) {
				e.finish(id, StateCancelled, "")
				return
			}
		}
		for index, step := range spec.Steps {
			if !e.waitForResume(ctx, id) {
				e.finish(id, StateCancelled, "")
				return
			}
			if ctx.Err() != nil {
				e.finish(id, StateCancelled, "")
				return
			}
			stepID := fmt.Sprintf("%s:%d:%d", id, iteration+1, index+1)
			info = e.startStep(id, index+1)
			e.emitEvent(Event{
				Run: info, Kind: "step", Phase: "started", StepID: stepID,
				Step: index + 1, Action: step.Kind, TsMillis: script.NowMillis(),
			})
			switch step.Kind {
			case StepSend:
				started := time.Now()
				err := e.sender.Send(spec.Target, step.Payload)
				if err != nil {
					e.emitEvent(Event{
						Run: info, Kind: "step", Phase: "failed", StepID: stepID,
						Step: index + 1, Action: step.Kind, TsMillis: script.NowMillis(),
						LatencyMs: time.Since(started).Milliseconds(), Message: err.Error(),
					})
					if step.ContinueOnError {
						continue
					}
					e.finish(id, StateFailed, err.Error())
					return
				}
				info = e.recordSent(id, len(step.Payload))
				ts := script.NowMillis()
				e.emitEvent(Event{
					Run: info, Kind: "io", Phase: "sent", StepID: stepID,
					Step: index + 1, Action: step.Kind, Direction: "tx",
					Payload: step.Payload, TsMillis: ts,
					LatencyMs: time.Since(started).Milliseconds(),
				})
				e.emitEvent(Event{
					Run: info, Kind: "step", Phase: "completed", StepID: stepID,
					Step: index + 1, Action: step.Kind, TsMillis: ts,
				})
			case StepDelay:
				started := time.Now()
				if !e.wait(ctx, time.Duration(step.DelayMs)*time.Millisecond) {
					e.finish(id, StateCancelled, "")
					return
				}
				e.emitEvent(Event{
					Run: info, Kind: "step", Phase: "completed", StepID: stepID,
					Step: index + 1, Action: step.Kind, TsMillis: script.NowMillis(),
					LatencyMs: time.Since(started).Milliseconds(),
				})
			case StepExpect:
				started := time.Now()
				reg, err := e.pool.RegisterOn(
					spec.Target.Channel, step.Pattern, step.Mode, step.TimeoutMs,
				)
				if err != nil {
					e.finish(id, StateFailed, err.Error())
					return
				}
				frame, awaitErr := e.pool.AwaitContext(ctx, reg)
				latency := time.Since(started).Milliseconds()
				if awaitErr != nil {
					phase := "failed"
					state := StateFailed
					if errors.Is(awaitErr, script.ErrTimeout) {
						phase = "timed-out"
						state = StateTimedOut
					} else if errors.Is(awaitErr, context.Canceled) {
						e.finish(id, StateCancelled, "")
						return
					}
					e.emitEvent(Event{
						Run: info, Kind: "step", Phase: phase, StepID: stepID,
						Step: index + 1, Action: step.Kind, TsMillis: script.NowMillis(),
						LatencyMs: latency, Message: awaitErr.Error(),
					})
					if step.ContinueOnError {
						continue
					}
					e.finish(id, state, awaitErr.Error())
					return
				}
				info = e.recordMatched(id)
				ts := script.NowMillis()
				e.emitEvent(Event{
					Run: info, Kind: "io", Phase: "matched", StepID: stepID,
					Step: index + 1, Action: step.Kind, Direction: "rx",
					Payload: frame.Payload, TsMillis: ts, LatencyMs: latency,
				})
				e.emitEvent(Event{
					Run: info, Kind: "step", Phase: "completed", StepID: stepID,
					Step: index + 1, Action: step.Kind, TsMillis: ts,
				})
			}
		}
	}
	e.finish(id, StateCompleted, "")
}

func (e *Engine) setRunning(id string) (RunInfo, RunState, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	run := e.runs[id]
	if run == nil || terminal(run.info.State) {
		return RunInfo{}, "", false
	}
	run.info.StartedAtMs = script.NowMillis()
	if !run.paused {
		run.info.State = StateRunning
	}
	return run.info, run.info.State, true
}

func (e *Engine) startStep(id string, step int) RunInfo {
	e.mu.Lock()
	defer e.mu.Unlock()
	run := e.runs[id]
	if run == nil {
		return RunInfo{}
	}
	run.info.CurrentStep = step
	return run.info
}

func (e *Engine) recordSent(id string, bytes int) RunInfo {
	e.mu.Lock()
	defer e.mu.Unlock()
	run := e.runs[id]
	if run == nil {
		return RunInfo{}
	}
	run.info.Sent++
	run.info.BytesSent += int64(bytes)
	return run.info
}

func (e *Engine) recordMatched(id string) RunInfo {
	e.mu.Lock()
	defer e.mu.Unlock()
	run := e.runs[id]
	if run == nil {
		return RunInfo{}
	}
	run.info.Matched++
	return run.info
}

func (e *Engine) finish(id string, state RunState, message string) {
	e.mu.Lock()
	run := e.runs[id]
	if run == nil || terminal(run.info.State) {
		e.mu.Unlock()
		return
	}
	run.info.State = state
	run.info.Error = message
	run.info.FinishedAtMs = script.NowMillis()
	delete(e.active, run.info.Channel)
	info := run.info
	e.mu.Unlock()

	e.emitEvent(Event{
		Run: info, Kind: "state", Phase: string(state), TsMillis: script.NowMillis(),
		Message: message,
	})
	e.pruneHistory()
}

func (e *Engine) wait(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (e *Engine) waitForResume(ctx context.Context, id string) bool {
	for {
		e.mu.Lock()
		run := e.runs[id]
		if run == nil || terminal(run.info.State) {
			e.mu.Unlock()
			return false
		}
		if !run.paused {
			e.mu.Unlock()
			return true
		}
		resume := run.resume
		e.mu.Unlock()
		select {
		case <-ctx.Done():
			return false
		case <-resume:
		}
	}
}

func (e *Engine) emitEvent(event Event) {
	if e.emit == nil {
		return
	}
	event.Payload = append([]byte(nil), event.Payload...)
	e.emit(event)
}

func (e *Engine) pruneHistory() {
	e.mu.Lock()
	terminalRuns := make([]RunInfo, 0, len(e.runs))
	for _, run := range e.runs {
		if terminal(run.info.State) {
			terminalRuns = append(terminalRuns, run.info)
		}
	}
	if len(terminalRuns) <= e.history {
		e.mu.Unlock()
		return
	}
	sort.Slice(terminalRuns, func(i, j int) bool {
		return terminalRuns[i].FinishedAtMs < terminalRuns[j].FinishedAtMs
	})
	for i := 0; i < len(terminalRuns)-e.history; i++ {
		delete(e.runs, terminalRuns[i].ID)
	}
	e.mu.Unlock()
}
