package script

import (
	"encoding/base64"
	"errors"
	"time"
)

// Frame directions.
const (
	DirRx = "rx"
	DirTx = "tx"
)

// Frame is one complete message cut from a transport byte stream.
//
// This is the DTO every backend slice assumes (integrator unifies later):
// channel names the communication endpoint, dir is rx|tx, payload is raw
// bytes in Go and a base64 string across mygo bindings, tsMillis is
// Unix-millisecond time.
type Frame struct {
	Channel  string `json:"channel"`
	Dir      string `json:"dir"`
	Payload  []byte `json:"-"`
	TsMillis int64  `json:"tsMillis"`
}

// FrameDTO is the bindings-safe form of Frame: payload crosses the
// Go/TypeScript boundary as base64.
type FrameDTO struct {
	Channel  string `json:"channel"`
	Dir      string `json:"dir"`
	Payload  string `json:"payload"`
	TsMillis int64  `json:"tsMillis"`
}

// ToDTO converts a Frame to its bindings-safe form.
func (f Frame) ToDTO() FrameDTO {
	return FrameDTO{
		Channel:  f.Channel,
		Dir:      f.Dir,
		Payload:  base64.StdEncoding.EncodeToString(f.Payload),
		TsMillis: f.TsMillis,
	}
}

// ToFrame converts a FrameDTO back to a Frame.
func (d FrameDTO) ToFrame() (Frame, error) {
	raw, err := base64.StdEncoding.DecodeString(d.Payload)
	if err != nil {
		return Frame{}, err
	}
	return Frame{Channel: d.Channel, Dir: d.Dir, Payload: raw, TsMillis: d.TsMillis}, nil
}

// NowMillis returns Unix time in milliseconds for frame timestamps.
func NowMillis() int64 {
	return time.Now().UnixNano() / int64(time.Millisecond)
}

// NewRxFrame builds an inbound frame stamped with the current time.
func NewRxFrame(channel string, payload []byte) Frame {
	return Frame{Channel: channel, Dir: DirRx, Payload: payload, TsMillis: NowMillis()}
}

// ErrTimeout reports an expired wait. Lua callers see it as nil + "timeout".
var ErrTimeout = errors.New("timeout")

// ErrClosed reports use of a closed Pool or Engine.
var ErrClosed = errors.New("script engine closed")
