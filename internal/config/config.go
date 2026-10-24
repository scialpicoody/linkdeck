package config

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	yaml "go.yaml.in/yaml/v3"
	"linkdeck/internal/framing"
)

// Transports known to presets.
const (
	TransportSerial    = "serial"
	TransportTCP       = "tcp" // legacy alias for tcp-client
	TransportTCPClient = "tcp-client"
	TransportTCPServer = "tcp-server"
)

// Default open parameters applied when neither preset nor explicit args
// set a value.
const (
	DefaultTransport     = TransportSerial
	DefaultBaud          = 115200
	DefaultDataBits      = 8
	DefaultParity        = "none"
	DefaultStopBits      = "1"
	DefaultFraming       = "delimiter"
	DefaultReadTimeoutMs = 1000
)

// Defaults for the reconnect policy.
const (
	DefaultReconnectInitialMs = 100
	DefaultReconnectMaxMs     = 5000
	DefaultReconnectAttempts  = 0 // 0 = retry without a cap
)

// FramingConfig selects one framer plus its string options
// (e.g. delimiter: {delimiter: "\n"}, fixed-size: {size: "64"}).
type FramingConfig struct {
	Name string            `yaml:"name,omitempty"`
	Opts map[string]string `yaml:"opts,omitempty"`
	Spec *framing.Spec     `yaml:"spec,omitempty"`
}

// ReconnectConfig bounds TCP redial behavior. MaxAttempts <= 0 means
// unbounded retries.
type ReconnectConfig struct {
	Enabled     bool `yaml:"enabled,omitempty"`
	InitialMs   int  `yaml:"initialMs,omitempty"`
	MaxMs       int  `yaml:"maxMs,omitempty"`
	MaxAttempts int  `yaml:"maxAttempts,omitempty"`
}

// Preset is one named channel preset: transport selection, endpoint
// (serial port name or TCP host:port), serial line parameters, framing,
// read timeout, and the TCP reconnect policy. Zero-valued fields mean
// "unset" and fall back to defaults under Resolve.
type Preset struct {
	Transport        string          `yaml:"transport,omitempty"`
	Endpoint         string          `yaml:"endpoint,omitempty"`
	Baud             int             `yaml:"baud,omitempty"`
	DataBits         int             `yaml:"dataBits,omitempty"`
	Parity           string          `yaml:"parity,omitempty"`
	StopBits         string          `yaml:"stopBits,omitempty"`
	Framing          FramingConfig   `yaml:"framing,omitempty"`
	ReadTimeoutMs    int             `yaml:"readTimeoutMs,omitempty"`
	Reconnect        ReconnectConfig `yaml:"reconnect,omitempty"`
	ConnectTimeoutMs int             `yaml:"connectTimeoutMs,omitempty"`
	HeartbeatMs      int             `yaml:"heartbeatMs,omitempty"`
	HeartbeatPayload string          `yaml:"heartbeatPayload,omitempty"`
}

// Config is the schema-v1 document: named channel presets, ordered
// script-favorite paths, and reusable automation definitions.
type Config struct {
	Presets    map[string]Preset `yaml:"presets,omitempty"`
	Favorites  []string          `yaml:"favorites,omitempty"`
	Automation AutomationLibrary `yaml:"automation,omitempty"`
}

// ExplicitArgs carries per-open overrides. A nil pointer (or nil map)
// means "not given" so Resolve keeps the preset value; a non-nil value
// wins over both preset and defaults, including an explicit zero.
type ExplicitArgs struct {
	Transport     *string
	Endpoint      *string
	Baud          *int
	DataBits      *int
	Parity        *string
	StopBits      *string
	FramingName   *string
	FramingOpts   map[string]string
	ReadTimeoutMs *int
	Reconnect     *ReconnectConfig
}

// DefaultPreset returns the built-in open parameters.
func DefaultPreset() Preset {
	return Preset{
		Transport:     DefaultTransport,
		Baud:          DefaultBaud,
		DataBits:      DefaultDataBits,
		Parity:        DefaultParity,
		StopBits:      DefaultStopBits,
		Framing:       FramingConfig{Name: DefaultFraming},
		ReadTimeoutMs: DefaultReadTimeoutMs,
		Reconnect: ReconnectConfig{
			InitialMs:   DefaultReconnectInitialMs,
			MaxMs:       DefaultReconnectMaxMs,
			MaxAttempts: DefaultReconnectAttempts,
		},
	}
}

