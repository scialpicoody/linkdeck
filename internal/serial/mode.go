package serial

import (
	"fmt"

	goserial "go.bug.st/serial"
)

// Parity is a JSON-friendly serial parity setting.
type Parity string

const (
	ParityNone  Parity = "none"
	ParityOdd   Parity = "odd"
	ParityEven  Parity = "even"
	ParityMark  Parity = "mark"
	ParitySpace Parity = "space"
)

// StopBits is a JSON-friendly stop-bits setting.
type StopBits string

const (
	StopOne     StopBits = "1"
	StopOneHalf StopBits = "1.5"
	StopTwo     StopBits = "2"
)

// Mode describes a serial port configuration.
//
// Flow control is intentionally absent: the underlying library exposes no
// flow-control API (see package doc gap 1).
type Mode struct {
	BaudRate int      `json:"baudRate"`
	DataBits int      `json:"dataBits"`
	Parity   Parity   `json:"parity"`
	StopBits StopBits `json:"stopBits"`
}

// DefaultMode is 115200 8N1, the common embedded default.
func DefaultMode() Mode {
	return Mode{BaudRate: 115200, DataBits: 8, Parity: ParityNone, StopBits: StopOne}
}

// Validate reports whether m is structurally sound. Baud-rate support beyond
// positivity is platform-dependent; Open propagates the library's typed
// errors (e.g. invalid speed) for those cases.
func (m Mode) Validate() error {
	if m.BaudRate <= 0 {
		return fmt.Errorf("serial: baud rate must be positive, got %d", m.BaudRate)
	}
	if m.DataBits < 5 || m.DataBits > 8 {
		return fmt.Errorf("serial: data bits must be 5-8, got %d", m.DataBits)
	}
	switch m.Parity {
	case ParityNone, ParityOdd, ParityEven, ParityMark, ParitySpace:
	default:
		return fmt.Errorf("serial: unknown parity %q", m.Parity)
	}
	switch m.StopBits {
	case StopOne, StopOneHalf, StopTwo:
	default:
		return fmt.Errorf("serial: unknown stop bits %q", m.StopBits)
	}
	return nil
}

// toLibrary converts m to the underlying library's mode. Callers must run
// Validate first; unknown values fall back to 8N1 rather than panic.
func (m Mode) toLibrary() *goserial.Mode {
	var parity goserial.Parity
	switch m.Parity {
	case ParityOdd:
		parity = goserial.OddParity
	case ParityEven:
		parity = goserial.EvenParity
	case ParityMark:
		parity = goserial.MarkParity
	case ParitySpace:
		parity = goserial.SpaceParity
	default:
		parity = goserial.NoParity
	}
	var stop goserial.StopBits
	switch m.StopBits {
	case StopOneHalf:
		stop = goserial.OnePointFiveStopBits
	case StopTwo:
		stop = goserial.TwoStopBits
	default:
		stop = goserial.OneStopBit
	}
	dataBits := m.DataBits
	if dataBits < 5 || dataBits > 8 {
		dataBits = 8
	}
	baud := m.BaudRate
	if baud <= 0 {
		baud = 115200
	}
	return &goserial.Mode{
		BaudRate: baud,
		DataBits: dataBits,
		Parity:   parity,
		StopBits: stop,
	}
}
