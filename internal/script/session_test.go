package script

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// writeScript drops content in a temp file and returns its path.
func writeScript(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "case.lua")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// rewriteScript replaces the file and forces a newer mtime so reload
// detection never depends on filesystem timestamp granularity.
func rewriteScript(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
}

func callOne(t *testing.T, s *Session, fn string, args ...any) any {
	t.Helper()
	rets, err := s.Call(fn, 5*time.Second, args...)
	if err != nil {
		t.Fatalf("Call(%s): %v", fn, err)
	}
	if len(rets) != 1 {
		t.Fatalf("Call(%s) returned %d values, want 1", fn, len(rets))
	}
	return rets[0]
}

func TestRunFileIsolation(t *testing.T) {
	ft := NewFakeTransport()
	e := NewEngine(EngineOptions{Serial: ft, TCP: ft})
	defer e.Close()

	path := writeScript(t, "N = (N or 0) + 1\nassert(N == 1, \"state leaked between runs\")\n")
	if err := e.RunFile(path, 5*time.Second); err != nil {
		t.Fatalf("first RunFile: %v", err)
	}
	if err := e.RunFile(path, 5*time.Second); err != nil {
		t.Fatalf("second RunFile must not see the first run's globals: %v", err)
	}

	other := writeScript(t, "assert(N == nil, \"globals leak across files\")\n")
	if err := e.RunFile(other, 5*time.Second); err != nil {
		t.Fatalf("cross-file isolation: %v", err)
	}
}

func TestRunFileMissing(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	if err := e.RunFile(filepath.Join(t.TempDir(), "missing.lua"), time.Second); err == nil {
		t.Fatal("missing file must fail")
	}
}

func TestRunFileErrorCarriesLines(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	path := writeScript(t, "local x = 1\nlocal y = 2\nerror(\"boom\")\n")
	err := e.RunFile(path, 5*time.Second)
	var runErr *RunError
	if !errors.As(err, &runErr) || runErr.Timeout {
		t.Fatalf("want non-timeout *RunError, got: %v", err)
	}
	if !strings.Contains(runErr.StackTrace, ":3:") {
		t.Fatalf("stack trace lacks line 3: %v", err)
	}
}

func TestSessionPersistsState(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	path := writeScript(t, `
count = 0
function bump(by)
  count = count + by
  return count
end
`)
	s, err := e.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := callOne(t, s, "bump", 1); got != float64(1) {
		t.Fatalf("bump = %v (%T), want 1", got, got)
	}
	if got := callOne(t, s, "bump", 2); got != float64(3) {
		t.Fatalf("second bump = %v, want 3 (state must persist)", got)
	}
}

