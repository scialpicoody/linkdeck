// Package codec owns LinkDeck's byte-level value conversions (Hex, ASCII,
// JSON) between frame payloads and script-visible values.
//
// It works strictly above the byte layer: it never participates in framing,
// never touches transports or channels, and never performs I/O. Every
// function here is pure: same input, same output, no goroutines, no globals,
// safe for concurrent use.
//
// Strictness choices (normative for this package):
//
// Hex: Encode emits lowercase, separator-free, prefix-free hex (the
// encoding/hex canonical form). Decode is case-insensitive and strips ASCII
// whitespace (space, tab, LF, VT, FF, CR) anywhere, so spaced hexdumps and
// multi-line pastes decode directly. Anything else is strict: "0x" prefixes,
// separators (":", "-", …), odd digit counts, and non-hex digits are errors,
// never silently skipped. Empty or whitespace-only input decodes to an empty
// (non-nil) payload with no error.
//
// ASCII: Encode and Decode are raw passthroughs that never fail and never
// alter bytes. Non-printable policy: control bytes and bytes above 0x7F pass
// through untouched in both directions; display escaping is a frontend
// concern, not a codec transformation. AsciiValidate separately enforces
// 7-bit ASCII (every byte <= 0x7F) for callers that need a check.
//
// JSON: Encode delegates to encoding/json (compact output, stdlib default
// HTML escaping, []byte encodes as a base64 string — all stdlib behavior,
// unchanged here). Decode and Compact require exactly one complete JSON
// value: empty or whitespace-only input is an error, and trailing bytes
// after the first value are an error. Concatenated or newline-delimited
// JSON streams are NOT split here — stream boundaries are framing's job, so
// a decoder that must split streams belongs in the framing layer, not here.
// Decoded numbers use the stdlib default (float64).
package codec
