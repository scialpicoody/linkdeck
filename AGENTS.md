# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Agent skills

### Issue tracker

Issues live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels, unchanged. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context layout. See `docs/agents/domain.md`.

### MyGo docs (upstream, not in this repo)

- Docs index: `https://mygo.egoist.dev/docs`
- Frontend (page loading, dark mode, accent/a11y): `https://mygo.egoist.dev/docs/frontend.md`
- Desktop APIs (`mygo.Theme.SetSource`, `Theme.Preferences()`): `https://mygo.egoist.dev/docs/native.md`

## What this is

LinkDeck is a desktop serial/TCP workbench built on [mygo](https://mygo.egoist.dev/docs): a Go backend (transports, framing, codecs, embedded Lua scripting) hosts a native window rendering a React/TypeScript workbench. Go methods and events are exposed to the page through generated bindings.

## Commands

Setup: `bun install`, then `go mod download`.

| Task | Command |
|---|---|
| Run the app (native window + Vite) | `bun run dev` (`mygo dev`) |
| Browser-only UI | `bun run dev:web` (bindings/events unavailable — no Go host) |
| Regenerate Go→TS bindings | `bun run generate` (`mygo generate`) |
| Production build | `bun run build` (`mygo build`, embeds `dist/` into the binary) |
| Frontend checks | `bun run check` (biome), `bun run typecheck` (tsc), `bun run build:web`, `bun run knip` |
| All Go tests | `go test ./...` |
| One Go test | `go test ./internal/framing -run TestDelimiterHalfFrames` |
| Race-sensitive packages | `go test -race ./internal/stream ./internal/script` |
| All frontend tests | `bun run test` (vitest) |
| One frontend test file / case | `bunx vitest run src/lib/channels.test.ts` / `bunx vitest run -t "renders ASCII as lowercase hex pairs"` |

`bun run build` is required to produce a shippable app; plain `go build` does not run the frontend build or embed it. Pre-commit (lefthook) runs biome on staged frontend files, `tsc --noEmit`, and `gofmt -l`; CI runs `bun install --frozen-lockfile`, `check`, `typecheck`, frontend tests, `knip`, `build:web`, and `go test ./...`.

`src/mygo.ts` is generated — never edit it by hand. Run `bun run generate` after changing any Go type or method reachable through `mygo.Bind` or any `mygo.NewEvent` payload. Biome and knip intentionally ignore it.

## Architecture

### Layering and import direction

```
internal/serial, internal/tcp   transports: own ports/conns, serialize I/O
        │
        ▼
internal/stream                 per-channel read loop, framer ownership, RX batching
        │
        ▼
internal/script                 Lua engine, matcher pool, opaque handles, Transport contract
        │
internal/automation             native send/delay/expect runs; owns timing and cancellation
        │
internal/link                   adapters from serial/tcp services to script.Transport
        │
        ▼
main.go                         binds services, wires the events, owns the window
```

`internal/framing` and `internal/codec` are pure, standalone libraries. Framing is consumed by the transport/stream layers; codec owns byte↔value conversion (Hex/ASCII/JSON) for frame payloads and must stay free of framing and I/O concerns. `internal/automation` depends on the matcher contract and a small Sender interface, never on driver packages. `internal/link` is the only package besides `main` that imports the drivers plus `script` and `automation`, which keeps the import graph acyclic. New transports plug in as a driver package plus adapters in `link`; the script and automation engines must not learn about drivers.

### RX data path (central invariant)

Per channel: transport bytes → `framing.Framer` (half/sticky/oversize/checksum handling) → `script.Pool.Feed` → unmatched frames batched per feed → `stream.Manager` queue → the `frames` mygo event → frontend.

- **Matcher-first:** a frame matching a pending expectation wakes only the waiting script; it never reaches the UI.
- **Backpressure:** the outbound queue holds 256 batches; when full the oldest batch is dropped and a per-channel `Dropped` counter increments. The read loop never blocks, so floods cannot wedge close/reconnect.
- **Capture ownership:** UI-owned serial/TCP opens set `Stream: true` and own the shared Manager loop. Script-owned opens leave it false and keep an exclusive Recv pump; the two paths must never read the same transport concurrently.
- **Lifetime:** one read goroutine per open channel. Stop order is always *close the transport first* (unblocks an in-flight `Read`), then `Manager.Stop`. Reconnect calls `Reset` to discard half-frame residue but deliberately keeps pending matchers.
- **Wire shape:** `Frame` is bytes in Go; across bindings it becomes `FrameDTO{channel, dir, payload(base64), tsMillis}`.

### Scripting model

`script.Engine` shares one matcher pool and one handle registry across three execution shapes:

- `Engine.Run` — source on the serialized main `LState`.
- `Engine.RunFile` — fresh `LState` per run, destroyed afterwards; channels it opened are closed on teardown.
- `Engine.Load` / `Session.Call` — long-lived `LState` per absolute script path; globals persist, auto-reload happens when mtime/size changes, and a broken edit keeps the previous generation alive.

Handles are opaque userdata owned by the `LState` that minted them; generation teardown closes only that owner's handles. Execution is serialized per state. Timeouts use `context.WithTimeout` on the `LState` (checked every Lua instruction); blocking callbacks poll in ≤50 ms slices (`pollSliceMs`) so they abort between slices. Default timeout is 5 s.

The Lua surface is locked by ticket #4: `serial.*` / `tcp.*` tables, top-level `send_expect`/`expect`, `log`/`hex`/`json` helpers, and `script.load`/session calls. Only base, table, string, math, and coroutine libs are opened; `dofile`/`loadfile` are disabled. Match modes are prefix (default), regex, pattern; first-registered wins; unmatched frames go to a capped backlog and the unmatched handler. Unpreempted host I/O is documented in `internal/script/doc.go`.

Use the vocabulary in `CONTEXT.md` (Channel, Handle, Frame, Framing, Matcher, Codec) in code, tests, issues, and docs.

### Configuration

YAML lives at `os.UserConfigDir()/linkdeck/config.yaml`. Load failures (missing or corrupt) warn and fall back to defaults — never refuse to start. Saves are atomic (temp file + rename). `Resolve` merges explicit open args over a preset over built-in defaults, in that precedence. `main.go` exposes presets, script favorites, reusable Commands, and reusable Sequences via `ConfigAPI`.

### Frontend

React 19 + TypeScript (strict, `noUncheckedIndexedAccess`) + Vite + Tailwind v4. Components follow a hand-ported shadcn-style token approach (no shadcn CLI/runtime); Radix primitives, `lucide-react`, and `sonner` toasts are the adopted primitives. The frame table is the primary traffic view; Monaco lazy-loads for the Lua editor. Heavy panels are code-split via `React.lazy`. Light/dark is CSS-token driven in `src/style.css`.

The canonical workbench layout, visual language, component contracts, and
current frontend gaps live in `docs/design/workbench.md`. Read it before
changing frontend information architecture or visual tokens. The visual
direction is recorded in `docs/adr/0001-signal-bench-visual-language.md`.

`src/lib/channels.ts` is the shared channel/tab contract consumed by sibling panels: treat it as additive-only and coordinate before renaming. It covers serial, TCP client, TCP server, and accepted TCP connections. `useChannels` polls both transports every 3 s as a fallback; the host publishes batched `channel-status` snapshots every 500 ms.

### mygo wiring

`main.go` binds services, then in `mygo.App.WhenReady` creates the window (`StateKey: "main"`), starts a `stream.Manager` whose `Emit` pushes `frames`, attaches that manager to serial/TCP, wires `stream-errors`, `channel-status`, `script-output`, and `script-run-status`, and polls backend lifecycle every 500 ms. `mygo.config.ts` is the build contract: `devUrl` must match Vite's strict port 5173, `buildCommand` produces `dist/`, bindings land in `src/mygo.ts`, and packaged output goes to `build/`. When mygo API behavior is in question, read the pinned source: `go list -m -f '{{.Dir}}' github.com/egoist/mygo` (v0.6.3); upstream doc links are in [Agent skills](#agent-skills) above.

## Project conventions

- Issues and specs live in GitHub Issues via `gh` (conventions in `docs/agents/issue-tracker.md`; triage label mapping in `docs/agents/triage-labels.md`). Before design work, read `CONTEXT.md` and any relevant ADRs in `docs/adr/`; surface conflicts with an ADR explicitly instead of silently overriding it.
- `docs/research/` records the primary-source evidence behind stack decisions (serial library, Lua runtime, frontend stack). Keep decision evidence there rather than in chat.
- All product capabilities are eligible for development. Closed release maps, completion notes, and research documents record implementation status; they never limit future functionality. `serial_cli` is a feature-level reference only — never consult its source.
- Product copy and code comments are English; conversation with the maintainer is Chinese.
