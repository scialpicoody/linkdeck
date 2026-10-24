package script

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yuin/gopher-lua/pm"
)

// MatchMode selects the match language for one expectation. Locked ticket
// #4 surface: prefix (default), regex, pattern (Lua patterns).
type MatchMode string

// Match modes.
const (
	ModePrefix  MatchMode = "prefix"
	ModeRegex   MatchMode = "regex"
	ModePattern MatchMode = "pattern"
)

// DefaultExpectTimeoutMs applies when expect/send_expect omit timeout_ms.
const DefaultExpectTimeoutMs = 1000

// ParseMatchMode maps the Lua mode field to a MatchMode. Empty means the
// locked default, prefix.
func ParseMatchMode(s string) (MatchMode, error) {
	switch s {
	case "", string(ModePrefix):
		return ModePrefix, nil
	case string(ModeRegex):
		return ModeRegex, nil
	case string(ModePattern):
		return ModePattern, nil
	default:
		return "", fmt.Errorf("unknown match mode %q: want prefix, regex or pattern", s)
	}
}

// Registration is one pending expectation: a pattern plus timeout waiting
// for a frame. The engine creates them via Pool.Register and resolves them
// via Pool.Feed/Pool.Await; direct construction is not needed.
type Registration struct {
	id       uint64
	channel  string
	pattern  string
	mode     MatchMode
	re       *regexp.Regexp
	deadline time.Time
	ch       chan Frame // buffered 1: the delivered frame
	fired    atomic.Bool
}

// Matches reports whether payload satisfies the registration's pattern.
func (r *Registration) Matches(payload []byte) bool {
	switch r.mode {
	case ModeRegex:
		return r.re.Match(payload)
	case ModePattern:
		mds, err := pm.Find(r.pattern, payload, 0, 1)
		if err != nil {
			return false // validated at Register; never match on surprise errors
		}
		return len(mds) > 0
	default: // ModePrefix
		return bytes.HasPrefix(payload, []byte(r.pattern))
	}
}

func (r *Registration) accepts(frame Frame) bool {
	return (r.channel == "" || r.channel == frame.Channel) && r.Matches(frame.Payload)
}

// compilePattern validates pattern for mode, returning the compiled regex
// for ModeRegex. Prefix needs no compilation; Lua patterns are probed with
// a one-byte input so malformed expressions fail here instead of silently
// never matching.
func compilePattern(pattern string, mode MatchMode) (*regexp.Regexp, error) {
	switch mode {
	case ModeRegex:
		re, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("bad regex pattern: %w", err)
		}
		return re, nil
	case ModePattern:
		if _, err := pm.Find(pattern, []byte{0}, 0, 1); err != nil {
			return nil, fmt.Errorf("bad Lua pattern: %w", err)
		}
		return nil, nil
	default:
		return nil, nil
	}
}

// ValidatePattern eagerly checks a matcher without registering it or
// consuming a backlog frame. Callers that preflight larger programs use this
// so invalid expectations fail before any side effects occur.
func ValidatePattern(pattern string, mode MatchMode) error {
	if _, err := ParseMatchMode(string(mode)); err != nil {
		return err
	}
	_, err := compilePattern(pattern, mode)
	return err
}

// validate compiles the pattern eagerly so bad expressions fail at
// Register instead of silently never matching.
func (r *Registration) validate() error {
	re, err := compilePattern(r.pattern, r.mode)
	if err != nil {
		return err
	}
	r.re = re
	return nil
}

// Pool is the matcher pool: expectations register, frames feed through in
// registration order, and a background sweep expires timed-out
// registrations. All methods are safe for concurrent use.
//
// Semantics (locked ticket #4): first registered, first matched; a new
// registration scans the backlog before waiting for new frames; frames that
// match nothing are kept in a capped backlog and routed to the unmatched
// handler (nil by default: kept only).
type Pool struct {
	mu          sync.Mutex
	regs        []*Registration
	backlog     []Frame
	maxBacklog  int
	onUnmatched func(Frame)

	sweepEvery time.Duration
	done       chan struct{}
	stopOnce   sync.Once
	nextID     uint64
}

// NewPool returns a Pool with a 1024-frame backlog cap and a 10ms timeout
// sweep. Close stops the sweep.
func NewPool() *Pool {
	p := &Pool{
		maxBacklog: 1024,
		sweepEvery: 10 * time.Millisecond,
		done:       make(chan struct{}),
	}
	go p.sweepLoop()
	return p
}

// SetUnmatchedHandler routes frames that match no registration. The engine
// points it at CLI output. The handler runs without the pool lock and must
// never re-enter the pool or the Lua state.
func (p *Pool) SetUnmatchedHandler(fn func(Frame)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onUnmatched = fn
}

