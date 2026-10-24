package tcp

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// serverConn is one accepted connection. Send is serialized with a write
// mutex so concurrent writers cannot interleave bytes; Recv is a single
// Read. Close is idempotent.
type serverConn struct {
	id   string
	conn net.Conn
	wmu  sync.Mutex
	once sync.Once
}

// Server is a race-safe TCP listen server. Listen starts the accept loop in
// the background; every accepted connection gets a stable id
// ("<server>/c<N>") usable with Send/Recv/CloseConn independently of its
// siblings. Conns lists live ids; Accept pops the next id, optionally
// waiting. Close shuts the listener and every connection.
type Server struct {
	name     string
	listener net.Listener

	mu    sync.Mutex // guards conns + pending
	conns map[string]*serverConn
	// pending queues ids in accept order for Accept.
	pending []string
	notify  chan struct{} // capacity 1: a new id is queued

	nextID atomic.Uint64
	closed atomic.Bool
	done   chan struct{}
	wg     sync.WaitGroup
}

// Listen starts a server bound to addr (e.g. "127.0.0.1:0" for an ephemeral
// port). The accept loop runs until Close.
func Listen(name, addr string) (*Server, error) {
	if name == "" {
		return nil, errors.New("tcp: server name is empty")
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("tcp: listen %s: %w", addr, err)
	}
	s := &Server{
		name:     name,
		listener: ln,
		conns:    make(map[string]*serverConn),
		notify:   make(chan struct{}, 1),
		done:     make(chan struct{}),
	}
	s.wg.Add(1)
	go s.acceptLoop()
	return s, nil
}

// Name returns the server name.
func (s *Server) Name() string { return s.name }

// Addr returns the bound address (useful with :0).
func (s *Server) Addr() net.Addr { return s.listener.Addr() }

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			if s.closed.Load() {
				return
			}
			// Transient accept error: back off briefly, stop if closed.
			select {
			case <-time.After(25 * time.Millisecond):
			case <-s.done:
				return
			}
			continue
		}
		if s.closed.Load() {
			_ = conn.Close()
			return
		}
		id := fmt.Sprintf("%s/c%d", s.name, s.nextID.Add(1))
		s.mu.Lock()
		s.conns[id] = &serverConn{id: id, conn: conn}
		s.pending = append(s.pending, id)
		s.mu.Unlock()
		select {
		case s.notify <- struct{}{}:
		default:
		}
	}
}

// Conns lists live accepted-connection ids.
func (s *Server) Conns() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.conns))
	for id := range s.conns {
		ids = append(ids, id)
	}
	return ids
}

// RemoteAddr returns the peer address for one accepted connection.
func (s *Server) RemoteAddr(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sc, ok := s.conns[id]; ok && sc.conn.RemoteAddr() != nil {
		return sc.conn.RemoteAddr().String()
	}
	return ""
}

// Accept returns the next accepted-connection id in accept order. A zero
// timeout polls once (error if none queued); a positive timeout waits up to
// the duration; a negative timeout waits until Close. It returns an error
// when no connection arrives in time or the server is closed and drained.
func (s *Server) Accept(timeout time.Duration) (string, error) {
	s.mu.Lock()
	if len(s.pending) > 0 {
		id := s.pending[0]
		s.pending = s.pending[1:]
		s.mu.Unlock()
		return id, nil
	}
	s.mu.Unlock()
	if timeout == 0 {
		return "", errors.New("tcp: no pending connections")
	}
	var deadline <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		deadline = t.C
	}
	for {
		select {
		case <-s.done:
			s.mu.Lock()
			if len(s.pending) > 0 {
				id := s.pending[0]
				s.pending = s.pending[1:]
				s.mu.Unlock()
				return id, nil
			}
			s.mu.Unlock()
			return "", errors.New("tcp: server closed")
		case <-deadline:
			return "", errors.New("tcp: accept timed out")
		case <-s.notify:
			s.mu.Lock()
			if len(s.pending) > 0 {
				id := s.pending[0]
				s.pending = s.pending[1:]
				s.mu.Unlock()
				return id, nil
			}
			s.mu.Unlock()
		}
	}
}

func (s *Server) lookup(id string) (*serverConn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sc, ok := s.conns[id]
	if !ok {
		return nil, fmt.Errorf("tcp: unknown connection %s", id)
	}
	return sc, nil
}

// Send writes data to one accepted connection without affecting its
// siblings.
func (s *Server) Send(id string, data []byte) (int, error) {
	sc, err := s.lookup(id)
	if err != nil {
		return 0, err
	}
	sc.wmu.Lock()
	defer sc.wmu.Unlock()
	n, werr := sc.conn.Write(data)
	if werr != nil {
		return n, fmt.Errorf("tcp: send on %s: %w", id, werr)
	}
	return n, nil
}

// Recv reads up to maxLen bytes from one accepted connection with a single
// Read. maxLen is capped to bound allocations.
func (s *Server) Recv(id string, maxLen int) ([]byte, error) {
	const maxRecv = 64 * 1024
	if maxLen <= 0 || maxLen > maxRecv {
		return nil, fmt.Errorf("tcp: recv length must be 1-%d, got %d", maxRecv, maxLen)
	}
	sc, err := s.lookup(id)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, maxLen)
	n, rerr := sc.conn.Read(buf)
	if rerr != nil {
		_ = s.CloseConn(id)
		return nil, fmt.Errorf("tcp: recv on %s: %w", id, rerr)
	}
	return buf[:n], nil
}

// CloseConn shuts one accepted connection; idempotent per id (second close
// reports unknown connection since the id is removed).
func (s *Server) CloseConn(id string) error {
	s.mu.Lock()
	sc, ok := s.conns[id]
	if ok {
		delete(s.conns, id)
		// Drop from pending so Accept never hands out a closed id.
		for i, p := range s.pending {
			if p == id {
				s.pending = append(s.pending[:i], s.pending[i+1:]...)
				break
			}
		}
	}
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("tcp: unknown connection %s", id)
	}
	var err error
	sc.once.Do(func() { err = sc.conn.Close() })
	if err != nil {
		return fmt.Errorf("tcp: close %s: %w", id, err)
	}
	return nil
}

// Close shuts the listener and every accepted connection, unblocking Accept.
func (s *Server) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	close(s.done)
	err := s.listener.Close()
	s.mu.Lock()
	conns := make([]*serverConn, 0, len(s.conns))
	for _, sc := range s.conns {
		conns = append(conns, sc)
	}
	s.conns = make(map[string]*serverConn)
	s.pending = nil
	s.mu.Unlock()
	for _, sc := range conns {
		sc.once.Do(func() { _ = sc.conn.Close() })
	}
	s.wg.Wait()
	if err != nil {
		return fmt.Errorf("tcp: close server %s: %w", s.name, err)
	}
	return nil
}
