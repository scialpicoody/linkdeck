package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"linkdeck/internal/framing"
)

func TestLoadMissingFallsBackToDefaults(t *testing.T) {
	cfg, err := LoadFrom(filepath.Join(t.TempDir(), "nope", "config.yaml"))
	if err == nil {
		t.Fatal("expected error for missing file")
	}
	if len(cfg.Presets) != 0 || len(cfg.Favorites) != 0 {
		t.Fatalf("expected defaults, got %+v", cfg)
	}
}

func TestLoadCorruptFallsBackToDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("presets: [unclosed\n\t!!!\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFrom(path)
	if err == nil {
		t.Fatal("expected error for corrupt file")
	}
	if len(cfg.Presets) != 0 || len(cfg.Favorites) != 0 {
		t.Fatalf("expected defaults, got %+v", cfg)
	}
}

func TestLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	want := Config{
		Presets: map[string]Preset{
			"bench": {
				Transport: TransportSerial, Endpoint: "/dev/ttyUSB0",
				Baud: 9600, DataBits: 8, Parity: "even", StopBits: "1",
				Framing:       FramingConfig{Name: "delimiter", Opts: map[string]string{"delimiter": "\n"}},
				ReadTimeoutMs: 500,
				Reconnect:     ReconnectConfig{Enabled: true, InitialMs: 200, MaxMs: 2000, MaxAttempts: 5},
			},
			"pi": {Transport: TransportTCP, Endpoint: "10.0.0.2:9000", Framing: FramingConfig{Name: "length-prefix"}},
		},
		Favorites: []string{"/scripts/a.lua", "/scripts/b.lua"},
	}
	if err := SaveTo(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Presets) != 2 || len(got.Favorites) != 2 {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	b := got.Presets["bench"]
	if b.Baud != 9600 || b.Parity != "even" || b.Framing.Opts["delimiter"] != "\n" || !b.Reconnect.Enabled {
		t.Fatalf("preset mismatch: %+v", b)
	}
}

func TestSaveLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	if err := SaveTo(filepath.Join(dir, "config.yaml"), DefaultConfig()); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "config.yaml" {
			t.Fatalf("stray file %s after save", e.Name())
		}
	}
}

// TestResolvePrecedence covers the explicit > preset > defaults matrix.
func TestResolvePrecedence(t *testing.T) {
	preset := Preset{Transport: TransportTCP, Endpoint: "host:1", Baud: 9600}
	d := DefaultPreset()

	if got := Resolve(Preset{}, ExplicitArgs{}); !reflect.DeepEqual(got, d) {
		t.Fatalf("empty/empty should be defaults: %+v", got)
	}
	if got := Resolve(preset, ExplicitArgs{}); got.Transport != TransportTCP || got.Endpoint != "host:1" || got.Baud != 9600 || got.DataBits != d.DataBits {
		t.Fatalf("preset should override defaults selectively: %+v", got)
	}
	got := Resolve(preset, ExplicitArgs{Baud: new(19200), Endpoint: new("other:2")})
	if got.Baud != 19200 || got.Endpoint != "other:2" || got.Transport != TransportTCP {
		t.Fatalf("explicit should win over preset: %+v", got)
	}
	// Explicit zero still wins (unset vs set distinction).
	got = Resolve(preset, ExplicitArgs{Baud: new(0)})
	if got.Baud != 0 {
		t.Fatalf("explicit zero must override preset: %+v", got)
	}
	// Framing opts: explicit map replaces preset map.
	got = Resolve(
		Preset{Framing: FramingConfig{Name: "delimiter", Opts: map[string]string{"delimiter": "\n"}}},
		ExplicitArgs{FramingOpts: map[string]string{"size": "64"}},
	)
	if got.Framing.Opts["size"] != "64" || len(got.Framing.Opts) != 1 {
		t.Fatalf("explicit framing opts should replace: %+v", got.Framing)
	}
	if got.Framing.Name != "delimiter" {
		t.Fatalf("preset framing name should survive: %+v", got.Framing)
	}
	// Reconnect: explicit struct replaces wholesale.
	got = Resolve(preset, ExplicitArgs{Reconnect: &ReconnectConfig{Enabled: true, InitialMs: 50}})
	if !got.Reconnect.Enabled || got.Reconnect.InitialMs != 50 || got.Reconnect.MaxMs != 0 {
		t.Fatalf("explicit reconnect should replace: %+v", got.Reconnect)
	}
}

func TestResolveNoAlias(t *testing.T) {
	preset := Preset{Framing: FramingConfig{Opts: map[string]string{"a": "b"}}}
	got := Resolve(preset, ExplicitArgs{})
	got.Framing.Opts["a"] = "mutated"
	if preset.Framing.Opts["a"] != "b" {
		t.Fatal("Resolve aliased the preset map")
	}
}

func TestConfigPath(t *testing.T) {
	p, err := ConfigPath()
	if err != nil {
		t.Skipf("no user config dir: %v", err)
	}
	if filepath.Base(p) != "config.yaml" || filepath.Base(filepath.Dir(p)) != "linkdeck" {
		t.Fatalf("unexpected path %s", p)
	}
}

func TestPresetCRUD(t *testing.T) {
	cfg := DefaultConfig()
	spec := framing.Spec{Kind: "delimiter", DelimiterHex: "0D0A"}
	preset := Preset{
		Transport: TransportSerial,
		Endpoint:  "/dev/ttyUSB0",
		Baud:      115200,
		Framing:   FramingConfig{Name: "delimiter", Spec: &spec},
	}
	if err := SetPreset(&cfg, "  bench  ", preset); err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Presets["bench"]; !ok {
		t.Fatal("trimmed preset name was not stored")
	}
	if err := RenamePreset(&cfg, "bench", "lab"); err != nil {
		t.Fatal(err)
	}
	if _, ok := cfg.Presets["bench"]; ok {
		t.Fatal("old preset name survived rename")
	}
	if got := cfg.Presets["lab"].Framing.Spec; got == nil || got.DelimiterHex != "0D0A" {
		t.Fatalf("rename lost framing spec: %+v", got)
	}
	if err := RemovePreset(&cfg, "lab"); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Presets) != 0 {
		t.Fatalf("preset not removed: %+v", cfg.Presets)
	}
	if err := RemovePreset(&cfg, "missing"); err == nil {
		t.Fatal("removing a missing preset should fail")
	}
}

func TestPresetValidation(t *testing.T) {
	if err := ValidatePreset(Preset{Transport: "udp"}); err == nil {
		t.Fatal("unknown transport should fail")
	}
	bad := framing.Spec{Kind: "fixed-size", FixedSize: 0}
	if err := ValidatePreset(Preset{
		Transport: TransportSerial,
		Framing:   FramingConfig{Spec: &bad},
	}); err == nil {
		t.Fatal("invalid framing should fail")
	}
}

func TestFramingSpecRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	spec := framing.Spec{
		Kind:         "header-checksum",
		HeaderHex:    "AA55",
		LengthOffset: 2,
		LengthWidth:  1,
		Checksum:     "xor",
	}
	want := Config{Presets: map[string]Preset{
		"framed": {
			Transport: TransportSerial,
			Endpoint:  "/dev/ttyUSB0",
			Framing:   FramingConfig{Name: "header-checksum", Spec: &spec},
		},
	}}
	if err := SaveTo(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if spec := got.Presets["framed"].Framing.Spec; spec == nil || spec.HeaderHex != "AA55" {
		t.Fatalf("framing spec did not round trip: %+v", spec)
	}
}
