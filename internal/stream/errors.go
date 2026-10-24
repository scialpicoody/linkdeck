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

// dupError reports a Start for an already-started channel.
type dupError struct{ channel string }

func (e *dupError) Error() string {
	return fmt.Sprintf("stream: channel %s is already started", e.channel)
}
