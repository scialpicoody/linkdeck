// Package script owns LinkDeck's embedded Lua scripting runtime.
//
// It wraps gopher-lua (pure Go, Lua 5.1 + goto) with a small race-safe
// surface: a serialized single-LState engine, a matcher pool for
// send_expect/expect, and the locked ticket #4 scripting API
// (serial/tcp tables, top-level send_expect/expect, log/hex/json helpers).
// Real serial/TCP transports plug in later through the Transport interface;
// this package ships no hardware access itself.
//
// Execution model. One Engine owns one *lua.LState and every use of it is
// serialized by a mutex, so concurrent Go callers queue instead of racing.
// Run executes a chunk under context.WithTimeout via LState.SetContext,
// which the VM checks on every Lua instruction: a runaway pure-Lua loop
// dies promptly with "context deadline exceeded", and PCall isolation
// rewinds the stack and surfaces the failure as a *RunError carrying the
// Lua message plus source/line stack trace.
//
// Blocking-callback exception. The per-instruction check cannot preempt a
// Go callback mid-call. In practice that means: expect/send_expect/recv
// loops poll the transport in short slices (<=50ms) and abort between
// slices when the run's context expires, so they die with the run; other
// blocking host calls (open/accept/send, future real-transport I/O) are NOT
// preempted mid-call — keep them short or context-aware. See lua-runtime
// research (docs/research/lua-runtime.md).
//
// Matching. The Pool filters raw strings only; it holds zero protocol
// knowledge (AT, Modbus, private frames all live in user scripts).
// Register scans the backlog before waiting; Feed tries registrations in
// registration order; unmatched frames are kept in a capped backlog and
// routed to the unmatched handler (CLI output by default). A background
// sweep expires timed-out registrations even when nobody is awaiting them.
package script
