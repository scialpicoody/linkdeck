package script

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	lua "github.com/yuin/gopher-lua"
)

// pollSliceMs bounds one blocking backend Recv inside expect/recv loops so
// a run timeout preempts the wait quickly (see package doc: blocking Go
// callbacks are otherwise invisible to the per-instruction kill switch).
const pollSliceMs = 50

// handleMetatable names the Lua userdata metatable for channel handles.
const handleMetatable = "LinkDeckHandle"

// binding pairs a Lua-visible handle with its backend and backend handle.
type binding struct {
	backend       Transport
	backendHandle Handle
	target        string // human label: port path or host:port
	table         string // owning Lua table: serial | tcp
}

// EngineOptions configures NewEngine. Transports are optional: Lua tables
// are always installed, but calls fail cleanly when the backend is nil.
type EngineOptions struct {
	Serial     Transport
	TCP        Transport
	Output     func(string) // unmatched-frame sink; defaults to std log
	Logger     func(string) // log(...) sink; defaults to std log
	MaxBacklog int          // <=0 keeps the pool default
}

// Engine is the script runtime: one serialized LState, the matcher pool,
// and the handle registry. Safe for concurrent use; Lua itself always runs
// single-file. The zero value is unusable; build with NewEngine.
type Engine struct {
	execMu sync.Mutex // serializes every LState touch
	L      *lua.LState
	pool   *Pool

	serial Transport
	tcp    Transport

	hmu     sync.Mutex
	handles map[Handle]*binding
	seq     uint64

	runMu     sync.Mutex
	runCtx    context.Context
	runCancel context.CancelFunc

	output func(string)
	logger func(string)

	closeOnce sync.Once
	closed    atomic.Bool
}

// NewEngine builds an Engine and installs the ticket #4 surface: serial
// and tcp tables, top-level send_expect/expect, and log/hex/json helpers.
func NewEngine(opts EngineOptions) *Engine {
	e := &Engine{
		L:       lua.NewState(lua.Options{SkipOpenLibs: true}),
		pool:    NewPool(),
		serial:  opts.Serial,
		tcp:     opts.TCP,
		handles: make(map[Handle]*binding),
		output:  opts.Output,
		logger:  opts.Logger,
	}
	if e.output == nil {
		e.output = func(s string) { log.Printf("linkdeck: %s", s) }
	}
	if e.logger == nil {
		e.logger = func(s string) { log.Printf("linkdeck: %s", s) }
	}
	if opts.MaxBacklog > 0 {
		e.pool.SetMaxBacklog(opts.MaxBacklog)
	}
	e.pool.SetUnmatchedHandler(func(f Frame) {
		e.output(fmt.Sprintf("%s %s %dB %x", f.Channel, f.Dir, len(f.Payload), f.Payload))
	})
	e.openSafeLibs()
	e.installHandles()
	e.installTransportTable("serial")
	e.installTransportTable("tcp")
	e.installExpect()
	e.installHelpers()
	return e
}

// Pool exposes the matcher pool for host-driven pumps (future transports).
// Feed is safe from any goroutine; the unmatched handler must not re-enter
// Lua or the pool.
func (e *Engine) Pool() *Pool { return e.pool }

// Feed offers an externally received frame to the matcher pool.
func (e *Engine) Feed(f Frame) bool { return e.pool.Feed(f) }

// Exec runs fn against the LState under the execution lock for host-driven
// Lua calls. fn must not call back into Engine methods that take execMu.
func (e *Engine) Exec(fn func(*lua.LState) error) error {
	e.execMu.Lock()
	defer e.execMu.Unlock()
	if e.closed.Load() {
		return ErrClosed
	}
	return fn(e.L)
}

// RunError is a script failure: the Lua message, its source/line stack
// trace, and whether a run timeout killed it. Unwrap exposes the
// *lua.ApiError for errors.As.
type RunError struct {
	Message    string
	StackTrace string
	Timeout    bool
	apiErr     *lua.ApiError
}

// Error surfaces the Lua message plus stack trace (line numbers included).
func (e *RunError) Error() string {
	prefix := ""
	if e.Timeout {
		prefix = "[timed out] "
	}
	if e.StackTrace != "" {
		return prefix + e.Message + "\n" + e.StackTrace
	}
	return prefix + e.Message
}

