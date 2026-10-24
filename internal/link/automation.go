package link

import (
	"errors"
	"fmt"

	"linkdeck/internal/automation"
	"linkdeck/internal/serial"
	"linkdeck/internal/tcp"
)

// AutomationSender maps automation Targets to the real transport services.
// It is the only automation adapter that imports serial/TCP drivers.
type AutomationSender struct {
	serial *serial.SerialService
	tcp    *tcp.TcpService
}

// NewAutomationSender returns the host adapter used by the automation engine.
func NewAutomationSender(serialSvc *serial.SerialService, tcpSvc *tcp.TcpService) *AutomationSender {
	return &AutomationSender{serial: serialSvc, tcp: tcpSvc}
}

// Send delivers payload to the Target's backend Channel.
func (s *AutomationSender) Send(target automation.Target, payload []byte) error {
	var (
		n   int
		err error
	)
	switch target.Transport {
	case "serial":
		if s.serial == nil {
			return errors.New("automation: serial transport unavailable")
		}
		n, err = s.serial.Send(target.Channel, payload)
	case "tcp-client":
		if s.tcp == nil {
			return errors.New("automation: TCP transport unavailable")
		}
		n, err = s.tcp.Send(target.Channel, payload)
	case "tcp-accepted":
		if s.tcp == nil {
			return errors.New("automation: TCP transport unavailable")
		}
		if target.Parent == "" {
			return errors.New("automation: accepted TCP target has no parent server")
		}
		n, err = s.tcp.ServerSend(target.Parent, target.Channel, payload)
	default:
		return fmt.Errorf("automation: unsupported transport %q", target.Transport)
	}
	if err != nil {
		return err
	}
	if n != len(payload) {
		return fmt.Errorf("automation: short write: %d of %d bytes", n, len(payload))
	}
	return nil
}
