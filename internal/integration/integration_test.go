package integration_test

import (
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"linkdeck/internal/framing"
	"linkdeck/internal/link"
	"linkdeck/internal/script"
	"linkdeck/internal/stream"
	"linkdeck/internal/tcp"
)

func echoServer(t *testing.T) (host string, port int, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port, func() { _ = ln.Close() }
}

func waitBatch(t *testing.T, batches <-chan stream.Batch) stream.Batch {
	t.Helper()
	select {
	case batch := <-batches:
		return batch
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for live stream batch")
		return stream.Batch{}
	}
}

func TestTCPTransportOpenStreamSendCloseReopen(t *testing.T) {
	host, port, stop := echoServer(t)
	defer stop()
	svc := tcp.NewTcpService()
	batches := make(chan stream.Batch, 16)
	mgr := stream.NewManager(script.NewPool(), func(batch stream.Batch) { batches <- batch })
	defer mgr.Close()
	svc.AttachStream(mgr)

	addr := net.JoinHostPort(host, strconv.Itoa(port))
	for attempt := 0; attempt < 2; attempt++ {
		info, err := svc.Open(tcp.OpenRequest{
			Name: "client", Address: addr, ConnectTimeoutMs: 2000, Stream: true,
			Framing: framing.Spec{Kind: "delimiter", DelimiterHex: "0A"},
		})
		require.NoError(t, err)
		require.Equal(t, tcp.StateConnected, info.State)
		_, err = svc.Send("client", []byte("hello\n"))
		require.NoError(t, err)
		batch := waitBatch(t, batches)
		require.Equal(t, "client", batch.Channel)
		require.Equal(t, "hello", string(batch.Frames[0].Payload))
		require.NoError(t, svc.Close("client"))
	}
}

func TestServerAcceptLiveStreamAndClose(t *testing.T) {
	svc := tcp.NewTcpService()
	batches := make(chan stream.Batch, 8)
	mgr := stream.NewManager(script.NewPool(), func(batch stream.Batch) { batches <- batch })
	defer mgr.Close()
	svc.AttachStream(mgr)

	info, err := svc.Listen(tcp.ListenRequest{
		Name: "server", Address: "127.0.0.1:0", Stream: true,
		Framing: framing.Spec{Kind: "delimiter", DelimiterHex: "0D0A"},
	})
	require.NoError(t, err)
	raw, err := net.Dial("tcp", info.Address)
	require.NoError(t, err)
	_, err = raw.Write([]byte("accepted\r\n"))
	require.NoError(t, err)
	batch := waitBatch(t, batches)
	require.Contains(t, batch.Channel, "server/c")
	require.Equal(t, "accepted", string(batch.Frames[0].Payload))
	require.NoError(t, raw.Close())
	require.NoError(t, svc.Unlisten("server"))
}

func TestWorkspaceRunPublishesStructuredTransportOutput(t *testing.T) {
	host, port, stop := echoServer(t)
	defer stop()
	tcpSvc := tcp.NewTcpService()
	mgr := stream.NewManager(script.NewPool(), nil)
	defer mgr.Close()
	tcpSvc.AttachStream(mgr)
	engine := script.NewEngine(script.EngineOptions{
		TCP: link.NewTCPTransport(tcpSvc),
	})
	svc := script.NewScriptService(engine)
	defer svc.Close()
	ws, err := script.OpenWorkspace(t.TempDir())
	require.NoError(t, err)
	svc.SetWorkspace(ws)
	output := make(chan script.OutputRow, 32)
	status := make(chan script.RunInfo, 16)
	svc.SetOutputHandler(func(row script.OutputRow) { output <- row })
	svc.SetStatusHandler(func(info script.RunInfo) { status <- info })

	path := "runtime.lua"
	require.NoError(t, ws.Write(path, `
local c = assert(tcp.open("`+host+`", `+strconv.Itoa(port)+`))
local data = assert(send_expect(c, "PING", "PING", {timeout_ms = 1000}))
log("echo:" .. data)
`))
	started, err := svc.StartFile(path, 3000)
	require.NoError(t, err)

	seen := map[string]bool{}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case row := <-output:
			if row.RunID == started.ID {
				seen[row.Type] = true
			}
		case info := <-status:
			if info.ID != started.ID || (info.State != script.RunCompleted &&
				info.State != script.RunFailed) {
				continue
			}
			require.Equal(t, script.RunCompleted, info.State, info.Error)
		drain:
			for {
				select {
				case row := <-output:
					if row.RunID == started.ID {
						seen[row.Type] = true
					}
				default:
					break drain
				}
			}
			require.True(t, seen[script.OutputTX])
			require.True(t, seen[script.OutputRX])
			require.True(t, seen[script.OutputLog])
			return
		case <-deadline:
			t.Fatal("timed out waiting for workspace runtime")
		}
	}
}

func TestWorkspaceRunReportsLinkedErrorLine(t *testing.T) {
	engine := script.NewEngine(script.EngineOptions{})
	svc := script.NewScriptService(engine)
	defer svc.Close()
	ws, err := script.OpenWorkspace(t.TempDir())
	require.NoError(t, err)
	svc.SetWorkspace(ws)
	status := make(chan script.RunInfo, 8)
	svc.SetStatusHandler(func(info script.RunInfo) { status <- info })
	require.NoError(t, ws.Write("broken.lua", "local a = 1\nlog(\"before\")\nerror(\"boom\")\n"))
	started, err := svc.StartFile("broken.lua", 1000)
	require.NoError(t, err)
	deadline := time.After(3 * time.Second)
	for {
		select {
		case info := <-status:
			if info.ID == started.ID && info.State == script.RunFailed {
				require.Equal(t, 3, info.Line)
				require.Contains(t, info.Error, "boom")
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for linked script error")
		}
	}
}
