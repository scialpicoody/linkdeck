package codec

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// JsonEncode marshals v to compact JSON via encoding/json, with stdlib
// defaults unchanged: HTML escaping on (<, >, & become \u003c etc.), and a
// []byte value encodes as a base64 string. It never emits a trailing
// newline. A nil value encodes to "null" without error.
func JsonEncode(v any) ([]byte, error) {
	out, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("codec: cannot encode JSON: %w", err)
	}
	return out, nil
}

// JsonDecode parses exactly one complete JSON value from src and returns it
// with stdlib default types (objects as map[string]any, arrays as []any,
// numbers as float64). Empty or whitespace-only input is an error, and so
// is any trailing data after the first value: concatenated or
// newline-delimited JSON streams are NOT split here. Stream boundaries are
// framing's job — a caller holding a stream must frame it into single
// values first, then decode each with this function.
func JsonDecode(src []byte) (any, error) {
	if len(bytes.TrimSpace(src)) == 0 {
		return nil, fmt.Errorf("codec: empty JSON payload")
	}
	dec := json.NewDecoder(bytes.NewReader(src))
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, fmt.Errorf("codec: invalid JSON: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("codec: invalid JSON: trailing data after first value")
		}
		return nil, fmt.Errorf("codec: invalid JSON: %w", err)
	}
	return v, nil
}

// JsonValidate reports whether src holds exactly one complete JSON value,
// under the same single-value rule as JsonDecode.
func JsonValidate(src []byte) error {
	_, err := JsonDecode(src)
	return err
}

func JsonCompact(src []byte) ([]byte, error) {
	// Enforce the single-value rule first: json.Compact's trailing-data
	// behavior is an stdlib detail this package does not depend on.
	if err := JsonValidate(src); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, src); err != nil {
		return nil, fmt.Errorf("codec: invalid JSON: %w", err)
	}
	return buf.Bytes(), nil
}