// DefaultConfig returns the empty-but-valid configuration.
func DefaultConfig() Config {
	return Config{
		Presets:   map[string]Preset{},
		Favorites: []string{},
		Automation: AutomationLibrary{
			Commands:  []AutomationCommand{},
			Sequences: []AutomationSequence{},
		},
	}
}

// ConfigPath reports os.UserConfigDir()/linkdeck/config.yaml.
func ConfigPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("config: user config dir: %w", err)
	}
	return filepath.Join(dir, "linkdeck", "config.yaml"), nil
}

// Load reads the default path, logs the path on load, and falls back to
// defaults (with a warning, never fatal) when the file is missing or
// corrupt.
func Load() (Config, error) {
	path, err := ConfigPath()
	if err != nil {
		log.Printf("config: %v; running on defaults", err)
		return DefaultConfig(), err
	}
	return LoadFrom(path)
}

// LoadFrom reads path with the same warn-and-defaults contract as Load.
func LoadFrom(path string) (Config, error) {
	log.Printf("config: loading %s", path)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			log.Printf("config: %s missing; running on defaults", path)
		} else {
			log.Printf("config: read %s: %v; running on defaults", path, err)
		}
		return DefaultConfig(), err
	}
	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		log.Printf("config: parse %s: %v; running on defaults", path, err)
		return DefaultConfig(), err
	}
	if cfg.Presets == nil {
		cfg.Presets = map[string]Preset{}
	}
	if cfg.Favorites == nil {
		cfg.Favorites = []string{}
	}
	if cfg.Automation.Commands == nil {
		cfg.Automation.Commands = []AutomationCommand{}
	}
	if cfg.Automation.Sequences == nil {
		cfg.Automation.Sequences = []AutomationSequence{}
	}
	return cfg, nil
}

// Save writes cfg to the default path atomically (temp file in the same
// directory + rename) so a crash cannot leave a half-written config.
func Save(cfg Config) error {
	path, err := ConfigPath()
	if err != nil {
		return err
	}
	return SaveTo(path, cfg)
}

// SaveTo writes cfg to path atomically via temp file + rename.
func SaveTo(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("config: mkdir: %w", err)
	}
	raw, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("config: temp file: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return fmt.Errorf("config: write temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("config: close temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("config: rename: %w", err)
	}
	return nil
}

// Resolve merges explicit open args over preset over built-in defaults:
// every field starts at the default, a nonzero preset field overrides it,
// and a non-nil explicit field wins outright.
func Resolve(preset Preset, explicit ExplicitArgs) Preset {
	out := DefaultPreset()
	if preset.Transport != "" {
		out.Transport = preset.Transport
	}
	if preset.Endpoint != "" {
		out.Endpoint = preset.Endpoint
	}
	if preset.Baud != 0 {
		out.Baud = preset.Baud
	}
	if preset.DataBits != 0 {
		out.DataBits = preset.DataBits
	}
	if preset.Parity != "" {
		out.Parity = preset.Parity
	}
	if preset.StopBits != "" {
		out.StopBits = preset.StopBits
	}
	if preset.Framing.Name != "" {
		out.Framing.Name = preset.Framing.Name
	}
	if len(preset.Framing.Opts) > 0 {
		out.Framing.Opts = cloneMap(preset.Framing.Opts)
	}
	if preset.Framing.Spec != nil {
		spec := *preset.Framing.Spec
		out.Framing.Spec = &spec
	}
	if preset.ReadTimeoutMs != 0 {
		out.ReadTimeoutMs = preset.ReadTimeoutMs
	}
	if preset.ConnectTimeoutMs != 0 {
		out.ConnectTimeoutMs = preset.ConnectTimeoutMs
	}
	if preset.HeartbeatMs != 0 {
		out.HeartbeatMs = preset.HeartbeatMs
	}
	if preset.HeartbeatPayload != "" {
		out.HeartbeatPayload = preset.HeartbeatPayload
	}
	// Reconnect is a plain struct, so overlay field by field: a nonzero
	// preset field overrides the default. Enabled is boolean (no nonzero
	// test), so the preset value always applies at this layer.
	out.Reconnect.Enabled = preset.Reconnect.Enabled
	if preset.Reconnect.InitialMs != 0 {
		out.Reconnect.InitialMs = preset.Reconnect.InitialMs
	}
	if preset.Reconnect.MaxMs != 0 {
		out.Reconnect.MaxMs = preset.Reconnect.MaxMs
	}
	if preset.Reconnect.MaxAttempts != 0 {
		out.Reconnect.MaxAttempts = preset.Reconnect.MaxAttempts
	}

	if explicit.Transport != nil {
		out.Transport = *explicit.Transport
	}
	if explicit.Endpoint != nil {
		out.Endpoint = *explicit.Endpoint
	}
	if explicit.Baud != nil {
		out.Baud = *explicit.Baud
	}
	if explicit.DataBits != nil {
		out.DataBits = *explicit.DataBits
	}
	if explicit.Parity != nil {
		out.Parity = *explicit.Parity
	}
	if explicit.StopBits != nil {
		out.StopBits = *explicit.StopBits
	}
	if explicit.FramingName != nil {
		out.Framing.Name = *explicit.FramingName
	}
	if explicit.FramingOpts != nil {
		out.Framing.Opts = cloneMap(explicit.FramingOpts)
	}
	if explicit.ReadTimeoutMs != nil {
		out.ReadTimeoutMs = *explicit.ReadTimeoutMs
	}
	if explicit.Reconnect != nil {
		out.Reconnect = *explicit.Reconnect
	}
	return out
}

