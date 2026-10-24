package main

import (
	"log"
	"runtime"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"linkdeck/internal/config"
	"linkdeck/internal/link"
	"linkdeck/internal/script"
	"linkdeck/internal/serial"
	"linkdeck/internal/stream"
	"linkdeck/internal/tcp"
)

// Greeter is callable from the frontend: `mygo generate` turns its methods
// into typed TypeScript functions in src/mygo.ts.
type Greeter struct{}

// Greet returns a greeting for name.
func (Greeter) Greet(name string) string {
	if name == "" {
		name = "stranger"
	}
	return "Hello, " + name + "! This message comes from Go."
}

// SystemInfo describes the machine the app runs on.
type SystemInfo struct {
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	GoVersion string `json:"goVersion"`
}

// Info returns information about the system.
func (Greeter) Info() SystemInfo {
	return SystemInfo{OS: runtime.GOOS, Arch: runtime.GOARCH, GoVersion: runtime.Version()}
}

// Tick is sent to the page every second.
var Tick = mygo.NewEvent[time.Time]("tick")

// Frames carries unmatched-frame batches (matcher-first path) to the UI.
// Payloads cross as base64 strings; see script.FrameDTO.
var Frames = mygo.NewEvent[[]script.FrameDTO]("frames")

// StreamErrors carries non-fatal framing failures (oversize/checksum) and
// cumulative per-channel counts to the workbench.
var StreamErrors = mygo.NewEvent[stream.FramingError]("stream-errors")

// ScriptOutput carries structured rows scoped to their run/script.
var ScriptOutput = mygo.NewEvent[script.OutputRow]("script-output")

// ScriptRunStatus carries queued/running/final run-state transitions.
var ScriptRunStatus = mygo.NewEvent[script.RunInfo]("script-run-status")

// ScriptAPI is the bound scripting surface for source/file runs and
// long-lived sessions.
type ScriptAPI struct {
	svc *script.ScriptService
}

// Run executes Lua source with a millisecond timeout.
func (a ScriptAPI) Run(src string, timeoutMs int) error {
	return a.svc.Run(src, timeoutMs)
}

// RunFile executes a script file with a millisecond timeout.
func (a ScriptAPI) RunFile(path string, timeoutMs int) error {
	return a.svc.RunFile(path, timeoutMs)
}

// StartRun starts a fresh-source run and returns its stable run id.
func (a ScriptAPI) StartRun(src string, script string, timeoutMs int) (script.RunInfo, error) {
	return a.svc.StartSource(src, script, timeoutMs)
}

// StartFile starts a workspace-relative file run.
func (a ScriptAPI) StartFile(path string, timeoutMs int) (script.RunInfo, error) {
	return a.svc.StartFile(path, timeoutMs)
}

// CancelRun requests cancellation of a queued or running run.
func (a ScriptAPI) CancelRun(id string) (script.RunInfo, error) {
	return a.svc.CancelRun(id)
}

// RunStatus reads one retained run record.
func (a ScriptAPI) RunStatus(id string) (script.RunInfo, error) {
	return a.svc.RunStatus(id)
}

// LoadSession loads or reuses a long-lived workspace session.
func (a ScriptAPI) LoadSession(path string) (script.SessionInfo, error) {
	return a.svc.LoadSession(path)
}

// CallSession starts one long-lived session function call.
func (a ScriptAPI) CallSession(path, fn string, timeoutMs int) (script.RunInfo, error) {
	return a.svc.CallSession(path, fn, timeoutMs)
}

// CloseSession closes one long-lived session.
func (a ScriptAPI) CloseSession(path string) error {
	return a.svc.CloseSession(path)
}

// Sessions lists live long-lived sessions.
func (a ScriptAPI) Sessions() []script.SessionInfo {
	return a.svc.Sessions()
}

// WorkspaceAPI exposes the configured Lua workspace to the Scripts view.
// It opens the directory lazily so a bad config path becomes an actionable
// UI error without preventing the rest of the workbench from starting.
type WorkspaceAPI struct {
	mu sync.Mutex
	ws *script.Workspace
}

func (a *WorkspaceAPI) workspace() (*script.Workspace, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ws != nil {
		return a.ws, nil
	}
	root, err := script.DefaultWorkspaceRoot()
	if err != nil {
		return nil, err
	}
	ws, err := script.OpenWorkspace(root)
	if err != nil {
		return nil, err
	}
	a.ws = ws
	return ws, nil
}

// Root returns the absolute script workspace directory.
func (a *WorkspaceAPI) Root() (string, error) {
	ws, err := a.workspace()
	if err != nil {
		return "", err
	}
	return ws.Root(), nil
}

// List returns workspace-relative Lua files in deterministic order.
func (a *WorkspaceAPI) List() ([]script.WorkspaceFile, error) {
	ws, err := a.workspace()
	if err != nil {
		return nil, err
	}
	return ws.List()
}

// Read returns source plus its optimistic-concurrency revision.
func (a *WorkspaceAPI) Read(path string) (script.WorkspaceDocument, error) {
	ws, err := a.workspace()
	if err != nil {
		return script.WorkspaceDocument{}, err
	}
	return ws.ReadDocument(path)
}

// Write saves source only when revision still matches the file on disk.
func (a *WorkspaceAPI) Write(
	path string,
	source string,
	revision string,
) (script.WorkspaceDocument, error) {
	ws, err := a.workspace()
	if err != nil {
		return script.WorkspaceDocument{}, err
	}
	return ws.WriteChecked(path, source, revision)
}

