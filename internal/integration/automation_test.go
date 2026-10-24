package integration

import (
	"io"
	"net"
	"testing"
	"time"

	"linkdeck/internal/automation"
	"linkdeck/internal/framing"
	"linkdeck/internal/link"
	"linkdeck/internal/script"
	"linkdeck/internal/stream"
	"linkdeck/internal/tcp"
)

func TestAutomationSendExpectThroughTCPStream(t *testing.T) {
	server, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	go func() {
		conn, err := server.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 3)
		if _, err := io.ReadFull(conn, buf); err != nil {
			return
		}
		if string(buf) == "AT\r" {
			_, _ = conn.Write([]byte("OK\r\n"))
		}
	}()

	pool := script.NewPool()
	defer pool.Close()
	manager := stream.NewManager(pool, nil)
	defer manager.Close()
	tcpSvc := tcp.NewTcpService()
	tcpSvc.AttachStream(manager)
	_, err = tcpSvc.Open(tcp.OpenRequest{
		Name:             "automation-client",
		Address:          server.Addr().String(),
		ConnectTimeoutMs: 1000,
		Framing:          framing.Spec{Kind: "delimiter", DelimiterHex: "0A"},
		Stream:           true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer tcpSvc.Close("automation-client")

	engine := automation.NewEngine(automation.Options{
		Sender: link.NewAutomationSender(nil, tcpSvc),
		Pool:   pool,
	})
	defer engine.Close()
	info, err := engine.Start(automation.RunSpec{
		Name: "tcp-probe",
		Target: automation.Target{
			Channel: "automation-client", Transport: "tcp-client",
		},
		Steps: []automation.Step{
			{Kind: automation.StepSend, Payload: []byte("AT\r")},
			{Kind: automation.StepExpect, Pattern: "OK", TimeoutMs: 2000},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		run, err := engine.Status(info.ID)
		if err != nil {
			t.Fatal(err)
		}
		if run.State == automation.StateCompleted {
			if run.Sent != 1 || run.Matched != 1 {
				t.Fatalf("completed run has wrong totals: %+v", run)
			}
			return
		}
		if run.State == automation.StateFailed || run.State == automation.StateTimedOut {
			t.Fatalf("automation failed: %+v", run)
		}
		if time.Now().After(deadline) {
			t.Fatalf("automation did not complete: %+v", run)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
