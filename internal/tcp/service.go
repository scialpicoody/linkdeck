package tcp

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"linkdeck/internal/framing"
	"linkdeck/internal/stream"
)

// OpenRequest asks the service to dial a TCP client. JSON-friendly for a
// future mygo.Bind (NOT bound in main.go; the integrator owns binding).
//
// MaxRetries caps reconnect attempts after the initial dial: 0 (default)
// retries forever. BaseBackoffMs/MaxBackoffMs tune the capped exponential
// backoff (defaults 100/5000); ConnectTimeoutMs bounds each dial (default
// 5000). HeartbeatMs <= 0 (default) disables the heartbeat; otherwise the
// client sends HeartbeatPayload (base64 over bindings) every HeartbeatMs.
type OpenRequest struct {
	Name             string       `json:"name"`
	Address          string       `json:"address"`
	ConnectTimeoutMs int          `json:"connectTimeoutMs"`
	MaxRetries       int          `json:"maxRetries"`
	BaseBackoffMs    int          `json:"baseBackoffMs"`
	MaxBackoffMs     int          `json:"maxBackoffMs"`
	HeartbeatMs      int          `json:"heartbeatMs"`
	HeartbeatPayload []byte       `json:"heartbeatPayload"`
	Framing          framing.Spec `json:"framing"`
}

// ConnInfo describes one client channel.
type ConnInfo struct {
	Name    string    `json:"name"`
	Address string    `json:"address"`
	State   ConnState `json:"state"`
}

// ListenRequest asks the service to start a listen server.
type ListenRequest struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// ListenInfo describes a bound server.
type ListenInfo struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// ChannelInfo is the List element: every client, server, and accepted
// server connection in one JSON-friendly row.
type ChannelInfo struct {
	Name    string    `json:"name"`
	Kind    string    `json:"kind"` // "tcp-client" | "tcp-server" | "tcp-conn"
	Address string    `json:"address"`
	State   ConnState `json:"state,omitempty"`
}

// TcpService owns dial clients and listen servers by name, mirroring the
// SerialService shape (list/open/close/send/recv/status) plus
// listen/accept for servers. Every method is safe for concurrent calls.
// It is deliberately NOT bound in main.go.
type TcpService struct {
	mu      sync.Mutex
	clients map[string]*Client
	servers map[string]*Server
	stream  *stream.Manager
}

// AttachStream connects the RX stream manager (ticket #11). When attached,
// Open starts a per-client read loop, Close stops it, and every
// successful reconnect Resets framer residue while keeping matchers. A nil
// manager detaches and clears client hooks. NOT bound in main.go.
func (s *TcpService) AttachStream(m *stream.Manager) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stream = m
	for name, c := range s.clients {
		if m != nil {
			c.SetReconnectHook(m.Resetter(name))
		} else {
			c.SetReconnectHook(nil)
		}
	}
}

// NewTcpService returns an empty TcpService.
func NewTcpService() *TcpService {
	return &TcpService{clients: make(map[string]*Client), servers: make(map[string]*Server)}
}

// List returns every known channel: clients, servers, and accepted server
// connections.
func (s *TcpService) List() ([]ChannelInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []ChannelInfo
	for name, c := range s.clients {
		out = append(out, ChannelInfo{Name: name, Kind: "tcp-client", Address: c.addr, State: c.Status()})
	}
	for name, srv := range s.servers {
		addr := ""
		if a := srv.Addr(); a != nil {
			addr = a.String()
		}
		out = append(out, ChannelInfo{Name: name, Kind: "tcp-server", Address: addr})
		for _, id := range srv.Conns() {
			out = append(out, ChannelInfo{Name: id, Kind: "tcp-conn", Address: addr})
		}
	}
	return out, nil
}

// Open dials a client; names are exclusive across clients.
func (s *TcpService) Open(req OpenRequest) (ConnInfo, error) {
	if req.Name == "" {
		return ConnInfo{}, errors.New("tcp: client name is empty")
	}
	spec := req.Framing
	if spec.Kind == "" {
		spec = framing.DefaultSpec()
	}
	framer, err := framing.New(spec)
	if err != nil {
		return ConnInfo{}, fmt.Errorf("tcp: framing: %w", err)
	}
	s.mu.Lock()
	if _, dup := s.clients[req.Name]; dup {
		s.mu.Unlock()
		return ConnInfo{}, fmt.Errorf("tcp: %s is already open", req.Name)
	}
	s.mu.Unlock()
	c, err := Dial(req.Name, req.Address, ClientOptions{
		ConnectTimeoutMs: req.ConnectTimeoutMs,
		MaxRetries:       req.MaxRetries,
		BaseBackoffMs:    req.BaseBackoffMs,
		MaxBackoffMs:     req.MaxBackoffMs,
		HeartbeatMs:      req.HeartbeatMs,
		HeartbeatPayload: req.HeartbeatPayload,
	})
	if err != nil {
		return ConnInfo{}, err
	}
	s.mu.Lock()
	if _, dup := s.clients[req.Name]; dup {
		s.mu.Unlock()
		_ = c.Close()
		return ConnInfo{}, fmt.Errorf("tcp: %s is already open", req.Name)
	}
	mgr := s.stream
	if mgr != nil {
		c.SetReconnectHook(mgr.Resetter(req.Name))
		if serr := mgr.Start(req.Name, clientSource{client: c}, framer); serr != nil {
			s.mu.Unlock()
			c.SetReconnectHook(nil)
			_ = c.Close()
			return ConnInfo{}, serr
		}
	}
	s.clients[req.Name] = c
	s.mu.Unlock()
	return ConnInfo{Name: req.Name, Address: req.Address, State: c.Status()}, nil
}

