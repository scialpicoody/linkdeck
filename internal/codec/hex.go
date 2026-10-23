package codec

import (
	"encoding/hex"
	"fmt"
)

// HexEncode renders b as lowercase, separator-free, prefix-free hex — the
// encoding/hex canonical form. Empty input encodes to "".
func HexEncode(b []byte) string {
	return hex.EncodeToString(b)
}

// HexDecode parses the canonical form from HexEncode, case-insensitively:
// upper- and lowercase digits mix freely. ASCII whitespace (space, tab, LF,
// VT, FF, CR) is stripped anywhere before decoding, so spaced hexdumps and
// multi-line pastes decode directly.
//
// Strict rejections (all errors, never silent skips): "0x" prefixes,
// separators such as ":" or "-", odd digit counts, and non-hex digits.
// Empty or whitespace-only input yields an empty (non-nil) payload and no
// error.
func HexDecode(s string) ([]byte, error) {
	stripped := stripHexWhitespace(s)
	// hex.DecodeString rejects odd lengths, non-hex digits, and any
	// prefix/separator characters — exactly this package's strict set —
	// with errors that already name the offending byte offset.
	dst := make([]byte, hex.DecodedLen(len(stripped)))
	if _, err := hex.Decode(dst, stripped); err != nil {
		return nil, fmt.Errorf("codec: invalid hex: %w", err)
	}
	return dst, nil
}

// HexValidate reports whether s would decode under HexDecode without
// returning the bytes.
func HexValidate(s string) error {
	_, err := HexDecode(s)
	return err
}

// stripHexWhitespace removes ASCII whitespace (space, tab, LF, VT, FF, CR)
// from s. It returns nil for empty or whitespace-only input so callers keep
// a single code path.
func stripHexWhitespace(s string) []byte {
	if s == "" {
		return nil
	}
	buf := make([]byte, 0, len(s))
	for i := range s {
		if isHexSpace(s[i]) {
			continue
		}
		buf = append(buf, s[i])
	}
	return buf
}

// isHexSpace reports the ASCII whitespace HexDecode tolerates.
func isHexSpace(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\v', '\f', '\r':
		return true
	}
	return false
}
