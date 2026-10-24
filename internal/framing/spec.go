package framing

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// Spec is the bindings-safe framing selection used by transport open calls.
// Hex fields carry raw delimiter/header bytes; empty values are invalid for
// the kinds that require them.
type Spec struct {
	Kind         string `json:"kind"`
	DelimiterHex string `json:"delimiterHex,omitempty"`
	FixedSize    int    `json:"fixedSize,omitempty"`
	LengthOffset int    `json:"lengthOffset,omitempty"`
	LengthWidth  int    `json:"lengthWidth,omitempty"`
	LengthEndian string `json:"lengthEndian,omitempty"`
	HeaderHex    string `json:"headerHex,omitempty"`
	Checksum     string `json:"checksum,omitempty"`
	MaxFrameSize int    `json:"maxFrameSize,omitempty"`
}

// DefaultSpec preserves the original LF-delimited default.
func DefaultSpec() Spec {
	return Spec{Kind: "delimiter", DelimiterHex: "0A"}
}

// New validates spec and constructs the selected framer.
func New(spec Spec) (Framer, error) {
	switch spec.Kind {
	case "delimiter":
		delimiter, err := decodeHexField("delimiter", spec.DelimiterHex)
		if err != nil {
			return nil, err
		}
		return NewDelimiter(DelimiterConfig{Delimiter: delimiter, MaxFrameSize: spec.MaxFrameSize})
	case "fixed-size":
		return NewFixedSize(spec.FixedSize, spec.MaxFrameSize)
	case "length-prefix":
		order, err := byteOrder(spec.LengthEndian)
		if err != nil {
			return nil, err
		}
		return NewLengthPrefix(LengthPrefixConfig{
			Offset:       spec.LengthOffset,
			Width:        spec.LengthWidth,
			Order:        order,
			MaxFrameSize: spec.MaxFrameSize,
		})
	case "header-checksum":
		header, err := decodeHexField("header", spec.HeaderHex)
		if err != nil {
			return nil, err
		}
		checksum, err := checksumKind(spec.Checksum)
		if err != nil {
			return nil, err
		}
		order, err := byteOrder(spec.LengthEndian)
		if err != nil {
			return nil, err
		}
		return NewHeaderLengthChecksum(HeaderChecksumConfig{
			Header:       header,
			LengthOffset: spec.LengthOffset,
			LengthWidth:  spec.LengthWidth,
			Order:        order,
			Checksum:     checksum,
			MaxFrameSize: spec.MaxFrameSize,
		})
	default:
		return nil, fmt.Errorf("framing: unknown kind %q", spec.Kind)
	}
}

func decodeHexField(label, value string) ([]byte, error) {
	if value == "" {
		return nil, fmt.Errorf("framing: %s is required", label)
	}
	out, err := hex.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("framing: invalid %s hex: %w", label, err)
	}
	return out, nil
}

func checksumKind(value string) (ChecksumKind, error) {
	switch value {
	case "xor":
		return ChecksumXOR, nil
	case "sum8":
		return ChecksumSum8, nil
	case "crc8":
		return ChecksumCRC8, nil
	default:
		return 0, errors.New(`framing: checksum must be "xor", "sum8", or "crc8"`)
	}
}

func byteOrder(value string) (binary.ByteOrder, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "big", "be":
		return binary.BigEndian, nil
	case "little", "le":
		return binary.LittleEndian, nil
	default:
		return nil, fmt.Errorf("framing: length endian must be %q or %q, got %q",
			"big", "little", value)
	}
}
