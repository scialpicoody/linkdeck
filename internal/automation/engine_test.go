package automation

import (
	"errors"
	"sync"
	"testing"
	"time"

	"linkdeck/internal/script"
)

type fakeSender struct {
	mu    sync.Mutex
	sends [][]byte
	err   error
}

func (s *fakeSender) Send(_ Target, payload []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.sends = append(s.sends, append([]byte(nil), payload...))
	return nil
}

func (s *fakeSender) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sends)
}

type eventLog struct {
	mu     sync.Mutex
	events []Event
}

func (l *eventLog) add(event Event) {
	l.mu.Lock()
	l.events = append(l.events, event)
	l.mu.Unlock()
}

func (l *eventLog) snapshot() []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]Event(nil), l.events...)
}

func waitFor(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func waitState(t *testing.T, engine *Engine, id string, state RunState) RunInfo {
	t.Helper()
	var info RunInfo
	waitFor(t, "run state "+string(state), func() bool {
		var err error
		info, err = engine.Status(id)
		return err == nil && info.State == state
	})
	return info
}

func target(channel string) Target {
	return Target{Channel: channel, Transport: "serial"}
}

func TestEngineRunsSendExpect(t *testing.T) {
	pool := script.NewPool()
	defer pool.Close()
	sender := &fakeSender{}
	log := &eventLog{}
	engine := NewEngine(Options{Sender: sender, Pool: pool, Emit: log.add})
	defer engine.Close()

	info, err := engine.Start(RunSpec{
		Name:   "probe",
		Target: target("c1"),
		Steps: []Step{
			{Kind: StepSend, Payload: []byte("PING")},
			{Kind: StepExpect, Pattern: "OK", TimeoutMs: 500},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool.Feed(script.NewRxFrame("c1", []byte("OK")))
	done := waitState(t, engine, info.ID, StateCompleted)
	if done.Sent != 1 || done.BytesSent != 4 || done.Matched != 1 {
		t.Fatalf("unexpected run totals: %+v", done)
	}
	if sender.count() != 1 {
		t.Fatalf("sends=%d, want 1", sender.count())
	}

	var sawTX, sawRX bool
	for _, event := range log.snapshot() {
		if event.Kind != "io" {
			continue
		}
		switch event.Direction {
		case "tx":
			sawTX = string(event.Payload) == "PING"
		case "rx":
			sawRX = string(event.Payload) == "OK"
		}
	}
	if !sawTX || !sawRX {
		t.Fatalf("missing TX/RX events: %+v", log.snapshot())
	}
}

func TestEngineCancelsDelayImmediately(t *testing.T) {
	engine := NewEngine(Options{Sender: &fakeSender{}})
	defer engine.Close()
	info, err := engine.Start(RunSpec{
		Target: target("c1"),
		Steps:  []Step{{Kind: StepDelay, DelayMs: 5000}},
	})
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := engine.Cancel(info.ID); err != nil {
		t.Fatal(err)
	}
	waitState(t, engine, info.ID, StateCancelled)
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("cancellation took %v", elapsed)
	}
}

func TestEngineScopesExpectationsByChannel(t *testing.T) {
	pool := script.NewPool()
	defer pool.Close()
	engine := NewEngine(Options{Sender: &fakeSender{}, Pool: pool})
	defer engine.Close()

	first, err := engine.Start(RunSpec{
		Target: target("c1"),
		Steps:  []Step{{Kind: StepExpect, Pattern: "READY", TimeoutMs: 1000}},
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := engine.Start(RunSpec{
		Target: target("c2"),
		Steps:  []Step{{Kind: StepExpect, Pattern: "READY", TimeoutMs: 1000}},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool.Feed(script.NewRxFrame("c2", []byte("READY")))
	waitState(t, engine, second.ID, StateCompleted)
	if got, err := engine.Status(first.ID); err != nil || got.State != StateRunning {
		t.Fatalf("first run state=%+v err=%v, want running", got, err)
	}
	pool.Feed(script.NewRxFrame("c1", []byte("READY")))
	waitState(t, engine, first.ID, StateCompleted)
}

func TestEngineRejectsConcurrentRunOnSameChannel(t *testing.T) {
	engine := NewEngine(Options{Sender: &fakeSender{}})
	defer engine.Close()
	first, err := engine.Start(RunSpec{
		Target: target("c1"),
		Steps:  []Step{{Kind: StepDelay, DelayMs: 1000}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = engine.Start(RunSpec{
		Target: target("c1"),
		Steps:  []Step{{Kind: StepDelay, DelayMs: 1}},
	})
	if !errors.Is(err, ErrChannelBusy) {
		t.Fatalf("second Start: got %v, want ErrChannelBusy", err)
	}
	_, _ = engine.Cancel(first.ID)
	waitState(t, engine, first.ID, StateCancelled)
}

func TestEngineCancelsActiveRunByChannel(t *testing.T) {
	engine := NewEngine(Options{Sender: &fakeSender{}})
	defer engine.Close()
	info, err := engine.Start(RunSpec{
		Target: target("c1"),
		Steps:  []Step{{Kind: StepDelay, DelayMs: 5000}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := engine.CancelChannel("other"); got != 0 {
		t.Fatalf("CancelChannel(other)=%d, want 0", got)
	}
	if got := engine.CancelChannel("c1"); got != 1 {
		t.Fatalf("CancelChannel(c1)=%d, want 1", got)
	}
	waitState(t, engine, info.ID, StateCancelled)
}

func TestEnginePausesAtStepBoundaryAndResumes(t *testing.T) {
	sender := &fakeSender{}
	engine := NewEngine(Options{Sender: sender})
	defer engine.Close()
	info, err := engine.Start(RunSpec{
		Target: target("c1"),
		Steps: []Step{
			{Kind: StepDelay, DelayMs: 30},
			{Kind: StepSend, Payload: []byte("GO")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Pause(info.ID); err != nil {
		t.Fatal(err)
	}
	waitState(t, engine, info.ID, StatePaused)
	time.Sleep(80 * time.Millisecond)
	if sender.count() != 0 {
		t.Fatalf("paused run sent %d payloads", sender.count())
	}
	if _, err := engine.Resume(info.ID); err != nil {
		t.Fatal(err)
	}
	done := waitState(t, engine, info.ID, StateCompleted)
	if sender.count() != 1 || done.Sent != 1 {
		t.Fatalf("resumed run: sends=%d info=%+v", sender.count(), done)
	}
}

func TestEngineRepeatsSequence(t *testing.T) {
	sender := &fakeSender{}
	engine := NewEngine(Options{Sender: sender})
	defer engine.Close()
	info, err := engine.Start(RunSpec{
		Target: target("c1"),
		Steps:  []Step{{Kind: StepSend, Payload: []byte{0x01}}},
		Repeat: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	done := waitState(t, engine, info.ID, StateCompleted)
	if sender.count() != 3 || done.Sent != 3 || done.BytesSent != 3 {
		t.Fatalf("repeat mismatch: sends=%d info=%+v", sender.count(), done)
	}
}

func TestEngineTimesOutExpectation(t *testing.T) {
	engine := NewEngine(Options{Sender: &fakeSender{}})
	defer engine.Close()
	info, err := engine.Start(RunSpec{
		Target: target("c1"),
		Steps:  []Step{{Kind: StepExpect, Pattern: "NEVER", TimeoutMs: 20}},
	})
	if err != nil {
		t.Fatal(err)
	}
	done := waitState(t, engine, info.ID, StateTimedOut)
	if done.Error == "" {
		t.Fatal("timed-out run should retain its timeout error")
	}
}

func TestFailedSendEventRetainsTXPayload(t *testing.T) {
	sender := &fakeSender{err: errors.New("port closed")}
	log := &eventLog{}
	engine := NewEngine(Options{Sender: sender, Emit: log.add})
	defer engine.Close()
	info, err := engine.Start(RunSpec{
		Target: target("c1"),
		Steps:  []Step{{Kind: StepSend, Payload: []byte("PING")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	waitState(t, engine, info.ID, StateFailed)
	waitFor(t, "failed TX event", func() bool {
		for _, event := range log.snapshot() {
			if event.Kind == "step" && event.Phase == "failed" && event.Direction == "tx" {
				return string(event.Payload) == "PING" && event.Message == "port closed"
			}
		}
		return false
	})
}

func TestEngineValidatesBeforeSideEffects(t *testing.T) {
	sender := &fakeSender{}
	engine := NewEngine(Options{Sender: sender})
	defer engine.Close()
	cases := []RunSpec{
		{},
		{Target: target("c1")},
		{
			Target: target("c1"),
			Steps:  []Step{{Kind: StepExpect, Pattern: "([bad", Mode: script.ModeRegex}},
		},
		{
			Target:     target("c1"),
			Steps:      []Step{{Kind: StepSend, Payload: []byte("x")}},
			Continuous: true,
		},
	}
	for _, spec := range cases {
		if _, err := engine.Start(spec); err == nil {
			t.Fatalf("Start(%+v) should fail validation", spec)
		}
	}
	if sender.count() != 0 {
		t.Fatalf("validation sent %d payloads", sender.count())
	}
}
