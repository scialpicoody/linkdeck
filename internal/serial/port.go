package serial

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	goserial "go.bug.st/serial"
)

// errClosed is returned for operations on a closed Port.
var errClosed = errors.New("serial: port is closed")

// ModemStatus carries the modem input status bits of a serial port.
type ModemStatus struct {
	CTS bool `json:"cts"`
	DSR bool `json:"dsr"`
	RI  bool `json:"ri"`
	DCD bool `json:"dcd"`
}

// Port is a race-safe serial port.
//
// Close is idempotent and safe to call concurrently with Send, Recv,
// SetReadTimeout and Status. Once closed, new operations fail with an error
// instead of touching the underlying handle. Per package doc gap 3, Close
// does not cancel an in-flight Write: Writes are serialized so at most one
// is in flight, and it runs to completion.
type Port struct {
	name string
	// wmu serializes Writes so Close never races more than one in-flight
	// write, and concurrent Sends don't interleave bytes.
	wmu sync.Mutex
	// mu guards port during Close against SetReadTimeout/Status/Read.
	mu     sync.Mutex
	port   goserial.Port
	closed atomic.Bool
}

// Open validates mode and opens the named port. A nonzero readTimeout is
// applied via SetReadTimeout; zero leaves the library default in place.
func Open(name string, mode Mode, readTimeout time.Duration) (*Port, error) {
	if name == "" {
		return nil, errors.New("serial: port name is empty")
	}
	if err := mode.Validate(); err != nil {
		return nil, err
	}
	raw, err := goserial.Open(name, mode.toLibrary())
	if err != nil {
		return nil, fmt.Errorf("serial: open %s: %w", name, err)
	}
	p := &Port{name: name, port: raw}
	if readTimeout != 0 {
		if err := p.SetReadTimeout(readTimeout); err != nil {
			_ = raw.Close()
			return nil, fmt.Errorf("serial: open %s: %w", name, err)
		}
	}
	return p, nil
}

// Name returns the port name p was opened with.
func (p *Port) Name() string { return p.name }

// Send writes data to the port, serialized against concurrent Sends.
// It fails fast once the port is closed but does not cancel an in-flight
// write on another goroutine (see gap 3 in the package doc).
func (p *Port) Send(data []byte) (int, error) {
	if p.closed.Load() {
		return 0, fmt.Errorf("serial: send on %s: %w", p.name, errClosed)
	}
	p.wmu.Lock()
	defer p.wmu.Unlock()
	if p.closed.Load() {
		return 0, fmt.Errorf("serial: send on %s: %w", p.name, errClosed)
	}
	n, err := p.port.Write(data)
	if err != nil {
		return n, fmt.Errorf("serial: send on %s: %w", p.name, err)
	}
	return n, nil
}

// Recv reads up to maxLen bytes with a single Read call: it blocks until at
// least one byte arrives, the read timeout expires (returning 0, nil), or an
// error occurs. maxLen is capped to keep a misbehaving caller from forcing a
// huge allocation.
func (p *Port) Recv(maxLen int) ([]byte, error) {
	const maxRecv = 64 * 1024
	if maxLen <= 0 || maxLen > maxRecv {
		return nil, fmt.Errorf("serial: recv length must be 1-%d, got %d", maxRecv, maxLen)
	}
	if p.closed.Load() {
		return nil, fmt.Errorf("serial: recv on %s: %w", p.name, errClosed)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed.Load() {
		return nil, fmt.Errorf("serial: recv on %s: %w", p.name, errClosed)
	}
	buf := make([]byte, maxLen)
	n, err := p.port.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("serial: recv on %s: %w", p.name, err)
	}
	return buf[:n], nil
}

// SetReadTimeout sets the Read timeout; a negative duration disables it
// (serial.NoTimeout). Expiry reports (0, nil), not an error.
func (p *Port) SetReadTimeout(d time.Duration) error {
	if p.closed.Load() {
		return fmt.Errorf("serial: set timeout on %s: %w", p.name, errClosed)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed.Load() {
		return fmt.Errorf("serial: set timeout on %s: %w", p.name, errClosed)
	}
	timeout := d
	if d < 0 {
		timeout = goserial.NoTimeout
	}
	if err := p.port.SetReadTimeout(timeout); err != nil {
		return fmt.Errorf("serial: set timeout on %s: %w", p.name, err)
	}
	return nil
}

// Status queries the modem input status bits (CTS, DSR, RI, DCD).
func (p *Port) Status() (ModemStatus, error) {
	if p.closed.Load() {
		return ModemStatus{}, fmt.Errorf("serial: status on %s: %w", p.name, errClosed)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed.Load() {
		return ModemStatus{}, fmt.Errorf("serial: status on %s: %w", p.name, errClosed)
	}
	bits, err := p.port.GetModemStatusBits()
	if err != nil {
		return ModemStatus{}, fmt.Errorf("serial: status on %s: %w", p.name, err)
	}
	return ModemStatus{CTS: bits.CTS, DSR: bits.DSR, RI: bits.RI, DCD: bits.DCD}, nil
}

// Close shuts the port down exactly once: concurrent and repeated calls are
// safe, and only the first reports the underlying close error. It unblocks a
// pending Recv; an in-flight Send runs to completion (see gap 3).
func (p *Port) Close() error {
	if p.closed.Swap(true) {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.port.Close(); err != nil {
		return fmt.Errorf("serial: close %s: %w", p.name, err)
	}
	return nil
}
