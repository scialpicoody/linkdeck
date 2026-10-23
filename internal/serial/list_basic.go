//go:build darwin && !cgo

package serial

import (
	"fmt"

	goserial "go.bug.st/serial"
)

// List returns all serial ports by name. This fallback builds without cgo,
// where the detailed USB enumerator (IOKit) is unavailable; only Name is
// populated. See list_detail.go for the full version.
func List() ([]PortInfo, error) {
	names, err := goserial.GetPortsList()
	if err != nil {
		return nil, fmt.Errorf("serial: list ports: %w", err)
	}
	out := make([]PortInfo, 0, len(names))
	for _, n := range names {
		out = append(out, PortInfo{Name: n})
	}
	return out, nil
}
