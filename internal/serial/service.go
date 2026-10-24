package serial

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"linkdeck/internal/framing"
	"linkdeck/internal/stream"
)

// OpenRequest asks the service to open a port. ReadTimeoutMs applies a read
// timeout in milliseconds: 0 leaves the library default in place, negative
// disables the timeout.
type OpenRequest struct {
	Port          string       `json:"port"`
	BaudRate      int          `json:"baudRate"`
	DataBits      int          `json:"dataBits"`
	Parity        Parity       `json:"parity"`
	StopBits      StopBits     `json:"stopBits"`
	ReadTimeoutMs int          `json:"readTimeoutMs"`
	Framing       framing.Spec `json:"framing"`
}

// SerialService exposes the serial transport to the frontend via mygo.Bind.
// It owns the open ports by name: Open is exclusive per name, and every
// method is safe for concurrent calls from any goroutine.
type SerialService struct {
	mu     sync.Mutex
	ports  map[string]*Port
	stream *stream.Manager
}

// AttachStream connects the RX stream manager (ticket #11). When attached,
// Open starts a per-port read loop and Close stops it. A nil manager
// detaches. NOT bound in main.go; the integrator owns binding.
func (s *SerialService) AttachStream(m *stream.Manager) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stream = m
}

// NewSerialService returns an empty SerialService.
func NewSerialService() *SerialService {
	return &SerialService{ports: make(map[string]*Port)}
}

// List returns all serial ports; see List for USB-detail and polling notes.
func (s *SerialService) List() ([]PortInfo, error) {
	return List()
}

// Open validates req and opens the port, reporting an error if it is already
// open through this service.
func (s *SerialService) Open(req OpenRequest) (PortInfo, error) {
	mode := Mode{BaudRate: req.BaudRate, DataBits: req.DataBits, Parity: req.Parity, StopBits: req.StopBits}
	if err := mode.Validate(); err != nil {
		return PortInfo{}, err
	}
	spec := req.Framing
	if spec.Kind == "" {
		spec = framing.DefaultSpec()
	}
	framer, err := framing.New(spec)
	if err != nil {
		return PortInfo{}, fmt.Errorf("serial: framing: %w", err)
	}
	var timeout time.Duration
	if req.ReadTimeoutMs != 0 {
		if req.ReadTimeoutMs < 0 {
			timeout = -1
		} else {
			timeout = time.Duration(req.ReadTimeoutMs) * time.Millisecond
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.ports[req.Port]; dup {
		return PortInfo{}, fmt.Errorf("serial: %s is already open", req.Port)
	}
	p, err := Open(req.Port, mode, timeout)
	if err != nil {
		return PortInfo{}, err
	}
	mgr := s.stream
	if mgr != nil {
		if serr := mgr.Start(req.Port, portSource{port: p}, framer); serr != nil {
			_ = p.Close()
			return PortInfo{}, serr
		}
	}
	s.ports[req.Port] = p
	return PortInfo{Name: req.Port}, nil
}

// Close shuts the named port; closing an unknown port is an error, closing
// twice is not (Close is idempotent, like Port.Close).
func (s *SerialService) Close(name string) error {
	s.mu.Lock()
	p, ok := s.ports[name]
	if ok {
		delete(s.ports, name)
	}
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("serial: %s is not open", name)
	}
	// Close the port first: it unblocks the read loop's in-flight Recv
	// (Manager.Stop waits for the loop to exit and cannot interrupt a
	// blocking Read itself).
	err := p.Close()
	if mgr := s.streamOf(); mgr != nil {
		mgr.Stop(name)
	}
	return err
}

// streamOf reports the attached stream manager, if any.
func (s *SerialService) streamOf() *stream.Manager {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stream
}

// portSource adapts an open Port to stream.Source.
type portSource struct{ port *Port }

// Read implements stream.Source.
func (ps portSource) Read(maxLen int) ([]byte, error) { return ps.port.Recv(maxLen) }

// Send writes data to the named open port.
func (s *SerialService) Send(name string, data []byte) (int, error) {
	p, err := s.lookup(name)
	if err != nil {
		return 0, err
	}
	return p.Send(data)
}

// Recv reads up to maxLen bytes from the named open port.
func (s *SerialService) Recv(name string, maxLen int) ([]byte, error) {
	p, err := s.lookup(name)
	if err != nil {
		return nil, err
	}
	return p.Recv(maxLen)
}

// SetReadTimeout sets the read timeout of the named open port in
// milliseconds; negative disables it.
func (s *SerialService) SetReadTimeout(name string, timeoutMs int) error {
	p, err := s.lookup(name)
	if err != nil {
		return err
	}
	timeout := time.Duration(timeoutMs) * time.Millisecond
	if timeoutMs < 0 {
		timeout = -1
	}
	return p.SetReadTimeout(timeout)
}

// Status queries the modem-line status of the named open port.
func (s *SerialService) Status(name string) (ModemStatus, error) {
	p, err := s.lookup(name)
	if err != nil {
		return ModemStatus{}, err
	}
	return p.Status()
}

func (s *SerialService) lookup(name string) (*Port, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.ports[name]
	if !ok {
		return nil, fmt.Errorf("serial: %s is not open", name)
	}
	if p == nil {
		return nil, errors.New("serial: nil port entry")
	}
	return p, nil
}
