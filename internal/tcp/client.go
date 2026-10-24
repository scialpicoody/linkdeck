package tcp

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// ConnState is the client status machine. States:
//
//	connecting    — initial dial in progress.
//	connected     — live connection.
//	reconnecting  — dial failed or the connection dropped; retrying in the
//	                background with exponential backoff + jitter.
//	closed        — Close called, or retries exhausted. Terminal.
type ConnState string

const (
	StateConnecting   ConnState = "connecting"
	StateConnected    ConnState = "connected"
	StateReconnecting ConnState = "reconnecting"
	StateClosed       ConnState = "closed"
)

// errUnconnected is returned by Send/Recv when there is no live connection.
// Send fails fast: it never waits for a reconnect to finish.
var errUnconnected = errors.New("tcp: not connected")

// ClientOptions configures a Client. Zero values take documented defaults.
// MaxRetries counts reconnect attempts after the initial dial fails or a
// live connection drops: 0 (default) means retry forever, N > 0 caps the
// attempts before the client moves to closed. HeartbeatMs <= 0 disables the
// heartbeat; otherwise the client sends HeartbeatPayload every HeartbeatMs
// while connected.
type ClientOptions struct {
	ConnectTimeoutMs int
	MaxRetries       int
	BaseBackoffMs    int
	MaxBackoffMs     int
	HeartbeatMs      int
	HeartbeatPayload []byte
}

// Client is a race-safe reconnecting TCP client. All methods are safe for
// concurrent use. Close is idempotent. A drop clears frame residue (see
// residue) but never touches matcher state, which lives above this package.
type Client struct {
	name string
	addr string

	connectTimeout time.Duration
	maxRetries     int
	baseBackoff    time.Duration
	maxBackoff     time.Duration
	heartbeat      time.Duration
	heartbeatMsg   []byte

	mu      sync.Mutex // guards conn + residue
	wmu     sync.Mutex // serializes Send against the heartbeat writer
	conn    net.Conn
	state   ConnState
	stateMu sync.RWMutex
	// residue holds partial stream bytes awaiting framing. It is cleared on
	// every successful (re)connect. The framing slice consumes full frames
	// out of band; this buffer only guarantees no stale half-frame leaks
	// across connections. Pending matchers (script slice) are preserved:
	// they are keyed by expectation, not by these bytes.
	residue []byte

	closed atomic.Bool
	wg     sync.WaitGroup
	done   chan struct{}

	loopMu  sync.Mutex // ensures a single reconnect goroutine
	looping bool

	hookMu      sync.Mutex
	onReconnect func() // stream slice: framer Reset on fresh connection
	hbStop      chan struct{}
	hbStopMu    sync.Mutex
}

// SetReconnectHook registers fn, called (without client locks held) on
// every successful reconnect. The stream slice uses it to Reset framer
// residue while keeping pending matchers. A nil fn clears the hook.
func (c *Client) SetReconnectHook(fn func()) {
	c.hookMu.Lock()
	defer c.hookMu.Unlock()
	c.onReconnect = fn
}

func (c *Client) reconnectHook() func() {
	c.hookMu.Lock()
	defer c.hookMu.Unlock()
	return c.onReconnect
}

// Dial opens a reconnecting client. It blocks for at most the connect
// timeout on the initial dial: success yields a connected client, failure
// yields a reconnecting client that keeps retrying in the background (until
// MaxRetries, if positive, is exhausted and it moves to closed).
func Dial(name, addr string, opts ClientOptions) (*Client, error) {
	if name == "" {
		return nil, errors.New("tcp: client name is empty")
	}
	if addr == "" {
		return nil, errors.New("tcp: dial address is empty")
	}
	timeout := time.Duration(opts.ConnectTimeoutMs) * time.Millisecond
	if opts.ConnectTimeoutMs <= 0 {
		timeout = 5 * time.Second
	}
	base, max := normalizeBackoff(
		time.Duration(opts.BaseBackoffMs)*time.Millisecond,
		time.Duration(opts.MaxBackoffMs)*time.Millisecond,
	)
	hb := time.Duration(opts.HeartbeatMs) * time.Millisecond
	if opts.HeartbeatMs < 0 {
		hb = 0
	}
	hbMsg := append([]byte(nil), opts.HeartbeatPayload...)
	c := &Client{
		name: name, addr: addr,
		connectTimeout: timeout,
		maxRetries:     opts.MaxRetries,
		baseBackoff:    base,
		maxBackoff:     max,
		heartbeat:      hb,
		heartbeatMsg:   hbMsg,
		state:          StateConnecting,
		done:           make(chan struct{}),
	}
	d := net.Dialer{Timeout: timeout}
	conn, err := d.Dial("tcp", addr)
	if err == nil {
		c.mu.Lock()
		c.conn = conn
		c.mu.Unlock()
		c.setState(StateConnected)
		c.startHeartbeat()
		return c, nil
	}
	c.setState(StateReconnecting)
	c.startReconnectLoop(0)
	return c, nil
}

