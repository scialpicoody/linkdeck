package codec

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestJsonEncode(t *testing.T) {
	cases := []struct {
		name  string
		input any
		want  string
	}{
		{name: "nil is null", input: nil, want: "null"},
		{name: "object compact", input: map[string]any{"b": 1.0, "a": "x"}, want: `{"a":"x","b":1}`},
		{name: "array", input: []any{1.0, "two", false}, want: `[1,"two",false]`},
		{name: "string", input: "hi", want: `"hi"`},
		{name: "number", input: 42, want: `42`},
		{name: "bool", input: true, want: `true`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := JsonEncode(tc.input)
			require.NoError(t, err)
			assert.JSONEq(t, tc.want, string(got))
			assert.NotContains(t, string(got), "\n")
		})
	}
}

func TestJsonEncodeError(t *testing.T) {
	_, err := JsonEncode(map[string]any{"bad": func() {}})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "cannot encode JSON")
}

func TestJsonDecode(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    any
		wantErr string
	}{
		{name: "empty", input: "", wantErr: "empty JSON"},
		{name: "whitespace only", input: "  \n\t ", wantErr: "empty JSON"},
		{name: "object", input: `{"a":1}`, want: map[string]any{"a": 1.0}},
		{name: "object with whitespace", input: "  { \"a\" : 1 }  ", want: map[string]any{"a": 1.0}},
		{name: "array", input: `[1, "two", null]`, want: []any{1.0, "two", nil}},
		{name: "string", input: `"hi"`, want: "hi"},
		{name: "number is float64", input: `42`, want: 42.0},
		{name: "bool", input: `true`, want: true},
		{name: "null", input: `null`, want: nil},
		{name: "truncated", input: `{"a":`, wantErr: "invalid JSON"},
		{name: "not json", input: `hello`, wantErr: "invalid JSON"},
		{name: "trailing value rejected", input: `{} {}`, wantErr: "trailing data"},
		{name: "ndjson pair rejected", input: "{\"a\":1}\n{\"b\":2}", wantErr: "trailing data"},
		{name: "trailing garbage rejected", input: `[] x`, wantErr: "invalid JSON"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := JsonDecode([]byte(tc.input))
			if tc.wantErr == "" {
				require.NoError(t, err)
				assert.Equal(t, tc.want, got)
			} else {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
			}
		})
	}
}

func TestJsonValidate(t *testing.T) {
	assert.NoError(t, JsonValidate([]byte(`{"a":[1,2]}`)))
	assert.NoError(t, JsonValidate([]byte(`  "x"  `)))
	require.Error(t, JsonValidate(nil))
	require.Error(t, JsonValidate([]byte{}))
	require.Error(t, JsonValidate([]byte(`{"a":1} {"b":2}`)))
	require.Error(t, JsonValidate([]byte(`{oops}`)))
}

func TestJsonCompact(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    string
		wantErr string
	}{
		{name: "empty", input: "", wantErr: "empty JSON"},
		{name: "already compact", input: `{"a":1}`, want: `{"a":1}`},
		{name: "whitespace elided", input: "{\n  \"a\" : [ 1 , 2 ]\n}", want: `{"a":[1,2]}`},
		{name: "scalar", input: `  12  `, want: `12`},
		{name: "stream rejected", input: "{\"a\":1}\n{\"b\":2}", wantErr: "trailing data"},
		{name: "malformed", input: `{"a":}`, wantErr: "invalid JSON"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := JsonCompact([]byte(tc.input))
			if tc.wantErr == "" {
				require.NoError(t, err)
				assert.Equal(t, tc.want, string(got))
			} else {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
			}
		})
	}
}

func TestJsonRoundTrip(t *testing.T) {
	for _, v := range []any{nil, "s", 1.5, true, []any{1.0}, map[string]any{"k": "v"}} {
		raw, err := JsonEncode(v)
		require.NoError(t, err)
		back, err := JsonDecode(raw)
		require.NoError(t, err)
		assert.Equal(t, v, back)
		compacted, err := JsonCompact(raw)
		require.NoError(t, err)
		assert.Equal(t, string(raw), string(compacted))
	}
}
