package script

import (
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/creack/pty"
	"linkdeck/internal/serial"
	"linkdeck/internal/tcp"
)

// startATServer runs a loopback TCP server that answers one AT probe with
// OK. It returns the port; the listener closes on test cleanup.
func startATServer(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(10 * time.Second))
				buf := make([]byte, 3)
				if _, err := io.ReadFull(c, buf); err != nil {
					return
				}
				if string(buf) == "AT\r" {
					_, _ = c.Write([]byte("OK\r\n"))
				}
			}(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestRealTCPSerialSendExpect(t *testing.T) {
	port := startATServer(t)
	e := NewEngine(EngineOptions{TCP: NewTCPTransport(tcp.NewTcpService())})
	defer e.Close()
	err := e.Run(fmt.Sprintf(`
local c, oerr = tcp.open("127.0.0.1", %d, {})
assert(c ~= nil, oerr)
local data, derr = send_expect(c, "AT\r", "OK", {timeout_ms = 5000})
assert(data == "OK\r\n", (derr or ("got " .. tostring(data))))
tcp.close(c)
DONE = true
`, port), 15*time.Second)
	if err != nil {
		t.Fatalf("real TCP send_expect: %v", err)
	}
}

func TestRealTCPListenAccept(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	e := NewEngine(EngineOptions{TCP: NewTCPTransport(tcp.NewTcpService())})
	defer e.Close()
	if err := e.Run(fmt.Sprintf(`LISTENER = assert(tcp.listen(%d))`, port), 5*time.Second); err != nil {
		t.Fatalf("listen: %v", err)
	}
	// A raw client greets the scripted server.
	go func() {
		c, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = c.Write([]byte("HELLO"))
		time.Sleep(2 * time.Second)
	}()
	err = e.Run(`
local c = assert(tcp.accept(LISTENER, 5000))
local d = assert(expect(c, "HEL", {timeout_ms = 5000}))
assert(d == "HELLO", d)
DONE = true
`, 15*time.Second)
	if err != nil {
		t.Fatalf("accept/expect: %v", err)
	}
}

func TestRealTCPExpectTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			// Silent: hold the connection, never speak.
			go func() { time.Sleep(10 * time.Second); c.Close() }()
		}
	}()

	e := NewEngine(EngineOptions{TCP: NewTCPTransport(tcp.NewTcpService())})
	defer e.Close()
	err = e.Run(fmt.Sprintf(`
local c = assert(tcp.open("127.0.0.1", %d, {}))
local d, derr = expect(c, "NEVER", {timeout_ms = 200})
assert(d == nil and derr == "timeout", "want nil+timeout, got " .. tostring(d) .. "/" .. tostring(derr))
DONE = true
`, port), 15*time.Second)
	if err != nil {
		t.Fatalf("expect timeout over real TCP: %v", err)
	}
}

// openPTYMaster opens a PTY pair and returns the slave path with the master
// end. The slave *os.File stays open for the test: closing it early can hang
// up the port on some platforms.
func openPTYMaster(t *testing.T) (string, *os.File) {
	t.Helper()
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = master.Close() })
	t.Cleanup(func() { _ = slave.Close() })
	return slave.Name(), master
}

func TestRealSerialPTYEndToEnd(t *testing.T) {
	slave, master := openPTYMaster(t)
	// The peer answers one AT probe, then leaves.
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = master.SetReadDeadline(time.Now().Add(10 * time.Second))
		buf := make([]byte, 3)
		if _, err := io.ReadFull(master, buf); err != nil {
			return
		}
		if string(buf) == "AT\r" {
			_, _ = master.Write([]byte("OK\r\n"))
		}
	}()
	defer func() { <-done }()

	e := NewEngine(EngineOptions{Serial: NewSerialTransport(serial.NewSerialService())})
	defer e.Close()
	err := e.Run(fmt.Sprintf(`
local h, oerr = serial.open(%q, {baudrate = 115200})
assert(h ~= nil, oerr)
local data, derr = send_expect(h, "AT\r", "OK", {timeout_ms = 5000})
assert(data == "OK\r\n", (derr or ("got " .. tostring(data))))
serial.close(h)
DONE = true
`, slave), 15*time.Second)
	if err != nil {
		t.Fatalf("real serial send_expect over PTY: %v", err)
	}
}
