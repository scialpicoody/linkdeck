package script

import (
	"errors"
	"sync"
	"time"
)

// fakeConn is one in-memory channel end.
type fakeConn struct {
	mu     sync.Mutex
	inbox  chan []byte
	sent   [][]byte
	closed bool
}

// FakeTransport is an in-memory Transport (plus ListenerTransport) for
// tests: no hardware, no network. Sends are recorded; per-send replies come
// from Respond; unsolicited inbound bytes enter via Push. All methods honor
// the Transport timeout contract, including ErrTimeout.
type FakeTransport struct {
	mu        sync.Mutex
	seq       int
	conns     map[Handle]*fakeConn
	listeners map[Handle]chan Handle
	// Respond maps an outgoing payload to the inbound replies it triggers.
	// Nil means no auto-reply.
	Respond func(sent []byte) [][]byte
	// OpenErr, when non-nil, fails every Open/Listen.
	OpenErr error
	// Opens logs every Open/Listen call; Last is the newest handle.
	Opens []OpenCall
	Last  Handle
}

// OpenCall records one Open/Listen call for assertions.
type OpenCall struct {
	Target string
	Opts   OpenOptions
	Listen bool
	Port   int
}

// NewFakeTransport returns an empty FakeTransport.
func NewFakeTransport() *FakeTransport {
	return &FakeTransport{
		conns:     make(map[Handle]*fakeConn),
		listeners: make(map[Handle]chan Handle),
	}
}

func (f *FakeTransport) next(prefix string) Handle {
	f.seq++
	return Handle(prefix + "-" + itoa(f.seq))
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// Open creates a new fake connection keyed by target (targets are opaque
// labels; Respond decides behavior).
func (f *FakeTransport) Open(target string, opts OpenOptions) (Handle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.OpenErr != nil {
		return "", f.OpenErr
	}
	h := f.next("fake")
	f.conns[h] = &fakeConn{inbox: make(chan []byte, 1024)}
	f.Opens = append(f.Opens, OpenCall{Target: target, Opts: opts})
	f.Last = h
	return h, nil
}

// Close marks the connection closed; further Send/Recv fail.
func (f *FakeTransport) Close(h Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ch, ok := f.conns[h]; ok {
		ch.mu.Lock()
		ch.closed = true
		ch.mu.Unlock()
		return nil
	}
	if _, ok := f.listeners[h]; ok {
		delete(f.listeners, h)
		return nil
	}
	return errors.New("fake: unknown handle")
}

// Send records the payload and enqueues Respond's replies, if any.
func (f *FakeTransport) Send(h Handle, data []byte) error {
	f.mu.Lock()
	ch, ok := f.conns[h]
	respond := f.Respond
	f.mu.Unlock()
	if !ok {
		return errors.New("fake: unknown handle")
	}
	ch.mu.Lock()
	closed := ch.closed
	ch.mu.Unlock()
	if closed {
		return errors.New("fake: connection closed")
	}
	cp := append([]byte(nil), data...)
	ch.mu.Lock()
	ch.sent = append(ch.sent, cp)
	ch.mu.Unlock()
	if respond != nil {
		for _, reply := range respond(cp) {
			ch.inbox <- append([]byte(nil), reply...)
		}
	}
	return nil
}

// Recv waits up to timeoutMs for inbound bytes (negative: indefinitely).
func (f *FakeTransport) Recv(h Handle, timeoutMs int) ([]byte, error) {
	f.mu.Lock()
	ch, ok := f.conns[h]
	f.mu.Unlock()
	if !ok {
		return nil, errors.New("fake: unknown handle")
	}
	ch.mu.Lock()
	closed := ch.closed
	ch.mu.Unlock()
	if closed {
		return nil, errors.New("fake: connection closed")
	}
	if timeoutMs < 0 {
		data, ok := <-ch.inbox
		if !ok {
			return nil, errors.New("fake: connection closed")
		}
		return data, nil
	}
	timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timer.Stop()
	select {
	case data := <-ch.inbox:
		return data, nil
	case <-timer.C:
		return nil, ErrTimeout
	}
}

// Push injects unsolicited inbound bytes.
func (f *FakeTransport) Push(h Handle, data []byte) error {
	f.mu.Lock()
	ch, ok := f.conns[h]
	f.mu.Unlock()
	if !ok {
		return errors.New("fake: unknown handle")
	}
	ch.inbox <- append([]byte(nil), data...)
	return nil
}

// Sent returns a copy of everything sent on h.
func (f *FakeTransport) Sent(h Handle) [][]byte {
	f.mu.Lock()
	ch, ok := f.conns[h]
	f.mu.Unlock()
	if !ok {
		return nil
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	return append([][]byte(nil), ch.sent...)
}

// Listen creates a fake listener; Accept dequeues staged connections.
func (f *FakeTransport) Listen(port int, opts OpenOptions) (Handle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.OpenErr != nil {
		return "", f.OpenErr
	}
	h := f.next("fakel")
	f.listeners[h] = make(chan Handle, 16)
	f.Opens = append(f.Opens, OpenCall{Opts: opts, Listen: true, Port: port})
	f.Last = h
	return h, nil
}

// StageAccept queues conn as the next Accept result on listener l.
func (f *FakeTransport) StageAccept(l, conn Handle) error {
	f.mu.Lock()
	pending, ok := f.listeners[l]
	f.mu.Unlock()
	if !ok {
		return errors.New("fake: unknown listener")
	}
	pending <- conn
	return nil
}

// Accept waits up to timeoutMs for a staged connection.
func (f *FakeTransport) Accept(h Handle, timeoutMs int) (Handle, error) {
	f.mu.Lock()
	pending, ok := f.listeners[h]
	f.mu.Unlock()
	if !ok {
		return "", errors.New("fake: unknown listener")
	}
	if timeoutMs < 0 {
		return <-pending, nil
	}
	timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timer.Stop()
	select {
	case conn := <-pending:
		return conn, nil
	case <-timer.C:
		return "", ErrTimeout
	}
}
