package script

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	lua "github.com/yuin/gopher-lua"
)

// defaultScriptTimeout applies when Run/RunFile/Call get a non-positive timeout.
const defaultScriptTimeout = 5 * time.Second

// sessionMetatable names the Lua userdata metatable for script sessions.
const sessionMetatable = "LinkDeckSession"

// execReg is one in-flight execution's kill switch: the context the LState
// checks on every instruction plus the cancel that ends it.
type execReg struct {
	ctx    context.Context
	cancel context.CancelFunc
}

// expired reports whether the owning execution's deadline passed. A nil
// context (no execution registered for this LState) never expires: expect
// deadlines still apply, only the run/call kill switch is absent.
func expired(ctx context.Context) bool {
	return ctx != nil && ctx.Err() != nil
}

// beginExec registers a timeout execution for L and arms the VM kill switch.
// Every LState runs at most one execution at a time (main LState under
// execMu, sessions under their own mutex, fresh states single-use), so one
// registration per LState is enough. Close cancels every registration.
func (e *Engine) beginExec(L *lua.LState, timeout time.Duration) context.Context {
	if timeout <= 0 {
		timeout = defaultScriptTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	e.exMu.Lock()
	e.execs[L] = execReg{ctx: ctx, cancel: cancel}
	e.exMu.Unlock()
	L.SetContext(ctx)
	return ctx
}

// endExec disarms L and drops its registration.
func (e *Engine) endExec(L *lua.LState) {
	L.RemoveContext()
	e.exMu.Lock()
	reg, ok := e.execs[L]
	if ok {
		delete(e.execs, L)
	}
	e.exMu.Unlock()
	if ok {
		reg.cancel()
	}
}

// ctxFor returns the in-flight execution context for L, or nil when L is
// idle. Blocking callbacks resolve it at entry so waits die with their own
// execution, whichever LState drives them.
func (e *Engine) ctxFor(L *lua.LState) context.Context {
	e.exMu.Lock()
	defer e.exMu.Unlock()
	if reg, ok := e.execs[L]; ok {
		return reg.ctx
	}
	return nil
}

// cancelAllExecs kills every in-flight execution. Close calls it before
// tearing states down.
func (e *Engine) cancelAllExecs() {
	e.exMu.Lock()
	regs := make([]execReg, 0, len(e.execs))
	for _, reg := range e.execs {
		regs = append(regs, reg)
	}
	e.exMu.Unlock()
	for _, reg := range regs {
		reg.cancel()
	}
}

// runErrorOf builds the *RunError for a failed chunk, sharing Run's shape:
// the Lua message plus source/line stack trace, Timeout when the execution
// context died first.
func runErrorOf(ctx context.Context, err error) *RunError {
	runErr := &RunError{Message: err.Error(), Timeout: ctx != nil && ctx.Err() != nil}
	var apiErr *lua.ApiError
	if errors.As(err, &apiErr) {
		runErr.apiErr = apiErr
		runErr.Message = apiErr.Object.String()
		runErr.StackTrace = apiErr.StackTrace
	}
	return runErr
}

// closeOwnedBy closes every channel handle minted through owner and drops
// them from the shared registry. Generation teardown (fresh-run end,
// session reload/close) calls it so exclusive backends (serial ports) can be
// reopened by the next generation; handles minted elsewhere are untouched.
func (e *Engine) closeOwnedBy(owner *lua.LState) {
	e.hmu.Lock()
	var doomed []*binding
	for id, b := range e.handles {
		if b.owner == owner {
			delete(e.handles, id)
			doomed = append(doomed, b)
		}
	}
	e.hmu.Unlock()
	for _, b := range doomed {
		_ = b.backend.Close(b.backendHandle)
	}
}

// ---------------------------------------------------------------------------
// Fresh runs: run(path)
// ---------------------------------------------------------------------------

// RunFile executes the script file at path on a fresh Lua state with a hard
// timeout (<=0 selects the default). The state carries the full scripting
// surface over the engine's shared handle registry and matcher pool, and is
// destroyed afterwards: globals never leak between runs. Handles the chunk
// leaves open are closed on teardown. Failures report as *RunError, same as
// Run; a missing/unreadable file reports a plain Go error.
func (e *Engine) RunFile(path string, timeout time.Duration) error {
	if e.closed.Load() {
		return ErrClosed
	}
	L := lua.NewState(lua.Options{SkipOpenLibs: true})
	e.installOnto(L)
	ctx := e.beginExec(L, timeout)
	derr := L.DoFile(path)
	// Read the deadline before endExec cancels it: teardown must not turn
	// ordinary chunk errors into timeouts.
	var runErr *RunError
	if derr != nil {
		runErr = runErrorOf(ctx, derr)
	}
	e.endExec(L)
	e.closeOwnedBy(L)
	L.Close()
	if derr != nil {
		return runErr
	}
	return nil
}

// ---------------------------------------------------------------------------
// Sessions: script.load(path), s:call(fn, args...), s:close()
// ---------------------------------------------------------------------------

// Session is one long-lived script: a dedicated LState bound to a script
// file, keyed in the engine registry by absolute path. Lua globals persist
// across Call invocations until the file changes (auto-reload before the
// next call) or the session closes. Safe for concurrent use; calls run
// serially per session. The zero value is unusable; build with Engine.Load.
type Session struct {
	eng  *Engine
	path string // absolute, cleaned: the registry key
	size int64

	mu     sync.Mutex // serializes calls (and reloads) on l
	l      *lua.LState
	mtime  time.Time
	closed bool
}

// Path returns the absolute script path this session is bound to.
func (s *Session) Path() string { return s.path }

// Closed reports whether the session was closed. A closed session's calls
// fail with ErrClosed.
func (s *Session) Closed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// Load returns the session bound to path, creating it on first use.
// Sessions are keyed by absolute cleaned path: repeated Loads of one file
// return the same live session. Creation executes the file with the default
// timeout; a failing chunk reports *RunError and registers nothing.
func (e *Engine) Load(path string) (*Session, error) {
	if e.closed.Load() {
		return nil, ErrClosed
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("script: resolve %s: %w", path, err)
	}
	abs = filepath.Clean(abs)
	e.smu.Lock()
	if s, ok := e.sessions[abs]; ok && !s.Closed() {
		e.smu.Unlock()
		return s, nil
	}
	e.smu.Unlock()

	l, mtime, size, err := e.execFile(abs, defaultScriptTimeout)
	if err != nil {
		return nil, err
	}
	s := &Session{eng: e, path: abs, l: l, mtime: mtime, size: size}
	e.smu.Lock()
	if live, ok := e.sessions[abs]; ok && !live.Closed() {
		e.smu.Unlock()
		e.closeOwnedBy(l)
		l.Close()
		return live, nil
	}
	e.sessions[abs] = s
	e.smu.Unlock()
	return s, nil
}

// execFile builds a fresh installed LState, executes the file at abs on it
// with timeout, and returns the live state with the file's identity. On
// failure the state is torn down and the error is *RunError (or a plain Go
// error when the file cannot be stated).
func (e *Engine) execFile(abs string, timeout time.Duration) (*lua.LState, time.Time, int64, error) {
	fi, err := os.Stat(abs)
	if err != nil {
		return nil, time.Time{}, 0, fmt.Errorf("script: stat %s: %w", abs, err)
	}
	l := lua.NewState(lua.Options{SkipOpenLibs: true})
	e.installOnto(l)
	ctx := e.beginExec(l, timeout)
	derr := l.DoFile(abs)
	var runErr *RunError
	if derr != nil {
		runErr = runErrorOf(ctx, derr)
	}
	e.endExec(l)
	if derr != nil {
		e.closeOwnedBy(l)
		l.Close()
		return nil, time.Time{}, 0, runErr
	}
	return l, fi.ModTime(), fi.Size(), nil
}

// maybeReloadLocked swaps in a fresh state when the file changed since the
// load. The old generation's handles close so exclusive backends reopen
// cleanly; a broken edit keeps the previous generation alive and reports
// its error instead. Callers hold s.mu.
func (s *Session) maybeReloadLocked() error {
	fi, err := os.Stat(s.path)
	if err != nil {
		return fmt.Errorf("script: stat %s: %w", s.path, err)
	}
	if !fi.ModTime().After(s.mtime) && fi.Size() == s.size {
		return nil
	}
	l, mtime, size, err := s.eng.execFile(s.path, defaultScriptTimeout)
	if err != nil {
		return fmt.Errorf("script: reload %s: %w", s.path, err)
	}
	old := s.l
	s.l, s.mtime, s.size = l, mtime, size
	s.eng.closeOwnedBy(old)
	old.Close()
	return nil
}

// Call invokes the session's global fn with args and returns its values.
// Each args element and each return must be a JSON-shaped value (nil, bool,
// numbers, strings, 1-based/composite tables); other Lua types (functions,
// userdata, threads) are conversion errors. Numbers cross as float64.
// timeout <= 0 selects the default; expiry kills like Run (pure-Lua runaways
// die on the per-instruction check, blocked expects abort between poll
// slices) and reports a timeout *RunError the same nil,"timeout" family the
// Lua surface returns. The session stays usable after any failure.
func (s *Session) Call(fn string, timeout time.Duration, args ...any) ([]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrClosed
	}
	if err := s.maybeReloadLocked(); err != nil {
		return nil, err
	}
	l := s.l
	lvargs := make([]lua.LValue, 0, len(args))
	for i, a := range args {
		lv, err := goToLua(l, a)
		if err != nil {
			return nil, fmt.Errorf("script: call %s arg %d: %w", fn, i+1, err)
		}
		lvargs = append(lvargs, lv)
	}
	ctx := s.eng.beginExec(l, timeout)
	defer s.eng.endExec(l)
	top := l.GetTop()
	if err := l.CallByParam(lua.P{
		Fn:      l.GetGlobal(fn),
		NRet:    lua.MultRet,
		Protect: true,
	}, lvargs...); err != nil {
		return nil, runErrorOf(ctx, err)
	}
	nret := l.GetTop() - top
	out := make([]any, 0, nret)
	for i := 1; i <= nret; i++ {
		v, err := luaToGo(l.Get(top + i))
		if err != nil {
			l.SetTop(top)
			return nil, fmt.Errorf("script: call %s return %d: %w", fn, i, err)
		}
		out = append(out, v)
	}
	l.SetTop(top)
	return out, nil
}

