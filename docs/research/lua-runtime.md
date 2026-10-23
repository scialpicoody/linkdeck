# Lua runtime research (ticket #3)

Question: which embedded scripting runtime should LinkDeck Phase 4 use for user
protocol scripts? Candidates: gopher-lua (pure Go), cgo Lua/LuaJIT bindings,
or a documented non-Lua fallback.

Recommendation: **gopher-lua** (`github.com/yuin/gopher-lua`). Its interrupt
story **passes** the kill-a-runaway-script deciding test: `LState.SetContext`
swaps the VM into a loop that checks `ctx.Done()` on **every Lua instruction**
and raises a Lua error on cancellation, so `context.WithTimeout` kills a
`while true do end` promptly with no extra glue. Details and sources below.

Maintenance-status dates were observed via the GitHub API on 2026-10-23.

## 1. gopher-lua (pure Go, Lua 5.1 + `goto`) — RECOMMENDED

Source: `github.com/yuin/gopher-lua` (README, `state.go`, `vm.go`; MIT).

- **Hard timeout / interrupt: PASS.** `state.go` provides
  `func (ls *LState) SetContext(ctx context.Context)` ("The provided ctx must
  be non-nil"), plus `Context()` / `RemoveContext()`. Setting a context swaps
  the interpreter to `mainLoopWithContext` in `vm.go`, whose loop does, per
  instruction:
  `select { case <-L.ctx.Done(): L.RaiseError(L.ctx.Err().Error()); return
  default: ... }`.
  So a `context.WithTimeout` + `SetContext` is a complete kill switch for
  runaway pure-Lua scripts — the error propagates through protected calls like
  any Lua error. Coroutine states created by `NewThread()` get a child context
  (with a returned cancel func), so cancellation propagates to threads.
  Caveat (read from the same loop): the check runs *between Lua instructions*,
  so a **blocking Go callback** (e.g. a host function doing I/O) is not
  preempted mid-call — keep host functions short or make them context-aware.
- **Error / panic isolation with line numbers.** `PCall` runs the call under a
  `recover()`: Lua errors arrive as `*ApiError`, and Go panics (including ones
  from host callbacks) are converted to `ApiError` of type `ApiErrorPanic`
  rather than crashing the host; the Lua stack is rewound (`stack.SetSp`,
  `reg.SetTop`). `ApiError` carries a Lua `StackTrace` (source + line numbers
  via `stackTrace`), and `Options.IncludeGoStackTrace` appends the Go stack for
  host-side debugging.
- **Serialized single-threaded execution.** README "Goroutines" section: "The
  `LState` is not goroutine-safe. It is recommended to use one LState per
  goroutine and communicate between goroutines by using channels." One state =
  one strictly serial script execution; `channel` values bridge to Go.
- **Startup cost.** `NewState` opens the stdlibs by default; `Options` allow
  `SkipOpenLibs` (plus `OpenBase`/`OpenTable`/… subsets — the README documents
  opening only safe libraries, which doubles as the sandboxing story),
  `CallStackSize` / `MinimizeStackMemory`, and `RegistrySize` /
  `RegistryMaxSize` / `RegistryGrowStep` for per-state memory tuning. Pure Go:
  no cgo, no system dependency, no cross-compilation penalty for a desktop app.
  (No benchmark run in this ticket; the README positions performance as
  roughly Python3-class on micro-benchmarks.)
- **Maintenance.** Not archived; ~6,993 stars; pushed 2026-04-01. The Lua 5.1
  (+ `goto`) dialect is frozen by design (see README "Differences between Lua
  and GopherLua") — stability, not stagnation, for our purposes.

Suggested use pattern: one `LState` per script run (fresh or pooled),
`SkipOpenLibs` + open only the safe libs, `SetContext` with the run's timeout,
execute via protected calls, surface `*ApiError` (message + stack trace) to
the user.

## 2. cgo bindings (aarzilli/golua over liblua 5.1–5.4 / LuaJIT) — NOT RECOMMENDED

Sources: `github.com/aarzilli/golua` README (MIT); Lua 5.4 reference manual
(`lua_sethook`); GitHub API for LuaJIT repos.

- **Hard timeout / interrupt: possible but hand-rolled.** The C API offers
  `lua_sethook(L, f, mask, count)` with `LUA_MASKCOUNT` — a hook firing every
  N instructions, the standard mechanism to abort runaway scripts by raising
  an error from the hook (Lua 5.4 manual, `lua_sethook`). But golua exposes no
  built-in context/timeout integration: we would write and maintain the
  hook + deadline plumbing per state ourselves, in cgo.
- **Error / panic isolation: footguns.** golua README "ON ERROR HANDLING":
  Lua exceptions are incompatible with Go, so `DoString`/`DoFile`/`Call` turn
  every Lua exception into a **Go panic**; `pcall`/`xpcall` are renamed to
  `unsafe_pcall`/`unsafe_xpcall` and are "only safe to be called from Lua code
  that never calls back to Go. Use at your own risk." Line numbers remain
  available through the standard C traceback APIs, but every script error
  crossing into Go must be caught with `recover` by our code, every time.
- **Serialized execution.** Same single-threaded model — README: "`lua.State`
  is not thread safe" — with the added constraint that a Lua state pinned
  inside a cgo call interacts badly with Go goroutine scheduling.
- **Startup / distribution cost.** Requires a system liblua matched to build
  tags (`lua52`/`lua53`/`lua54`/`luajit`, dynamic vs `luaa` static). For a
  desktop-first mygo app shipping on multiple platforms, that is per-target
  toolchain and packaging work plus per-call cgo overhead — pure cost against
  user protocol scripts that are I/O-bound, not compute-bound.
- **Maintenance.** golua itself: not archived, 702 stars, pushed 2026-10-10.
  Upstream Lua (5.4) is actively maintained. LuaJIT upstream
  (`LuaJIT/LuaJIT`, described as a mirror) rolls slowly; the community
  maintenance line is the OpenResty fork (`openresty/luajit2`, pushed
  2026-10-23). Either way we inherit a C dependency for no deciding-test win.

Verdict: full Lua-version choice and fastest raw execution, but it loses on
every axis that matters here — interrupt is DIY, errors bridge as panics, and
distribution gets harder.

## 3. Non-Lua fallback: goja (pure-Go JavaScript) — DOCUMENTED FALLBACK

Source: `github.com/dop251/goja` (README, `runtime.go`; MIT).

- **Interrupt: purpose-built.** `func (r *Runtime) Interrupt(v interface{})`
  raises an async, cross-goroutine interrupt that aborts a running script
  ("If the runtime is currently not running, it will be immediately
  interrupted on the next Run*() call"; pair with `ClearInterrupt()` on
  reuse). This is the cleanest kill primitive of the three — callable from a
  watchdog goroutine.
- **Errors with positions.** Script failures surface as `*Exception` with
  `Stack() []StackFrame` (file/line/position) — equivalent line-number story.
- **Serialized execution.** README FAQ: "Is it goroutine-safe? No. An instance
  of goja.Runtime can only be used by a single goroutine at a time." Same
  one-runtime-one-thread discipline as gopher-lua states.
- **Startup cost.** Pure Go, no cgo; `goja.New()` builds a fresh runtime.
- **Maintenance.** Very active: ~7,158 stars, pushed 2026-10-23 (same day).

Verdict: the fallback if LinkDeck ever prefers JavaScript over Lua. It does
not beat gopher-lua for this ticket: the script corpus and design target Lua,
and gopher-lua's context-timeout integration is equally decisive with less
API surface to misuse.

## Also noted, not shortlisted

- `github.com/Shopify/go-lua` (pure-Go Lua VM, ~3,460 stars, pushed
  2026-10-07): a second pure-Go Lua option, but nothing in scope showed a
  built-in timeout/interrupt story comparable to gopher-lua's `SetContext`,
  so it adds evaluation cost with no deciding-test advantage.

## Bottom line

| Axis | gopher-lua | cgo (golua/LuaJIT) | goja fallback |
|---|---|---|---|
| Kill runaway script | Built-in: per-instruction `ctx.Done()` check | DIY count hook in cgo | Built-in: `Interrupt()` |
| Error isolation + lines | `PCall`→`*ApiError` + Lua stack trace; Go panics contained | Lua errors become Go panics; `unsafe_pcall` caveat | `*Exception` + `Stack()` |
| Serialized execution | 1 `LState`, not goroutine-safe, channels | 1 `State`, not thread-safe + cgo pinning | 1 `Runtime`, single goroutine |
| Startup/distribution | Pure Go, tunable stacks, subset libs | System liblua, build tags, cgo overhead | Pure Go |
| Maintenance | Stable, ~7k stars | Binding active; LuaJIT line via fork | Very active, ~7.2k stars |

Default holds: **gopher-lua**, because its interrupt story passes.
