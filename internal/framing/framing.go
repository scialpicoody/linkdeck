// Package framing turns transport byte streams into frames.
//
// It implements the Framing layer from CONTEXT.md: a Channel delivers a raw
// byte stream, and a Framer cuts that stream into Frames (one complete
// message each). Transport metadata from the Frame DTO the slices share
// (channel name, rx/tx direction, tsMillis timestamp) is attached above this
// layer; here a frame is just its payload bytes.
//
// Mapping to the CONTEXT.md Framing glossary entry:
//
//   - Half frames: bytes that do not yet complete a frame are buffered
//     inside the Framer and produce no output until the rest arrives.
//   - Sticky frames: one Feed call may complete zero, one, or many frames;
//     all complete frames are returned in wire order.
//   - Oversize caps: every framer enforces a max frame size. A frame (or
//     backlog) that exceeds it reports ErrOversize and the offending bytes
//     are evicted, so the buffer cannot grow without bound. The exact
//     eviction is documented per implementation; in all cases the stream
//     recovers on the next Feed.
//   - Checksum failures: the header-length-checksum framer verifies each
//     frame and reports ErrChecksum for corrupt frames without losing
//     stream sync.
//
// Feed may return both frames and a non-nil error: frames decoded before the
// error are still valid and the caller MUST process them. Reset discards any
// buffered half-frame residue (the EOF case: a stream that ends mid-frame
// drops the fragment so the next stream starts clean).
//
// Framers are stateful and NOT safe for concurrent use; confine each Framer
// to the goroutine that owns its channel.
package framing

import "errors"

// DefaultMaxFrameSize bounds a single frame (wire bytes) when the caller
// passes a non-positive MaxFrameSize. 1 MiB fits generous AT/modem traffic
// while keeping a hostile or misconfigured peer from exhausting memory.
const DefaultMaxFrameSize = 1 << 20

// ErrOversize reports that a frame (or an unterminated backlog) exceeded the
// configured max frame size. The offending bytes are evicted; feed more data
// to continue the stream.
var ErrOversize = errors.New("framing: frame exceeds max size")

// ErrChecksum reports a header-length-checksum frame whose trailing checksum
// byte does not match the computed value. Stream sync is preserved; later
// frames from the same Feed are still returned.
var ErrChecksum = errors.New("framing: checksum mismatch")

// Framer cuts a transport byte stream into frames. See the package doc for
// the half/sticky/oversize/checksum contract shared by all implementations.
type Framer interface {
	// Feed appends p to the internal buffer and returns every frame that is
	// now complete, in wire order. An empty (or nil) p is a no-op returning
	// nil, nil. Returned payloads are copies the caller owns.
	Feed(p []byte) ([][]byte, error)
	// Reset discards buffered residue. Use it at EOF or when switching to
	// a new stream on the same channel.
	Reset()
}

// normalizeMax resolves a caller-supplied cap to an effective one.
func normalizeMax(max int) int {
	if max <= 0 {
		return DefaultMaxFrameSize
	}
	return max
}
