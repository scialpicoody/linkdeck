//go:build !darwin || cgo

package serial

import (
	"fmt"

	goserial "go.bug.st/serial"
	"go.bug.st/serial/enumerator"
)

// List returns all serial ports with USB detail where the platform reports
// it. Active USB probing stays disabled (no filters): plain enumeration must
// not disturb attached devices (see research/serial-library.md).
func List() ([]PortInfo, error) {
	// Prefer detailed enumeration; fall back to plain names if the detailed
	// pass fails so a half-broken USB stack still yields usable ports.
	details, err := enumerator.GetDetailedPortsList()
	if err == nil {
		out := make([]PortInfo, 0, len(details))
		for _, d := range details {
			if d == nil {
				continue
			}
			out = append(out, PortInfo{
				Name:         d.Name,
				USB:          d.IsUSB,
				VID:          d.VID,
				PID:          d.PID,
				SerialNumber: d.SerialNumber,
				Manufacturer: d.Manufacturer,
				Product:      d.Product,
			})
		}
		return out, nil
	}
	names, lerr := goserial.GetPortsList()
	if lerr != nil {
		return nil, fmt.Errorf("serial: list ports: %w (detailed: %v)", lerr, err)
	}
	out := make([]PortInfo, 0, len(names))
	for _, n := range names {
		out = append(out, PortInfo{Name: n})
	}
	return out, nil
}
