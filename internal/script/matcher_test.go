package script

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func mustRegister(t *testing.T, p *Pool, pattern string, mode MatchMode, timeoutMs int) *Registration {
	t.Helper()
	reg, err := p.Register(pattern, mode, timeoutMs)
	if err != nil {
		t.Fatalf("Register(%q, %s): %v", pattern, mode, err)
	}
	return reg
}

func TestMatchModes(t *testing.T) {
	p := NewPool()
	defer p.Close()
	cases := []struct {
		mode    MatchMode
		pattern string
		hit     string
		miss    string
	}{
		{ModePrefix, "OK", "OK\r\n", "NOK\r\n"},
		{ModePrefix, "", "anything", ""}, // empty prefix matches all (Go HasPrefix)
		{ModeRegex, `^\+CMT: \d+$`, "+CMT: 123", "+CMT: abc"},
		{ModePattern, "+CMT: %d+", "+CMT: 123 ok", "nope"},
	}
	for _, tc := range cases {
		reg := mustRegister(t, p, tc.pattern, tc.mode, 100)
		if !reg.Matches([]byte(tc.hit)) {
			t.Errorf("mode %s pattern %q: expected match on %q", tc.mode, tc.pattern, tc.hit)
		}
		if tc.miss != "" && reg.Matches([]byte(tc.miss)) {
			t.Errorf("mode %s pattern %q: unexpected match on %q", tc.mode, tc.pattern, tc.miss)
		}
		p.Cancel(reg)
	}
}

func TestDefaultModeIsPrefix(t *testing.T) {
	m, err := ParseMatchMode("")
	if err != nil || m != ModePrefix {
		t.Fatalf("empty mode: got %q, %v; want prefix", m, err)
	}
	for _, bad := range []string{"glob", "PREFIX", "substring"} {
		if _, err := ParseMatchMode(bad); err == nil {
			t.Errorf("mode %q: expected error", bad)
		}
	}
}

func TestRegisterValidation(t *testing.T) {
	p := NewPool()
	defer p.Close()
	if _, err := p.Register("x", "glob", 100); err == nil {
		t.Error("bad mode: expected error")
	}
	if _, err := p.Register("([a-z", ModeRegex, 100); err == nil {
		t.Error("bad regex: expected error")
	}
	if _, err := p.Register("[a", ModePattern, 100); err == nil {
		t.Error("bad Lua pattern: expected error")
	}
	if n := p.Pending(); n != 0 {
		t.Errorf("failed registrations must not linger: pending=%d", n)
	}
}

func TestFeedRegistrationOrder(t *testing.T) {
	p := NewPool()
	defer p.Close()
	first := mustRegister(t, p, "OK", ModePrefix, 1000)
	second := mustRegister(t, p, "OK", ModePrefix, 1000)

	if !p.Feed(NewRxFrame("c", []byte("OK"))) {
		t.Fatal("expected a match")
	}
	select {
	case f := <-first.ch:
		if string(f.Payload) != "OK" {
			t.Fatalf("first got %q", f.Payload)
		}
	default:
		t.Fatal("first registration did not win")
	}
	select {
	case <-second.ch:
		t.Fatal("second registration must not also match")
	default:
	}
	if got := p.Pending(); got != 1 {
		t.Fatalf("pending=%d, want 1", got)
	}
	// The loser stays live and gets the next frame.
	if !p.Feed(NewRxFrame("c", []byte("OK"))) {
		t.Fatal("expected the second registration to match")
	}
	select {
	case <-second.ch:
	default:
		t.Fatal("second registration never resolved")
	}
}

