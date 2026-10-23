// Package config owns LinkDeck's persistent configuration: channel
// presets and script favorites stored at
// os.UserConfigDir()/linkdeck/config.yaml (schema v1, YAML).
//
// Load failure (missing or corrupt file) warns via the standard logger
// and returns defaults; it never refuses to start. Save writes
// atomically (temp file + rename) so a crash cannot leave a half-written
// config. Resolve merges explicit open args over a preset over built-in
// defaults for the UI favorites seam to plug into.
package config
