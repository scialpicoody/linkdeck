package serial

// PortInfo describes one serial port. USB detail fields are populated where
// the platform reports them (see list_detail.go); elsewhere only Name is
// set. Poll List on a ticker for arrival/removal detection: the underlying
// library offers no hotplug events (see package doc gap 2).
type PortInfo struct {
	Name         string `json:"name"`
	USB          bool   `json:"usb"`
	VID          string `json:"vid,omitempty"`
	PID          string `json:"pid,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Product      string `json:"product,omitempty"`
}
