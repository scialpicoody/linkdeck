package stream

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"linkdeck/internal/framing"
	"linkdeck/internal/script"
)

func newDelim(t *testing.T) framing.Framer {
	t.Helper()
	f, err := framing.NewDelimiter(framing.DelimiterConfig{Delimiter: []byte("\n")})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// scriptSource replays scripted chunks, then blocks until closed so the
// read loop parks without spinning.
type scriptSource struct {
	chunks   [][]byte
	at       int
	mu       sync.Mutex
	reads    atomic.Int64
	unblock  chan struct{}
	errAfter error
}

// oneErrorFramer returns a valid frame alongside one checksum failure, then
// stays quiet. It exercises the Feed "frames + error" contract.
type oneErrorFramer struct{ sent bool }

func (f *oneErrorFramer) Feed([]byte) ([][]byte, error) {
	if f.sent {
		return nil, nil
	}
	f.sent = true
	return [][]byte{[]byte("valid")}, framing.ErrChecksum
}

func (*oneErrorFramer) Reset() {}

func (s *scriptSource) Read(maxLen int) ([]byte, error) {
	s.reads.Add(1)
	s.mu.Lock()
	if s.at < len(s.chunks) {
		c := s.chunks[s.at]
		s.at++
		s.mu.Unlock()
		if len(c) > maxLen {
			c = c[:maxLen]
		}
		return append([]byte(nil), c...), nil
	}
	err := s.errAfter
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case <-s.unblock:
		return nil, errors.New("stream test: source closed")
	case <-time.After(5 * time.Millisecond):
		return nil, nil // no-op poll: the loop retries
	}
}
func collectBatches() (*sync.Mutex, *[]Batch, Emit) {
	var mu sync.Mutex
	var out []Batch
	emit := func(b Batch) {
		mu.Lock()
		out = append(out, b)
		mu.Unlock()
	}
	return &mu, &out, emit
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// Half frames buffer until complete; sticky frames from one Feed arrive in
// one batch; matched frames wake waiters only and never reach Emit.
func TestHalfStickyAndMatcherFirst(t *testing.T) {
	pool := script.NewPool()
	defer pool.Close()
	mu, out, emit := collectBatches()
	m := NewManager(pool, emit)
	defer m.Close()

	reg, err := pool.Register("WAKE", script.ModePrefix, 3000)
	if err != nil {
		t.Fatal(err)
	}

	src := &scriptSource{
		chunks: [][]byte{
			[]byte("hel"),           // half frame: nothing yet
			[]byte("lo\nWAKE"),      // completes "hello", leaves half "WAKE"
			[]byte(" me\nsecond\n"), // completes "WAKE me" (matched) + "second"
		},
		unblock: make(chan struct{}),
	}
	if err := m.Start("ch1", src, newDelim(t)); err != nil {
		t.Fatal(err)
	}

	frame, err := pool.Await(reg)
	if err != nil {
		t.Fatalf("matcher never woke: %v", err)
	}
	if string(frame.Payload) != "WAKE me" {
		t.Fatalf("matched payload = %q, want %q", frame.Payload, "WAKE me")
	}

	waitFor(t, "2 unmatched batches", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(*out) == 2
	})

	mu.Lock()
	defer mu.Unlock()
	if got := string((*out)[0].Frames[0].Payload); got != "hello" {
		t.Fatalf("batch[0] = %q, want hello", got)
	}
	if got := string((*out)[1].Frames[0].Payload); got != "second" {
		t.Fatalf("batch[1] = %q, want second", got)
	}
	for _, b := range *out {
		for _, f := range b.Frames {
			if string(f.Payload) == "WAKE me" {
				t.Fatalf("matched frame leaked into Emit batch")
			}
			if f.Channel != "ch1" || f.Dir != script.DirRx {
				t.Fatalf("bad frame metadata: %+v", f)
			}
		}
	}
	close(src.unblock) // release the parked read loop before m.Close()
}

// Full queue drops the oldest batch and counts per evicted channel.
func TestOverflowDropsOldest(t *testing.T) {
	pool := script.NewPool()
	defer pool.Close()
	release := make(chan struct{})
	var mu sync.Mutex
	var got []Batch
	first := make(chan struct{}, 1)
	emit := func(b Batch) {
		select {
		case first <- struct{}{}:
		default:
		}
		<-release // block dispatcher on the first batch
		mu.Lock()
		got = append(got, b)
		mu.Unlock()
	}
	m := NewManager(pool, emit)
	defer m.Close()

	const chunks = QueueDepth + 50
	scripted := make([][]byte, 0, chunks)
	for range chunks {
		scripted = append(scripted, []byte("f\n"))
	}
	src := &scriptSource{chunks: scripted, unblock: make(chan struct{})}
	if err := m.Start("flood", src, newDelim(t)); err != nil {
		t.Fatal(err)
	}

	// Dispatcher is parked on the first batch; the loop keeps enqueueing
	// until the queue saturates and evictions start.
	waitFor(t, "drops to accumulate", func() bool { return m.Dropped("flood") >= 10 })

	close(release) // let the dispatcher drain
	waitFor(t, "drain", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(got)+int(m.Dropped("flood")) >= chunks
	})

	mu.Lock()
	defer mu.Unlock()
	if total := len(got) + int(m.Dropped("flood")); total != chunks {
		t.Fatalf("emitted(%d)+dropped(%d) = %d, want %d", len(got), m.Dropped("flood"), total, chunks)
	}
	if other := m.Dropped("quiet"); other != 0 {
		t.Fatalf("idle channel dropped = %d, want 0", other)
	}
	close(src.unblock) // release the parked read loop before m.Close()
}

