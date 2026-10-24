// Package automation runs deterministic send/delay/expect programs against
// one Channel. It is independent of transport drivers: the host supplies a
// Sender adapter and the shared matcher Pool.
package automation

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"linkdeck/internal/script"
)

const (
	maxSteps     = 256
	maxPayload   = 1 << 20
	maxRepeat    = 1_000_000
	maxWaitMs    = int((24 * time.Hour) / time.Millisecond)
	defaultMatch = 1000
)

var (
	ErrRunNotFound = errors.New("automation: run not found")
	ErrChannelBusy = errors.New("automation: channel already has an active run")
	ErrClosed      = errors.New("automation: engine closed")
)

// RunState is the durable lifecycle state of one automation Run.
type RunState string

const (
	StateQueued    RunState = "queued"
	StateRunning   RunState = "running"
	StatePaused    RunState = "paused"
	StateCompleted RunState = "completed"
	StateFailed    RunState = "failed"
	StateTimedOut  RunState = "timed-out"
	StateCancelled RunState = "cancelled"
)

// StepKind is one explicit Sequence action.
type StepKind string

const (
	StepSend   StepKind = "send"
	StepDelay  StepKind = "delay"
	StepExpect StepKind = "expect"
)

// Target identifies the backend Channel a Run owns. Parent is used for
// accepted TCP connections; other transports leave it empty.
type Target struct {
	Channel   string `json:"channel"`
	Transport string `json:"transport"`
	Parent    string `json:"parent,omitempty"`
}

// Step is one immutable action inside a Sequence.
type Step struct {
	Kind            StepKind         `json:"kind"`
	Payload         []byte           `json:"payload,omitempty"`
	Mode            script.MatchMode `json:"mode,omitempty"`
	Pattern         string           `json:"pattern,omitempty"`
	DelayMs         int              `json:"delayMs,omitempty"`
	TimeoutMs       int              `json:"timeoutMs,omitempty"`
	ContinueOnError bool             `json:"continueOnError,omitempty"`
}

// RunSpec is one request to execute a Sequence. Repeat <= 0 means once.
// Continuous requires IntervalMs > 0 so an unbounded run cannot spin.
type RunSpec struct {
	Name       string `json:"name"`
	Target     Target `json:"target"`
	Steps      []Step `json:"steps"`
	Repeat     int    `json:"repeat,omitempty"`
	IntervalMs int    `json:"intervalMs,omitempty"`
	Continuous bool   `json:"continuous,omitempty"`
}

// RunInfo is an immutable snapshot of one Run.
type RunInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Channel      string   `json:"channel"`
	State        RunState `json:"state"`
	CurrentStep  int      `json:"currentStep"`
	CreatedAtMs  int64    `json:"createdAtMs"`
	StartedAtMs  int64    `json:"startedAtMs,omitempty"`
	FinishedAtMs int64    `json:"finishedAtMs,omitempty"`
	Sent         int      `json:"sent"`
	BytesSent    int64    `json:"bytesSent"`
	Matched      int      `json:"matched"`
	Error        string   `json:"error,omitempty"`
}

// Event is an ordered, immutable projection of Run progress.
type Event struct {
	Run       RunInfo  `json:"run"`
	Kind      string   `json:"kind"` // state | step | io
	Phase     string   `json:"phase,omitempty"`
	StepID    string   `json:"stepId,omitempty"`
	Step      int      `json:"step,omitempty"`
	Action    StepKind `json:"action,omitempty"`
	Direction string   `json:"direction,omitempty"`
	Payload   []byte   `json:"payload,omitempty"`
	TsMillis  int64    `json:"tsMillis"`
	LatencyMs int64    `json:"latencyMs,omitempty"`
	Message   string   `json:"message,omitempty"`
}

// Sender is the only transport dependency of the automation engine.
type Sender interface {
	Send(target Target, payload []byte) error
}

func normalizeSpec(spec RunSpec) (RunSpec, error) {
	spec.Name = strings.TrimSpace(spec.Name)
	if spec.Target.Channel == "" {
		return RunSpec{}, errors.New("automation: target channel is empty")
	}
	if spec.Target.Transport == "" {
		return RunSpec{}, errors.New("automation: target transport is empty")
	}
	if len(spec.Steps) == 0 {
		return RunSpec{}, errors.New("automation: sequence has no steps")
	}
	if len(spec.Steps) > maxSteps {
		return RunSpec{}, fmt.Errorf("automation: sequence exceeds %d steps", maxSteps)
	}
	if spec.Repeat < 0 || spec.Repeat > maxRepeat {
		return RunSpec{}, fmt.Errorf("automation: repeat must be 0-%d", maxRepeat)
	}
	if spec.IntervalMs < 0 || spec.IntervalMs > maxWaitMs {
		return RunSpec{}, fmt.Errorf("automation: interval must be 0-%d ms", maxWaitMs)
	}
	if spec.Continuous && spec.IntervalMs == 0 {
		return RunSpec{}, errors.New("automation: continuous runs require an interval")
	}
	if spec.Repeat <= 1 {
		spec.Repeat = 1
	}

	steps := make([]Step, len(spec.Steps))
	for i, step := range spec.Steps {
		step.Payload = append([]byte(nil), step.Payload...)
		switch step.Kind {
		case StepSend:
			if len(step.Payload) == 0 {
				return RunSpec{}, fmt.Errorf("automation: step %d send payload is empty", i+1)
			}
			if len(step.Payload) > maxPayload {
				return RunSpec{}, fmt.Errorf("automation: step %d payload exceeds %d bytes", i+1, maxPayload)
			}
		case StepDelay:
			if step.DelayMs < 0 || step.DelayMs > maxWaitMs {
				return RunSpec{}, fmt.Errorf("automation: step %d delay must be 0-%d ms", i+1, maxWaitMs)
			}
		case StepExpect:
			if step.TimeoutMs == 0 {
				step.TimeoutMs = defaultMatch
			}
			if step.TimeoutMs < 1 || step.TimeoutMs > maxWaitMs {
				return RunSpec{}, fmt.Errorf("automation: step %d timeout must be 1-%d ms", i+1, maxWaitMs)
			}
			if err := script.ValidatePattern(step.Pattern, step.Mode); err != nil {
				return RunSpec{}, fmt.Errorf("automation: step %d matcher: %w", i+1, err)
			}
		default:
			return RunSpec{}, fmt.Errorf("automation: step %d has unknown kind %q", i+1, step.Kind)
		}
		steps[i] = step
	}
	spec.Steps = steps
	return spec, nil
}

func terminal(state RunState) bool {
	return state == StateCompleted ||
		state == StateFailed ||
		state == StateTimedOut ||
		state == StateCancelled
}
