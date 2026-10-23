package framing

import (
	"bytes"
	"errors"
	"fmt"
)

// DelimiterConfig configures a DelimiterFramer.
type DelimiterConfig struct {
	// Delimiter terminates each frame, e.g. []byte("\r\n") for AT-style
	// CRLF traffic. Required and non-empty.
	Delimiter []byte
	// MaxFrameSize caps one frame in wire bytes (payload plus delimiter).
	// Non-positive selects DefaultMaxFrameSize.
	MaxFrameSize int
}

// DelimiterFramer cuts frames terminated by a fixed delimiter (CONTEXT.md:
// delimiter framing). The terminator is stripped from the returned payload.
// As a convenience, a bare "\n" delimiter also strips one trailing "\r",
// so the same framer splits both LF and AT-style CRLF line endings.
type DelimiterFramer struct {
	delim   []byte
	max     int
	buf     []byte
	stripCR bool
}

// NewDelimiter validates cfg and returns a ready DelimiterFramer.
func NewDelimiter(cfg DelimiterConfig) (*DelimiterFramer, error) {
	if len(cfg.Delimiter) == 0 {
		return nil, errors.New("framing: delimiter must not be empty")
	}
	max := normalizeMax(cfg.MaxFrameSize)
	if len(cfg.Delimiter) > max {
		return nil, fmt.Errorf("framing: delimiter (%d bytes) exceeds max frame size %d",
			len(cfg.Delimiter), max)
	}
	return &DelimiterFramer{
		delim:   bytes.Clone(cfg.Delimiter),
		max:     max,
		stripCR: len(cfg.Delimiter) == 1 && cfg.Delimiter[0] == '\n',
	}, nil
}

// Feed implements Framer. Complete lines are returned stripped of their
// terminator; a trailing partial line stays buffered (half frame). An
// oversize frame is dropped through its terminator and reported with
// ErrOversize; an over-cap backlog with no terminator yet evicts the whole
// buffer. Either way decoding resumes on the next Feed.
func (f *DelimiterFramer) Feed(p []byte) ([][]byte, error) {
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
		i := bytes.Index(f.buf, f.delim)
		if i < 0 {
			if len(f.buf) > f.max {
				// Unterminated backlog over cap: unrecoverable, evict all.
				f.buf = nil
				fail(ErrOversize)
			}
			return out, firstErr
		}
		if i+len(f.delim) > f.max {
			// Terminated but over cap: drop this frame, keep the stream.
			f.buf = f.buf[i+len(f.delim):]
			fail(ErrOversize)
			continue
		}
		line := bytes.Clone(f.buf[:i])
		if f.stripCR && len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		out = append(out, line)
		f.buf = f.buf[i+len(f.delim):]
	}
}

// Reset implements Framer.
func (f *DelimiterFramer) Reset() {
	f.buf = nil
}
