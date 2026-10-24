package stream

import (
	"errors"
	"fmt"
)

var (
	errEmptyChannel  = errors.New("stream: channel name is empty")
	errNilSource     = errors.New("stream: source and framer must not be nil")
	errClosedManager = errors.New("stream: manager is closed")
)

// ErrSourceClosed tells the read loop that its transport has reached a
// terminal state. Reconnecting transports keep returning ordinary errors;
// accepted TCP connections use this to release their channel slot.
var ErrSourceClosed = errors.New("stream: source closed")

// dupError reports a Start for an already-started channel.
type dupError struct{ channel string }

func (e *dupError) Error() string {
	return fmt.Sprintf("stream: channel %s is already started", e.channel)
}
