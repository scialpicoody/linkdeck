// Package tcp owns LinkDeck's TCP transport: a reconnecting dial client
// and a multi-connection listen server.
//
// Channel/Handle/Frame vocabulary follows CONTEXT.md. Every channel here
// (client or one accepted server connection) is a byte stream; the framing
// slice turns streams into Frames, the codec slice converts payloads, and
// the script slice matches expectations against frames.
//
// Reconnect contract (client): a drop clears frame residue (any partial
// bytes held for framing) but preserves pending matchers. Concretely,
// Client drops its internal residue buffer on every successful (re)connect
// and never touches matcher state, which lives above this package. The
// script slice hooks in by re-issuing its pending expect list against the
// fresh stream; it MUST NOT assume continuity of partial frames across a
// reconnect. See Client.ResetFraming for the explicit hook point.
//
// Payloads cross mygo bindings as base64 strings; in Go they are []byte.
// See Frame for the DTO every slice assumes.
package tcp
