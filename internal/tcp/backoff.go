package tcp

import (
	"math/rand/v2"
	"time"
)

// Backoff defaults. Reported sequence (before jitter) with base 100ms and
// cap 5000ms, attempt counting from 0:
//
//	100 200 400 800 1600 3200 5000 5000 ...
//
// Jitter adds up to +25% on top of the capped exponential value, so each
// delay d satisfies capped <= d <= capped+capped/4.
const (
	DefaultBaseBackoff = 100 * time.Millisecond
	DefaultMaxBackoff  = 5 * time.Second
	maxBackoffShift    = 30 // guards base<<attempt overflow
)

// backoff returns the reconnect delay for a zero-based attempt: the capped
// exponential value plus up to 25% jitter. It never returns a non-positive
// delay.
func backoff(attempt int, base, max time.Duration) time.Duration {
	if base <= 0 {
		base = DefaultBaseBackoff
	}
	if max <= 0 {
		max = DefaultMaxBackoff
	}
	if attempt < 0 {
		attempt = 0
	}
	shift := attempt
	if shift > maxBackoffShift {
		shift = maxBackoffShift
	}
	capped := base << shift
	if capped <= 0 || capped > max {
		capped = max
	}
	// Jitter in [0, capped/4].
	j := time.Duration(0)
	if q := capped / 4; q > 0 {
		j = time.Duration(rand.Int64N(int64(q) + 1))
	}
	if d := capped + j; d > 0 {
		return d
	}
	return capped
}

// normalizeBackoff applies defaults to a base/max pair.
func normalizeBackoff(base, max time.Duration) (time.Duration, time.Duration) {
	if base <= 0 {
		base = DefaultBaseBackoff
	}
	if max <= 0 {
		max = DefaultMaxBackoff
	}
	if max < base {
		max = base
	}
	return base, max
}
