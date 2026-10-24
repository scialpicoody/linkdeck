# LinkDeck Workbench Design

Status: adopted

This is the source of truth for the desktop workbench UI. It describes the
current implementation, not an aspirational layout. Product copy and code
comments are English; maintainer conversations may be Chinese.

## Product intent

LinkDeck is a serial/TCP signal bench for people who diagnose devices and
protocols all day. The UI should make the next useful action obvious:

- Watch complete frames arriving on one active channel.
- Transmit a payload without losing sight of the frame stream.
- Inspect a selected frame in place.
- Move into a script workspace without mixing script output into live traffic.

The primary reference is LLCOM's operational density, not its exact layout.
LinkDeck keeps one active channel, a persistent operations dock, quick-send,
and a dedicated script workspace.

## Design principles

### Signal first

The frame stream is the main workspace. Chrome, navigation, and controls must
not consume width that belongs to payloads.

### One active channel

One channel is active at a time. The left rail is for switching, opening, and
configuring channels. There is no top tab strip and no hidden multi-panel
comparison view in v1.

### Persistent operations

Transmit and Inspect live in a right dock beside the stream on wide windows.
On narrow windows they move below the stream rather than disappearing behind
an unrelated navigation action.

### Dense, legible instrument UI

Use compact rows, explicit labels, and monospace data. Density is useful only
when hierarchy remains clear. Avoid decorative cards, oversized headings,
pill-shaped controls, and empty dashboard layouts.

### One visual language

The workbench resembles a warm instrument panel mounted in dark rack chrome:
warm surfaces, ink header and status bar, amber primary actions, and distinct
RX/TX signal colors. Do not mix in generic blue-grey shadcn defaults.

## Information architecture

```text
+-----------------------------------------------------------------------+
| ink header: LinkDeck | Monitor / Scripts | active channel | Connect    |
+--------+---------------------------------------------+----------------+
| channel|                                             | operations     |
| rail   | frame stream                                | Transmit       |
|        |                                             | Inspect        |
|        |                                             |                |
+--------+---------------------------------------------+----------------+
| ink status: state | endpoint | baud | RX/TX | drops | error            |
+-----------------------------------------------------------------------+
```

### Wide window

- Header: 48 px.
- Channel rail: 200 px expanded, 56 px collapsed.
- Frame stream: flexible center column.
- Operations dock: 320 px default width at `xl` and above; resizable from
  260-520 px and persisted locally.
- Status bar: 28 px.

### Narrow window

- The channel rail folds away below `md`. Channel access remains in the header.
- The operations dock moves below the frame stream at a 42% target height,
  clamped to 10rem-55% of the monitor area so both surfaces stay usable.
- Controls may wrap, but the payload column remains the flexible remainder.

### Scripts view

```text
+-----------------------------------------------------------------------+
| ink header: Monitor / Scripts                                        |
+----------------+--------------------------------------+---------------+
| script library | open script tabs                     |               |
| favorites +    +--------------------------------------+               |
| workspace      | Monaco editor                        |               |
|                +--------------------------------------+               |
|                | script output                        |               |
+----------------+--------------------------------------+---------------+
```

The library is persistent at desktop widths. The editor and linked output
share the center column; output is not another narrow right sidebar. Small
windows stack the library above the editor.

## Visual language

### Color

All color decisions are CSS tokens in `src/style.css`. Components use token
utilities such as `bg-card`, `text-rx`, and `border-border`, never literal
palette colors except state-dot data supplied by `stateColor`.

Light mode feels like warm bench paper. Dark mode keeps the same hierarchy on
near-black instrument surfaces. The OS owns the light/dark switch.

| Role | Token | Intent |
|---|---|---|
| Page | `background` | warm grid-backed bench surface |
| Panel | `card` | primary readable workspace |
| Raised panel | `panel-raised` | compact toolbars and section headers |
| Chrome | `chrome` | header and status bar |
| Action | `primary` | amber transmit/connect emphasis |
| Inbound signal | `rx` | green RX direction and waveform |
| Outbound signal | `tx` | orange TX direction |
| Danger | `danger` | failed send, invalid input, connection error |
| Warning | `warning` | paused stream, dropped frames |

