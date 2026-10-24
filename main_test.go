package main

import (
	"io"
	"net"
	"testing"

	"github.com/stretchr/testify/require"
	"linkdeck/internal/serial"
	"linkdeck/internal/tcp"
)

func TestTransportStatusesReportTCPLifecycle(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer echo.Close()
	go func() {
		conn, err := echo.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.Copy(conn, conn)
	}()

	svc := tcp.NewTcpService()
	_, err = svc.Open(tcp.OpenRequest{
		Name: "client-1", Address: echo.Addr().String(), ConnectTimeoutMs: 1000,
	})
	require.NoError(t, err)
	defer svc.Close("client-1")
	_, err = svc.Listen(tcp.ListenRequest{Name: "server-1", Address: "127.0.0.1:0"})
	require.NoError(t, err)
	defer svc.Unlisten("server-1")

	statuses := transportStatuses(serial.NewSerialService(), svc)
	byKey := make(map[string]string, len(statuses))
	for _, status := range statuses {
		byKey[status.Key] = status.State
	}
	require.Equal(t, "connected", byKey["client-1"])
	require.Equal(t, "listening", byKey["server-1"])
}