// Name returns the client name.
func (c *Client) Name() string { return c.name }

// Status reports the current status-machine state.
func (c *Client) Status() ConnState {
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return c.state
}

func (c *Client) setState(s ConnState) {
	c.stateMu.Lock()
	c.state = s
	c.stateMu.Unlock()
}

// ResetFraming clears frame residue without touching the connection. Hook
// for the script slice: call it when discarding stale partial frames; the
// reconnect path calls it automatically on every fresh connection while
// leaving pending matchers intact.
func (c *Client) ResetFraming() {
	c.mu.Lock()
	c.residue = nil
	c.mu.Unlock()
}

// Send writes data on the live connection. It fails fast with an error
// while unconnected (connecting/reconnecting/closed) and never blocks
// waiting for a reconnect. A mid-write connection failure reports the write
// error and kicks the reconnect loop.
func (c *Client) Send(data []byte) (int, error) {
	if c.closed.Load() {
		return 0, fmt.Errorf("tcp: send on %s: %w", c.name, errUnconnected)
	}
	// wmu serializes Send against the heartbeat writer so bytes never
	// interleave; mu is only held to grab the current conn, never across
	// the blocking Write, so a stuck write cannot wedge Close/handleDrop.
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.mu.Lock()
	conn := c.conn
	closed := c.closed.Load()
	c.mu.Unlock()
	if conn == nil || closed {
		return 0, fmt.Errorf("tcp: send on %s: %w", c.name, errUnconnected)
	}
	n, err := conn.Write(data)
	if err != nil {
		go c.handleDrop()
		return n, fmt.Errorf("tcp: send on %s: %w", c.name, err)
	}
	return n, nil
}

// Recv reads up to maxLen bytes with a single Read on the live connection.
// It fails fast while unconnected. A connection failure reports the read
// error and kicks the reconnect loop; the caller retries after reconnect.
// maxLen is capped to bound allocations.
func (c *Client) Recv(maxLen int) ([]byte, error) {
	const maxRecv = 64 * 1024
	if maxLen <= 0 || maxLen > maxRecv {
		return nil, fmt.Errorf("tcp: recv length must be 1-%d, got %d", maxRecv, maxLen)
	}
	if c.closed.Load() {
		return nil, fmt.Errorf("tcp: recv on %s: %w", c.name, errUnconnected)
	}
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return nil, fmt.Errorf("tcp: recv on %s: %w", c.name, errUnconnected)
	}
	buf := make([]byte, maxLen)
	n, err := conn.Read(buf)
	if err != nil {
		if errors.Is(err, io.EOF) || isConnReset(err) {
			go c.handleDrop()
		}
		return nil, fmt.Errorf("tcp: recv on %s: %w", c.name, err)
	}
	return buf[:n], nil
}

// Close shuts the client down: terminal closed state, stops heartbeat and
// reconnect loops, closes the live connection. Idempotent; waits for
// background goroutines.
func (c *Client) Close() error {
	if c.closed.Swap(true) {
		return nil
	}
	close(c.done)
	c.setState(StateClosed)
	c.stopHeartbeat()
	c.mu.Lock()
	conn := c.conn
	c.conn = nil
	c.residue = nil
	c.mu.Unlock()
	var err error
	if conn != nil {
		err = conn.Close()
	}
	// Drain loop starters: any startReconnectLoop that already Added did so
	// under loopMu before Close's Swap+acquire, and any later starter sees
	// closed and skips its Add. Either way no Add races wg.Wait below.
	c.loopMu.Lock()
	c.loopMu.Unlock()
	c.wg.Wait()
	if err != nil {
		return fmt.Errorf("tcp: close %s: %w", c.name, err)
	}
	return nil
}

