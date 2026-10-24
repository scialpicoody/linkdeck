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
- Operations dock: 320 px fixed width at `xl` and above.
- Status bar: 28 px.

### Narrow window

- The channel rail folds away below `md`. Channel access remains in the header.
- The operations dock moves below the frame stream and occupies 42% of the
  monitor area.
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

- Lists discovered channels and their current state.
- Selecting a row makes it active and opens it in the workbench model.
- Row settings open the same dialog in edit mode.
- The rail can collapse to icons without losing the active indication.
- Empty and loading states stay inside the rail and provide an open action.

### FramePanel

- Renders complete frames only. Partial transport chunks never become rows.
- Columns: time, direction, byte length, payload preview.
- Toolbar: direction filter, ASCII/HEX codec, search, pause, follow, clear.
- Search matches both ASCII and hex representations.
- Follow mode renders at most the newest 500 rows.
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
- Escape and the close button clear the selection.
- With no selection it shows a task-oriented empty state, not stale data.
- It shares dock chrome with Transmit and never opens as a disconnected overlay.

### StatusBar

- Shows channel state, endpoint, baud when known, RX/TX counters, drops, and
  the latest channel error.
- Counters can be reset from the status bar.
- The wall clock is intentionally absent.

### ChannelDialog

- One dialog covers create and edit.
- Create selects or enters an endpoint, serial parameters, and framing.
- Framing exposes delimiter, fixed-size, length-prefix, and
  header-length-checksum parameters, including a shared frame-size cap.
- Edit closes and attempts to reopen the channel with the submitted settings.
- Failures stay visible in the dialog. Transactional reopen/rollback is not
  implemented yet.
- Presets fill the form. Preset authoring is not part of this dialog yet.

### Scripts

- The library lists favorites and workspace scripts.
- Selecting a script opens a per-script editor tab.
- Editor sources remain separate per tab.
- Script output appears below the active editor and supports error-line jumps.
- The favorite load/save props are the persistence seam; `ConfigAPI` wiring,
  workspace scanning, and runtime integration are tracked separately.

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
- Script workspace: `src/components/scripts/`
- Status bar: `src/components/layout/StatusBar.tsx`
- Native window and icon: `main.go`, `resources/`

## Current operational gaps

These are implementation gaps, not reasons to change the visual direction:

- Scripts still use demo entries and the run action is a stub.
- Edit-channel failure does not yet restore the prior connection settings.
- The operations dock is fixed-width rather than resizable.
- Preset writing and TCP channel creation are not exposed in the current dialog.
- Channel discovery still models every polled serial device as a channel rather
  than distinguishing devices from open channels.

The frame stream now ingests live RX batches, surfaces per-channel dropped and
framing-error counters in the status bar, and applies the dialog's framing
configuration to serial and TCP client read loops.

Future work should preserve this document's information architecture and visual
tokens unless a new design decision explicitly supersedes it.
