package serial

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	goserial "go.bug.st/serial"
)

func TestModeValidate(t *testing.T) {
	valid := Mode{BaudRate: 115200, DataBits: 8, Parity: ParityNone, StopBits: StopOne}
	cases := []struct {
		name    string
		mutate  func(Mode) Mode
		wantErr string
	}{
		{name: "default 8N1", mutate: func(m Mode) Mode { return m }},
		{name: "low baud", mutate: func(m Mode) Mode { m.BaudRate = 1200; return m }},
		{name: "high baud", mutate: func(m Mode) Mode { m.BaudRate = 3000000; return m }},
		{name: "five data bits", mutate: func(m Mode) Mode { m.DataBits = 5; return m }},
		{name: "seven data bits", mutate: func(m Mode) Mode { m.DataBits = 7; return m }},
		{name: "odd parity", mutate: func(m Mode) Mode { m.Parity = ParityOdd; return m }},
		{name: "even parity", mutate: func(m Mode) Mode { m.Parity = ParityEven; return m }},
		{name: "mark parity", mutate: func(m Mode) Mode { m.Parity = ParityMark; return m }},
		{name: "space parity", mutate: func(m Mode) Mode { m.Parity = ParitySpace; return m }},
		{name: "1.5 stop bits", mutate: func(m Mode) Mode { m.StopBits = StopOneHalf; return m }},
		{name: "2 stop bits", mutate: func(m Mode) Mode { m.StopBits = StopTwo; return m }},
		{name: "zero baud", mutate: func(m Mode) Mode { m.BaudRate = 0; return m }, wantErr: "baud rate"},
		{name: "negative baud", mutate: func(m Mode) Mode { m.BaudRate = -9600; return m }, wantErr: "baud rate"},
		{name: "four data bits", mutate: func(m Mode) Mode { m.DataBits = 4; return m }, wantErr: "data bits"},
		{name: "nine data bits", mutate: func(m Mode) Mode { m.DataBits = 9; return m }, wantErr: "data bits"},
		{name: "empty parity", mutate: func(m Mode) Mode { m.Parity = ""; return m }, wantErr: "parity"},
		{name: "bogus parity", mutate: func(m Mode) Mode { m.Parity = "sometimes"; return m }, wantErr: "parity"},
		{name: "empty stop bits", mutate: func(m Mode) Mode { m.StopBits = ""; return m }, wantErr: "stop bits"},
		{name: "bogus stop bits", mutate: func(m Mode) Mode { m.StopBits = "3"; return m }, wantErr: "stop bits"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.mutate(valid).Validate()
			if tc.wantErr == "" {
				assert.NoError(t, err)
			} else {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
			}
		})
	}
}

func TestToLibraryMapping(t *testing.T) {
	m := Mode{BaudRate: 9600, DataBits: 7, Parity: ParityEven, StopBits: StopTwo}
	lib := m.toLibrary()
	assert.Equal(t, 9600, lib.BaudRate)
	assert.Equal(t, 7, lib.DataBits)
	assert.Equal(t, goserial.EvenParity, lib.Parity)
	assert.Equal(t, goserial.TwoStopBits, lib.StopBits)

	def := DefaultMode().toLibrary()
	assert.Equal(t, 115200, def.BaudRate)
	assert.Equal(t, 8, def.DataBits)
	assert.Equal(t, goserial.NoParity, def.Parity)
	assert.Equal(t, goserial.OneStopBit, def.StopBits)
}