// Unwrap returns the underlying *lua.ApiError, if any.
func (e *RunError) Unwrap() error {
	if e.apiErr == nil {
		return nil
	}
	return e.apiErr
}

// Run executes src with a hard timeout (<=0 selects 5s). Pure-Lua runaways
// die via the per-instruction context check; blocked expect/recv loops
// abort between poll slices; other blocking host I/O is not preempted (see
// package doc). PCall isolation keeps the engine reusable after any error.
func (e *Engine) Run(src string, timeout time.Duration) error {
	if e.closed.Load() {
		return ErrClosed
	}
	e.execMu.Lock()
	defer e.execMu.Unlock()
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	e.runMu.Lock()
	e.runCtx, e.runCancel = ctx, cancel
	e.runMu.Unlock()
	defer func() {
		e.runMu.Lock()
		e.runCtx, e.runCancel = nil, nil
		e.runMu.Unlock()
	}()
	e.L.SetContext(ctx)
	defer e.L.RemoveContext()
	if err := e.L.DoString(src); err != nil {
		runErr := &RunError{Message: err.Error(), Timeout: ctx.Err() != nil}
		var apiErr *lua.ApiError
		if errors.As(err, &apiErr) {
			runErr.apiErr = apiErr
			runErr.Message = apiErr.Object.String()
			runErr.StackTrace = apiErr.StackTrace
		}
		return runErr
	}
	return nil
}

// Close stops the timeout sweep, cancels an in-flight run, and closes the
// Lua state. Open transports belong to the host and are left alone.
func (e *Engine) Close() {
	e.closeOnce.Do(func() {
		e.closed.Store(true)
		e.pool.Close()
		e.runMu.Lock()
		cancel := e.runCancel
		e.runMu.Unlock()
		if cancel != nil {
			cancel()
		}
		e.execMu.Lock()
		defer e.execMu.Unlock()
		e.L.Close()
	})
}

// runExpired reports whether the in-flight run (if any) timed out.
func (e *Engine) runExpired() bool {
	e.runMu.Lock()
	defer e.runMu.Unlock()
	return e.runCtx != nil && e.runCtx.Err() != nil
}

// ---------------------------------------------------------------------------
// Lua installation
// ---------------------------------------------------------------------------

func (e *Engine) openSafeLibs() {
	for _, pair := range []struct {
		name string
		open func(*lua.LState) int
	}{
		{lua.BaseLibName, lua.OpenBase},
		{lua.TabLibName, lua.OpenTable},
		{lua.StringLibName, lua.OpenString},
		{lua.MathLibName, lua.OpenMath},
		{lua.CoroutineLibName, lua.OpenCoroutine},
	} {
		if err := e.L.CallByParam(lua.P{
			Fn:      e.L.NewFunction(pair.open),
			NRet:    0,
			Protect: true,
		}, lua.LString(pair.name)); err != nil {
			panic(err)
		}
	}
	// Filesystem doors stay shut: dropping dofile/loadfile keeps scripts to
	// the chunks the host feeds them (load() of in-memory strings is fine).
	// io, os, debug and package/require are never opened.
	for _, name := range []string{"dofile", "loadfile"} {
		e.L.SetGlobal(name, lua.LNil)
	}
	e.L.SetGlobal("print", e.L.NewFunction(e.luaLog))
}

func (e *Engine) installHandles() {
	mt := e.L.NewTypeMetatable(handleMetatable)
	mt.RawSetString("__gc", e.L.NewFunction(func(L *lua.LState) int {
		ud, ok := L.Get(1).(*lua.LUserData)
		if !ok {
			return 0
		}
		if id, ok := ud.Value.(string); ok && !e.closed.Load() {
			_ = e.closeHandle(Handle(id)) // backup path: explicit close is primary
		}
		return 0
	}))
	mt.RawSetString("__tostring", e.L.NewFunction(func(L *lua.LState) int {
		if ud, ok := L.Get(1).(*lua.LUserData); ok {
			if id, ok := ud.Value.(string); ok {
				L.Push(lua.LString("handle(" + id + ")"))
				return 1
			}
		}
		L.Push(lua.LString("handle(?)"))
		return 1
	}))
}

