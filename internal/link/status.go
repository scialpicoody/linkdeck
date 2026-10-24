package link

// TransportStatus is one host-published channel lifecycle snapshot. Keys
// are backend identities: serial port names, TCP client/server names, or
// accepted-connection ids.
type TransportStatus struct {
	Key      string `json:"key"`
	Kind     string `json:"kind"`
	Parent   string `json:"parent,omitempty"`
	Endpoint string `json:"endpoint"`
	State    string `json:"state"`
	Error    string `json:"error,omitempty"`
	Attempts int    `json:"attempts,omitempty"`
}
