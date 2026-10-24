# CONTEXT.md

Ubiquitous language for LinkDeck. Glossary only; no implementation details.

## Glossary

- **Channel**: a named communication endpoint (serial port, TCP client, TCP server, or one accepted TCP connection). Channels share framing and codec behavior.
- **Handle**: the opaque Lua-side reference to a channel. Scripts can only use handles through the scripting API, never inspect their fields.
- **Frame**: one complete message cut from a byte stream by a framing implementation (delimiter, length-prefix, fixed-size, or header-length-checksum).
- **Framing**: the layer that turns transport byte streams into frames. Handles half frames, sticky frames, oversize caps, and checksum failures.
- **Matcher**: a registered expectation (pattern plus timeout) waiting for a frame. `send_expect` registers one and then sends; `expect` only registers. First registered, first matched.
- **Codec**: byte-level value conversion (Hex, ASCII, JSON). Works above the byte layer; never participates in framing.
- **Command**: a named outbound payload with codec and line-ending settings.
- **Sequence**: an ordered program of send, delay, expect, and assertion steps.
- **Automation Run**: one immutable execution of a Sequence against one Channel.
