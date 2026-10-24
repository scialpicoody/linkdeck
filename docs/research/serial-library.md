# Serial library research — LinkDeck Phase 1

**Ticket:** #2 · **Date:** 2026-10-23 · **Recommendation: `go.bug.st/serial` (bugst/go-serial) v1.8.0.**
No blocker surfaced; the ticket default stands. One known gap (no flow-control
API) is documented below with workarounds.

All claims below were verified against primary sources: the library repos
themselves, `pkg.go.dev`, and the repos' issue trackers / CI configs.

## Candidates

| Library | Version / activity | License | Verdict |
|---|---|---|---|
| `go.bug.st/serial` ([bugst/go-serial](https://github.com/bugst/go-serial)) | v1.8.0 tagged 2026-07-15; prior v1.7.1/v1.7.0 May 2026; 877 stars / 240 forks / 55 open issues | BSD-3-Clause | **Recommend** |
| `github.com/tarm/serial` ([tarm/serial](https://github.com/tarm/serial)) | Last push 2023-10-16; 1695 stars | (Suyash Kumar fork lineage) | Reject — superseded |
| `github.com/jacobsa/go-serial` ([jacobsa/go-serial](https://github.com/jacobsa/go-serial)) | Last push 2021-09-29; dormant | Apache-style (see repo LICENSE) | Reject — dormant, thin surface |

`tarm/serial` is the original package `bugst/go-serial` was forked from. Its own
README still documents a minimal surface ("Currently there is very little in the
way of configurability. You can set the baud rate… all ports are opened with 8
data bits, 1 stop bit, no parity, no hardware flow control, and no software flow
control") and it has seen no meaningful work since Oct 2023. It is the past, not
an alternative.

`jacobsa/go-serial` nominally supports OS X, Linux and Windows (per its README)
and its `OpenOptions` struct does include `ParityMode` and even an
`RTSCTSFlowControl bool` flag (source: `serial/serial.go` in that repo). But the
project has been dormant since Sep 2021, it has **no port-enumeration API**, **no
modem-line status API**, no typed errors, and its read model is an
inter-character-timeout/minimum-read-size scheme rather than a settable read
timeout. It is a fallback only if hardware flow control turns out to be a hard
day-1 requirement (see gap 1).

## `go.bug.st/serial` v1.8.0 — evidence by criterion

Sources: [`serial.go`](https://github.com/bugst/go-serial/blob/master/serial.go),
[`serial_unix.go`](https://github.com/bugst/go-serial/blob/master/serial_unix.go),
[`serial_windows.go`](https://github.com/bugst/go-serial/blob/master/serial_windows.go),
[`serial_darwin.go`](https://github.com/bugst/go-serial/blob/master/serial_darwin.go),
[`enumerator/enumerator.go`](https://github.com/bugst/go-serial/blob/master/enumerator/enumerator.go),
[`go.mod`](https://github.com/bugst/go-serial/blob/master/go.mod),
[`.github/workflows/test.yaml`](https://github.com/bugst/go-serial/blob/master/.github/workflows/test.yaml),
[tags](https://github.com/bugst/go-serial/tags),
[issues](https://github.com/bugst/go-serial/issues).
(`pkg.go.dev/go.bug.st/serial` currently renders v1.8.0, published 2026-07-15.)

- **Port enumeration.** `GetPortsList() ([]string, error)` on every OS, plus
  `enumerator.GetDetailedPortsList(...)` returning USB VID/PID, serial number,
  manufacturer/product/configuration strings. Since v1.8.0 (PR #226, tag notes)
  active USB probing is opt-in via filter functions, so plain enumeration does
  not disturb attached devices.
- **Baud / data / stop / parity.** `Mode{BaudRate, DataBits (5–8), Parity
  (No/Odd/Even/Mark/Space), StopBits (1 / 1.5 / 2)}`, applied via `Open()` and
  re-applied via `SetMode()`. Custom (non-standard) baud rates are supported on
  Linux (`serial_specialbaudrate_linux*.go`, TCSETS2/BOTHER path) and macOS
  (`serial_darwin.go`, `IOSSIOSPEED` ioctl). Invalid values surface as typed
  `PortError` codes (`InvalidSpeed`, `InvalidDataBits`, `InvalidParity`,
  `InvalidStopBits`).
- **Flow control — GAP (see below).** There is no public flow-control setting.
  Unix `nativeOpen` explicitly disables RTS/CTS (`setTermSettingsCtsRts(false)`)
  and clears `IXON`/`IXOFF`; the Windows DCB setup clears `dcbOutXCTSFlow` and
  `dcbOutXDSRFlow`. Upstream issue
  [#201 "add rts/cts flow-control support"](https://github.com/bugst/go-serial/issues/201)
  (open since 2025-03-24) tracks exactly this.
- **Modem-line status.** `SetDTR(bool)`, `SetRTS(bool)`,
  `GetModemStatusBits() → {CTS, DSR, RI, DCD}`, plus
  `Mode.InitialStatusBits` to set DTR/RTS at open time (shipped; upstream #140
  is closed). Unix notes a few-ms pulse on open is unavoidable — relevant to
  device-reset behavior, not a blocker.
- **Read timeout.** `SetReadTimeout(time.Duration)` / `NoTimeout` sentinel.
  Unix implements it with `select()` over the fd plus a close-signal pipe
  (timeout expiry returns `0, nil`); Windows uses overlapped I/O. No
  listen/hotplug API exists — arrival/removal detection must poll
  `GetPortsList()` (or the detailed enumerator) on an app-level ticker.
- **Pure Go vs cgo.** Pure Go plus the single dependency `golang.org/x/sys`
  (`go.mod`: `go 1.25.0`, `require golang.org/x/sys v0.43.0`). One exception:
  the macOS USB *enumerator* needs cgo (IOKit) — CI sets `CGO_ENABLED=1` for the
  macOS job only (see `test.yaml`; also v1.6.0 tag "darwin: use Go type
  wrappers…"). Plain open/read/write/enumerate builds without cgo.
- **OS/arch health.** CI (`test.yaml`) builds ubuntu / windows / macOS ×
  amd64 **and** arm64, runs the unit tests with `-race` (socat-backed PTY tests
  on Linux), and cross-builds 386, arm, freebsd/amd64, openbsd (amd64/386/arm),
  linux/ppc64le. So Linux/macOS/Windows on amd64+arm64 are all green.
- **Maintenance.** Actively maintained by Cristian Maglie (Arduino): v1.7.0 and
  v1.7.1 in May 2026, v1.8.0 in Jul 2026, CH340-on-Windows workaround in v1.6.3
  (relevant to embedded workbenches). Open-issue backlog (~55) is the normal
  long tail for a hardware-facing library.

## Gaps vs design-doc §2.1 needs, and handling

1. **No RTS/CTS or XON/XOFF support (upstream #201, open).** If Phase 1 must
   talk to devices that require hardware flow control, the library alone cannot
   do it. Workarounds, in order of preference: (a) manual RTS/CTS via
   `SetRTS`/`GetModemStatusBits` in app code; (b) a small local patch adding a
   `FlowControl` mode field upstream-style; (c) only as a last resort, switch
   to dormant `jacobsa/go-serial` for its `RTSCTSFlowControl` flag. **Not a
   Phase-1 blocker** unless flow-controlled devices are in scope — confirm on
   the scripting/channel tickets if unsure.
2. **No hotplug/listen events.** Plan on a poll-based port-list refresh
   (e.g. 1–2 s ticker diffing `GetDetailedPortsList`) in the connection
   manager. No library needed.
3. **Close does not unblock a blocked `Write`** (upstream
   [#150](https://github.com/bugst/go-serial/issues/150), open; reads *are*
   unblocked via the close-signal pipe). The connection manager's shutdown path
   should not rely on `Close()` to cancel an in-flight `Write` — use short
   writes / app-level write serialization instead.

## Recommendation

Adopt **`go.bug.st/serial` v1.8.0** for Phase 1. Pin the version in `go.mod`
when the serial phase starts; budget app-level polling for port-list refresh;
keep hardware flow control unexposed until a device requires it (gap 1
workarounds above remain available).
