# Configuration

LinkDeck stores one schema-v1 YAML document. Configuration is discovered in a
small hierarchy and the first existing file is authoritative:

1. `LINKDECK_CONFIG`, when set, for an explicit file.
2. `config.yaml` beside the executable, for portable installs.
3. `os.UserConfigDir()/linkdeck/config.yaml`, for per-user settings.

`mygo dev` skips the executable layer because its app bundle is an ephemeral
staging directory.

Only one file is read. The search does not merge settings across files. This
keeps the active configuration predictable and lets read-modify-write
operations save back to the same file. If none exists, the first preferred
path is the save target; a missing file is a normal first-run state and does
not log an error.

Corrupt or unreadable configuration warns through the calling service and
falls back to defaults. It never prevents startup. Saves use a temporary file
in the target directory followed by a rename.

The document is grouped by user-facing capability:

```yaml
presets:        # named serial/TCP channel configurations
  bench: {}
favorites:      # ordered workspace-relative Lua paths
  - hello.lua
automation:
  commands: []  # reusable outbound payloads
  sequences: [] # reusable send/delay/expect programs
```

See `resources/config.example.yaml` for a complete annotated example.
