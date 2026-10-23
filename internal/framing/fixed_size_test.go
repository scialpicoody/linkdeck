package framing

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ Framer = (*FixedSizeFramer)(nil)

func TestNewFixedSizeErrors(t *testing.T) {
	for _, size := range []int{0, -1, -64} {
		_, err := NewFixedSize(size, 0)
		assert.ErrorContains(t, err, "must be positive", "size %d", size)
	}
	_, err := NewFixedSize(65, 64)
	assert.ErrorContains(t, err, "exceeds max frame size")
}

func TestFixedSizeDecode(t *testing.T) {
	cases := []struct {
		name  string
		size  int
		feeds []string
		want  []string
	}{
		{name: "exact single", size: 4, feeds: []string{"abcd"}, want: []string{"abcd"}},
		{name: "half then rest", size: 4, feeds: []string{"ab", "cd"}, want: []string{"abcd"}},
		{name: "byte at a time", size: 3, feeds: []string{"a", "b", "c"}, want: []string{"abc"}},
		{name: "sticky two frames", size: 2, feeds: []string{"abcd"}, want: []string{"ab", "cd"}},
		{name: "sticky plus residue", size: 2, feeds: []string{"abcde"}, want: []string{"ab", "cd"}},
		{name: "residue completes later", size: 2, feeds: []string{"abcde", "f"}, want: []string{"ab", "cd", "ef"}},
		{name: "short feed buffers", size: 4, feeds: []string{"ab"}, want: nil},
		{name: "binary payload", size: 3, feeds: []string{"\x00\xff\x01\x02"}, want: []string{"\x00\xff\x01"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, err := NewFixedSize(tc.size, 0)
			require.NoError(t, err)
			got, err := feedStrings(t, f, tc.feeds)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestFixedSizeResetDropsResidue(t *testing.T) {
	f, err := NewFixedSize(4, 0)
	require.NoError(t, err)
	_, err = f.Feed([]byte("abc"))
	require.NoError(t, err)

	f.Reset() // EOF: the 3-byte fragment is gone.

	frames, err := f.Feed([]byte("wxyz"))
	require.NoError(t, err)
	require.Len(t, frames, 1)
	assert.Equal(t, "wxyz", string(frames[0]))
}

func TestFixedSizeEmptyFeeds(t *testing.T) {
	f, err := NewFixedSize(2, 0)
	require.NoError(t, err)
	for _, p := range [][]byte{nil, {}} {
		frames, err := f.Feed(p)
		assert.NoError(t, err)
		assert.Nil(t, frames)
	}
}

func TestFixedSizeAccessor(t *testing.T) {
	f, err := NewFixedSize(7, 0)
	require.NoError(t, err)
	assert.Equal(t, 7, f.Size())
}