// SetMaxBacklog caps retained unmatched frames; oldest drop first. Values
// below 1 mean 1.
func (p *Pool) SetMaxBacklog(n int) {
	if n < 1 {
		n = 1
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.maxBacklog = n
	if len(p.backlog) > n {
		p.backlog = append([]Frame(nil), p.backlog[len(p.backlog)-n:]...)
	}
}

// Register adds an expectation and returns it. A backlog scan runs first:
// when a retained frame matches, it is consumed from the backlog and
// delivered straight into the registration, so the caller's Await returns
// immediately. timeoutMs <= 0 means backlog-scan only (no waiting).
func (p *Pool) Register(pattern string, mode MatchMode, timeoutMs int) (*Registration, error) {
	return p.RegisterOn("", pattern, mode, timeoutMs)
}

// RegisterOn adds an expectation scoped to channel. Empty channel preserves
// the global behavior of Register. A matching frame from another channel can
// never consume this registration.
func (p *Pool) RegisterOn(
	channel string,
	pattern string,
	mode MatchMode,
	timeoutMs int,
) (*Registration, error) {
	if _, err := ParseMatchMode(string(mode)); err != nil {
		return nil, err
	}
	reg := &Registration{
		channel:  channel,
		pattern:  pattern,
		mode:     mode,
		deadline: time.Now().Add(time.Duration(timeoutMs) * time.Millisecond),
		ch:       make(chan Frame, 1),
	}
	if err := reg.validate(); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nextID++
	reg.id = p.nextID
	for i, f := range p.backlog {
		if reg.accepts(f) {
			p.backlog = append(p.backlog[:i:i], p.backlog[i+1:]...)
			reg.ch <- f
			reg.fired.Store(true)
			return reg, nil
		}
	}
	p.regs = append(p.regs, reg)
	return reg, nil
}

// Feed offers one frame to registrations in registration order. The first
// live registration whose pattern matches consumes it and its awaiter
// wakes; otherwise the frame joins the backlog (and the unmatched handler,
// when set). It reports whether something matched.
func (p *Pool) Feed(frame Frame) bool {
	p.mu.Lock()
	for i, reg := range p.regs {
		if reg.fired.Load() {
			continue
		}
		if reg.accepts(frame) {
			p.regs = append(p.regs[:i:i], p.regs[i+1:]...)
			reg.fired.Store(true)
			reg.ch <- frame
			p.mu.Unlock()
			return true
		}
	}
	p.backlog = append(p.backlog, frame)
	if len(p.backlog) > p.maxBacklog {
		p.backlog = append([]Frame(nil), p.backlog[len(p.backlog)-p.maxBacklog:]...)
	}
	fn := p.onUnmatched
	p.mu.Unlock()
	if fn != nil {
		fn(frame)
	}
	return false
}

// Await blocks until the registration's frame arrives, its deadline
// passes (ErrTimeout), or the pool closes (ErrClosed). A backlog hit at
// Register resolves on the first call.
func (p *Pool) Await(reg *Registration) (Frame, error) {
	return p.AwaitContext(context.Background(), reg)
}

// AwaitContext blocks until the registration resolves, expires, the pool
// closes, or ctx is cancelled. Cancellation removes a pending registration
// immediately and returns ctx.Err().
func (p *Pool) AwaitContext(ctx context.Context, reg *Registration) (Frame, error) {
	var timer *time.Timer
	var timerCh <-chan time.Time
	if wait := time.Until(reg.deadline); wait > 0 {
		timer = time.NewTimer(wait)
		timerCh = timer.C
		defer timer.Stop()
	} else {
		expired := make(chan time.Time)
		close(expired)
		timerCh = expired
	}
	select {
	case f := <-reg.ch:
		return f, nil
	case <-ctx.Done():
		p.cancel(reg)
		return Frame{}, ctx.Err()
	case <-timerCh:
		select {
		case f := <-reg.ch:
			return f, nil
		default:
		}
		p.cancel(reg)
		return Frame{}, ErrTimeout
	case <-p.done:
		return Frame{}, ErrClosed
	}
}

// cancel removes a registration without delivering. It reports whether the
// registration was still pending.
func (p *Pool) cancel(reg *Registration) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, r := range p.regs {
		if r == reg {
			p.regs = append(p.regs[:i:i], p.regs[i+1:]...)
			reg.fired.Store(true)
			return true
		}
	}
	return false
}

// Cancel abandons a registration (late senders keep their frames via the
// backlog path on Feed). Engine calls it whenever an expect/send_expect
// leaves through an error path.
func (p *Pool) Cancel(reg *Registration) {
	p.cancel(reg)
}

// Pending reports live registrations; BacklogLen reports retained frames.
func (p *Pool) Pending() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.regs)
}

// BacklogLen reports retained unmatched frames.
func (p *Pool) BacklogLen() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.backlog)
}

// Close stops the timeout sweep and unblocks Await callers with ErrClosed.
func (p *Pool) Close() {
	p.stopOnce.Do(func() { close(p.done) })
}

func (p *Pool) sweepLoop() {
	t := time.NewTicker(p.sweepEvery)
	defer t.Stop()
	for {
		select {
		case <-p.done:
			return
		case now := <-t.C:
			p.mu.Lock()
			kept := p.regs[:0]
			for _, reg := range p.regs {
				if !now.Before(reg.deadline) {
					reg.fired.Store(true)
					continue
				}
				kept = append(kept, reg)
			}
			for i := len(kept); i < len(p.regs); i++ {
				p.regs[i] = nil
			}
			p.regs = kept
			p.mu.Unlock()
		}
	}
}
