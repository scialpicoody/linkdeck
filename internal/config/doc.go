// Package config owns LinkDeck's persistent configuration: channel presets,
// script favorites, and reusable automation definitions (schema v1, YAML).
//
// Configuration resolves in layers: an explicit LINKDECK_CONFIG path, a
// portable config.yaml beside the executable, then
// os.UserConfigDir()/linkdeck/config.yaml. The first existing file is
// authoritative. A missing file is a normal first-run state and returns
// defaults; a corrupt file also returns defaults, with an error for the
// caller to report, and never refuses to start. Save writes atomically (temp
// file + rename) so a crash cannot leave a half-written config. Resolve
// merges explicit open args over a preset over built-in defaults.
package config