func (e *Engine) pushHandle(L *lua.LState, id Handle) {
	ud := L.NewUserData()
	ud.Value = string(id)
	L.SetMetatable(ud, L.GetTypeMetatable(handleMetatable))
	L.Push(ud)
}

func (e *Engine) backendFor(table string) Transport {
	if table == "serial" {
		return e.serial
	}
	return e.tcp
}

func (e *Engine) installTransportTable(name string) {
	tbl := e.L.NewTable()
	L := e.L
	open := e.luaOpen(name)
	if name == "tcp" {
		open = e.luaTcpOpen // locked sketch: tcp.open(host, port, opts?)
	}
	L.SetFuncs(tbl, map[string]lua.LGFunction{
		"open":  open,
		"close": e.luaClose,
		"send":  e.luaSend,
		"recv":  e.luaRecv,
	})
	if name == "tcp" {
		tbl.RawSetString("listen", L.NewFunction(e.luaListen))
		tbl.RawSetString("accept", L.NewFunction(e.luaAccept))
	}
	L.SetGlobal(name, tbl)
}

// ---------------------------------------------------------------------------
// Lua callbacks: open/close/send/recv
// ---------------------------------------------------------------------------

// luaOpen implements serial.open(path, opts?): single target positional.
func (e *Engine) luaOpen(table string) lua.LGFunction {
	return func(L *lua.LState) int {
		backend := e.backendFor(table)
		if backend == nil {
			L.Push(lua.LNil)
			L.Push(lua.LString(table + " transport not configured"))
			return 2
		}
		target := L.CheckString(1)
		opts := openOptions(L.OptTable(2, L.NewTable()))
		h, err := backend.Open(target, opts)
		if err != nil {
			L.Push(lua.LNil)
			L.Push(lua.LString(err.Error()))
			return 2
		}
		id := e.bind(table, backend, h, target)
		e.pushHandle(L, id)
		L.Push(lua.LNil)
		return 2
	}
}

// luaTcpOpen implements tcp.open(host, port, opts?). The backend receives
// the host as target with the port in Extra["port"]; the frame label uses
// net.JoinHostPort so IPv6 hosts stay valid.
func (e *Engine) luaTcpOpen(L *lua.LState) int {
	backend := e.backendFor("tcp")
	if backend == nil {
		L.Push(lua.LNil)
		L.Push(lua.LString("tcp transport not configured"))
		return 2
	}
	host := L.CheckString(1)
	port := L.CheckInt(2)
	opts := openOptions(L.OptTable(3, L.NewTable()))
	if opts.Extra == nil {
		opts.Extra = make(map[string]string)
	}
	opts.Extra["port"] = strconv.Itoa(port)
	h, err := backend.Open(host, opts)
	if err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(err.Error()))
		return 2
	}
	id := e.bind("tcp", backend, h, net.JoinHostPort(host, strconv.Itoa(port)))
	e.pushHandle(L, id)
	L.Push(lua.LNil)
	return 2
}

func (e *Engine) luaClose(L *lua.LState) int {
	id, ok := handleArg(L, 1)
	if !ok {
		L.Push(lua.LString("handle expected"))
		return 1
	}
	if err := e.closeHandle(id); err != nil {
		L.Push(lua.LString(err.Error()))
		return 1
	}
	L.Push(lua.LNil)
	return 1
}

func (e *Engine) luaSend(L *lua.LState) int {
	b, _, msg := e.lookupOrError(L, 1)
	if msg != "" {
		L.Push(lua.LString(msg))
		return 1
	}
	data := L.CheckString(2)
	if err := b.backend.Send(b.backendHandle, []byte(data)); err != nil {
		L.Push(lua.LString(err.Error()))
		return 1
	}
	L.Push(lua.LNil)
	return 1
}

func (e *Engine) luaRecv(L *lua.LState) int {
	b, _, msg := e.lookupOrError(L, 1)
	if msg != "" {
		L.Push(lua.LNil)
		L.Push(lua.LString(msg))
		return 2
	}
	timeoutMs := L.OptInt(2, DefaultExpectTimeoutMs)
	if timeoutMs < 0 {
		L.ArgError(2, "timeout_ms must be >= 0")
		return 0
	}
	data, err := e.recvWait(b, timeoutMs)
	if err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(expectErrString(err)))
		return 2
	}
	L.Push(lua.LString(string(data)))
	L.Push(lua.LNil)
	return 2
}