The app icon repeats the same language: dark rack panel, amber signal path,
green RX endpoint, orange TX endpoint, and three abstract deck tracks.
Editable source is `resources/icon.svg`; packaged output is
`resources/icon.png`.

### Typography

- UI: Space Grotesk Variable.
- Data and controls: IBM Plex Mono.
- Use the `.eyebrow` utility for short uppercase section labels.
- Use the `.micro-label` utility for compact metadata.
- Numeric traffic, endpoints, payloads, and keyboard shortcuts stay mono.

### Form

- Corners are 6 px or square. Avoid pill controls.
- Prefer borders and tonal layers over large shadows.
- The dotted/grid background is subtle texture, never a competing pattern.
- Accent color indicates action or selected state, not decoration.
- RX and TX always use their semantic colors, including inspector direction.

## Component contracts

### WorkbenchHeader

- Owns top-level `Monitor` / `Scripts` switching.
- Shows the active channel and its state when one exists.
- `Connect` opens the unified channel dialog.
- Keeps transport labels low-emphasis so they do not compete with the action.

### Sidebar

- Lists serial, TCP client, TCP server, and accepted-connection channels with
  kind-specific icons and their current state.
- Selecting a row makes it active and opens it in the workbench model.
- Row settings open the same dialog in edit mode.
- A row close action disconnects the transport and removes the channel.
  Closing a server also removes its accepted-connection channels.
- The rail can collapse to icons without losing the active indication.
- Empty and loading states stay inside the rail and provide an open action.

### FramePanel

- Renders complete frames only. Partial transport chunks never become rows.
- Columns: time, direction, byte length, payload preview.
- Toolbar: direction filter, ASCII/HEX codec, search, pause, follow, clear.
- Search matches both ASCII and hex representations.
- Follow mode renders at most the newest 500 rows.
- Pause freezes the currently visible rows while capture, unread counters, and
  retention continue in the background.
- Retention is bounded per channel at 5000 frames and 8 MiB. Clear removes
  visible rows without resetting session statistics.
- Row selection drives the Inspect dock.
- Empty states distinguish no channel, no frames, and no filter matches.

### Composer

- Is always available beside live traffic on wide windows.
- Supports ASCII and HEX codecs.
- ASCII supports None/LF/CRLF; HEX sends bytes verbatim.
- Invalid HEX stays local and never reaches the transport.
- History is per codec, capped at 50 entries.
- Quick-send entries persist locally and preserve their codec.
- `Cmd/Ctrl+Enter` sends. `Cmd/Ctrl+Up/Down` recalls history.
- A failed TX creates a visible error row, an inline error, and a toast.

### FrameInspector

- Shows the selected frame as hex, ASCII, and decoded JSON views.
- Always shows session totals for frames, bytes, and errors plus a rolling
  60-second RX/TX throughput chart; throughput uses at most 60 one-second
  buckets.
- Escape and the close button clear the selection.
- With no selection it shows a task-oriented empty state, not stale data.
- It shares dock chrome with Transmit and never opens as a disconnected overlay.

### StatusBar

- Shows channel kind/state, endpoint, baud when known, RX/TX counters,
  cumulative queue drops, framing failures, and the latest channel error.
- Counters can be reset from the status bar.
- The wall clock is intentionally absent.

### ChannelDialog

- One dialog covers create and edit.
- The transport selector covers serial, TCP client, and TCP server without
  separate dialogs.
- Serial exposes port and line parameters. TCP client exposes remote address,
  connect timeout, reconnect policy, heartbeat, and framing. TCP server
  exposes a listen address and framing; port 0 binds an available port.
- Accepted TCP connections are channels but inherit their server's framing
  and cannot be edited independently.
- Framing exposes delimiter, fixed-size, length-prefix, and
  header-length-checksum parameters, including a shared frame-size cap.
- Edit opens a different backend key before closing the old one. Same-backend
  edits close first and attempt to restore the last successful configuration
  on failure.
