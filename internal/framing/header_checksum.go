package framing

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

// ChecksumKind selects the trailing-checksum algorithm of a
// HeaderChecksumFramer. Every kind uses a single checksum byte.
type ChecksumKind int

const (
	// ChecksumXOR xors all preceding frame bytes.
	ChecksumXOR ChecksumKind = iota + 1
	// ChecksumSum8 sums all preceding frame bytes modulo 256.
	ChecksumSum8
	// ChecksumCRC8 runs CRC-8 (poly 0x07, init 0x00) over all preceding
	// frame bytes.
	ChecksumCRC8
)

// String names the kind for logs and errors.
func (k ChecksumKind) String() string {
	switch k {
	case ChecksumXOR:
		return "xor"
	case ChecksumSum8:
		return "sum8"
	case ChecksumCRC8:
		return "crc8"
	default:
		return "unknown"
	}
}

// compute runs the checksum over the frame bytes preceding the checksum byte.
func (k ChecksumKind) compute(b []byte) byte {
	switch k {
	case ChecksumSum8:
		var sum byte
		for _, x := range b {
			sum += x
		}
		return sum
	case ChecksumCRC8:
		var crc byte
		for _, x := range b {
			crc ^= x
			for range 8 {
				if crc&0x80 != 0 {
					crc = (crc << 1) ^ 0x07
				} else {
					crc <<= 1
				}
			}
		}
		return crc
	default: // ChecksumXOR
		var acc byte
		for _, x := range b {
			acc ^= x
		}
		return acc
	}
}

// HeaderChecksumConfig configures a HeaderChecksumFramer.
//
// Wire layout: [Header][length field at LengthOffset, LengthWidth bytes
// wide][N payload bytes][1 checksum byte], where the length field holds N.
// LengthOffset is typically len(Header): the length field follows the header.
type HeaderChecksumConfig struct {
	// Header is the fixed magic prefix anchoring each frame. Required.
	Header []byte
	// LengthOffset is the byte offset of the length field from the frame
	// start. Must be >= len(Header).
	LengthOffset int
	// LengthWidth is the length field size in bytes: 1, 2, or 4.
	LengthWidth int
	// Order decodes the length field; nil selects big-endian.
	Order binary.ByteOrder
	// Checksum selects the checksum algorithm.
	Checksum ChecksumKind
	// MaxFrameSize caps one frame in wire bytes (header plus length field
	// plus payload plus checksum). Non-positive selects DefaultMaxFrameSize.
	MaxFrameSize int
}

// HeaderChecksumFramer cuts header/length/checksum frames (CONTEXT.md:
// header-length-checksum framing) and verifies each checksum. It returns the
// complete wire frame — header, length field, payload, and checksum — so
// layers above keep full context.
type HeaderChecksumFramer struct {
	header []byte
	offset int
	width  int
	order  binary.ByteOrder
	sum    ChecksumKind
	max    int
	buf    []byte
}

// NewHeaderLengthChecksum validates cfg and returns a ready framer.
func NewHeaderLengthChecksum(cfg HeaderChecksumConfig) (*HeaderChecksumFramer, error) {
	if len(cfg.Header) == 0 {
		return nil, errors.New("framing: header must not be empty")
	}
	if cfg.LengthWidth != 1 && cfg.LengthWidth != 2 && cfg.LengthWidth != 4 {
		return nil, fmt.Errorf("framing: length width %d must be 1, 2, or 4", cfg.LengthWidth)
	}
	if cfg.LengthOffset < len(cfg.Header) {
		return nil, fmt.Errorf("framing: length offset %d must not start inside the %d-byte header",
			cfg.LengthOffset, len(cfg.Header))
	}
	switch cfg.Checksum {
	case ChecksumXOR, ChecksumSum8, ChecksumCRC8:
	default:
		return nil, fmt.Errorf("framing: unknown checksum kind %d", int(cfg.Checksum))
	}
	max := normalizeMax(cfg.MaxFrameSize)
	if min := cfg.LengthOffset + cfg.LengthWidth + 1; min > max {
		return nil, fmt.Errorf("framing: minimal frame (%d bytes) exceeds max frame size %d", min, max)
	}
	order := cfg.Order
	if order == nil {
		order = binary.BigEndian
	}
	return &HeaderChecksumFramer{
		header: bytes.Clone(cfg.Header),
		offset: cfg.LengthOffset,
		width:  cfg.LengthWidth,
		order:  order,
		sum:    cfg.Checksum,
		max:    max,
	}, nil
}

// readLen decodes the length field of a header-anchored buffer.
func (f *HeaderChecksumFramer) readLen() uint64 {
	field := f.buf[f.offset : f.offset+f.width]
	switch f.width {
	case 1:
		return uint64(field[0])
	case 2:
		return uint64(f.order.Uint16(field))
	default:
		return uint64(f.order.Uint32(field))
	}
}

// Feed implements Framer. Bytes before the first header are dropped as
// resync noise; a corrupt frame reports ErrChecksum (or ErrOversize for an
// over-cap declared length) and scanning resumes one byte later, so later
// good frames in the same Feed still decode. Incomplete frames stay
// buffered; the buffer never exceeds the cap plus one header while waiting.
func (f *HeaderChecksumFramer) Feed(p []byte) ([][]byte, error) {
	if len(p) == 0 {
		return nil, nil
	}
	f.buf = append(f.buf, p...)
	var out [][]byte
	var firstErr error
	fail := func(err error) {
		if firstErr == nil {
			firstErr = err
		}
	}
	for {
		i := bytes.Index(f.buf, f.header)
		if i < 0 {
			// No header in sight. Keep a tail that could be a split
			// header; the rest is resync noise and must go so the
			// buffer stays bounded.
			if tail := len(f.header) - 1; len(f.buf) > f.max+tail {
				f.buf = append([]byte(nil), f.buf[len(f.buf)-tail:]...)
			}
			return out, firstErr
		}
		if i > 0 {
			f.buf = f.buf[i:]
		}
		if len(f.buf) < f.offset+f.width {
			return out, firstErr
		}
		total := uint64(f.offset) + uint64(f.width) + f.readLen() + 1
		if total > uint64(f.max) {
			f.buf = f.buf[1:]
			fail(ErrOversize)
			continue
		}
		if uint64(len(f.buf)) < total {
			return out, firstErr
		}
		body := f.buf[:total-1]
		if want := f.sum.compute(body); f.buf[total-1] != want {
			f.buf = f.buf[1:]
			fail(ErrChecksum)
			continue
		}
		out = append(out, bytes.Clone(f.buf[:total]))
		f.buf = f.buf[total:]
	}
}

// Reset implements Framer.
func (f *HeaderChecksumFramer) Reset() {
	f.buf = nil
}
