package framing

import (
	"encoding/binary"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ Framer = (*HeaderChecksumFramer)(nil)

// buildHLC assembles one wire frame: header, a width-byte length at offset,
// payload, then the checksum byte over everything before it.
func buildHLC(t *testing.T, header []byte, offset, width int, order binary.ByteOrder, kind ChecksumKind, payload []byte) []byte {
	t.Helper()
	require.GreaterOrEqual(t, offset, len(header))
	wire := append([]byte(nil), header...)
	wire = append(wire, make([]byte, offset-len(header))...)
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
	wire = append(wire, payload...)
	return append(wire, kind.compute(wire))
}

func mustHLC(t *testing.T, cfg HeaderChecksumConfig) *HeaderChecksumFramer {
	t.Helper()
	f, err := NewHeaderLengthChecksum(cfg)
	require.NoError(t, err)
	return f
}

func TestChecksumKindString(t *testing.T) {
	assert.Equal(t, "xor", ChecksumXOR.String())
	assert.Equal(t, "sum8", ChecksumSum8.String())
	assert.Equal(t, "crc8", ChecksumCRC8.String())
	assert.Equal(t, "unknown", ChecksumKind(99).String())
}

func TestNewHeaderLengthChecksumErrors(t *testing.T) {
	good := HeaderChecksumConfig{
		Header: []byte{0xAA}, LengthOffset: 1, LengthWidth: 1, Checksum: ChecksumXOR,
	}
	_, err := NewHeaderLengthChecksum(good)
	assert.NoError(t, err)

	bad := good
	bad.Header = nil
	_, err = NewHeaderLengthChecksum(bad)
	assert.ErrorContains(t, err, "header must not be empty")

	bad = good
	bad.LengthWidth = 3
	_, err = NewHeaderLengthChecksum(bad)
	assert.ErrorContains(t, err, "must be 1, 2, or 4")

	bad = good
	bad.LengthOffset = 0 // inside the 1-byte header
	_, err = NewHeaderLengthChecksum(bad)
	assert.ErrorContains(t, err, "must not start inside")

	bad = good
	bad.Checksum = ChecksumKind(99)
	_, err = NewHeaderLengthChecksum(bad)
	assert.ErrorContains(t, err, "unknown checksum kind")

	bad = good
	bad.MaxFrameSize = 2 // minimal frame is 1+1+0+1 = 4
	_, err = NewHeaderLengthChecksum(bad)
	assert.ErrorContains(t, err, "exceeds max frame size")
}

func TestHeaderChecksumGoldens(t *testing.T) {
	// header AA, len 02, payload 01 02: xor(AA,02,01,02) == AB.
	xor := buildHLC(t, []byte{0xAA}, 1, 1, binary.BigEndian, ChecksumXOR, []byte{0x01, 0x02})
	assert.Equal(t, []byte{0xAA, 0x02, 0x01, 0x02, 0xAB}, xor)

	// sum8(AA,02,01,02) == 0xAF.
	sum := buildHLC(t, []byte{0xAA}, 1, 1, binary.BigEndian, ChecksumSum8, []byte{0x01, 0x02})
	assert.Equal(t, []byte{0xAA, 0x02, 0x01, 0x02, 0xAF}, sum)
}

func TestHeaderChecksumKinds(t *testing.T) {
	for _, kind := range []ChecksumKind{ChecksumXOR, ChecksumSum8, ChecksumCRC8} {
		t.Run(kind.String(), func(t *testing.T) {
			f := mustHLC(t, HeaderChecksumConfig{
				Header: []byte{0xAA}, LengthOffset: 1, LengthWidth: 1, Checksum: kind,
			})
			wire := buildHLC(t, []byte{0xAA}, 1, 1, binary.BigEndian, kind, []byte("data"))
			frames, err := f.Feed(wire)
			require.NoError(t, err)
			require.Len(t, frames, 1)
			assert.Equal(t, wire, []byte(frames[0]))
		})
	}
}

func TestHeaderChecksumSplitPoints(t *testing.T) {
	wire := buildHLC(t, []byte{0xAA, 0x55}, 2, 2, binary.BigEndian, ChecksumCRC8, []byte("split-me"))

	for split := range len(wire) + 1 {
		f := mustHLC(t, HeaderChecksumConfig{
			Header: []byte{0xAA, 0x55}, LengthOffset: 2, LengthWidth: 2, Checksum: ChecksumCRC8,
		})
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

func TestHeaderChecksumSticky(t *testing.T) {
	f := mustHLC(t, HeaderChecksumConfig{
		Header: []byte{0xAA}, LengthOffset: 1, LengthWidth: 1, Checksum: ChecksumXOR,
	})
	a := buildHLC(t, []byte{0xAA}, 1, 1, binary.BigEndian, ChecksumXOR, []byte("one"))
	b := buildHLC(t, []byte{0xAA}, 1, 1, binary.BigEndian, ChecksumXOR, []byte("two"))
	frames, err := f.Feed(append(a, b...))
	require.NoError(t, err)
	require.Len(t, frames, 2)
	assert.Equal(t, a, []byte(frames[0]))
	assert.Equal(t, b, []byte(frames[1]))
}

func TestHeaderChecksumBadChecksum(t *testing.T) {
	newFramer := func(t *testing.T) *HeaderChecksumFramer {
		return mustHLC(t, HeaderChecksumConfig{
			Header: []byte{0xAA}, LengthOffset: 1, LengthWidth: 1, Checksum: ChecksumXOR,
		})
	}
	good := func(t *testing.T, payload string) []byte {
		return buildHLC(t, []byte{0xAA}, 1, 1, binary.BigEndian, ChecksumXOR, []byte(payload))
	}

	t.Run("corrupt frame errors and stream resyncs", func(t *testing.T) {
		f := newFramer(t)
		bad := good(t, "nope")
		bad[len(bad)-1] ^= 0xFF // break the checksum
		frames, err := f.Feed(bad)
		assert.ErrorIs(t, err, ErrChecksum)
		assert.Empty(t, frames)

		frames, err = f.Feed(good(t, "ok"))
		require.NoError(t, err)
		require.Len(t, frames, 1)
	})

	t.Run("good bad good sticky keeps the good frames", func(t *testing.T) {
		f := newFramer(t)
		a := good(t, "a")
		bad := good(t, "b")
		bad[2] ^= 0xFF // corrupt payload, checksum now wrong
		c := good(t, "c")
		frames, err := f.Feed(append(append(append([]byte(nil), a...), bad...), c...))
		assert.ErrorIs(t, err, ErrChecksum)
		require.Len(t, frames, 2)
		assert.Equal(t, a, []byte(frames[0]))
		assert.Equal(t, c, []byte(frames[1]))
	})
}

func TestHeaderChecksumGarbagePrefix(t *testing.T) {
	f := mustHLC(t, HeaderChecksumConfig{
		Header: []byte{0xAA}, LengthOffset: 1, LengthWidth: 1, Checksum: ChecksumSum8,
	})
	wire := buildHLC(t, []byte{0xAA}, 1, 1, binary.BigEndian, ChecksumSum8, []byte("hi"))
	frames, err := f.Feed(append([]byte{0x00, 0xFF, 0x13}, wire...))
	require.NoError(t, err)
	require.Len(t, frames, 1)
	assert.Equal(t, wire, []byte(frames[0]))
}

func TestHeaderChecksumOversize(t *testing.T) {
	f := mustHLC(t, HeaderChecksumConfig{
		Header: []byte{0xAA}, LengthOffset: 1, LengthWidth: 2,
		Checksum: ChecksumXOR, MaxFrameSize: 16,
	})
	// Declared length 500 blows the 16-byte cap.
	wire := []byte{0xAA, 0x01, 0xF4, 0x00}
	_, err := f.Feed(wire)
	assert.ErrorIs(t, err, ErrOversize)

	// Stream resyncs past the corrupt length byte.
	good := buildHLC(t, []byte{0xAA}, 1, 2, binary.BigEndian, ChecksumXOR, []byte("ok"))
	frames, err := f.Feed(good)
	require.NoError(t, err)
	require.Len(t, frames, 1)
	assert.Equal(t, good, []byte(frames[0]))
}

func TestHeaderChecksumResetDropsResidue(t *testing.T) {
	f := mustHLC(t, HeaderChecksumConfig{
		Header: []byte{0xAA}, LengthOffset: 1, LengthWidth: 1, Checksum: ChecksumXOR,
	})
	wire := buildHLC(t, []byte{0xAA}, 1, 1, binary.BigEndian, ChecksumXOR, []byte("hello"))
	_, err := f.Feed(wire[:3]) // half frame
	require.NoError(t, err)

	f.Reset() // EOF: fragment gone.

	frames, err := f.Feed(wire)
	require.NoError(t, err)
	require.Len(t, frames, 1)
	assert.Equal(t, wire, []byte(frames[0]))
}

func TestHeaderChecksumEmptyFeeds(t *testing.T) {
	f := mustHLC(t, HeaderChecksumConfig{
		Header: []byte{0xAA}, LengthOffset: 1, LengthWidth: 1, Checksum: ChecksumXOR,
	})
	for _, p := range [][]byte{nil, {}} {
		frames, err := f.Feed(p)
		assert.NoError(t, err)
		assert.Nil(t, frames)
	}
}