// Close shuts the named client; closing an unknown client is an error,
// closing twice is not possible (the name is removed).
func (s *TcpService) Close(name string) error {
	s.mu.Lock()
	c, ok := s.clients[name]
	if ok {
		delete(s.clients, name)
	}
	mgr := s.stream
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("tcp: %s is not open", name)
	}
	c.SetReconnectHook(nil)
	// Close the client first: it unblocks the read loop's in-flight Recv
	// (Manager.Stop waits for the loop to exit and cannot interrupt a
	// blocking Read itself).
	err := c.Close()
	if mgr != nil {
		mgr.Stop(name)
	}
	return err
}

// clientSource adapts a dial Client to stream.Source.
type clientSource struct{ client *Client }

// Read implements stream.Source.
func (cs clientSource) Read(maxLen int) ([]byte, error) { return cs.client.Recv(maxLen) }

// Send writes data to the named client; fails fast while unconnected.
func (s *TcpService) Send(name string, data []byte) (int, error) {
	c, err := s.lookupClient(name)
	if err != nil {
		return 0, err
	}
	return c.Send(data)
}

// Recv reads up to maxLen bytes from the named client.
func (s *TcpService) Recv(name string, maxLen int) ([]byte, error) {
	c, err := s.lookupClient(name)
	if err != nil {
		return nil, err
	}
	return c.Recv(maxLen)
}

// Status reports the named client's status-machine state.
func (s *TcpService) Status(name string) (ConnState, error) {
	c, err := s.lookupClient(name)
	if err != nil {
		return "", err
	}
	return c.Status(), nil
}

// Listen starts a named server; names are exclusive across servers.
func (s *TcpService) Listen(req ListenRequest) (ListenInfo, error) {
	if req.Name == "" {
		return ListenInfo{}, errors.New("tcp: server name is empty")
	}
	s.mu.Lock()
	if _, dup := s.servers[req.Name]; dup {
		s.mu.Unlock()
		return ListenInfo{}, fmt.Errorf("tcp: server %s is already listening", req.Name)
	}
	s.mu.Unlock()
	srv, err := Listen(req.Name, req.Address)
	if err != nil {
		return ListenInfo{}, err
	}
	s.mu.Lock()
	if _, dup := s.servers[req.Name]; dup {
		s.mu.Unlock()
		_ = srv.Close()
		return ListenInfo{}, fmt.Errorf("tcp: server %s is already listening", req.Name)
	}
	s.servers[req.Name] = srv
	s.mu.Unlock()
	return ListenInfo{Name: req.Name, Address: srv.Addr().String()}, nil
}

// Accept returns the next accepted-connection id on the named server.
// TimeoutMs == 0 polls once, > 0 waits up to that many milliseconds,
// < 0 waits until Unlisten.
func (s *TcpService) Accept(server string, timeoutMs int) (ConnInfo, error) {
	srv, err := s.lookupServer(server)
	if err != nil {
		return ConnInfo{}, err
	}
	var timeout time.Duration
	if timeoutMs == 0 {
		timeout = 0
	} else if timeoutMs < 0 {
		timeout = -1
	} else {
		timeout = time.Duration(timeoutMs) * time.Millisecond
	}
	id, err := srv.Accept(timeout)
	if err != nil {
		return ConnInfo{}, err
	}
	return ConnInfo{Name: id, Address: srv.Addr().String(), State: StateConnected}, nil
}

// ServerConns lists live accepted-connection ids on the named server.
func (s *TcpService) ServerConns(server string) ([]ConnInfo, error) {
	srv, err := s.lookupServer(server)
	if err != nil {
		return nil, err
	}
	ids := srv.Conns()
	out := make([]ConnInfo, 0, len(ids))
	for _, id := range ids {
		out = append(out, ConnInfo{Name: id, Address: srv.Addr().String(), State: StateConnected})
	}
	return out, nil
}

// ServerSend writes to one accepted connection.
func (s *TcpService) ServerSend(server, id string, data []byte) (int, error) {
	srv, err := s.lookupServer(server)
	if err != nil {
		return 0, err
	}
	return srv.Send(id, data)
}

// ServerRecv reads from one accepted connection.
func (s *TcpService) ServerRecv(server, id string, maxLen int) ([]byte, error) {
	srv, err := s.lookupServer(server)
	if err != nil {
		return nil, err
	}
	return srv.Recv(id, maxLen)
}

// ServerClose shuts one accepted connection.
func (s *TcpService) ServerClose(server, id string) error {
	srv, err := s.lookupServer(server)
	if err != nil {
		return err
	}
	return srv.CloseConn(id)
}

// Unlisten shuts the named server and all its connections.
func (s *TcpService) Unlisten(server string) error {
	s.mu.Lock()
	srv, ok := s.servers[server]
	if ok {
		delete(s.servers, server)
	}
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("tcp: server %s is not listening", server)
	}
	return srv.Close()
}

func (s *TcpService) lookupClient(name string) (*Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.clients[name]
	if !ok {
		return nil, fmt.Errorf("tcp: %s is not open", name)
	}
	return c, nil
}

func (s *TcpService) lookupServer(name string) (*Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	srv, ok := s.servers[name]
	if !ok {
		return nil, fmt.Errorf("tcp: server %s is not listening", name)
	}
	return srv, nil
}
