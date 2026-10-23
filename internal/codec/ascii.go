package codec

import (
	"fmt"
)

// AsciiEncode renders b as a string with zero transformation: every byte,
// including control bytes and bytes above 0x7F, maps to the same-valued
// byte in the result. It never fails.
func AsciiEncode(b []byte) string {
	return string(b)
}

// AsciiDecode converts s to its raw bytes with zero transformation: every
// byte, including embedded NULs and non-UTF-8 sequences, survives. It never
// fails and never validates; use AsciiValidate when a check is needed.
// Empty input yields an empty (non-nil) payload.
func AsciiDecode(s string) []byte {
	out := make([]byte, len(s))
	copy(out, s)
	return out
}

// AsciiValidate enforces 7-bit ASCII: every byte must be <= 0x7F. Control
// bytes (including NUL, LF, CR, TAB) are valid — they pass through the codec
// untouched by design, and escaping them for display is a frontend concern,
// not a codec transformation. Only bytes above 0x7F fail, reported with
// their first offending offset.
func AsciiValidate(b []byte) error {
	for i := range b {
		if b[i] > 0x7F {
			return fmt.Errorf("codec: non-ASCII byte 0x%02X at offset %d", b[i], i)
		}
	}
	return nil
}