func TestSessionRegistryKeying(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	dir := t.TempDir()
	path := filepath.Join(dir, "keyed.lua")
	if err := os.WriteFile(path, []byte("function f() return 1 end\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	a, err := e.Load(abs)
	if err != nil {
		t.Fatal(err)
	}
	b, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("same file via different spellings must return the same session")
	}
	if a.Path() != abs {
		t.Fatalf("registry key must be the absolute path, got %q", a.Path())
	}
}

func TestSessionMtimeReload(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	path := writeScript(t, `
count = 0
function tag() return "v1" end
function bump() count = count + 1 return count end
`)
	s, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := callOne(t, s, "tag"); got != "v1" {
		t.Fatalf("tag = %v", got)
	}
	if got := callOne(t, s, "bump"); got != float64(1) {
		t.Fatalf("bump = %v", got)
	}
	rewriteScript(t, path, `
count = 0
function tag() return "v2" end
function bump() count = count + 1 return count end
`)
	if got := callOne(t, s, "tag"); got != "v2" {
		t.Fatalf("tag after edit = %v, want v2 (mtime reload)", got)
	}
	// Reload resets Lua globals: the counter restarts.
	if got := callOne(t, s, "bump"); got != float64(1) {
		t.Fatalf("bump after reload = %v, want 1 (fresh state)", got)
	}
}

func TestSessionBrokenEditKeepsOld(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	path := writeScript(t, "function f() return \"good\" end\n")
	s, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	rewriteScript(t, path, "function f( return BROKEN\n")
	if _, err := s.Call("f", 5*time.Second); err == nil {
		t.Fatal("broken edit must fail the call")
	} else if !strings.Contains(err.Error(), "reload") {
		t.Fatalf("error should name the reload, got: %v", err)
	}
	// The previous generation survives: fix the file and calls work again.
	rewriteScript(t, path, "function f() return \"fixed\" end\n")
	if got := callOne(t, s, "f"); got != "fixed" {
		t.Fatalf("f after fix = %v", got)
	}
}

func TestSessionCallTimeoutKills(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	path := writeScript(t, `
function spin() while true do end end
function alive() return 42 end
`)
	s, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = s.Call("spin", 150*time.Millisecond)
	if err == nil {
		t.Fatal("spin must be killed")
	}
	var runErr *RunError
	if !errors.As(err, &runErr) || !runErr.Timeout {
		t.Fatalf("want timeout *RunError, got: %v", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("kill took %v", time.Since(start))
	}
	// The session stays usable after the kill.
	if got := callOne(t, s, "alive"); got != float64(42) {
		t.Fatalf("alive = %v", got)
	}
}

func TestSessionCallErrors(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	path := writeScript(t, `
function two() return "a", 2 end
function sum(t) local s = 0 for _, v in ipairs(t) do s = s + v end return s end
function leakfn() return print end
`)
	s, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Call("nosuchfn", 5*time.Second); err == nil {
		t.Fatal("missing function must fail")
	}
	rets, err := s.Call("two", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(rets) != 2 || rets[0] != "a" || rets[1] != float64(2) {
		t.Fatalf("two() = %v", rets)
	}
	rets, err = s.Call("sum", 5*time.Second, []any{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(rets) != 1 || rets[0] != float64(6) {
		t.Fatalf("sum = %v", rets)
	}
	if _, err := s.Call("leakfn", 5*time.Second); err == nil {
		t.Fatal("function return values must fail conversion")
	}
}

func TestSessionCloseEvicts(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	path := writeScript(t, "count = 0\nfunction bump() count = count + 1 return count end\n")
	s, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := callOne(t, s, "bump"); got != float64(1) {
		t.Fatalf("bump = %v", got)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("double close must be nil: %v", err)
	}
	if !s.Closed() {
		t.Fatal("Closed() must report true")
	}
	if _, err := s.Call("bump", 5*time.Second); !errors.Is(err, ErrClosed) {
		t.Fatalf("calls after close must fail with ErrClosed, got: %v", err)
	}
	// Evicted: the next Load starts over.
	s2, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if s2 == s {
		t.Fatal("Load after close must mint a new session")
	}
	if got := callOne(t, s2, "bump"); got != float64(1) {
		t.Fatalf("fresh session bump = %v, want 1", got)
	}
}

func TestSessionSendExpectFake(t *testing.T) {
	ft := NewFakeTransport()
	ft.Respond = func(sent []byte) [][]byte {
		if string(sent) == "AT\r" {
			return [][]byte{[]byte("OK\r\n")}
		}
		return nil
	}
	e := NewEngine(EngineOptions{Serial: ft, TCP: ft})
	defer e.Close()
	path := writeScript(t, `
h = assert(serial.open("/dev/ttyFake0", {baudrate = 115200}))
function ping()
  local data, derr = send_expect(h, "AT\r", "OK", {timeout_ms = 1000})
  assert(data ~= nil, derr or "nil data")
  return data
end
`)
	s, err := e.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	for i := range 2 {
		if got := callOne(t, s, "ping"); got != "OK\r\n" {
			t.Fatalf("ping %d = %q", i, got)
		}
	}
}

func TestSharedRegistryAcrossModes(t *testing.T) {
	ft := NewFakeTransport()
	e := NewEngine(EngineOptions{Serial: ft, TCP: ft})
	defer e.Close()

	path := writeScript(t, "SH = assert(serial.open(\"shared-s\"))\n")
	s, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Run("RH = assert(serial.open(\"shared-r\"))\n", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	e.hmu.Lock()
	n := len(e.handles)
	e.hmu.Unlock()
	if n != 2 {
		t.Fatalf("both modes must draw from one registry, got %d handles", n)
	}

	// Fresh runs clean up what they mint.
	fresh := writeScript(t, "local h = assert(serial.open(\"fresh-x\"))\n")
	if err := e.RunFile(fresh, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	e.hmu.Lock()
	n = len(e.handles)
	e.hmu.Unlock()
	if n != 2 {
		t.Fatalf("fresh-run teardown must close its handles, got %d", n)
	}

	// Session close drops only its own generation.
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	e.hmu.Lock()
	n = len(e.handles)
	e.hmu.Unlock()
	if n != 1 {
		t.Fatalf("session close must drop its handles, got %d", n)
	}
	if err := e.Run("assert(serial.close(RH) == nil)\n", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	e.hmu.Lock()
	n = len(e.handles)
	e.hmu.Unlock()
	if n != 0 {
		t.Fatalf("registry must drain, got %d", n)
	}
}

func TestLuaScriptLoadAndRun(t *testing.T) {
	ft := NewFakeTransport()
	e := NewEngine(EngineOptions{Serial: ft, TCP: ft})
	defer e.Close()
	sessPath := writeScript(t, "n = 0\nfunction bump(by) n = n + by return n end\n")
	runPath := writeScript(t, "RAN = (RAN or 0) + 1\n")
	err := e.Run(`
local s, lerr = script.load("`+sessPath+`")
assert(s ~= nil, lerr)
assert(tostring(s) == "session(`+sessPath+`)")
local v = assert(s:call("bump", 10))
assert(v == 10, "got " .. tostring(v))
local v2 = assert(s:call("bump", 5))
assert(v2 == 15, "got " .. tostring(v2))
assert(s:close() == nil, "close must succeed")
assert(run("`+runPath+`") == true, "run must succeed")
assert(run("`+runPath+`") == true, "run must succeed")
DONE = true
`, 10*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if err := e.Run(`assert(RAN == nil, "run() must not leak into the caller state")`, 5*time.Second); err != nil {
		t.Fatalf("run isolation: %v", err)
	}
}

func TestLuaSessionCallTimeoutString(t *testing.T) {
	e := NewEngine(EngineOptions{Serial: NewFakeTransport(), TCP: NewFakeTransport()})
	defer e.Close()
	path := writeScript(t, "function spin() while true do end end\n")
	err := e.Run(`
local s = assert(script.load("`+path+`"))
local d, derr = s:call("spin")
assert(d == nil and derr == "timeout", "want nil+timeout, got " .. tostring(d) .. "/" .. tostring(derr))
DONE = true
`, 10*time.Second)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestConcurrentSessionsRace(t *testing.T) {
	ft := NewFakeTransport()
	e := NewEngine(EngineOptions{Serial: ft, TCP: ft})
	defer e.Close()
	path := writeScript(t, "n = 0\nfunction bump() n = n + 1 return n end\n")
	s1, err := e.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	other := writeScript(t, "function id(x) return x end\n")
	s2, err := e.Load(other)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := s1.Call("bump", 5*time.Second); err != nil {
				t.Error(err)
				return
			}
			if _, err := s2.Call("id", 5*time.Second, i); err != nil {
				t.Error(err)
			}
		}(i)
		if err := e.RunFile(other, 5*time.Second); err != nil {
			t.Error(err)
		}
		e.Feed(NewRxFrame("race", []byte("PING")))
	}
	wg.Wait()
}
