package main

import (
	"encoding/json"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"linkdeck/internal/automation"
	"linkdeck/internal/config"
	"linkdeck/internal/link"
	"linkdeck/internal/script"
	"linkdeck/internal/serial"
	"linkdeck/internal/stream"
	"linkdeck/internal/tcp"
)

// Tick is sent to the page every second.
var Tick = mygo.NewEvent[time.Time]("tick")

// Frames carries unmatched-frame batches (matcher-first path) to the UI.
// Payloads cross as base64 strings; see script.FrameDTO.
var Frames = mygo.NewEvent[[]script.FrameDTO]("frames")

// StreamErrors carries non-fatal framing failures (oversize/checksum) and
// cumulative per-channel counts to the workbench.
var StreamErrors = mygo.NewEvent[stream.FramingError]("stream-errors")

// ChannelStatus carries batched transport lifecycle transitions. A 3s
// frontend poll is the fallback when an event is missed.
var ChannelStatus = mygo.NewEvent[[]link.TransportStatus]("channel-status")

// ScriptOutput carries structured rows scoped to their run/script.
var ScriptOutput = mygo.NewEvent[script.OutputRow]("script-output")

// ScriptRunStatus carries queued/running/final run-state transitions.
var ScriptRunStatus = mygo.NewEvent[script.RunInfo]("script-run-status")

// AutomationEvent carries ordered automation state, step, and IO snapshots.
var AutomationEvent = mygo.NewEvent[automation.Event]("automation-event")

// AutomationAPI is the bound native sequence runner.
type AutomationAPI struct {
	engine *automation.Engine
}

// Start validates and starts one automation Run.
func (a *AutomationAPI) Start(spec automation.RunSpec) (automation.RunInfo, error) {
	return a.engine.Start(spec)
}

// Cancel requests cancellation of one Run.
func (a *AutomationAPI) Cancel(id string) (automation.RunInfo, error) {
	return a.engine.Cancel(id)
}

// Pause requests a boundary pause between Steps.
func (a *AutomationAPI) Pause(id string) (automation.RunInfo, error) {
	return a.engine.Pause(id)
}

// Resume releases a boundary pause.
func (a *AutomationAPI) Resume(id string) (automation.RunInfo, error) {
	return a.engine.Resume(id)
}

// Status returns one retained Run snapshot.
func (a *AutomationAPI) Status(id string) (automation.RunInfo, error) {
	return a.engine.Status(id)
}

// List returns active and recently terminal Runs.
func (a *AutomationAPI) List() []automation.RunInfo {
	return a.engine.List()
}

// CancelChannel stops the active Run for a closing Channel.
func (a *AutomationAPI) CancelChannel(channel string) int {
	return a.engine.CancelChannel(channel)
}

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

// AutomationLibrary returns persisted reusable Commands and Sequences.
func (a *ConfigAPI) AutomationLibrary() config.AutomationLibrary {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; using defaults", err)
	}
	return config.CloneAutomationLibrary(cfg.Automation)
}

// SaveAutomationCommand inserts or replaces one reusable payload.
func (a *ConfigAPI) SaveAutomationCommand(command config.AutomationCommand) error {
	return a.updateAutomation(func(cfg *config.Config) error {
		return config.SaveAutomationCommand(cfg, command)
	})
}

// DeleteAutomationCommand removes one reusable payload.
func (a *ConfigAPI) DeleteAutomationCommand(name string) error {
	return a.updateAutomation(func(cfg *config.Config) error {
		return config.DeleteAutomationCommand(cfg, name)
	})
}

// RenameAutomationCommand renames a reusable payload without changing its body.
func (a *ConfigAPI) RenameAutomationCommand(oldName, newName string) error {
	return a.updateAutomation(func(cfg *config.Config) error {
		return config.RenameAutomationCommand(cfg, oldName, newName)
	})
}

// SaveAutomationSequence inserts or replaces one reusable Sequence.
func (a *ConfigAPI) SaveAutomationSequence(sequence config.AutomationSequence) error {
	return a.updateAutomation(func(cfg *config.Config) error {
		return config.SaveAutomationSequence(cfg, sequence)
	})
}

