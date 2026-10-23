package framing

import (
	"bytes"
	"fmt"
)

// FixedSizeFramer cuts the stream into chunks of exactly size bytes
// (CONTEXT.md: fixed-size framing). A trailing partial chunk stays buffered
// (half frame) until the rest arrives.
type FixedSizeFramer struct {
	size int
	buf  []byte
}

// NewFixedSize validates size against maxFrameSize (non-positive selects
// DefaultMaxFrameSize) and returns a ready FixedSizeFramer. Oversize is
// rejected at construction, so this framer cannot exceed its cap at runtime:
// its buffer never holds more than size-1 residue bytes plus in-flight data
// that is emitted as whole frames on the same Feed.
func NewFixedSize(size, maxFrameSize int) (*FixedSizeFramer, error) {
	max := normalizeMax(maxFrameSize)
	if size <= 0 {
		return nil, fmt.Errorf("framing: fixed size %d must be positive", size)
	}
	if size > max {
		return nil, fmt.Errorf("framing: fixed size %d exceeds max frame size %d", size, max)
	}
	return &FixedSizeFramer{size: size}, nil
}

// Size reports the configured frame size.
func (f *FixedSizeFramer) Size() int {
	return f.size
}

// Feed implements Framer.
func (f *FixedSizeFramer) Feed(p []byte) ([][]byte, error) {
	if len(p) == 0 {
		return nil, nil
	}
	f.buf = append(f.buf, p...)
	var out [][]byte
	for len(f.buf) >= f.size {
		out = append(out, bytes.Clone(f.buf[:f.size]))
		f.buf = f.buf[f.size:]
	}
	if len(f.buf) == 0 {
		f.buf = nil
	}
	return out, nil
}

// Reset implements Framer.
func (f *FixedSizeFramer) Reset() {
	f.buf = nil
}
