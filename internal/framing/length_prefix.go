package framing

import (
	"encoding/binary"
	"fmt"
)

// LengthPrefixConfig configures a LengthPrefixFramer.
//
// Wire layout: [Offset header bytes][Width length bytes][N payload bytes],
// where the length field holds N, the number of payload bytes following it.
// Offset is the byte offset of the length field from the frame start, which
// lets a fixed magic/SOF byte (or short header) precede it.
type LengthPrefixConfig struct {
	// Offset skips leading header bytes before the length field. Must be >= 0.
	Offset int
	// Width is the length field size in bytes: 1, 2, or 4.
	Width int
	// Order decodes the length field; nil selects big-endian.
	Order binary.ByteOrder
	// MaxFrameSize caps one frame in wire bytes (header plus length field
	// plus payload). Non-positive selects DefaultMaxFrameSize.
	MaxFrameSize int
}

// LengthPrefixFramer cuts length-prefixed frames (CONTEXT.md: length-prefix
// framing). It returns the complete wire frame — header, length field, and
// payload — so layers above keep full context; only the delimiter framer
// strips framing overhead.
type LengthPrefixFramer struct {
	offset int
	width  int
	order  binary.ByteOrder
	max    int
	buf    []byte
}

// NewLengthPrefix validates cfg and returns a ready LengthPrefixFramer.
func NewLengthPrefix(cfg LengthPrefixConfig) (*LengthPrefixFramer, error) {
	if cfg.Offset < 0 {
		return nil, fmt.Errorf("framing: length prefix offset %d must not be negative", cfg.Offset)
	}
	if cfg.Width != 1 && cfg.Width != 2 && cfg.Width != 4 {
		return nil, fmt.Errorf("framing: length prefix width %d must be 1, 2, or 4", cfg.Width)
	}
	max := normalizeMax(cfg.MaxFrameSize)
	if cfg.Offset+cfg.Width > max {
		return nil, fmt.Errorf("framing: length prefix header (%d bytes) exceeds max frame size %d",
			cfg.Offset+cfg.Width, max)
	}
	order := cfg.Order
	if order == nil {
		order = binary.BigEndian
	}
	return &LengthPrefixFramer{offset: cfg.Offset, width: cfg.Width, order: order, max: max}, nil
}

// readLen decodes the length field at the head of b (b holds at least
// offset+width bytes).
func (f *LengthPrefixFramer) readLen(b []byte) uint64 {
	field := b[f.offset : f.offset+f.width]
	switch f.width {
	case 1:
		return uint64(field[0])
	case 2:
		return uint64(f.order.Uint16(field))
	default:
		return uint64(f.order.Uint32(field))
	}
}

// Feed implements Framer. A declared length past the cap reports ErrOversize
// and evicts the whole buffer: without a sync marker, frame boundaries past
// a corrupt length are unrecoverable. An incomplete frame stays buffered;
// the buffer can never exceed the cap plus one header while waiting.
func (f *LengthPrefixFramer) Feed(p []byte) ([][]byte, error) {
	if len(p) == 0 {
		return nil, nil
	}
	f.buf = append(f.buf, p...)
	var out [][]byte
	for {
		if len(f.buf) < f.offset+f.width {
			return out, nil
		}
		n := f.readLen(f.buf)
		total := uint64(f.offset) + uint64(f.width) + n
		if total > uint64(f.max) {
			f.buf = nil
			return out, ErrOversize
		}
		if uint64(len(f.buf)) < total {
			return out, nil
		}
		frame := make([]byte, total)
		copy(frame, f.buf[:total])
		out = append(out, frame)
		f.buf = f.buf[total:]
	}
}

// Reset implements Framer.
func (f *LengthPrefixFramer) Reset() {
	f.buf = nil
}