func (e *Engine) luaListen(L *lua.LState) int {
	backend := e.backendFor("tcp")
	if backend == nil {
		L.Push(lua.LNil)
		L.Push(lua.LString("tcp transport not configured"))
		return 2
	}
	lt, ok := backend.(ListenerTransport)
	if !ok {
		L.Push(lua.LNil)
		L.Push(lua.LString("tcp transport does not support listen"))
		return 2
	}
	port := L.CheckInt(1)
	opts := openOptions(L.OptTable(2, L.NewTable()))
	h, err := lt.Listen(port, opts)
	if err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(err.Error()))
		return 2
	}
	id := e.bind("tcp", backend, h, "listen:"+strconv.Itoa(port))
	e.pushHandle(L, id)
	L.Push(lua.LNil)
	return 2
}

func (e *Engine) luaAccept(L *lua.LState) int {
	b, _, msg := e.lookupOrError(L, 1)
	if msg != "" {
		L.Push(lua.LNil)
		L.Push(lua.LString(msg))
		return 2
	}
	lt, ok := b.backend.(ListenerTransport)
	if !ok {
		L.Push(lua.LNil)
		L.Push(lua.LString("tcp transport does not support accept"))
		return 2
	}
	timeoutMs := L.OptInt(2, DefaultExpectTimeoutMs)
	if timeoutMs < 0 {
		L.ArgError(2, "timeout_ms must be >= 0")
		return 0
	}
	h, target, err := e.acceptWait(lt, b, timeoutMs)
	if err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(expectErrString(err)))
		return 2
	}
	id := e.bind("tcp", b.backend, h, target)
	e.pushHandle(L, id)
	L.Push(lua.LNil)
	return 2
}

// ---------------------------------------------------------------------------
// Lua callbacks: expect/send_expect
// ---------------------------------------------------------------------------

func (e *Engine) installExpect() {
	e.L.SetGlobal("send_expect", e.L.NewFunction(e.luaSendExpect))
	e.L.SetGlobal("expect", e.L.NewFunction(e.luaExpect))
}

func (e *Engine) luaSendExpect(L *lua.LState) int {
	b, _, msg := e.lookupOrError(L, 1)
	if msg != "" {
		L.Push(lua.LNil)
		L.Push(lua.LString(msg))
		return 2
	}
	data := L.CheckString(2)
	pattern := L.CheckString(3)
	mode, timeoutMs := checkExpectOpts(L, 4)
	if mode == "" {
		return 0 // ArgError already raised
	}
	// Validate the pattern before touching the wire: a bad expression must
	// not consume a send.
	if _, err := compilePattern(pattern, mode); err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(err.Error()))
		return 2
	}
	if err := b.backend.Send(b.backendHandle, []byte(data)); err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(err.Error()))
		return 2
	}
	e.doExpect(L, b, pattern, mode, timeoutMs)
	return 2
}

func (e *Engine) luaExpect(L *lua.LState) int {
	b, _, msg := e.lookupOrError(L, 1)
	if msg != "" {
		L.Push(lua.LNil)
		L.Push(lua.LString(msg))
		return 2
	}
	pattern := L.CheckString(2)
	mode, timeoutMs := checkExpectOpts(L, 3)
	if mode == "" {
		return 0 // ArgError already raised
	}
	e.doExpect(L, b, pattern, mode, timeoutMs)
	return 2
}

// doExpect registers the matcher (backlog scanned first inside Register)
// and pumps received frames through the pool until ours resolves.
// It pushes (data, nil) or (nil, err); "timeout" on expiry.
func (e *Engine) doExpect(L *lua.LState, b *binding, pattern string, mode MatchMode, timeoutMs int) {
	reg, err := e.pool.Register(pattern, mode, timeoutMs)
	if err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(err.Error()))
		return
	}
	frame, err := e.awaitFrame(b, reg)
	if err != nil {
		L.Push(lua.LNil)
		L.Push(lua.LString(expectErrString(err)))
		return
	}
	L.Push(lua.LString(string(frame.Payload)))
	L.Push(lua.LNil)
}

func expectErrString(err error) string {
	if errors.Is(err, ErrTimeout) || errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return err.Error()
}