// Close evicts the session from the engine registry, closes the channels it
// minted, and destroys its LState. Idempotent; in-flight calls drain first.
func (s *Session) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	l := s.l
	s.l = nil
	s.mu.Unlock()

	s.eng.smu.Lock()
	if cur, ok := s.eng.sessions[s.path]; ok && cur == s {
		delete(s.eng.sessions, s.path)
	}
	s.eng.smu.Unlock()
	if l != nil {
		s.eng.closeOwnedBy(l)
		l.Close()
	}
	return nil
}

// sessionsSnapshot lists live sessions for Engine.Close without holding smu
// across Session.Close.
func (e *Engine) sessionsSnapshot() []*Session {
	e.smu.Lock()
	defer e.smu.Unlock()
	out := make([]*Session, 0, len(e.sessions))
	for _, s := range e.sessions {
		out = append(out, s)
	}
	return out
}

// ---------------------------------------------------------------------------
// Value ferry: Go <-> Lua across LState boundaries
// ---------------------------------------------------------------------------

// goToLua converts one Go argument to a Lua value on L. It accepts the
// JSON-shaped set Call documents; anything else is an error.
func goToLua(L *lua.LState, v any) (lua.LValue, error) {
	switch v := v.(type) {
	case nil:
		return lua.LNil, nil
	case bool:
		return lua.LBool(v), nil
	case string:
		return lua.LString(v), nil
	case float64:
		return lua.LNumber(v), nil
	case float32:
		return lua.LNumber(float64(v)), nil
	case int:
		return lua.LNumber(float64(v)), nil
	case int8:
		return lua.LNumber(float64(v)), nil
	case int16:
		return lua.LNumber(float64(v)), nil
	case int32:
		return lua.LNumber(float64(v)), nil
	case int64:
		return lua.LNumber(float64(v)), nil
	case uint:
		return lua.LNumber(float64(v)), nil
	case uint8:
		return lua.LNumber(float64(v)), nil
	case uint16:
		return lua.LNumber(float64(v)), nil
	case uint32:
		return lua.LNumber(float64(v)), nil
	case uint64:
		return lua.LNumber(float64(v)), nil
	case []any:
		t := L.NewTable()
		for i, item := range v {
			lv, err := goToLua(L, item)
			if err != nil {
				return nil, err
			}
			t.RawSetInt(i+1, lv)
		}
		return t, nil
	case []string:
		t := L.NewTable()
		for i, item := range v {
			t.RawSetInt(i+1, lua.LString(item))
		}
		return t, nil
	case map[string]any:
		t := L.NewTable()
		for key, item := range v {
			lv, err := goToLua(L, item)
			if err != nil {
				return nil, err
			}
			t.RawSetString(key, lv)
		}
		return t, nil
	default:
		return nil, fmt.Errorf("cannot convert %T", v)
	}
}

