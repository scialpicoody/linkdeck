package script

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	lua "github.com/yuin/gopher-lua"
)

// testLogs captures engine sinks.
type testLogs struct {
	mu     sync.Mutex
	out    []string
	logged []string
}

func (l *testLogs) output(s string) {
	l.mu.Lock()
	l.out = append(l.out, s)
	l.mu.Unlock()
}

func (l *testLogs) logger(s string) {
	l.mu.Lock()
	l.logged = append(l.logged, s)
	l.mu.Unlock()
}

func (l *testLogs) joinedOut() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.out, "\n")
}

func (l *testLogs) joinedLog() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.logged, "\n")
}

func newTestEngine(ft *FakeTransport) (*Engine, *testLogs) {
	logs := &testLogs{}
	e := NewEngine(EngineOptions{
		Serial: ft,
		TCP:    ft,
		Output: logs.output,
		Logger: logs.logger,
	})
	return e, logs
}

// globalString reads a Lua global after a Run.
func globalString(t *testing.T, e *Engine, name string) lua.LValue {
	t.Helper()
	var v lua.LValue
	if err := e.Exec(func(L *lua.LState) error {
		v = L.GetGlobal(name)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSerialSendExpectE2E(t *testing.T) {
	ft := NewFakeTransport()
	ft.Respond = func(sent []byte) [][]byte {
		if string(sent) == "AT\r" {
			return [][]byte{[]byte("OK\r\n")}
		}
		return nil
	}
	e, _ := newTestEngine(ft)
	defer e.Close()
	err := e.Run(`
local h, oerr = serial.open("/dev/ttyFake0", {baudrate = 115200})
assert(h ~= nil, oerr)
local data, derr = send_expect(h, "AT\r", "OK", {timeout_ms = 1000})
assert(data ~= nil, derr or "nil data")
assert(data == "OK\r\n", "got " .. tostring(data))
RESULT = data
serial.close(h)
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := globalString(t, e, "RESULT"); string(got.(lua.LString)) != "OK\r\n" {
		t.Fatalf("RESULT=%q", got.String())
	}
	sent := ft.Sent(ft.Last)
	if len(sent) != 1 || string(sent[0]) != "AT\r" {
		t.Fatalf("sent=%q", sent)
	}
	if got := len(ft.Opens); got != 1 || ft.Opens[0].Target != "/dev/ttyFake0" {
		t.Fatalf("opens=%+v", ft.Opens)
	}
	if ft.Opens[0].Opts.BaudRate != 115200 {
		t.Fatalf("baudrate=%d", ft.Opens[0].Opts.BaudRate)
	}
}

func TestTcpOpenShape(t *testing.T) {
	ft := NewFakeTransport()
	ft.Respond = func([]byte) [][]byte { return [][]byte{[]byte("READY")} }
	e, _ := newTestEngine(ft)
	defer e.Close()
	err := e.Run(`
local c, oerr = tcp.open("192.168.1.10", 502, {})
assert(c ~= nil, oerr)
local data, derr = send_expect(c, "hi", "REA", {mode = "prefix", timeout_ms = 500})
assert(data == "READY", derr or ("got " .. tostring(data)))
RESULT = data
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := globalString(t, e, "RESULT"); string(got.(lua.LString)) != "READY" {
		t.Fatalf("RESULT=%q", got.String())
	}
	if len(ft.Opens) != 1 || ft.Opens[0].Target != "192.168.1.10" {
		t.Fatalf("opens=%+v", ft.Opens)
	}
	if ft.Opens[0].Opts.Extra["port"] != "502" {
		t.Fatalf("port extra=%+v", ft.Opens[0].Opts)
	}
}

func TestExpectTimeoutIsNilPlusTimeout(t *testing.T) {
	ft := NewFakeTransport() // no Respond: silence
	e, _ := newTestEngine(ft)
	defer e.Close()
	err := e.Run(`
local h = assert(serial.open("quiet"))
local data, perr = expect(h, "NEVER", {timeout_ms = 80})
assert(data == nil, "data must be nil on timeout")
assert(perr == "timeout", "err must be 'timeout', got " .. tostring(perr))
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := globalString(t, e, "DONE"); got != lua.LTrue {
		t.Fatal("script did not reach DONE")
	}
}

func TestExpectBacklogFirstEndToEnd(t *testing.T) {
	ft := NewFakeTransport()
	e, logs := newTestEngine(ft)
	defer e.Close()
	err := e.Run(`PORT = serial.open("c0")`, 5*time.Second)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	// Unsolicited frames land before any expectation exists.
	if err := ft.Push(ft.Last, []byte("NOISE")); err != nil {
		t.Fatal(err)
	}
	if err := ft.Push(ft.Last, []byte("READY")); err != nil {
		t.Fatal(err)
	}
	err = e.Run(`
local h = PORT
local d1, e1 = expect(h, "READY", {timeout_ms = 500})
assert(d1 == "READY", e1 or "nil d1")
local d2, e2 = expect(h, "NOI", {timeout_ms = 50})
assert(d2 == "NOISE", e2 or ("nil d2: " .. tostring(d2)))
RESULT = d1 .. "|" .. d2
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := globalString(t, e, "RESULT"); string(got.(lua.LString)) != "READY|NOISE" {
		t.Fatalf("RESULT=%q", got.String())
	}
	// NOISE matched nothing on arrival: kept and routed to output (hex).
	if out := logs.joinedOut(); !strings.Contains(out, "4e4f495345") {
		t.Fatalf("unmatched NOISE never reached output sink: %q", out)
	}
}

func TestMatchModesEndToEnd(t *testing.T) {
	ft := NewFakeTransport()
	e, _ := newTestEngine(ft)
	defer e.Close()
	if err := e.Run(`PORT = serial.open("m0")`, 5*time.Second); err != nil {
		t.Fatalf("open: %v", err)
	}
	for _, push := range []string{"+CMT: 123", "v=1.2.3;"} {
		if err := ft.Push(ft.Last, []byte(push)); err != nil {
			t.Fatal(err)
		}
	}
	err := e.Run(`
local h = PORT
local d1 = assert(expect(h, "^\\+CMT: [0-9]+$", {mode = "regex", timeout_ms = 200}))
assert(d1 == "+CMT: 123", d1)
local d2 = assert(expect(h, "v=%d+.%d+.%d+;", {mode = "pattern", timeout_ms = 200}))
assert(d2 == "v=1.2.3;", d2)
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestSendExpectValidatesPatternBeforeSend(t *testing.T) {
	ft := NewFakeTransport()
	e, _ := newTestEngine(ft)
	defer e.Close()
	err := e.Run(`
local h = assert(serial.open("v0"))
local data, perr = send_expect(h, "PING", "([bad", {mode = "regex", timeout_ms = 200})
assert(data == nil, "must not match")
assert(perr ~= nil and perr ~= "timeout", "must be a validation error, got " .. tostring(perr))
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sent := ft.Sent(ft.Last); len(sent) != 0 {
		t.Fatalf("bad pattern must not consume a send: %q", sent)
	}
}

func TestRunTimeoutKillsSpin(t *testing.T) {
	e, _ := newTestEngine(NewFakeTransport())
	defer e.Close()
	start := time.Now()
	err := e.Run(`while true do end`, 200*time.Millisecond)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("spin must be killed")
	}
	var runErr *RunError
	if !errors.As(err, &runErr) || !runErr.Timeout {
		t.Fatalf("expected timeout RunError, got: %v", err)
	}
	if !strings.Contains(runErr.Message, "deadline") {
		t.Fatalf("message should name the deadline: %q", runErr.Message)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("kill took %v", elapsed)
	}
	// Engine stays usable after the kill.
	if err := e.Run(`ALIVE = 1 + 1`, time.Second); err != nil {
		t.Fatalf("engine not reusable: %v", err)
	}
	if got := globalString(t, e, "ALIVE"); got != lua.LNumber(2) {
		t.Fatalf("ALIVE=%v", got)
	}
}

func TestRunErrorCarriesLineNumbers(t *testing.T) {
	e, _ := newTestEngine(NewFakeTransport())
	defer e.Close()
	err := e.Run("local x = 1\nlocal y = 2\nerror(\"boom\")\n", 5*time.Second)
	if err == nil {
		t.Fatal("expected error")
	}
	var runErr *RunError
	if !errors.As(err, &runErr) {
		t.Fatalf("expected *RunError, got %T", err)
	}
	if runErr.Timeout {
		t.Fatalf("must not be a timeout: %v", err)
	}
	if !strings.Contains(runErr.StackTrace, ":3:") {
		t.Fatalf("stack trace lacks line 3: %v", err)
	}
	var apiErr *lua.ApiError
	if !errors.As(err, &apiErr) {
		t.Fatal("Unwrap should expose *lua.ApiError")
	}
}

func TestRecvRawAndTimeout(t *testing.T) {
	ft := NewFakeTransport()
	e, _ := newTestEngine(ft)
	defer e.Close()
	if err := e.Run(`PORT = serial.open("r0")`, 5*time.Second); err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := ft.Push(ft.Last, []byte("raw-bytes")); err != nil {
		t.Fatal(err)
	}
	err := e.Run(`
local h = PORT
local d = assert(serial.recv(h, 500))
assert(d == "raw-bytes", d)
local d2, e2 = serial.recv(h, 60)
assert(d2 == nil and e2 == "timeout", "want nil+timeout, got " .. tostring(d2) .. "/" .. tostring(e2))
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestHelpers(t *testing.T) {
	e, logs := newTestEngine(NewFakeTransport())
	defer e.Close()
	err := e.Run(`
log("hello", 42, true)
assert(hex.encode("ABC") == "414243")
local raw, herr = hex.decode("414243")
assert(raw == "ABC", herr or "?")
local bad, berr = hex.decode("zz")
assert(bad == nil and berr ~= nil, "bad hex must fail")
local enc = assert(json.encode({name = "link", n = 3, tags = {"a", "b"}}))
local dec = assert(json.decode(enc))
assert(dec.name == "link" and dec.n == 3 and dec.tags[2] == "b", enc)
assert(json.encode({}) == "{}", "empty table encodes as {}")
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := logs.joinedLog(); !strings.Contains(got, "hello\t42\ttrue") {
		t.Fatalf("log sink got %q", got)
	}
}

func TestJsonCycleFails(t *testing.T) {
	e, _ := newTestEngine(NewFakeTransport())
	defer e.Close()
	err := e.Run(`
local t = {}
t.self = t
local enc, jerr = json.encode(t)
assert(enc == nil and jerr ~= nil, "cycle must fail")
local enc2, jerr2 = json.encode(print)
assert(enc2 == nil and jerr2 ~= nil, "function must fail")
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestListenAccept(t *testing.T) {
	ft := NewFakeTransport()
	e, _ := newTestEngine(ft)
	defer e.Close()
	// Pre-stage the accepted connection with an inbound greeting.
	conn, err := ft.Open("conn0", OpenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := ft.Push(conn, []byte("HELLO")); err != nil {
		t.Fatal(err)
	}
	if err := e.Run(`LISTENER = assert(tcp.listen(9999))`, 5*time.Second); err != nil {
		t.Fatalf("listen: %v", err)
	}
	if last := ft.Opens[len(ft.Opens)-1]; len(ft.Opens) != 2 || !last.Listen || last.Port != 9999 {
		t.Fatalf("opens=%+v", ft.Opens)
	}
	if err := ft.StageAccept(ft.Last, conn); err != nil {
		t.Fatal(err)
	}
	err = e.Run(`
local c = assert(tcp.accept(LISTENER, 500))
local d = assert(expect(c, "HEL", {timeout_ms = 500}))
assert(d == "HELLO", d)
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := globalString(t, e, "DONE"); got != lua.LTrue {
		t.Fatal("script did not reach DONE")
	}
}

func TestOpenFailureSurfaces(t *testing.T) {
	ft := NewFakeTransport()
	ft.OpenErr = errors.New("no such port")
	e, _ := newTestEngine(ft)
	defer e.Close()
	err := e.Run(`
local h, oerr = serial.open("/dev/missing", {})
assert(h == nil and oerr == "no such port", "want nil+err, got " .. tostring(h) .. "/" .. tostring(oerr))
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestUnconfiguredTransportFailsCleanly(t *testing.T) {
	logs := &testLogs{}
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), Output: logs.output, Logger: logs.logger})
	defer e.Close()
	err := e.Run(`
local h, oerr = tcp.open("10.0.0.1", 80, {})
assert(h == nil and oerr == "tcp transport not configured", tostring(oerr))
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestClosedHandleReuse(t *testing.T) {
	ft := NewFakeTransport()
	e, _ := newTestEngine(ft)
	defer e.Close()
	err := e.Run(`
local h = assert(serial.open("c9"))
assert(serial.close(h) == nil, "close must succeed")
local d, cerr = serial.close(h)
assert(d ~= nil, "second close must report an error value")
local r, rerr = serial.recv(h, 50)
assert(r == nil and rerr == "unknown or closed handle", tostring(rerr))
DONE = true
`, 5*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestCrossGoroutineFeedResolvesExpect(t *testing.T) {
	ft := NewFakeTransport()
	e, _ := newTestEngine(ft)
	defer e.Close()
	if err := e.Run(`PORT = serial.open("g0")
READY = false`, 5*time.Second); err != nil {
		t.Fatalf("open: %v", err)
	}
	runErr := make(chan error, 1)
	go func() {
		runErr <- e.Run(`
local d = assert(expect(PORT, "PING", {timeout_ms = 3000}))
RESULT = d
`, 5*time.Second)
	}()
	time.Sleep(100 * time.Millisecond)
	// A host-side pump (future real transports) feeds from any goroutine.
	if !e.Feed(NewRxFrame("g0", []byte("PING-1"))) {
		t.Fatal("Feed should match the pending expect")
	}
	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cross-goroutine Feed never resolved expect")
	}
	if got := globalString(t, e, "RESULT"); string(got.(lua.LString)) != "PING-1" {
		t.Fatalf("RESULT=%q", got.String())
	}
}

func TestFrameDTORoundTrip(t *testing.T) {
	f := NewRxFrame("ttyUSB0", []byte{0x01, 0x02, 0xff})
	dto := f.ToDTO()
	if dto.Payload != "AQL/" {
		t.Fatalf("base64=%q", dto.Payload)
	}
	back, err := dto.ToFrame()
	if err != nil {
		t.Fatal(err)
	}
	if back.Channel != "ttyUSB0" || back.Dir != DirRx || string(back.Payload) != string(f.Payload) {
		t.Fatalf("round trip: %+v", back)
	}
	if _, err := (FrameDTO{Payload: "!!!nope"}).ToFrame(); err == nil {
		t.Fatal("bad base64 must fail")
	}
}

func TestScriptServiceFacade(t *testing.T) {
	ft := NewFakeTransport()
	ft.Respond = func([]byte) [][]byte { return [][]byte{[]byte("pong")} }
	svc := NewScriptService(NewEngine(EngineOptions{Serial: ft, TCP: ft}))
	defer svc.Close()
	if err := svc.Run(`local h = assert(serial.open("s0"))
assert(send_expect(h, "ping", "pong", {timeout_ms = 500}) == "pong")`, 5000); err != nil {
		t.Fatalf("Service.Run: %v", err)
	}
	if !svc.Feed(NewRxFrame("s0", []byte("stray"))) {
		// No pending matcher: kept as backlog, Feed reports false.
	} else {
		t.Fatal("Feed with no registrations must not match")
	}
}