func TestBacklogFirst(t *testing.T) {
	p := NewPool()
	defer p.Close()
	// No registrations: frames backlog.
	p.Feed(NewRxFrame("c", []byte("NOISE")))
	p.Feed(NewRxFrame("c", []byte("READY")))
	if got := p.BacklogLen(); got != 2 {
		t.Fatalf("backlog=%d, want 2", got)
	}
	// A later registration scans the backlog before waiting.
	reg := mustRegister(t, p, "REA", ModePrefix, 50)
	select {
	case f := <-reg.ch:
		if string(f.Payload) != "READY" {
			t.Fatalf("got %q, want READY", f.Payload)
		}
	case <-time.After(time.Second):
		t.Fatal("backlog scan did not resolve")
	}
	if got := p.BacklogLen(); got != 1 {
		t.Fatalf("backlog=%d, want 1 (READY consumed)", got)
	}
	if got := p.Pending(); got != 0 {
		t.Fatalf("pending=%d, want 0 (never queued)", got)
	}
}

func TestAwaitTimeout(t *testing.T) {
	p := NewPool()
	defer p.Close()
	reg := mustRegister(t, p, "NEVER", ModePrefix, 30)
	start := time.Now()
	if _, err := p.Await(reg); !errors.Is(err, ErrTimeout) {
		t.Fatalf("Await: got %v, want ErrTimeout", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("Await took %v", elapsed)
	}
	if got := p.Pending(); got != 0 {
		t.Fatalf("pending=%d after timeout, want 0", got)
	}
}

func TestZeroTimeoutScansBacklogOnly(t *testing.T) {
	p := NewPool()
	defer p.Close()
	p.Feed(NewRxFrame("c", []byte("HELLO")))
	reg := mustRegister(t, p, "HEL", ModePrefix, 0)
	if _, err := p.Await(reg); err != nil {
		t.Fatalf("backlog hit with timeout 0: %v", err)
	}
	miss := mustRegister(t, p, "NOPE", ModePrefix, 0)
	if _, err := p.Await(miss); !errors.Is(err, ErrTimeout) {
		t.Fatalf("miss with timeout 0: got %v, want ErrTimeout", miss)
	}
}

func TestTimeoutSweep(t *testing.T) {
	p := NewPool()
	defer p.Close()
	mustRegister(t, p, "ABANDONED", ModePrefix, 20)
	deadline := time.Now().Add(2 * time.Second)
	for p.Pending() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("sweep never expired the abandoned registration")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestUnmatchedHandlerAndCap(t *testing.T) {
	p := NewPool()
	defer p.Close()
	var mu sync.Mutex
	var routed []Frame
	p.SetUnmatchedHandler(func(f Frame) {
		mu.Lock()
		routed = append(routed, f)
		mu.Unlock()
	})
	p.SetMaxBacklog(2)
	for i := range 5 {
		p.Feed(NewRxFrame("c", []byte(fmt.Sprintf("f%d", i))))
	}
	if got := p.BacklogLen(); got != 2 {
		t.Fatalf("backlog=%d, want capped 2", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(routed) != 5 {
		t.Fatalf("routed=%d, want 5 (every unmatched frame)", len(routed))
	}
	if string(routed[0].Payload) != "f0" {
		t.Fatalf("first routed=%q, want f0", routed[0].Payload)
	}
}

func TestPoolClose(t *testing.T) {
	p := NewPool()
	reg := mustRegister(t, p, "X", ModePrefix, 5000)
	done := make(chan error, 1)
	go func() {
		_, err := p.Await(reg)
		done <- err
	}()
	p.Close()
	select {
	case err := <-done:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("Await after Close: got %v, want ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Await did not unblock on Close")
	}
}

func TestPoolConcurrent(t *testing.T) {
	p := NewPool()
	defer p.Close()
	var wg sync.WaitGroup
	for w := range 4 {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := range 50 {
				reg, err := p.Register(fmt.Sprintf("w%d-%d", w, i), ModePrefix, 5)
				if err != nil {
					t.Error(err)
					return
				}
				p.Feed(NewRxFrame("c", []byte(fmt.Sprintf("w%d-%d!", w, i))))
				_, _ = p.Await(reg)
			}
		}(w)
	}
	p.SetMaxBacklog(64)
	wg.Wait()
}
