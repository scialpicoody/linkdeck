// Package link wires real drivers behind the script engine's Transport
// contract. It lives outside internal/script so the driver packages stay
// out of the engine's import graph (serial/tcp → stream → script must
// remain acyclic); only main imports this package.
package link

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"linkdeck/internal/script"
	"linkdeck/internal/serial"
	"linkdeck/internal/tcp"
)

// Engine-contract aliases so the moved code reads unchanged.
type (
	Transport         = script.Transport
	ListenerTransport = script.ListenerTransport
	Handle            = script.Handle
	OpenOptions       = script.OpenOptions
	EngineOptions     = script.EngineOptions
)

var (
	ErrTimeout = script.ErrTimeout
	NewEngine  = script.NewEngine
)

var (
	_ Transport         = (*SerialTransport)(nil)
	_ Transport         = (*TCPTransport)(nil)
	_ ListenerTransport = (*TCPTransport)(nil)
)

// serialMaxRecv bounds one adapter Recv; the engine slices waits anyway.
const serialMaxRecv = 4096

// tcpPumpMaxRecv bounds one pump read. Both TCP Recv paths cap at 64KiB;
// stay well under it.
const tcpPumpMaxRecv = 32 * 1024

// ---------------------------------------------------------------------------
// Serial: the real driver behind the serial Lua table
// ---------------------------------------------------------------------------

// SerialTransport adapts a *serial.SerialService to the script Transport
// contract. It is constructor-injected (no edits to the serial package):
// NewSerialTransport(svc) with the service the host owns. A nil service
// fails every Open cleanly, mirroring the unconfigured-transport Lua path.
//
// Semantics:
//   - Opens are exclusive per port name, like the service itself: opening an
//     already-open port fails instead of aliasing it.
//   - BaudRate <= 0 selects 115200; DataBits/Parity/StopBits stay 8N1 (the
//     service's JSON surface owns finer modes; presets arrive via Extra).
//   - Framing is informational here: the engine passes raw received bytes
//     and the data-path slice owns framing.
//   - Recv honors the timeout contract exactly via the port read timeout;
//     expiry is ErrTimeout. Each Recv reprograms the port's timeout, so the
//     last slice's value lingers for direct service users afterwards.
//   - One waiter per channel: concurrent Recvs on one handle race on the
//     port timeout. All methods are otherwise safe for concurrent use.
type SerialTransport struct {
	mu   sync.Mutex
	svc  *serial.SerialService
	seq  int
	open map[Handle]string
}

// NewSerialTransport returns a Transport over svc (nil allowed: opens fail).
func NewSerialTransport(svc *serial.SerialService) *SerialTransport {
	return &SerialTransport{svc: svc, open: make(map[Handle]string)}
}

// Open opens target (a port path) once; reopening an open port is an error.
func (t *SerialTransport) Open(target string, opts OpenOptions) (Handle, error) {
	if t.svc == nil {
		return "", errors.New("serial: transport not configured")
	}
	baud := opts.BaudRate
	if baud <= 0 {
		baud = 115200
	}
	t.mu.Lock()
	if _, dup := t.targetLocked(target); dup {
		t.mu.Unlock()
		return "", fmt.Errorf("serial: %s is already open", target)
	}
	t.mu.Unlock()
	if _, err := t.svc.Open(serial.OpenRequest{
		Port:     target,
		BaudRate: baud,
		DataBits: 8,
		Parity:   serial.ParityNone,
		StopBits: serial.StopOne,
	}); err != nil {
		return "", err
	}
	t.mu.Lock()
	t.seq++
	h := Handle(fmt.Sprintf("serial-%d", t.seq))
	t.open[h] = target
	t.mu.Unlock()
	return h, nil
}

// targetLocked reports whether target is already open. Callers hold t.mu.
func (t *SerialTransport) targetLocked(target string) (Handle, bool) {
	for h, name := range t.open {
		if name == target {
			return h, true
		}
	}
	return "", false
}

// Close shuts the channel; unknown handles are an error.
func (t *SerialTransport) Close(h Handle) error {
	t.mu.Lock()
	name, ok := t.open[h]
	if ok {
		delete(t.open, h)
	}
	t.mu.Unlock()
	if !ok {
		return fmt.Errorf("serial: unknown handle %s", string(h))
	}
	return t.svc.Close(name)
}

// Send writes data; short writes are an error.
func (t *SerialTransport) Send(h Handle, data []byte) error {
	t.mu.Lock()
	name, ok := t.open[h]
	t.mu.Unlock()
	if !ok {
		return fmt.Errorf("serial: unknown handle %s", string(h))
	}
	n, err := t.svc.Send(name, data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return fmt.Errorf("serial: short write on %s: %d of %d bytes", name, n, len(data))
	}
	return nil
}

