package serial

import (
	"os"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// openPTYPort opens a PTY pair and wraps the slave end in a Port. It returns
// the master end for driving the conversation from the test side. The slave
// *os.File stays open for the test: closing it early can hang up the port on
// some platforms.
func openPTYPort(t *testing.T, mode Mode, readTimeout time.Duration) (*os.File, *Port) {
	t.Helper()
	master, slave, err := pty.Open()
	require.NoError(t, err)
	t.Cleanup(func() { _ = master.Close() })
	t.Cleanup(func() { _ = slave.Close() })
	port, err := Open(slave.Name(), mode, readTimeout)
	require.NoError(t, err, "open PTY slave as serial port")
	t.Cleanup(func() { _ = port.Close() })
	return master, port
}

// readMaster reads up to n bytes from the PTY master, failing the test on
// timeout. (*os.File has no deadline support on PTY masters.)
func readMaster(t *testing.T, master *os.File, n int) []byte {
	t.Helper()
	type result struct {
		b   []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		buf := make([]byte, n)
		m, err := master.Read(buf)
		ch <- result{b: buf[:m], err: err}
	}()
	select {
	case r := <-ch:
		require.NoError(t, r.err)
		return r.b
	case <-time.After(5 * time.Second):
		t.Fatal("timed out reading PTY master")
		return nil
	}
}

func TestOpenClosePTY(t *testing.T) {
	master, port := openPTYPort(t, DefaultMode(), 0)
	assert.NotNil(t, master)
	assert.NotEmpty(t, port.Name())

	// Idempotent close: first call closes, repeats are nil.
	require.NoError(t, port.Close())
	assert.NoError(t, port.Close())

	// Operations after close fail instead of touching the handle.
	_, err := port.Send([]byte("x"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "closed")
	_, err = port.Recv(16)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "closed")
	assert.Error(t, port.SetReadTimeout(time.Second))
	_, err = port.Status()
	require.Error(t, err)
}

func TestSendRecvPTY(t *testing.T) {
	master, port := openPTYPort(t, DefaultMode(), 2*time.Second)

	// Master -> port.
	_, err := master.Write([]byte("hello-linkdeck"))
	require.NoError(t, err)
	got, err := port.Recv(64)
	require.NoError(t, err)
	assert.Equal(t, "hello-linkdeck", string(got))

	// Port -> master.
	n, err := port.Send([]byte("back-again"))
	require.NoError(t, err)
	assert.Equal(t, len("back-again"), n)
	assert.Equal(t, "back-again", string(readMaster(t, master, 64)))
}

func TestReadTimeoutExpiry(t *testing.T) {
	_, port := openPTYPort(t, DefaultMode(), 100*time.Millisecond)
	start := time.Now()
	got, err := port.Recv(64)
	require.NoError(t, err, "timeout expiry reports (0, nil), not an error")
	assert.Empty(t, got)
	assert.GreaterOrEqual(t, time.Since(start), 100*time.Millisecond)
}

func TestSetReadTimeoutPTY(t *testing.T) {
	master, port := openPTYPort(t, DefaultMode(), 0)

	// A short timeout expires empty; then disabling it blocks until data
	// arrives from the master side.
	require.NoError(t, port.SetReadTimeout(50*time.Millisecond))
	got, err := port.Recv(64)
	require.NoError(t, err)
	assert.Empty(t, got)

	require.NoError(t, port.SetReadTimeout(-1)) // disabled
	go func() {
		time.Sleep(100 * time.Millisecond)
		_, _ = master.Write([]byte("late"))
	}()
	got, err = port.Recv(64)
	require.NoError(t, err)
	assert.Equal(t, "late", string(got))
}

func TestOpenValidation(t *testing.T) {
	_, slave, err := pty.Open()
	require.NoError(t, err)
	defer func() { _ = slave.Close() }()

	_, err = Open("", DefaultMode(), 0)
	require.Error(t, err)

	_, err = Open(slave.Name(), Mode{BaudRate: 0, DataBits: 8, Parity: ParityNone, StopBits: StopOne}, 0)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "baud rate")

	_, err = Open("/dev/definitely-not-a-linkdeck-port", DefaultMode(), 0)
	require.Error(t, err, "missing device must surface the library error")
}

func TestListNoError(t *testing.T) {
	ports, err := List()
	require.NoError(t, err, "listing must not fail on a bare machine")
	for _, p := range ports {
		assert.NotEmpty(t, p.Name)
	}
}

func TestStatusPTY(t *testing.T) {
	_, port := openPTYPort(t, DefaultMode(), 0)
	// PTYs have no modem lines: the library returns an ioctl error here.
	// Either outcome is fine; what matters is a pure-Go error, never a
	// panic, and a usable struct when the device reports one.
	status, err := port.Status()
	if err != nil {
		t.Logf("status on PTY: %v", err)
		return
	}
	_ = status
}

func TestConcurrentCloseSend(t *testing.T) {
	master, port := openPTYPort(t, DefaultMode(), 0)
	defer func() { _ = master.Close() }()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 50 {
			_, _ = port.Send([]byte("x"))
		}
	}()
	for range 10 {
		_ = port.Close()
	}
	<-done
	// After close, Sends fail fast with the closed sentinel.
	_, err := port.Send([]byte("x"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "closed")
}
