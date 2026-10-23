package tcp

import (
	"time"
)

// Frame is the DTO every backend slice assumes. In Go the payload is raw
// bytes; over mygo bindings []byte encodes as a base64 string. TsMillis is
// Unix milliseconds. Dir is "rx" or "tx". Channel names the client or
// accepted server connection the frame came from / goes to.
type Frame struct {
	Channel  string `json:"channel"`
	Dir      string `json:"dir"`
	Payload  []byte `json:"payload"`
	TsMillis int64  `json:"tsMillis"`
}

// NewFrame builds a Frame stamped with the current time.
func NewFrame(channel, dir string, payload []byte) Frame {
	cp := make([]byte, len(payload))
	copy(cp, payload)
	return Frame{Channel: channel, Dir: dir, Payload: cp, TsMillis: time.Now().UnixMilli()}
}
