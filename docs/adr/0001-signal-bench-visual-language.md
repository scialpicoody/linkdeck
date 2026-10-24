# 0001: Use a signal-bench visual language for the workbench

Status: accepted

## Context

The first workbench implementation used generic blue-grey semantic tokens and
an inspector that competed with the frame stream for width. It was functional,
but it read like a dashboard rather than a professional serial/TCP tool. The
maintainer asked for a redesign with LLCOM-level operational density, stronger
space utilization, and a clearer action flow.

The replacement needed to support:

- One active channel with fast switching.
- A frame stream that remains the dominant workspace.
- Always-available transmit and inspection.
- A separate scripting workspace rather than another crowded sidebar tab.
- Immediate recognition of RX, TX, actions, warnings, and errors.

## Decision

Adopt an instrument-panel visual language and an operational three-part
workbench:

1. Dark rack chrome for the header and status bar.
2. Warm, layered panel surfaces for the channel rail, frame stream, and tools.
3. Amber as the action color, with dedicated green RX and orange TX signals.

Use Space Grotesk for UI text and IBM Plex Mono for endpoints, payloads,
counters, and compact controls. Keep corners small, borders explicit, and
decoration subordinate to traffic. A persistent right operations dock replaces
the width-consuming inspector that previously appeared on demand.

The complete layout and component contract live in
`docs/design/workbench.md`. The app icon uses the same signal, endpoint, and
deck-track vocabulary.

## Alternatives considered

- Keep generic shadcn blue-grey tokens and only tighten spacing. Rejected:
  density alone would not establish product identity or RX/TX semantics.
- Copy LLCOM's layout literally. Rejected: LinkDeck needs persistent quick-send,
  in-place frame inspection, and a first-class script workspace.
- Put every tool in collapsible panels around a terminal. Rejected: it causes
  controls to disappear and makes the next action less predictable.
- Use a light-only UI skill page. Rejected: the workbench must follow the OS
  light/dark preference and remain usable in either mode.

## Consequences

- New UI work must reuse the tokens and component patterns in
  `src/style.css`; adding a parallel palette is a design regression.
- Layout changes must protect the frame stream's flexible width and the
  persistent operations dock on wide windows.
- Screenshots and future prototypes are easier to evaluate because RX, TX,
  action, and error semantics are stable.
- The visual direction is intentionally specific. A future neutral or
  marketing-oriented theme would be a separate product decision, not a
  component-local variation.
