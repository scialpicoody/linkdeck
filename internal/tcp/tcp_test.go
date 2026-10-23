package tcp

import (
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// waitFor polls cond until true or the timeout elapses.
func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	require.Fail(t, "timed out waiting for "+what)
}

func waitState(t *testing.T, c *Client, want ConnState, timeout time.Duration) {
	t.Helper()
	waitFor(t, "state "+string(want), timeout, func() bool { return c.Status() == want })
}

// startEcho runs a raw echo listener on 127.0.0.1:0. dropFirst, when true,
// closes the first accepted connection after echoing one message to force a
// client reconnect; later connections echo cleanly.
func startEcho(t *testing.T, dropFirst bool) (addr string, closeAll func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	var first atomic.Bool
	first.Store(dropFirst)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				drop := first.Swap(false)
				buf := make([]byte, 64*1024)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(buf[:n])
				if drop {
					return // close: forces the client to reconnect
				}
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()
	return ln.Addr().String(), func() { _ = ln.Close() }
}

func fastOpts() ClientOptions {
	return ClientOptions{ConnectTimeoutMs: 2000, BaseBackoffMs: 10, MaxBackoffMs: 50}
}

func TestBackoffSequence(t *testing.T) {
	base, max := normalizeBackoff(0, 0)
	require.Equal(t, DefaultBaseBackoff, base)
	require.Equal(t, DefaultMaxBackoff, max)
	// Pre-jitter capped values: 100 200 400 800 1600 3200 5000 5000.
	capped := []time.Duration{
		100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond,
		800 * time.Millisecond, 1600 * time.Millisecond, 3200 * time.Millisecond,
		5000 * time.Millisecond, 5000 * time.Millisecond,
	}
	for i, want := range capped {
		for range 50 {
			d := backoff(i, DefaultBaseBackoff, DefaultMaxBackoff)
			require.GreaterOrEqual(t, d, want, "attempt %d", i)
			require.LessOrEqual(t, d, want+want/4, "attempt %d", i)
		}
	}
}

func TestClientEcho(t *testing.T) {
	addr, stop := startEcho(t, false)
	defer stop()

	svc := NewTcpService()
	info, err := svc.Open(OpenRequest{Name: "echo", Address: addr, ConnectTimeoutMs: 2000})
	require.NoError(t, err)
	require.Equal(t, StateConnected, info.State)

	st, err := svc.Status("echo")
	require.NoError(t, err)
	require.Equal(t, StateConnected, st)

	n, err := svc.Send("echo", []byte("hello"))
	require.NoError(t, err)
	require.Equal(t, 5, n)
	got, err := svc.Recv("echo", 1024)
	require.NoError(t, err)
	require.Equal(t, "hello", string(got))

	require.NoError(t, svc.Close("echo"))
	st, err = svc.Status("echo")
	require.Error(t, err) // unknown after close
	require.Empty(t, st)
	_, err = svc.Send("echo", []byte("x"))
	require.Error(t, err)
}

func TestReconnectAfterServerDrop(t *testing.T) {
	addr, stop := startEcho(t, true)
	defer stop()

	c, err := Dial("re", addr, fastOpts())
	require.NoError(t, err)
	require.Equal(t, StateConnected, c.Status())
	defer c.Close()

	// First exchange, then the server drops the connection.
	_, err = c.Send([]byte("first"))
	require.NoError(t, err)
	got, err := c.Recv(1024)
	require.NoError(t, err)
	require.Equal(t, "first", string(got))

	// The drop surfaces as a read error. Poll a failing read: it both
	// observes the drop and kicks the reconnect loop.
	waitFor(t, "drop observed", 5*time.Second, func() bool {
		_, rerr := c.Recv(1024)
		return rerr != nil
	})
	waitState(t, c, StateConnected, 5*time.Second)

	// Fresh connection carries traffic again. Retry the round-trip: an
	// iteration whose send fails only means the new connection is not up
	// yet; a send that succeeds is always followed by its echo (or a
	// detectable error), so Recv here always terminates.
	waitFor(t, "traffic after reconnect", 5*time.Second, func() bool {
		if _, serr := c.Send([]byte("second")); serr != nil {
			return false
		}
		got2, rerr := c.Recv(1024)
		if rerr != nil {
			return false
		}
		return string(got2) == "second"
	})
}

func TestSendFailsFastWhileUnconnected(t *testing.T) {
	// Nothing listens here: Dial yields a reconnecting client.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())

	c, err := Dial("down", addr, fastOpts())
	require.NoError(t, err)
	defer c.Close()
	require.Equal(t, StateReconnecting, c.Status())

	start := time.Now()
	_, serr := c.Send([]byte("x"))
	require.Error(t, serr)
	require.Less(t, time.Since(start), 2*time.Second, "send must fail fast, not wait for reconnect")
	_, rerr := c.Recv(1024)
	require.Error(t, rerr)
}

func TestMaxRetriesExhaustsToClosed(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())

	opts := fastOpts()
	opts.MaxRetries = 2
	c, err := Dial("capped", addr, opts)
	require.NoError(t, err)
	defer c.Close()
	waitState(t, c, StateClosed, 5*time.Second)
}