// Recv waits up to timeoutMs for bytes (negative: indefinitely) and reports
// ErrTimeout on expiry, per the Transport contract.
func (t *SerialTransport) Recv(h Handle, timeoutMs int) ([]byte, error) {
	t.mu.Lock()
	name, ok := t.open[h]
	t.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("serial: unknown handle %s", string(h))
	}
	if err := t.svc.SetReadTimeout(name, timeoutMs); err != nil {
		return nil, err
	}
	data, err := t.svc.Recv(name, serialMaxRecv)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, ErrTimeout
	}
	return data, nil
}

// ---------------------------------------------------------------------------
// TCP: the real driver behind the tcp Lua table
// ---------------------------------------------------------------------------

// tcpPump is one connection's read loop. The underlying client Recv has no
// deadline knob, so each connection pumps blocking reads into a queue and
// Recv dequeues with an exact timeout: no leaked readers per slice, no lost
// bytes between slices, and reconnect drops ride out inside the loop while
// waiters keep their deadline. One goroutine per open connection until
// Close, mirroring the per-channel read-loop ownership of the data path.
type tcpPump struct {
	svc    *tcp.TcpService
	client string // dial-client name; empty for accepted server conns
	server string // server name for accepted conns
	conn   string // accepted-conn id

	mu     sync.Mutex
	queue  [][]byte
	notify chan struct{} // cap 1: queued data or death; rechecked under mu
	done   chan struct{}

	stopOnce sync.Once
	wg       sync.WaitGroup
	dead     error // sticky fatal error once the loop exits uncleanly
}

// errPumpClosed wakes waiters abandoned by Close.
var errPumpClosed = errors.New("tcp: connection closed")

func newTCPPump(svc *tcp.TcpService, client, server, conn string) *tcpPump {
	p := &tcpPump{
		svc:    svc,
		client: client,
		server: server,
		conn:   conn,
		notify: make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
	p.wg.Add(1)
	go p.run()
	return p
}

func (p *tcpPump) signal() {
	select {
	case p.notify <- struct{}{}:
	default:
	}
}

func (p *tcpPump) run() {
	defer p.wg.Done()
	fail := func(err error) {
		p.mu.Lock()
		if p.dead == nil {
			p.dead = err
		}
		p.mu.Unlock()
		p.signal()
	}
	for {
		select {
		case <-p.done:
			return
		default:
		}
		var (
			data []byte
			err  error
		)
		if p.client != "" {
			data, err = p.svc.Recv(p.client, tcpPumpMaxRecv)
		} else {
			data, err = p.svc.ServerRecv(p.server, p.conn, tcpPumpMaxRecv)
		}
		if err != nil {
			select {
			case <-p.done:
				return
			default:
			}
			if p.client != "" {
				// Reconnecting clients fail fast while down; ride it out.
				time.Sleep(20 * time.Millisecond)
				continue
			}
			fail(err)
			return
		}
		if len(data) == 0 {
			continue
		}
		p.mu.Lock()
		p.queue = append(p.queue, data)
		p.mu.Unlock()
		p.signal()
	}
}

// recv dequeues the next chunk, waiting up to timeoutMs (negative: no
// deadline) and reporting ErrTimeout on expiry.
func (p *tcpPump) recv(timeoutMs int) ([]byte, error) {
	var deadline <-chan time.Time
	if timeoutMs >= 0 {
		timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
		defer timer.Stop()
		deadline = timer.C
	}
	for {
		p.mu.Lock()
		if len(p.queue) > 0 {
			data := p.queue[0]
			p.queue[0] = nil
			p.queue = p.queue[1:]
			p.mu.Unlock()
			return data, nil
		}
		dead := p.dead
		p.mu.Unlock()
		if dead != nil {
			return nil, dead
		}
		select {
		case <-p.notify:
		case <-p.done:
			return nil, errPumpClosed
		case <-deadline:
			return nil, ErrTimeout
		}
	}
}

// stop ends the read loop; waiters wake with errPumpClosed.
func (p *tcpPump) stop() {
	p.stopOnce.Do(func() { close(p.done) })
	p.wg.Wait()
}

// TCPTransport adapts a *tcp.TcpService to Transport plus
// ListenerTransport, constructor-injected like the serial side. Dial clients
// keep the service's reconnect behavior; server connections ride the
// service's accept queue. Listen binds loopback only (127.0.0.1:port) so
// script servers never surprise the host with a LAN-visible socket.
type TCPTransport struct {
	mu      sync.Mutex
	svc     *tcp.TcpService
	seq     int
	clients map[Handle]*tcpPump
	conns   map[Handle]*tcpPump
	servers map[Handle]string
}

// NewTCPTransport returns a Transport over svc (nil allowed: opens fail).
func NewTCPTransport(svc *tcp.TcpService) *TCPTransport {
	return &TCPTransport{
		svc:     svc,
		clients: make(map[Handle]*tcpPump),
		conns:   make(map[Handle]*tcpPump),
		servers: make(map[Handle]string),
	}
}

// Open dials target (a host; the port arrives in opts.Extra["port"] from
// tcp.open, or target already holds host:port for direct Go use).
func (t *TCPTransport) Open(target string, opts OpenOptions) (Handle, error) {
	if t.svc == nil {
		return "", errors.New("tcp: transport not configured")
	}
	addr := target
	if port, ok := opts.Extra["port"]; ok && port != "" {
		addr = net.JoinHostPort(target, port)
	}
	t.mu.Lock()
	t.seq++
	name := fmt.Sprintf("tcp-c%d", t.seq)
	h := Handle(fmt.Sprintf("tcp:%d", t.seq))
	t.mu.Unlock()
	if _, err := t.svc.Open(tcp.OpenRequest{Name: name, Address: addr}); err != nil {
		return "", err
	}
	t.mu.Lock()
	t.clients[h] = newTCPPump(t.svc, name, "", "")
	t.mu.Unlock()
	return h, nil
}

// Listen starts a loopback server on port.
func (t *TCPTransport) Listen(port int, opts OpenOptions) (Handle, error) {
	if t.svc == nil {
		return "", errors.New("tcp: transport not configured")
	}
	t.mu.Lock()
	t.seq++
	name := fmt.Sprintf("tcp-s%d", t.seq)
	h := Handle(fmt.Sprintf("tcp:%d", t.seq))
	t.mu.Unlock()
	if _, err := t.svc.Listen(tcp.ListenRequest{
		Name:    name,
		Address: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
	}); err != nil {
		return "", err
	}
	t.mu.Lock()
	t.servers[h] = name
	t.mu.Unlock()
	return h, nil
}

// Accept waits up to timeoutMs for the next connection (0 polls once,
// negative waits until Unlisten) and reports ErrTimeout on expiry.
func (t *TCPTransport) Accept(h Handle, timeoutMs int) (Handle, error) {
	t.mu.Lock()
	name, ok := t.servers[h]
	t.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("tcp: unknown listen handle %s", string(h))
	}
	info, err := t.svc.Accept(name, timeoutMs)
	if err != nil {
		if strings.Contains(err.Error(), "timed out") ||
			strings.Contains(err.Error(), "no pending") {
			return "", ErrTimeout
		}
		return "", err
	}
	t.mu.Lock()
	t.seq++
	ch := Handle(fmt.Sprintf("tcp:%d", t.seq))
	t.conns[ch] = newTCPPump(t.svc, "", name, info.Name)
	t.mu.Unlock()
	return ch, nil
}