func cloneMap(m map[string]string) map[string]string {
	if m == nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// NormalizePresetName trims and validates a user-facing preset name.
func NormalizePresetName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("config: preset name is empty")
	}
	if len(name) > 64 {
		return "", errors.New("config: preset name must be 64 characters or fewer")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("config: preset name contains control characters")
		}
	}
	return name, nil
}

// ValidatePreset rejects values that cannot produce a usable open request.
func ValidatePreset(preset Preset) error {
	if preset.Transport != "" &&
		preset.Transport != TransportSerial &&
		preset.Transport != TransportTCP &&
		preset.Transport != TransportTCPClient &&
		preset.Transport != TransportTCPServer {
		return fmt.Errorf("config: unknown preset transport %q", preset.Transport)
	}
	if preset.Baud < 0 {
		return errors.New("config: preset baud rate must not be negative")
	}
	if preset.DataBits != 0 && (preset.DataBits < 5 || preset.DataBits > 8) {
		return errors.New("config: preset data bits must be 5-8")
	}
	if preset.ReadTimeoutMs < 0 {
		return errors.New("config: preset read timeout must not be negative")
	}
	if preset.ConnectTimeoutMs < 0 || preset.HeartbeatMs < 0 {
		return errors.New("config: preset TCP timers must not be negative")
	}
	if preset.Reconnect.InitialMs < 0 || preset.Reconnect.MaxMs < 0 || preset.Reconnect.MaxAttempts < 0 {
		return errors.New("config: preset reconnect values must not be negative")
	}
	if preset.Framing.Spec != nil {
		if _, err := framing.New(*preset.Framing.Spec); err != nil {
			return fmt.Errorf("config: preset framing: %w", err)
		}
	}
	return nil
}

// SetPreset validates and inserts or replaces one named preset.
func SetPreset(cfg *Config, name string, preset Preset) error {
	name, err := NormalizePresetName(name)
	if err != nil {
		return err
	}
	if err := ValidatePreset(preset); err != nil {
		return err
	}
	if cfg.Presets == nil {
		cfg.Presets = make(map[string]Preset)
	}
	cfg.Presets[name] = preset
	return nil
}

// RemovePreset deletes one named preset.
func RemovePreset(cfg *Config, name string) error {
	name, err := NormalizePresetName(name)
	if err != nil {
		return err
	}
	if _, ok := cfg.Presets[name]; !ok {
		return fmt.Errorf("config: preset %q does not exist", name)
	}
	delete(cfg.Presets, name)
	return nil
}

// RenamePreset atomically renames one preset while preserving its body.
func RenamePreset(cfg *Config, oldName, newName string) error {
	oldName, err := NormalizePresetName(oldName)
	if err != nil {
		return err
	}
	newName, err = NormalizePresetName(newName)
	if err != nil {
		return err
	}
	preset, ok := cfg.Presets[oldName]
	if !ok {
		return fmt.Errorf("config: preset %q does not exist", oldName)
	}
	if oldName == newName {
		return nil
	}
	if _, exists := cfg.Presets[newName]; exists {
		return fmt.Errorf("config: preset %q already exists", newName)
	}
	delete(cfg.Presets, oldName)
	cfg.Presets[newName] = preset
	return nil
}
