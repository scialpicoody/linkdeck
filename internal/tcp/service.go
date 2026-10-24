package tcp

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"linkdeck/internal/framing"
	"linkdeck/internal/stream"
)

// OpenRequest asks the service to dial a TCP client. It is JSON-friendly for
// mygo bindings.
//
// MaxRetries caps reconnect attempts after the initial dial: 0 (default)
// retries forever and negative disables reconnect. BaseBackoffMs/MaxBackoffMs tune the capped exponential
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
	// Stream enables the shared UI capture loop. Script-owned clients leave
	// this false so their Recv pump owns the connection exclusively.
	Stream bool `json:"stream"`
}

// ConnInfo describes one client channel.
type ConnInfo struct {
	Name    string    `json:"name"`
	Address string    `json:"address"`
	State   ConnState `json:"state"`
}

// ListenRequest asks the service to start a listen server.
type ListenRequest struct {
	Name    string       `json:"name"`
	Address string       `json:"address"`
	Framing framing.Spec `json:"framing"`
	// Stream makes accepted connections first-class UI channels by starting
	// a Manager read loop for each one. Script-owned servers leave it false
	// and consume connections through Accept.
	Stream bool `json:"stream"`
}

// ListenInfo describes a bound server.
type ListenInfo struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// ChannelInfo is the List element: every client, server, and accepted
// server connection in one JSON-friendly row.
type ChannelInfo struct {
	Name     string    `json:"name"`
	Kind     string    `json:"kind"` // "tcp-client" | "tcp-server" | "tcp-conn"
	Address  string    `json:"address"`
	Parent   string    `json:"parent,omitempty"`
	State    ConnState `json:"state,omitempty"`
	Error    string    `json:"error,omitempty"`
	Attempts int       `json:"attempts,omitempty"`
}

// TcpService owns dial clients and listen servers by name, mirroring the
// SerialService shape (list/open/close/send/recv/status) plus
// listen/accept for servers. Every method is safe for concurrent calls.
type TcpService struct {
	mu      sync.Mutex
	clients map[string]*Client
	servers map[string]*Server
	stream  *stream.Manager
}

// AttachStream connects the RX stream manager (ticket #11). When attached,
// Open starts a per-client read loop, Close stops it, and every
// successful reconnect Resets framer residue while keeping matchers. A nil
// manager detaches and clears client hooks.
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
		state, attempts, lastErr := c.Snapshot()
		out = append(out, ChannelInfo{
			Name: name, Kind: "tcp-client", Address: c.addr,
			State: state, Error: lastErr, Attempts: attempts,
		})
	}
	for name, srv := range s.servers {
		addr := ""
		if a := srv.Addr(); a != nil {
			addr = a.String()
		}
		out = append(out, ChannelInfo{
			Name: name, Kind: "tcp-server", Address: addr, State: StateListening,
		})
		for _, id := range srv.Conns() {
			out = append(out, ChannelInfo{
				Name: id, Kind: "tcp-conn", Parent: name,
				Address: srv.RemoteAddr(id), State: StateConnected,
			})
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
	if mgr != nil && req.Stream {
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

// serverSource adapts one accepted connection. Any read failure is terminal
// for that peer, so the Manager releases the channel slot even though the
// listener remains open.
type serverSource struct {
	server *Server
	id     string
}

func (ss serverSource) Read(maxLen int) ([]byte, error) {
	data, err := ss.server.Recv(ss.id, maxLen)
	if err != nil {
		return nil, stream.ErrSourceClosed
	}
	return data, nil
}

// streamServer consumes accepted connections for a UI-owned listener and
// starts one Manager read loop per peer. Script-owned servers leave
// ListenRequest.Stream false and keep using Accept directly.
func (s *TcpService) streamServer(
	srv *Server,
	mgr *stream.Manager,
	spec framing.Spec,
) {
	for {
		id, err := srv.Accept(-1)
		if err != nil {
			return
		}
		framer, err := framing.New(spec)
		if err != nil {
			_ = srv.CloseConn(id)
			continue
		}
		if err := mgr.Start(id, serverSource{server: srv, id: id}, framer); err != nil {
			_ = srv.CloseConn(id)
			continue
		}
	}
}

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
	spec := req.Framing
	if spec.Kind == "" {
		spec = framing.DefaultSpec()
	}
	_, err := framing.New(spec)
	if err != nil {
		return ListenInfo{}, fmt.Errorf("tcp: framing: %w", err)
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
	stream := s.stream
	s.mu.Unlock()
	if req.Stream && stream != nil {
		go s.streamServer(srv, stream, spec)
	}
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
	s.mu.Lock()
	mgr := s.stream
	s.mu.Unlock()
	err = srv.CloseConn(id)
	if mgr != nil {
		mgr.Stop(id)
	}
	return err
}

// Unlisten shuts the named server and all its connections.
func (s *TcpService) Unlisten(server string) error {
	s.mu.Lock()
	srv, ok := s.servers[server]
	if ok {
		delete(s.servers, server)
	}
	mgr := s.stream
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("tcp: server %s is not listening", server)
	}
	ids := srv.Conns()
	err := srv.Close()
	if mgr != nil {
		for _, id := range ids {
			mgr.Stop(id)
		}
	}
	return err
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
