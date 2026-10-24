package config

import (
	"os"
	"path/filepath"
	"testing"
)

func testSequence(name string) AutomationSequence {
	return AutomationSequence{
		Name:       name,
		Repeat:     2,
		IntervalMs: 50,
		Steps: []AutomationStep{
			{Kind: "send", Codec: "ascii", Payload: "AT", LineEnding: "crlf"},
			{Kind: "delay", DelayMs: 25},
			{Kind: "expect", Mode: "prefix", Pattern: "OK", TimeoutMs: 500},
		},
	}
}

func TestAutomationLibraryRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	cfg := DefaultConfig()
	if err := SaveAutomationCommand(&cfg, AutomationCommand{
		Name:        "Probe",
		Codec:       "ascii",
		Payload:     "AT+CSQ",
		LineEnding:  "crlf",
		Description: "signal quality",
	}); err != nil {
		t.Fatal(err)
	}
	if err := SaveAutomationSequence(&cfg, testSequence("Poll")); err != nil {
		t.Fatal(err)
	}
	if err := SaveTo(path, cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Automation.Commands) != 1 || len(loaded.Automation.Sequences) != 1 {
		t.Fatalf("automation library did not round trip: %+v", loaded.Automation)
	}
	if loaded.Automation.Sequences[0].Steps[2].Pattern != "OK" {
		t.Fatalf("step fields were lost: %+v", loaded.Automation.Sequences[0])
	}
}

func TestAutomationCRUDAndValidation(t *testing.T) {
	cfg := DefaultConfig()
	if err := SaveAutomationSequence(&cfg, testSequence("  Poll  ")); err != nil {
		t.Fatal(err)
	}
	if cfg.Automation.Sequences[0].Name != "Poll" {
		t.Fatal("sequence name was not normalized")
	}
	changed := testSequence("Poll")
	changed.Repeat = 3
	if err := SaveAutomationSequence(&cfg, changed); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Automation.Sequences) != 1 || cfg.Automation.Sequences[0].Repeat != 3 {
		t.Fatalf("upsert did not replace in place: %+v", cfg.Automation.Sequences)
	}
	if err := RenameAutomationSequence(&cfg, "Poll", "Bench poll"); err != nil {
		t.Fatal(err)
	}
	if cfg.Automation.Sequences[0].Name != "Bench poll" {
		t.Fatal("sequence rename failed")
	}
	if err := DeleteAutomationSequence(&cfg, "Bench poll"); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Automation.Sequences) != 0 {
		t.Fatal("sequence delete failed")
	}

	invalid := testSequence("bad")
	invalid.Continuous = true
	invalid.IntervalMs = 0
	if err := SaveAutomationSequence(&cfg, invalid); err == nil {
		t.Fatal("unsafe continuous sequence should fail validation")
	}
	if err := SaveAutomationCommand(&cfg, AutomationCommand{
		Name: "bad hex", Codec: "hex", Payload: "ABC",
	}); err == nil {
		t.Fatal("invalid HEX command should fail validation")
	}
}

func TestAutomationCloneDoesNotAlias(t *testing.T) {
	library := AutomationLibrary{
		Commands:  []AutomationCommand{{Name: "C"}},
		Sequences: []AutomationSequence{testSequence("S")},
	}
	clone := CloneAutomationLibrary(library)
	clone.Commands[0].Name = "changed"
	clone.Sequences[0].Steps[0].Payload = "changed"
	if library.Commands[0].Name != "C" || library.Sequences[0].Steps[0].Payload != "AT" {
		t.Fatal("automation clone aliased source data")
	}
}

func TestOldConfigLoadsEmptyAutomationLibrary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("presets: {}\nfavorites: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Automation.Commands == nil || cfg.Automation.Sequences == nil {
		t.Fatalf("legacy config should normalize empty automation slices: %+v", cfg.Automation)
	}
}
