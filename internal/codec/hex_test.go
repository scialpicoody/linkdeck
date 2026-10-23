package codec

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHexEncode(t *testing.T) {
	cases := []struct {
		name  string
		input []byte
		want  string
	}{
		{name: "empty nil", input: nil, want: ""},
		{name: "empty slice", input: []byte{}, want: ""},
		{name: "single byte", input: []byte{0x0A}, want: "0a"},
		{name: "lowercase canonical", input: []byte{0xDE, 0xAD, 0xBE, 0xEF}, want: "deadbeef"},
		{name: "all zeros", input: []byte{0x00, 0x00}, want: "0000"},
		{name: "text", input: []byte("Hi"), want: "4869"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, HexEncode(tc.input))
		})
	}
}

func TestHexDecode(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		want    []byte
		wantErr string
	}{
		{name: "empty", input: "", want: []byte{}},
		{name: "whitespace only", input: "  \t\n", want: []byte{}},
		{name: "lowercase", input: "deadbeef", want: []byte{0xDE, 0xAD, 0xBE, 0xEF}},
		{name: "uppercase", input: "DEADBEEF", want: []byte{0xDE, 0xAD, 0xBE, 0xEF}},
		{name: "mixed case", input: "dEaDbEeF", want: []byte{0xDE, 0xAD, 0xBE, 0xEF}},
		{name: "spaces between bytes", input: "de ad be ef", want: []byte{0xDE, 0xAD, 0xBE, 0xEF}},
		{name: "tabs and newlines", input: "de\tad\nbe\r\nef", want: []byte{0xDE, 0xAD, 0xBE, 0xEF}},
		{name: "leading trailing space", input: "  00ff  ", want: []byte{0x00, 0xFF}},
		{name: "round trip text", input: "4869", want: []byte("Hi")},
		{name: "odd digits", input: "abc", wantErr: "invalid hex"},
		{name: "odd after strip", input: "a b c", wantErr: "invalid hex"},
		{name: "non-hex digit", input: "zz", wantErr: "invalid hex"},
		{name: "0x prefix rejected", input: "0x12", wantErr: "invalid hex"},
		{name: "colon separator rejected", input: "de:ad", wantErr: "invalid hex"},
		{name: "dash separator rejected", input: "de-ad", wantErr: "invalid hex"},
		{name: "0x alone rejected", input: "0x", wantErr: "invalid hex"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := HexDecode(tc.input)
			if tc.wantErr == "" {
				require.NoError(t, err)
				require.NotNil(t, got)
				assert.Equal(t, tc.want, got)
			} else {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
			}
		})
	}
}

func TestHexRoundTrip(t *testing.T) {
	payloads := [][]byte{nil, {}, {0x00}, []byte("frame-bytes \x00\xff")}
	for _, p := range payloads {
		decoded, err := HexDecode(HexEncode(p))
		require.NoError(t, err)
		want := p
		if want == nil {
			want = []byte{}
		}
		assert.Equal(t, want, decoded)
	}
}

func TestHexValidate(t *testing.T) {
	assert.NoError(t, HexValidate("aA 09"))
	assert.NoError(t, HexValidate(""))
	require.Error(t, HexValidate("0x01"))
	require.Error(t, HexValidate("0"))
}
