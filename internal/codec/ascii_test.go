package codec

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAsciiPassthrough(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
	}{
		{name: "empty nil", raw: nil},
		{name: "empty slice", raw: []byte{}},
		{name: "printable", raw: []byte("hello, linkdeck")},
		{name: "controls pass through", raw: []byte{0x00, 0x01, 0x07, '\t', '\n', '\r', 0x1B, 0x7F}},
		{name: "high bytes pass through", raw: []byte{0x80, 0xFE, 0xFF}},
		{name: "invalid utf8 passes through", raw: []byte{0xFF, 0xFE, 'A'}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := AsciiEncode(tc.raw)
			assert.Equal(t, string(tc.raw), s)
			back := AsciiDecode(s)
			require.NotNil(t, back)
			want := tc.raw
			if want == nil {
				want = []byte{}
			}
			assert.Equal(t, want, back)
		})
	}
}

func TestAsciiDecodeNeverFails(t *testing.T) {
	// Even embedded NULs and lone surrogates of the Go string world
	// survive: no input can make Decode fail.
	for _, s := range []string{"", "\x00", "a\x00b", "\xff\xfe"} {
		got := AsciiDecode(s)
		require.NotNil(t, got)
		assert.Equal(t, []byte(s), got)
	}
}

func TestAsciiValidate(t *testing.T) {
	cases := []struct {
		name    string
		input   []byte
		wantErr string
	}{
		{name: "empty nil", input: nil},
		{name: "empty slice", input: []byte{}},
		{name: "printable", input: []byte("OK 123")},
		{name: "controls valid", input: []byte{0x00, '\t', '\n', '\r', 0x1B, 0x7F}},
		{name: "high byte at start", input: []byte{0x80, 'A'}, wantErr: "offset 0"},
		{name: "high byte at end", input: []byte{'A', 0xFF}, wantErr: "offset 1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := AsciiValidate(tc.input)
			if tc.wantErr == "" {
				assert.NoError(t, err)
			} else {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
			}
		})
	}
}
