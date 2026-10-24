// Package stream owns LinkDeck's RX data path (ticket #11): per-channel
// read goroutines turn transport byte streams into unmatched-frame batches.
//
// Data flow per channel: transport bytes → framing.Framer (half/sticky
// handling) → script.Pool match call (matcher-first: matched frames wake
// waiters ONLY and never reach the UI) → unmatched frames batched per Feed
// into one Batch → Emit.
//
// Backpressure: the outbound queue holds 256 batches; when full the oldest
// batch is dropped and a per-channel dropped counter increments (see
// Dropped). The read loop never blocks, so floods cannot wedge
// close/reconnect.
//
// Lifetime: one read goroutine per open channel, context-cancelled on
// Stop/Close. Reset clears framer residue on reconnect and keeps pending
// matchers (the pool is owned by the caller, never touched here).
//
// Framers are confined to their channel's goroutine; Reset synchronizes
// against Feed through a per-channel mutex.
package stream

import (
	"context"
	"errors"
	"sync"
	"time"

	"linkdeck/internal/framing"
	"linkdeck/internal/script"
)

// QueueDepth bounds the outbound batch queue. Full → drop oldest batch.
const QueueDepth = 256

// readMaxLen bounds one transport read so a misbehaving source cannot
// force a huge allocation per iteration.
const readMaxLen = 4096

// Batch is one outbound event: every unmatched frame from a single Feed,
// in wire order. Payloads are raw bytes in Go; over mygo bindings each
// frame crosses as {channel, dir, payloadBase64, tsMillis} (script.Frame
// DTO shape, matching the frontend JSON-lines row shape).
type Batch struct {
	Channel string
	Frames  []script.Frame
}

// FramingError is one non-fatal decode failure. Counts are cumulative for the
// channel, so the UI can update a status indicator without reconstructing
// state from a lossy event stream.
type FramingError struct {
	Channel  string `json:"channel"`
	Kind     string `json:"kind"`
	Message  string `json:"message"`
	Oversize uint64 `json:"oversize"`
	Checksum uint64 `json:"checksum"`
	Other    uint64 `json:"other"`
	TsMillis int64  `json:"tsMillis"`
}

// FramingErrorCounts is the cumulative per-channel failure set.
type FramingErrorCounts struct {
	Oversize uint64
	Checksum uint64
	Other    uint64
}

// Emit receives outbound batches. It runs on the Manager's dispatcher
// goroutine and MUST NOT block indefinitely; the integrator connects it to
// the mygo event. A nil Emit discards batches (queue accounting still
// applies).
type Emit func(Batch)

// Source is one channel's byte supplier: the bound service adapts its
// transport (serial Port, TCP client/conn) to it. Read returns up to
// maxLen bytes; an empty slice with a nil error is a no-op poll.
type Source interface {
	Read(maxLen int) ([]byte, error)
}

type channelState struct {
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	mu       sync.Mutex // guards framer across Feed (loop) and Reset (reconnect)
	framer   framing.Framer
	stopped  chan struct{}
	stopOnce sync.Once
}

func (s *channelState) finish() { s.stopOnce.Do(func() { close(s.stopped) }) }

// Manager fans per-channel byte streams into unmatched-frame batches.
// Safe for concurrent use. The matcher pool is owned by the caller and is
// never closed or cleared here, so reconnects keep pending matchers.
type Manager struct {
	pool *script.Pool
	emit Emit

	chMu     sync.Mutex
	channels map[string]*channelState

	qMu     sync.Mutex
	queue   []Batch
	dropped map[string]uint64
	notify  chan struct{}

	errMu      sync.Mutex
	framingErr map[string]FramingErrorCounts
	onFraming  func(FramingError)

	ctx    context.Context
	cancel context.CancelFunc
	dispWg sync.WaitGroup
}

// NewManager returns a Manager feeding frames through pool and publishing
// batches to emit. A nil pool gets a private one; a nil emit discards.
func NewManager(pool *script.Pool, emit Emit) *Manager {
	if pool == nil {
		pool = script.NewPool()
	}
	m := &Manager{
		pool:       pool,
		emit:       emit,
		channels:   make(map[string]*channelState),
		dropped:    make(map[string]uint64),
		framingErr: make(map[string]FramingErrorCounts),
		notify:     make(chan struct{}, 1),
	}
	m.ctx, m.cancel = context.WithCancel(context.Background())
	m.dispWg.Add(1)
	go m.dispatchLoop()
	return m
}

// SetFramingErrorHandler installs the non-fatal framing failure sink. The
// handler is called on the affected channel's read loop and must not block.
func (m *Manager) SetFramingErrorHandler(fn func(FramingError)) {
	m.errMu.Lock()
	m.onFraming = fn
	m.errMu.Unlock()
}

// Start begins the read loop for channel. It reports an error when the
// channel is already started or the Manager is closed. The loop owns
// framer until Stop; Reset is the only sanctioned cross-goroutine touch.
func (m *Manager) Start(channel string, src Source, framer framing.Framer) error {
	if channel == "" {
		return errEmptyChannel
	}
	if src == nil || framer == nil {
		return errNilSource
	}
	m.chMu.Lock()
	defer m.chMu.Unlock()
	select {
	case <-m.ctx.Done():
		return errClosedManager
	default:
	}
	if _, dup := m.channels[channel]; dup {
		return &dupError{channel}
	}
	ctx, cancel := context.WithCancel(m.ctx)
	st := &channelState{cancel: cancel, framer: framer, stopped: make(chan struct{})}
	st.wg.Add(1)
	m.channels[channel] = st
	go m.runLoop(ctx, channel, src, st)
	return nil
}