// luaToGo converts one Lua value to its JSON-shaped Go form: nil, bool,
// float64, string, []any (1-based contiguous tables) or map[string]any.
// Empty tables become map[string]any{}. Functions, userdata, threads and
// channels are errors.
func luaToGo(v lua.LValue) (any, error) {
	return luaToJSON(v, make(map[*lua.LTable]bool), 0)
}

// ---------------------------------------------------------------------------
// Lua surface: script.load(path), run(path), s:call(...), s:close()
// ---------------------------------------------------------------------------

// installScript adds the session surface to L: the script table with load,
// and the top-level run for fresh file runs. Every LState (main, fresh,
// session) gets the same surface; sessions created from any state share the
// engine registry keyed by absolute path.
func (e *Engine) installScript(L *lua.LState) {
	scriptTbl := L.NewTable()
	L.SetFuncs(scriptTbl, map[string]lua.LGFunction{
		"load": e.luaScriptLoad,
	})
	L.SetGlobal("script", scriptTbl)
	L.SetGlobal("run", L.NewFunction(e.luaRunFile))
}

// luaScriptLoad implements script.load(path): the session for path as a
// session handle (nil + error when the file fails).
func (e *Engine) luaScriptLoad(L *lua.LState) int {
	path := L.CheckString(1)
	s, err := e.Load(path)
	if err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(err.Error()))
		return 2
	}
	e.pushSession(L, s)
	L.Push(lua.LNil)
	return 2
}

