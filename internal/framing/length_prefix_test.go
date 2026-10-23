package framing

import (
	"encoding/binary"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ Framer = (*LengthPrefixFramer)(nil)

// buildLP assembles one wire frame: header bytes, a width-byte big/little
// endian length, then the payload.
func buildLP(t *testing.T, header []byte, width int, order binary.ByteOrder, payload []byte) []byte {
	t.Helper()
	wire := append([]byte(nil), header...)
	switch width {
	case 1:
		require.Less(t, len(payload), 256)
		wire = append(wire, byte(len(payload)))
	case 2:
		var b [2]byte
		order.PutUint16(b[:], uint16(len(payload)))
		wire = append(wire, b[:]...)
	case 4:
		var b [4]byte
		order.PutUint32(b[:], uint32(len(payload)))
		wire = append(wire, b[:]...)
	default:
		t.Fatalf("bad width %d", width)
	}
	return append(wire, payload...)
}

func TestNewLengthPrefixErrors(t *testing.T) {
	_, err := NewLengthPrefix(LengthPrefixConfig{Offset: -1, Width: 1})
	assert.ErrorContains(t, err, "must not be negative")

	for _, w := range []int{0, 3, 5, 8} {
		_, err := NewLengthPrefix(LengthPrefixConfig{Offset: 0, Width: w})
		assert.ErrorContains(t, err, "must be 1, 2, or 4", "width %d", w)
	}

	_, err = NewLengthPrefix(LengthPrefixConfig{Offset: 4, Width: 2, MaxFrameSize: 5})
	assert.ErrorContains(t, err, "exceeds max frame size")
}

func TestLengthPrefixRoundTrip(t *testing.T) {
	cases := []struct {
		name    string
		offset  int
		width   int
		order   binary.ByteOrder
		payload []byte
	}{
		{name: "u8 no offset", offset: 0, width: 1, order: binary.BigEndian, payload: []byte("hi")},
		{name: "u16be with SOF", offset: 1, width: 2, order: binary.BigEndian, payload: []byte("hello modem")},
		{name: "u16le with SOF", offset: 1, width: 2, order: binary.LittleEndian, payload: []byte("hello modem")},
		{name: "u32be empty payload", offset: 0, width: 4, order: binary.BigEndian, payload: []byte{}},
		{name: "u32le", offset: 0, width: 4, order: binary.LittleEndian, payload: []byte{0x01, 0x02, 0x03}},
		{name: "offset two-byte header", offset: 2, width: 1, order: binary.BigEndian, payload: []byte("x")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, err := NewLengthPrefix(LengthPrefixConfig{
				Offset: tc.offset, Width: tc.width, Order: tc.order,
			})
			require.NoError(t, err)
			header := []byte{0x7E, 0x55}[:tc.offset]
			wire := buildLP(t, header, tc.width, tc.order, tc.payload)
			frames, err := f.Feed(wire)
			require.NoError(t, err)
			require.Len(t, frames, 1)
			assert.Equal(t, wire, []byte(frames[0]))
		})
	}
}

func TestLengthPrefixSplitPoints(t *testing.T) {
	header := []byte{0x7E}
	payload := []byte("split-me")
	wire := buildLP(t, header, 2, binary.BigEndian, payload)

	for split := range len(wire) + 1 {
		f, err := NewLengthPrefix(LengthPrefixConfig{Offset: 1, Width: 2})
		require.NoError(t, err)

		frames, err := f.Feed(wire[:split])
		require.NoError(t, err)
		if split == len(wire) {
			// Whole frame fed at once: decodes immediately.
			require.Len(t, frames, 1, "split %d", split)
			assert.Equal(t, wire, []byte(frames[0]))
			continue
		}
		assert.Empty(t, frames, "split %d: half frame must buffer", split)

		frames, err = f.Feed(wire[split:])
		require.NoError(t, err)
		require.Len(t, frames, 1, "split %d", split)
		assert.Equal(t, wire, []byte(frames[0]))
	}
}

func TestLengthPrefixSticky(t *testing.T) {
	f, err := NewLengthPrefix(LengthPrefixConfig{Offset: 0, Width: 1})
	require.NoError(t, err)
	a := buildLP(t, nil, 1, binary.BigEndian, []byte("one"))
	b := buildLP(t, nil, 1, binary.BigEndian, []byte("two!"))
	frames, err := f.Feed(append(a, b...))
	require.NoError(t, err)
	require.Len(t, frames, 2)
	assert.Equal(t, a, []byte(frames[0]))
	assert.Equal(t, b, []byte(frames[1]))
}

func TestLengthPrefixOversize(t *testing.T) {
	f, err := NewLengthPrefix(LengthPrefixConfig{Offset: 0, Width: 2, MaxFrameSize: 16})
	require.NoError(t, err)

	// Declared length 1000 blows the 16-byte cap.
	var lenBytes [2]byte
	binary.BigEndian.PutUint16(lenBytes[:], 1000)
	_, err = f.Feed(append(lenBytes[:], make([]byte, 8)...))
	assert.ErrorIs(t, err, ErrOversize)

	// Stream recovers: the corrupt bytes were evicted.
	good := buildLP(t, nil, 2, binary.BigEndian, []byte("ok"))
	frames, err := f.Feed(good)
	require.NoError(t, err)
	require.Len(t, frames, 1)
	assert.Equal(t, good, []byte(frames[0]))
}

func TestLengthPrefixResetDropsResidue(t *testing.T) {
	f, err := NewLengthPrefix(LengthPrefixConfig{Offset: 0, Width: 1})
	require.NoError(t, err)
	wire := buildLP(t, nil, 1, binary.BigEndian, []byte("hello"))
	_, err = f.Feed(wire[:3]) // half frame: len byte + partial payload
	require.NoError(t, err)

	f.Reset() // EOF: fragment gone.

	frames, err := f.Feed(wire)
	require.NoError(t, err)
	require.Len(t, frames, 1)
	assert.Equal(t, wire, []byte(frames[0]))
}

func TestLengthPrefixEmptyFeeds(t *testing.T) {
	f, err := NewLengthPrefix(LengthPrefixConfig{Offset: 0, Width: 1})
	require.NoError(t, err)
	for _, p := range [][]byte{nil, {}} {
		frames, err := f.Feed(p)
		assert.NoError(t, err)
		assert.Nil(t, frames)
	}
}