// Stop cancels channel's read loop and waits for it to exit. Unknown
// channels are a no-op. The framer is discarded with the loop.
//
// Stop waits for an in-flight Source.Read to return: it cannot interrupt a
// blocking Read. Service Close paths MUST close the transport first (which
// fails the pending Read) and then call Stop.
func (m *Manager) Stop(channel string) {
	m.chMu.Lock()
	st, ok := m.channels[channel]
	if ok {
		delete(m.channels, channel)
	}
	m.chMu.Unlock()
	if !ok {
		return
	}
	st.cancel()
	st.wg.Wait()
	st.finish()
}

// Reset discards channel's buffered half-frame residue after a reconnect.
// Pending matchers are untouched (the pool lives outside this package).
// Unknown channels are a no-op.
func (m *Manager) Reset(channel string) {
	m.chMu.Lock()
	st, ok := m.channels[channel]
	m.chMu.Unlock()
	if !ok {
		return
	}
	st.mu.Lock()
	st.framer.Reset()
	st.mu.Unlock()
}

// Resetter returns a func resetting channel's framer residue, for use as
// a reconnect hook (see tcp.Client.SetReconnectHook). Matchers survive.
func (m *Manager) Resetter(channel string) func() {
	return func() { m.Reset(channel) }
}

// Dropped reports how many queued batches for channel were evicted by
// newer batches while the queue was full. The counter keys on the evicted
// batch's channel: a flood on one channel never inflates another's count.
func (m *Manager) Dropped(channel string) uint64 {
	m.qMu.Lock()
	defer m.qMu.Unlock()
	return m.dropped[channel]
}

// FramingErrors reports cumulative oversize/checksum/other failures for a
// channel.
func (m *Manager) FramingErrors(channel string) FramingErrorCounts {
	m.errMu.Lock()
	defer m.errMu.Unlock()
	return m.framingErr[channel]
}

// Close stops every read loop and the dispatcher, draining nothing: queued
// batches that Emit never consumed are discarded. Idempotent. Like Stop it
// waits for in-flight Reads; unblock or close sources first (closing a
// parked test source's unblock channel is enough).
func (m *Manager) Close() {
	m.cancel()
	m.chMu.Lock()
	states := make([]*channelState, 0, len(m.channels))
	for name, st := range m.channels {
		delete(m.channels, name)
		st.cancel()
		states = append(states, st)
	}
	m.chMu.Unlock()
	for _, st := range states {
		st.wg.Wait()
		st.finish()
	}
	m.dispWg.Wait()
}
func (m *Manager) runLoop(ctx context.Context, channel string, src Source, st *channelState) {
	defer st.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		chunk, err := src.Read(readMaxLen)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Millisecond):
			}
			continue
		}
		if len(chunk) == 0 {
			continue
		}
		// Feed may return frames alongside a non-nil error (oversize /
		// checksum): frames decoded before the error are still valid and
		// MUST be processed.
		st.mu.Lock()
		frames, ferr := st.framer.Feed(chunk)
		st.mu.Unlock()
		if ferr != nil {
			m.reportFramingError(channel, ferr)
		}
		if len(frames) == 0 {
			continue
		}
		unmatched := make([]script.Frame, 0, len(frames))
		for _, payload := range frames {
			f := script.NewRxFrame(channel, payload)
			if !m.pool.Feed(f) {
				unmatched = append(unmatched, f)
			}
		}
		if len(unmatched) > 0 {
			m.enqueue(Batch{Channel: channel, Frames: unmatched})
		}
	}
}

func (m *Manager) reportFramingError(channel string, err error) {
	kind := "other"
	m.errMu.Lock()
	counts := m.framingErr[channel]
	switch {
	case errors.Is(err, framing.ErrOversize):
		kind = "oversize"
		counts.Oversize++
	case errors.Is(err, framing.ErrChecksum):
		kind = "checksum"
		counts.Checksum++
	default:
		counts.Other++
	}
	m.framingErr[channel] = counts
	handler := m.onFraming
	m.errMu.Unlock()
	if handler == nil {
		return
	}
	handler(FramingError{
		Channel:  channel,
		Kind:     kind,
		Message:  err.Error(),
		Oversize: counts.Oversize,
		Checksum: counts.Checksum,
		Other:    counts.Other,
		TsMillis: time.Now().UnixMilli(),
	})
}

func (m *Manager) enqueue(b Batch) {
	m.qMu.Lock()
	if len(m.queue) >= QueueDepth {
		evicted := m.queue[0]
		var zero Batch
		m.queue[0] = zero
		m.queue = m.queue[1:]
		m.dropped[evicted.Channel]++
	}
	m.queue = append(m.queue, b)
	m.qMu.Unlock()
	select {
	case m.notify <- struct{}{}:
	default:
	}
}

func (m *Manager) dispatchLoop() {
	defer m.dispWg.Done()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-m.notify:
		}
		for {
			m.qMu.Lock()
			if len(m.queue) == 0 {
				m.qMu.Unlock()
				break
			}
			b := m.queue[0]
			var zero Batch
			m.queue[0] = zero
			m.queue = m.queue[1:]
			emit := m.emit
			m.qMu.Unlock()
			if emit != nil {
				emit(b)
			}
		}
	}
}