// awaitFrame pumps the channel into the pool until reg resolves, its
// deadline passes, or the run dies. Receiving is sliced so run timeouts
// preempt the wait; each slice honors the backend Recv contract.
func (e *Engine) awaitFrame(b *binding, reg *Registration) (Frame, error) {
	for {
		select {
		case f := <-reg.ch:
			return f, nil
		default:
		}
		if e.runExpired() {
			e.pool.Cancel(reg)
			return Frame{}, context.DeadlineExceeded
		}
		rem := time.Until(reg.deadline)
		if rem <= 0 {
			select {
			case f := <-reg.ch:
				return f, nil
			default:
			}
			e.pool.Cancel(reg)
			return Frame{}, ErrTimeout
		}
		ms := int(rem.Milliseconds())
		if ms > pollSliceMs || ms <= 0 {
			ms = pollSliceMs
		}
		data, err := b.backend.Recv(b.backendHandle, ms)
		if err != nil {
			if errors.Is(err, ErrTimeout) {
				continue
			}
			e.pool.Cancel(reg)
			return Frame{}, err
		}
		if len(data) == 0 {
			continue
		}
		e.pool.Feed(NewRxFrame(b.target, data))
	}
}

// recvWait reads the next chunk with an overall timeout, sliced for run
// preemption. Raw recv bypasses the matcher pool by design: mix it with
// expect on one channel and frames will go where you did not want them.
func (e *Engine) recvWait(b *binding, timeoutMs int) ([]byte, error) {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for {
		if e.runExpired() {
			return nil, context.DeadlineExceeded
		}
		if timeoutMs >= 0 && !time.Now().Before(deadline) {
			return nil, ErrTimeout
		}
		ms := pollSliceMs
		if timeoutMs >= 0 {
			if rem := int(time.Until(deadline).Milliseconds()); rem < ms {
				ms = rem
			}
			if ms <= 0 {
				return nil, ErrTimeout
			}
		} else {
			ms = -1
		}
		data, err := b.backend.Recv(b.backendHandle, ms)
		if err != nil {
			if errors.Is(err, ErrTimeout) {
				continue
			}
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		return data, nil
	}
}

// acceptWait polls Accept in slices like recvWait.
func (e *Engine) acceptWait(lt ListenerTransport, b *binding, timeoutMs int) (Handle, string, error) {
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
	for {
		if e.runExpired() {
			return "", "", context.DeadlineExceeded
		}
		if !time.Now().Before(deadline) {
			return "", "", ErrTimeout
		}
		ms := pollSliceMs
		if rem := int(time.Until(deadline).Milliseconds()); rem < ms {
			ms = rem
		}
		if ms <= 0 {
			return "", "", ErrTimeout
		}
		h, err := lt.Accept(b.backendHandle, ms)
		if err != nil {
			if errors.Is(err, ErrTimeout) {
				continue
			}
			return "", "", err
		}
		return h, b.target + "/accepted", nil
	}
}

// ---------------------------------------------------------------------------
// Lua callbacks: log/hex/json helpers
// ---------------------------------------------------------------------------

func (e *Engine) installHelpers() {
	L := e.L
	L.SetGlobal("log", L.NewFunction(e.luaLog))

	hexTbl := L.NewTable()
	L.SetFuncs(hexTbl, map[string]lua.LGFunction{
		"encode": func(L *lua.LState) int {
			s := L.CheckString(1)
			L.Push(lua.LString(hex.EncodeToString([]byte(s))))
			return 1
		},
		"decode": func(L *lua.LState) int {
			s := L.CheckString(1)
			raw, err := hex.DecodeString(strings.TrimSpace(s))
			if err != nil {
				L.Push(lua.LNil)
				L.Push(lua.LString(err.Error()))
				return 2
			}
			L.Push(lua.LString(string(raw)))
			L.Push(lua.LNil)
			return 2
		},
	})
	L.SetGlobal("hex", hexTbl)

	jsonTbl := L.NewTable()
	L.SetFuncs(jsonTbl, map[string]lua.LGFunction{
		"encode": func(L *lua.LState) int {
			v, err := luaToJSON(L.Get(1), make(map[*lua.LTable]bool), 0)
			if err != nil {
				L.Push(lua.LNil)
				L.Push(lua.LString(err.Error()))
				return 2
			}
			buf, err := json.Marshal(v)
			if err != nil {
				L.Push(lua.LNil)
				L.Push(lua.LString(err.Error()))
				return 2
			}
			L.Push(lua.LString(string(buf)))
			L.Push(lua.LNil)
			return 2
		},
		"decode": func(L *lua.LState) int {
			s := L.CheckString(1)
			var v any
			if err := json.Unmarshal([]byte(s), &v); err != nil {
				L.Push(lua.LNil)
				L.Push(lua.LString(err.Error()))
				return 2
			}
			L.Push(jsonToLua(L, v))
			return 1
		},
	})
	L.SetGlobal("json", jsonTbl)
}

func (e *Engine) luaLog(L *lua.LState) int {
	top := L.GetTop()
	parts := make([]string, 0, top)
	for i := 1; i <= top; i++ {
		v := L.Get(i)
		if s, ok := v.(lua.LString); ok {
			parts = append(parts, string(s))
		} else {
			parts = append(parts, v.String())
		}
	}
	e.logger(strings.Join(parts, "\t"))
	return 0
}

// luaToJSON converts a Lua value to JSON-marshalable Go values. Tables with
// only contiguous 1-based integer keys become arrays; other tables become
// string-keyed objects; empty tables encode as {}. Cycles and nesting past
// 128 levels are errors.
func luaToJSON(v lua.LValue, seen map[*lua.LTable]bool, depth int) (any, error) {
	if depth > 128 {
		return nil, errors.New("json.encode: table too deep")
	}
	switch v := v.(type) {
	case *lua.LNilType:
		return nil, nil
	case lua.LBool:
		return bool(v), nil
	case lua.LNumber:
		return float64(v), nil
	case lua.LString:
		return string(v), nil
	case *lua.LTable:
		if seen[v] {
			return nil, errors.New("json.encode: cyclic table")
		}
		seen[v] = true
		defer delete(seen, v)
		n := v.Len()
		empty := true
		v.ForEach(func(_, _ lua.LValue) { empty = false })
		if empty {
			return map[string]any{}, nil
		}
		isArray := true
		v.ForEach(func(key, _ lua.LValue) {
			num, ok := key.(lua.LNumber)
			if !ok || float64(num) != float64(int(num)) || int(num) < 1 || int(num) > n {
				isArray = false
			}
		})
		if !isArray {
			out := make(map[string]any, n)
			var convErr error
			v.ForEach(func(key, val lua.LValue) {
				if convErr != nil {
					return
				}
				jv, err := luaToJSON(val, seen, depth+1)
				if err != nil {
					convErr = err
					return
				}
				out[key.String()] = jv
			})
			return out, convErr
		}
		out := make([]any, 0, n)
		for i := 1; i <= n; i++ {
			jv, err := luaToJSON(v.RawGetInt(i), seen, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, jv)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("json.encode: cannot encode %s", v.Type().String())
	}
}

// jsonToLua converts decoded JSON to Lua values (objects to tables,
// arrays to 1-based tables, null to nil).
func jsonToLua(L *lua.LState, v any) lua.LValue {
	switch v := v.(type) {
	case nil:
		return lua.LNil
	case bool:
		return lua.LBool(v)
	case float64:
		return lua.LNumber(v)
	case string:
		return lua.LString(v)
	case []any:
		t := L.NewTable()
		for i, item := range v {
			t.RawSetInt(i+1, jsonToLua(L, item))
		}
		return t
	case map[string]any:
		t := L.NewTable()
		for key, item := range v {
			t.RawSetString(key, jsonToLua(L, item))
		}
		return t
	default:
		return lua.LNil
	}
}

// ---------------------------------------------------------------------------
// handles + options
// ---------------------------------------------------------------------------

func (e *Engine) bind(table string, backend Transport, bh Handle, target string) Handle {
	e.hmu.Lock()
	defer e.hmu.Unlock()
	e.seq++
	id := Handle(fmt.Sprintf("%s:%d", table, e.seq))
	e.handles[id] = &binding{backend: backend, backendHandle: bh, target: target, table: table}
	return id
}

// handleArg extracts a handle id without touching the registry.
func handleArg(L *lua.LState, idx int) (Handle, bool) {
	ud, ok := L.Get(idx).(*lua.LUserData)
	if !ok {
		return "", false
	}
	id, ok := ud.Value.(string)
	if !ok {
		return "", false
	}
	return Handle(id), true
}

// lookupOrError resolves a handle argument. Type misuse raises ArgError;
// unknown/closed handles return a message the caller pushes as an error
// value, matching the value-error convention of the rest of the surface.
// It pushes nothing itself so multi-return callers keep (nil, err) order.
func (e *Engine) lookupOrError(L *lua.LState, idx int) (*binding, Handle, string) {
	id, ok := handleArg(L, idx)
	if !ok {
		L.ArgError(idx, "handle expected")
		return nil, "", ""
	}
	e.hmu.Lock()
	b := e.handles[id]
	e.hmu.Unlock()
	if b == nil {
		return nil, "", "unknown or closed handle"
	}
	return b, id, ""
}

func (e *Engine) closeHandle(id Handle) error {
	e.hmu.Lock()
	b := e.handles[id]
	if b == nil {
		e.hmu.Unlock()
		return errors.New("unknown or closed handle")
	}
	delete(e.handles, id)
	e.hmu.Unlock()
	return b.backend.Close(b.backendHandle)
}

// checkExpectOpts reads the {mode, timeout_ms} table (or nil) at idx.
// Bad values raise ArgError, which never returns; success returns the mode.
func checkExpectOpts(L *lua.LState, idx int) (MatchMode, int) {
	mode := ModePrefix
	timeoutMs := DefaultExpectTimeoutMs
	if tbl, ok := L.Get(idx).(*lua.LTable); ok {
		if mv := tbl.RawGetString("mode"); mv != lua.LNil {
			ms, ok := mv.(lua.LString)
			if !ok {
				L.ArgError(idx, "mode must be a string")
				return "", 0
			}
			m, err := ParseMatchMode(string(ms))
			if err != nil {
				L.ArgError(idx, err.Error())
				return "", 0
			}
			mode = m
		}
		if tv := tbl.RawGetString("timeout_ms"); tv != lua.LNil {
			num, ok := tv.(lua.LNumber)
			if !ok {
				L.ArgError(idx, "timeout_ms must be a number")
				return "", 0
			}
			timeoutMs = int(num)
			if timeoutMs < 0 {
				L.ArgError(idx, "timeout_ms must be >= 0")
				return "", 0
			}
		}
	}
	return mode, timeoutMs
}

// openOptions converts a Lua option table to OpenOptions.
func openOptions(tbl *lua.LTable) OpenOptions {
	opts := OpenOptions{Extra: make(map[string]string)}
	tbl.ForEach(func(key, val lua.LValue) {
		ks, ok := key.(lua.LString)
		if !ok {
			return
		}
		switch strings.ToLower(string(ks)) {
		case "baudrate", "baud_rate", "baud":
			if n, ok := val.(lua.LNumber); ok {
				opts.BaudRate = int(n)
			}
		case "timeout_ms":
			if n, ok := val.(lua.LNumber); ok {
				opts.TimeoutMs = int(n)
			}
		case "framing":
			if s, ok := val.(lua.LString); ok {
				opts.Framing = string(s)
			}
		default:
			opts.Extra[string(ks)] = val.String()
		}
	})
	return opts
}

// ---------------------------------------------------------------------------
// ScriptService: the future mygo-bound facade (defined, NOT bound).
// ---------------------------------------------------------------------------

// ScriptService wraps an Engine for host use. It is deliberately not
// registered with mygo.Bind here: main.go stays integrator-owned, and the
// real transports are not built yet. The integrator binds this type once
// the surface settles.
type ScriptService struct {
	eng *Engine
}

// NewScriptService returns a ScriptService over eng.
func NewScriptService(eng *Engine) *ScriptService {
	return &ScriptService{eng: eng}
}

// Run executes src with timeoutMs (<=0 selects the engine default) and
// reports script failures as Go errors; unmatched frames and log(...) go to
// the engine's configured sinks.
func (s *ScriptService) Run(src string, timeoutMs int) error {
	return s.eng.Run(src, time.Duration(timeoutMs)*time.Millisecond)
}

// Feed offers an externally received frame to the script matchers.
func (s *ScriptService) Feed(f Frame) bool {
	return s.eng.Feed(f)
}

// Close shuts the engine down.
func (s *ScriptService) Close() {
	s.eng.Close()
}