// luaRunFile implements run(path, timeout_ms?): a fresh-state file run.
// It returns (true, nil) on success, (nil, err) on failure.
func (e *Engine) luaRunFile(L *lua.LState) int {
	path := L.CheckString(1)
	timeoutMs := L.OptInt(2, 0)
	if timeoutMs < 0 {
		L.ArgError(2, "timeout_ms must be >= 0")
		return 0
	}
	var timeout time.Duration
	if timeoutMs > 0 {
		timeout = time.Duration(timeoutMs) * time.Millisecond
	}
	if err := e.RunFile(path, timeout); err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(err.Error()))
		return 2
	}
	L.Push(lua.LTrue)
	L.Push(lua.LNil)
	return 2
}

// pushSession wraps s as userdata on L with the session metatable.
func (e *Engine) pushSession(L *lua.LState, s *Session) {
	mt := L.GetTypeMetatable(sessionMetatable)
	if mt == lua.LNil {
		mt = L.NewTypeMetatable(sessionMetatable)
		methods := L.NewTable()
		L.SetFuncs(methods, map[string]lua.LGFunction{
			"call":  e.luaSessionCall,
			"close": e.luaSessionClose,
		})
		L.SetField(mt, "__index", methods)
		L.SetField(mt, "__gc", L.NewFunction(func(L *lua.LState) int {
			if s, ok := sessionArg(L, 1); ok {
				_ = s.Close()
			}
			return 0
		}))
		L.SetField(mt, "__tostring", L.NewFunction(func(L *lua.LState) int {
			if s, ok := sessionArg(L, 1); ok {
				L.Push(lua.LString("session(" + s.path + ")"))
				return 1
			}
			L.Push(lua.LString("session(?)"))
			return 1
		}))
	}
	ud := L.NewUserData()
	ud.Value = s
	L.SetMetatable(ud, mt)
	L.Push(ud)
}

// sessionArg extracts the *Session from argument idx without touching the
// engine registry.
func sessionArg(L *lua.LState, idx int) (*Session, bool) {
	ud, ok := L.Get(idx).(*lua.LUserData)
	if !ok {
		return nil, false
	}
	s, ok := ud.Value.(*Session)
	if !ok || s == nil {
		return nil, false
	}
	return s, true
}

// luaSessionCall implements s:call(fn, args...): positional args ferry into
// the session state through JSON-shaped values, returns ferry back. Errors
// (missing function, conversion, reload, timeout) report as (nil, err) with
// "timeout" on expiry, matching the expect convention.
func (e *Engine) luaSessionCall(L *lua.LState) int {
	s, ok := sessionArg(L, 1)
	if !ok {
		L.ArgError(1, "session expected")
		return 0
	}
	fn := L.CheckString(2)
	top := L.GetTop()
	ferried := make([]any, 0, top-2)
	for i := 3; i <= top; i++ {
		v, err := luaToGo(L.Get(i))
		if err != nil {
			L.Push(lua.LNil)
			L.Push(lua.LString(err.Error()))
			return 2
		}
		ferried = append(ferried, v)
	}
	rets, err := s.Call(fn, 0, ferried...)
	if err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(callErrString(err)))
		return 2
	}
	for _, r := range rets {
		L.Push(jsonToLua(L, r))
	}
	return len(rets)
}

// luaSessionClose implements s:close(): evicts and destroys the session.
func (e *Engine) luaSessionClose(L *lua.LState) int {
	s, ok := sessionArg(L, 1)
	if !ok {
		L.ArgError(1, "session expected")
		return 0
	}
	if err := s.Close(); err != nil {
		L.Push(lua.LString(err.Error()))
		return 1
	}
	L.Push(lua.LNil)
	return 1
}

// callErrString maps call failures to the Lua error string: expiry (run
// timeout kill or pool timeout) is "timeout", everything else its message.
func callErrString(err error) string {
	if errors.Is(err, ErrTimeout) || errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var runErr *RunError
	if errors.As(err, &runErr) && runErr.Timeout {
		return "timeout"
	}
	return err.Error()
}