// Create adds a collision-safe top-level Lua file.
func (a *WorkspaceAPI) Create(name string) (script.WorkspaceDocument, error) {
	ws, err := a.workspace()
	if err != nil {
		return script.WorkspaceDocument{}, err
	}
	file, err := ws.Create(name)
	if err != nil {
		return script.WorkspaceDocument{}, err
	}
	return ws.ReadDocument(file.Path)
}

// ConfigAPI exposes presets and favorites to the UI. All read-modify-write
// operations share one mutex so concurrent preset/favorite edits cannot
// overwrite each other.
type ConfigAPI struct {
	mu sync.Mutex
}

// Favorites returns persisted script-favorite paths.
func (a *ConfigAPI) Favorites() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; using defaults", err)
	}
	return cfg.Favorites
}

// SetFavorites persists script-favorite paths (atomic write).
func (a *ConfigAPI) SetFavorites(favs []string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; overwriting with defaults", err)
		cfg = config.DefaultConfig()
	}
	cfg.Favorites = favs
	return config.Save(cfg)
}

// Presets returns named channel presets.
func (a *ConfigAPI) Presets() map[string]config.Preset {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; using defaults", err)
	}
	if cfg.Presets == nil {
		return map[string]config.Preset{}
	}
	out := make(map[string]config.Preset, len(cfg.Presets))
	for name, preset := range cfg.Presets {
		out[name] = preset
	}
	return out
}

// SavePreset validates and atomically inserts or replaces one preset.
func (a *ConfigAPI) SavePreset(name string, preset config.Preset) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; overwriting with defaults", err)
		cfg = config.DefaultConfig()
	}
	if err := config.SetPreset(&cfg, name, preset); err != nil {
		return err
	}
	return config.Save(cfg)
}

// DeletePreset removes one named preset.
func (a *ConfigAPI) DeletePreset(name string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; overwriting with defaults", err)
		cfg = config.DefaultConfig()
	}
	if err := config.RemovePreset(&cfg, name); err != nil {
		return err
	}
	return config.Save(cfg)
}

// RenamePreset preserves the preset body under a new name.
func (a *ConfigAPI) RenamePreset(oldName, newName string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; overwriting with defaults", err)
		cfg = config.DefaultConfig()
	}
	if err := config.RenamePreset(&cfg, oldName, newName); err != nil {
		return err
	}
	return config.Save(cfg)
}

// StreamAPI exposes RX backpressure telemetry to the workbench.
type StreamAPI struct {
	mu  sync.RWMutex
	mgr *stream.Manager
}

func (a *StreamAPI) attach(mgr *stream.Manager) {
	a.mu.Lock()
	a.mgr = mgr
	a.mu.Unlock()
}

// Dropped reports the cumulative batches evicted for channel.
func (a *StreamAPI) Dropped(channel string) uint64 {
	a.mu.RLock()
	mgr := a.mgr
	a.mu.RUnlock()
	if mgr == nil {
		return 0
	}
	return mgr.Dropped(channel)
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; running on defaults", err)
	}
	_ = cfg

	serialSvc := serial.NewSerialService()
	tcpSvc := tcp.NewTcpService()
	engine := script.NewEngine(script.EngineOptions{
		Serial: link.NewSerialTransport(serialSvc),
		TCP:    link.NewTCPTransport(tcpSvc),
	})
	scriptSvc := script.NewScriptService(engine)
	workspaceAPI := &WorkspaceAPI{}
	if ws, wsErr := workspaceAPI.workspace(); wsErr != nil {
		log.Printf("script workspace: %v; file runs disabled until configured", wsErr)
	} else {
		scriptSvc.SetWorkspace(ws)
	}
	scriptAPI := ScriptAPI{svc: scriptSvc}
	streamAPI := &StreamAPI{}

	mygo.Bind(Greeter{}, serialSvc, tcpSvc, scriptAPI, workspaceAPI, &ConfigAPI{}, streamAPI)

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           "linkdeck",
			Width:           1280,
			Height:          800,
			MinWidth:        480,
			MinHeight:       360,
			BackgroundColor: "light-dark(#e8e4d9, #10130f)", // the page's --bg in src/style.css
			// Opens where the user left it last time.
			StateKey: "main",
			// The frontend: devUrl during `mygo dev`, frontendDist
			// embedded by `mygo build` otherwise (see mygo.json).
			URL: "/",
		})
		mgr := stream.NewManager(engine.Pool(), func(b stream.Batch) {
			dtos := make([]script.FrameDTO, 0, len(b.Frames))
			for _, f := range b.Frames {
				dtos = append(dtos, f.ToDTO())
			}
			// Best effort: a closed window ends delivery; loops keep
			// running until their channels close.
			_ = Frames.Emit(win, dtos)
		})
		mgr.SetFramingErrorHandler(func(err stream.FramingError) {
			_ = StreamErrors.Emit(win, err)
		})
		scriptSvc.SetOutputHandler(func(row script.OutputRow) {
			_ = ScriptOutput.Emit(win, row)
		})
		scriptSvc.SetStatusHandler(func(info script.RunInfo) {
			_ = ScriptRunStatus.Emit(win, info)
		})
		streamAPI.attach(mgr)
		serialSvc.AttachStream(mgr)
		tcpSvc.AttachStream(mgr)
		go func() {
			for t := range time.Tick(time.Second) {
				if Tick.Emit(win, t) != nil {
					return // the window was closed
				}
			}
		}()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	engine.Close()
}
