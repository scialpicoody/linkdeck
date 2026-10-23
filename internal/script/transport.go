package script

// OpenOptions carries channel-open parameters from Lua option tables.
//
// Serial callers fill BaudRate/Framing; TCP callers pass host in target
// with the port in Extra["port"]. Anything the table holds beyond the
// known fields lands in Extra as strings for future transports.
type OpenOptions struct {
	BaudRate  int
	TimeoutMs int
	Framing   string
	Extra     map[string]string
}

// Handle is the opaque Lua-side reference to an open channel. Scripts hold
// it as userdata: usable through the scripting API, never inspectable.
// The zero value is invalid.
type Handle string

// Transport is one script-visible channel family (serial ports, TCP
// connections). Engine routes each Lua table (serial, tcp) to one
// Transport; real drivers plug in later by implementing this interface.
//
// Contract:
//   - Open mints a backend-local handle for target and reports errors for
//     bad targets/options; it must not block longer than necessary.
//   - Recv waits up to timeoutMs for bytes and returns ErrTimeout when the
//     wait expires with nothing received; timeoutMs < 0 waits without a
//     deadline. Recv must be safe to call repeatedly: the engine polls in
//     short slices so run timeouts preempt blocked expects.
//   - All methods are safe for concurrent use.
type Transport interface {
	Open(target string, opts OpenOptions) (Handle, error)
	Close(h Handle) error
	Send(h Handle, data []byte) error
	Recv(h Handle, timeoutMs int) ([]byte, error)
}

// ListenerTransport is an optional extension for transports that accept
// inbound connections (TCP servers). Engine exposes tcp.listen/tcp.accept
// only when the tcp Transport implements it; otherwise those calls fail
// with a Lua "not supported" error.
type ListenerTransport interface {
	Transport
	Listen(port int, opts OpenOptions) (Handle, error)
	Accept(h Handle, timeoutMs int) (Handle, error)
}