- Presets fill the form and can be saved, renamed, or deleted from the same
  dialog. Presets persist transport, endpoint, serial/TCP options, reconnect
  policy, heartbeat, and typed framing. Typed framing specs take precedence
  over legacy string options.

### Scripts

- The library lists real workspace `.lua` files, sorted by relative path, with
  favorites separated above the workspace list.
- Create adds a collision-safe top-level Lua file in the configured workspace.
- Tabs show dirty state; closing a dirty tab requires confirmation, and saves
  use an optimistic revision so an external edit is never overwritten silently.
- Favorites persist through `ConfigAPI`; entries removed from the workspace are
  pruned on refresh.
- Selecting a script opens a per-script editor tab.
- Editor sources remain separate per tab.
- Run source and Run saved create stable run ids and show queued, running,
  completed, failed, timed-out, or cancelled state. Timeout is configurable.
- A long-lived session can be loaded, called by function name, cancelled, and
  closed. Session files auto-reload when mtime/size changes; broken edits report
  the reload error while the previous generation remains available.
- Script output appears below the active editor in a dedicated pane, filtered
  to the active script and capped at 1000 rows for the workbench session.
- Output rows distinguish log, TX, RX, unmatched frame, error, and system
  events. Runtime errors expose their source line and jump into Monaco.

## Interaction rules

- Make the active channel visually unambiguous in the rail, header, and status
  bar.
- Switching channels resets frame selection and inline send errors.
- Clearing frames also clears selection.
- Destructive actions stay explicit; avoid confirmation dialogs for reversible
  UI actions such as clearing the current frame view.
- Keyboard shortcuts supplement visible controls; they never become the only
  way to perform an action.
- Use tooltips for unfamiliar icon-only controls, not as a substitute for clear
  labels where space permits.
- The operations dock separator supports pointer drag plus Left/Right, Home,
  End, and 0 (reset) keys. It exposes its current width and bounds to assistive
  technology and never steals focus from the frame table during resizing.

## State coverage

Every new panel must design these states before implementation:

1. No channel or no selection.
2. Loading or connecting.
3. Healthy live data.
4. Empty but ready.
5. Error or failed action.
6. Paused or disconnected, where applicable.

Placeholder text should say what the user can do next. Do not use fake traffic
to make an empty workbench look populated.

## Implementation map

- App composition and state wiring: `src/App.tsx`
- Design tokens and global texture: `src/style.css`
- Header and view switch: `src/components/layout/WorkbenchHeader.tsx`
- Channel rail: `src/components/layout/Sidebar.tsx`
- Frame stream: `src/components/frames/FramePanel.tsx`
- Transmit dock: `src/components/frames/Composer.tsx`
- Frame inspection: `src/components/frames/FrameInspector.tsx`
- Frame ingestion/retention/statistics: `src/lib/frame-ingest.ts`,
  `src/lib/capture-session.ts`, `src/lib/use-capture-sessions.ts`,
  `src/lib/frame-store.ts`, `src/lib/frame-stats.ts`, `src/lib/frame-identity.ts`,
  `src/lib/frame-view.ts`
- Operations dock sizing: `src/lib/dock-layout.ts`, `src/style.css`
- Script workspace: `src/components/scripts/`
- Status bar: `src/components/layout/StatusBar.tsx`
- Native window and icon: `main.go`, `resources/`

## Operational guarantees

- The host publishes batched `channel-status` snapshots every 500 ms; the
  frontend also polls serial and TCP state every 3 seconds as a fallback.
- Serial removal and TCP drops preserve channel identity, counters, and frame
  history. The rail/status show disconnected, reconnecting, closed, or error
  state instead of pretending the channel is live.
- Accepted TCP peers have independent stream ownership; remote close releases
  their stream slot. UI-owned transports enable the shared capture loop, while
  script-owned transports keep an exclusive Recv pump.
- The frame stream ingests live RX batches and local TX rows into one ordering
  contract. Queue drops and framing failures remain cumulative per channel.

Future work should preserve this document's information architecture and visual
tokens unless a new design decision explicitly supersedes it.
