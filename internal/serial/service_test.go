package serial

import (
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"linkdeck/internal/framing"
	"linkdeck/internal/script"
	"linkdeck/internal/stream"
)

func TestServiceOpenClose(t *testing.T) {
	master, slave, err := pty.Open()
	require.NoError(t, err)
	defer func() { _ = master.Close() }()
	defer func() { _ = slave.Close() }()

	svc := NewSerialService()
	info, err := svc.Open(OpenRequest{
		Port:          slave.Name(),
		BaudRate:      115200,
		DataBits:      8,
		Parity:        ParityNone,
		StopBits:      StopOne,
		ReadTimeoutMs: 200,
	})
	require.NoError(t, err)
	assert.Equal(t, slave.Name(), info.Name)

	// Exclusive per name through the service.
	_, err = svc.Open(OpenRequest{
		Port:     slave.Name(),
		BaudRate: 115200,
		DataBits: 8,
		Parity:   ParityNone,
		StopBits: StopOne,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already open")

	// Round-trip through the service surface.
	n, err := svc.Send(slave.Name(), []byte("ping"))
	require.NoError(t, err)
	assert.Equal(t, 4, n)
	assert.Equal(t, "ping", string(readMaster(t, master, 16)))

	require.NoError(t, svc.Close(slave.Name()))
	require.Error(t, svc.Close(slave.Name()), "second close is unknown to the service")
}

func TestServiceValidation(t *testing.T) {
	svc := NewSerialService()
	_, err := svc.Open(OpenRequest{Port: "/dev/nope", BaudRate: -1})
	require.Error(t, err, "invalid mode never reaches the device")

	_, err = svc.Send("/dev/nope", []byte("x"))
	require.Error(t, err)
	_, err = svc.Recv("/dev/nope", 16)
	require.Error(t, err)
	assert.Error(t, svc.SetReadTimeout("/dev/nope", 100))
	_, err = svc.Status("/dev/nope")
	require.Error(t, err)
}

func TestServiceOpenUsesFraming(t *testing.T) {
	master, slave, err := pty.Open()
	require.NoError(t, err)
	defer func() { _ = master.Close() }()
	defer func() { _ = slave.Close() }()

	pool := script.NewPool()
	defer pool.Close()
	var mu sync.Mutex
	var payloads []string
	mgr := stream.NewManager(pool, func(batch stream.Batch) {
		mu.Lock()
		defer mu.Unlock()
		for _, frame := range batch.Frames {
			payloads = append(payloads, string(frame.Payload))
		}
	})
	defer mgr.Close()

	svc := NewSerialService()
	svc.AttachStream(mgr)
	_, err = svc.Open(OpenRequest{
		Port:          slave.Name(),
		BaudRate:      115200,
		DataBits:      8,
		Parity:        ParityNone,
		StopBits:      StopOne,
		ReadTimeoutMs: 200,
		Framing:       framing.Spec{Kind: "delimiter", DelimiterHex: "0D0A"},
		Stream:        true,
	})
	require.NoError(t, err)
	defer func() { _ = svc.Close(slave.Name()) }()

	_, err = master.Write([]byte("one\r\ntwo\r\n"))
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(payloads) == 2
	}, 3*time.Second, 10*time.Millisecond)
	assert.Equal(t, []string{"one", "two"}, payloads)
}
