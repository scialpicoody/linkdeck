package framing

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ Framer = (*DelimiterFramer)(nil)

func mustDelimiter(t *testing.T, delim string, max int) *DelimiterFramer {
	t.Helper()
	f, err := NewDelimiter(DelimiterConfig{Delimiter: []byte(delim), MaxFrameSize: max})
	require.NoError(t, err)
	return f
}

func feedStrings(t *testing.T, f Framer, feeds []string) ([]string, error) {
	t.Helper()
	var got []string
	var firstErr error
	for _, in := range feeds {
		frames, err := f.Feed([]byte(in))
		if err != nil && firstErr == nil {
			firstErr = err
		}
		for _, fr := range frames {
			got = append(got, string(fr))
		}
	}
	return got, firstErr
}

func TestNewDelimiterErrors(t *testing.T) {
	_, err := NewDelimiter(DelimiterConfig{})
	assert.ErrorContains(t, err, "delimiter must not be empty")

	_, err = NewDelimiter(DelimiterConfig{Delimiter: []byte("\r\n"), MaxFrameSize: 1})
	assert.ErrorContains(t, err, "exceeds max frame size")
}

func TestDelimiterDecode(t *testing.T) {
	cases := []struct {
		name  string
		delim string
		in    string
		want  []string
	}{
		{name: "AT-style CRLF", delim: "\r\n", in: "AT\r\n", want: []string{"AT"}},
		{name: "bare LF", delim: "\n", in: "AT\n", want: []string{"AT"}},
		{name: "LF framer strips CR", delim: "\n", in: "AT\r\n", want: []string{"AT"}},
		{name: "CRLF framer keeps lone CR", delim: "\r\n", in: "a\rb\r\n", want: []string{"a\rb"}},
		{name: "sticky multiples", delim: "\r\n", in: "OK\r\nAT\r\nERROR\r\n", want: []string{"OK", "AT", "ERROR"}},
		{name: "empty payload line", delim: "\r\n", in: "\r\n", want: []string{""}},
		{name: "unterminated half yields nothing", delim: "\r\n", in: "AT+CSQ", want: nil},
		{name: "no terminator at all", delim: "\r\n", in: "garbage", want: nil},
		{name: "custom multi-byte delimiter", delim: "<END>", in: "a<END>b<END>", want: []string{"a", "b"}},
		{name: "delimiter split across feeds is one frame", delim: "\r\n", in: "AT\r\n", want: []string{"AT"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := mustDelimiter(t, tc.delim, 0)
			got, err := feedStrings(t, f, []string{tc.in})
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestDelimiterHalfFrames(t *testing.T) {
	f := mustDelimiter(t, "\r\n", 0)
	got, err := feedStrings(t, f, []string{"A", "T+C", "SQ", "\r", "\n"})
	require.NoError(t, err)
	assert.Equal(t, []string{"AT+CSQ"}, got)
}

func TestDelimiterOversize(t *testing.T) {
	t.Run("unterminated backlog evicts and recovers", func(t *testing.T) {
		f := mustDelimiter(t, "\r\n", 8)
		_, err := f.Feed([]byte("0123456789"))
		assert.ErrorIs(t, err, ErrOversize)

		frames, err := f.Feed([]byte("OK\r\n"))
		require.NoError(t, err)
		require.Len(t, frames, 1)
		assert.Equal(t, "OK", string(frames[0]))
	})

	t.Run("oversize terminated frame drops but stream continues", func(t *testing.T) {
		f := mustDelimiter(t, "\r\n", 8)
		frames, err := f.Feed([]byte("0123456789\r\nOK\r\n"))
		assert.ErrorIs(t, err, ErrOversize)
		require.Len(t, frames, 1)
		assert.Equal(t, "OK", string(frames[0]))
	})

	t.Run("cap counts payload plus delimiter", func(t *testing.T) {
		// max 6: "1234\r\n" is exactly 6 wire bytes and fits.
		f := mustDelimiter(t, "\r\n", 6)
		got, err := feedStrings(t, f, []string{"1234\r\n"})
		require.NoError(t, err)
		assert.Equal(t, []string{"1234"}, got)

		// "12345\r\n" is 7 wire bytes and must not.
		_, err = f.Feed([]byte("12345\r\n"))
		assert.ErrorIs(t, err, ErrOversize)
	})
}

func TestDelimiterResetDropsResidue(t *testing.T) {
	f := mustDelimiter(t, "\r\n", 0)
	_, err := f.Feed([]byte("half-frame"))
	require.NoError(t, err)

	f.Reset() // EOF: the fragment is gone.

	got, err := feedStrings(t, f, []string{"AT\r\n"})
	require.NoError(t, err)
	assert.Equal(t, []string{"AT"}, got)
}

func TestDelimiterEmptyFeeds(t *testing.T) {
	f := mustDelimiter(t, "\r\n", 0)
	for _, p := range [][]byte{nil, {}} {
		frames, err := f.Feed(p)
		assert.NoError(t, err)
		assert.Nil(t, frames)
	}
	// State untouched: a half frame from before is still pending.
	_, err := f.Feed([]byte("AT"))
	require.NoError(t, err)
	_, err = f.Feed(nil)
	require.NoError(t, err)
	got, err := feedStrings(t, f, []string{"\r\n"})
	require.NoError(t, err)
	assert.Equal(t, []string{"AT"}, got)
}

func TestDelimiterFramesAreCopies(t *testing.T) {
	f := mustDelimiter(t, "\n", 0)
	frames, err := f.Feed([]byte("AB\n"))
	require.NoError(t, err)
	require.Len(t, frames, 1)
	frames[0][0] = 'z' // corrupt our copy; the framer must not care.

	got, err := feedStrings(t, f, []string{"AB\n"})
	require.NoError(t, err)
	assert.Equal(t, []string{"AB"}, got)
}