// DeleteAutomationSequence removes one reusable Sequence.
func (a *ConfigAPI) DeleteAutomationSequence(name string) error {
	return a.updateAutomation(func(cfg *config.Config) error {
		return config.DeleteAutomationSequence(cfg, name)
	})
}

// RenameAutomationSequence renames a reusable Sequence without changing its body.
func (a *ConfigAPI) RenameAutomationSequence(oldName, newName string) error {
	return a.updateAutomation(func(cfg *config.Config) error {
		return config.RenameAutomationSequence(cfg, oldName, newName)
	})
}

func (a *ConfigAPI) updateAutomation(update func(*config.Config) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	cfg, err := config.Load()
	if err != nil {
		log.Printf("config: %v; overwriting with defaults", err)
		cfg = config.DefaultConfig()
	}
	if err := update(&cfg); err != nil {
		return err
	}
	return config.Save(cfg)
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

// transportStatuses snapshots open serial ports and every TCP client,
// listener, and accepted connection. It is safe to call while channels are
// being opened or closed.
func transportStatuses(
	serialSvc *serial.SerialService,
	tcpSvc *tcp.TcpService,
) []link.TransportStatus {
	out := make([]link.TransportStatus, 0)
	discovered, discoveryErr := serialSvc.List()
	available := make(map[string]struct{}, len(discovered))
	for _, port := range discovered {
		available[port.Name] = struct{}{}
	}
	for _, name := range serialSvc.OpenNames() {
		status := link.TransportStatus{
			Key: name, Kind: "serial", Endpoint: name, State: "connected",
		}
		if discoveryErr == nil {
			if _, ok := available[name]; !ok {
				status.State = "disconnected"
				status.Error = "serial device removed"
			}
		}
		if _, err := serialSvc.Status(name); err != nil && status.State == "connected" {
			status.State = "error"
			status.Error = err.Error()
		}
		out = append(out, status)
	}
	if rows, err := tcpSvc.List(); err == nil {
		for _, row := range rows {
			out = append(out, link.TransportStatus{
				Key: row.Name, Kind: row.Kind, Parent: row.Parent, Endpoint: row.Address,
				State: string(row.State), Error: row.Error, Attempts: row.Attempts,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind == out[j].Kind {
			return out[i].Key < out[j].Key
		}
		return out[i].Kind < out[j].Kind
	})
	return out
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
	var automationWindowMu sync.RWMutex
	var automationWindow *mygo.Window
	automationEngine := automation.NewEngine(automation.Options{
		Sender: link.NewAutomationSender(serialSvc, tcpSvc),
		Pool:   engine.Pool(),
		Emit: func(event automation.Event) {
			automationWindowMu.RLock()
			win := automationWindow
			automationWindowMu.RUnlock()
			if win != nil {
				_ = AutomationEvent.Emit(win, event)
			}
		},
	})
	automationAPI := &AutomationAPI{engine: automationEngine}
	workspaceAPI := &WorkspaceAPI{}
	if ws, wsErr := workspaceAPI.workspace(); wsErr != nil {
		log.Printf("script workspace: %v; file runs disabled until configured", wsErr)
	} else {
		scriptSvc.SetWorkspace(ws)
	}
	scriptAPI := ScriptAPI{svc: scriptSvc}
	streamAPI := &StreamAPI{}

	mygo.Bind(serialSvc, tcpSvc, scriptAPI, workspaceAPI, &ConfigAPI{}, streamAPI, automationAPI)

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
		automationWindowMu.Lock()
		automationWindow = win
		automationWindowMu.Unlock()
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
			last := ""
			ticker := time.NewTicker(500 * time.Millisecond)
			defer ticker.Stop()
			for {
				statuses := transportStatuses(serialSvc, tcpSvc)
				raw, _ := json.Marshal(statuses)
				if signature := string(raw); signature != last {
					last = signature
					if err := ChannelStatus.Emit(win, statuses); err != nil {
						return
					}
				}
				<-ticker.C
			}
		}()
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
	automationEngine.Close()
	engine.Close()
}