// Close shuts a client, an accepted connection, or a listener.
func (t *TCPTransport) Close(h Handle) error {
	t.mu.Lock()
	if p, ok := t.clients[h]; ok {
		delete(t.clients, h)
		t.mu.Unlock()
		p.stop()
		return t.svc.Close(p.client)
	}
	if p, ok := t.conns[h]; ok {
		delete(t.conns, h)
		t.mu.Unlock()
		p.stop()
		return t.svc.ServerClose(p.server, p.conn)
	}
	name, ok := t.servers[h]
	if ok {
		delete(t.servers, h)
	}
	t.mu.Unlock()
	if !ok {
		return fmt.Errorf("tcp: unknown handle %s", string(h))
	}
	return t.svc.Unlisten(name)
}

// Send writes data; listeners and unknown handles are errors.
func (t *TCPTransport) Send(h Handle, data []byte) error {
	p, server, conn, err := t.writerFor(h)
	if err != nil {
		return err
	}
	var n int
	if p != nil {
		n, err = t.svc.Send(p.client, data)
	} else {
		n, err = t.svc.ServerSend(server, conn, data)
	}
	if err != nil {
		return err
	}
	if n != len(data) {
		return fmt.Errorf("tcp: short write: %d of %d bytes", n, len(data))
	}
	return nil
}

// writerFor resolves a sendable handle: a client pump, or a server/conn id
// pair when the pump is nil.
func (t *TCPTransport) writerFor(h Handle) (p *tcpPump, server, conn string, err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if p, ok := t.clients[h]; ok {
		return p, "", "", nil
	}
	if p, ok := t.conns[h]; ok {
		return nil, p.server, p.conn, nil
	}
	if _, ok := t.servers[h]; ok {
		return nil, "", "", fmt.Errorf("tcp: cannot send on listen handle %s", string(h))
	}
	return nil, "", "", fmt.Errorf("tcp: unknown handle %s", string(h))
}

// Recv reads via the connection pump with the Transport timeout contract.
func (t *TCPTransport) Recv(h Handle, timeoutMs int) ([]byte, error) {
	t.mu.Lock()
	p, ok := t.clients[h]
	if !ok {
		p, ok = t.conns[h]
	}
	t.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("tcp: unknown or listen handle %s", string(h))
	}
	return p.recv(timeoutMs)
}