func TestMultiConnIsolation(t *testing.T) {
	addr, stop := startEcho(t, false)
	defer stop()

	a, err := Dial("a", addr, fastOpts())
	require.NoError(t, err)
	defer a.Close()
	b, err := Dial("b", addr, fastOpts())
	require.NoError(t, err)
	defer b.Close()

	_, err = a.Send([]byte("msg-a"))
	require.NoError(t, err)
	_, err = b.Send([]byte("msg-b"))
	require.NoError(t, err)

	ga, err := a.Recv(1024)
	require.NoError(t, err)
	gb, err := b.Recv(1024)
	require.NoError(t, err)
	require.Equal(t, "msg-a", string(ga))
	require.Equal(t, "msg-b", string(gb))
}

func TestServerAcceptAndPerConnIO(t *testing.T) {
	svc := NewTcpService()
	li, err := svc.Listen(ListenRequest{Name: "srv", Address: "127.0.0.1:0"})
	require.NoError(t, err)
	defer svc.Unlisten("srv")

	raw1, err := net.Dial("tcp", li.Address)
	require.NoError(t, err)
	defer raw1.Close()
	raw2, err := net.Dial("tcp", li.Address)
	require.NoError(t, err)
	defer raw2.Close()

	c1, err := svc.Accept("srv", 2000)
	require.NoError(t, err)
	c2, err := svc.Accept("srv", 2000)
	require.NoError(t, err)
	require.NotEqual(t, c1.Name, c2.Name)

	// Independent send/recv per connection: write distinct payloads from
	// the server side, read them on the matching raw socket only.
	_, err = svc.ServerSend("srv", c1.Name, []byte("one"))
	require.NoError(t, err)
	_, err = svc.ServerSend("srv", c2.Name, []byte("two"))
	require.NoError(t, err)
	buf1 := make([]byte, 16)
	_ = raw1.SetReadDeadline(time.Now().Add(2 * time.Second))
	n1, err := raw1.Read(buf1)
	require.NoError(t, err)
	require.Equal(t, "one", string(buf1[:n1]))
	buf2 := make([]byte, 16)
	_ = raw2.SetReadDeadline(time.Now().Add(2 * time.Second))
	n2, err := raw2.Read(buf2)
	require.NoError(t, err)
	require.Equal(t, "two", string(buf2[:n2]))

	// Client-to-server direction is per-conn too.
	_, err = raw1.Write([]byte("up-one"))
	require.NoError(t, err)
	_, err = raw2.Write([]byte("up-two"))
	require.NoError(t, err)
	g1, err := svc.ServerRecv("srv", c1.Name, 1024)
	require.NoError(t, err)
	require.Equal(t, "up-one", string(g1))
	g2, err := svc.ServerRecv("srv", c2.Name, 1024)
	require.NoError(t, err)
	require.Equal(t, "up-two", string(g2))

	// Closing one connection leaves the other usable.
	require.NoError(t, svc.ServerClose("srv", c1.Name))
	_, err = svc.ServerSend("srv", c2.Name, []byte("still-here"))
	require.NoError(t, err)
	_ = raw2.SetReadDeadline(time.Now().Add(2 * time.Second))
	n3, err := raw2.Read(buf2)
	require.NoError(t, err)
	require.Equal(t, "still-here", string(buf2[:n3]))

	conns, err := svc.ServerConns("srv")
	require.NoError(t, err)
	require.Len(t, conns, 1)
	require.Equal(t, c2.Name, conns[0].Name)
}

func TestServiceListAndHeartbeat(t *testing.T) {
	addr, stop := startEcho(t, false)
	defer stop()

	svc := NewTcpService()
	_, err := svc.Open(OpenRequest{
		Name: "hb", Address: addr, ConnectTimeoutMs: 2000,
		BaseBackoffMs: 10, MaxBackoffMs: 50,
		HeartbeatMs: 20, HeartbeatPayload: []byte("ping"),
	})
	require.NoError(t, err)
	defer svc.Close("hb")
	_, err = svc.Listen(ListenRequest{Name: "srv", Address: "127.0.0.1:0"})
	require.NoError(t, err)
	defer svc.Unlisten("srv")

	rows, err := svc.List()
	require.NoError(t, err)
	kinds := map[string]int{}
	for _, r := range rows {
		kinds[r.Kind]++
	}
	require.Equal(t, 1, kinds["tcp-client"])
	require.Equal(t, 1, kinds["tcp-server"])

	// Heartbeat bytes share the stream, so our payload may arrive coalesced
	// with reflected pings or split across reads: accumulate until it
	// appears. A corrupted stream would never contain it intact.
	_, err = svc.Send("hb", []byte("framed-msg"))
	require.NoError(t, err)
	var seen []byte
	waitFor(t, "framed echo", 5*time.Second, func() bool {
		got, rerr := svc.Recv("hb", 1024)
		if rerr != nil {
			return false
		}
		seen = append(seen, got...)
		return strings.Contains(string(seen), "framed-msg")
	})
	st, err := svc.Status("hb")
	require.NoError(t, err)
	require.Equal(t, StateConnected, st)
}