// Stop cancels the loop: reads cease after Stop returns.
func TestCloseStopsLoop(t *testing.T) {
	pool := script.NewPool()
	defer pool.Close()
	_, _, emit := collectBatches()
	m := NewManager(pool, emit)
	defer m.Close()

	src := &scriptSource{unblock: make(chan struct{}), errAfter: errors.New("boom")}
	if err := m.Start("s1", src, newDelim(t)); err != nil {
		t.Fatal(err)
	}
	if err := m.Start("s1", src, newDelim(t)); err == nil {
		t.Fatalf("double Start succeeded, want error")
	}
	waitFor(t, "reads to start", func() bool { return src.reads.Load() > 0 })
	m.Stop("s1")
	n := src.reads.Load()
	time.Sleep(50 * time.Millisecond)
	if after := src.reads.Load(); after != n {
		t.Fatalf("reads continued after Stop: %d -> %d", n, after)
	}
	// Restart after Stop works with a fresh framer.
	src2 := &scriptSource{chunks: [][]byte{[]byte("ok\n")}, unblock: make(chan struct{})}
	if err := m.Start("s1", src2, newDelim(t)); err != nil {
		t.Fatalf("restart after Stop: %v", err)
	}
	close(src2.unblock) // release the parked read loop before m.Close()
}

// Reset clears half-frame residue while pending matchers survive.
func TestResetKeepsMatchers(t *testing.T) {
	pool := script.NewPool()
	defer pool.Close()
	mu, out, emit := collectBatches()
	m := NewManager(pool, emit)
	defer m.Close()

	reg, err := pool.Register("AB", script.ModePrefix, 3000)
	if err != nil {
		t.Fatal(err)
	}
	src := &scriptSource{
		chunks:  [][]byte{[]byte("half-")}, // buffered residue, no frame yet
		unblock: make(chan struct{}),
	}
	if err := m.Start("r1", src, newDelim(t)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "residue to buffer", func() bool { return src.reads.Load() > 0 })
	time.Sleep(20 * time.Millisecond)

	m.Reset("r1") // reconnect: residue gone, matcher kept
	m.Reset("missing")

	src.mu.Lock()
	src.chunks = append(src.chunks, []byte("AB\n"))
	src.mu.Unlock()

	frame, err := pool.Await(reg)
	if err != nil {
		t.Fatalf("matcher lost across Reset: %v", err)
	}
	if string(frame.Payload) != "AB" {
		t.Fatalf("payload = %q, want AB (stale residue must be gone)", frame.Payload)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, b := range *out {
		for _, f := range b.Frames {
			if string(f.Payload) == "half-AB" {
				t.Fatalf("stale residue survived Reset")
			}
		}
	}
	close(src.unblock) // release the parked read loop before m.Close()
}

func TestFramingErrorReportedWithoutLosingFrames(t *testing.T) {
	pool := script.NewPool()
	defer pool.Close()
	mu, out, emit := collectBatches()
	m := NewManager(pool, emit)
	defer m.Close()

	errors := make(chan FramingError, 1)
	m.SetFramingErrorHandler(func(err FramingError) { errors <- err })

	src := &scriptSource{
		chunks:  [][]byte{[]byte("payload")},
		unblock: make(chan struct{}),
	}
	if err := m.Start("bad", src, &oneErrorFramer{}); err != nil {
		t.Fatal(err)
	}

	var reported FramingError
	select {
	case reported = <-errors:
	case <-time.After(3 * time.Second):
		t.Fatal("framing error was not reported")
	}
	if reported.Channel != "bad" || reported.Kind != "checksum" || reported.Checksum != 1 {
		t.Fatalf("unexpected framing error: %+v", reported)
	}
	if got := m.FramingErrors("bad"); got.Checksum != 1 || got.Oversize != 0 {
		t.Fatalf("unexpected counters: %+v", got)
	}

	waitFor(t, "valid frame after framing error", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(*out) == 1 && len((*out)[0].Frames) == 1
	})
	mu.Lock()
	got := string((*out)[0].Frames[0].Payload)
	mu.Unlock()
	if got != "valid" {
		t.Fatalf("payload = %q, want valid", got)
	}
	close(src.unblock)
}

func TestTerminalSourceReleasesChannelSlot(t *testing.T) {
	pool := script.NewPool()
	defer pool.Close()
	m := NewManager(pool, nil)
	defer m.Close()

	src := &scriptSource{errAfter: ErrSourceClosed, unblock: make(chan struct{})}
	if err := m.Start("peer", src, newDelim(t)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "terminal source cleanup", func() bool {
		m.chMu.Lock()
		defer m.chMu.Unlock()
		_, exists := m.channels["peer"]
		return !exists
	})

	// The same backend id can be reused after a terminal peer closes.
	src2 := &scriptSource{unblock: make(chan struct{})}
	defer close(src2.unblock)
	if err := m.Start("peer", src2, newDelim(t)); err != nil {
		t.Fatalf("reuse channel slot: %v", err)
	}
}