// handleDrop moves a connected client into reconnecting and starts the retry
// loop. Safe to call from multiple goroutines; only the first starts it.
func (c *Client) handleDrop() {
	if c.closed.Load() {
		return
	}
	c.mu.Lock()
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
	c.residue = nil
	c.mu.Unlock()
	c.stopHeartbeat()
	if c.Status() != StateReconnecting {
		c.setState(StateReconnecting)
	}
	c.startReconnectLoop(0)
}

// startReconnectLoop spawns the single background retry goroutine resuming
// at the given attempt count. Each attempt sleeps backoff(attempt) first so
// a fresh drop waits base before redialing and pressure backs off while the
// peer stays down.
func (c *Client) startReconnectLoop(firstAttempt int) {
	c.loopMu.Lock()
	if c.looping || c.closed.Load() {
		c.loopMu.Unlock()
		return
	}
	c.looping = true
	// Add under loopMu while closed is still false: pairs with Close's
	// loopMu drain, so every Add happens-before Close's Wait.
	c.wg.Add(1)
	c.loopMu.Unlock()
	go func() {
		defer c.wg.Done()
		defer func() {
			c.loopMu.Lock()
			c.looping = false
			c.loopMu.Unlock()
		}()
		for attempt := firstAttempt; ; attempt++ {
			if c.closed.Load() {
				return
			}
			if c.maxRetries > 0 && attempt >= c.maxRetries {
				c.setState(StateClosed)
				c.closed.Store(true)
				return
			}
			timer := time.NewTimer(backoff(attempt, c.baseBackoff, c.maxBackoff))
			select {
			case <-timer.C:
			case <-c.done:
				timer.Stop()
				return
			}
			if c.closed.Load() {
				return
			}
			d := net.Dialer{Timeout: c.connectTimeout}
			conn, err := d.Dial("tcp", c.addr)
			if err == nil {
				c.mu.Lock()
				c.conn = conn
				c.residue = nil // clear frame residue, keep matchers (above)
				c.mu.Unlock()
				c.setState(StateConnected)
				c.startHeartbeat()
				if hook := c.reconnectHook(); hook != nil {
					hook()
				}
				return
			}
		}
	}()
}

func (c *Client) startHeartbeat() {
	if c.heartbeat <= 0 || len(c.heartbeatMsg) == 0 {
		return
	}
	c.hbStopMu.Lock()
	if c.closed.Load() {
		// Close's stopHeartbeat (under this same mutex) precedes its
		// wg.Wait, so skipping the Add here keeps Add before Wait.
		c.hbStopMu.Unlock()
		return
	}
	if c.hbStop != nil {
		select {
		case <-c.hbStop:
			c.hbStop = nil
		default:
			c.hbStopMu.Unlock()
			return // already running
		}
	}
	stop := make(chan struct{})
	c.hbStop = stop
	c.wg.Add(1)
	c.hbStopMu.Unlock()
	msg := append([]byte(nil), c.heartbeatMsg...)
	interval := c.heartbeat
	go func() {
		defer c.wg.Done()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if c.Status() != StateConnected {
					continue
				}
				c.mu.Lock()
				conn := c.conn
				c.mu.Unlock()
				if conn == nil {
					continue
				}
				c.wmu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(interval / 2))
				_, err := conn.Write(msg)
				_ = conn.SetWriteDeadline(time.Time{})
				c.wmu.Unlock()
				if err != nil {
					go c.handleDrop()
					return
				}
			}
		}
	}()
}

func (c *Client) stopHeartbeat() {
	c.hbStopMu.Lock()
	defer c.hbStopMu.Unlock()
	if c.hbStop != nil {
		select {
		case <-c.hbStop:
		default:
			close(c.hbStop)
		}
		c.hbStop = nil
	}
}

func isConnReset(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return true
	}
	return false
}
