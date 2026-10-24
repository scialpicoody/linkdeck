package config

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	MaxAutomationCommands  = 500
	MaxAutomationSequences = 500
	MaxAutomationSteps     = 256
	MaxAutomationPayload   = 1 << 20
	maxAutomationText      = 1 << 16
	maxAutomationWaitMs    = 24 * 60 * 60 * 1000
)

// AutomationLibrary is the persisted reusable-send workspace. Slices retain
// user ordering; names are the stable keys used by save/rename/delete calls.
type AutomationLibrary struct {
	Commands  []AutomationCommand  `yaml:"commands,omitempty" json:"commands"`
	Sequences []AutomationSequence `yaml:"sequences,omitempty" json:"sequences"`
}

// AutomationCommand is one named payload authored in the UI codec.
type AutomationCommand struct {
	Name        string `yaml:"name" json:"name"`
	Codec       string `yaml:"codec" json:"codec"`
	Payload     string `yaml:"payload" json:"payload"`
	LineEnding  string `yaml:"lineEnding,omitempty" json:"lineEnding,omitempty"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
	UpdatedAtMs int64  `yaml:"updatedAtMs,omitempty" json:"updatedAtMs,omitempty"`
}

// AutomationStep is the persisted, editable form of one Sequence step.
// Payload stays in the selected codec so loading it back into the editor is
// lossless.
type AutomationStep struct {
	Kind            string `yaml:"kind" json:"kind"`
	Payload         string `yaml:"payload,omitempty" json:"payload,omitempty"`
	Codec           string `yaml:"codec,omitempty" json:"codec,omitempty"`
	LineEnding      string `yaml:"lineEnding,omitempty" json:"lineEnding,omitempty"`
	Mode            string `yaml:"mode,omitempty" json:"mode,omitempty"`
	Pattern         string `yaml:"pattern,omitempty" json:"pattern,omitempty"`
	DelayMs         int    `yaml:"delayMs,omitempty" json:"delayMs,omitempty"`
	TimeoutMs       int    `yaml:"timeoutMs,omitempty" json:"timeoutMs,omitempty"`
	ContinueOnError bool   `yaml:"continueOnError,omitempty" json:"continueOnError,omitempty"`
}

// AutomationSequence is one reusable executable program without a Channel.
type AutomationSequence struct {
	Name        string           `yaml:"name" json:"name"`
	Description string           `yaml:"description,omitempty" json:"description,omitempty"`
	Steps       []AutomationStep `yaml:"steps" json:"steps"`
	Repeat      int              `yaml:"repeat" json:"repeat"`
	IntervalMs  int              `yaml:"intervalMs,omitempty" json:"intervalMs,omitempty"`
	Continuous  bool             `yaml:"continuous,omitempty" json:"continuous,omitempty"`
	UpdatedAtMs int64            `yaml:"updatedAtMs,omitempty" json:"updatedAtMs,omitempty"`
}

// CloneAutomationLibrary returns a deep-copy snapshot safe for bindings.
func CloneAutomationLibrary(library AutomationLibrary) AutomationLibrary {
	out := AutomationLibrary{
		Commands:  append([]AutomationCommand(nil), library.Commands...),
		Sequences: make([]AutomationSequence, len(library.Sequences)),
	}
	for index, sequence := range library.Sequences {
		sequence.Steps = append([]AutomationStep(nil), sequence.Steps...)
		out.Sequences[index] = sequence
	}
	if out.Commands == nil {
		out.Commands = []AutomationCommand{}
	}
	if out.Sequences == nil {
		out.Sequences = []AutomationSequence{}
	}
	return out
}

func normalizeAutomationName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("config: automation name is empty")
	}
	if utf8.RuneCountInString(name) > 64 {
		return "", errors.New("config: automation name must be 64 characters or fewer")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("config: automation name contains control characters")
		}
	}
	return name, nil
}

func validateCodec(codec string) error {
	if codec != "ascii" && codec != "hex" {
		return fmt.Errorf("config: unsupported command codec %q", codec)
	}
	return nil
}

func validateLineEnding(ending string) error {
	if ending == "" || ending == "none" || ending == "lf" || ending == "crlf" {
		return nil
	}
	return fmt.Errorf("config: unsupported line ending %q", ending)
}

func validatePayload(codec, payload string) error {
	if payload == "" {
		return errors.New("config: automation payload is empty")
	}
	if len(payload) > MaxAutomationPayload {
		return fmt.Errorf("config: automation payload exceeds %d bytes", MaxAutomationPayload)
	}
	if codec != "hex" {
		return nil
	}
	compact := strings.Join(strings.Fields(payload), "")
	if len(compact)%2 != 0 {
		return errors.New("config: HEX payload needs complete byte pairs")
	}
	for _, r := range compact {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return errors.New("config: HEX payload contains a non-hex character")
		}
	}
	return nil
}

// ValidateAutomationCommand checks one reusable command.
func ValidateAutomationCommand(command AutomationCommand) error {
	if err := validateCodec(command.Codec); err != nil {
		return err
	}
	if err := validateLineEnding(command.LineEnding); err != nil {
		return err
	}
	if err := validatePayload(command.Codec, command.Payload); err != nil {
		return err
	}
	if len(command.Description) > maxAutomationText {
		return fmt.Errorf("config: command description exceeds %d bytes", maxAutomationText)
	}
	return nil
}

// ValidateAutomationSequence checks one reusable Sequence before persistence.
func ValidateAutomationSequence(sequence AutomationSequence) error {
	if len(sequence.Description) > maxAutomationText {
		return fmt.Errorf("config: sequence description exceeds %d bytes", maxAutomationText)
	}
	if len(sequence.Steps) == 0 {
		return errors.New("config: automation sequence has no steps")
	}
	if len(sequence.Steps) > MaxAutomationSteps {
		return fmt.Errorf("config: automation sequence exceeds %d steps", MaxAutomationSteps)
	}
	if sequence.Repeat < 1 || sequence.Repeat > 1_000_000 {
		return errors.New("config: automation repeat must be 1-1000000")
	}
	if sequence.IntervalMs < 0 || sequence.IntervalMs > maxAutomationWaitMs {
		return fmt.Errorf("config: automation interval must be 0-%d ms", maxAutomationWaitMs)
	}
	if sequence.Continuous && sequence.IntervalMs == 0 {
		return errors.New("config: continuous automation requires a positive interval")
	}
	for index, step := range sequence.Steps {
		switch step.Kind {
		case "send":
			if err := validateCodec(step.Codec); err != nil {
				return fmt.Errorf("config: step %d: %w", index+1, err)
			}
			if err := validateLineEnding(step.LineEnding); err != nil {
				return fmt.Errorf("config: step %d: %w", index+1, err)
			}
			if err := validatePayload(step.Codec, step.Payload); err != nil {
				return fmt.Errorf("config: step %d: %w", index+1, err)
			}
		case "delay":
			if step.DelayMs < 0 || step.DelayMs > maxAutomationWaitMs {
				return fmt.Errorf("config: step %d delay is out of range", index+1)
			}
		case "expect":
			if step.Mode != "prefix" && step.Mode != "regex" && step.Mode != "pattern" {
				return fmt.Errorf("config: step %d has unsupported matcher mode %q", index+1, step.Mode)
			}
			if step.Pattern == "" {
				return fmt.Errorf("config: step %d matcher pattern is empty", index+1)
			}
			if step.TimeoutMs < 1 || step.TimeoutMs > maxAutomationWaitMs {
				return fmt.Errorf("config: step %d timeout is out of range", index+1)
			}
		default:
			return fmt.Errorf("config: step %d has unsupported kind %q", index+1, step.Kind)
		}
	}
	return nil
}

// SaveAutomationCommand inserts or replaces a command by normalized name.
func SaveAutomationCommand(cfg *Config, command AutomationCommand) error {
	name, err := normalizeAutomationName(command.Name)
	if err != nil {
		return err
	}
	command.Name = name
	if err := ValidateAutomationCommand(command); err != nil {
		return err
	}
	command.UpdatedAtMs = time.Now().UnixMilli()
	cfg.Automation.Commands = upsertCommand(cfg.Automation.Commands, command)
	return nil
}

// DeleteAutomationCommand removes one named command.
func DeleteAutomationCommand(cfg *Config, name string) error {
	name, err := normalizeAutomationName(name)
	if err != nil {
		return err
	}
	for index, command := range cfg.Automation.Commands {
		if command.Name == name {
			cfg.Automation.Commands = append(
				cfg.Automation.Commands[:index:index],
				cfg.Automation.Commands[index+1:]...,
			)
			return nil
		}
	}
	return fmt.Errorf("config: automation command %q does not exist", name)
}

// RenameAutomationCommand preserves order and rejects duplicate names.
func RenameAutomationCommand(cfg *Config, oldName, newName string) error {
	newName, err := normalizeAutomationName(newName)
	if err != nil {
		return err
	}
	index := commandIndex(cfg.Automation.Commands, oldName)
	if index < 0 {
		return fmt.Errorf("config: automation command %q does not exist", oldName)
	}
	if commandIndex(cfg.Automation.Commands, newName) >= 0 {
		return fmt.Errorf("config: automation command %q already exists", newName)
	}
	cfg.Automation.Commands[index].Name = newName
	cfg.Automation.Commands[index].UpdatedAtMs = time.Now().UnixMilli()
	return nil
}

// SaveAutomationSequence inserts or replaces a Sequence by normalized name.
func SaveAutomationSequence(cfg *Config, sequence AutomationSequence) error {
	name, err := normalizeAutomationName(sequence.Name)
	if err != nil {
		return err
	}
	sequence.Name = name
	if err := ValidateAutomationSequence(sequence); err != nil {
		return err
	}
	sequence.Steps = append([]AutomationStep(nil), sequence.Steps...)
	sequence.UpdatedAtMs = time.Now().UnixMilli()
	cfg.Automation.Sequences = upsertSequence(cfg.Automation.Sequences, sequence)
	return nil
}

// DeleteAutomationSequence removes one named Sequence.
func DeleteAutomationSequence(cfg *Config, name string) error {
	name, err := normalizeAutomationName(name)
	if err != nil {
		return err
	}
	for index, sequence := range cfg.Automation.Sequences {
		if sequence.Name == name {
			cfg.Automation.Sequences = append(
				cfg.Automation.Sequences[:index:index],
				cfg.Automation.Sequences[index+1:]...,
			)
			return nil
		}
	}
	return fmt.Errorf("config: automation sequence %q does not exist", name)
}

// RenameAutomationSequence preserves order and rejects duplicate names.
func RenameAutomationSequence(cfg *Config, oldName, newName string) error {
	newName, err := normalizeAutomationName(newName)
	if err != nil {
		return err
	}
	index := sequenceIndex(cfg.Automation.Sequences, oldName)
	if index < 0 {
		return fmt.Errorf("config: automation sequence %q does not exist", oldName)
	}
	if sequenceIndex(cfg.Automation.Sequences, newName) >= 0 {
		return fmt.Errorf("config: automation sequence %q already exists", newName)
	}
	cfg.Automation.Sequences[index].Name = newName
	cfg.Automation.Sequences[index].UpdatedAtMs = time.Now().UnixMilli()
	return nil
}

func upsertCommand(commands []AutomationCommand, command AutomationCommand) []AutomationCommand {
	next := append([]AutomationCommand(nil), commands...)
	if index := commandIndex(next, command.Name); index >= 0 {
		next[index] = command
		return next
	}
	if len(next) >= MaxAutomationCommands {
		next = next[1:]
	}
	return append(next, command)
}

func upsertSequence(sequences []AutomationSequence, sequence AutomationSequence) []AutomationSequence {
	next := append([]AutomationSequence(nil), sequences...)
	if index := sequenceIndex(next, sequence.Name); index >= 0 {
		next[index] = sequence
		return next
	}
	if len(next) >= MaxAutomationSequences {
		next = next[1:]
	}
	return append(next, sequence)
}

func commandIndex(commands []AutomationCommand, name string) int {
	name = strings.TrimSpace(name)
	for index, command := range commands {
		if command.Name == name {
			return index
		}
	}
	return -1
}

func sequenceIndex(sequences []AutomationSequence, name string) int {
	name = strings.TrimSpace(name)
	for index, sequence := range sequences {
		if sequence.Name == name {
			return index
		}
	}
	return -1
}
